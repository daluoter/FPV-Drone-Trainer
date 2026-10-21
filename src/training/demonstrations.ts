import { createInitialDroneState, droneGroundSupport, DRONE_GROUND_CLEARANCE_M } from '../drone'
import { FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { rotateVectorByQuaternion } from '../math/quaternion'
import { applyActualRates, applyConfiguredRateLimit, type RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { flightSimulationConfigFromTuning, validateTuningSettings, type TuningSettings } from '../tuning/config'
import { identifyTuningPreset, type TuningPresetSelection } from '../tuning/presets'
import { CURRENT_TRAINING_RULES_VERSION, fingerprintTrainingSettings } from './attempt'

export type TeachingDemonstrationKind = 'takeoff' | 'landing' | 'straight-line' | 'roll' | 'pitch' | 'yaw'

export interface TeachingCue {
  readonly timeSeconds: number
  readonly text: string
}

export interface TeachingDemonstration {
  readonly schemaVersion: 1
  readonly kind: TeachingDemonstrationKind
  readonly lessonId: 'intro' | 'takeoff' | 'landing' | 'straight-line'
  readonly rulesVersion: typeof CURRENT_TRAINING_RULES_VERSION
  readonly physicsVersion: 1
  readonly presetId: TuningPresetSelection
  readonly settingsFingerprint: string
  readonly title: string
  readonly description: string
  readonly source: 'simulated'
  readonly recording: ReplayRecording
  readonly cues: readonly TeachingCue[]
}

const STEP_SECONDS = 1 / 240
const TAKEOFF_DURATION_SECONDS = 10
const LANDING_DURATION_SECONDS = 14
const STRAIGHT_DURATION_SECONDS = 18
const AXIS_DURATION_SECONDS = 6.5
const AXIS_RATE_DEGREES_PER_SECOND = 15
const MAXIMUM_RECORDED_SAMPLES = 1_200

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Invert the configured rate curve, rather than assuming all presets need the same stick amount. */
function stickForRate(settings: TuningSettings, axis: RateAxis, desiredRate = AXIS_RATE_DEGREES_PER_SECOND): number {
  if (Math.abs(desiredRate) <= 1e-9) return 0
  const desiredMagnitude = Math.abs(desiredRate)
  const curve = settings.controller.rates.axes[axis]
  const limit = settings.controller.rateLimitsDegPerSec[axis]
  const rateAt = (stick: number): number => applyConfiguredRateLimit(applyActualRates(stick, curve), limit)
  if (rateAt(1) < desiredMagnitude) {
    throw new RangeError('目前角速度限制不足以產生示範，請先選擇新手或一般靈敏度。')
  }
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) * 0.5
    if (rateAt(middle) < desiredMagnitude) low = middle
    else high = middle
  }
  return (low + high) * 0.5 * Math.sign(desiredRate)
}

/** Feedforward and a conservative altitude correction only generate recorded input. */
function collectiveThrottle(
  simulation: FlightSimulation,
  altitudeM: number,
  maximumVerticalSpeed = 0.65,
): number {
  const state = simulation.getState()
  const config = simulation.droneConfig
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const maximumThrust = config.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  const targetVelocity = clamp((altitudeM - state.positionM.y) * 1.25, -maximumVerticalSpeed, maximumVerticalSpeed)
  const acceleration = clamp((targetVelocity - state.velocityMps.y) * 3, -2, 2)
  const thrust = (config.massKg * (config.gravityMps2 + acceleration)
    + config.linearDragCoefficientNPerMps.y * state.velocityMps.y) / Math.max(0.5, up.y)
  return clamp(thrust / maximumThrust, 0, 0.85)
}

/** A recorded input generator, not a control mode offered to the live player. */
function demonstrationInput(
  simulation: FlightSimulation,
  settings: TuningSettings,
  timeSeconds: number,
  kind: TeachingDemonstrationKind,
  altitudeM: number,
  axisStick: number,
): NormalizedRcInput {
  const throttle = collectiveThrottle(simulation, altitudeM, kind === 'landing' ? 0.42 : 0.65)
  if (kind === 'straight-line') {
    const state = simulation.getState()
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const targetZ = settings.drone.spawnPositionM.z - (timeSeconds < 0.6 ? 0 : 8)
    const targetVelocityZ = clamp((targetZ - state.positionM.z) * 0.65, -1.3, 1.3)
    const accelerationZ = clamp((targetVelocityZ - state.velocityMps.z) * 2.4, -1.5, 1.5)
    const targetPitch = Math.atan2(accelerationZ, settings.drone.gravityMps2)
    const pitch = Math.atan2(up.z, up.y)
    const targetRateDegrees = clamp((targetPitch - pitch) * 3.5, -0.6, 0.6) * 180 / Math.PI
    return { roll: 0, pitch: stickForRate(settings, 'pitch', targetRateDegrees), yaw: 0, throttle }
  }
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
  const freeze = (cues: TeachingCue[]): readonly TeachingCue[] => Object.freeze(cues.map((cue) => Object.freeze(cue)))
  if (kind === 'takeoff') return freeze([
    { timeSeconds: 0, text: '先確認機身水平，緩慢建立推力。這是模擬錄製，尚待真人飛手驗證。' },
    { timeSeconds: 0.5, text: '增加油門讓機體平穩上升，保持其他三軸接近中央。' },
    { timeSeconds: 2.5, text: '接近目標前減少上升速度；油門控制推力，不是直接設定高度。' },
    { timeSeconds: 5, text: '在目標高度附近小幅補油，觀察機體是否仍有升降速度。' },
    { timeSeconds: 8, text: '連續穩住後完成起飛練習；實際操作仍需自己持續修正。' },
  ])
  if (kind === 'landing') return freeze([
    { timeSeconds: 0, text: '從空中對準降落區，先保持水平並觀察下降速度。' },
    { timeSeconds: 0.6, text: '略減油門開始下降；提早調整，不要等碰地才急加油門。' },
    { timeSeconds: 5, text: '接近地面時降低下降速度，保持機身水平與落點穩定。' },
    { timeSeconds: 9, text: '平穩接地後保持低油門與水平，連續穩住，再解除解鎖。' },
  ])
  if (kind === 'straight-line') return freeze([
    { timeSeconds: 0, text: '先在起點穩住高度，確認前方路線與停點。' },
    { timeSeconds: 0.6, text: '小幅前傾開始前進，同時用油門維持高度。' },
    { timeSeconds: 6, text: '接近終點前反向小幅修正，先降低速度，避免衝過停點。' },
    { timeSeconds: 10, text: '回復水平並不會立即煞停；持續觀察速度與位置。' },
    { timeSeconds: 14, text: '在終點附近連續穩住，完成前進、減速與停點練習。' },
  ])
  const axisName = kind === 'roll' ? '橫滾 Roll' : kind === 'pitch' ? '俯仰 Pitch' : '偏航 Yaw'
  return freeze([
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
  if (!['takeoff', 'landing', 'straight-line', 'roll', 'pitch', 'yaw'].includes(kind)) {
    throw new RangeError('不支援此示範種類。')
  }
  const simulation = new FlightSimulation(flightSimulationConfigFromTuning(settings))
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  if (settings.drone.massKg * settings.drone.gravityMps2 / maximumThrust >= 0.8) {
    throw new RangeError('目前推力不足以完成穩定示範，請檢查機體設定。')
  }
  // The renderer's takeoff-pad anchor is the geometry-clamped initial COM,
  // including nonzero ground or a configured spawn below the support surface.
  const spawn = createInitialDroneState(settings.drone).positionM
  const takeoff = kind === 'takeoff'
  const landing = kind === 'landing'
  const straight = kind === 'straight-line'
  const start = takeoff ? spawn : landing || straight
    ? { ...spawn, y: spawn.y + 2.5 }
    : { ...spawn, y: Math.max(spawn.y + 8, settings.drone.ground.heightM + 8) }
  simulation.resetAt(start)
  simulation.arm()
  const recorder = new FlightReplayRecorder({ capacity: MAXIMUM_RECORDED_SAMPLES, decimation: 4 })
  recorder.beginFlight()
  const duration = takeoff ? TAKEOFF_DURATION_SECONDS : landing ? LANDING_DURATION_SECONDS
    : straight ? STRAIGHT_DURATION_SECONDS : AXIS_DURATION_SECONDS
  const axisStick = kind === 'roll' || kind === 'pitch' || kind === 'yaw' ? stickForRate(settings, kind) : 0
  const supportedAltitude = settings.drone.ground.heightM
    + droneGroundSupport(settings.drone, simulation.getState().orientation).supportOffsetM + DRONE_GROUND_CLEARANCE_M
  const targetAltitude = takeoff ? spawn.y + 2 : landing ? supportedAltitude - 0.025 : start.y
  const initialInput = demonstrationInput(simulation, settings, 0, kind, start.y, axisStick)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  const steps = Math.round(duration / STEP_SECONDS)
  for (let index = 0; index < steps; index += 1) {
    const timeSeconds = index * STEP_SECONDS
    const desiredAltitude = (takeoff || landing) && timeSeconds < 0.5 ? start.y : targetAltitude
    const input = demonstrationInput(simulation, settings, timeSeconds, kind, desiredAltitude, axisStick)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError('目前設定無法完成穩定模擬示範，請採用有效的新手設定後重試。')
    }
    recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: step.telemetry.armed, telemetry: step.telemetry })
  }
  const recording = recorder.endFlight()
  const title = kind === 'takeoff' ? '油門與起飛示範'
    : kind === 'landing' ? '定點降落：下降、減速與平穩接地'
      : kind === 'straight-line' ? '直線與減速停點：前進、煞停與穩住'
        : kind === 'roll' ? '橫滾 Roll：推桿、回中與反向修正'
      : kind === 'pitch' ? '俯仰 Pitch：推桿、回中與反向修正'
        : '偏航 Yaw：推桿、回中與反向修正'
  return Object.freeze({
    schemaVersion: 1,
    kind,
    lessonId: takeoff ? 'takeoff' : landing ? 'landing' : straight ? 'straight-line' : 'intro',
    rulesVersion: CURRENT_TRAINING_RULES_VERSION,
    physicsVersion: 1,
    presetId: identifyTuningPreset(settings),
    settingsFingerprint: fingerprintTrainingSettings(settings),
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
