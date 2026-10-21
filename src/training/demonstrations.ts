import { FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { rotateVectorByQuaternion } from '../math/quaternion'
import { applyActualRates, applyConfiguredRateLimit, type RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { flightSimulationConfigFromTuning, validateTuningSettings, type TuningSettings } from '../tuning/config'

export type TeachingDemonstrationKind = 'takeoff' | 'roll' | 'pitch' | 'yaw'

export interface TeachingCue {
  readonly timeSeconds: number
  readonly text: string
}

export interface TeachingDemonstration {
  readonly title: string
  readonly description: string
  readonly source: 'simulated'
  readonly recording: ReplayRecording
  readonly cues: readonly TeachingCue[]
}

const STEP_SECONDS = 1 / 240
const TAKEOFF_DURATION_SECONDS = 10
const AXIS_DURATION_SECONDS = 6.5
const AXIS_RATE_DEGREES_PER_SECOND = 15
const MAXIMUM_RECORDED_SAMPLES = 800

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Invert the configured rate curve, rather than assuming all presets need the same stick amount. */
function stickForRate(settings: TuningSettings, axis: RateAxis): number {
  const curve = settings.controller.rates.axes[axis]
  const limit = settings.controller.rateLimitsDegPerSec[axis]
  const rateAt = (stick: number): number => applyConfiguredRateLimit(applyActualRates(stick, curve), limit)
  if (rateAt(1) < AXIS_RATE_DEGREES_PER_SECOND) {
    throw new RangeError('目前角速度限制不足以產生示範，請先選擇新手或一般靈敏度。')
  }
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) * 0.5
    if (rateAt(middle) < AXIS_RATE_DEGREES_PER_SECOND) low = middle
    else high = middle
  }
  return (low + high) * 0.5
}

/** A recorded input generator, not a control mode offered to the live player. */
function demonstrationInput(
  simulation: FlightSimulation,
  timeSeconds: number,
  kind: TeachingDemonstrationKind,
  altitudeM: number,
  axisStick: number,
): NormalizedRcInput {
  const state = simulation.getState()
  const config = simulation.droneConfig
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const maximumThrust = config.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const targetVelocity = clamp((altitudeM - state.positionM.y) * 1.25, -0.65, 0.65)
  const acceleration = clamp((targetVelocity - state.velocityMps.y) * 3, -2, 2)
  const thrust = (config.massKg * (config.gravityMps2 + acceleration)
    + config.linearDragCoefficientNPerMps.y * state.velocityMps.y) / Math.max(0.5, up.y)
  const throttle = clamp(thrust / maximumThrust, 0, 0.85)
  const axisValue = kind === 'takeoff' ? 0
    : timeSeconds >= 1 && timeSeconds < 2 ? axisStick
      : timeSeconds >= 3.5 && timeSeconds < 4.5 ? -axisStick
        : 0
  return {
    roll: kind === 'roll' ? axisValue : 0,
    pitch: kind === 'pitch' ? axisValue : 0,
    yaw: kind === 'yaw' ? axisValue : 0,
    throttle,
  }
}

function cuesFor(kind: TeachingDemonstrationKind): readonly TeachingCue[] {
  if (kind === 'takeoff') return Object.freeze([
    { timeSeconds: 0, text: '先確認機身水平，緩慢建立推力。這是模擬錄製，尚待真人飛手驗證。' },
    { timeSeconds: 0.5, text: '增加油門讓機體平穩上升，保持其他三軸接近中央。' },
    { timeSeconds: 2.5, text: '接近目標前減少上升速度；油門控制推力，不是直接設定高度。' },
    { timeSeconds: 5, text: '在目標高度附近小幅補油，觀察機體是否仍有升降速度。' },
    { timeSeconds: 8, text: '連續穩住後完成起飛練習；實際操作仍需自己持續修正。' },
  ])
  const axisName = kind === 'roll' ? '橫滾 Roll' : kind === 'pitch' ? '俯仰 Pitch' : '偏航 Yaw'
  return Object.freeze([
    { timeSeconds: 0, text: `先看${axisName}；示範油門會隨姿態調整，真人飛行沒有自動定高。` },
    { timeSeconds: 1, text: `小量推動${axisName}，開始產生旋轉。` },
    { timeSeconds: 2, text: '搖桿回中後旋轉逐漸停止；Acro 不會自動回到原來姿態。' },
    { timeSeconds: 3.5, text: '反向小量修正，將姿態或機頭方向帶回。' },
    { timeSeconds: 4.5, text: '再次回中停止旋轉；機體仍可能因慣性繼續移動。' },
  ])
}

/**
 * Record a bounded real flight simulation without a renderer, RAF or live-device input.
 * All displayed positions and inputs come from the same completed fixed steps.
 * The generated teaching example is not human-pilot evidence or a new live autopilot.
 */
export function createTeachingDemonstration(
  settings: TuningSettings,
  kind: TeachingDemonstrationKind,
): TeachingDemonstration {
  if (!validateTuningSettings(settings).valid) throw new RangeError('示範設定未通過驗證，請先還原有效設定。')
  if (kind !== 'takeoff' && kind !== 'roll' && kind !== 'pitch' && kind !== 'yaw') {
    throw new RangeError('不支援此示範種類。')
  }
  const simulation = new FlightSimulation(flightSimulationConfigFromTuning(settings))
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  if (settings.drone.massKg * settings.drone.gravityMps2 / maximumThrust >= 0.8) {
    throw new RangeError('目前推力不足以完成穩定示範，請檢查機體設定。')
  }
  const spawn = settings.drone.spawnPositionM
  const takeoff = kind === 'takeoff'
  const start = takeoff ? spawn : { ...spawn, y: Math.max(spawn.y + 8, settings.drone.ground.heightM + 8) }
  simulation.resetAt(start)
  simulation.arm()
  const recorder = new FlightReplayRecorder({ capacity: MAXIMUM_RECORDED_SAMPLES, decimation: 4 })
  recorder.beginFlight()
  const duration = takeoff ? TAKEOFF_DURATION_SECONDS : AXIS_DURATION_SECONDS
  const axisStick = takeoff ? 0 : stickForRate(settings, kind)
  const targetAltitude = takeoff ? spawn.y + 2 : start.y
  const initialInput = demonstrationInput(simulation, 0, kind, start.y, axisStick)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  const steps = Math.round(duration / STEP_SECONDS)
  for (let index = 0; index < steps; index += 1) {
    const timeSeconds = index * STEP_SECONDS
    const desiredAltitude = takeoff && timeSeconds < 0.5 ? start.y : targetAltitude
    const input = demonstrationInput(simulation, timeSeconds, kind, desiredAltitude, axisStick)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError('目前設定無法完成穩定模擬示範，請採用有效的新手設定後重試。')
    }
    recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: step.telemetry.armed, telemetry: step.telemetry })
  }
  const recording = recorder.endFlight()
  const title = kind === 'takeoff' ? '油門與起飛示範'
    : kind === 'roll' ? '橫滾 Roll：推桿、回中與反向修正'
      : kind === 'pitch' ? '俯仰 Pitch：推桿、回中與反向修正'
        : '偏航 Yaw：推桿、回中與反向修正'
  return Object.freeze({
    title,
    description: '模擬示範，尚待真人飛手驗證。畫面、搖桿與字幕共用同一時間軸；示範不會計入通關。',
    source: 'simulated',
    recording,
    cues: cuesFor(kind),
  })
}

/** The UI passes the playback clock's relative position, including seek/slow motion. */
export function teachingCueAt(demonstration: TeachingDemonstration, timeSeconds: number): string {
  const time = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0
  let cue = demonstration.cues[0]?.text ?? demonstration.description
  for (const candidate of demonstration.cues) {
    if (candidate.timeSeconds > time) break
    cue = candidate.text
  }
  return cue
}
