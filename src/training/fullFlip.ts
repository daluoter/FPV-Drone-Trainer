import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const FULL_FLIP_TARGET_HEIGHT_M = 10
export const FULL_FLIP_MIN_PREPARATION_HEIGHT_M = 8
export const FULL_FLIP_MIN_HEIGHT_M = 1.5
export const FULL_FLIP_AREA_RADIUS_M = 80
export const FULL_FLIP_PREPARATION_SECONDS = 0.1
export const FULL_FLIP_HOLD_SECONDS = 0.2
export const FULL_FLIP_PREPARATION_TILT_DEGREES = 25
export const FULL_FLIP_RECOVERY_TILT_DEGREES = 30
export const FULL_FLIP_MAX_BODY_RATE_DEGREES = 120
export const FULL_FLIP_MAX_HORIZONTAL_SPEED_MPS = 8
export const FULL_FLIP_PREPARATION_VERTICAL_MPS = 3.5
export const FULL_FLIP_RECOVERY_DESCENT_MPS = 2.5
export const FULL_FLIP_RECOVERY_CLIMB_MPS = 4
export const FULL_FLIP_COMPLETION_DEGREES = 340
export const FULL_FLIP_MAX_COMPLETION_DEGREES = 380
export const FULL_FLIP_MAX_TURN_DEGREES = 405
export const FULL_FLIP_INVERTED_TILT_DEGREES = 150
export const FULL_FLIP_TIME_LIMIT_SECONDS = 300
export const FULL_FLIP_PHASE_IDS = Object.freeze([
  'flip-ground', 'flip-liftoff', 'flip-ready', 'flip-inverted', 'flip-upright', 'flip-recovered',
] as const)

const DEGREES = 180 / Math.PI

/** Direction is fixed by the selected lesson, never by saved progress or input. */
export function fullFlipRequiredDirection(lessonId: string): -1 | 0 | 1 {
  return lessonId === 'front-flip' ? 1 : lessonId === 'back-flip' ? -1 : 0
}

/** Direct measured-state instruments. Front flips are positive: body -X.
 * Pilot-positive pitch/body +X is nose-up, so back flips are negative here. */
export function measureFullFlipMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  return {
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    flipRateDegreesPerSecond: -state.angularVelocityBodyRadPerSec.x * DEGREES,
    verticalSpeedMps: state.velocityMps.y,
    horizontalSpeedMps: Math.hypot(state.velocityMps.x, state.velocityMps.z),
  }
}

/** Shortest observed body rotation, invariant to the equivalent q/-q representation. */
function observedRotation(before: DroneState, after: DroneState) {
  let delta = normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(normalizeQuaternion(before.orientation)), normalizeQuaternion(after.orientation)))
  if (delta.w < 0) delta = { x: -delta.x, y: -delta.y, z: -delta.z, w: -delta.w }
  const sine = Math.hypot(delta.x, delta.y, delta.z)
  const angle = 2 * Math.atan2(sine, Math.max(0, delta.w))
  const factor = sine > 1e-10 ? angle / sine : 2
  return { delta, vector: { x: delta.x * factor, y: delta.y * factor, z: delta.z * factor }, angleDegrees: angle * DEGREES }
}

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function emptyEpisode(): Record<string, number> {
  return {
    // Episode state: 0 preparing, 1 ready, 2 observed rotation, 3 complete turn.
    flipEpisodeState: 0, flipEpisodeValid: 0, flipInterrupted: 0,
    flipSignedDegrees: 0, flipMeasuredRateDegrees: 0, flipProgressDegrees: 0, flipDirection: 0,
    flipInverted: 0, flipCompleted: 0, flipOffAxisDegrees: 0,
    preparationQualifying: 0, preparationDwellSeconds: 0,
    recoveryQualifying: 0, recoveryDwellSeconds: 0,
    flipInterruptionReason: 0, interruptionAltitudeM: 0, interruptionFlipProgressDegrees: 0,
    interruptionLaunchDistanceM: 0, interruptionOffAxisDegrees: 0, interruptionFlipDirection: 0,
  }
}

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '本次翻轉練習已結束；按再練一次會清空本次步驟，從地面自行起飛後重試。' }
}

function exerciseHint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase >= 6) return '已完成一圈實際翻轉並恢復正飛與控制；不需降落，現在可以上鎖停止馬達。'
  if (phase === 0) return '請先在起飛區實際接地開始，不能從高空跳過自行起飛。'
  if (phase === 1) return '自行起飛至至少 8 m，建議約 10 m，為翻滾掉高保留餘裕。'
  if (metrics.insideFlipArea < 0.5) return '已離開起飛點周圍 80 m 練習區；本次翻轉證據已中斷，回區後重新準備並完成一整圈。'
  if (metrics.flipEpisodeValid < 0.5) {
    const required = metrics.flipRequiredDirection > 0 ? '前翻' : metrics.flipRequiredDirection < 0 ? '後翻' : null
    const wrongDirection = metrics.flipInterruptionReason === 8 && required
      ? `本課指定${required}；剛才向${metrics.interruptionFlipDirection < 0 ? '後' : '前'}翻轉，方向不符。本圈已中斷，先前步驟保留；請重新準備再完成${required}一圈。`
      : metrics.flipInterrupted > 0.5 ? '本次翻轉已中斷，先前步驟保留；需重新準備並完整翻一圈。' : ''
    return `${wrongDirection}先升至至少 8 m，帶回 25° 內、減緩旋轉與漂移，短暫準備 0.1 秒。`
  }
  if (metrics.flipCompleted > 0.5) return '已觀察到完整一圈；回中減緩旋轉，再修到 30° 內。保持至少 1.5 m 高度，減緩下降與漂移，確認 0.2 秒。'
  const direction = metrics.flipRequiredDirection < 0 || metrics.flipRequiredDirection === 0 && metrics.flipDirection < 0
    ? '後翻' : metrics.flipRequiredDirection > 0 || metrics.flipDirection > 0 ? '前翻' : '選擇前翻或後翻'
  return metrics.flipInverted > 0.5
    ? `已通過倒置；繼續${direction}完成同一圈，接近正飛時提早回中減緩旋轉。`
    : `準備完成；${direction}，沿同一俯仰方向完整翻一圈。可先適量加油爬升；倒置時適度收油，不以橫滾或偏航代替。`
}

function evaluateFullFlip(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('翻轉練習停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('翻轉練習停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('翻轉練習停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('翻轉練習缺少有效起飛點或地面參考，請重設訓練場。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('翻轉練習停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || (contact.touching && Math.abs(clearance) > 0.003)) return terminal('翻轉練習停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < FULL_FLIP_PHASE_IDS.length && context.checkpoints[FULL_FLIP_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureFullFlipMotion(sample.state)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const airborne = !contact.touching && clearance >= 0.15
  const inside = launchDistanceM <= FULL_FLIP_AREA_RADIUS_M
  const episode = emptyEpisode()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = {
    ...episode, ...motion, flipPhase: phase, altitudeM, groundClearanceM: clearance,
    launchDistanceM, groundTouching: contact.touching ? 1 : 0, insideFlipArea: inside ? 1 : 0,
    targetAltitudeM: FULL_FLIP_TARGET_HEIGHT_M, flipRequiredDirection: fullFlipRequiredDirection(context.lesson.id),
  }
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  let measuredFlipDegrees = 0
  let rotation: Vector3 = { x: 0, y: 0, z: 0 }
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('翻轉練習停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('翻轉練習停止：位置跳躍與實際速度不一致。', metrics)
    const observed = observedRotation(previous.state, sample.state)
    rotation = observed.vector
    const afterRateInBeforeBody = rotateVectorByQuaternion(observed.delta, sample.state.angularVelocityBodyRadPerSec)
    const beforeRate = previous.state.angularVelocityBodyRadPerSec
    measuredFlipDegrees = -(beforeRate.x + afterRateInBeforeBody.x) * 0.5 * delta * DEGREES
    metrics.angularConsistencyErrorDegrees = Math.hypot(
      rotation.x - (beforeRate.x + afterRateInBeforeBody.x) * 0.5 * delta,
      rotation.y - (beforeRate.y + afterRateInBeforeBody.y) * 0.5 * delta,
      rotation.z - (beforeRate.z + afterRateInBeforeBody.z) * 0.5 * delta,
    ) * DEGREES
    // Includes fixed-step acceleration/retention error, but rejects pose-only
    // jumps. Refuse an ambiguous >90° retained interval rather than unwrap it.
    metrics.angularToleranceDegrees = 2 + 400 * delta * delta
    if (observed.angleDegrees > 90 || metrics.angularConsistencyErrorDegrees > metrics.angularToleranceDegrees) return terminal('翻轉練習停止：姿態變化與實際旋轉速度不一致，無法確認完整翻轉。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > FULL_FLIP_TIME_LIMIT_SECONDS) return terminal('翻轉挑戰逾時：尚未完成完整翻轉與空中恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: exerciseHint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = FULL_FLIP_PHASE_IDS[phase]
    phase += 1
    metrics.flipPhase = phase
    return phase === 6
      ? { status: 'success', checkpointIds: [id], score: 100, metrics, message: '已從地面自行起飛，完成一圈實際翻轉並恢復正飛與控制。', hint: exerciseHint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: exerciseHint(phase, metrics) }
  }
  // Reasons: 1 ground, 2 low, 3 outside, 4 off-axis, 5 overrotation,
  // 6 reversing past the starting orientation, 7 lost pre-flip height,
  // 8 rotating opposite to this directional lesson's required turn.
  const interrupt = (reason: number): TrainingEvaluation => {
    const interruption = { flipInterrupted: 1, flipInterruptionReason: reason,
      interruptionAltitudeM: altitudeM, interruptionFlipProgressDegrees: metrics.flipProgressDegrees,
      interruptionLaunchDistanceM: launchDistanceM, interruptionOffAxisDegrees: metrics.flipOffAxisDegrees,
      interruptionFlipDirection: metrics.flipDirection }
    Object.assign(metrics, emptyEpisode(), interruption)
    return continuing()
  }
  if (phase >= 6) {
    if (metrics.flipRequiredDirection !== 0 && (metrics.flipDirection !== metrics.flipRequiredDirection
      || metrics.flipEpisodeValid < 0.5 || metrics.flipCompleted < 0.5 || metrics.flipInverted < 0.5)) {
      return terminal('翻轉練習停止：尚未取得本課指定方向的完整一圈與恢復證據，請重新開始。', metrics)
    }
    return { status: 'success', score: 100, metrics, message: '已完成完整翻轉與恢復。', hint: exerciseHint(phase, metrics) }
  }
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && inside && altitudeM >= FULL_FLIP_MIN_PREPARATION_HEIGHT_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < FULL_FLIP_MIN_HEIGHT_M) return interrupt(2)
  if (!inside) return interrupt(3)

  if (metrics.flipEpisodeState === 0) {
    const prepared = altitudeM >= FULL_FLIP_MIN_PREPARATION_HEIGHT_M && motion.tiltDegrees <= FULL_FLIP_PREPARATION_TILT_DEGREES
      && motion.bodyRateDegreesPerSecond <= FULL_FLIP_MAX_BODY_RATE_DEGREES && motion.horizontalSpeedMps <= FULL_FLIP_MAX_HORIZONTAL_SPEED_MPS
      && Math.abs(motion.verticalSpeedMps) <= FULL_FLIP_PREPARATION_VERTICAL_MPS
    metrics.preparationQualifying = prepared ? 1 : 0
    metrics.preparationDwellSeconds = prepared && metric(context, 'preparationQualifying') > 0.5
      ? Math.min(FULL_FLIP_PREPARATION_SECONDS, metric(context, 'preparationDwellSeconds') + delta) : 0
    if (metrics.preparationDwellSeconds + 1e-8 >= FULL_FLIP_PREPARATION_SECONDS) {
      metrics.flipEpisodeState = 1
      metrics.flipEpisodeValid = 1
      metrics.flipInterrupted = 0
      metrics.flipInterruptionReason = 0
      if (phase === 2) return advance()
    }
    return continuing()
  }
  // A prepared pilot may deliberately build upward energy before the flip;
  // speed preparation bounds do not silently revoke that readiness latch.
  if (metrics.flipEpisodeState === 1 && altitudeM < FULL_FLIP_MIN_PREPARATION_HEIGHT_M) return interrupt(7)
  metrics.flipSignedDegrees += -rotation.x * DEGREES
  metrics.flipMeasuredRateDegrees += measuredFlipDegrees
  metrics.flipRateConsistencyErrorDegrees = Math.abs(metrics.flipSignedDegrees - metrics.flipMeasuredRateDegrees)
  // A per-sample tolerance must not accumulate into invented rotation: many
  // small pose-only or rate-only changes still disagree over the whole episode.
  if (metrics.flipRateConsistencyErrorDegrees > 12) return terminal('翻轉練習停止：累積姿態變化與實際翻轉速度不一致。', metrics)
  metrics.flipOffAxisDegrees += Math.hypot(rotation.y, rotation.z) * DEGREES
  if (metrics.flipDirection === 0 && Math.abs(metrics.flipSignedDegrees) >= 10) metrics.flipDirection = Math.sign(metrics.flipSignedDegrees)
  const directed = metrics.flipSignedDegrees * (metrics.flipDirection || 1)
  metrics.flipProgressDegrees = Math.min(360, Math.abs(metrics.flipSignedDegrees))
  if (metrics.flipRequiredDirection !== 0 && metrics.flipDirection !== 0 && metrics.flipDirection !== metrics.flipRequiredDirection) return interrupt(8)
  if (Math.abs(metrics.flipSignedDegrees) > FULL_FLIP_MAX_TURN_DEGREES) return interrupt(5)
  if (metrics.flipOffAxisDegrees > 120) return interrupt(4)
  if (directed < -15) return interrupt(6)
  if (metrics.flipDirection !== 0 && metrics.flipEpisodeState === 1) metrics.flipEpisodeState = 2
  if (directed >= 120 && directed <= 240 && motion.tiltDegrees >= FULL_FLIP_INVERTED_TILT_DEGREES) metrics.flipInverted = 1
  if (phase === 3 && metrics.flipInverted > 0.5) return advance()
  if (metrics.flipInverted > 0.5 && directed >= FULL_FLIP_COMPLETION_DEGREES && directed <= FULL_FLIP_MAX_COMPLETION_DEGREES
    && motion.tiltDegrees <= FULL_FLIP_RECOVERY_TILT_DEGREES) {
    metrics.flipCompleted = 1
    metrics.flipEpisodeState = 3
  }
  if (phase === 4 && metrics.flipCompleted > 0.5) return advance()
  // Historical milestones alone cannot restore completion after an interruption.
  if (phase === 5 && metrics.flipCompleted > 0.5 && metrics.flipInverted > 0.5 && metrics.flipEpisodeValid > 0.5) {
    const recovered = directed >= FULL_FLIP_COMPLETION_DEGREES && directed <= FULL_FLIP_MAX_COMPLETION_DEGREES
      && motion.tiltDegrees <= FULL_FLIP_RECOVERY_TILT_DEGREES && motion.bodyRateDegreesPerSecond <= FULL_FLIP_MAX_BODY_RATE_DEGREES
      && motion.horizontalSpeedMps <= FULL_FLIP_MAX_HORIZONTAL_SPEED_MPS
      && motion.verticalSpeedMps >= -FULL_FLIP_RECOVERY_DESCENT_MPS && motion.verticalSpeedMps <= FULL_FLIP_RECOVERY_CLIMB_MPS
    metrics.recoveryQualifying = recovered ? 1 : 0
    metrics.recoveryDwellSeconds = recovered && metric(context, 'recoveryQualifying') > 0.5
      ? Math.min(FULL_FLIP_HOLD_SECONDS, metric(context, 'recoveryDwellSeconds') + delta) : 0
    if (metrics.recoveryDwellSeconds + 1e-8 >= FULL_FLIP_HOLD_SECONDS) return advance()
  } else {
    metrics.recoveryQualifying = 0
    metrics.recoveryDwellSeconds = 0
  }
  return continuing()
}

export const fullFlipEvaluator: LessonEvaluatorContract = { evaluate: evaluateFullFlip }

export const FULL_FLIP_LESSON: LessonDefinition = {
  id: 'full-flip', priority: 2.9, title: '前後翻轉', availability: 'available', available: true,
  description: '從地面自行起飛，取得高度餘裕後向前或向後翻一整圈，再恢復正飛與控制。',
  objectives: ['從地面自行起飛並為翻滾保留高度。', '實際通過倒置，沿同一方向完成一圈翻轉。', '回中減緩旋轉，再修回正飛並短暫恢復控制。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'flip-ground', title: '地面開始', description: '在起飛區實際接地開始。' },
    { id: 'flip-liftoff', title: '自行起飛至練習高度', description: '自行起飛至至少 8 m，建議約 10 m。' },
    { id: 'flip-ready', title: '翻轉前準備', description: '帶回接近水平、減緩旋轉與漂移，短暫準備 0.1 秒。' },
    { id: 'flip-inverted', title: '通過倒置姿態', description: '選前翻或後翻，沿同一圈實際通過倒置。' },
    { id: 'flip-upright', title: '完成一圈翻轉', description: '沿同一方向翻完 360° 附近並回到正飛，不以半圈後反向回平代替。' },
    { id: 'flip-recovered', title: '恢復正飛與控制', description: '留在空中，減緩旋轉、下降與漂移，短暫確認 0.2 秒。' },
  ],
  success: { title: '完整翻轉完成', description: '已觀察到完整翻轉與其後的空中恢復。', criteria: ['實際地面自行起飛', '觀察到同一圈的倒置與完整翻轉', '空中短暫恢復控制'] },
  failure: { title: '翻轉尚未完成', description: '一般動作中斷可重新準備；墜毀、解除解鎖或無效資料需要重試。', criteria: ['不能以偏航、橫滾或半圈回平代替', '接地停住不能代替空中恢復'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['flipProgressDegrees', 'tiltDegrees', 'verticalSpeedMps', 'recoveryDwellSeconds'] },
  hints: ['取得足夠高度，選前翻或後翻完整翻一圈；接近正飛時提早回中，再主動修回接近水平。'],
  evaluator: fullFlipEvaluator,
}

export const FULL_FLIP_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L11', title: '前後翻轉', level: '花飛入門', prerequisiteIds: ['full-roll'],
  objectives: ['理解倒置時的姿態與油門方向。', '自行完成一圈完整翻轉並恢復正飛與控制。'],
  steps: ['從地面自行起飛，至少 8 m、建議約 10 m，保留翻滾的掉高餘裕。', '帶回接近水平並稍微減緩旋轉與漂移，依提示短暫準備 0.1 秒。', '可先適量加油爬升，再選前翻或後翻，以俯仰軸持續轉動，沿同一方向完整翻一圈。', '倒置時適度收油，避免推力往地面壓；接近正飛時提早回中減緩旋轉，再修回接近水平。', '保持空中與至少 1.5 m 高度，稍微減緩下降與漂移，確認 0.2 秒後完成；不需降落或回原位置。'],
  commonMistakes: ['只翻半圈再反向回平；本課要完成同一方向的一整圈。', '用橫滾或偏航代替俯仰翻轉；本課需沿左右機臂方向的軸前翻或後翻。', '高度不足或倒置時持續大油門，讓機體很快掉高。', '已轉回正飛仍繼續推俯仰桿，沒提早回中停止旋轉。'],
}

function directionalFlipLesson(id: 'front-flip' | 'back-flip', title: '前翻' | '後翻', priority: number): LessonDefinition {
  return {
    ...FULL_FLIP_LESSON, id, title, priority,
    description: `從地面自行起飛，取得高度餘裕後完成一圈${title}，再恢復正飛與控制。`,
    objectives: ['從地面自行起飛並為翻轉保留高度。', `實際通過倒置，沿指定方向完成一圈${title}。`, '回中減緩旋轉，再修回正飛並短暫恢復控制。'],
    checkpoints: FULL_FLIP_LESSON.checkpoints.map((checkpoint, index) => index === 2
      ? { ...checkpoint, title: `${title}準備` }
      : index === 3 ? { ...checkpoint, description: `持續${title}，沿同一圈實際通過倒置；反方向翻轉不計入本課。` }
        : index === 4 ? { ...checkpoint, title: `完成一圈${title}`, description: `沿${title}方向翻完 360° 附近並回到正飛；不以反方向翻轉或半圈回平代替。` }
          : { ...checkpoint }),
    success: { ...FULL_FLIP_LESSON.success, title: `${title}完成`, description: `已觀察到完整${title}與其後的空中恢復。`, criteria: ['實際地面自行起飛', `觀察到同一圈的倒置與指定方向${title}`, '空中短暫恢復控制'] },
    hints: [`取得足夠高度，沿${title}方向完成一圈；接近正飛時提早回中，再主動修回接近水平。`],
  }
}

export const FRONT_FLIP_LESSON: LessonDefinition = directionalFlipLesson('front-flip', '前翻', 2.9)
export const BACK_FLIP_LESSON: LessonDefinition = directionalFlipLesson('back-flip', '後翻', 2.95)

function directionalFlipLearningContent(code: 'L11' | 'L12', title: '前翻' | '後翻', prerequisiteId: string): LessonLearningContent {
  return {
    ...FULL_FLIP_LEARNING_CONTENT, code, title, prerequisiteIds: [prerequisiteId],
    objectives: ['理解倒置時的姿態與油門方向。', `自行完成一圈${title}並恢復正飛與控制。`],
    steps: [
      '從地面自行起飛，至少 8 m、建議約 10 m，保留翻轉的掉高餘裕。',
      '帶回接近水平並稍微減緩旋轉與漂移，依提示短暫準備 0.1 秒。',
      `可先適量加油爬升，再以俯仰軸持續${title}，沿同一方向完整翻一圈；本課只判定${title}。`,
      '倒置時適度收油，避免推力往地面壓；接近正飛時提早回中減緩旋轉，再修回接近水平。',
      '保持空中與至少 1.5 m 高度，稍微減緩下降與漂移，確認 0.2 秒後完成；不需降落或回原位置。',
    ],
    commonMistakes: [`朝反方向翻轉；本課需完成${title}，不能以另一方向代替。`, ...FULL_FLIP_LEARNING_CONTENT.commonMistakes],
  }
}

export const FRONT_FLIP_LEARNING_CONTENT: LessonLearningContent = directionalFlipLearningContent('L11', '前翻', 'full-roll')
export const BACK_FLIP_LEARNING_CONTENT: LessonLearningContent = directionalFlipLearningContent('L12', '後翻', 'front-flip')
