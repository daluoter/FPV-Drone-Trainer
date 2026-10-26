import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const SPLIT_S_TARGET_HEIGHT_M = 25
export const SPLIT_S_MIN_ENTRY_HEIGHT_M = 15
export const SPLIT_S_MIN_HEIGHT_M = 1.5
export const SPLIT_S_AREA_RADIUS_M = 150
export const SPLIT_S_MIN_ENTRY_SPEED_MPS = 3
export const SPLIT_S_MIN_HEIGHT_LOSS_M = 3
export const SPLIT_S_MIN_REVERSE_TRAVEL_M = 1.5
export const SPLIT_S_RECOVERY_TILT_DEGREES = 35
export const SPLIT_S_HOLD_SECONDS = 0.2
export const SPLIT_S_TIME_LIMIT_SECONDS = 300
export const SPLIT_S_PHASE_IDS = Object.freeze([
  'split-ground', 'split-liftoff', 'split-entry', 'split-inverted',
  'split-descent', 'split-reversed', 'split-upright', 'split-recovered',
] as const)
const DEGREES = 180 / Math.PI

/** Instruments use measured body/world state; controller position is never completion proof. */
export function measureSplitSMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  return {
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    rollRateDegreesPerSecond: -state.angularVelocityBodyRadPerSec.z * DEGREES,
    pitchRateDegreesPerSecond: state.angularVelocityBodyRadPerSec.x * DEGREES,
    verticalSpeedMps: state.velocityMps.y,
    horizontalSpeedMps: Math.hypot(state.velocityMps.x, state.velocityMps.z),
  }
}
function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function emptyEpisode(): Record<string, number> {
  return {
    splitEpisodeState: 0, splitEpisodeValid: 0, splitInterrupted: 0, splitInterruptionReason: 0,
    splitRollSignedDegrees: 0, splitRollProgressDegrees: 0, splitRollMaxDegrees: 0, splitRollMeasuredDegrees: 0,
    splitPitchSignedDegrees: 0, splitPitchProgressDegrees: 0, splitPitchMaxDegrees: 0, splitPitchMeasuredDegrees: 0,
    splitRollOffAxisDegrees: 0, splitPitchOffAxisDegrees: 0,
    splitInverted: 0, splitDescended: 0, splitReversed: 0, splitCompleted: 0, splitGeometryFrozen: 0,
    splitForwardX: 0, splitForwardZ: -1, splitForwardSpeedMps: 0, splitHeadingChangeDegrees: 0, splitDiveStartY: 0, splitLowestY: 0, splitHeightLossM: 0,
    splitReverseTravelM: 0, splitPathTurnDegrees: 0, splitPreviousTangentDegrees: 0, splitTangentObserved: 0, splitPathMaxDegrees: 0, splitPathStallSeconds: 0,
    splitPreparationQualifying: 0, splitPreparationDwellSeconds: 0, splitRecoveryQualifying: 0, splitRecoveryDwellSeconds: 0,
    interruptionAltitudeM: 0, interruptionSplitRollDegrees: 0, interruptionSplitPitchDegrees: 0,
    interruptionHeightLossM: 0, interruptionHeadingChangeDegrees: 0, interruptionReverseTravelM: 0, interruptionLaunchDistanceM: 0,
  }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按再練一次，從地面自行起飛並重新取得下降餘裕後重試。' }
}
function hint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase >= 8) return '已完成橫滾倒置、下降半迴圈、方向反轉及空中恢復；不需降落，可以上鎖停止馬達。'
  if (phase === 0) return '在起飛區實際接地、低油門明確解鎖後開始。'
  if (phase === 1) return '自行起飛至至少 15 m，建議約 25 m；這課向下繞回，需要保留下降空間。'
  if (metrics.splitEpisodeValid < 0.5) return `${metrics.splitInterrupted > 0.5 ? '本次動作已中斷，先前步驟保留；請重新完成同一套翻轉下降。' : ''}升到至少 15 m，建立至少 3 m/s 前進速度，姿態帶回 35° 內並短暫準備。`
  if (metrics.splitInverted < 0.5) return '選左或右，主要用橫滾半圈翻成倒置；不要直接後翻，也不要用偏航轉頭代替。倒置時適度收油。'
  if (metrics.splitDescended < 0.5) return '已橫滾至倒置；向後拉俯仰，讓機頭往地面繞出下降半迴圈，配合油門並留意高度。'
  if (metrics.splitReversed < 0.5) return '已實際下降；持續同方向後拉，讓機頭與實際移動都轉向來路，不能只原地轉機頭。'
  if (metrics.splitCompleted < 0.5) return '沿同一下降半迴圈拉回正飛，朝來路方向飛出；不要反向翻回起始姿態。'
  return '已完成下降與改出；留在空中，回中減緩旋轉並主動帶回 35° 內，減緩下降後確認 0.2 秒。'
}

function evaluateSplitS(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('翻轉下降停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('翻轉下降停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('翻轉下降停止：已上鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('翻轉下降缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('翻轉下降停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('翻轉下降停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < SPLIT_S_PHASE_IDS.length && context.checkpoints[SPLIT_S_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureSplitSMotion(sample.state)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const inside = launchDistanceM <= SPLIT_S_AREA_RADIUS_M
  const airborne = !contact.touching && clearance >= 0.15
  const episode = emptyEpisode()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = { ...episode, ...motion, splitPhase: phase, altitudeM, groundClearanceM: clearance,
    launchDistanceM, insideSplitArea: inside ? 1 : 0, groundTouching: contact.touching ? 1 : 0, targetAltitudeM: SPLIT_S_TARGET_HEIGHT_M }
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  let rollDegrees = 0
  let pitchDegrees = 0
  let yawDegrees = 0
  let measuredRollDegrees = 0
  let measuredPitchDegrees = 0
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('翻轉下降停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    if (metrics.velocityConsistencyErrorM > 0.04 + 10 * delta * delta) return terminal('翻轉下降停止：位置跳躍與實際速度不一致。', metrics)
    let rotation = normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(normalizeQuaternion(previous.state.orientation)), normalizeQuaternion(sample.state.orientation)))
    if (rotation.w < 0) rotation = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: -rotation.w }
    const sine = Math.hypot(rotation.x, rotation.y, rotation.z)
    const angle = 2 * Math.atan2(sine, Math.max(0, rotation.w))
    const factor = sine > 1e-10 ? angle / sine : 2
    pitchDegrees = rotation.x * factor * DEGREES
    rollDegrees = -rotation.z * factor * DEGREES
    yawDegrees = Math.abs(rotation.y) * factor * DEGREES
    const rateAfter = rotateVectorByQuaternion(rotation, sample.state.angularVelocityBodyRadPerSec)
    const rateBefore = previous.state.angularVelocityBodyRadPerSec
    measuredRollDegrees = -(rateBefore.z + rateAfter.z) * 0.5 * delta * DEGREES
    measuredPitchDegrees = (rateBefore.x + rateAfter.x) * 0.5 * delta * DEGREES
    metrics.angularConsistencyErrorDegrees = Math.hypot(
      rotation.x * factor - (rateBefore.x + rateAfter.x) * 0.5 * delta,
      rotation.y * factor - (rateBefore.y + rateAfter.y) * 0.5 * delta,
      rotation.z * factor - (rateBefore.z + rateAfter.z) * 0.5 * delta,
    ) * DEGREES
    if (angle * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > 2 + 400 * delta * delta) return terminal('翻轉下降停止：姿態變化與實際旋轉速度不一致。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > SPLIT_S_TIME_LIMIT_SECONDS) return terminal('翻轉下降挑戰逾時：尚未完成下降半迴圈與空中恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: hint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = SPLIT_S_PHASE_IDS[phase]
    phase += 1
    metrics.splitPhase = phase
    return phase >= 8 ? { status: 'success', checkpointIds: [id], score: 100, metrics,
      message: '已從地面自行起飛，完成橫滾倒置、下降半迴圈及空中改出。', hint: hint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: hint(phase, metrics) }
  }
  // Reasons: ground, low, outside, off-axis, overrotation, reversal,
  // lost entry height before the roll/dive, interrupted or insufficient spatial path.
  const interrupt = (reason: number): TrainingEvaluation => {
    const snapshot = { splitInterrupted: 1, splitInterruptionReason: reason, interruptionAltitudeM: altitudeM,
      interruptionSplitRollDegrees: metrics.splitRollProgressDegrees, interruptionSplitPitchDegrees: metrics.splitPitchProgressDegrees,
      interruptionHeightLossM: metrics.splitHeightLossM, interruptionHeadingChangeDegrees: metrics.splitHeadingChangeDegrees,
      interruptionReverseTravelM: metrics.splitReverseTravelM, interruptionLaunchDistanceM: launchDistanceM }
    Object.assign(metrics, emptyEpisode(), snapshot)
    return continuing()
  }
  if (phase >= 8) return metrics.splitEpisodeValid > 0.5 && metrics.splitCompleted > 0.5 && metrics.splitInverted > 0.5
    && metrics.splitDescended > 0.5 && metrics.splitReversed > 0.5
    ? { status: 'success', score: 100, metrics, message: '已完成翻轉下降與空中恢復。', hint: hint(phase, metrics) }
    : terminal('翻轉下降停止：缺少同一套動作的實際飛行證據，請重新開始。', metrics)
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && inside && altitudeM >= SPLIT_S_MIN_ENTRY_HEIGHT_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < SPLIT_S_MIN_HEIGHT_M) return interrupt(2)
  if (!inside) return interrupt(3)
  const forward = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 0, z: -1 })
  const forwardNorm = Math.hypot(forward.x, forward.z)
  if (metrics.splitEpisodeState === 0) {
    const speed = forwardNorm > 0.1 ? (sample.state.velocityMps.x * forward.x + sample.state.velocityMps.z * forward.z) / forwardNorm : 0
    metrics.splitForwardSpeedMps = speed
    metrics.splitHeadingChangeDegrees = 0
    const prepared = altitudeM >= SPLIT_S_MIN_ENTRY_HEIGHT_M && motion.tiltDegrees <= 35 && motion.bodyRateDegreesPerSecond <= 120
      && speed >= SPLIT_S_MIN_ENTRY_SPEED_MPS && Math.abs(motion.verticalSpeedMps) <= 4
    metrics.splitPreparationQualifying = prepared ? 1 : 0
    metrics.splitPreparationDwellSeconds = prepared && metric(context, 'splitPreparationQualifying') > 0.5
      ? Math.min(0.1, metric(context, 'splitPreparationDwellSeconds') + delta) : 0
    if (metrics.splitPreparationDwellSeconds + 1e-8 >= 0.1) {
      Object.assign(metrics, { splitEpisodeState: 1, splitEpisodeValid: 1, splitInterrupted: 0, splitInterruptionReason: 0,
        splitForwardX: forward.x / forwardNorm, splitForwardZ: forward.z / forwardNorm })
      if (phase === 2) return advance()
    }
    return continuing()
  }
  const forwardSpeed = sample.state.velocityMps.x * metrics.splitForwardX + sample.state.velocityMps.z * metrics.splitForwardZ
  metrics.splitForwardSpeedMps = forwardSpeed
  metrics.splitHeadingChangeDegrees = forwardNorm > 0.15
    ? Math.acos(Math.max(-1, Math.min(1, (forward.x * metrics.splitForwardX + forward.z * metrics.splitForwardZ) / forwardNorm))) * DEGREES
    : metric(context, 'splitHeadingChangeDegrees')
  if (metrics.splitEpisodeState === 1) {
    metrics.splitRollSignedDegrees += rollDegrees
    metrics.splitRollMeasuredDegrees += measuredRollDegrees
    metrics.splitRollProgressDegrees = Math.abs(metrics.splitRollSignedDegrees)
    metrics.splitRollMaxDegrees = Math.max(metrics.splitRollMaxDegrees, metrics.splitRollProgressDegrees)
    metrics.splitRollOffAxisDegrees += Math.abs(pitchDegrees) + yawDegrees
    if (Math.abs(metrics.splitRollSignedDegrees - metrics.splitRollMeasuredDegrees) > 12) return terminal('翻轉下降停止：累積姿態與橫滾速度不一致。', metrics)
    if (metrics.splitRollProgressDegrees > 250) return interrupt(5)
    if (metrics.splitRollOffAxisDegrees > 100 || metrics.splitHeadingChangeDegrees > 70) return interrupt(4)
    if (metrics.splitRollMaxDegrees - metrics.splitRollProgressDegrees > 45) return interrupt(6)
    if (altitudeM < SPLIT_S_MIN_ENTRY_HEIGHT_M - 5) return interrupt(7)
    if (metrics.splitRollProgressDegrees >= 145 && metrics.splitRollProgressDegrees <= 235 && motion.tiltDegrees >= 140) {
      metrics.splitInverted = 1
      metrics.splitEpisodeState = 2
      if (phase === 3) return advance()
    }
    return continuing()
  }
  // Continue measuring the last part of the half-roll while inverted, until
  // the descending pitch starts. A full roll cannot borrow the inversion flag.
  if (metrics.splitEpisodeState === 2 && metrics.splitPitchProgressDegrees < 10) {
    metrics.splitRollSignedDegrees += rollDegrees
    metrics.splitRollMeasuredDegrees += measuredRollDegrees
    metrics.splitRollProgressDegrees = Math.abs(metrics.splitRollSignedDegrees)
    metrics.splitRollMaxDegrees = Math.max(metrics.splitRollMaxDegrees, metrics.splitRollProgressDegrees)
    if (Math.abs(metrics.splitRollSignedDegrees - metrics.splitRollMeasuredDegrees) > 12) return terminal('翻轉下降停止：累積姿態與橫滾速度不一致。', metrics)
    if (metrics.splitRollProgressDegrees > 250) return interrupt(5)
    if (metrics.splitRollMaxDegrees - metrics.splitRollProgressDegrees > 45) return interrupt(6)
  }
  metrics.splitPitchSignedDegrees += pitchDegrees
  metrics.splitPitchMeasuredDegrees += measuredPitchDegrees
  metrics.splitPitchProgressDegrees = Math.max(0, metrics.splitPitchSignedDegrees)
  metrics.splitPitchMaxDegrees = Math.max(metrics.splitPitchMaxDegrees, metrics.splitPitchProgressDegrees)
  metrics.splitPitchOffAxisDegrees += Math.abs(rollDegrees) + yawDegrees
  if (Math.abs(metrics.splitPitchSignedDegrees - metrics.splitPitchMeasuredDegrees) > 12) return terminal('翻轉下降停止：累積姿態與俯仰速度不一致。', metrics)
  if (metrics.splitPitchOffAxisDegrees > 150) return interrupt(4)
  if (metrics.splitPitchProgressDegrees > 250) return interrupt(5)
  if (metrics.splitPitchSignedDegrees < -35 || metrics.splitPitchMaxDegrees - metrics.splitPitchSignedDegrees > 45) return interrupt(6)
  if (metrics.splitEpisodeState === 2 && metrics.splitPitchProgressDegrees >= 10 && motion.verticalSpeedMps < -0.5) {
    Object.assign(metrics, { splitEpisodeState: 3, splitDiveStartY: position.y, splitLowestY: position.y, splitHeightLossM: 0,
      splitPathTurnDegrees: 0, splitPathMaxDegrees: 0, splitTangentObserved: 0, splitReverseTravelM: 0 })
  }
  if (metrics.splitEpisodeState >= 3) {
    if (metrics.splitGeometryFrozen < 0.5) metrics.splitLowestY = Math.min(metrics.splitLowestY, position.y)
    metrics.splitHeightLossM = Math.max(0, metrics.splitDiveStartY - metrics.splitLowestY)
    metrics.splitReverseTravelM += Math.max(0, -forwardSpeed) * delta
    if (Math.hypot(forwardSpeed, motion.verticalSpeedMps) >= 1) {
      const tangent = Math.atan2(-motion.verticalSpeedMps, forwardSpeed) * DEGREES
      if (metrics.splitTangentObserved > 0.5) {
        let change = tangent - metrics.splitPreviousTangentDegrees
        while (change > 180) change -= 360
        while (change < -180) change += 360
        metrics.splitPathTurnDegrees += change
      }
      metrics.splitPreviousTangentDegrees = tangent
      metrics.splitTangentObserved = 1
      metrics.splitPathStallSeconds = 0
      metrics.splitPathMaxDegrees = Math.max(metrics.splitPathMaxDegrees, metrics.splitPathTurnDegrees)
      if (metrics.splitPathMaxDegrees - metrics.splitPathTurnDegrees > 75) return interrupt(8)
    } else {
      metrics.splitTangentObserved = 0
      if (metrics.splitCompleted < 0.5) {
        metrics.splitPathStallSeconds += delta
        if (metrics.splitPathStallSeconds >= 0.75) return interrupt(8)
      }
    }
    if (metrics.splitHeightLossM >= SPLIT_S_MIN_HEIGHT_LOSS_M && motion.verticalSpeedMps <= -1 && metrics.splitPitchProgressDegrees >= 30) metrics.splitDescended = 1
    if (phase === 4 && metrics.splitDescended > 0.5) return advance()
    if (metrics.splitDescended > 0.5 && metrics.splitHeadingChangeDegrees >= 140 && forwardSpeed <= -1
      && metrics.splitReverseTravelM >= SPLIT_S_MIN_REVERSE_TRAVEL_M) metrics.splitReversed = 1
    if (phase === 5 && metrics.splitReversed > 0.5) return advance()
    if (metrics.splitPitchProgressDegrees >= 145 && motion.tiltDegrees <= SPLIT_S_RECOVERY_TILT_DEGREES) {
      metrics.splitGeometryFrozen = 1
      if (metrics.splitHeightLossM < SPLIT_S_MIN_HEIGHT_LOSS_M) return interrupt(8)
    }
    if (metrics.splitInverted > 0.5 && metrics.splitDescended > 0.5 && metrics.splitReversed > 0.5
      && metrics.splitPitchProgressDegrees >= 145 && metrics.splitPitchProgressDegrees <= 225 && metrics.splitPathTurnDegrees >= 100
      && metrics.splitHeadingChangeDegrees >= 140 && forwardSpeed <= -1 && motion.tiltDegrees <= SPLIT_S_RECOVERY_TILT_DEGREES) {
      metrics.splitCompleted = 1
      metrics.splitEpisodeState = 4
    }
    if (phase === 6 && metrics.splitCompleted > 0.5) return advance()
    if (phase === 7 && metrics.splitCompleted > 0.5 && metrics.splitEpisodeValid > 0.5) {
      const recovered = metrics.splitPitchProgressDegrees >= 145 && metrics.splitPitchProgressDegrees <= 225
        && motion.tiltDegrees <= SPLIT_S_RECOVERY_TILT_DEGREES && motion.bodyRateDegreesPerSecond <= 140
        && motion.horizontalSpeedMps <= 15 && motion.verticalSpeedMps >= -4 && motion.verticalSpeedMps <= 5
      metrics.splitRecoveryQualifying = recovered ? 1 : 0
      metrics.splitRecoveryDwellSeconds = recovered && metric(context, 'splitRecoveryQualifying') > 0.5
        ? Math.min(SPLIT_S_HOLD_SECONDS, metric(context, 'splitRecoveryDwellSeconds') + delta) : 0
      if (metrics.splitRecoveryDwellSeconds + 1e-8 >= SPLIT_S_HOLD_SECONDS) return advance()
    } else {
      metrics.splitRecoveryQualifying = 0
      metrics.splitRecoveryDwellSeconds = 0
    }
  }
  return continuing()
}
export const splitSLearningEvaluator: LessonEvaluatorContract = { evaluate: evaluateSplitS }
export const SPLIT_S_LESSON: LessonDefinition = {
  id: 'split-s', priority: 3, title: '翻轉下降', availability: 'available', available: true,
  description: '從地面自行起飛，在足夠高度橫滾半圈至倒置，再後拉俯仰走出下降半迴圈，反轉方向並恢復正飛。',
  objectives: ['自行起飛並保留下降與改出高度。', '依序完成橫滾倒置、下降半迴圈與實際方向反轉。', '朝來路方向改出並恢復空中控制。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', 'split-zone'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'split-ground', title: '地面開始', description: '在起飛區實際接地開始。' },
    { id: 'split-liftoff', title: '自行起飛至下降餘裕高度', description: '自行起飛至至少 15 m，建議約 25 m。' },
    { id: 'split-entry', title: '建立前進速度', description: '至少 3 m/s 前進，姿態在 35° 內短暫準備。' },
    { id: 'split-inverted', title: '橫滾半圈至倒置', description: '選左或右，實際橫滾半圈並翻成倒置，不能以後翻代替。' },
    { id: 'split-descent', title: '拉出下降半迴圈', description: '倒置後沿同一方向後拉俯仰，實際下降至少 3 m。' },
    { id: 'split-reversed', title: '實際反轉飛行方向', description: '機頭轉向來路，實際反向飛行至少 1.5 m。' },
    { id: 'split-upright', title: '拉平恢復正飛', description: '以俯仰走完下降半圈並回到正飛，不用偏航迴轉或反向拼湊。' },
    { id: 'split-recovered', title: '恢復正飛與控制', description: '留在空中，主動修回 35° 內並減緩旋轉與下降，確認 0.2 秒。' },
  ],
  success: { title: '翻轉下降完成', description: '已觀察到連續橫滾倒置、下降半迴圈、反向出口與空中恢復。', criteria: ['地面自行起飛', '先橫滾倒置再俯仰下降', '實際反轉方向及空中改出'] },
  failure: { title: '翻轉下降尚未完成', description: '一般動作中斷可重新取得高度再準備；墜毀、上鎖或無效資料需重試。', criteria: ['不能只偏航轉頭或原地後翻', '不能借用舊動作證據', '地面停住不能代替空中恢復'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['splitRollProgressDegrees', 'splitPitchProgressDegrees', 'splitHeightLossM', 'splitHeadingChangeDegrees', 'splitRecoveryDwellSeconds'] },
  hints: ['先留出約 25 m 高度，橫滾至倒置再後拉，走出下降半迴圈並朝來路改出；本課不要求窄門、原點或降落。'],
  evaluator: splitSLearningEvaluator,
}
export const SPLIT_S_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L14', title: '翻轉下降', level: '花飛進階', prerequisiteIds: ['basic-recovery', 'full-roll', 'front-flip'],
  objectives: ['理解橫滾倒置後的俯仰下降與方向變化。', '自行串接下降半迴圈、方向反轉與空中恢復。'],
  steps: ['從地面自行起飛至至少 15 m，建議約 25 m，留在起飛點半徑 150 m 的空曠區。', '建立至少 3 m/s 前進速度，姿態在 35° 內短暫準備。', '選左或右橫滾半圈，實際翻成倒置；倒置時適度收油。', '向後拉俯仰，讓機頭往地面繞出下降半迴圈，留意高度與油門，不要只原地轉頭。', '持續同方向後拉，讓機頭及實際飛行轉向來路，再提早回中減緩旋轉並補油改出。', '保留至少 1.5 m 高度，主動帶回 35° 內並減緩下降，確認 0.2 秒；不需降落或回原點。'],
  commonMistakes: ['直接後翻或偏航迴轉，沒有先實際橫滾成倒置。', '倒置時維持大油門，或起始高度不夠，讓改出空間迅速縮小。', '只完成機頭反轉，飛行慣性還沒有轉向來路。', '下降時反向翻回，未沿同一俯仰方向走完半迴圈。'],
}
