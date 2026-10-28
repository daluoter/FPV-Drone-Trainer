import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, inverseRotateVectorByQuaternion, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { createOrbitTarget, ORBIT_LESSON, ORBIT_REQUIRED_LAPS, ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M, orbitLearningEvaluator } from './orbit'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const ANGULAR_SPEED_RAD_PER_SECOND = 0.35
const RAMP_SECONDS = 2
// Preparation starts after actual side motion; leave a small margin beyond five full laps.
const TOTAL_ANGLE_RAD = ORBIT_REQUIRED_LAPS * 2 * Math.PI + Math.PI / 12
const CIRCLE_SECONDS = TOTAL_ANGLE_RAD / ANGULAR_SPEED_RAD_PER_SECOND + RAMP_SECONDS
const DEPARTURE_TURN_SECONDS = 2.5
const DEPARTURE_SPEED_MPS = 3
const MAXIMUM_DURATION_SECONDS = 180
const CAPACITY = 12_000
const CAPTIONS = [
  '從地面自行起飛；正刷鍋示範以實際搖桿及物理繞行，觀看不計入真人成績。',
  `第 2 步：自行起飛至約 ${ORBIT_TARGET_HEIGHT_M} m，辨認前方的參考目標及寬鬆環繞區。`,
  `第 3 步：繼續穩住約 ${ORBIT_TARGET_HEIGHT_M} m 高度，靠近目標約 ${ORBIT_TARGET_RADIUS_M} m 半徑；機頭朝向目標，先建立側向移動。`,
  `第 4 步：已建立真正的環繞方向；機頭朝向目標，持續側向繞行。這次需完成至少 ${ORBIT_REQUIRED_LAPS} 個完整的 360° 圈。`,
  '第 1 圈完成；持續面向目標，保持同一方向進入第 2 圈。',
  '第 2 圈完成；觀察半徑、高度與機頭，繼續同一方向進入第 3 圈。',
  '第 3 圈完成；協調側移、偏航及推力，持續朝向目標進入第 4 圈。',
  '第 4 圈完成；保持同一方向，再完成第 5 個完整的 360° 圈。',
  `第 ${ORBIT_REQUIRED_LAPS} 圈完成；現在逐漸收住側向移動，轉向塔外並實際飛離，保持高度及控制。`,
  `正刷鍋九步已完成；已實際面向目標連續繞行 ${ORBIT_REQUIRED_LAPS} 個完整圈，再朝塔外飛離並恢復控制，不需降落。`,
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Smooth bounded trajectory used only to author normal RC input for a recorded movie. */
function circleAt(elapsed: number): { angle: number; speed: number; acceleration: number } {
  const maximum = ANGULAR_SPEED_RAD_PER_SECOND
  const rampAngle = maximum * RAMP_SECONDS / 2
  const decelerationAt = CIRCLE_SECONDS - RAMP_SECONDS
  if (elapsed <= 0) return { angle: 0, speed: 0, acceleration: 0 }
  if (elapsed < RAMP_SECONDS) {
    const u = elapsed / RAMP_SECONDS
    return { angle: maximum * RAMP_SECONDS * (u ** 3 - u ** 4 / 2),
      speed: maximum * (3 * u ** 2 - 2 * u ** 3), acceleration: maximum * (6 * u - 6 * u ** 2) / RAMP_SECONDS }
  }
  if (elapsed < decelerationAt) return { angle: rampAngle + (elapsed - RAMP_SECONDS) * maximum, speed: maximum, acceleration: 0 }
  if (elapsed < CIRCLE_SECONDS) {
    const u = (elapsed - decelerationAt) / RAMP_SECONDS
    return { angle: TOTAL_ANGLE_RAD - rampAngle + maximum * RAMP_SECONDS * (u - u ** 3 + u ** 4 / 2),
      speed: maximum * (1 - 3 * u ** 2 + 2 * u ** 3), acceleration: -maximum * (6 * u - 6 * u ** 2) / RAMP_SECONDS }
  }
  return { angle: TOTAL_ANGLE_RAD, speed: 0, acceleration: 0 }
}

/** A separate simulated teaching flight; it never controls the live player. */
export function recordOrbitDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const target = createOrbitTarget(launch, ground)
  const entry = { x: target.x, y: target.y, z: target.z + ORBIT_TARGET_RADIUS_M }
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumRate = (axis: RateAxis): number => Math.min(180, settings.controller.rates.axes[axis].maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec[axis] ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumRate('yaw') < 35 || maximumRate('pitch') < 60 || maximumRate('roll') < 60 || maximumThrust / settings.drone.massKg < 18) {
    throw new RangeError('目前角速度或推力不足以完成正刷鍋示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 })
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'orbit-zone', kind: 'zone', positionM: target }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: 'orbit-zone', orbitPhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let finished = false
  let completedMovie = false
  let approachAt: number | null = null
  let entrySettledAt: number | null = null
  let orbitAt: number | null = null
  let orbitCueWritten = false
  let exitCueWritten = false
  let departureCueWritten = false
  const cue = (time: number, text: string): void => {
    cues.push({ timeSeconds: time, text, targetReferenceId: 'orbit-zone', orbitPhase: phase })
  }
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = orbitLearningEvaluator.evaluate(sample, { lesson: ORBIT_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if ((next.metrics?.orbitInterrupted ?? 0) > 0.5) throw new RangeError(`目前設定無法連續完成正刷鍋示範。${next.hint ?? ''}`)
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成正刷鍋模擬示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.orbitPhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cue(state.timeSeconds, CAPTIONS[phase])
    }
    finished = next.status === 'success'
  }
  const attitudeInput = (desired: Quaternion, throttle: number, yawFeedforward: number): NormalizedRcInput => {
    const state = simulation.getState()
    let error = multiplyQuaternions(conjugateQuaternion(state.orientation), desired)
    if (error.w < 0) error = { x: -error.x, y: -error.y, z: -error.z, w: -error.w }
    const sine = Math.hypot(error.x, error.y, error.z)
    const factor = sine > 1e-8 ? 2 * Math.atan2(sine, Math.max(0, error.w)) / sine : 2
    const feedforward = inverseRotateVectorByQuaternion(state.orientation, { x: 0, y: yawFeedforward, z: 0 })
    const pilot = bodyAngularRateToPilotAxes({
      x: feedforward.x + error.x * factor * 7 - state.angularVelocityBodyRadPerSec.x * 0.08,
      y: feedforward.y + error.y * factor * 7 - state.angularVelocityBodyRadPerSec.y * 0.08,
      z: feedforward.z + error.z * factor * 7 - state.angularVelocityBodyRadPerSec.z * 0.08,
    })
    return { roll: stickForRate(settings, 'roll', clamp(pilot.roll * 180 / Math.PI, -maximumRate('roll'), maximumRate('roll'))),
      pitch: stickForRate(settings, 'pitch', clamp(pilot.pitch * 180 / Math.PI, -maximumRate('pitch'), maximumRate('pitch'))),
      yaw: stickForRate(settings, 'yaw', clamp(pilot.yaw * 180 / Math.PI, -maximumRate('yaw'), maximumRate('yaw'))), throttle }
  }
  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const velocity = state.velocityMps
    if (approachAt === null && Math.abs(state.positionM.y - target.y) < 0.5 && Math.abs(velocity.y) < 0.6) approachAt = time
    const entryDistance = Math.hypot(state.positionM.x - entry.x, state.positionM.z - entry.z)
    if (approachAt !== null && orbitAt === null) {
      if (entryDistance < 0.4 && Math.hypot(velocity.x, velocity.z) < 0.35) {
        entrySettledAt ??= time
        if (time - entrySettledAt > 0.3) orbitAt = time
      } else entrySettledAt = null
    }
    const circle = circleAt(orbitAt === null ? 0 : time - orbitAt)
    const departureElapsed = orbitAt === null ? 0 : Math.max(0, time - orbitAt - CIRCLE_SECONDS - DEPARTURE_TURN_SECONDS)
    const radius = ORBIT_TARGET_RADIUS_M + Math.min(12, departureElapsed * DEPARTURE_SPEED_MPS)
    const departing = departureElapsed > 0
    const desiredX = orbitAt === null ? launch.x : target.x + radius * Math.sin(circle.angle)
    const desiredZ = approachAt === null ? launch.z : orbitAt === null ? entry.z : target.z + radius * Math.cos(circle.angle)
    const desiredVx = orbitAt === null ? clamp((desiredX - state.positionM.x) * 1.2, -4, 4)
      : departing ? DEPARTURE_SPEED_MPS * Math.sin(circle.angle) : radius * circle.speed * Math.cos(circle.angle)
    const desiredVz = orbitAt === null ? clamp((desiredZ - state.positionM.z) * 1.2, -4, 4)
      : departing ? DEPARTURE_SPEED_MPS * Math.cos(circle.angle) : -radius * circle.speed * Math.sin(circle.angle)
    const accelerationX = clamp((orbitAt === null ? 0 : radius * (circle.acceleration * Math.cos(circle.angle) - circle.speed ** 2 * Math.sin(circle.angle)))
      + (desiredX - state.positionM.x) * 1.2 + (desiredVx - velocity.x) * 2.2, -10, 10)
    const accelerationZ = clamp((orbitAt === null ? 0 : -radius * (circle.acceleration * Math.sin(circle.angle) + circle.speed ** 2 * Math.cos(circle.angle)))
      + (desiredZ - state.positionM.z) * 1.2 + (desiredVz - velocity.z) * 2.2, -10, 10)
    const accelerationY = clamp((clamp((target.y - state.positionM.y) * 1.5, -2.5, 3) - velocity.y) * 3, -5, 10)
    const force = { x: settings.drone.massKg * accelerationX + settings.drone.linearDragCoefficientNPerMps.x * velocity.x,
      y: settings.drone.massKg * (settings.drone.gravityMps2 + accelerationY) + settings.drone.linearDragCoefficientNPerMps.y * velocity.y,
      z: settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z }
    const dx = state.positionM.x - target.x
    const dz = state.positionM.z - target.z
    const turningOut = orbitAt !== null && time > orbitAt + CIRCLE_SECONDS
    const yaw = Math.atan2(dx, dz) + (turningOut ? Math.PI : 0)
    const localX = Math.cos(yaw) * force.x - Math.sin(yaw) * force.z
    const localZ = Math.sin(yaw) * force.x + Math.cos(yaw) * force.z
    const pitch = Math.atan2(localZ, force.y)
    const roll = -Math.atan2(localX, Math.hypot(force.y, localZ))
    const desired = multiplyQuaternions(quaternionFromRotationVector({ x: 0, y: yaw, z: 0 }),
      multiplyQuaternions(quaternionFromRotationVector({ x: pitch, y: 0, z: 0 }), quaternionFromRotationVector({ x: 0, y: 0, z: roll })))
    const yawRate = clamp((dz * velocity.x - dx * velocity.z) / Math.max(1, dx * dx + dz * dz), -1, 1)
    const throttle = clamp(Math.hypot(force.x, force.y, force.z) / maximumThrust, 0, 0.95)
    if (time < 0.5) return { roll: 0, pitch: 0, yaw: 0, throttle: collectiveThrottle(simulation, launch.y, 1) }
    return attitudeInput(desired, throttle, yawRate)
  }
  const initial = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initial, armed: true, telemetry: simulation.getTelemetry() })
  observe(initial)
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) throw new RangeError('目前設定無法安全完成正刷鍋示範，請採用新手或一般預設。')
    const retained = recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })
    if (!retained) continue
    observe(input)
    if (orbitAt !== null && !orbitCueWritten) {
      cue(step.state.timeSeconds, '現在開始側向環繞：機頭朝向參考目標，逐漸加入側移及偏航，實際繞過目標四周。')
      orbitCueWritten = true
    }
    if (orbitAt !== null && !exitCueWritten && step.state.timeSeconds > orbitAt + CIRCLE_SECONDS - RAMP_SECONDS) {
      cue(step.state.timeSeconds, '現在開始減速改出：保持高度，逐漸收住側向速度，接著轉向塔外並實際飛離。')
      exitCueWritten = true
    }
    if (orbitAt !== null && !departureCueWritten && step.state.timeSeconds > orbitAt + CIRCLE_SECONDS + DEPARTURE_TURN_SECONDS) {
      cue(step.state.timeSeconds, '現在朝塔外飛離：機頭已轉向外側，主動向外飛出至少 3 m，保持高度並恢復控制。')
      departureCueWritten = true
    }
    if (finished && orbitAt !== null && Math.hypot(step.state.positionM.x - target.x, step.state.positionM.z - target.z) > ORBIT_TARGET_RADIUS_M + 7) {
      cue(step.state.timeSeconds, CAPTIONS[9])
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成正刷鍋示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
