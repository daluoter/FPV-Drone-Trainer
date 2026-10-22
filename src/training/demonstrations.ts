import { droneGroundSupport, DRONE_GROUND_CLEARANCE_M } from '../drone'
import { FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { rotateVectorByQuaternion } from '../math/quaternion'
import { applyActualRates, applyConfiguredRateLimit, type RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import { flightSimulationConfigFromTuning, validateTuningSettings, type TuningSettings } from '../tuning/config'
import { identifyTuningPreset, type TuningPresetSelection } from '../tuning/presets'
import { CURRENT_TRAINING_RULES_VERSION, fingerprintTrainingSettings } from './attempt'
import { createTrainingFieldAnchors, LANDING_TARGET_DISTANCE_M } from './field'
import { recordDirectionDemonstration } from './directionDemonstration'

export type TeachingDemonstrationKind = 'takeoff' | 'landing' | 'straight-line' | 'direction-control' | 'roll' | 'pitch' | 'yaw'

export interface TeachingCue {
  readonly timeSeconds: number
  readonly text: string
  readonly targetReferenceId?: string
}

export interface TeachingDemonstration {
  readonly schemaVersion: 1
  readonly kind: TeachingDemonstrationKind
  readonly lessonId: 'intro' | 'takeoff' | 'landing' | 'straight-line' | 'direction-control'
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
const LANDING_DURATION_SECONDS = 32
const STRAIGHT_DURATION_SECONDS = 27
const AXIS_DURATION_SECONDS = 6.5
const AXIS_RATE_DEGREES_PER_SECOND = 15
const MAXIMUM_RECORDED_SAMPLES = 2_100
const ROUTE_FORWARD_START_SECONDS = 7.5
const LANDING_DESCENT_START_SECONDS = 20

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
  const descending = kind === 'landing' && timeSeconds >= LANDING_DESCENT_START_SECONDS
  const throttle = collectiveThrottle(simulation, altitudeM, descending ? 0.42 : 0.65)
  if (kind === 'straight-line' || kind === 'landing') {
    const state = simulation.getState()
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    // Continue beyond the last vertical ring so the example actually crosses
    // its plane, rather than approaching the old stop point asymptotically.
    const routeDistance = LANDING_TARGET_DISTANCE_M + (kind === 'straight-line' ? 1 : 0)
    const targetZ = settings.drone.spawnPositionM.z - (timeSeconds < ROUTE_FORWARD_START_SECONDS ? 0 : routeDistance)
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
    { timeSeconds: 0, text: '從地面起飛區開始，緩慢增加油門起飛；降落區在前方八公尺的藍色標記。' },
    { timeSeconds: 3, text: '先在起點上方取得高度，穩住後再向前飛，不會從空中突然開始。' },
    { timeSeconds: ROUTE_FORWARD_START_SECONDS, text: '小幅前傾飛向藍色降落區，保持高度，提早降低前進速度。' },
    { timeSeconds: LANDING_DESCENT_START_SECONDS, text: '對準藍色降落區、先減少側移，再緩慢下降；接地前提早減少下降速度。' },
    { timeSeconds: 29, text: '在藍色區內接地、沒有墜毀就完成；看到完成結果後，再解除解鎖。' },
  ])
  if (kind === 'straight-line') return freeze([
    { timeSeconds: 0, text: '從地面起飛區開始，先自己建立推力，逐步爬升到起點目標高度。' },
    { timeSeconds: 5, text: '升到起點高度附近，確認前方藍、金、綠三個圈，再開始前進。' },
    { timeSeconds: ROUTE_FORWARD_START_SECONDS, text: '小幅前傾開始前進，同時用油門維持高度；通過中途圈只是其中一步。' },
    { timeSeconds: 13.5, text: '依序從藍色、金色圈內飛過；這一版先練穿圈，不要求減速比例。' },
    { timeSeconds: 18, text: '繼續對準綠色終點圈，從圈內飛過；沒有停穩也能完成。' },
    { timeSeconds: 22, text: '依序穿過藍、金、綠三圈就完成；漏圈可以回到該圈前方重新穿過。' },
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
  if (!['takeoff', 'landing', 'straight-line', 'direction-control', 'roll', 'pitch', 'yaw'].includes(kind)) {
    throw new RangeError('不支援此示範種類。')
  }
  const simulation = new FlightSimulation(flightSimulationConfigFromTuning(settings))
  const maximumThrust = settings.drone.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)
  if (settings.drone.massKg * settings.drone.gravityMps2 / maximumThrust >= 0.8) {
    throw new RangeError('目前推力不足以完成穩定示範，請檢查機體設定。')
  }
  if (kind === 'direction-control') {
    const { recording, cues } = recordDirectionDemonstration(simulation, settings, stickForRate, collectiveThrottle)
    return Object.freeze({
      schemaVersion: 1, kind, lessonId: 'direction-control',
      rulesVersion: CURRENT_TRAINING_RULES_VERSION, physicsVersion: 1,
      presetId: identifyTuningPreset(settings), settingsFingerprint: fingerprintTrainingSettings(settings),
      title: 'L05 側移與方向感：左右、前後、換向後再移動',
      description: '模擬示範，尚待真人飛手驗證。畫面、搖桿、字幕與目標共用同一時間軸；示範不會計入通關。',
      source: 'simulated', recording, cues,
    })
  }
  // The renderer's takeoff-pad anchor is the geometry-clamped initial COM,
  // including nonzero ground or a configured spawn below the support surface.
  const { pad: spawn, launch: groundedSpawn, routeAltitudeM: routeAltitude } = createTrainingFieldAnchors(settings.drone)
  const takeoff = kind === 'takeoff'
  const landing = kind === 'landing'
  const straight = kind === 'straight-line'
  const start = takeoff ? spawn : landing || straight
    ? groundedSpawn
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
  const targetAltitude = takeoff ? spawn.y + 2 : landing || straight ? routeAltitude : start.y
  const initialInput = demonstrationInput(simulation, settings, 0, kind, start.y, axisStick)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  const steps = Math.round(duration / STEP_SECONDS)
  for (let index = 0; index < steps; index += 1) {
    const timeSeconds = index * STEP_SECONDS
    const desiredAltitude = (takeoff || landing || straight) && timeSeconds < 0.5 ? start.y
      : landing && timeSeconds >= LANDING_DESCENT_START_SECONDS ? supportedAltitude - 0.025 : targetAltitude
    const input = demonstrationInput(simulation, settings, timeSeconds, kind, desiredAltitude, axisStick)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError('目前設定無法完成穩定模擬示範，請採用有效的新手設定後重試。')
    }
    recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: step.telemetry.armed, telemetry: step.telemetry })
  }
  const recording = recorder.endFlight()
  const title = kind === 'takeoff' ? '油門與起飛示範'
    : kind === 'landing' ? '起飛到降落：前往藍色降落區、減速與平穩接地'
    : kind === 'straight-line' ? '直線穿圈：依序飛過藍、金、綠三圈'
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

// Native range values can round a retained frame's timestamp by a few ULPs.
const TEACHING_CLOCK_TOLERANCE_SECONDS = 1e-9

/** The UI passes the playback clock's relative position, including seek/slow motion. */
export function teachingCueAt(demonstration: TeachingDemonstration, timeSeconds: number): string {
  const time = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0
  let cue = demonstration.cues[0]?.text ?? demonstration.description
  for (const candidate of demonstration.cues) {
    if (candidate.timeSeconds > time + TEACHING_CLOCK_TOLERANCE_SECONDS) break
    cue = candidate.text
  }
  return cue
}

/** Scene target reads the same playback time as captions, including paused seek. */
export function teachingTargetAt(demonstration: TeachingDemonstration, timeSeconds: number): string | null {
  const time = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0
  let target: string | null = null
  for (const cue of demonstration.cues) {
    if (cue.timeSeconds > time + TEACHING_CLOCK_TOLERANCE_SECONDS) break
    if (cue.targetReferenceId !== undefined) target = cue.targetReferenceId
  }
  return target
}
