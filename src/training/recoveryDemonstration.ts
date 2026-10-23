import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { crossVector3, type Vector3 } from '../math/vector'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import type { TuningSettings } from '../tuning/config'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import { BASIC_RECOVERY_LESSON, BASIC_RECOVERY_TARGET_HEIGHT_M, basicRecoveryEvaluator } from './basicRecovery'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const MAXIMUM_DURATION_SECONDS = 120
const CAPACITY = 7_500

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalized(value: Vector3): Vector3 {
  const length = Math.hypot(value.x, value.y, value.z)
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}

const PHASE_CAPTIONS = [
  '從地面自行起飛，依提示製造小偏差，再主動修正；示範不計入真人成績。',
  '從地面自行起飛至約 6 m，先留出恢復高度；真人操控沒有自動定高。',
  '先讓姿態與速度平順，再小量右傾，觀察實際傾角超過 15°。',
  '已偵測傾斜；向反方向小量修正，主動把機身帶回接近水平，回中只會停止旋轉。',
  '傾斜恢復完成；回到約 6 m 並降低漂移，準備稍收油門製造下沉。',
  '已偵測下沉；適量補油止住下降，保持離地餘裕，接地停止不算空中恢復。',
  '下沉恢復完成；先讓姿態與速度平順，再小量前傾建立前進漂移。',
  '已偵測漂移；朝移動反方向短暫傾斜減速，再主動帶回近水平，不要求回原位置。',
  '已完成傾斜、下沉與漂移恢復；三段都先觀察到真實偏差，再完成空中修正。',
] as const

/**
 * Generate a teaching recording with RC commands through the real fixed-step
 * controller. The evaluator observes only retained physical samples; it never
 * changes the simulation, and this helper is never offered as live assistance.
 */
export function recordRecoveryDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const altitude = settings.drone.ground.heightM + BASIC_RECOVERY_TARGET_HEIGHT_M
  const references = [
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
  ]
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 })
  simulation.arm()
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: PHASE_CAPTIONS[0], targetReferenceId: 'recovery-zone', recoveryPhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  let observedSamples = 0
  let phase = 0
  let finished = false
  let previousReady = false

  const observe = (sample: TrainingSample): void => {
    const next = basicRecoveryEvaluator.evaluate(sample, {
      lesson: BASIC_RECOVERY_LESSON, mode: 'practice', elapsedSeconds: sample.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], sampleCount: observedSamples,
      previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation,
    })
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成恢復模擬示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) {
      checkpoints[id] = { id, completed: true, completedAtSeconds: sample.timestampSeconds, metrics: { ...(next.metrics ?? {}) } }
    }
    observedSamples += 1
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.recoveryPhase ?? 0
    const ready = next.metrics?.exerciseReady === 1
    if (nextPhase !== phase) {
      phase = nextPhase
      cues.push({ timeSeconds: sample.timestampSeconds, text: PHASE_CAPTIONS[phase], targetReferenceId: 'recovery-zone', recoveryPhase: phase })
    } else if (ready && !previousReady && [2, 4, 6].includes(phase)) {
      const instruction = phase === 2 ? '準備完成：現在小量右傾，建立約 15° 的傾斜。'
        : phase === 4 ? '準備完成：現在稍收油門，觀察下降速度達到約 0.8 m/s。'
          : '準備完成：現在小量前傾，觀察水平速度達到約 1.5 m/s。'
      cues.push({ timeSeconds: sample.timestampSeconds, text: instruction, targetReferenceId: 'recovery-zone', recoveryPhase: phase })
    }
    previousReady = ready
    finished = next.status === 'success'
  }

  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const velocity = state.velocityMps
    const ready = evaluation?.metrics?.exerciseReady === 1
    const inducingTilt = phase === 2 && ready
    const inducingSink = phase === 4 && ready
    const inducingDrift = phase === 6 && ready
    const desiredVelocityX = clamp((launch.x - state.positionM.x) * 0.65, -1, 1)
    const desiredVelocityZ = inducingDrift ? -2.2 : clamp((launch.z - state.positionM.z) * 0.65, -1, 1)
    const accelerationX = clamp((desiredVelocityX - velocity.x) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.x * velocity.x / settings.drone.massKg, -1.5, 1.5)
    const accelerationZ = clamp((desiredVelocityZ - velocity.z) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.z * velocity.z / settings.drone.massKg, -1.5, 1.5)
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const tilt = 20 * Math.PI / 180
    const targetUp = inducingTilt ? { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 }
      : normalized({ x: accelerationX, y: settings.drone.gravityMps2, z: accelerationZ })
    const correction = crossVector3(up, targetUp)
    const forward = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
    const heading = Math.atan2(forward.x, -forward.z)
    const worldRate = { x: clamp(correction.x * 3.5, -0.6, 0.6), y: clamp(heading * 2, -0.5, 0.5), z: clamp(correction.z * 3.5, -0.6, 0.6) }
    const pilotRates = bodyAngularRateToPilotAxes(inverseRotateVectorByQuaternion(state.orientation, worldRate))
    return {
      roll: stickForRate(settings, 'roll', pilotRates.roll * 180 / Math.PI),
      pitch: stickForRate(settings, 'pitch', pilotRates.pitch * 180 / Math.PI),
      yaw: stickForRate(settings, 'yaw', pilotRates.yaw * 180 / Math.PI),
      throttle: collectiveThrottle(simulation, time < 0.5 ? launch.y : inducingSink ? altitude - 2.5 : altitude, inducingSink ? 1.2 : 0.65),
    }
  }
  const sampleFor = (input: NormalizedRcInput): TrainingSample => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    return { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: settings.drone.ground.heightM, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 } }
  }
  const initialInput = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  observe(sampleFor(initialInput))
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError(`目前設定無法完成恢復模擬示範，請採用新手或一般預設後重試。${step.warnings.join(' ')}`)
    }
    const retained = recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })
    if (!retained) continue
    observe(sampleFor(input))
    if (finished) break
  }
  if (!finished) throw new RangeError('目前設定無法在錄影容量內完成恢復示範，請採用新手或一般預設後重試。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((cue) => Object.freeze(cue))) }
}
