import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const ORBIT_TARGET_HEIGHT_M = 10
export const ORBIT_TARGET_RADIUS_M = 15
export const ORBIT_MIN_RADIUS_M = 6
export const ORBIT_MAX_RADIUS_M = 30
export const ORBIT_MIN_ENTRY_HEIGHT_M = 4
export const ORBIT_MAX_ENTRY_HEIGHT_M = 20
export const ORBIT_MIN_HEIGHT_M = 1.5
export const ORBIT_AREA_RADIUS_M = 150
export const ORBIT_MIN_TANGENTIAL_SPEED_MPS = 0.75
export const ORBIT_MAX_HEADING_ERROR_DEGREES = 80
export const ORBIT_REQUIRED_LAPS = 5
export const ORBIT_COMPLETION_DEGREES = ORBIT_REQUIRED_LAPS * 360
export const ORBIT_EXIT_DISTANCE_M = 3
export const ORBIT_EXIT_MIN_SPEED_MPS = 0.5
export const ORBIT_HOLD_SECONDS = 0.2
export const ORBIT_TIME_LIMIT_SECONDS = 300
export const ORBIT_PHASE_IDS = Object.freeze([
  'orbit-ground', 'orbit-liftoff', 'orbit-entry', 'orbit-lap-1', 'orbit-lap-2', 'orbit-lap-3', 'orbit-lap-4', 'orbit-lap-5', 'orbit-recovered',
] as const)
const DEGREES = 180 / Math.PI

/** The teaching target is separate from the retained legacy orbit-poi anchor. */
export function createOrbitTarget(launchPositionM: Vector3, groundHeightM: number): Vector3 {
  return { x: launchPositionM.x, y: groundHeightM + ORBIT_TARGET_HEIGHT_M, z: launchPositionM.z - 30 }
}

export function measureOrbitMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  return {
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    horizontalSpeedMps: Math.hypot(state.velocityMps.x, state.velocityMps.z),
    verticalSpeedMps: state.velocityMps.y,
  }
}

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function episodeDefaults(): Record<string, number> {
  return {
    orbitEpisodeValid: 0, orbitInterrupted: 0, orbitInterruptionReason: 0,
    orbitDirection: 0, orbitSignedDegrees: 0, orbitProgressDegrees: 0, orbitMaxProgressDegrees: 0,
    orbitCompleted: 0, orbitCompletedLaps: 0, orbitCurrentLap: 1, orbitInvalidSeconds: 0, orbitAngleObserved: 0, orbitLastAngleRad: 0,
    orbitPreparationQualifying: 0, orbitPreparationDwellSeconds: 0,
    orbitRecoveryQualifying: 0, orbitRecoveryDwellSeconds: 0, orbitExitQualifying: 0, orbitLapAngularSpeedRadPerSec: 0,
    orbitCompletionRadiusM: 0, orbitExitDistanceM: 0,
    interruptionAltitudeM: 0, interruptionOrbitProgressDegrees: 0, interruptionOrbitRadiusM: 0,
    interruptionOrbitHeadingErrorDegrees: 0, interruptionOrbitTangentialSpeedMps: 0, interruptionLaunchDistanceM: 0, interruptionTiltDegrees: 0, interruptionOrbitCompletedLaps: 0,
  }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按再練一次，從地面自行起飛後重試本次正刷鍋。' }
}
function hint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase === 0) return '在起飛區實際接地、低油門明確解鎖後開始。'
  if (phase === 1) return '自行起飛至約 10 m，再朝前方參考塔接近；至少 4 m 才能準備繞行。'
  if (metrics.orbitEpisodeValid < 0.5) return `${metrics.orbitInterrupted > 0.5 ? '本次連續繞行已中斷並清空角度；先前步驟保留，但需要重新連續完成五圈。' : ''}到塔旁約 15 m，機頭大致朝塔，用側向移動建立一個繞行方向；不用精準定距。`
  if (metrics.orbitCompleted < 0.5) return `保持同一方向真正繞塔移動，目前完成 ${metrics.orbitCompletedLaps}／5 圈、累積約 ${Math.floor(metrics.orbitProgressDegrees)}°。用偏航讓機頭朝塔，配合橫滾及油門維持半徑與高度；原地轉機頭不算。`
  if (phase < 9) return '五個完整圈已完成；朝塔外平穩離開至少 3 m，保持向外速度至少 0.5 m/s，修平姿態並減緩升降，確認 0.2 秒。原地停住不算離開。'
  return '已完成同方向五個完整繞塔圈與空中恢復；不需要降落或回到原點。'
}

function evaluateOrbit(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('正刷鍋停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('正刷鍋停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('正刷鍋停止：已上鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('正刷鍋缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('正刷鍋停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('正刷鍋停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < ORBIT_PHASE_IDS.length && context.checkpoints[ORBIT_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureOrbitMotion(sample.state)
  const target = createOrbitTarget(launch.positionM, surface.positionM.y)
  const x = position.x - target.x
  const z = position.z - target.z
  const radius = Math.hypot(x, z)
  const angle = Math.atan2(z, x)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const airborne = !contact.touching && clearance >= 0.15
  const radialSpeed = radius > 1e-6 ? (x * sample.state.velocityMps.x + z * sample.state.velocityMps.z) / radius : 0
  const tangentSpeed = radius > 1e-6 ? (x * sample.state.velocityMps.z - z * sample.state.velocityMps.x) / radius : 0
  const forward = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 0, z: -1 })
  const forwardNorm = Math.hypot(forward.x, forward.z)
  const headingError = radius > 1e-6 && forwardNorm > 0.1
    ? Math.acos(Math.max(-1, Math.min(1, (-x * forward.x - z * forward.z) / radius / forwardNorm))) * DEGREES : 180
  const episode = episodeDefaults()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = { ...episode, ...motion, orbitPhase: phase, altitudeM, groundClearanceM: clearance,
    launchDistanceM, groundTouching: contact.touching ? 1 : 0, targetAltitudeM: ORBIT_TARGET_HEIGHT_M,
    orbitRadiusM: radius, orbitHeadingErrorDegrees: headingError, orbitTangentialSpeedMps: Math.abs(tangentSpeed),
    orbitRadialSpeedMps: radialSpeed, orbitAngularSpeedRadPerSec: radius > 1e-6 ? Math.abs(tangentSpeed / radius) : 0 }
  metrics.orbitExitDistanceM = metrics.orbitCompleted > 0.5 ? Math.max(0, radius - metrics.orbitCompletionRadiusM) : 0
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  if (!previous && metrics.orbitEpisodeValid > 0.5) return terminal('正刷鍋停止：繞行資料中斷，缺少連續的飛行觀察。', metrics)
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('正刷鍋停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('正刷鍋停止：位置跳躍與實際速度不一致。', metrics)
    let rotation = normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(normalizeQuaternion(previous.state.orientation)), normalizeQuaternion(sample.state.orientation)))
    if (rotation.w < 0) rotation = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: -rotation.w }
    const sine = Math.hypot(rotation.x, rotation.y, rotation.z)
    const turn = 2 * Math.atan2(sine, Math.max(0, rotation.w))
    const factor = sine > 1e-10 ? turn / sine : 2
    const rateAfter = rotateVectorByQuaternion(rotation, sample.state.angularVelocityBodyRadPerSec)
    const beforeRate = previous.state.angularVelocityBodyRadPerSec
    metrics.angularConsistencyErrorDegrees = Math.hypot(
      rotation.x * factor - (beforeRate.x + rateAfter.x) * 0.5 * delta,
      rotation.y * factor - (beforeRate.y + rateAfter.y) * 0.5 * delta,
      rotation.z * factor - (beforeRate.z + rateAfter.z) * 0.5 * delta,
    ) * DEGREES
    if (turn * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > 2 + 400 * delta * delta) return terminal('正刷鍋停止：姿態變化與實際旋轉速度不一致。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > ORBIT_TIME_LIMIT_SECONDS) return terminal('正刷鍋挑戰逾時：尚未完成繞塔與空中恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: hint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = ORBIT_PHASE_IDS[phase]
    phase += 1
    metrics.orbitPhase = phase
    return phase >= 9 ? { status: 'success', checkpointIds: [id], score: 100, metrics,
      message: '已從地面自行起飛，完成同方向五圈正刷鍋並恢復空中控制。', hint: hint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: hint(phase, metrics) }
  }
  // Reasons: 1 ground, 2 too low, 3 outside area, 4 radius, 5 altitude,
  // 6 nose away from target, 7 no lateral progress, 8 backtracking, 9 excessive tilt.
  const interrupt = (reason: number): TrainingEvaluation => {
    // Keep the first failure's facts while the pilot is still recovering.
    // Only a fresh valid preparation may open another episode/snapshot.
    if (metrics.orbitEpisodeValid < 0.5 && metrics.orbitInterrupted > 0.5) return continuing()
    const snapshot = { orbitInterrupted: 1, orbitInterruptionReason: reason, interruptionAltitudeM: altitudeM,
      interruptionOrbitProgressDegrees: metrics.orbitProgressDegrees, interruptionOrbitRadiusM: radius,
      interruptionOrbitHeadingErrorDegrees: headingError, interruptionOrbitTangentialSpeedMps: Math.abs(tangentSpeed),
      interruptionLaunchDistanceM: launchDistanceM, interruptionTiltDegrees: motion.tiltDegrees, interruptionOrbitCompletedLaps: metrics.orbitCompletedLaps }
    Object.assign(metrics, episodeDefaults(), snapshot)
    return continuing()
  }
  if (phase >= 9) return metrics.orbitEpisodeValid > 0.5 && metrics.orbitCompleted > 0.5 && metrics.orbitProgressDegrees + 1e-8 >= ORBIT_COMPLETION_DEGREES
    && metrics.orbitCompletedLaps >= ORBIT_REQUIRED_LAPS
    && metrics.orbitCompletionRadiusM >= ORBIT_MIN_RADIUS_M && metrics.orbitCompletionRadiusM <= ORBIT_MAX_RADIUS_M
    && metrics.orbitExitDistanceM + 1e-8 >= ORBIT_EXIT_DISTANCE_M
    && metrics.orbitExitQualifying > 0.5 && metrics.orbitRecoveryQualifying > 0.5 && metrics.orbitRecoveryDwellSeconds + 1e-8 >= ORBIT_HOLD_SECONDS
    ? { status: 'success', score: 100, metrics, message: '已完成五圈正刷鍋與空中恢復。', hint: hint(phase, metrics) }
    : terminal('正刷鍋停止：缺少同一段連續五圈及恢復的實際飛行證據，請重新開始。', metrics)
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && launchDistanceM <= ORBIT_AREA_RADIUS_M && altitudeM >= ORBIT_MIN_ENTRY_HEIGHT_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < ORBIT_MIN_HEIGHT_M) return interrupt(2)
  if (launchDistanceM > ORBIT_AREA_RADIUS_M) return interrupt(3)
  const envelopeReason = radius < ORBIT_MIN_RADIUS_M || radius > ORBIT_MAX_RADIUS_M ? 4
    : altitudeM < ORBIT_MIN_ENTRY_HEIGHT_M || altitudeM > ORBIT_MAX_ENTRY_HEIGHT_M ? 5
      : headingError > ORBIT_MAX_HEADING_ERROR_DEGREES ? 6
        : Math.abs(tangentSpeed) < ORBIT_MIN_TANGENTIAL_SPEED_MPS ? 7 : motion.tiltDegrees > 80 ? 9 : 0
  metrics.orbitEnvelopeValid = envelopeReason === 0 ? 1 : 0
  if (metrics.orbitEpisodeValid < 0.5) {
    const prepared = envelopeReason === 0
    metrics.orbitPreparationQualifying = prepared ? 1 : 0
    metrics.orbitPreparationDwellSeconds = prepared && metric(context, 'orbitPreparationQualifying') > 0.5
      ? Math.min(0.1, metric(context, 'orbitPreparationDwellSeconds') + delta) : 0
    if (metrics.orbitPreparationDwellSeconds + 1e-8 >= 0.1) {
      Object.assign(metrics, { orbitEpisodeValid: 1, orbitInterrupted: 0, orbitInterruptionReason: 0,
        orbitDirection: Math.sign(tangentSpeed), orbitAngleObserved: 1, orbitLastAngleRad: angle })
      if (phase === 2) return advance()
    }
    return continuing()
  }
  if (metrics.orbitCompleted < 0.5) {
    let angleDelta = angle - metrics.orbitLastAngleRad
    while (angleDelta > Math.PI) angleDelta -= Math.PI * 2
    while (angleDelta < -Math.PI) angleDelta += Math.PI * 2
    const directedDelta = metrics.orbitDirection * angleDelta * DEGREES
    // Invalid intervals never earn positive credit. Real reverse movement still
    // subtracts: returning through a brief invalid gap cannot pump the same arc.
    metrics.orbitSignedDegrees += envelopeReason === 0 && metrics.orbitAngleObserved > 0.5
      ? directedDelta : Math.min(0, directedDelta)
    metrics.orbitProgressDegrees = Math.max(0, metrics.orbitSignedDegrees)
    metrics.orbitCompletedLaps = Math.min(ORBIT_REQUIRED_LAPS, Math.floor((metrics.orbitProgressDegrees + 1e-8) / 360))
    metrics.orbitCurrentLap = Math.min(ORBIT_REQUIRED_LAPS, metrics.orbitCompletedLaps + 1)
    metrics.orbitMaxProgressDegrees = Math.max(metrics.orbitMaxProgressDegrees, metrics.orbitProgressDegrees)
    metrics.orbitLastAngleRad = angle
    metrics.orbitAngleObserved = envelopeReason === 0 ? 1 : 0
    if (metrics.orbitMaxProgressDegrees - metrics.orbitSignedDegrees > 45) return interrupt(8)
    if (envelopeReason !== 0) {
      metrics.orbitInvalidSeconds += delta
      if (metrics.orbitInvalidSeconds + 1e-8 >= 0.75) return interrupt(envelopeReason)
      return continuing()
    }
    metrics.orbitInvalidSeconds = 0
    if (metrics.orbitProgressDegrees + 1e-8 >= ORBIT_COMPLETION_DEGREES) {
      metrics.orbitCompleted = 1
      metrics.orbitLapAngularSpeedRadPerSec = Math.abs(tangentSpeed / radius)
      metrics.orbitCompletionRadiusM = radius
      metrics.orbitExitDistanceM = 0
    }
  }
  // Milestones can survive a local retry; only current episode evidence can
  // satisfy later milestones or recovery. Never reuse old orbit-lap-N flags.
  if (phase >= 3 && phase <= 7 && metrics.orbitProgressDegrees + 1e-8 >= (phase - 2) * 360) return advance()
  if (phase === 8 && metrics.orbitEpisodeValid > 0.5 && metrics.orbitCompleted > 0.5) {
    const exiting = metrics.orbitExitDistanceM + 1e-8 >= ORBIT_EXIT_DISTANCE_M && radialSpeed >= ORBIT_EXIT_MIN_SPEED_MPS
    metrics.orbitExitQualifying = exiting ? 1 : 0
    const recovered = exiting && motion.tiltDegrees <= 35 && motion.bodyRateDegreesPerSecond <= 140
      && motion.horizontalSpeedMps <= 15 && motion.verticalSpeedMps >= -4 && motion.verticalSpeedMps <= 5
    metrics.orbitRecoveryQualifying = recovered ? 1 : 0
    metrics.orbitRecoveryDwellSeconds = recovered && metric(context, 'orbitRecoveryQualifying') > 0.5
      ? Math.min(ORBIT_HOLD_SECONDS, metric(context, 'orbitRecoveryDwellSeconds') + delta) : 0
    if (metrics.orbitRecoveryDwellSeconds + 1e-8 >= ORBIT_HOLD_SECONDS) return advance()
  } else {
    metrics.orbitRecoveryQualifying = 0
    metrics.orbitRecoveryDwellSeconds = 0
  }
  return continuing()
}

export const orbitLearningEvaluator: LessonEvaluatorContract = { evaluate: evaluateOrbit }
export const ORBIT_LESSON: LessonDefinition = {
  id: 'orbit', priority: 4, title: '正刷鍋', availability: 'available', available: true,
  description: '從地面自行起飛，以機頭朝向參考塔的側向飛行，沿同一方向連續完成五個完整圈，再朝塔外平穩離開。',
  objectives: ['自行起飛並找到參考塔與寬闊繞行區。', '協調橫滾、偏航與油門，機頭大致朝塔並真正繞行。', '連續完成同方向五圈後朝塔外離開並恢復控制。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', 'orbit-zone'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'orbit-ground', title: '地面開始', description: '在起飛區實際接地，明確解鎖。' },
    { id: 'orbit-liftoff', title: '自行起飛至練習高度', description: '至少 4 m，建議約 10 m，再接近前方參考塔。' },
    { id: 'orbit-entry', title: '朝塔建立側向繞行', description: '距塔約 15 m，機頭朝塔，沿左右任一方向開始移動。' },
    { id: 'orbit-lap-1', title: '完成第一圈', description: '同方向實際繞行完整 360°，機頭大致朝塔。' },
    { id: 'orbit-lap-2', title: '連續完成第二圈', description: '同一段繞行累積至少 720°，保持半徑、高度與機頭關係。' },
    { id: 'orbit-lap-3', title: '連續完成第三圈', description: '同一段繞行累積至少 1080°，避免中途反向或停住。' },
    { id: 'orbit-lap-4', title: '連續完成第四圈', description: '同一段繞行累積至少 1440°，持續側向移動。' },
    { id: 'orbit-lap-5', title: '連續完成第五圈', description: '同一段繞行累積至少 1800°，每圈都是完整 360°。' },
    { id: 'orbit-recovered', title: '朝塔外離開並恢復控制', description: '向塔外離開至少 3 m、向外速度至少 0.5 m/s，修平姿態並減緩升降，確認 0.2 秒。' },
  ],
  success: { title: '正刷鍋完成', description: '已觀察到同方向連續五個完整圈與向外平穩離開。', criteria: ['地面自行起飛', '真正繞塔五圈並大致朝塔', '朝塔外離開至少 3 m 並恢復控制'] },
  failure: { title: '正刷鍋尚未完成', description: '一般偏離可在空中重新準備；墜毀、上鎖或無效資料需要重試。', criteria: ['原地偏航不算繞塔', '來回刷小段不能累積圈數', '不能把中斷前後的圈數拼成連續五圈'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['orbitCompletedLaps', 'orbitProgressDegrees', 'orbitRadiusM', 'orbitHeadingErrorDegrees', 'orbitRecoveryDwellSeconds'] },
  hints: ['先升至約 10 m，對照參考塔與寬闊環帶。機頭大致朝塔，用側移與偏航連續完成五個 360° 圈；不用完美圓形、精準回原點或降落。'],
  evaluator: orbitLearningEvaluator,
}
export const ORBIT_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L15', title: '正刷鍋', level: '花飛進階', prerequisiteIds: ['direction-control', 'coordinated-turn', 'figure-eight'],
  objectives: ['分辨真正繞行與原地偏航。', '用機頭朝塔的側向飛行協調方向、半徑、高度與出場。'],
  steps: ['從地面自行起飛至約 10 m，找到前方參考塔；至少 4 m 才開始繞行。', '到塔旁約 15 m，機頭朝塔，選左或右側移並配合偏航。', '每圈完整繞行 360°，連續完成同方向五圈；觀察塔在畫面中的位置，搭配橫滾與油門修正半徑及高度。', '持續同方向累積至少 1800°，不用貼著環帶或飛出完美圓形；中斷後須重新連續繞五圈。', '完成五圈後朝塔外離開至少 3 m，向外速度至少 0.5 m/s，修平姿態、減緩旋轉與升降，保持 0.2 秒；原地停住不算離開。'],
  commonMistakes: ['原地轉機頭，沒有真正沿塔周圍移動。', '像一般前飛轉彎，只讓機頭朝切線而沒有朝塔。', '左右反覆刷同一小段弧線，把局部動作當成完整一圈。', '只顧偏航，忘記用橫滾與油門控制半徑與高度。'],
}
