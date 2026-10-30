import { droneGroundSupport } from '../drone'
import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { conjugateQuaternion, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createGravityGate, gravityGateTopCrossing, GRAVITY_GATE_TOP_HEIGHT_M } from '../world/gravityGate'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { GRAVITY_GATE_LESSON, GRAVITY_GATE_PRACTICE_HEIGHT_M, gravityGateEvaluator } from './gravityGate'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

const STEP_SECONDS = 1 / 240
const MAXIMUM_DURATION_SECONDS = 80
const CAPACITY = 5_000
const APPROACH_SPEED_MPS = 6
const COAST_THROTTLE = 0.04
const CAPTIONS = [
  '從地面自行起飛；重力門示範使用實際搖桿、同一套物理與實體門框，觀看不計真人成績。',
  `第 2 步：自行起飛至約 ${GRAVITY_GATE_PRACTICE_HEIGHT_M} m；辨認上方金黃色頂部入口與遠端青色側面出口。`,
  '第 3 步：先拉開距離，朝門架建立前進速度；不要直接從側面穿過。',
  `第 4 步：帶著前進動量加油門上拋，取得越過 ${GRAVITY_GATE_TOP_HEIGHT_M} m 頂框所需的高度。`,
  '第 5 步：上拋後降低油門並調整俯仰，讓下落路線朝向金黃色頂部入口。',
  '第 6 步：已收油並實際調姿；順著下落軌跡由頂部向下進入框內。',
  '第 7 步：已由頂部進框；看向青色側面出口，補回推力並從遠端側面飛出。',
  '第 8 步：已從指定側面飛出；修平姿態、止住下沉並恢復控制，不需要降落。',
  '重力門八步已完成：自行起飛、帶速上拋、收油調姿、頂部向下進框、側面改出，再恢復控制。',
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
  if (maximumRate('pitch') < 90 || maximumRate('roll') < 60 || maximumRate('yaw') < 60 || maximumThrust / settings.drone.massKg < 27) {
    throw new RangeError('目前角速度或推力不足以完成重力門示範，請採用新手或一般預設。')
  }
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 }, gate.colliders)
  simulation.arm()
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'gravity-gate-frame', kind: 'gate', positionM: gate.centerM }]
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  const cues: TeachingCue[] = [{ timeSeconds: 0, text: CAPTIONS[0], targetReferenceId: gate.id, gravityGatePhase: 0 }]
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  let phase = 0
  let stage: 'lift' | 'approach' | 'throw' | 'coast' | 'exit' = 'lift'
  let pendingCaption: string | null = null
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
      throw new RangeError(`目前設定無法完成重力門示範。${next.message ?? ''} ${next.hint ?? ''}（${stage}, t=${state.timeSeconds.toFixed(2)}, y=${(state.positionM.y - ground).toFixed(2)}, z=${(state.positionM.z - launch.z).toFixed(2)}）`)
    }
    for (const id of next.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: state.timeSeconds, metrics: { ...next.metrics } }
    if (stage === 'coast' && previous && gravityGateTopCrossing(previous.state.positionM, state.positionM, gate)?.insideOpening) stage = 'exit'
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
    const velocity = state.velocityMps
    const altitude = state.positionM.y - ground
    if (stage === 'lift' && Math.abs(altitude - GRAVITY_GATE_PRACTICE_HEIGHT_M) < 0.4 && Math.abs(velocity.y) < 0.6) stage = 'approach'
    if (stage === 'approach' && state.positionM.z <= gate.centerM.z + 20 && velocity.z < -4) {
      stage = 'throw'
      pendingCaption = `現在開始上拋：保留前進動量、加油門取得高度；頂框在 ${GRAVITY_GATE_TOP_HEIGHT_M} m，先到頂部開口上方。`
    }
    if (stage === 'throw' && altitude >= 20.3 && velocity.y >= 10) {
      stage = 'coast'
      pendingCaption = '現在收油並調整俯仰：依慣性繼續上升，越過最高點後朝頂部開口下落。'
    }
    if (time < 0.5) return { roll: 0, pitch: 0, yaw: 0, throttle: collectiveThrottle(simulation, launch.y, 1) }
    if (stage === 'coast') return attitudeInput(quaternionFromRotationVector({ x: -25 * Math.PI / 180, y: 0, z: 0 }), COAST_THROTTLE)
    const targetVx = clamp((launch.x - state.positionM.x) * 1.2, -3, 3)
    const targetVz = stage === 'lift' ? clamp((launch.z - state.positionM.z) * 1.2, -3, 3) : -APPROACH_SPEED_MPS
    const accelerationX = clamp((targetVx - velocity.x) * 2.2, -7, 7)
    const accelerationZ = clamp((targetVz - velocity.z) * 2.2, -7, 7)
    const targetY = stage === 'exit' ? gate.centerM.y : ground + GRAVITY_GATE_PRACTICE_HEIGHT_M
    const accelerationY = stage === 'throw' ? 10 : clamp((clamp((targetY - state.positionM.y) * 1.5, -2.5, stage === 'lift' ? 3 : 4) - velocity.y) * 3, -5, 14)
    const force = { x: settings.drone.massKg * accelerationX + settings.drone.linearDragCoefficientNPerMps.x * velocity.x,
      y: settings.drone.massKg * (settings.drone.gravityMps2 + accelerationY) + settings.drone.linearDragCoefficientNPerMps.y * velocity.y,
      z: settings.drone.massKg * accelerationZ + settings.drone.linearDragCoefficientNPerMps.z * velocity.z }
    const pitch = Math.atan2(force.z, force.y)
    const roll = -Math.atan2(force.x, Math.hypot(force.y, force.z))
    const desired = multiplyQuaternions(quaternionFromRotationVector({ x: pitch, y: 0, z: 0 }), quaternionFromRotationVector({ x: 0, y: 0, z: roll }))
    return attitudeInput(desired, clamp(Math.hypot(force.x, force.y, force.z) / maximumThrust, 0, 0.95))
  }
  const initial = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initial, armed: true, telemetry: simulation.getTelemetry() })
  observe(initial)
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError(`目前設定無法安全完成重力門示範。${step.warnings.join(' ')}（${stage}, t=${step.state.timeSeconds.toFixed(2)}, y=${(step.state.positionM.y - ground).toFixed(2)}, z=${(step.state.positionM.z - launch.z).toFixed(2)}）`)
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
