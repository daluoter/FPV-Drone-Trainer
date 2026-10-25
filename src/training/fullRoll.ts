import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const FULL_ROLL_TARGET_HEIGHT_M = 10
export const FULL_ROLL_MIN_PREPARATION_HEIGHT_M = 8
export const FULL_ROLL_MIN_HEIGHT_M = 1.5
export const FULL_ROLL_AREA_RADIUS_M = 60
export const FULL_ROLL_PREPARATION_SECONDS = 0.1
export const FULL_ROLL_HOLD_SECONDS = 0.25
export const FULL_ROLL_PREPARATION_TILT_DEGREES = 20
export const FULL_ROLL_RECOVERY_TILT_DEGREES = 25
export const FULL_ROLL_MAX_BODY_RATE_DEGREES = 90
export const FULL_ROLL_MAX_HORIZONTAL_SPEED_MPS = 5
export const FULL_ROLL_PREPARATION_VERTICAL_MPS = 3.5
export const FULL_ROLL_RECOVERY_DESCENT_MPS = 1.5
export const FULL_ROLL_RECOVERY_CLIMB_MPS = 3
export const FULL_ROLL_COMPLETION_DEGREES = 340
export const FULL_ROLL_MAX_COMPLETION_DEGREES = 380
export const FULL_ROLL_MAX_TURN_DEGREES = 405
export const FULL_ROLL_INVERTED_TILT_DEGREES = 150
export const FULL_ROLL_TIME_LIMIT_SECONDS = 300
export const FULL_ROLL_PHASE_IDS = Object.freeze([
  'roll-ground', 'roll-liftoff', 'roll-ready', 'roll-inverted', 'roll-upright', 'roll-recovered',
] as const)

const DEGREES = 180 / Math.PI

/** Direct instruments from actual state, independent of controls and evaluator history. */
export function measureFullRollMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  return {
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    rollRateDegreesPerSecond: -state.angularVelocityBodyRadPerSec.z * DEGREES,
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
    rollEpisodeState: 0, rollEpisodeValid: 0, rollInterrupted: 0,
    rollSignedDegrees: 0, rollMeasuredRateDegrees: 0, rollProgressDegrees: 0, rollDirection: 0,
    rollInverted: 0, rollCompleted: 0, rollOffAxisDegrees: 0,
    preparationQualifying: 0, preparationDwellSeconds: 0,
    recoveryQualifying: 0, recoveryDwellSeconds: 0,
    rollInterruptionReason: 0, interruptionAltitudeM: 0, interruptionRollProgressDegrees: 0,
    interruptionLaunchDistanceM: 0, interruptionOffAxisDegrees: 0,
  }
}

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '本次橫滾練習已結束；按再練一次會清空本次步驟，從地面自行起飛後重試。' }
}

function exerciseHint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase >= 6) return '已完成一圈實際橫滾並恢復正飛與控制；不需降落，現在可以 Disarm。'
  if (phase === 0) return '請先在起飛區實際接地開始，不能從高空跳過自行起飛。'
  if (phase === 1) return '自行起飛至至少 8 m，建議約 10 m，為翻滾掉高保留餘裕。'
  if (metrics.insideRollArea < 0.5) return '已離開起飛點周圍 60 m 練習區；本次橫滾證據已中斷，回區後重新準備並完成一整圈。'
  if (metrics.rollEpisodeValid < 0.5) return `${metrics.rollInterrupted > 0.5 ? '本次橫滾已中斷，先前步驟保留；需重新準備並完整翻一圈。' : ''}先升至至少 8 m，帶回 20° 內、減緩旋轉與漂移，短暫準備 0.1 秒。`
  if (metrics.rollCompleted > 0.5) return '已觀察到完整一圈；回中減緩旋轉，再修到 25° 內。保持至少 1.5 m 高度，減緩下降與漂移，確認 0.25 秒。'
  const direction = metrics.rollDirection < 0 ? '左' : metrics.rollDirection > 0 ? '右' : '選左或右'
  return metrics.rollInverted > 0.5
    ? `已通過倒置；繼續向${direction}完成同一圈，接近正飛時提早回中減緩旋轉。`
    : `準備完成；${direction}推橫滾桿，沿同一方向完整翻一圈。可先適量加油爬升；倒置時適度收油，不以 俯仰或偏航 代替。`
}

function evaluateFullRoll(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('橫滾練習停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('橫滾練習停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('橫滾練習停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('橫滾練習缺少有效起飛點或地面參考，請重設訓練場。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('橫滾練習停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || (contact.touching && Math.abs(clearance) > 0.003)) return terminal('橫滾練習停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < FULL_ROLL_PHASE_IDS.length && context.checkpoints[FULL_ROLL_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureFullRollMotion(sample.state)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const airborne = !contact.touching && clearance >= 0.15
  const inside = launchDistanceM <= FULL_ROLL_AREA_RADIUS_M
  const episode = emptyEpisode()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = {
    ...episode, ...motion, rollPhase: phase, altitudeM, groundClearanceM: clearance,
    launchDistanceM, groundTouching: contact.touching ? 1 : 0, insideRollArea: inside ? 1 : 0,
    targetAltitudeM: FULL_ROLL_TARGET_HEIGHT_M,
  }
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  let measuredRollDegrees = 0
  let rotation: Vector3 = { x: 0, y: 0, z: 0 }
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('橫滾練習停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('橫滾練習停止：位置跳躍與實際速度不一致。', metrics)
    const observed = observedRotation(previous.state, sample.state)
    rotation = observed.vector
    const afterRateInBeforeBody = rotateVectorByQuaternion(observed.delta, sample.state.angularVelocityBodyRadPerSec)
    const beforeRate = previous.state.angularVelocityBodyRadPerSec
    measuredRollDegrees = -(beforeRate.z + afterRateInBeforeBody.z) * 0.5 * delta * DEGREES
    metrics.angularConsistencyErrorDegrees = Math.hypot(
      rotation.x - (beforeRate.x + afterRateInBeforeBody.x) * 0.5 * delta,
      rotation.y - (beforeRate.y + afterRateInBeforeBody.y) * 0.5 * delta,
      rotation.z - (beforeRate.z + afterRateInBeforeBody.z) * 0.5 * delta,
    ) * DEGREES
    // Includes fixed-step acceleration/retention error, but rejects pose-only
    // jumps. Refuse an ambiguous >90° retained interval rather than unwrap it.
    metrics.angularToleranceDegrees = 2 + 400 * delta * delta
    if (observed.angleDegrees > 90 || metrics.angularConsistencyErrorDegrees > metrics.angularToleranceDegrees) return terminal('橫滾練習停止：姿態變化與實際旋轉速度不一致，無法確認完整橫滾。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > FULL_ROLL_TIME_LIMIT_SECONDS) return terminal('橫滾挑戰逾時：尚未完成完整橫滾與空中恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: exerciseHint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = FULL_ROLL_PHASE_IDS[phase]
    phase += 1
    metrics.rollPhase = phase
    return phase === 6
      ? { status: 'success', checkpointIds: [id], score: 100, metrics, message: '已從地面自行起飛，完成一圈實際橫滾並恢復正飛與控制。', hint: exerciseHint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: exerciseHint(phase, metrics) }
  }
  // Reasons: 1 ground, 2 low, 3 outside, 4 off-axis, 5 overrotation,
  // 6 reversing past the starting orientation, 7 lost pre-roll height.
  const interrupt = (reason: number): TrainingEvaluation => {
    const interruption = { rollInterrupted: 1, rollInterruptionReason: reason,
      interruptionAltitudeM: altitudeM, interruptionRollProgressDegrees: metrics.rollProgressDegrees,
      interruptionLaunchDistanceM: launchDistanceM, interruptionOffAxisDegrees: metrics.rollOffAxisDegrees }
    Object.assign(metrics, emptyEpisode(), interruption)
    return continuing()
  }
  if (phase >= 6) return { status: 'success', score: 100, metrics, message: '已完成完整橫滾與恢復。', hint: exerciseHint(phase, metrics) }
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && inside && altitudeM >= FULL_ROLL_MIN_PREPARATION_HEIGHT_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < FULL_ROLL_MIN_HEIGHT_M) return interrupt(2)
  if (!inside) return interrupt(3)

  if (metrics.rollEpisodeState === 0) {
    const prepared = altitudeM >= FULL_ROLL_MIN_PREPARATION_HEIGHT_M && motion.tiltDegrees <= FULL_ROLL_PREPARATION_TILT_DEGREES
      && motion.bodyRateDegreesPerSecond <= FULL_ROLL_MAX_BODY_RATE_DEGREES && motion.horizontalSpeedMps <= FULL_ROLL_MAX_HORIZONTAL_SPEED_MPS
      && Math.abs(motion.verticalSpeedMps) <= FULL_ROLL_PREPARATION_VERTICAL_MPS
    metrics.preparationQualifying = prepared ? 1 : 0
    metrics.preparationDwellSeconds = prepared && metric(context, 'preparationQualifying') > 0.5
      ? Math.min(FULL_ROLL_PREPARATION_SECONDS, metric(context, 'preparationDwellSeconds') + delta) : 0
    if (metrics.preparationDwellSeconds + 1e-8 >= FULL_ROLL_PREPARATION_SECONDS) {
      metrics.rollEpisodeState = 1
      metrics.rollEpisodeValid = 1
      metrics.rollInterrupted = 0
      metrics.rollInterruptionReason = 0
      if (phase === 2) return advance()
    }
    return continuing()
  }
  // A prepared pilot may deliberately build upward energy before the roll;
  // speed preparation bounds do not silently revoke that readiness latch.
  if (metrics.rollEpisodeState === 1 && altitudeM < FULL_ROLL_MIN_PREPARATION_HEIGHT_M) return interrupt(7)
  metrics.rollSignedDegrees += -rotation.z * DEGREES
  metrics.rollMeasuredRateDegrees += measuredRollDegrees
  metrics.rollRateConsistencyErrorDegrees = Math.abs(metrics.rollSignedDegrees - metrics.rollMeasuredRateDegrees)
  // A per-sample tolerance must not accumulate into invented rotation: many
  // small pose-only or rate-only changes still disagree over the whole episode.
  if (metrics.rollRateConsistencyErrorDegrees > 12) return terminal('橫滾練習停止：累積姿態變化與實際橫滾速度不一致。', metrics)
  metrics.rollOffAxisDegrees += Math.hypot(rotation.x, rotation.y) * DEGREES
  if (metrics.rollDirection === 0 && Math.abs(metrics.rollSignedDegrees) >= 10) metrics.rollDirection = Math.sign(metrics.rollSignedDegrees)
  const directed = metrics.rollSignedDegrees * (metrics.rollDirection || 1)
  metrics.rollProgressDegrees = Math.min(360, Math.abs(metrics.rollSignedDegrees))
  if (Math.abs(metrics.rollSignedDegrees) > FULL_ROLL_MAX_TURN_DEGREES) return interrupt(5)
  if (metrics.rollOffAxisDegrees > 120) return interrupt(4)
  if (directed < -15) return interrupt(6)
  if (metrics.rollDirection !== 0 && metrics.rollEpisodeState === 1) metrics.rollEpisodeState = 2
  if (directed >= 120 && directed <= 240 && motion.tiltDegrees >= FULL_ROLL_INVERTED_TILT_DEGREES) metrics.rollInverted = 1
  if (phase === 3 && metrics.rollInverted > 0.5) return advance()
  if (metrics.rollInverted > 0.5 && directed >= FULL_ROLL_COMPLETION_DEGREES && directed <= FULL_ROLL_MAX_COMPLETION_DEGREES
    && motion.tiltDegrees <= FULL_ROLL_RECOVERY_TILT_DEGREES) {
    metrics.rollCompleted = 1
    metrics.rollEpisodeState = 3
  }
  if (phase === 4 && metrics.rollCompleted > 0.5) return advance()
  // Historical milestones alone cannot restore completion after an interruption.
  if (phase === 5 && metrics.rollCompleted > 0.5 && metrics.rollInverted > 0.5 && metrics.rollEpisodeValid > 0.5) {
    const recovered = directed >= FULL_ROLL_COMPLETION_DEGREES && directed <= FULL_ROLL_MAX_COMPLETION_DEGREES
      && motion.tiltDegrees <= FULL_ROLL_RECOVERY_TILT_DEGREES && motion.bodyRateDegreesPerSecond <= FULL_ROLL_MAX_BODY_RATE_DEGREES
      && motion.horizontalSpeedMps <= FULL_ROLL_MAX_HORIZONTAL_SPEED_MPS
      && motion.verticalSpeedMps >= -FULL_ROLL_RECOVERY_DESCENT_MPS && motion.verticalSpeedMps <= FULL_ROLL_RECOVERY_CLIMB_MPS
    metrics.recoveryQualifying = recovered ? 1 : 0
    metrics.recoveryDwellSeconds = recovered && metric(context, 'recoveryQualifying') > 0.5
      ? Math.min(FULL_ROLL_HOLD_SECONDS, metric(context, 'recoveryDwellSeconds') + delta) : 0
    if (metrics.recoveryDwellSeconds + 1e-8 >= FULL_ROLL_HOLD_SECONDS) return advance()
  } else {
    metrics.recoveryQualifying = 0
    metrics.recoveryDwellSeconds = 0
  }
  return continuing()
}

export const fullRollEvaluator: LessonEvaluatorContract = { evaluate: evaluateFullRoll }

export const FULL_ROLL_LESSON: LessonDefinition = {
  id: 'full-roll', priority: 2.8, title: '完整橫滾', availability: 'available', available: true,
  description: '從地面自行起飛，取得高度餘裕後向左或右翻一整圈，再恢復正飛與控制。',
  objectives: ['從地面自行起飛並為翻滾保留高度。', '實際通過倒置，沿同一方向完成一圈橫滾。', '回中減緩旋轉，再修回正飛並短暫恢復控制。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'roll-ground', title: '地面開始', description: '在起飛區實際接地開始。' },
    { id: 'roll-liftoff', title: '自行起飛至練習高度', description: '自行起飛至至少 8 m，建議約 10 m。' },
    { id: 'roll-ready', title: '橫滾前準備', description: '帶回接近水平、減緩旋轉與漂移，短暫準備 0.1 秒。' },
    { id: 'roll-inverted', title: '通過倒置姿態', description: '選左或右橫滾，沿同一圈實際通過倒置姿態。' },
    { id: 'roll-upright', title: '完成一圈橫滾', description: '沿同一方向翻完 360° 附近並回到正飛，不以半圈後反向回平代替。' },
    { id: 'roll-recovered', title: '恢復正飛與控制', description: '留在空中，減緩旋轉、下降與漂移，短暫確認 0.25 秒。' },
  ],
  success: { title: '完整橫滾完成', description: '已觀察到完整橫滾與其後的空中恢復。', criteria: ['實際地面自行起飛', '觀察到同一圈的倒置與完整橫滾', '空中短暫恢復控制'] },
  failure: { title: '橫滾尚未完成', description: '一般動作中斷可重新準備；墜毀、解除解鎖或無效資料需要重試。', criteria: ['不能以偏航、前後翻或半圈回平代替', '接地停住不能代替空中恢復'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['rollProgressDegrees', 'tiltDegrees', 'verticalSpeedMps', 'recoveryDwellSeconds'] },
  hints: ['取得足夠高度，選左或右完整翻一圈；接近正飛時提早回中，再主動修回接近水平。'],
  evaluator: fullRollEvaluator,
}

export const FULL_ROLL_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L10', title: '完整橫滾', level: '花飛入門', prerequisiteIds: ['basic-recovery'],
  objectives: ['理解倒置時的姿態與油門方向。', '自行完成一圈完整橫滾並恢復正飛與控制。'],
  steps: ['從地面自行起飛，至少 8 m、建議約 10 m，保留翻滾的掉高餘裕。', '帶回接近水平並稍微減緩旋轉與漂移，依提示短暫準備 0.1 秒。', '可先適量加油爬升，再選左或右推橫滾桿，沿同一方向完整翻一圈。', '倒置時適度收油，避免推力往地面壓；接近正飛時提早回中減緩旋轉，再修回接近水平。', '保持空中與至少 1.5 m 高度，稍微減緩下降與漂移，確認 0.25 秒後完成；不需降落或回原位置。'],
  commonMistakes: ['只翻半圈再反向回平；本課要完成同一方向的一整圈。', '用 俯仰或偏航 代替 Roll；需沿機頭到機尾的軸橫滾。', '高度不足或倒置時持續大油門，讓機體很快掉高。', '已轉回正飛仍繼續推橫滾桿，沒提早回中停止旋轉。'],
}
