import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createWallRide, WALL_RIDE_TARGET_HEIGHT_M } from '../world/wallRide'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { WALL_RIDE_LESSON, wallRideEvaluator } from './wallRide'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const FORWARD_SPEED_MPS = 8
const RAMP_SECONDS = 2
const MAXIMUM_DURATION_SECONDS = 45
const CAPACITY = 4_000
const BANK_DEGREES = 75
const CAPTIONS = [
  '從地面自行起飛；騎牆示範使用實際搖桿、相同飛控及實體牆面，觀看不計真人成績。',
  '第 2 步：自行起飛至約 60 m，先保留側傾下沉與回正改出的空間。',
  '第 3 步：靠近右側牆的進場區，保持間隙，先看清沿牆前進的方向。',
  '第 4 步：先建立真正沿牆向前的動量，再開始側傾；不需要停住或懸停。',
  '第 5 步：側傾使機腹朝向牆面；牆面在 FPV 中像地面，靠實際動量沿牆飛行。',
  '第 6 步：保留間隙沿牆飛過至少 16 m，維持至少 2 秒；此時推力的向上分量較少，示範會自然下沉，不吸附牆面或自動定高。',
  '第 7 步：貼牆段已完成，修回正飛並往遠離牆面的方向改出，維持非接觸間隙。',
  '第 8 步：已離開牆面，減緩旋轉及升降、恢復空中控制；可以繼續向前，不必停住或降落。',
  '騎牆八步完成：從地面起飛、帶速進場，機腹朝牆並保留間隙沿牆飛過，再回正離牆。',
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Only normal RC inputs author this separate recording; live flight is never assisted. */
export function recordWallRideDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const wall = createWallRide(launch, ground)
  const altitude = ground + WALL_RIDE_TARGET_HEIGHT_M
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumRate = (axis: RateAxis): number => Math.min(180, settings.controller.rates.axes[axis].maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec[axis] ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumRate('roll') < 100 || maximumRate('pitch') < 60 || maximumRate('yaw') < 60 || maximumThrust / settings.drone.massKg < 18) {
    throw new RangeError('目前角速度或推力不足以完成騎牆示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 }, wall.colliders)
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'wall-ride-entry', kind: 'marker', positionM: wall.entryM },
    { id: 'wall-ride-start', kind: 'marker', positionM: wall.rideStartM },
    { id: 'wall-ride-end', kind: 'marker', positionM: wall.rideEndM },
    { id: 'wall-ride-exit', kind: 'marker', positionM: wall.exitM }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: 'wall-ride-entry', wallRidePhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let positionAt: number | null = null
  let travelAt: number | null = null
  let bankAt: number | null = null
  let bankEnd: number | null = null
  let finishedAt: number | null = null
  let completedMovie = false
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = wallRideEvaluator.evaluate(sample, { lesson: WALL_RIDE_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if ((next.metrics?.wallRideInterrupted ?? 0) > 0.5) throw new RangeError(`目前設定無法連續完成騎牆示範。${next.message ?? next.hint ?? ''}`)
    if (next.status === 'failure') throw new RangeError(`目前設定無法完成騎牆示範。${next.message ?? ''}`)
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    previous = sample
    evaluation = next
    const nextPhase = next.metrics?.wallRidePhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cues.push({ timeSeconds: state.timeSeconds, text: CAPTIONS[phase],
        targetReferenceId: phase >= 6 ? 'wall-ride-exit' : phase >= 4 ? 'wall-ride-end' : 'wall-ride-entry', wallRidePhase: phase })
    }
    if (phase >= 6) bankEnd ??= state.timeSeconds
    if (next.status === 'success') finishedAt ??= state.timeSeconds
  }
  const attitudeInput = (desired: Quaternion, throttle: number): NormalizedRcInput => {
    const state = simulation.getState()
    let error = multiplyQuaternions(conjugateQuaternion(state.orientation), desired)
    if (error.w < 0) error = { x: -error.x, y: -error.y, z: -error.z, w: -error.w }
    const sine = Math.hypot(error.x, error.y, error.z)
    const factor = sine > 1e-8 ? 2 * Math.atan2(sine, Math.max(0, error.w)) / sine : 2
    const pilot = bodyAngularRateToPilotAxes({
      x: error.x * factor * 7 - state.angularVelocityBodyRadPerSec.x * 0.08,
      y: error.y * factor * 7 - state.angularVelocityBodyRadPerSec.y * 0.08,
      z: error.z * factor * 7 - state.angularVelocityBodyRadPerSec.z * 0.08,
    })
    return { roll: stickForRate(settings, 'roll', clamp(pilot.roll * 180 / Math.PI, -maximumRate('roll'), maximumRate('roll'))),
      pitch: stickForRate(settings, 'pitch', clamp(pilot.pitch * 180 / Math.PI, -maximumRate('pitch'), maximumRate('pitch'))),
      yaw: stickForRate(settings, 'yaw', clamp(pilot.yaw * 180 / Math.PI, -maximumRate('yaw'), maximumRate('yaw'))), throttle }
  }
  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const position = state.positionM
    const velocity = state.velocityMps
    const progress = launch.z - position.z
    if (positionAt === null && Math.abs(position.y - altitude) < 0.25 && Math.abs(velocity.y) < 0.5) positionAt = time
    if (positionAt !== null && travelAt === null && Math.abs(position.x - wall.entryM.x) < 0.25
      && Math.abs(position.z - launch.z) < 0.25 && Math.hypot(velocity.x, velocity.z) < 0.4) travelAt = time
    if (travelAt !== null && bankAt === null && position.z <= wall.nearZM) bankAt = time
    if (bankAt !== null && bankEnd === null) {
      if (time - bankAt > 4) throw new RangeError('目前設定未能在保留間隙的側傾段完成騎牆，請採用新手或一般預設。')
      // Coast through the bank on established forward momentum. Reducing
      // collective lets gravity act normally while thrust points away from the
      // wall. This does not manufacture support, adhesion or a fixed height.
      const desired = multiplyQuaternions(quaternionFromRotationVector({ x: -5 * Math.PI / 180, y: 0, z: 0 }),
        quaternionFromRotationVector({ x: 0, y: 0, z: BANK_DEGREES * Math.PI / 180 }))
      return attitudeInput(desired, settings.drone.massKg * settings.drone.gravityMps2 * 0.12 / maximumThrust)
    }
    const targetAltitude = bankEnd === null ? altitude : ground + WALL_RIDE_TARGET_HEIGHT_M - 20
    const targetX = bankEnd !== null ? wall.exitM.x : positionAt === null ? launch.x : wall.entryM.x
    const ramp = travelAt === null ? 0 : clamp((time - travelAt) / RAMP_SECONDS, 0, 1)
    const speed = FORWARD_SPEED_MPS * ramp * ramp * (3 - 2 * ramp)
    const targetVx = bankEnd !== null ? clamp((targetX - position.x) * 1.2, -4, 4)
      : travelAt !== null && progress >= 7 ? 1 : clamp((targetX - position.x) * 1.2, -3, 3)
    const targetVz = travelAt === null ? clamp((launch.z - position.z) * 1.2, -3, 3) : bankEnd === null ? -speed : -4
    const accelerationX = clamp((targetVx - velocity.x) * 3, -12, 12)
    const accelerationZ = clamp((targetVz - velocity.z) * 3, -8, 8)
    const accelerationY = clamp((clamp((targetAltitude - position.y) * 1.5, -3, 4) - velocity.y) * 3, -5, 14)
    const force = { x: settings.drone.massKg * accelerationX + settings.drone.linearDragCoefficientNPerMps.x * velocity.x,
      y: settings.drone.massKg * (settings.drone.gravityMps2 + accelerationY) + settings.drone.linearDragCoefficientNPerMps.y * velocity.y,
      z: settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z }
    const pitch = Math.atan2(force.z, force.y)
    const roll = -Math.atan2(force.x, Math.hypot(force.y, force.z))
    const desired = multiplyQuaternions(quaternionFromRotationVector({ x: pitch, y: 0, z: 0 }),
      quaternionFromRotationVector({ x: 0, y: 0, z: roll }))
    return attitudeInput(desired, clamp(Math.hypot(force.x, force.y, force.z) / maximumThrust, 0, 0.95))
  }
  const initial = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initial, armed: true, telemetry: simulation.getTelemetry() })
  observe(initial)
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) throw new RangeError('目前設定無法安全完成騎牆示範，請採用新手或一般預設。')
    if (!recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })) continue
    observe(input)
    if (finishedAt !== null && step.state.timeSeconds >= finishedAt + 0.65) {
      cues.push({ timeSeconds: step.state.timeSeconds, text: CAPTIONS[8], targetReferenceId: 'wall-ride-exit', wallRidePhase: 8 })
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError('目前設定無法在錄影容量內完成騎牆示範，請採用新手或一般預設。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
