import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { SPLIT_S_LESSON, splitSLearningEvaluator } from './splitS'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const TARGET_HEIGHT_M = 25
const RADIUS_M = 8
const ANGULAR_SPEED = 1.35
const ENTRY_SPEED = RADIUS_M * ANGULAR_SPEED
const MAXIMUM_DURATION_SECONDS = 120
const CAPACITY = 7_500
const HALF_ROLL = quaternionFromRotationVector({ x: 0, y: 0, z: -Math.PI })
const REVERSED_HEADING = quaternionFromRotationVector({ x: 0, y: -Math.PI, z: 0 })
const CAPTIONS = [
  '從地面自行起飛；這段翻轉下降示範以實際搖桿與物理錄製，觀看不計入真人成績。',
  '第 2 步：自行起飛至約 25 m，留出倒置後下降半迴圈及改出的空間。',
  '第 3 步：建立前進速度並保持進場高度，再開始半圈橫滾。',
  '第 4 步：前進準備完成；先橫滾半圈到倒置，再向後拉俯仰進入下降段。',
  '第 5 步：已觀察到半圈橫滾與倒置；接著向後拉俯仰，實際往下繞弧。',
  '第 6 步：已開始下降半迴圈；保持同一後拉方向，讓機頭與實際速度逐漸轉向來路。',
  '第 7 步：已轉向來路並實際反向移動；繼續拉回正飛，保留下方高度。',
  '第 8 步：已完成半迴圈並回正；回中減緩旋轉，補油止住下降，再恢復控制。',
  '翻轉下降八步已完成；已觀察到半圈橫滾、倒置、下降半迴圈、反向出場及空中恢復。',
] as const

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/** Author a bounded teaching movie through normal RC commands, never a live assist. */
export function recordSplitSDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const altitude = ground + TARGET_HEIGHT_M
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumRate = (axis: RateAxis): number => Math.min(280, settings.controller.rates.axes[axis].maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec[axis] ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumRate('roll') < 180 || maximumRate('pitch') < 240 || maximumThrust / settings.drone.massKg < 28) {
    throw new RangeError('目前角速度或推力不足以完成翻轉下降示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 })
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: 'split-zone', splitSPhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let finished = false
  let completedMovie = false
  let rollCueWritten = false
  let diveCueWritten = false
  let entryAt: number | null = null
  let rollAt: number | null = null
  let diveAt: number | null = null
  let diveY = altitude
  let diveZ = launch.z
  let startingAngle = 0
  let recoveryHeight = altitude - RADIUS_M * 2
  const cue = (time: number, text: string): void => {
    cues.push({ timeSeconds: time, text, targetReferenceId: 'split-zone', splitSPhase: phase })
  }
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = splitSLearningEvaluator.evaluate(sample, { lesson: SPLIT_S_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if ((next.metrics?.splitInterrupted ?? 0) > 0.5) throw new RangeError(`目前設定無法連續完成翻轉下降示範。${next.hint ?? ''}`)
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成翻轉下降模擬示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.splitPhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cue(state.timeSeconds, CAPTIONS[phase])
    }
    finished = next.status === 'success'
  }
  const attitudeInput = (target: Quaternion, throttle: number, pitchFeedforward = 0): NormalizedRcInput => {
    const state = simulation.getState()
    let error = multiplyQuaternions(conjugateQuaternion(state.orientation), target)
    if (error.w < 0) error = { x: -error.x, y: -error.y, z: -error.z, w: -error.w }
    const sine = Math.hypot(error.x, error.y, error.z)
    const factor = sine > 1e-8 ? 2 * Math.atan2(sine, Math.max(0, error.w)) / sine : 2
    const body = { x: pitchFeedforward + error.x * factor * 7 - state.angularVelocityBodyRadPerSec.x * 0.08,
      y: error.y * factor * 7 - state.angularVelocityBodyRadPerSec.y * 0.08,
      z: error.z * factor * 7 - state.angularVelocityBodyRadPerSec.z * 0.08 }
    const pilot = bodyAngularRateToPilotAxes(body)
    return { roll: stickForRate(settings, 'roll', clamp(pilot.roll * 180 / Math.PI, -maximumRate('roll'), maximumRate('roll'))),
      pitch: stickForRate(settings, 'pitch', clamp(pilot.pitch * 180 / Math.PI, -maximumRate('pitch'), maximumRate('pitch'))),
      yaw: stickForRate(settings, 'yaw', clamp(pilot.yaw * 180 / Math.PI, -maximumRate('yaw'), maximumRate('yaw'))), throttle }
  }
  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const velocity = state.velocityMps
    if (entryAt === null && Math.abs(state.positionM.y - altitude) < 0.5 && Math.abs(velocity.y) < 0.6) entryAt = time
    if (entryAt !== null && rollAt === null && time - entryAt > 5 && -velocity.z > ENTRY_SPEED - 0.4 && phase >= 3) rollAt = time
    if (rollAt !== null && diveAt === null && phase >= 4 && time - rollAt > 0.85
      && Math.abs(state.angularVelocityBodyRadPerSec.z) < 0.4) {
      diveAt = time
      diveY = state.positionM.y
      diveZ = state.positionM.z
      startingAngle = clamp(Math.atan2(-velocity.y, -velocity.z), 0.05, 0.65)
      recoveryHeight = Math.max(ground + 5, diveY - RADIUS_M * (Math.cos(startingAngle) + 1))
    }
    if (rollAt !== null && diveAt === null) return attitudeInput(HALF_ROLL, 0.04)
    let accelerationY = clamp((clamp(((diveAt === null ? altitude : recoveryHeight) - state.positionM.y) * 1.5, -2.5, 3) - velocity.y) * 3, -5, 12)
    let accelerationZ = clamp(((entryAt === null ? 0 : diveAt === null ? -ENTRY_SPEED : 4) - velocity.z) * 2, -4, 5)
    let pitchFeedforward = 0
    let loop = false
    const theta = diveAt === null ? null : startingAngle + (time - diveAt) * ANGULAR_SPEED
    if (theta !== null && theta <= Math.PI) {
      loop = true
      const targetY = diveY + RADIUS_M * (Math.cos(theta) - Math.cos(startingAngle))
      const targetZ = diveZ - RADIUS_M * (Math.sin(theta) - Math.sin(startingAngle))
      const targetVy = -ENTRY_SPEED * Math.sin(theta)
      const targetVz = -ENTRY_SPEED * Math.cos(theta)
      const inward = RADIUS_M * ANGULAR_SPEED ** 2
      accelerationY = -inward * Math.cos(theta) + (targetY - state.positionM.y) * 1.1 + (targetVy - velocity.y) * 2
      accelerationZ = inward * Math.sin(theta) + (targetZ - state.positionM.z) * 1.1 + (targetVz - velocity.z) * 2
      pitchFeedforward = ANGULAR_SPEED * inward * (inward - settings.drone.gravityMps2 * Math.cos(theta))
        / (inward ** 2 + settings.drone.gravityMps2 ** 2 - 2 * inward * settings.drone.gravityMps2 * Math.cos(theta))
    }
    const forceY = settings.drone.massKg * (accelerationY + settings.drone.gravityMps2)
      + settings.drone.linearDragCoefficientNPerMps.y * velocity.y
    const forceZ = settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z
    const angle = Math.atan2(forceZ, forceY)
    const target = loop
      ? multiplyQuaternions(HALF_ROLL, quaternionFromRotationVector({ x: Math.PI - angle, y: 0, z: 0 }))
      : diveAt === null ? quaternionFromRotationVector({ x: angle, y: 0, z: 0 })
        : multiplyQuaternions(REVERSED_HEADING, quaternionFromRotationVector({ x: -angle, y: 0, z: 0 }))
    const throttle = clamp(Math.hypot(forceY, forceZ) / maximumThrust, 0, 0.95)
    if (time < 0.5) return { roll: 0, pitch: 0, yaw: 0, throttle: collectiveThrottle(simulation, launch.y, 1) }
    return attitudeInput(target, throttle, pitchFeedforward)
  }
  const initial = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initial, armed: true, telemetry: simulation.getTelemetry() })
  observe(initial)
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) throw new RangeError('目前設定無法安全完成翻轉下降示範，請採用新手或一般預設。')
    const retained = recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })
    if (!retained) continue
    observe(input)
    if (rollAt !== null && !rollCueWritten) {
      cue(step.state.timeSeconds, '現在開始半圈橫滾：先翻成倒置，接著才向後拉俯仰進入下降半迴圈。')
      rollCueWritten = true
    }
    if (diveAt !== null && !diveCueWritten) {
      cue(step.state.timeSeconds, '現在開始後拉俯仰：沿下降弧線轉向來路，保留下方空間並提早準備改出。')
      diveCueWritten = true
    }
    if (finished && diveAt !== null && step.state.timeSeconds > diveAt + (Math.PI - startingAngle) / ANGULAR_SPEED + 1) {
      cue(step.state.timeSeconds, CAPTIONS[8])
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成翻轉下降示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
