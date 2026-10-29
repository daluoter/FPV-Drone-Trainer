import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, inverseRotateVectorByQuaternion, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { createReverseOrbitTarget, REVERSE_ORBIT_LESSON, REVERSE_ORBIT_REQUIRED_LAPS, REVERSE_ORBIT_FLIGHT_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M, reverseOrbitEvaluator } from './reverseOrbit'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
// At half tower height, a steeper inward thrust vector keeps the jib visible
// through the beginner preset's 10-degree FPV mount without changing its camera.
const ANGULAR_SPEED_RAD_PER_SECOND = 1.45
const RAMP_SECONDS = 3
const DEPARTURE_DELAY_SECONDS = 1.5
const DEPARTURE_SPEED_MPS = 3
const MAXIMUM_DURATION_SECONDS = 120
const CAPACITY = 8_000
const CAPTIONS = [
  '從地面自行起飛；倒刷鍋示範使用實際搖桿與同一套物理，觀看不計真人成績。',
  `第 2 步：自行起飛至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m（起重機塔高的一半），辨認高處塔式起重機及長機臂。`,
  '第 3 步：接近起重機旁約 10 m，逐漸建立側移、抬頭仰視機臂；推力仍斜向上並朝向圓心。',
  '第 4 步：已建立仰視環繞；持續看著高處機臂繞行，開始第 1 個完整圈。',
  '第 1 圈完成；持續仰視機臂，沿同一方向繼續第 2 圈。',
  '第 2 圈完成；保持機臂可見，配合側移、偏航與油門，繼續第 3 圈。',
  '第 3 圈完成；逐漸減少環繞速度、修平姿態，再朝起重機外側實際飛離。',
  '倒刷鍋七步已完成：從地面起飛，仰視機臂連續環繞三個完整圈，再飛離並恢復控制。',
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
function smooth(value: number): number { return value * value * (3 - 2 * value) }

/** Authored path derivatives generate RC inputs; they never replace recorded poses. */
function circleAt(elapsed: number, completedAt: number | null): { angle: number; speed: number; acceleration: number } {
  const maximum = ANGULAR_SPEED_RAD_PER_SECOND
  const rampAngle = maximum * RAMP_SECONDS / 2
  const accelerating = (time: number) => {
    if (time <= 0) return { angle: 0, speed: 0, acceleration: 0 }
    if (time < RAMP_SECONDS) {
      const u = time / RAMP_SECONDS
      return { angle: maximum * RAMP_SECONDS * (u ** 3 - u ** 4 / 2), speed: maximum * smooth(u),
        acceleration: maximum * (6 * u - 6 * u ** 2) / RAMP_SECONDS }
    }
    return { angle: rampAngle + (time - RAMP_SECONDS) * maximum, speed: maximum, acceleration: 0 }
  }
  if (completedAt === null || elapsed <= completedAt) return accelerating(elapsed)
  const start = accelerating(completedAt)
  const u = clamp((elapsed - completedAt) / RAMP_SECONDS, 0, 1)
  return { angle: start.angle + start.speed * RAMP_SECONDS * (u - u ** 3 + u ** 4 / 2),
    speed: start.speed * (1 - smooth(u)), acceleration: -start.speed * (6 * u - 6 * u ** 2) / RAMP_SECONDS }
}

/** A separate physical flight, controlled exclusively with normalized RC input. */
export function recordReverseOrbitDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const target = createReverseOrbitTarget(launch, ground)
  const flightHeight = ground + REVERSE_ORBIT_FLIGHT_HEIGHT_M
  const entry = { x: target.x, y: flightHeight, z: target.z + REVERSE_ORBIT_TARGET_RADIUS_M }
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumRate = (axis: RateAxis): number => Math.min(180, settings.controller.rates.axes[axis].maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec[axis] ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumRate('yaw') < 100 || maximumRate('pitch') < 100 || maximumRate('roll') < 100 || maximumThrust / settings.drone.massKg < 27) {
    throw new RangeError('目前角速度或推力不足以完成倒刷鍋示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 })
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'reverse-orbit-zone', kind: 'zone', positionM: target }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: 'reverse-orbit-zone', reverseOrbitPhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let finished = false
  let completedMovie = false
  let approachAt: number | null = null
  let entrySettledAt: number | null = null
  let orbitAt: number | null = null
  let circlesCompletedAt: number | null = null
  let orbitCueWritten = false
  let departureCueWritten = false
  const cue = (time: number, text: string): void => {
    cues.push({ timeSeconds: time, text, targetReferenceId: 'reverse-orbit-zone', reverseOrbitPhase: phase })
  }
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      fpvCamera: settings.camera,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = reverseOrbitEvaluator.evaluate(sample, { lesson: REVERSE_ORBIT_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if ((next.metrics?.reverseOrbitInterrupted ?? 0) > 0.5) throw new RangeError(`目前設定無法連續完成倒刷鍋示範。${next.hint ?? ''}`)
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成倒刷鍋模擬示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.reverseOrbitPhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cue(state.timeSeconds, CAPTIONS[phase])
    }
    if ((next.metrics?.reverseOrbitCompletedLaps ?? 0) >= REVERSE_ORBIT_REQUIRED_LAPS) circlesCompletedAt ??= state.timeSeconds
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
    if (approachAt === null && Math.abs(state.positionM.y - flightHeight) < 0.5 && Math.abs(velocity.y) < 0.6) approachAt = time
    const entryDistance = Math.hypot(state.positionM.x - entry.x, state.positionM.z - entry.z)
    if (approachAt !== null && orbitAt === null) {
      if (entryDistance < 0.4 && Math.hypot(velocity.x, velocity.z) < 0.35) {
        entrySettledAt ??= time
        if (time - entrySettledAt > 0.3) orbitAt = time
      } else entrySettledAt = null
    }
    const elapsed = orbitAt === null ? 0 : time - orbitAt
    const completedElapsed = circlesCompletedAt === null || orbitAt === null ? null : circlesCompletedAt - orbitAt
    const circle = circleAt(elapsed, completedElapsed)
    const departureElapsed = circlesCompletedAt === null ? 0 : Math.max(0, time - circlesCompletedAt - RAMP_SECONDS - DEPARTURE_DELAY_SECONDS)
    const radius = REVERSE_ORBIT_TARGET_RADIUS_M + Math.min(12, departureElapsed * DEPARTURE_SPEED_MPS)
    const departing = departureElapsed > 0
    const desiredX = orbitAt === null ? launch.x : target.x + radius * Math.sin(circle.angle)
    const desiredZ = approachAt === null ? launch.z : orbitAt === null ? entry.z : target.z + radius * Math.cos(circle.angle)
    const desiredVx = orbitAt === null ? clamp((desiredX - state.positionM.x) * 1.2, -4, 4)
      : departing ? DEPARTURE_SPEED_MPS * Math.sin(circle.angle) : radius * circle.speed * Math.cos(circle.angle)
    const desiredVz = orbitAt === null ? clamp((desiredZ - state.positionM.z) * 1.2, -4, 4)
      : departing ? DEPARTURE_SPEED_MPS * Math.cos(circle.angle) : -radius * circle.speed * Math.sin(circle.angle)
    const accelerationX = clamp((orbitAt === null ? 0 : radius * (circle.acceleration * Math.cos(circle.angle) - circle.speed ** 2 * Math.sin(circle.angle)))
      + (desiredX - state.positionM.x) * 1.2 + (desiredVx - velocity.x) * 2.2, -24, 24)
    const accelerationZ = clamp((orbitAt === null ? 0 : -radius * (circle.acceleration * Math.sin(circle.angle) + circle.speed ** 2 * Math.cos(circle.angle)))
      + (desiredZ - state.positionM.z) * 1.2 + (desiredVz - velocity.z) * 2.2, -24, 24)
    const accelerationY = clamp((clamp((flightHeight - state.positionM.y) * 1.5, -2.5, 3) - velocity.y) * 3, -5, 10)
    const force = { x: settings.drone.massKg * accelerationX + settings.drone.linearDragCoefficientNPerMps.x * velocity.x,
      y: settings.drone.massKg * (settings.drone.gravityMps2 + accelerationY) + settings.drone.linearDragCoefficientNPerMps.y * velocity.y,
      z: settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z }
    const dx = state.positionM.x - target.x
    const dz = state.positionM.z - target.z
    // The nose changes side while the thrust vector continues inward and up.
    const outwardBlend = orbitAt === null ? 0 : smooth(clamp(elapsed / RAMP_SECONDS, 0, 1))
    const yaw = Math.atan2(dx, dz) + Math.PI * outwardBlend
    const localX = Math.cos(yaw) * force.x - Math.sin(yaw) * force.z
    const localZ = Math.sin(yaw) * force.x + Math.cos(yaw) * force.z
    const pitch = Math.atan2(localZ, force.y)
    const roll = -Math.atan2(localX, Math.hypot(force.y, localZ))
    const desired = multiplyQuaternions(quaternionFromRotationVector({ x: 0, y: yaw, z: 0 }),
      multiplyQuaternions(quaternionFromRotationVector({ x: pitch, y: 0, z: 0 }), quaternionFromRotationVector({ x: 0, y: 0, z: roll })))
    const radialYawRate = (dz * velocity.x - dx * velocity.z) / Math.max(1, dx * dx + dz * dz)
    const transitionYawRate = orbitAt !== null && elapsed < RAMP_SECONDS
      ? Math.PI * 6 * clamp(elapsed / RAMP_SECONDS, 0, 1) * (1 - clamp(elapsed / RAMP_SECONDS, 0, 1)) / RAMP_SECONDS : 0
    const throttle = clamp(Math.hypot(force.x, force.y, force.z) / maximumThrust, 0, 0.95)
    if (time < 0.5) return { roll: 0, pitch: 0, yaw: 0, throttle: collectiveThrottle(simulation, launch.y, 1) }
    return attitudeInput(desired, throttle, clamp(radialYawRate + transitionYawRate, -2.5, 2.5))
  }
  const initial = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initial, armed: true, telemetry: simulation.getTelemetry() })
  observe(initial)
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) throw new RangeError('目前設定無法安全完成倒刷鍋示範，請採用新手或一般預設。')
    if (!recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })) continue
    observe(input)
    if (orbitAt !== null && !orbitCueWritten) {
      cue(step.state.timeSeconds, '現在建立仰視環繞：逐步抬頭、加入側移與偏航，讓高處機臂保持在畫面內。')
      orbitCueWritten = true
    }
    if (circlesCompletedAt !== null && !departureCueWritten && step.state.timeSeconds > circlesCompletedAt + RAMP_SECONDS + DEPARTURE_DELAY_SECONDS) {
      cue(step.state.timeSeconds, '現在向起重機外側飛離：保持高度、實際向外移動至少 3 m，再恢復空中控制。')
      departureCueWritten = true
    }
    if (finished && Math.hypot(step.state.positionM.x - target.x, step.state.positionM.z - target.z) > REVERSE_ORBIT_TARGET_RADIUS_M + 7) {
      cue(step.state.timeSeconds, CAPTIONS[7])
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成倒刷鍋示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
