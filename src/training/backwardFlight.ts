import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const BACKWARD_FLIGHT_TARGET_HEIGHT_M = 10
export const BACKWARD_FLIGHT_MIN_ENTRY_HEIGHT_M = 4
export const BACKWARD_FLIGHT_MAX_ENTRY_HEIGHT_M = 30
export const BACKWARD_FLIGHT_MIN_HEIGHT_M = 1.5
export const BACKWARD_FLIGHT_AREA_RADIUS_M = 150
export const BACKWARD_FLIGHT_MIN_FORWARD_SPEED_MPS = 1.5
export const BACKWARD_FLIGHT_MIN_RETAINED_SPEED_MPS = 0.5
export const BACKWARD_FLIGHT_MIN_SPEED_MPS = 0.75
export const BACKWARD_FLIGHT_MIN_YAW_DEGREES = 120
export const BACKWARD_FLIGHT_MAX_HEADING_ERROR_DEGREES = 60
export const BACKWARD_FLIGHT_REQUIRED_DISTANCE_M = 3
export const BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS = 0.6
export const BACKWARD_FLIGHT_RECOVERY_SECONDS = 0.25
export const BACKWARD_FLIGHT_RECOVERY_SPEED_RATIO = 0.75
export const BACKWARD_FLIGHT_MAX_RECOVERY_SPEED_MPS = 2.5
export const BACKWARD_FLIGHT_TIME_LIMIT_SECONDS = 180
export const BACKWARD_FLIGHT_PHASE_IDS = Object.freeze([
  'backward-ground', 'backward-liftoff', 'backward-forward', 'backward-turned',
  'backward-moving', 'backward-maintained', 'backward-recovered',
] as const)
const DEGREES = 180 / Math.PI
const angle = (dot: number): number => Math.acos(Math.max(-1, Math.min(1, dot))) * DEGREES

export function measureBackwardFlightMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const nose = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
  const noseLength = Math.hypot(nose.x, nose.z)
  const horizontalSpeedMps = Math.hypot(state.velocityMps.x, state.velocityMps.z)
  const noseX = noseLength > 0.1 ? nose.x / noseLength : 0
  const noseZ = noseLength > 0.1 ? nose.z / noseLength : 0
  const alongNose = noseX * state.velocityMps.x + noseZ * state.velocityMps.z
  return {
    tiltDegrees: angle(up.y),
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    horizontalSpeedMps, verticalSpeedMps: state.velocityMps.y, noseX, noseZ,
    backwardSpeedMps: -alongNose,
    backwardVelocityHeadingDegrees: horizontalSpeedMps > 0.1 && noseLength > 0.1 ? angle(alongNose / horizontalSpeedMps) : 0,
  }
}
function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function episodeDefaults(): Record<string, number> {
  return {
    backwardEpisodeValid: 0, backwardInterrupted: 0, backwardInterruptionReason: 0,
    backwardEntryDirectionX: 0, backwardEntryDirectionZ: 0,
    backwardEntryNoseX: 0, backwardEntryNoseZ: 0,
    backwardForwardEstablished: 0, backwardTurned: 0, backwardMoving: 0, backwardMaintained: 0,
    backwardPreparationQualifying: 0, backwardPreparationDwellSeconds: 0,
    backwardMovingQualifying: 0, backwardMovingDwellSeconds: 0,
    backwardDistanceM: 0, backwardHoldSeconds: 0, backwardMomentumLostSeconds: 0,
    backwardInvalidSeconds: 0, backwardHeightInvalidSeconds: 0, backwardRecoveryQualifying: 0, backwardRecoveryDwellSeconds: 0,
    backwardCompletionSpeedMps: 0, backwardRecoverySpeedLimitMps: 0,
    interruptionAltitudeM: 0, interruptionTiltDegrees: 0, interruptionLaunchDistanceM: 0,
    interruptionBackwardSpeedMps: 0, interruptionBackwardForwardSpeedMps: 0,
    interruptionBackwardDistanceM: 0, interruptionBackwardHoldSeconds: 0,
    interruptionBackwardHeadingErrorDegrees: 0,
  }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按再練一次，從地面自行起飛後重試後退飛行。' }
}
function hint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase === 0) return '先在起飛區實際接地，低油門明確解鎖。'
  if (phase === 1) return '自行起飛至約 10 m；至少離地 4 m 再建立前進速度。'
  if (metrics.backwardEpisodeValid < 0.5) return `${metrics.backwardInterrupted > 0.5 ? '本次動量與後退路線已重新準備，先前勾選保留；仍須重新前飛、轉頭並完成後退路線。' : ''}沿寬闊走廊前飛，機頭朝移動方向，維持至少 1.5 m/s 約 0.2 秒。`
  if (metrics.backwardTurned < 0.5) return '保留目前向前的移動慣性，用左或右偏航轉頭約 180°；機腹維持朝下，不要先停住。'
  if (metrics.backwardMaintained < 0.5) return `機頭朝向來路，但飛機繼續沿原方向移動；後退速度至少 0.75 m/s，目前有效後退 ${metrics.backwardDistanceM.toFixed(1)}／3 m、${metrics.backwardHoldSeconds.toFixed(1)}／0.6 秒。`
  if (phase < 7) return `後退路線已完成；修平機體，減速至少四分之一至 ${metrics.backwardRecoverySpeedLimitMps.toFixed(1)} m/s 以下，或轉回面向實際移動方向，穩住升降與旋轉 0.25 秒。`
  return '已完成前飛、保留動量轉頭、實際後退路線與空中恢復；不需要降落。'
}

function evaluateBackwardFlight(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('後退飛行停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('後退飛行停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('後退飛行停止：已上鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('後退飛行缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('後退飛行停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('後退飛行停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < BACKWARD_FLIGHT_PHASE_IDS.length && context.checkpoints[BACKWARD_FLIGHT_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureBackwardFlightMotion(sample.state)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const airborne = !contact.touching && clearance >= 0.15
  const episode = episodeDefaults()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = { ...episode, ...motion, backwardPhase: phase, altitudeM, groundClearanceM: clearance,
    launchDistanceM, groundTouching: contact.touching ? 1 : 0, targetAltitudeM: BACKWARD_FLIGHT_TARGET_HEIGHT_M,
    backwardYawDegrees: 0, backwardHeadingErrorDegrees: 180, backwardForwardSpeedMps: 0 }
  const updateDirection = (): void => {
    if (metrics.backwardEpisodeValid < 0.5) return
    metrics.backwardForwardSpeedMps = sample.state.velocityMps.x * metrics.backwardEntryDirectionX + sample.state.velocityMps.z * metrics.backwardEntryDirectionZ
    metrics.backwardYawDegrees = angle(motion.noseX * metrics.backwardEntryNoseX + motion.noseZ * metrics.backwardEntryNoseZ)
    metrics.backwardHeadingErrorDegrees = angle(-motion.noseX * metrics.backwardEntryDirectionX - motion.noseZ * metrics.backwardEntryDirectionZ)
  }
  updateDirection()
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  if (!previous && metrics.backwardEpisodeValid > 0.5) return terminal('後退飛行停止：缺少連續的飛行觀察。', metrics)
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('後退飛行停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('後退飛行停止：位置跳躍與實際速度不一致。', metrics)
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
    if (turn * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > 2 + 400 * delta * delta) return terminal('後退飛行停止：姿態變化與實際旋轉速度不一致。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > BACKWARD_FLIGHT_TIME_LIMIT_SECONDS) return terminal('後退飛行挑戰逾時：尚未完成後退路線與恢復控制。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: hint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = BACKWARD_FLIGHT_PHASE_IDS[phase]
    phase += 1
    metrics.backwardPhase = phase
    return phase >= 7 ? { status: 'success', checkpointIds: [id], score: 100, metrics,
      message: '已從地面起飛，保留前飛動量轉頭，完成實際後退路線並恢復控制。', hint: hint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: hint(phase, metrics) }
  }
  // Reasons: ground, low, outside area, altitude, excessive tilt, lost momentum,
  // nose no longer reversed, insufficient backward motion.
  const interrupt = (reason: number): TrainingEvaluation => {
    if (metrics.backwardEpisodeValid < 0.5 && metrics.backwardInterrupted > 0.5) return continuing()
    const snapshot = { backwardInterrupted: 1, backwardInterruptionReason: reason, interruptionAltitudeM: altitudeM,
      interruptionTiltDegrees: motion.tiltDegrees, interruptionLaunchDistanceM: launchDistanceM,
      interruptionBackwardSpeedMps: motion.backwardSpeedMps, interruptionBackwardForwardSpeedMps: metrics.backwardForwardSpeedMps,
      interruptionBackwardDistanceM: metrics.backwardDistanceM, interruptionBackwardHoldSeconds: metrics.backwardHoldSeconds,
      interruptionBackwardHeadingErrorDegrees: metrics.backwardHeadingErrorDegrees }
    Object.assign(metrics, episodeDefaults(), snapshot)
    return continuing()
  }
  const proof = (): boolean => metrics.backwardEpisodeValid > 0.5 && metrics.backwardForwardEstablished > 0.5
    && metrics.backwardTurned > 0.5 && metrics.backwardMoving > 0.5 && metrics.backwardMaintained > 0.5
    && metrics.backwardDistanceM + 1e-8 >= BACKWARD_FLIGHT_REQUIRED_DISTANCE_M
    && metrics.backwardHoldSeconds + 1e-8 >= BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS
  if (phase >= 7) return proof() && metrics.backwardRecoveryQualifying > 0.5
    && metrics.backwardRecoveryDwellSeconds + 1e-8 >= BACKWARD_FLIGHT_RECOVERY_SECONDS
    ? { status: 'success', score: 100, metrics, message: '已完成後退飛行與空中恢復。', hint: hint(phase, metrics) }
    : terminal('後退飛行停止：缺少同一段前飛、轉頭、後退與恢復的實際證據。', metrics)
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && launchDistanceM <= BACKWARD_FLIGHT_AREA_RADIUS_M && altitudeM >= BACKWARD_FLIGHT_MIN_ENTRY_HEIGHT_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < BACKWARD_FLIGHT_MIN_HEIGHT_M) return interrupt(2)
  if (launchDistanceM > BACKWARD_FLIGHT_AREA_RADIUS_M) return interrupt(3)
  if (motion.tiltDegrees > 70) return interrupt(5)
  if (metrics.backwardEpisodeValid > 0.5 && metrics.backwardMaintained < 0.5) {
    const retained = metrics.backwardForwardSpeedMps >= BACKWARD_FLIGHT_MIN_RETAINED_SPEED_MPS
    metrics.backwardMomentumLostSeconds = retained ? 0 : metrics.backwardMomentumLostSeconds + delta
    if (metrics.backwardMomentumLostSeconds + 1e-8 >= 0.3) return interrupt(6)
  }
  if (altitudeM < BACKWARD_FLIGHT_MIN_ENTRY_HEIGHT_M || altitudeM > BACKWARD_FLIGHT_MAX_ENTRY_HEIGHT_M) {
    // Height corrections never earn progress, but physically travelling back
    // still subtracts. The same short strip cannot be reused via a height gap.
    if (metrics.backwardEpisodeValid > 0.5 && metrics.backwardMaintained < 0.5 && previous) {
      metrics.backwardDistanceM = Math.max(0, metrics.backwardDistanceM + Math.min(0,
        (position.x - previous.state.positionM.x) * metrics.backwardEntryDirectionX
        + (position.z - previous.state.positionM.z) * metrics.backwardEntryDirectionZ))
    }
    metrics.backwardHeightInvalidSeconds += delta
    metrics.backwardMovingQualifying = 0
    metrics.backwardMovingDwellSeconds = 0
    metrics.backwardRecoveryQualifying = 0
    metrics.backwardRecoveryDwellSeconds = 0
    if (metrics.backwardHeightInvalidSeconds + 1e-8 >= 0.75) return interrupt(4)
    return continuing()
  }
  metrics.backwardHeightInvalidSeconds = 0
  if (metrics.backwardEpisodeValid < 0.5) {
    const prepared = motion.horizontalSpeedMps >= BACKWARD_FLIGHT_MIN_FORWARD_SPEED_MPS && motion.backwardVelocityHeadingDegrees <= 45
    metrics.backwardPreparationQualifying = prepared ? 1 : 0
    metrics.backwardPreparationDwellSeconds = prepared && metric(context, 'backwardPreparationQualifying') > 0.5
      ? Math.min(0.2, metric(context, 'backwardPreparationDwellSeconds') + delta) : 0
    if (metrics.backwardPreparationDwellSeconds + 1e-8 >= 0.2) {
      Object.assign(metrics, episodeDefaults(), { backwardEpisodeValid: 1, backwardForwardEstablished: 1,
        backwardEntryDirectionX: sample.state.velocityMps.x / motion.horizontalSpeedMps,
        backwardEntryDirectionZ: sample.state.velocityMps.z / motion.horizontalSpeedMps,
        backwardEntryNoseX: motion.noseX, backwardEntryNoseZ: motion.noseZ })
      updateDirection()
      if (phase === 2) return advance()
    }
    return continuing()
  }
  if (metrics.backwardMaintained < 0.5) {
    const retained = metrics.backwardForwardSpeedMps >= BACKWARD_FLIGHT_MIN_RETAINED_SPEED_MPS
    const turned = retained && metrics.backwardYawDegrees >= BACKWARD_FLIGHT_MIN_YAW_DEGREES
      && metrics.backwardHeadingErrorDegrees <= BACKWARD_FLIGHT_MAX_HEADING_ERROR_DEGREES
    if (turned) metrics.backwardTurned = 1
    const backward = turned && motion.backwardSpeedMps >= BACKWARD_FLIGHT_MIN_SPEED_MPS && motion.backwardVelocityHeadingDegrees >= 120
    const previouslyBackward = metric(context, 'backwardMovingQualifying') > 0.5
    metrics.backwardMovingQualifying = backward ? 1 : 0
    metrics.backwardMovingDwellSeconds = backward && previouslyBackward ? metrics.backwardMovingDwellSeconds + delta : 0
    if (metrics.backwardMovingDwellSeconds + 1e-8 >= 0.1) metrics.backwardMoving = 1
    if (backward && previouslyBackward && previous) {
      const travel = (position.x - previous.state.positionM.x) * metrics.backwardEntryDirectionX
        + (position.z - previous.state.positionM.z) * metrics.backwardEntryDirectionZ
      metrics.backwardDistanceM = Math.max(0, metrics.backwardDistanceM + travel)
      metrics.backwardHoldSeconds += delta
    }
    if (!backward && metrics.backwardMoving > 0.5) {
      // Brief corrections do not earn distance or time. Reverse travel still
      // subtracts, so shuttling through invalid intervals cannot pump progress.
      if (previous) metrics.backwardDistanceM = Math.max(0, metrics.backwardDistanceM + Math.min(0,
        (position.x - previous.state.positionM.x) * metrics.backwardEntryDirectionX
        + (position.z - previous.state.positionM.z) * metrics.backwardEntryDirectionZ))
      metrics.backwardInvalidSeconds += delta
      if (metrics.backwardInvalidSeconds + 1e-8 >= 0.75) return interrupt(turned ? 8 : 7)
    } else metrics.backwardInvalidSeconds = 0
    if (metrics.backwardDistanceM + 1e-8 >= BACKWARD_FLIGHT_REQUIRED_DISTANCE_M
      && metrics.backwardHoldSeconds + 1e-8 >= BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS && backward) {
      metrics.backwardMaintained = 1
      metrics.backwardCompletionSpeedMps = motion.horizontalSpeedMps
      metrics.backwardRecoverySpeedLimitMps = Math.min(BACKWARD_FLIGHT_MAX_RECOVERY_SPEED_MPS,
        motion.horizontalSpeedMps * BACKWARD_FLIGHT_RECOVERY_SPEED_RATIO)
    }
    if (phase === 3 && metrics.backwardTurned > 0.5) return advance()
    if (phase === 4 && metrics.backwardMoving > 0.5) return advance()
    if (phase === 5 && proof()) return advance()
    return continuing()
  }
  // Latched milestone flags never replace a new complete episode after a retry.
  if (phase === 3 && metrics.backwardTurned > 0.5 || phase === 4 && metrics.backwardMoving > 0.5 || phase === 5 && proof()) return advance()
  if (phase === 6 && proof()) {
    const slowed = metrics.backwardCompletionSpeedMps >= BACKWARD_FLIGHT_MIN_SPEED_MPS
      && motion.horizontalSpeedMps <= metrics.backwardRecoverySpeedLimitMps
    const controlled = slowed || motion.backwardVelocityHeadingDegrees <= 60 && motion.horizontalSpeedMps >= 0.5
    const recovered = controlled && motion.tiltDegrees <= 40 && motion.bodyRateDegreesPerSecond <= 180
      && motion.verticalSpeedMps >= -4 && motion.verticalSpeedMps <= 5
    metrics.backwardRecoveryQualifying = recovered ? 1 : 0
    metrics.backwardRecoveryDwellSeconds = recovered && metric(context, 'backwardRecoveryQualifying') > 0.5
      ? Math.min(BACKWARD_FLIGHT_RECOVERY_SECONDS, metrics.backwardRecoveryDwellSeconds + delta) : 0
    if (metrics.backwardRecoveryDwellSeconds + 1e-8 >= BACKWARD_FLIGHT_RECOVERY_SECONDS) return advance()
  }
  return continuing()
}

export const backwardFlightEvaluator: LessonEvaluatorContract = { evaluate: evaluateBackwardFlight }
export const BACKWARD_FLIGHT_LESSON: LessonDefinition = {
  id: 'backward-flight', priority: 16, title: '後退飛行', availability: 'available', available: true,
  description: '自行起飛並建立前進速度，保留原方向的動量偏航轉頭，再以機腹朝下的姿態實際後退並恢復控制。',
  objectives: ['分辨機頭方向與實際移動方向。', '保留前飛動量轉頭，機腹維持朝下。', '實際後退至少 3 m，再減速或轉回並恢復控制。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', 'backward-zone'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'backward-ground', title: '地面開始', description: '在起飛區實際接地，明確解鎖。' },
    { id: 'backward-liftoff', title: '自行起飛至練習高度', description: '至少離地 4 m，建議約 10 m，再進入寬闊走廊。' },
    { id: 'backward-forward', title: '建立前進速度', description: '機頭朝移動方向，維持至少 1.5 m/s 約 0.2 秒。' },
    { id: 'backward-turned', title: '保留動量轉頭', description: '沿原方向繼續移動，左或右偏航約 180°，機腹維持朝下。' },
    { id: 'backward-moving', title: '形成實際後退飛行', description: '機頭朝來路，實際朝機尾方向移動，後退速度至少 0.75 m/s。' },
    { id: 'backward-maintained', title: '維持後退路線', description: '沿原方向實際後退至少 3 m，累積有效後退至少 0.6 秒。' },
    { id: 'backward-recovered', title: '減速或轉回並恢復控制', description: '比完成路線時減速至少四分之一且不超過 2.5 m/s，或轉回面向實際移動方向，修平機體並穩住升降與旋轉 0.25 秒。' },
  ],
  success: { title: '後退飛行完成', description: '已觀察到前飛、保留動量轉頭、實際後退路線與空中恢復。', criteria: ['地面自行起飛', '保留動量轉頭且機腹朝下', '實際後退至少 3 m 與 0.6 秒', '減速或轉回並恢復控制'] },
  failure: { title: '後退飛行尚未完成', description: '一般偏離可在空中重新建立前速；墜毀、上鎖或無效資料需要重試。', criteria: ['原地轉頭不算後退飛行', '倒置或停住後再前飛不算保留動量', '中斷前後的路線不能拼成一次後退'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['backwardYawDegrees', 'backwardSpeedMps', 'backwardDistanceM', 'backwardHoldSeconds', 'backwardRecoveryDwellSeconds'] },
  hints: ['從地面起飛至約 10 m，先向前飛再偏航轉頭；機頭朝向來路，飛機沿原方向繼續移動。後退至少 3 m 後減速或轉回，不用窄門、精準停點或降落。'],
  evaluator: backwardFlightEvaluator,
}
export const BACKWARD_FLIGHT_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L17', title: '後退飛行', level: '花飛進階', prerequisiteIds: ['direction-control', 'coordinated-turn', 'basic-recovery'],
  objectives: ['辨認機頭朝向與實際速度方向的差別。', '用偏航轉頭保留前飛動量，控制後退路線與改出。'],
  steps: ['從地面自行起飛至約 10 m，至少離地 4 m 再前飛。', '沿寬闊走廊建立前進速度，機頭朝移動方向，至少 1.5 m/s 維持 0.2 秒。', '保留原方向的移動慣性，以左右任一偏航轉頭約 180°；機腹保持朝下，不先停住。', '對照來向參考物與速度方向提示，機頭朝來路，但飛機仍沿原方向移動；後退速度至少 0.75 m/s。', '有效後退至少 3 m、0.6 秒，再比完成路線時減速至少四分之一且不超過 2.5 m/s，或轉回面向實際移動方向，修平姿態並穩住 0.25 秒。'],
  commonMistakes: ['在原地偏航轉頭，沒有前進動量。', '先停住，轉頭後重新加速前飛。', '把機腹朝天的倒置飛行當成這堂課的後退飛行。', '只看機頭方向，忽略飛機的實際移動方向與速度。'],
}
