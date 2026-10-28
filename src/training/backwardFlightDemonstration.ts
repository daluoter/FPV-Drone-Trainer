import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, inverseRotateVectorByQuaternion, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { BACKWARD_FLIGHT_LESSON, BACKWARD_FLIGHT_TARGET_HEIGHT_M, backwardFlightEvaluator } from './backwardFlight'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const TRAVEL_SPEED_MPS = 4
const TURN_SECONDS = 2.5
const MAXIMUM_DURATION_SECONDS = 45
const CAPACITY = 3_000
const CAPTIONS = [
  '從地面自行起飛；後退飛行示範使用實際搖桿與物理，觀看不計入真人成績。',
  '第 2 步：自行起飛到約 10 m，機腹保持朝下，觀察走廊的來向與去向。',
  '第 3 步：沿走廊建立真正前進速度；先有前進動量，再開始偏航轉頭。',
  '第 4 步：已有前進動量，現在偏航約 180°；機腹仍朝地，移動方向繼續沿原本去向。',
  '第 5 步：機頭已朝向來路；繼續沿原方向移動，形成相對機頭的真正後退飛行。',
  '第 6 步：已觀察到後退移動；維持機腹朝下及足夠後退距離，不用對準窄門或精準定高。',
  '第 7 步：後退路線已完成；再觀察一小段機腹朝下的後退移動，接著小量修正姿態並減速恢復控制。',
  '後退飛行七步已完成：先前進、偏航轉頭、實際向機尾移動，再減速恢復控制；不需要降落。',
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Authors normal RC input in a separate simulation; it never moves or assists the live aircraft. */
export function recordBackwardFlightDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const altitude = ground + BACKWARD_FLIGHT_TARGET_HEIGHT_M
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumRate = (axis: RateAxis): number => Math.min(180, settings.controller.rates.axes[axis].maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec[axis] ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumRate('yaw') < 100 || maximumRate('pitch') < 60 || maximumRate('roll') < 60 || maximumThrust / settings.drone.massKg < 18) {
    throw new RangeError('目前角速度或推力不足以完成後退飛行示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 })
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'backward-zone', kind: 'zone', positionM: { x: launch.x, y: altitude, z: launch.z - 25 } }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: 'backward-zone', backwardPhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let forwardAt: number | null = null
  let turnAt: number | null = null
  let brakingAt: number | null = null
  let finishedAt: number | null = null
  let completedMovie = false
  const cue = (time: number, text: string): void => {
    cues.push({ timeSeconds: time, text, targetReferenceId: 'backward-zone', backwardPhase: phase })
  }
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = backwardFlightEvaluator.evaluate(sample, { lesson: BACKWARD_FLIGHT_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if ((next.metrics?.backwardInterrupted ?? 0) > 0.5) throw new RangeError(`目前設定無法連續完成後退飛行示範。${next.hint ?? ''}`)
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成後退飛行模擬示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.backwardPhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cue(state.timeSeconds, CAPTIONS[phase])
    }
    if (phase >= 3 && turnAt === null) turnAt = state.timeSeconds + 0.5
    if (phase >= 6 && brakingAt === null && turnAt !== null && state.timeSeconds >= turnAt + TURN_SECONDS + 1.2) {
      brakingAt = state.timeSeconds
      cue(state.timeSeconds, '現在開始減速：機頭仍朝向來路，小量修正俯仰、維持推力，實際降低後退速度並恢復控制。')
    }
    if (next.status === 'success') finishedAt ??= state.timeSeconds
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
    if (forwardAt === null && Math.abs(state.positionM.y - altitude) < 0.5 && Math.abs(velocity.y) < 0.6) forwardAt = time
    const turnU = turnAt === null ? 0 : clamp((time - turnAt) / TURN_SECONDS, 0, 1)
    const yaw = Math.PI * turnU * turnU * (3 - 2 * turnU)
    const yawRate = turnU > 0 && turnU < 1 ? Math.PI * 6 * turnU * (1 - turnU) / TURN_SECONDS : 0
    const targetVz = forwardAt === null || brakingAt !== null ? 0 : -TRAVEL_SPEED_MPS
    const accelerationX = clamp((launch.x - state.positionM.x) * 1.2 - velocity.x * 2.2, -7, 7)
    const accelerationZ = clamp((targetVz - velocity.z) * 2.2, -7, 7)
    const accelerationY = clamp((clamp((altitude - state.positionM.y) * 1.5, -2.5, 3) - velocity.y) * 3, -5, 10)
    const force = { x: settings.drone.massKg * accelerationX + settings.drone.linearDragCoefficientNPerMps.x * velocity.x,
      y: settings.drone.massKg * (settings.drone.gravityMps2 + accelerationY) + settings.drone.linearDragCoefficientNPerMps.y * velocity.y,
      z: settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z }
    const localX = Math.cos(yaw) * force.x - Math.sin(yaw) * force.z
    const localZ = Math.sin(yaw) * force.x + Math.cos(yaw) * force.z
    const pitch = Math.atan2(localZ, force.y)
    const roll = -Math.atan2(localX, Math.hypot(force.y, localZ))
    const desired = multiplyQuaternions(quaternionFromRotationVector({ x: 0, y: yaw, z: 0 }),
      multiplyQuaternions(quaternionFromRotationVector({ x: pitch, y: 0, z: 0 }), quaternionFromRotationVector({ x: 0, y: 0, z: roll })))
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
    if (step.state.crashed || step.reset || !step.telemetry.armed) throw new RangeError('目前設定無法安全完成後退飛行示範，請採用新手或一般預設。')
    if (!recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })) continue
    observe(input)
    if (finishedAt !== null && step.state.timeSeconds >= finishedAt + 0.65) {
      cue(step.state.timeSeconds, CAPTIONS[7])
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成後退飛行示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
