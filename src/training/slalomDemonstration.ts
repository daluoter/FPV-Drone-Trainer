import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, inverseRotateVectorByQuaternion, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createSlalomFlags, SLALOM_EXIT_DISTANCE_M, SLALOM_TARGET_HEIGHT_M } from '../world/slalomFlags'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { SLALOM_LESSON, slalomEvaluator } from './slalom'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const FORWARD_SPEED_MPS = 6
const RAMP_SECONDS = 2
const MAXIMUM_DURATION_SECONDS = 65
const CAPACITY = 4_000
const CAPTIONS = [
  '從地面自行起飛；刀旗 S 彎示範使用實際搖桿、相同飛控與實體旗標，觀看不計真人成績。',
  '第 2 步：自行起飛至約 4 m，先辨認前方六面刀旗及左右交替的路線。',
  '第 3 步：持續向前，從第 1 旗左側通過；示範會配合俯仰、橫滾、偏航與油門，不要求固定側立角度。',
  '第 4 步：已過第 1 旗左側，開始換向，從第 2 旗右側通過。',
  '第 5 步：已過第 2 旗右側，再換到左側，接第 3 旗；航跡持續向前。',
  '第 6 步：已過第 3 旗左側，反向側傾，從第 4 旗右側通過。',
  '第 7 步：已過第 4 旗右側，繼續接第 5 旗左側，不回頭繞圈。',
  '第 8 步：已過第 5 旗左側，接最後第 6 旗右側。',
  '第 9 步：六旗左右交替完成；沿前方出口繼續飛離，逐漸減少側傾與旋轉。',
  '第 10 步：已向前飛離旗列，修平機體、穩住升降與旋轉；保持前進也能完成，不需要停住或降落。',
  '刀旗 S 彎十步完成：從地面自行起飛，向前左右交替通過六旗，再回正飛離。',
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** A recorded physical flight; author feedback only generates ordinary RC inputs. */
export function recordSlalomDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const flags = createSlalomFlags(launch, ground)
  const first = flags[0]
  const last = flags.at(-1)!
  const spacing = first.positionM.z - flags[1].positionM.z
  const firstDistance = launch.z - first.positionM.z
  const lastDistance = launch.z - last.positionM.z
  const amplitude = Math.abs(first.passPointM.x - launch.x)
  const altitude = ground + SLALOM_TARGET_HEIGHT_M
  const exit = { x: last.passPointM.x, y: altitude, z: last.positionM.z - SLALOM_EXIT_DISTANCE_M }
  const colliders = flags.flatMap((flag) => flag.colliders)
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumRate = (axis: RateAxis): number => Math.min(180, settings.controller.rates.axes[axis].maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec[axis] ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumRate('yaw') < 100 || maximumRate('pitch') < 60 || maximumRate('roll') < 80 || maximumThrust / settings.drone.massKg < 18) {
    throw new RangeError('目前角速度或推力不足以完成刀旗 S 彎示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 }, colliders)
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    ...flags.map((flag) => ({ id: flag.id, kind: 'flag', positionM: flag.positionM })),
    { id: 'slalom-exit', kind: 'marker', positionM: exit }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: first.id, slalomPhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let positionAt: number | null = null
  let travelAt: number | null = null
  let finishedAt: number | null = null
  let completedMovie = false
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = slalomEvaluator.evaluate(sample, { lesson: SLALOM_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if ((next.metrics?.slalomInterrupted ?? 0) > 0.5) throw new RangeError(`目前設定無法連續完成刀旗 S 彎示範。${next.hint ?? ''}`)
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成刀旗 S 彎示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.slalomPhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cues.push({ timeSeconds: state.timeSeconds, text: CAPTIONS[phase],
        targetReferenceId: phase >= 8 ? 'slalom-exit' : flags[Math.max(0, Math.min(5, phase - 2))].id, slalomPhase: phase })
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
    if (positionAt === null && Math.abs(state.positionM.y - altitude) < 0.25 && Math.abs(velocity.y) < 0.5) positionAt = time
    if (positionAt !== null && travelAt === null && Math.abs(state.positionM.x - first.passPointM.x) < 0.25
      && Math.abs(state.positionM.z - launch.z) < 0.25 && Math.hypot(velocity.x, velocity.z) < 0.35) travelAt = time
    const progress = launch.z - state.positionM.z
    const ramp = travelAt === null ? 0 : clamp((time - travelAt) / RAMP_SECONDS, 0, 1)
    const forwardSpeed = FORWARD_SPEED_MPS * ramp * ramp * (3 - 2 * ramp)
    const onWeave = travelAt !== null && progress >= firstDistance && progress < lastDistance
    const angle = Math.PI * (progress - firstDistance) / spacing
    const derivative = onWeave ? amplitude * Math.PI / spacing * Math.sin(angle) : 0
    const secondDerivative = onWeave ? amplitude * (Math.PI / spacing) ** 2 * Math.cos(angle) : 0
    const targetX = positionAt === null ? launch.x : travelAt === null || progress < firstDistance ? first.passPointM.x
      : progress < lastDistance ? launch.x - amplitude * Math.cos(angle) : last.passPointM.x
    const targetVx = travelAt === null ? clamp((targetX - state.positionM.x) * 1.2, -3, 3) : derivative * forwardSpeed
    const targetVz = travelAt === null ? clamp((launch.z - state.positionM.z) * 1.2, -3, 3) : -forwardSpeed
    const accelerationX = clamp(secondDerivative * forwardSpeed ** 2 + (targetX - state.positionM.x) * 1.5 + (targetVx - velocity.x) * 2.5, -18, 18)
    const accelerationZ = clamp((targetVz - velocity.z) * 2.5, -8, 8)
    const accelerationY = clamp((clamp((altitude - state.positionM.y) * 1.5, -2.5, 3) - velocity.y) * 3, -5, 10)
    const force = { x: settings.drone.massKg * accelerationX + settings.drone.linearDragCoefficientNPerMps.x * velocity.x,
      y: settings.drone.massKg * (settings.drone.gravityMps2 + accelerationY) + settings.drone.linearDragCoefficientNPerMps.y * velocity.y,
      z: settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z }
    const yaw = -Math.atan(derivative)
    const yawRate = -secondDerivative * forwardSpeed / (1 + derivative ** 2)
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
    if (step.state.crashed || step.reset || !step.telemetry.armed) throw new RangeError('目前設定無法安全完成刀旗 S 彎示範，請採用新手或一般預設。')
    if (!recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })) continue
    observe(input)
    if (finishedAt !== null && step.state.timeSeconds >= finishedAt + 0.65) {
      cues.push({ timeSeconds: step.state.timeSeconds, text: CAPTIONS[10], targetReferenceId: 'slalom-exit', slalomPhase: 10 })
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成刀旗 S 彎示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
