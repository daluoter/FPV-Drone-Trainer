import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, inverseRotateVectorByQuaternion, multiplyQuaternions, rotateVectorByQuaternion, type Quaternion } from '../math/quaternion'
import { crossVector3 } from '../math/vector'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { FULL_FLIP_LESSON, FULL_FLIP_TARGET_HEIGHT_M, fullFlipEvaluator } from './fullFlip'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const MAXIMUM_DURATION_SECONDS = 120
const CAPACITY = 7_500
const PREPARATION_READING_SECONDS = 2
const BOOST_SECONDS = 0.65
const TARGET_FLIP_DEGREES = 365

const PHASE_CAPTIONS = [
  '從地面自行起飛，完成一圈實際翻轉後恢復正飛；示範不計入真人成績。',
  `第 2 步：自行起飛至約 ${FULL_FLIP_TARGET_HEIGHT_M} m，先留出翻轉與恢復的高度餘裕。`,
  '第 3 步：接近水平、減少過大的漂移，短暫準備；不必精準停在原位置。',
  '翻轉前準備完成；先讀提示，接著補油建立上升餘裕，再保持同方向俯仰翻轉。',
  '第 4 步已觀察到倒置；繼續同方向翻轉，倒置時收油，避免推力把機體壓向地面。',
  '第 5 步已完成一圈並回到正飛；停止旋轉，再適量補油止住下降與減少漂移。',
  '已完成完整翻轉與空中恢復；實際通過倒置、同方向一圈及恢復確認，沒有自動操控真人飛行。',
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Record forward-positive (+1) or backward (-1) pitch flips through ordinary RC commands, the real controller and rigid-body solver.
 * This generator only authors a bounded movie; it never becomes a live assist.
 */
export function recordFullFlipDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
  direction: 1 | -1 = 1,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const directionName = direction === 1 ? '前翻' : '後翻'
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const altitude = settings.drone.ground.heightM + FULL_FLIP_TARGET_HEIGHT_M
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const hoverThrottle = settings.drone.massKg * settings.drone.gravityMps2 / maximumThrust
  const maximumPitchRate = Math.min(280,
    settings.controller.rates.axes.pitch.maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec.pitch ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumPitchRate < 140 || hoverThrottle >= 0.7) {
    throw new RangeError('目前轉速或推力不足以完成翻轉示範，請選擇新手或一般預設。')
  }
  const references = [
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
  ]
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 })
  simulation.arm()
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: PHASE_CAPTIONS[0], targetReferenceId: 'flip-zone', fullFlipPhase: 0 }]
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let observedSamples = 0
  let finished = false
  let preparedAt: number | null = null
  let boostAt: number | null = null
  let flipStarted = false
  let flipFinished = false
  let flippedDegrees = 0
  let previousOrientation: Quaternion | null = null
  let recoveryAt: number | null = null
  let maximumFlippedDegrees = 0
  let completedMovie = false

  const cue = (timeSeconds: number, text: string): void => {
    cues.push({ timeSeconds, text, targetReferenceId: 'flip-zone', fullFlipPhase: phase })
  }
  const observe = (sample: TrainingSample): void => {
    const next = fullFlipEvaluator.evaluate(sample, {
      lesson: FULL_FLIP_LESSON, mode: 'practice', elapsedSeconds: sample.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], sampleCount: observedSamples,
      previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation,
    })
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成翻轉模擬示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) {
      checkpoints[id] = { id, completed: true, completedAtSeconds: sample.timestampSeconds, metrics: { ...(next.metrics ?? {}) } }
    }
    observedSamples += 1
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.flipPhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cue(sample.timestampSeconds, PHASE_CAPTIONS[phase])
      if (phase === 3) preparedAt = sample.timestampSeconds
    }
    finished = next.status === 'success'
  }
  const levelInput = (throttle: number): NormalizedRcInput => {
    const state = simulation.getState()
    const velocity = state.velocityMps
    const desiredVelocityX = clamp((launch.x - state.positionM.x) * 0.5, -1.5, 1.5)
    const desiredVelocityZ = clamp((launch.z - state.positionM.z) * 0.5, -1.5, 1.5)
    const accelerationX = clamp((desiredVelocityX - velocity.x) * 2
      + settings.drone.linearDragCoefficientNPerMps.x * velocity.x / settings.drone.massKg, -3, 3)
    const accelerationZ = clamp((desiredVelocityZ - velocity.z) * 2
      + settings.drone.linearDragCoefficientNPerMps.z * velocity.z / settings.drone.massKg, -3, 3)
    const length = Math.hypot(accelerationX, settings.drone.gravityMps2, accelerationZ)
    const targetUp = { x: accelerationX / length, y: settings.drone.gravityMps2 / length, z: accelerationZ / length }
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const correction = crossVector3(up, targetUp)
    const forward = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
    const heading = Math.atan2(forward.x, -forward.z)
    const worldRate = { x: clamp(correction.x * 4, -1, 1), y: clamp(heading * 2, -0.5, 0.5), z: clamp(correction.z * 4, -1, 1) }
    const pilotRates = bodyAngularRateToPilotAxes(inverseRotateVectorByQuaternion(state.orientation, worldRate))
    return {
      roll: stickForRate(settings, 'roll', pilotRates.roll * 180 / Math.PI),
      pitch: stickForRate(settings, 'pitch', pilotRates.pitch * 180 / Math.PI),
      yaw: stickForRate(settings, 'yaw', pilotRates.yaw * 180 / Math.PI), throttle,
    }
  }
  // Stronger vertical correction is necessary after a real flip loses lift.
  // It still authors a bounded collective RC channel through the normal solver.
  const verticalThrottle = (targetVelocity: number, maximumAcceleration: number): number => {
    const state = simulation.getState()
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const acceleration = clamp((targetVelocity - state.velocityMps.y) * 3, -4, maximumAcceleration)
    const thrust = (settings.drone.massKg * (settings.drone.gravityMps2 + acceleration)
      + settings.drone.linearDragCoefficientNPerMps.y * state.velocityMps.y) / Math.max(0.5, up.y)
    return clamp(thrust / maximumThrust, 0, 0.85)
  }
  const inputAt = (timeSeconds: number): NormalizedRcInput => {
    const state = simulation.getState()
    if (preparedAt !== null && boostAt === null && timeSeconds - preparedAt >= PREPARATION_READING_SECONDS
      && Math.abs(state.positionM.y - altitude) < 0.8 && Math.abs(state.velocityMps.y) < 1) {
      boostAt = timeSeconds
    }
    if (boostAt !== null && !flipStarted && timeSeconds - boostAt >= BOOST_SECONDS) {
      flipStarted = true
      previousOrientation = state.orientation
    }
    if (flipStarted && !flipFinished) {
      const remaining = TARGET_FLIP_DEGREES - flippedDegrees
      const flipRate = -direction * state.angularVelocityBodyRadPerSec.x * 180 / Math.PI
      if (remaining < 1 && Math.abs(flipRate) < 15) {
        flipFinished = true
        recoveryAt = timeSeconds
      } else {
        const desiredRate = clamp(remaining * 8 - flipRate * 0.12, -80, maximumPitchRate)
        const throttle = flippedDegrees < 50 ? hoverThrottle
          : flippedDegrees > 300 ? verticalThrottle(2, 12) : Math.min(0.1, hoverThrottle * 0.32)
        return { roll: 0, pitch: stickForRate(settings, 'pitch', -direction * desiredRate), yaw: 0, throttle }
      }
    }
    if (flipFinished) {
      const desiredVelocity = clamp((altitude - state.positionM.y) * 1.1, -1, 2)
      return levelInput(verticalThrottle(desiredVelocity, 12))
    }
    if (boostAt !== null) return levelInput(verticalThrottle(5, 10))
    return levelInput(collectiveThrottle(simulation, timeSeconds < 0.5 ? launch.y : altitude, 1.3))
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
  let lastMode = 'climb'
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError(`目前設定無法完成翻轉模擬示範，請採用新手或一般預設後重試。${step.warnings.join(' ')}`)
    }
    if (flipStarted && !flipFinished && previousOrientation) {
      const relative = multiplyQuaternions(conjugateQuaternion(previousOrientation), step.state.orientation)
      const sign = relative.w < 0 ? -1 : 1
      flippedDegrees += -direction * 2 * Math.atan2(relative.x * sign, relative.w * sign) * 180 / Math.PI
      maximumFlippedDegrees = Math.max(maximumFlippedDegrees, flippedDegrees)
      previousOrientation = step.state.orientation
    }
    const retained = recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })
    if (!retained) continue
    observe(sampleFor(input))
    const mode = flipFinished ? 'recover' : flipStarted ? 'flip' : boostAt !== null ? 'boost' : 'climb'
    if (mode !== lastMode) {
      if (phase < 6) cue(step.state.timeSeconds, mode === 'boost'
        ? '先適量補油建立上升餘裕，再開始同方向翻轉；真人操作需要自己配合油門。'
        : mode === 'flip' ? `第 4 步現在開始：保持同方向${directionName}；經過倒置，再轉回正飛。`
          : '第 6 步現在恢復：回中停止旋轉、修回接近水平，適量補油止住下降並減少漂移。')
      lastMode = mode
    }
    if (finished && recoveryAt !== null && step.state.timeSeconds - recoveryAt >= 0.5 && maximumFlippedDegrees >= 360) {
      cue(step.state.timeSeconds, PHASE_CAPTIONS[6])
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成完整翻轉示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
