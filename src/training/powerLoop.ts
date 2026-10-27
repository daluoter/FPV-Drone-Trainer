import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const POWER_LOOP_TARGET_HEIGHT_M = 25
export const POWER_LOOP_MIN_ENTRY_HEIGHT_M = 6
export const POWER_LOOP_MIN_PREPARATION_HEIGHT_M = POWER_LOOP_MIN_ENTRY_HEIGHT_M
export const POWER_LOOP_MIN_HEIGHT_M = 1.5
export const POWER_LOOP_AREA_RADIUS_M = 120
export const POWER_LOOP_MIN_ENTRY_SPEED_MPS = 3
export const POWER_LOOP_MIN_HEIGHT_GAIN_M = 3
export const POWER_LOOP_MIN_FORWARD_SPAN_M = 6
export const POWER_LOOP_MIN_REVERSE_TRAVEL_M = 1.5
export const POWER_LOOP_COMPLETION_DEGREES = 325
export const POWER_LOOP_HOLD_SECONDS = 0.2
export const POWER_LOOP_RECOVERY_TILT_DEGREES = 35
export const POWER_LOOP_TIME_LIMIT_SECONDS = 300
export const POWER_LOOP_PHASE_IDS = Object.freeze([
  'loop-ground', 'loop-liftoff', 'loop-entry', 'loop-climb', 'loop-inverted', 'loop-descent', 'loop-exit', 'loop-recovered',
] as const)
const DEGREES = 180 / Math.PI

/** Instruments measure the flight, never stick position. Nose-up body +X is positive. */
export function measurePowerLoopMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  return {
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    loopRateDegreesPerSecond: state.angularVelocityBodyRadPerSec.x * DEGREES,
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
    loopEpisodeState: 0, loopEpisodeValid: 0, loopInterrupted: 0, loopInterruptionReason: 0,
    loopSignedDegrees: 0, loopMeasuredRateDegrees: 0, loopProgressDegrees: 0, loopMaxProgressDegrees: 0, loopOffAxisDegrees: 0,
    loopClimbed: 0, loopInverted: 0, loopDescended: 0, loopCompleted: 0, loopGeometryFrozen: 0,
    loopStartX: 0, loopStartY: 0, loopStartZ: 0, loopForwardX: 0, loopForwardZ: -1,
    loopPeakY: 0, loopMinForwardM: 0, loopMaxForwardM: 0, loopHeightGainM: 0, loopForwardSpanM: 0,
    loopReverseTravelM: 0, loopPathTurnDegrees: 0, loopPreviousTangentDegrees: 0, loopTangentObserved: 0, loopPathStallSeconds: 0, loopMaxPathTurnDegrees: 0,
    loopPreparationQualifying: 0, loopPreparationDwellSeconds: 0, loopRecoveryQualifying: 0, loopRecoveryDwellSeconds: 0,
    interruptionAltitudeM: 0, interruptionLoopProgressDegrees: 0, interruptionHeightGainM: 0,
    interruptionForwardSpanM: 0, interruptionReverseTravelM: 0, interruptionLaunchDistanceM: 0,
  }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按再練一次，從地面自行起飛後重試本次大迴旋。' }
}
function hint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase >= 8) return '已完成實際垂直迴圈並恢復正飛與控制；不需降落，可以上鎖停止馬達。'
  if (phase === 0) return '請先在起飛區實際接地開始。'
  if (phase === 1) return `先自行起飛至建議約 ${POWER_LOOP_TARGET_HEIGHT_M} m，為下降與改出保留高度；最低有效高度仍為 6 m。`
  if (metrics.loopEpisodeValid < 0.5) return `${metrics.loopInterruptionReason === 9 ? '本圈實際前後跨度不足 6 m，已清除本圈證據；直線飛遠不會補成大迴旋。' : metrics.loopInterrupted > 0.5 ? '本圈已中斷，先前步驟保留；需重新完成同一整圈。' : ''}建議先升至約 ${POWER_LOOP_TARGET_HEIGHT_M} m，再建立前進速度（至少 3 m/s），姿態帶回 35° 內，短暫準備；最低有效高度仍為 6 m。`
  if (metrics.loopClimbed < 0.5) return `${metrics.loopEpisodeState === 1 && metrics.altitudeM < POWER_LOOP_TARGET_HEIGHT_M - 1 ? `高度仍低於建議約 ${POWER_LOOP_TARGET_HEIGHT_M} m，先升高並穩住，再開始拉起。` : ''}帶著前進速度，適量加油並持續向後拉俯仰，讓航跡實際向上彎；不要原地快速後翻。`
  if (metrics.loopInverted < 0.5) return '保持同一俯仰方向越過頂部；倒置時適度收油，讓機體往後方繞回。'
  if (metrics.loopDescended < 0.5) return '已越過頂部，繼續同一圈並往下繞回；需要實際後退航段與下降，不能只在空中翻一圈。'
  if (metrics.loopCompleted < 0.5) return '繼續拉回正飛，隨姿態補回油門，建立向前出口；不用飛出完美圓形或回到原點。'
  return '已完成迴圈；留在空中，回中減緩旋轉，修回 35° 內並減緩下降，保持 0.2 秒。'
}

function evaluatePowerLoop(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('大迴旋停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('大迴旋停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('大迴旋停止：已上鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('大迴旋缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('大迴旋停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('大迴旋停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < POWER_LOOP_PHASE_IDS.length && context.checkpoints[POWER_LOOP_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measurePowerLoopMotion(sample.state)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const inside = launchDistanceM <= POWER_LOOP_AREA_RADIUS_M
  const airborne = !contact.touching && clearance >= 0.15
  const episode = emptyEpisode()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = { ...episode, ...motion, loopPhase: phase, altitudeM, groundClearanceM: clearance,
    launchDistanceM, insideLoopArea: inside ? 1 : 0, groundTouching: contact.touching ? 1 : 0, targetAltitudeM: POWER_LOOP_TARGET_HEIGHT_M }
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  let pitchDegrees = 0
  let measuredPitchDegrees = 0
  let offAxisDegrees = 0
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('大迴旋停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('大迴旋停止：位置跳躍與實際速度不一致。', metrics)
    let rotation = normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(normalizeQuaternion(previous.state.orientation)), normalizeQuaternion(sample.state.orientation)))
    if (rotation.w < 0) rotation = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: -rotation.w }
    const sine = Math.hypot(rotation.x, rotation.y, rotation.z)
    const angle = 2 * Math.atan2(sine, Math.max(0, rotation.w))
    const factor = sine > 1e-10 ? angle / sine : 2
    pitchDegrees = rotation.x * factor * DEGREES
    offAxisDegrees = Math.hypot(rotation.y, rotation.z) * factor * DEGREES
    const rateAfter = rotateVectorByQuaternion(rotation, sample.state.angularVelocityBodyRadPerSec)
    const rateBefore = previous.state.angularVelocityBodyRadPerSec
    measuredPitchDegrees = (rateBefore.x + rateAfter.x) * 0.5 * delta * DEGREES
    metrics.angularConsistencyErrorDegrees = Math.hypot(
      rotation.x * factor - (rateBefore.x + rateAfter.x) * 0.5 * delta,
      rotation.y * factor - (rateBefore.y + rateAfter.y) * 0.5 * delta,
      rotation.z * factor - (rateBefore.z + rateAfter.z) * 0.5 * delta,
    ) * DEGREES
    metrics.angularToleranceDegrees = 2 + 400 * delta * delta
    if (angle * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > metrics.angularToleranceDegrees) return terminal('大迴旋停止：姿態變化與實際旋轉速度不一致。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > POWER_LOOP_TIME_LIMIT_SECONDS) return terminal('大迴旋挑戰逾時：尚未完成迴圈與空中恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: hint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = POWER_LOOP_PHASE_IDS[phase]
    phase += 1
    metrics.loopPhase = phase
    return phase >= 8 ? { status: 'success', checkpointIds: [id], score: 100, metrics,
      message: '已從地面自行起飛，完成實際大迴旋並恢復正飛與控制。', hint: hint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: hint(phase, metrics) }
  }
  // Reasons: 1 ground, 2 low, 3 outside, 4 off-axis, 5 overrotation,
  // 6 opposite/backtracking turn, 7 lost height before starting the climb,
  // 8 interrupted/reversed spatial path, 9 insufficient actual loop span.
  const interrupt = (reason: number): TrainingEvaluation => {
    const snapshot = { loopInterrupted: 1, loopInterruptionReason: reason, interruptionAltitudeM: altitudeM,
      interruptionLoopProgressDegrees: metrics.loopProgressDegrees, interruptionHeightGainM: metrics.loopHeightGainM,
      interruptionForwardSpanM: metrics.loopForwardSpanM, interruptionReverseTravelM: metrics.loopReverseTravelM,
      interruptionLaunchDistanceM: launchDistanceM }
    Object.assign(metrics, emptyEpisode(), snapshot)
    return continuing()
  }
  if (phase >= 8) return metrics.loopEpisodeValid > 0.5 && metrics.loopCompleted > 0.5 && metrics.loopInverted > 0.5 && metrics.loopDescended > 0.5
    ? { status: 'success', score: 100, metrics, message: '已完成大迴旋與空中恢復。', hint: hint(phase, metrics) }
    : terminal('大迴旋停止：缺少同一整圈的實際飛行證據，請重新開始。', metrics)
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && inside && altitudeM >= POWER_LOOP_MIN_ENTRY_HEIGHT_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < POWER_LOOP_MIN_HEIGHT_M) return interrupt(2)
  if (!inside) return interrupt(3)
  if (metrics.loopEpisodeState === 0) {
    const forward = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 0, z: -1 })
    const norm = Math.hypot(forward.x, forward.z)
    const forwardSpeed = norm > 0.1 ? (sample.state.velocityMps.x * forward.x + sample.state.velocityMps.z * forward.z) / norm : 0
    metrics.loopForwardSpeedMps = forwardSpeed
    const prepared = altitudeM >= POWER_LOOP_MIN_ENTRY_HEIGHT_M && motion.tiltDegrees <= 35 && motion.bodyRateDegreesPerSecond <= 120
      && forwardSpeed >= POWER_LOOP_MIN_ENTRY_SPEED_MPS && Math.abs(motion.verticalSpeedMps) <= 4
    metrics.loopPreparationQualifying = prepared ? 1 : 0
    metrics.loopPreparationDwellSeconds = prepared && metric(context, 'loopPreparationQualifying') > 0.5
      ? Math.min(0.1, metric(context, 'loopPreparationDwellSeconds') + delta) : 0
    if (metrics.loopPreparationDwellSeconds + 1e-8 >= 0.1) {
      Object.assign(metrics, { loopEpisodeState: 1, loopEpisodeValid: 1, loopInterrupted: 0, loopInterruptionReason: 0,
        loopStartX: position.x, loopStartY: position.y, loopStartZ: position.z, loopPeakY: position.y,
        loopForwardX: forward.x / norm, loopForwardZ: forward.z / norm })
      if (phase === 2) return advance()
    }
    return continuing()
  }
  metrics.loopSignedDegrees += pitchDegrees
  metrics.loopMeasuredRateDegrees += measuredPitchDegrees
  metrics.loopRateConsistencyErrorDegrees = Math.abs(metrics.loopSignedDegrees - metrics.loopMeasuredRateDegrees)
  if (metrics.loopRateConsistencyErrorDegrees > 12) return terminal('大迴旋停止：累積姿態變化與實際俯仰速度不一致。', metrics)
  metrics.loopOffAxisDegrees += offAxisDegrees
  metrics.loopProgressDegrees = Math.max(0, metrics.loopSignedDegrees)
  metrics.loopMaxProgressDegrees = Math.max(metrics.loopMaxProgressDegrees, metrics.loopProgressDegrees)
  if (metrics.loopOffAxisDegrees > 150) return interrupt(4)
  if (metrics.loopSignedDegrees > 450) return interrupt(5)
  if (metrics.loopSignedDegrees < -45 || metrics.loopEpisodeState >= 2 && (metrics.loopSignedDegrees < -20
    || metrics.loopMaxProgressDegrees - metrics.loopSignedDegrees > 45)) return interrupt(6)
  if (metrics.loopEpisodeState === 1 && altitudeM < POWER_LOOP_MIN_ENTRY_HEIGHT_M - 1) return interrupt(7)
  if (metrics.loopEpisodeState === 1 && metrics.loopSignedDegrees >= 15 && motion.verticalSpeedMps > 0.5) {
    // The straight run-up is entry preparation, not part of the spatial loop.
    // Rebase geometry and tangent proof at the observed upward pull; keep the
    // independently measured body rotation and entry direction unchanged.
    Object.assign(metrics, { loopEpisodeState: 2, loopStartX: position.x, loopStartY: position.y, loopStartZ: position.z,
      loopPeakY: position.y, loopMinForwardM: 0, loopMaxForwardM: 0, loopHeightGainM: 0, loopForwardSpanM: 0,
      loopReverseTravelM: 0, loopPathTurnDegrees: 0, loopMaxPathTurnDegrees: 0, loopTangentObserved: 0 })
  }
  const forwardM = (position.x - metrics.loopStartX) * metrics.loopForwardX + (position.z - metrics.loopStartZ) * metrics.loopForwardZ
  const forwardSpeed = sample.state.velocityMps.x * metrics.loopForwardX + sample.state.velocityMps.z * metrics.loopForwardZ
  metrics.loopForwardSpeedMps = forwardSpeed
  if (metrics.loopEpisodeState >= 2 && metrics.loopGeometryFrozen < 0.5) {
    metrics.loopPeakY = Math.max(metrics.loopPeakY, position.y)
    metrics.loopMinForwardM = Math.min(metrics.loopMinForwardM, forwardM)
    metrics.loopMaxForwardM = Math.max(metrics.loopMaxForwardM, forwardM)
  }
  metrics.loopHeightGainM = Math.max(0, metrics.loopPeakY - metrics.loopStartY)
  metrics.loopForwardSpanM = metrics.loopMaxForwardM - metrics.loopMinForwardM
  if (metrics.loopEpisodeState >= 2) metrics.loopReverseTravelM += Math.max(0, -forwardSpeed) * delta
  // A useful measured path instrument, independent of the required body turn.
  if (Math.hypot(forwardSpeed, motion.verticalSpeedMps) >= 1) {
    metrics.loopPathStallSeconds = 0
    const tangent = Math.atan2(motion.verticalSpeedMps, forwardSpeed) * DEGREES
    if (metrics.loopTangentObserved > 0.5) {
      let change = tangent - metrics.loopPreviousTangentDegrees
      while (change > 180) change -= 360
      while (change < -180) change += 360
      metrics.loopPathTurnDegrees += change
    }
    metrics.loopPreviousTangentDegrees = tangent
    metrics.loopTangentObserved = 1
    metrics.loopMaxPathTurnDegrees = Math.max(metrics.loopMaxPathTurnDegrees, metrics.loopPathTurnDegrees)
    if (metrics.loopEpisodeState >= 2 && metrics.loopMaxPathTurnDegrees - metrics.loopPathTurnDegrees > 75) return interrupt(8)
  } else {
    // Keep earned spatial turn through a brief crest pause, but never bridge
    // the gap: the next measured heading starts a fresh segment. Unobserved
    // turn contributes nothing. A prolonged stop requires a new whole loop.
    metrics.loopTangentObserved = 0
    if (metrics.loopEpisodeState >= 2 && metrics.loopCompleted < 0.5) {
      metrics.loopPathStallSeconds += delta
      if (metrics.loopPathStallSeconds >= 0.75) return interrupt(8)
    }
  }
  if (metrics.loopEpisodeState >= 2 && metrics.loopHeightGainM >= POWER_LOOP_MIN_HEIGHT_GAIN_M && metrics.loopSignedDegrees >= 30
    && motion.verticalSpeedMps >= 0.5) metrics.loopClimbed = 1
  if (phase === 3 && metrics.loopClimbed > 0.5) return advance()
  if (metrics.loopClimbed > 0.5 && metrics.loopSignedDegrees >= 110 && metrics.loopSignedDegrees <= 260 && motion.tiltDegrees >= 140) metrics.loopInverted = 1
  if (phase === 4 && metrics.loopInverted > 0.5) return advance()
  if (metrics.loopInverted > 0.5 && metrics.loopPeakY - position.y >= 2 && motion.verticalSpeedMps <= -1
    && metrics.loopReverseTravelM >= POWER_LOOP_MIN_REVERSE_TRAVEL_M) metrics.loopDescended = 1
  if (phase === 5 && metrics.loopDescended > 0.5) return advance()
  // Once the actual body turn returns to upright, straight exit travel cannot
  // inflate a small loop into the required span.
  if (metrics.loopDescended > 0.5 && metrics.loopSignedDegrees >= POWER_LOOP_COMPLETION_DEGREES
    && motion.tiltDegrees <= POWER_LOOP_RECOVERY_TILT_DEGREES) {
    metrics.loopGeometryFrozen = 1
    if (metrics.loopForwardSpanM < POWER_LOOP_MIN_FORWARD_SPAN_M) return interrupt(9)
  }
  if (metrics.loopDescended > 0.5 && metrics.loopSignedDegrees >= POWER_LOOP_COMPLETION_DEGREES && metrics.loopSignedDegrees <= 415
    && metrics.loopHeightGainM >= POWER_LOOP_MIN_HEIGHT_GAIN_M && metrics.loopForwardSpanM >= POWER_LOOP_MIN_FORWARD_SPAN_M
    && metrics.loopPathTurnDegrees >= 270 && forwardSpeed >= 1 && motion.tiltDegrees <= POWER_LOOP_RECOVERY_TILT_DEGREES) metrics.loopCompleted = 1
  if (phase === 6 && metrics.loopCompleted > 0.5) return advance()
  if (phase === 7 && metrics.loopEpisodeValid > 0.5 && metrics.loopCompleted > 0.5 && metrics.loopClimbed > 0.5
    && metrics.loopInverted > 0.5 && metrics.loopDescended > 0.5) {
    const recovered = metrics.loopSignedDegrees >= POWER_LOOP_COMPLETION_DEGREES && metrics.loopSignedDegrees <= 415
      && motion.tiltDegrees <= POWER_LOOP_RECOVERY_TILT_DEGREES && motion.bodyRateDegreesPerSecond <= 140
      && motion.horizontalSpeedMps <= 15 && motion.verticalSpeedMps >= -4 && motion.verticalSpeedMps <= 5
    metrics.loopRecoveryQualifying = recovered ? 1 : 0
    metrics.loopRecoveryDwellSeconds = recovered && metric(context, 'loopRecoveryQualifying') > 0.5
      ? Math.min(POWER_LOOP_HOLD_SECONDS, metric(context, 'loopRecoveryDwellSeconds') + delta) : 0
    if (metrics.loopRecoveryDwellSeconds + 1e-8 >= POWER_LOOP_HOLD_SECONDS) return advance()
  } else {
    metrics.loopRecoveryQualifying = 0
    metrics.loopRecoveryDwellSeconds = 0
  }
  return continuing()
}

export const powerLoopEvaluator: LessonEvaluatorContract = { evaluate: evaluatePowerLoop }
export const POWER_LOOP_LESSON: LessonDefinition = {
  id: 'power-loop', priority: 2.98, title: '大迴旋', availability: 'available', available: true,
  description: '從地面自行起飛，帶著前進速度向上拉出大範圍垂直迴圈，越頂、下降後恢復正飛。',
  objectives: ['自行起飛並建立前進速度。', '實際飛出爬升、越頂、後退與下降的垂直迴圈。', '完成同一圈後恢復正飛與控制。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', 'loop-zone'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'loop-ground', title: '地面開始', description: '在起飛區實際接地開始。' },
    { id: 'loop-liftoff', title: '自行起飛至練習高度', description: `先起飛至建議約 ${POWER_LOOP_TARGET_HEIGHT_M} m，預留改出空間；最低有效高度為 6 m。` },
    { id: 'loop-entry', title: '建立前進速度', description: `建議在約 ${POWER_LOOP_TARGET_HEIGHT_M} m 高度建立至少 3 m/s 前進速度，姿態在 35° 內短暫準備。` },
    { id: 'loop-climb', title: '向上拉出迴圈', description: '帶著前進速度向上拉，實際爬升至少 3 m。' },
    { id: 'loop-inverted', title: '越頂通過倒置', description: '沿同一俯仰方向越頂，實際通過倒置。' },
    { id: 'loop-descent', title: '繞回下降', description: '實際往後方繞回至少 1.5 m，越頂後下降至少 2 m。' },
    { id: 'loop-exit', title: '完成迴圈並向前改出', description: '同一圈累積俯仰至少 325°，前後跨度至少 6 m，回到正飛向前改出。' },
    { id: 'loop-recovered', title: '恢復正飛與控制', description: '留在空中，修回 35° 內並減緩旋轉與下降，短暫確認 0.2 秒。' },
  ],
  success: { title: '大迴旋完成', description: '已觀察到實際垂直迴圈與空中恢復。', criteria: ['地面自行起飛', '同一圈爬升、倒置、後退與下降', '向前改出並恢復控制'] },
  failure: { title: '大迴旋尚未完成', description: '一般動作中斷可重新準備；墜毀、上鎖或無效資料需重試。', criteria: ['不能用原地後翻或只上下移動代替', '中斷後需重新完成同一整圈', '接地停住不能代替空中恢復'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['loopProgressDegrees', 'loopHeightGainM', 'loopForwardSpanM', 'loopRecoveryDwellSeconds'] },
  hints: [`建議先升至約 ${POWER_LOOP_TARGET_HEIGHT_M} m，再建立前進速度並拉出大範圍垂直迴圈；本課先練空曠場地，不要求繞過障礙物或飛出完美圓形。`],
  evaluator: powerLoopEvaluator,
}
export const POWER_LOOP_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L13', title: '大迴旋', level: '花飛入門', prerequisiteIds: ['back-flip'],
  objectives: ['分辨實際垂直迴圈與原地後翻。', '連續完成入彎、爬升、越頂、下降與改出。'],
  steps: [`先自行起飛至建議約 ${POWER_LOOP_TARGET_HEIGHT_M} m，為下降與改出保留空間；最低有效高度仍為 6 m，留在起飛點周圍 120 m 空曠練習區。`, '建立至少 3 m/s 前進速度，姿態在 35° 內短暫準備。', '適量加油並向後拉俯仰，帶著速度實際向上繞出迴圈，爬升至少 3 m。', '保持同一方向越過頂部，倒置時適度收油，讓機體往後方繞回並下降。', '接近正飛時提早回中減緩旋轉，補回油門向前改出；本圈需有至少 6 m 前後跨度。', '保留至少 1.5 m 高度，在 35° 內減緩旋轉與下降，確認 0.2 秒；不需降落、回原點或飛出完美圓形。'],
  commonMistakes: ['前進速度不足，原地快速後翻；姿態翻一圈不代表航跡完成大迴旋。', '只往上拉後原路下降，沒有越頂往後繞回。', '越頂後改向前翻，沒有沿同一方向完成整圈。', '倒置時維持大油門或改出太晚，迅速掉高。'],
}
