import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { crossVector3, type Vector3 } from '../math/vector'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import type { TuningSettings } from '../tuning/config'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import {
  BASIC_RECOVERY_DRIFT_ONSET_MPS,
  BASIC_RECOVERY_LESSON,
  BASIC_RECOVERY_SINK_ONSET_MPS,
  BASIC_RECOVERY_TARGET_HEIGHT_M,
  BASIC_RECOVERY_TILT_ONSET_DEGREES,
  basicRecoveryEvaluator,
} from './basicRecovery'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const MAXIMUM_DURATION_SECONDS = 120
const CAPACITY = 7_500
const PREPARATION_READING_SECONDS = 2
const ONSET_OBSERVATION_SECONDS = 0.75

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalized(value: Vector3): Vector3 {
  const length = Math.hypot(value.x, value.y, value.z)
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}

const PHASE_CAPTIONS = [
  '從地面自行起飛，依提示製造小偏差，再主動修正；示範不計入真人成績。',
  `從地面自行起飛至約 ${BASIC_RECOVERY_TARGET_HEIGHT_M} m，先留出恢復高度；真人操控沒有自動定高。`,
  `第 3 步：先準備，再小量右傾，觀察實際傾角達 ${BASIC_RECOVERY_TILT_ONSET_DEGREES}°。`,
  '已偵測傾斜；第 4 步先看機身傾斜，接著向反方向修正。Acro 回中只會停止旋轉。',
  `第 5 步：傾斜恢復完成，回到約 ${BASIC_RECOVERY_TARGET_HEIGHT_M} m；準備稍收油門，讓升降速度變成負值。`,
  '已偵測下沉；第 6 步先看負的升降速度，接著適量補油止住下降。接地停止不算空中恢復。',
  '第 7 步：下沉恢復完成，先稍微減少漂移，再小量前傾建立實際前進速度。',
  '已偵測漂移；第 8 步先看水平速度，接著朝移動反方向傾斜減速，再主動回平。',
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
  let phaseEnteredAt = 0
  let preparedAt: number | null = null
  let actionCueKey = ''
  let lastAction: { phase: number; kind: 'prepare' | 'induce' | 'observe' | 'correct' } = { phase: 0, kind: 'prepare' }

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
      phaseEnteredAt = sample.timestampSeconds
      preparedAt = null
      actionCueKey = ''
      cues.push({ timeSeconds: sample.timestampSeconds, text: PHASE_CAPTIONS[phase], targetReferenceId: 'recovery-zone', recoveryPhase: phase })
    } else if (ready && !previousReady && [2, 4, 6].includes(phase)) {
      preparedAt = sample.timestampSeconds
      cues.push({ timeSeconds: sample.timestampSeconds,
        text: '準備完成；先看目前步驟與數值，示範接著會製造小偏差。可點選示範步驟重看，觀看不會增加真人進度。',
        targetReferenceId: 'recovery-zone', recoveryPhase: phase })
    }
    if (lastAction.phase === phase && (lastAction.kind === 'induce' || lastAction.kind === 'correct')) {
      const key = `${phase}:${lastAction.kind}`
      if (key !== actionCueKey) {
        actionCueKey = key
        const instruction = phase === 2 ? `第 3 步現在開始：小量右傾，讓實際傾角達 ${BASIC_RECOVERY_TILT_ONSET_DEGREES}°。`
          : phase === 3 ? '第 4 步現在修正：向傾斜反方向小量操作，主動帶回接近水平，再回中減緩旋轉。'
            : phase === 4 ? `第 5 步現在開始：稍收油門，觀察升降速度下降至 −${BASIC_RECOVERY_SINK_ONSET_MPS.toFixed(1)} m/s。`
              : phase === 5 ? '第 6 步現在修正：適量補油，讓負的升降速度回升、止住下降；小幅向上也可以。'
                : phase === 6 ? `第 7 步現在開始：小量前傾，讓實際水平速度達 ${BASIC_RECOVERY_DRIFT_ONSET_MPS.toFixed(1)} m/s。`
                  : '第 8 步現在修正：向移動反方向傾斜減速，再主動回平，觀察水平速度降低。'
        cues.push({ timeSeconds: sample.timestampSeconds, text: instruction, targetReferenceId: 'recovery-zone', recoveryPhase: phase })
      }
    }
    previousReady = ready
    finished = next.status === 'success'
  }

  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const velocity = state.velocityMps
    const ready = evaluation?.metrics?.exerciseReady === 1
    const readingFinished = ready && preparedAt !== null && time - preparedAt >= PREPARATION_READING_SECONDS
    const observingOnset = [3, 5, 7].includes(phase) && time - phaseEnteredAt < ONSET_OBSERVATION_SECONDS
    const inducingTilt = phase === 2 && readingFinished || phase === 3 && observingOnset
    const inducingSink = phase === 4 && readingFinished || phase === 5 && observingOnset
    const inducingDrift = phase === 6 && readingFinished || phase === 7 && observingOnset
    lastAction = { phase, kind: phase % 2 === 0 ? readingFinished ? 'induce' : 'prepare' : observingOnset ? 'observe' : 'correct' }
    const desiredVelocityX = clamp((launch.x - state.positionM.x) * 0.65, -1, 1)
    const desiredVelocityZ = inducingDrift ? -1.8 : clamp((launch.z - state.positionM.z) * 0.65, -1, 1)
    const accelerationX = clamp((desiredVelocityX - velocity.x) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.x * velocity.x / settings.drone.massKg, -1.5, 1.5)
    const accelerationZ = clamp((desiredVelocityZ - velocity.z) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.z * velocity.z / settings.drone.massKg, -1.5, 1.5)
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const tilt = 18 * Math.PI / 180
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
      throttle: collectiveThrottle(simulation, time < 0.5 ? launch.y : inducingSink ? state.positionM.y - 0.8 : altitude, inducingSink ? 0.7 : 0.65),
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
