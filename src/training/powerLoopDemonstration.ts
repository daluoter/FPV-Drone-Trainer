import { droneGroundSupport } from '../drone'
import { FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { rotateVectorByQuaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { POWER_LOOP_LESSON, POWER_LOOP_TARGET_HEIGHT_M, powerLoopEvaluator } from './powerLoop'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const RADIUS_M = 8
const ANGULAR_SPEED_RAD_PER_SECOND = 1.35
const ENTRY_SPEED_MPS = RADIUS_M * ANGULAR_SPEED_RAD_PER_SECOND
const MAXIMUM_DURATION_SECONDS = 120
const CAPACITY = 7_500

const CAPTIONS = [
  '從地面自行起飛；這段示範以實際搖桿與物理飛出大迴旋，觀看不計入真人成績。',
  `第 2 步：自行起飛，先爬升至約 ${POWER_LOOP_TARGET_HEIGHT_M} m，留出下半圈與改出的空間。`,
  `第 3 步：繼續升至約 ${POWER_LOOP_TARGET_HEIGHT_M} m，再保持高度並建立前進速度；大迴旋需要飛出路徑，原地後翻不算完成。`,
  '第 4 步：已建立前進速度；穩住入彎高度，接著拉起機頭、配合油門沿弧線爬升。',
  '第 5 步：已向上拉起並實際爬升；繼續拉過頂部，接近倒置時減少油門。',
  '第 6 步：已觀察到倒置；繼續越過頂部並往下繞回，維持同方向俯仰，預留改出高度。',
  '第 7 步：已向後繞回並下降；繼續拉回正飛、適量補油向前改出。',
  '第 8 步：已完成實際垂直迴圈並向前改出；回中減緩旋轉、修正下降，恢復控制。',
  '大迴旋八步已完成；實際觀察到前進、爬升、過頂、下降、改出與空中恢復。',
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function angleDifference(target: number, current: number): number {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current))
}

/** Author a bounded movie with ordinary RC commands; this controller is never offered to live flight. */
export function recordPowerLoopDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const altitude = ground + POWER_LOOP_TARGET_HEIGHT_M
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumPitchRate = Math.min(280, settings.controller.rates.axes.pitch.maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec.pitch ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumPitchRate < 240 || maximumThrust / settings.drone.massKg < 28) {
    throw new RangeError('目前角速度或推力不足以完成大迴旋示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 })
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: 'loop-zone', powerLoopPhase: 0 }]
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let entryAt: number | null = null
  let loopAt: number | null = null
  let loopZ = launch.z
  let loopCueWritten = false
  let finished = false
  let completedMovie = false

  const cue = (timeSeconds: number, text: string): void => {
    cues.push({ timeSeconds, text, targetReferenceId: 'loop-zone', powerLoopPhase: phase })
  }
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = powerLoopEvaluator.evaluate(sample, { lesson: POWER_LOOP_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成大迴旋模擬示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.loopPhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cue(state.timeSeconds, CAPTIONS[phase])
    }
    finished = next.status === 'success'
  }
  const verticalAcceleration = (height: number, maximumSpeed = 2): number => {
    const state = simulation.getState()
    return clamp((clamp((height - state.positionM.y) * 1.5, -maximumSpeed, maximumSpeed) - state.velocityMps.y) * 3, -5, 8)
  }
  const inputAt = (timeSeconds: number): NormalizedRcInput => {
    const state = simulation.getState()
    const velocity = state.velocityMps
    if (entryAt === null && Math.abs(state.positionM.y - altitude) < 0.5 && Math.abs(velocity.y) < 0.6) entryAt = timeSeconds
    if (entryAt !== null && loopAt === null && timeSeconds - entryAt > 5
      && -velocity.z > ENTRY_SPEED_MPS - 0.35 && Math.abs(velocity.y) < 0.6) {
      loopAt = timeSeconds
      loopZ = state.positionM.z
    }
    let accelerationY = verticalAcceleration(altitude)
    let accelerationZ = clamp(-velocity.z * 2, -5, 5)
    let feedForwardRate = 0
    const loopElapsed = loopAt === null ? null : timeSeconds - loopAt
    if (loopElapsed !== null && loopElapsed <= 2 * Math.PI / ANGULAR_SPEED_RAD_PER_SECOND) {
      const theta = loopElapsed * ANGULAR_SPEED_RAD_PER_SECOND
      const targetY = altitude + RADIUS_M * (1 - Math.cos(theta))
      const targetZ = loopZ - RADIUS_M * Math.sin(theta)
      const targetVy = ENTRY_SPEED_MPS * Math.sin(theta)
      const targetVz = -ENTRY_SPEED_MPS * Math.cos(theta)
      const inward = RADIUS_M * ANGULAR_SPEED_RAD_PER_SECOND ** 2
      accelerationY = inward * Math.cos(theta) + (targetY - state.positionM.y) * 1.1 + (targetVy - velocity.y) * 2
      accelerationZ = inward * Math.sin(theta) + (targetZ - state.positionM.z) * 1.1 + (targetVz - velocity.z) * 2
      feedForwardRate = ANGULAR_SPEED_RAD_PER_SECOND * inward * (inward + settings.drone.gravityMps2 * Math.cos(theta))
        / (inward ** 2 + settings.drone.gravityMps2 ** 2 + 2 * inward * settings.drone.gravityMps2 * Math.cos(theta))
    } else if (entryAt !== null) {
      const desiredVz = loopElapsed === null ? -ENTRY_SPEED_MPS : -4
      accelerationZ = clamp((desiredVz - velocity.z) * 2, -4, 5)
    }
    const forceY = settings.drone.massKg * (accelerationY + settings.drone.gravityMps2)
      + settings.drone.linearDragCoefficientNPerMps.y * velocity.y
    const forceZ = settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z
    const targetAngle = Math.atan2(forceZ, forceY)
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const actualAngle = Math.atan2(up.z, up.y)
    // The circular feedforward remains well behaved around the inverted crest;
    // normal body-rate feedback corrects measured error through the RC channel.
    const rate = clamp((feedForwardRate + angleDifference(targetAngle, actualAngle) * 7
      - state.angularVelocityBodyRadPerSec.x * 0.08) * 180 / Math.PI, -maximumPitchRate, maximumPitchRate)
    const throttle = clamp(Math.hypot(forceY, forceZ) / maximumThrust, 0, 0.95)
    if (timeSeconds < 0.5) return { roll: 0, pitch: 0, yaw: 0, throttle: collectiveThrottle(simulation, launch.y, 1) }
    return { roll: 0, pitch: stickForRate(settings, 'pitch', rate), yaw: 0, throttle }
  }
  const initialInput = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  observe(initialInput)
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) throw new RangeError('目前設定無法安全完成大迴旋示範，請採用新手或一般預設。')
    const retained = recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })
    if (!retained) continue
    observe(input)
    if (loopAt !== null && !loopCueWritten) {
      cue(step.state.timeSeconds, '現在開始拉起：帶著前進速度向上繞弧；配合油門，避免只做原地後翻。')
      loopCueWritten = true
    }
    if (finished && loopAt !== null && step.state.timeSeconds > loopAt + 2 * Math.PI / ANGULAR_SPEED_RAD_PER_SECOND + 1) {
      cue(step.state.timeSeconds, CAPTIONS[8])
      completedMovie = true
      break
    }
  }
  // A limited airframe must fail honestly rather than display an invented loop.
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成大迴旋示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
