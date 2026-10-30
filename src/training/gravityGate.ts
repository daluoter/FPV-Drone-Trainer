import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3 } from '../math/vector'
import { findSweptObstacleHit, OBSTACLE_CRASH_WARNING_PREFIX } from '../simulation/obstacles'
import { createGravityGate, gravityGateExitCrossing, gravityGateLowerCrossing, gravityGateTopCrossing, GRAVITY_GATE_TOP_HEIGHT_M } from '../world/gravityGate'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const GRAVITY_GATE_PRACTICE_HEIGHT_M = 8
export const GRAVITY_GATE_MIN_ENTRY_HEIGHT_M = 4
export const GRAVITY_GATE_MIN_HEIGHT_M = 2
export const GRAVITY_GATE_AREA_RADIUS_M = 150
export const GRAVITY_GATE_MIN_FORWARD_SPEED_MPS = 1.5
export const GRAVITY_GATE_MIN_TOSS_SPEED_MPS = 1.2
export const GRAVITY_GATE_MIN_TOSS_GAIN_M = 1
export const GRAVITY_GATE_MIN_ATTITUDE_CHANGE_DEGREES = 8
export const GRAVITY_GATE_MIN_RETURN_SPEED_MPS = 0.5
export const GRAVITY_GATE_RETURN_DISTANCE_M = 0.3
/** A stopped or still-inward lower-level observation is enough; negative speed is not required. */
export const GRAVITY_GATE_RETURN_READY_SPEED_MPS = 0.2
export const GRAVITY_GATE_RECOVERY_SECONDS = 0.2
export const GRAVITY_GATE_TIME_LIMIT_SECONDS = 300
export const GRAVITY_GATE_PHASE_IDS = Object.freeze([
  'gravity-ground', 'gravity-liftoff', 'gravity-forward', 'gravity-tossed',
  'gravity-adjusted', 'gravity-entered', 'gravity-exited', 'gravity-recovered',
] as const)
const DEGREES = 180 / Math.PI
const angle = (dot: number): number => Math.acos(Math.max(-1, Math.min(1, dot))) * DEGREES

export function measureGravityGateMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const nose = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
  const speed = Math.hypot(state.velocityMps.x, state.velocityMps.z)
  const noseLength = Math.hypot(nose.x, nose.z)
  return { tiltDegrees: angle(up.y), upX: up.x, upY: up.y, upZ: up.z,
    horizontalSpeedMps: speed, verticalSpeedMps: state.velocityMps.y,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    gravityGateForwardSpeedMps: -state.velocityMps.x,
    gravityGateReturnSpeedMps: state.velocityMps.x,
    gravityGateHeadingErrorDegrees: speed > 0.1 && noseLength > 0.1
      ? angle((nose.x * state.velocityMps.x + nose.z * state.velocityMps.z) / noseLength / speed) : 180 }
}
function metric(context: TrainingEvaluationContext, key: string): number {
  const value = context.previousEvaluation?.metrics?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function episodeDefaults(): Record<string, number> {
  return {
    gravityGateEpisodeValid: 0, gravityGateInterrupted: 0, gravityGateInterruptionReason: 0,
    gravityGateForwardEstablished: 0, gravityGateTossed: 0, gravityGateAdjusted: 0,
    gravityGateEntered: 0, gravityGateLowerReached: 0, gravityGateReturned: 0, gravityGateExited: 0, gravityGateRecovered: 0,
    gravityGateReturnStartX: 0, gravityGateReturnDistanceM: 0, gravityGateReturnSegmentValid: 0,
    gravityGateReturnReady: 0,
    gravityGatePreparationQualifying: 0, gravityGatePreparationDwellSeconds: 0,
    gravityGateStartHeightM: 0, gravityGateStartUpX: 0, gravityGateStartUpY: 1, gravityGateStartUpZ: 0,
    gravityGateMomentumLostSeconds: 0,
    gravityGateHeightGainM: 0, gravityGatePeakVerticalSpeedMps: 0, gravityGatePeakThrottle: 0,
    gravityGateThrottleCutObserved: 0, gravityGateAttitudeChangeDegrees: 0,
    gravityGateEntryCrossingX: 0, gravityGateEntryCrossingZ: 0,
    gravityGateExitCrossingX: 0, gravityGateExitCrossingY: 0,
    gravityGateRecoveryQualifying: 0, gravityGateRecoveryDwellSeconds: 0,
    interruptionAltitudeM: 0, interruptionLaunchDistanceM: 0, interruptionTiltDegrees: 0,
    interruptionGravityGateTopHeightDifferenceM: 0, interruptionGravityGateEntryHorizontalErrorM: 0,
    interruptionGravityGateEntryForwardErrorM: 0, interruptionGravityGateExitDistanceM: 0,
    interruptionGravityGateLowerHeightDifferenceM: 0, interruptionGravityGateReturnSpeedMps: 0,
    interruptionGravityGateReturnDistanceM: 0,
  }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按「再練一次」，從地面自行起飛後重試重力門。' }
}
function hint(metrics: Readonly<Record<string, number>>): string {
  const phase = metrics.gravityGatePhase
  if (phase === 0) return '先在起飛區實際接地，低油門明確解鎖。'
  if (phase === 1) return `自行起飛至約 ${GRAVITY_GATE_PRACTICE_HEIGHT_M} m，再繞到門框右側的進場點，朝框內建立前速。`
  if (metrics.gravityGateEpisodeValid < 0.5) return `${metrics.gravityGateInterrupted > 0.5 ? '本次路線已中斷；先前勾選保留，但須重新側向前飛、上拋、頂部入框及低層折返。' : ''}到門框右側的進場點，朝左（−X）建立至少 1.5 m/s 的前速，先穩住升降再上拋。`
  if (metrics.gravityGateTossed < 0.5) return `帶前速向上拋，讓飛機實際拉升到水平頂口上方；頂部離地 ${GRAVITY_GATE_TOP_HEIGHT_M} m，建議上拋到約 17～18 m。`
  if (metrics.gravityGateAdjusted < 0.5) return '提早降低上拋時的油門，用橫滾或俯仰微調姿態，觀察升速減少並對準頂部開口；不要求翻滿一圈。'
  if (metrics.gravityGateEntered < 0.5) return `從黃色頂部開口向下落入框內；目前比入口${metrics.gravityGateTopHeightDifferenceM >= 0 ? '高' : '低'} ${Math.abs(metrics.gravityGateTopHeightDifferenceM).toFixed(1)} m，左右偏差 ${metrics.gravityGateEntryHorizontalErrorM.toFixed(1)} m、前後偏差 ${metrics.gravityGateEntryForwardErrorM.toFixed(1)} m。`
  if (metrics.gravityGateLowerReached < 0.5) return '已由水平頂口入框；留在框內向下降到中環以下的低層，再朝來向折返。上層直接側出不能完成。'
  if (metrics.gravityGateReturnReady < 0.5) return '已下降至低層；先在框內減少原方向速度、近乎停住，再向來向折返。不要在上層便反向飛回後直接側出。'
  if (metrics.gravityGateReturned < 0.5) return `已下降至低層；朝右（＋X）飛回來向，實際回程速度至少 ${GRAVITY_GATE_MIN_RETURN_SPEED_MPS} m/s、回程位移至少 ${GRAVITY_GATE_RETURN_DISTANCE_M} m。轉頭本身不能代替反向移動。`
  if (metrics.gravityGateExited < 0.5) return `已在低層反向移動；從來向那側的青色低層出口飛出，還差 ${Math.max(0, metrics.gravityGateExitDistanceM).toFixed(1)} m。`
  if (metrics.gravityGateRecovered < 0.5) return '已由來向那側的低層出口改出；主動修回正飛，減緩下降與旋轉，穩住 0.2 秒；不需要降落。'
  return '已完成側向上拋、頂口落入、框內下降、低層折返與空中恢復。'
}

function evaluateGravityGate(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('重力門停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) {
    const obstacle = sample.state.warnings.find((warning) => warning.startsWith(OBSTACLE_CRASH_WARNING_PREFIX))
    return terminal(obstacle ? `重力門停止：機體已碰撞實體門框。${obstacle}` : '重力門停止：機體已墜毀，請重設後重試。', context.previousEvaluation?.metrics)
  }
  if (sample.armed === false) return terminal('重力門停止：已上鎖或失去焦點。', context.previousEvaluation?.metrics)
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('重力門缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('重力門停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('重力門停止：接地標記與機體支撐高度不一致。')
  const gate = createGravityGate(launch.positionM, surface.positionM.y)
  let phase = 0
  while (phase < GRAVITY_GATE_PHASE_IDS.length && context.checkpoints[GRAVITY_GATE_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureGravityGateMotion(sample.state)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const airborne = !contact.touching && clearance >= 0.15
  const episode = episodeDefaults()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = { ...episode, ...motion, gravityGatePhase: phase,
    altitudeM, groundClearanceM: clearance, launchDistanceM, groundTouching: contact.touching ? 1 : 0,
    targetAltitudeM: GRAVITY_GATE_PRACTICE_HEIGHT_M,
    gravityGateTopHeightDifferenceM: position.y - gate.topY,
    gravityGateEntryHorizontalErrorM: position.x - gate.centerM.x,
    gravityGateEntryForwardErrorM: position.z - gate.centerM.z,
    gravityGateExitDistanceM: gate.exitX - position.x,
    gravityGateLowerHeightDifferenceM: position.y - gate.lowerExitMaxY }
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  if (!previous && metrics.gravityGateEpisodeValid > 0.5) return terminal('重力門停止：缺少連續飛行觀察。', metrics)
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('重力門停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta)
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('重力門停止：位置跳躍與實際速度不一致。', metrics)
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
      rotation.z * factor - (beforeRate.z + rateAfter.z) * 0.5 * delta) * DEGREES
    if (turn * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > 2 + 400 * delta * delta) return terminal('重力門停止：姿態變化與實際旋轉速度不一致。', metrics)
    // Configured body-envelope contact is authoritative in physics before this
    // observer runs. This extra center-line sweep rejects fabricated crossings
    // through a solid beam without assuming any particular custom drone size.
    const hit = findSweptObstacleHit(previous.state.positionM, position, 0, gate.colliders)
    if (hit) return terminal(`重力門停止：路線穿過實體門框。${OBSTACLE_CRASH_WARNING_PREFIX}${hit.colliderId}`, metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > GRAVITY_GATE_TIME_LIMIT_SECONDS) return terminal('重力門挑戰逾時：尚未完成頂部進入、側面飛出與恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: hint(metrics) })
  const interrupt = (reason: number): TrainingEvaluation => {
    if (metrics.gravityGateEpisodeValid < 0.5 && metrics.gravityGateInterrupted > 0.5) return continuing()
    const snapshot = { gravityGateInterrupted: 1, gravityGateInterruptionReason: reason,
      interruptionAltitudeM: altitudeM, interruptionLaunchDistanceM: launchDistanceM, interruptionTiltDegrees: motion.tiltDegrees,
      interruptionGravityGateTopHeightDifferenceM: metrics.gravityGateTopHeightDifferenceM,
      interruptionGravityGateEntryHorizontalErrorM: metrics.gravityGateEntryHorizontalErrorM,
      interruptionGravityGateEntryForwardErrorM: metrics.gravityGateEntryForwardErrorM,
      interruptionGravityGateExitDistanceM: metrics.gravityGateExitDistanceM,
      interruptionGravityGateLowerHeightDifferenceM: metrics.gravityGateLowerHeightDifferenceM,
      interruptionGravityGateReturnSpeedMps: motion.gravityGateReturnSpeedMps,
      interruptionGravityGateReturnDistanceM: metrics.gravityGateReturnDistanceM }
    Object.assign(metrics, episodeDefaults(), snapshot)
    return continuing()
  }
  const advance = (): TrainingEvaluation => {
    const id = GRAVITY_GATE_PHASE_IDS[phase]
    phase += 1
    metrics.gravityGatePhase = phase
    return phase === 8 ? { status: 'success', checkpointIds: [id], score: 100, metrics,
      message: '已自行起飛、側向上拋與收油調姿，由水平頂口落入、下降到低層並折返來向，最後恢復正飛。', hint: hint(metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: hint(metrics) }
  }
  const passageProof = (): boolean => metrics.gravityGateEpisodeValid > 0.5
    && metrics.gravityGateForwardEstablished > 0.5 && metrics.gravityGateTossed > 0.5
    && metrics.gravityGateAdjusted > 0.5 && metrics.gravityGateEntered > 0.5 && metrics.gravityGateLowerReached > 0.5
    && metrics.gravityGateReturnReady > 0.5 && metrics.gravityGateReturned > 0.5 && metrics.gravityGateExited > 0.5
  if (phase >= 8) return passageProof() && metrics.gravityGateRecovered > 0.5
    && metrics.gravityGateRecoveryDwellSeconds + 1e-8 >= GRAVITY_GATE_RECOVERY_SECONDS
    ? { status: 'success', score: 100, metrics, message: '已完成重力門及空中恢復。', hint: hint(metrics) }
    : terminal('重力門停止：缺少同一段上拋、頂部入框、框內下降、低層反向改出及恢復的實際證據。', metrics)
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && altitudeM >= GRAVITY_GATE_MIN_ENTRY_HEIGHT_M && launchDistanceM <= GRAVITY_GATE_AREA_RADIUS_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < GRAVITY_GATE_MIN_HEIGHT_M) return interrupt(2)
  if (launchDistanceM > GRAVITY_GATE_AREA_RADIUS_M) return interrupt(3)
  const throttle = sample.normalizedInput?.throttle
  const validThrottle = typeof throttle === 'number' && Number.isFinite(throttle) && throttle >= 0 && throttle <= 1
  if (metrics.gravityGateEpisodeValid < 0.5) {
    // Establish a separate, level-ish approach after takeoff; lifting directly
    // from the launch pad cannot serve as both takeoff and the toss exercise.
    const prepared = motion.gravityGateForwardSpeedMps >= GRAVITY_GATE_MIN_FORWARD_SPEED_MPS
      && motion.gravityGateHeadingErrorDegrees <= 60 && Math.abs(motion.verticalSpeedMps) <= 1.5
      && position.x > gate.maxX && Math.abs(position.z - gate.centerM.z) <= (gate.maxZ - gate.minZ) / 2 + 3
      && altitudeM >= GRAVITY_GATE_MIN_ENTRY_HEIGHT_M
    metrics.gravityGatePreparationQualifying = prepared ? 1 : 0
    metrics.gravityGatePreparationDwellSeconds = prepared && metric(context, 'gravityGatePreparationQualifying') > 0.5
      ? metrics.gravityGatePreparationDwellSeconds + delta : 0
    if (metrics.gravityGatePreparationDwellSeconds + 1e-8 < 0.1) return continuing()
    Object.assign(metrics, episodeDefaults(), { gravityGateEpisodeValid: 1, gravityGateForwardEstablished: 1,
      gravityGateStartHeightM: position.y, gravityGateStartUpX: motion.upX, gravityGateStartUpY: motion.upY, gravityGateStartUpZ: motion.upZ,
      gravityGatePeakVerticalSpeedMps: motion.verticalSpeedMps, gravityGatePeakThrottle: validThrottle ? throttle : 0 })
    if (phase === 2) return advance()
    return continuing()
  }
  if (metrics.gravityGateTossed < 0.5) {
    metrics.gravityGateMomentumLostSeconds = motion.gravityGateForwardSpeedMps >= 0.5 ? 0 : metrics.gravityGateMomentumLostSeconds + delta
    if (metrics.gravityGateMomentumLostSeconds + 1e-8 >= 0.75) return interrupt(10)
  }
  metrics.gravityGateHeightGainM = Math.max(metrics.gravityGateHeightGainM, position.y - metrics.gravityGateStartHeightM)
  metrics.gravityGatePeakVerticalSpeedMps = Math.max(metrics.gravityGatePeakVerticalSpeedMps, motion.verticalSpeedMps)
  if (validThrottle && metrics.gravityGateAdjusted < 0.5) metrics.gravityGatePeakThrottle = Math.max(metrics.gravityGatePeakThrottle, throttle)
  const attitudeChange = angle(motion.upX * metrics.gravityGateStartUpX + motion.upY * metrics.gravityGateStartUpY + motion.upZ * metrics.gravityGateStartUpZ)
  if (metrics.gravityGateTossed < 0.5 && metrics.gravityGateHeightGainM >= GRAVITY_GATE_MIN_TOSS_GAIN_M
    && motion.verticalSpeedMps >= GRAVITY_GATE_MIN_TOSS_SPEED_MPS && motion.gravityGateForwardSpeedMps >= 0.5) metrics.gravityGateTossed = 1
  if (metrics.gravityGateTossed > 0.5) {
    metrics.gravityGateAttitudeChangeDegrees = Math.max(metrics.gravityGateAttitudeChangeDegrees, attitudeChange)
    const cutLimit = Math.max(0.12, Math.min(0.6, metrics.gravityGatePeakThrottle * 0.85))
    if (validThrottle && metrics.gravityGatePeakThrottle > 0.12 && throttle <= cutLimit) metrics.gravityGateThrottleCutObserved = 1
    if (metrics.gravityGateThrottleCutObserved > 0.5 && metrics.gravityGateAttitudeChangeDegrees >= GRAVITY_GATE_MIN_ATTITUDE_CHANGE_DEGREES
      && metrics.gravityGatePeakVerticalSpeedMps - motion.verticalSpeedMps >= 0.5) metrics.gravityGateAdjusted = 1
  }
  if (previous) {
    const before = previous.state.positionM
    const top = gravityGateTopCrossing(before, position, gate)
    if (metrics.gravityGateEntered < 0.5 && top) {
      if (!top.insideOpening) return interrupt(4)
      if (!(metrics.gravityGateTossed > 0.5 && metrics.gravityGateAdjusted > 0.5)) return interrupt(9)
      metrics.gravityGateEntered = 1
      metrics.gravityGateEntryCrossingX = top.positionM.x - gate.centerM.x
      metrics.gravityGateEntryCrossingZ = top.positionM.z - gate.centerM.z
    }
    const inside = position.x > gate.minX && position.x < gate.maxX && position.z > gate.minZ && position.z < gate.maxZ
      && position.y > gate.bottomY && position.y < gate.topY
    if (metrics.gravityGateEntered < 0.5 && inside) return interrupt(5)
    if (metrics.gravityGateEntered > 0.5 && metrics.gravityGateExited < 0.5) {
      const lower = gravityGateLowerCrossing(before, position, gate)
      if (metrics.gravityGateLowerReached < 0.5 && lower) {
        if (!lower.insideOpening || top && top.fraction >= lower.fraction) return interrupt(11)
        metrics.gravityGateLowerReached = 1
        metrics.gravityGateReturnStartX = lower.positionM.x
        metrics.gravityGateReturnSegmentValid = 1
      }
      const exit = gravityGateExitCrossing(before, position, gate)
      if (exit) {
        // When a single accepted segment crosses both planes, entry must
        // happen first within that segment, never after the side crossing.
        if (!exit.insideOpening || metrics.gravityGateLowerReached < 0.5
          || lower && lower.fraction >= exit.fraction) return interrupt(11)
        if (metrics.gravityGateReturnReady < 0.5 || motion.gravityGateReturnSpeedMps < GRAVITY_GATE_MIN_RETURN_SPEED_MPS) return interrupt(12)
        metrics.gravityGateExited = 1
        metrics.gravityGateExitCrossingX = exit.positionM.x - gate.centerM.x
        metrics.gravityGateExitCrossingY = exit.positionM.y - gate.centerM.y
      } else if (position.x <= gate.minX || position.x >= gate.maxX || position.z <= gate.minZ || position.z >= gate.maxZ
        || position.y <= gate.bottomY || position.y > gate.topY + 0.05) return interrupt(6)
    }
    if (metrics.gravityGateExited > 0.5 && (inside || position.x < gate.exitX - 0.05)) return interrupt(7)
    if (metrics.gravityGateLowerReached > 0.5) {
      // Net displacement from the innermost low-level position proves actual
      // return travel without rewarding repeated back-and-forth pumping. A
      // learner falling close to the return face may finish this short proof
      // just outside the already verified lower opening.
      const atLowerLevel = position.y > gate.lowerExitMinY && position.y <= gate.lowerExitMaxY
      if (atLowerLevel && (inside || metrics.gravityGateExited > 0.5)) {
        if (inside && metrics.gravityGateReturnReady < 0.5
          && motion.gravityGateReturnSpeedMps <= GRAVITY_GATE_RETURN_READY_SPEED_MPS) {
          metrics.gravityGateReturnReady = 1
          metrics.gravityGateReturnStartX = position.x
          metrics.gravityGateReturnDistanceM = 0
          metrics.gravityGateReturnSegmentValid = 1
        }
        if (metrics.gravityGateReturnSegmentValid < 0.5) {
          metrics.gravityGateReturnStartX = position.x
          metrics.gravityGateReturnDistanceM = 0
          metrics.gravityGateReturnSegmentValid = 1
        } else {
          metrics.gravityGateReturnStartX = Math.min(metrics.gravityGateReturnStartX, position.x)
          metrics.gravityGateReturnDistanceM = Math.max(0, position.x - metrics.gravityGateReturnStartX)
        }
        if (metrics.gravityGateReturnReady > 0.5 && motion.gravityGateReturnSpeedMps >= GRAVITY_GATE_MIN_RETURN_SPEED_MPS
          && metrics.gravityGateReturnDistanceM + 1e-8 >= GRAVITY_GATE_RETURN_DISTANCE_M) metrics.gravityGateReturned = 1
      } else if (metrics.gravityGateReturned < 0.5) {
        metrics.gravityGateReturnSegmentValid = 0
        metrics.gravityGateReturnDistanceM = 0
        metrics.gravityGateReturnReady = 0
      }
    }
  }
  const recovered = passageProof() && position.x >= gate.exitX && motion.tiltDegrees <= 45
    && motion.bodyRateDegreesPerSecond <= 180 && motion.verticalSpeedMps >= -6 && motion.verticalSpeedMps <= 6
    && motion.horizontalSpeedMps <= 25
  metrics.gravityGateRecoveryQualifying = recovered ? 1 : 0
  metrics.gravityGateRecoveryDwellSeconds = recovered && metric(context, 'gravityGateRecoveryQualifying') > 0.5
    ? metrics.gravityGateRecoveryDwellSeconds + delta : 0
  if (metrics.gravityGateRecoveryDwellSeconds + 1e-8 >= GRAVITY_GATE_RECOVERY_SECONDS) metrics.gravityGateRecovered = 1
  const milestoneKeys = ['gravityGateForwardEstablished', 'gravityGateTossed', 'gravityGateAdjusted', 'gravityGateEntered', 'gravityGateExited', 'gravityGateRecovered']
  if (phase >= 2 && phase <= 7 && metrics[milestoneKeys[phase - 2]] > 0.5
    && (phase !== 6 || metrics.gravityGateReturned > 0.5)) return advance()
  return continuing()
}

export const gravityGateEvaluator: LessonEvaluatorContract = { evaluate: evaluateGravityGate }
export const GRAVITY_GATE_LESSON: LessonDefinition = {
  id: 'gravity-gate', priority: 18, title: '重力門', availability: 'available', available: true,
  description: '從地面起飛，繞到門框側邊帶速上拋，從水平頂口落入；下降到低層後折返，從來向那側飛出並恢復控制。',
  objectives: ['辨認黃色水平頂口、兩層中環、青色低層返出口及實體門框。', '由側邊前飛上拋，收油調姿；實際從頂口落入、框內下降，再反向從低層同側飛出。', '保留改出高度，不要求翻滿一圈、緊貼門框或精準停點。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', 'gravity-gate-frame'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'gravity-ground', title: '地面開始', description: '在起飛區實際接地，明確解鎖後自行起飛。' },
    { id: 'gravity-liftoff', title: '自行起飛至進場高度', description: '至少離地 4 m，建議約 8 m，繞到門框側邊進場點，留出上拋空間。' },
    { id: 'gravity-forward', title: '側邊建立前進速度', description: '從門框右側朝左（−X）飛至少 1.5 m/s，升降平穩約 0.1 秒。' },
    { id: 'gravity-tossed', title: '帶速向上拋', description: '前飛之後實際上升至少 1 m，升速至少 1.2 m/s，再取得頂部開口上方的高度。' },
    { id: 'gravity-adjusted', title: '收油並調整姿態', description: '降低上拋油門，實際用橫滾或俯仰調姿，觀察升速減少後對準頂部開口。' },
    { id: 'gravity-entered', title: '從頂部向下入框', description: '由上往下實際穿過黃色頂部開口，機體避開實體門框。' },
    { id: 'gravity-exited', title: '下降至低層並折返側出', description: '在框內穿過中環下降到低層，再向來向（＋X）實際飛回，從青色低層出口改出。' },
    { id: 'gravity-recovered', title: '恢復正飛與控制', description: '離框後修平機體，穩住升降與旋轉 0.2 秒，不需要降落。' },
  ],
  success: { title: '重力門完成', description: '已觀察到同一次側向上拋、水平頂口落入、框內下降、低層折返來向與恢復。', criteria: ['地面自行起飛', '先前飛再上拋與調姿', '框內下降至低層後反向從來向側面飛出', '未碰框並恢復正飛'] },
  failure: { title: '重力門尚未完成', description: '漏門可重新前飛上拋；碰框墜毀、上鎖或資料無效需要重設重試。', criteria: ['側面直接穿越不算水平頂口進入', '只掠過頂部、上層側出或未反向改出不算', '不能拼接中斷或重設前後的進出證據'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['gravityGateTopHeightDifferenceM', 'gravityGateEntryHorizontalErrorM', 'gravityGateEntryForwardErrorM', 'gravityGateExitDistanceM', 'gravityGateReturnSpeedMps', 'gravityGateReturnDistanceM', 'gravityGateRecoveryDwellSeconds'] },
  hints: [`先起飛至約 ${GRAVITY_GATE_PRACTICE_HEIGHT_M} m，繞到右側進場點，再朝框內上拋至約 17～18 m。水平頂口離地 ${GRAVITY_GATE_TOP_HEIGHT_M} m；黃色頂口落入，穿過中環下降到低層後，從來向那側的青色出口反向改出。`], evaluator: gravityGateEvaluator,
}
export const GRAVITY_GATE_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L19', title: '重力門', level: '近障礙花飛', prerequisiteIds: ['wide-gate', 'basic-recovery', 'full-roll'],
  objectives: ['從側邊帶速上拋取得水平頂口上方的空間，練習收油及調姿。', '辨認兩層門與反向路線，依序完成頂口落入、框內下降、低層同側折返。'],
  steps: ['從地面自行起飛至約 8 m，先繞到門框右側的進場點，認清黃色水平頂口與青色低層返出口。', '朝框內（−X）建立平穩前速，再帶速上拋至約 17～18 m，讓路線越過 14 m 高的水平頂口。', '提前降低上拋油門，以橫滾或俯仰調整姿態，對準寬 8 m、深 8 m 的水平頂口，實際向下落入。', '留在框內穿過中環下降至低層，再朝來向（＋X）真正反向移動；轉頭本身不能代替折返。', '從來向那側的青色低層出口飛出後回正，穩住升降與旋轉 0.2 秒；不要求降落、完整八字或固定翻轉圈數。'],
  commonMistakes: ['從側門直接穿過，沒有由水平頂口向下落入。', '進框後仍在上層便側出，或保持原方向從另一側直出。', '在框外先下降再從低層繞入，借用先前頂入勾選代替完整連續路線。', '只把機頭轉向，實際移動仍未反向；應觀察回程速度與位置變化。'],
}
