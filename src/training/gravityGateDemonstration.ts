import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, inverseRotateVectorByQuaternion, multiplyQuaternions, quaternionFromRotationVector, rotateVectorByQuaternion, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createGravityGate, gravityGateLowerCrossing, gravityGateTopCrossing, GRAVITY_GATE_TOP_HEIGHT_M } from '../world/gravityGate'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { GRAVITY_GATE_LESSON, GRAVITY_GATE_PRACTICE_HEIGHT_M, gravityGateEvaluator } from './gravityGate'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const MAXIMUM_DURATION_SECONDS = 80
const CAPACITY = 5_000
const APPROACH_SPEED_MPS = 3.5
const COAST_THROTTLE = 0.04
const RETURN_TURN_SECONDS = 1.25
const CAPTIONS = [
  '從地面自行起飛；重力門示範使用實際搖桿、同一套物理與實體門框，觀看不計真人成績。',
  `第 2 步：自行起飛至約 ${GRAVITY_GATE_PRACTICE_HEIGHT_M} m，再繞到門框右側的進場點；頂部入、低層向來向折返。`,
  '第 3 步：從進場點朝門框側邊前飛；先建立側向進場速度，再向上拋。',
  `第 4 步：保留側向前進動量加油門上拋，到 ${GRAVITY_GATE_TOP_HEIGHT_M} m 水平頂口上方。`,
  '第 5 步：上拋後收油並調姿，沿實際慣性越過頂點，對準金色水平頂口。',
  '第 6 步：已收油並調姿；由水平頂口向下落入框內。',
  '第 7 步：已由頂口落入；先下降到低層，再向來向折返，從同側青色出口飛出。',
  '第 8 步：已在低層反向飛出同側出口；修平姿態、減緩升降與旋轉，不需要降落。',
  '重力門八步已完成：地面起飛、側向前飛上拋、收油調姿、頂口落入、低層折返同側飛出，再恢復控制。',
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** A separate teaching flight, authored solely with ordinary fixed-step RC commands. */
export function recordGravityGateDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const ground = settings.drone.ground.heightM
  const gate = createGravityGate(launch, ground)
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const maximumRate = (axis: RateAxis): number => Math.min(180, settings.controller.rates.axes[axis].maxRateDegPerSec * 0.94,
    (settings.controller.rateLimitsDegPerSec[axis] ?? Number.POSITIVE_INFINITY) * 0.94)
  if (maximumRate('pitch') < 90 || maximumRate('roll') < 60 || maximumRate('yaw') < 90 || maximumThrust / settings.drone.massKg < 27) {
    throw new RangeError('目前角速度或推力不足以完成重力門示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 }, gate.colliders)
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: gate.id, kind: 'gate', positionM: gate.centerM }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: gate.id, gravityGatePhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let stage: 'lift' | 'position' | 'approach' | 'throw' | 'coast' | 'descend' | 'return' = 'lift'
  let pendingCaption: string | null = null
  let turnAt: number | null = null
  let finishedAt: number | null = null
  let completedMovie = false
  const cue = (time: number, text: string): void => {
    cues.push({ timeSeconds: time, text, targetReferenceId: gate.id, gravityGatePhase: phase })
  }
  const observe = (input: NormalizedRcInput): void => {
    const state = simulation.getState()
    const supportOffsetM = droneGroundSupport(settings.drone, state.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: state.timeSeconds, state, armed: simulation.isArmed(), normalizedInput: input,
      groundContact: { heightM: ground, supportOffsetM,
        touching: state.positionM.y - supportOffsetM <= ground + GROUND_CONTACT_SLOP_M + 1e-5 } }
    const next = gravityGateEvaluator.evaluate(sample, { lesson: GRAVITY_GATE_LESSON, mode: 'practice', elapsedSeconds: state.timeSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    if ((next.metrics?.gravityGateInterrupted ?? 0) > 0.5 || next.status === 'failure') {
      throw new RangeError(`目前設定無法完成重力門示範。${next.message ?? ''} ${next.hint ?? ''}（${stage}, t=${state.timeSeconds.toFixed(2)}, x=${(state.positionM.x - launch.x).toFixed(2)}, y=${(state.positionM.y - ground).toFixed(2)}, z=${(state.positionM.z - launch.z).toFixed(2)}）`)
    }
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    if (stage === 'coast' && previous && gravityGateTopCrossing(previous.state.positionM, state.positionM, gate)?.insideOpening) {
      stage = 'descend'
      pendingCaption = '已從水平頂口向下落入；保持在框內，先降過中層環，再向來向折返。'
    }
    if (stage === 'descend' && previous && gravityGateLowerCrossing(previous.state.positionM, state.positionM, gate)?.insideOpening) {
      stage = 'return'
      turnAt = state.timeSeconds
      pendingCaption = '現在已降到低層：改變實際移動方向，朝來向的青色出口折返；只轉機頭不算反向飛出。'
    }
    previous = sample
    evaluation = next
    if (pendingCaption !== null) { cue(state.timeSeconds, pendingCaption); pendingCaption = null }
    const nextPhase = next.metrics?.gravityGatePhase ?? 0
    if (nextPhase !== phase) {
      phase = nextPhase
      cue(state.timeSeconds, CAPTIONS[phase])
    }
    if (next.status === 'success') finishedAt ??= state.timeSeconds
  }
  const attitudeInput = (desired: Quaternion, throttle: number, yawFeedforward = 0): NormalizedRcInput => {
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
    const altitude = state.positionM.y - ground
    if (stage === 'lift' && Math.abs(altitude - GRAVITY_GATE_PRACTICE_HEIGHT_M) < 0.3 && Math.abs(velocity.y) < 0.5) {
      stage = 'position'
      pendingCaption = '先繞到門框右側的進場點，轉向門框側邊；金色水平頂口才是下降入口。'
    }
    if (stage === 'position') {
      const nose = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
      if (Math.hypot(state.positionM.x - gate.approachPointM.x, state.positionM.z - gate.approachPointM.z) < 0.3
        && Math.hypot(velocity.x, velocity.z) < 0.4 && nose.x < -0.97) stage = 'approach'
    }
    if (stage === 'approach' && state.positionM.x <= gate.centerM.x + 11 && velocity.x < -2.5) {
      stage = 'throw'
      pendingCaption = `保留朝門框側邊的動量，現在加油門上拋；先取得高於 ${GRAVITY_GATE_TOP_HEIGHT_M} m 頂口的高度。`
    }
    if (stage === 'throw' && altitude >= 12.1 && velocity.y >= 8.3) {
      stage = 'coast'
      pendingCaption = '現在收油並調整俯仰；讓慣性帶飛機越過最高點，再朝水平頂口下落。'
    }
    if (time < 0.5) return { roll: 0, pitch: 0, yaw: 0, throttle: collectiveThrottle(simulation, launch.y, 1) }
    if (stage === 'coast') return attitudeInput(multiplyQuaternions(quaternionFromRotationVector({ x: 0, y: Math.PI / 2, z: 0 }),
      quaternionFromRotationVector({ x: -25 * Math.PI / 180, y: 0, z: 0 })), COAST_THROTTLE)
    const turnU = turnAt === null ? 0 : clamp((time - turnAt) / RETURN_TURN_SECONDS, 0, 1)
    const yaw = stage === 'lift' ? 0 : Math.PI / 2 - Math.PI * turnU * turnU * (3 - 2 * turnU)
    const yawRate = turnU > 0 && turnU < 1 ? -Math.PI * 6 * turnU * (1 - turnU) / RETURN_TURN_SECONDS : 0
    const targetVx = stage === 'lift' ? clamp((launch.x - state.positionM.x) * 1.2, -3, 3)
      : stage === 'position' ? clamp((gate.approachPointM.x - state.positionM.x) * 1.2, -3.5, 3.5)
        : stage === 'descend' ? 0
          : stage === 'return' ? APPROACH_SPEED_MPS : -APPROACH_SPEED_MPS
    const targetZ = stage === 'lift' ? launch.z : gate.centerM.z
    const targetVz = clamp((targetZ - state.positionM.z) * 1.2, -3.5, 3.5)
    const accelerationX = clamp((targetVx - velocity.x) * 2.5, -8, 8)
    const accelerationZ = clamp((targetVz - velocity.z) * 2.5, -8, 8)
    const targetY = stage === 'descend' || stage === 'return' ? gate.sideExitCenterM.y : ground + GRAVITY_GATE_PRACTICE_HEIGHT_M
    const maximumFallSpeed = stage === 'descend' ? 4 : 2.5
    const accelerationY = stage === 'throw' ? 10 : clamp((clamp((targetY - state.positionM.y) * 1.5, -maximumFallSpeed, 3) - velocity.y) * 3, -5, 14)
    const force = { x: settings.drone.massKg * accelerationX + settings.drone.linearDragCoefficientNPerMps.x * velocity.x,
      y: settings.drone.massKg * (settings.drone.gravityMps2 + accelerationY) + settings.drone.linearDragCoefficientNPerMps.y * velocity.y,
      z: settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z }
    const localX = Math.cos(yaw) * force.x - Math.sin(yaw) * force.z
    const localZ = Math.sin(yaw) * force.x + Math.cos(yaw) * force.z
    const pitch = Math.atan2(localZ, force.y)
    const roll = -Math.atan2(localX, Math.hypot(force.y, localZ))
    const desired = multiplyQuaternions(quaternionFromRotationVector({ x: 0, y: yaw, z: 0 }),
      multiplyQuaternions(quaternionFromRotationVector({ x: pitch, y: 0, z: 0 }), quaternionFromRotationVector({ x: 0, y: 0, z: roll })))
    return attitudeInput(desired, clamp(Math.hypot(force.x, force.y, force.z) / maximumThrust, 0, 0.95), yawRate)
  }
  const initial = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initial, armed: true, telemetry: simulation.getTelemetry() })
  observe(initial)
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError(`目前設定無法安全完成重力門示範。${step.warnings.join(' ')}（${stage}, t=${step.state.timeSeconds.toFixed(2)}, x=${(step.state.positionM.x - launch.x).toFixed(2)}, y=${(step.state.positionM.y - ground).toFixed(2)}, z=${(step.state.positionM.z - launch.z).toFixed(2)}）`)
    }
    if (!recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })) continue
    observe(input)
    if (finishedAt !== null && step.state.timeSeconds >= finishedAt + 0.8) {
      cue(step.state.timeSeconds, CAPTIONS[8])
      completedMovie = true
      break
    }
  }
  if (!completedMovie) throw new RangeError(`目前設定無法在錄影容量內完成重力門示範，請採用新手或一般預設。（${stage}，phase ${phase}）`)
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((value) => Object.freeze(value))) }
}
