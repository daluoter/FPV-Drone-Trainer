import { DEFAULT_FPV_MOUNT_POSITION_M, DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, quaternionFromRotationVector, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const REVERSE_ORBIT_TARGET_HEIGHT_M = 45
export const REVERSE_ORBIT_FLIGHT_HEIGHT_M = REVERSE_ORBIT_TARGET_HEIGHT_M / 2
export const REVERSE_ORBIT_TARGET_RADIUS_M = 10
export const REVERSE_ORBIT_MIN_RADIUS_M = 4
export const REVERSE_ORBIT_MAX_RADIUS_M = 30
export const REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M = 4
export const REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M = 30
export const REVERSE_ORBIT_MIN_HEIGHT_M = 1.5
export const REVERSE_ORBIT_AREA_RADIUS_M = 150
export const REVERSE_ORBIT_MIN_TANGENTIAL_SPEED_MPS = 0.75
export const REVERSE_ORBIT_MIN_VIEW_ELEVATION_DEGREES = 35
export const REVERSE_ORBIT_MAX_TILT_DEGREES = 85
export const REVERSE_ORBIT_REQUIRED_LAPS = 3
export const REVERSE_ORBIT_COMPLETION_DEGREES = REVERSE_ORBIT_REQUIRED_LAPS * 360
export const REVERSE_ORBIT_EXIT_DISTANCE_M = 3
export const REVERSE_ORBIT_EXIT_MIN_SPEED_MPS = 0.5
export const REVERSE_ORBIT_HOLD_SECONDS = 0.2
export const REVERSE_ORBIT_TIME_LIMIT_SECONDS = 300
export const REVERSE_ORBIT_PHASE_IDS = Object.freeze([
  'reverse-orbit-ground', 'reverse-orbit-liftoff', 'reverse-orbit-entry', 'reverse-orbit-lap-1', 'reverse-orbit-lap-2', 'reverse-orbit-lap-3', 'reverse-orbit-recovered',
] as const)
const DEGREES = 180 / Math.PI

/** High central crane structure, measured independently of the ground launch. */
export function createReverseOrbitTarget(launchPositionM: Vector3, groundHeightM: number): Vector3 {
  return { x: launchPositionM.x, y: groundHeightM + REVERSE_ORBIT_TARGET_HEIGHT_M, z: launchPositionM.z - 30 }
}

export function measureReverseOrbitMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  return {
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    horizontalSpeedMps: Math.hypot(state.velocityMps.x, state.velocityMps.z),
    verticalSpeedMps: state.velocityMps.y,
  }
}

/** Rigid FPV sightline, using the same mount and rotation order as rendering. */
export function measureReverseOrbitView(
  state: Pick<DroneState, 'positionM' | 'orientation'>,
  target: Vector3,
  camera: { readonly fpvMountAngleDegrees: number; readonly fpvFovDegrees: number },
) {
  const mount = quaternionFromRotationVector({ x: camera.fpvMountAngleDegrees / DEGREES, y: 0, z: 0 })
  const orientation = multiplyQuaternions(normalizeQuaternion(state.orientation), mount)
  const forward = rotateVectorByQuaternion(orientation, { x: 0, y: 0, z: -1 })
  const offset = rotateVectorByQuaternion(state.orientation, DEFAULT_FPV_MOUNT_POSITION_M)
  const dx = target.x - state.positionM.x - offset.x
  const dy = target.y - state.positionM.y - offset.y
  const dz = target.z - state.positionM.z - offset.z
  const distance = Math.hypot(dx, dy, dz)
  const error = distance > 1e-9 ? Math.acos(Math.max(-1, Math.min(1,
    (forward.x * dx + forward.y * dy + forward.z * dz) / distance))) * DEGREES : 180
  return {
    reverseOrbitViewElevationDegrees: Math.asin(Math.max(-1, Math.min(1, forward.y))) * DEGREES,
    reverseOrbitTargetViewErrorDegrees: error,
    reverseOrbitViewLimitDegrees: camera.fpvFovDegrees / 2,
    reverseOrbitViewMarginDegrees: camera.fpvFovDegrees / 2 - error,
    reverseOrbitTargetDistanceM: distance,
  }
}

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function episodeDefaults(): Record<string, number> {
  return {
    reverseOrbitEpisodeValid: 0, reverseOrbitInterrupted: 0, reverseOrbitInterruptionReason: 0,
    reverseOrbitDirection: 0, reverseOrbitSignedDegrees: 0, reverseOrbitProgressDegrees: 0, reverseOrbitMaxProgressDegrees: 0,
    reverseOrbitCompleted: 0, reverseOrbitCompletedLaps: 0, reverseOrbitCurrentLap: 1, reverseOrbitInvalidSeconds: 0, reverseOrbitAngleObserved: 0, reverseOrbitLastAngleRad: 0,
    reverseOrbitPreparationQualifying: 0, reverseOrbitPreparationDwellSeconds: 0,
    reverseOrbitRecoveryQualifying: 0, reverseOrbitRecoveryDwellSeconds: 0, reverseOrbitExitQualifying: 0, reverseOrbitLapAngularSpeedRadPerSec: 0,
    reverseOrbitCompletionRadiusM: 0, reverseOrbitExitDistanceM: 0,
    interruptionAltitudeM: 0, interruptionReverseOrbitProgressDegrees: 0, interruptionReverseOrbitRadiusM: 0,
    interruptionReverseOrbitTargetViewErrorDegrees: 0, interruptionReverseOrbitViewElevationDegrees: 0,
    interruptionReverseOrbitViewLimitDegrees: 0, interruptionReverseOrbitTangentialSpeedMps: 0,
    interruptionLaunchDistanceM: 0, interruptionTiltDegrees: 0, interruptionReverseOrbitCompletedLaps: 0,
  }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按再練一次，從地面自行起飛後重試本次倒刷鍋。' }
}
function hint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase === 0) return '在起飛區實際接地、低油門明確解鎖後開始。'
  if (phase === 1) return `自行起飛至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m（起重機塔高的一半），再朝前方參考塔接近；至少 4 m 才能準備繞行。`
  if (metrics.reverseOrbitEpisodeValid < 0.5) return `${metrics.reverseOrbitInterrupted > 0.5 ? '本次連續繞行已中斷並清空角度；先前步驟保留，但需要重新連續完成三圈。' : ''}到起重機旁約 10 m，抬高視線仰看高處機臂，再建立真正繞行。推力仍要有向上分量，不用把機腹翻朝天。`
  if (metrics.reverseOrbitCompleted < 0.5) return `持續仰視高處機臂並沿同一方向真正環繞，目前 ${metrics.reverseOrbitCompletedLaps}／3 圈、累積約 ${Math.floor(metrics.reverseOrbitProgressDegrees)}°。配合姿態與油門維持高度及半徑；原地轉機頭不能代替繞行。`
  if (phase < 7) return '三個完整圈已完成；朝塔外平穩離開至少 3 m，保持向外速度至少 0.5 m/s，修平姿態並減緩升降，確認 0.2 秒。原地停住不算離開。'
  return '已完成同方向三個完整繞塔圈與空中恢復；不需要降落或回到原點。'
}

function evaluateReverseOrbit(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('倒刷鍋停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('倒刷鍋停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('倒刷鍋停止：已上鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const camera = sample.fpvCamera
  if (!camera || !Number.isFinite(camera.fpvMountAngleDegrees) || camera.fpvMountAngleDegrees < 0 || camera.fpvMountAngleDegrees > 50
    || !Number.isFinite(camera.fpvFovDegrees) || camera.fpvFovDegrees < 45 || camera.fpvFovDegrees > 120) return terminal('倒刷鍋停止：缺少有效的實際 FPV 鏡頭設定。')
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('倒刷鍋缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('倒刷鍋停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('倒刷鍋停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < REVERSE_ORBIT_PHASE_IDS.length && context.checkpoints[REVERSE_ORBIT_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureReverseOrbitMotion(sample.state)
  const target = createReverseOrbitTarget(launch.positionM, surface.positionM.y)
  const x = position.x - target.x
  const z = position.z - target.z
  const radius = Math.hypot(x, z)
  const angle = Math.atan2(z, x)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const airborne = !contact.touching && clearance >= 0.15
  const radialSpeed = radius > 1e-6 ? (x * sample.state.velocityMps.x + z * sample.state.velocityMps.z) / radius : 0
  const tangentSpeed = radius > 1e-6 ? (x * sample.state.velocityMps.z - z * sample.state.velocityMps.x) / radius : 0
  const view = measureReverseOrbitView(sample.state, target, camera)
  const episode = episodeDefaults()
  for (const name of Object.keys(episode)) episode[name] = metric(context, name)
  const metrics: Record<string, number> = { ...episode, ...motion, reverseOrbitPhase: phase, altitudeM, groundClearanceM: clearance,
    ...view, launchDistanceM, groundTouching: contact.touching ? 1 : 0, targetAltitudeM: REVERSE_ORBIT_FLIGHT_HEIGHT_M,
    reverseOrbitRadiusM: radius, reverseOrbitTangentialSpeedMps: Math.abs(tangentSpeed),
    reverseOrbitRadialSpeedMps: radialSpeed, reverseOrbitAngularSpeedRadPerSec: radius > 1e-6 ? Math.abs(tangentSpeed / radius) : 0 }
  metrics.reverseOrbitExitDistanceM = metrics.reverseOrbitCompleted > 0.5 ? Math.max(0, radius - metrics.reverseOrbitCompletionRadiusM) : 0
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  if (!previous && metrics.reverseOrbitEpisodeValid > 0.5) return terminal('倒刷鍋停止：繞行資料中斷，缺少連續的飛行觀察。', metrics)
  if (previous) {
    if (!previous.fpvCamera || previous.fpvCamera.fpvMountAngleDegrees !== camera.fpvMountAngleDegrees
      || previous.fpvCamera.fpvFovDegrees !== camera.fpvFovDegrees) return terminal('倒刷鍋停止：本次練習的鏡頭設定已改變，請重新開始。', metrics)
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('倒刷鍋停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('倒刷鍋停止：位置跳躍與實際速度不一致。', metrics)
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
    if (turn * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > 2 + 400 * delta * delta) return terminal('倒刷鍋停止：姿態變化與實際旋轉速度不一致。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > REVERSE_ORBIT_TIME_LIMIT_SECONDS) return terminal('倒刷鍋挑戰逾時：尚未完成繞塔與空中恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: hint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = REVERSE_ORBIT_PHASE_IDS[phase]
    phase += 1
    metrics.reverseOrbitPhase = phase
    return phase >= 7 ? { status: 'success', checkpointIds: [id], score: 100, metrics,
      message: '已從地面自行起飛，完成同方向三圈倒刷鍋並恢復空中控制。', hint: hint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: hint(phase, metrics) }
  }
  // Reasons: 1 ground, 2 too low, 3 outside area, 4 radius, 5 altitude,
  // 6 high structure outside the actual camera view, 7 no lateral progress,
  // 8 backtracking, 9 down-facing thrust, 10 insufficient upward sightline.
  const interrupt = (reason: number): TrainingEvaluation => {
    // Keep the first failure's facts while the pilot is still recovering.
    // Only a fresh valid preparation may open another episode/snapshot.
    if (metrics.reverseOrbitEpisodeValid < 0.5 && metrics.reverseOrbitInterrupted > 0.5) return continuing()
    const snapshot = { reverseOrbitInterrupted: 1, reverseOrbitInterruptionReason: reason, interruptionAltitudeM: altitudeM,
      interruptionReverseOrbitProgressDegrees: metrics.reverseOrbitProgressDegrees, interruptionReverseOrbitRadiusM: radius,
      interruptionReverseOrbitTargetViewErrorDegrees: view.reverseOrbitTargetViewErrorDegrees,
      interruptionReverseOrbitViewElevationDegrees: view.reverseOrbitViewElevationDegrees,
      interruptionReverseOrbitViewLimitDegrees: view.reverseOrbitViewLimitDegrees,
      interruptionReverseOrbitTangentialSpeedMps: Math.abs(tangentSpeed),
      interruptionLaunchDistanceM: launchDistanceM, interruptionTiltDegrees: motion.tiltDegrees, interruptionReverseOrbitCompletedLaps: metrics.reverseOrbitCompletedLaps }
    Object.assign(metrics, episodeDefaults(), snapshot)
    return continuing()
  }
  if (phase >= 7) return metrics.reverseOrbitEpisodeValid > 0.5 && metrics.reverseOrbitCompleted > 0.5 && metrics.reverseOrbitProgressDegrees + 1e-8 >= REVERSE_ORBIT_COMPLETION_DEGREES
    && metrics.reverseOrbitCompletedLaps >= REVERSE_ORBIT_REQUIRED_LAPS
    && metrics.reverseOrbitCompletionRadiusM >= REVERSE_ORBIT_MIN_RADIUS_M && metrics.reverseOrbitCompletionRadiusM <= REVERSE_ORBIT_MAX_RADIUS_M
    && metrics.reverseOrbitExitDistanceM + 1e-8 >= REVERSE_ORBIT_EXIT_DISTANCE_M
    && metrics.reverseOrbitExitQualifying > 0.5 && metrics.reverseOrbitRecoveryQualifying > 0.5 && metrics.reverseOrbitRecoveryDwellSeconds + 1e-8 >= REVERSE_ORBIT_HOLD_SECONDS
    ? { status: 'success', score: 100, metrics, message: '已完成三圈倒刷鍋與空中恢復。', hint: hint(phase, metrics) }
    : terminal('倒刷鍋停止：缺少同一段連續三圈及恢復的實際飛行證據，請重新開始。', metrics)
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && launchDistanceM <= REVERSE_ORBIT_AREA_RADIUS_M && altitudeM >= REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M ? advance() : continuing()
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitudeM < REVERSE_ORBIT_MIN_HEIGHT_M) return interrupt(2)
  if (launchDistanceM > REVERSE_ORBIT_AREA_RADIUS_M) return interrupt(3)
  const envelopeReason = radius < REVERSE_ORBIT_MIN_RADIUS_M || radius > REVERSE_ORBIT_MAX_RADIUS_M ? 4
    : altitudeM < REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M || altitudeM > REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M || target.y - position.y < 6 ? 5
      : motion.tiltDegrees >= REVERSE_ORBIT_MAX_TILT_DEGREES ? 9
        : view.reverseOrbitViewElevationDegrees < REVERSE_ORBIT_MIN_VIEW_ELEVATION_DEGREES ? 10
          : view.reverseOrbitTargetViewErrorDegrees > view.reverseOrbitViewLimitDegrees ? 6
            : Math.abs(tangentSpeed) < REVERSE_ORBIT_MIN_TANGENTIAL_SPEED_MPS ? 7 : 0
  metrics.reverseOrbitEnvelopeValid = envelopeReason === 0 ? 1 : 0
  if (metrics.reverseOrbitEpisodeValid < 0.5) {
    const prepared = envelopeReason === 0
    metrics.reverseOrbitPreparationQualifying = prepared ? 1 : 0
    metrics.reverseOrbitPreparationDwellSeconds = prepared && metric(context, 'reverseOrbitPreparationQualifying') > 0.5
      ? Math.min(0.1, metric(context, 'reverseOrbitPreparationDwellSeconds') + delta) : 0
    if (metrics.reverseOrbitPreparationDwellSeconds + 1e-8 >= 0.1) {
      Object.assign(metrics, { reverseOrbitEpisodeValid: 1, reverseOrbitInterrupted: 0, reverseOrbitInterruptionReason: 0,
        reverseOrbitDirection: Math.sign(tangentSpeed), reverseOrbitAngleObserved: 1, reverseOrbitLastAngleRad: angle })
      if (phase === 2) return advance()
    }
    return continuing()
  }
  if (metrics.reverseOrbitCompleted < 0.5) {
    let angleDelta = angle - metrics.reverseOrbitLastAngleRad
    while (angleDelta > Math.PI) angleDelta -= Math.PI * 2
    while (angleDelta < -Math.PI) angleDelta += Math.PI * 2
    const directedDelta = metrics.reverseOrbitDirection * angleDelta * DEGREES
    // Invalid intervals never earn positive credit. Real reverse movement still
    // subtracts: returning through a brief invalid gap cannot pump the same arc.
    metrics.reverseOrbitSignedDegrees += envelopeReason === 0 && metrics.reverseOrbitAngleObserved > 0.5
      ? directedDelta : Math.min(0, directedDelta)
    metrics.reverseOrbitProgressDegrees = Math.max(0, metrics.reverseOrbitSignedDegrees)
    metrics.reverseOrbitCompletedLaps = Math.min(REVERSE_ORBIT_REQUIRED_LAPS, Math.floor((metrics.reverseOrbitProgressDegrees + 1e-8) / 360))
    metrics.reverseOrbitCurrentLap = Math.min(REVERSE_ORBIT_REQUIRED_LAPS, metrics.reverseOrbitCompletedLaps + 1)
    metrics.reverseOrbitMaxProgressDegrees = Math.max(metrics.reverseOrbitMaxProgressDegrees, metrics.reverseOrbitProgressDegrees)
    metrics.reverseOrbitLastAngleRad = angle
    metrics.reverseOrbitAngleObserved = envelopeReason === 0 ? 1 : 0
    if (metrics.reverseOrbitMaxProgressDegrees - metrics.reverseOrbitSignedDegrees > 45) return interrupt(8)
    if (envelopeReason !== 0) {
      metrics.reverseOrbitInvalidSeconds += delta
      if (metrics.reverseOrbitInvalidSeconds + 1e-8 >= 0.75) return interrupt(envelopeReason)
      return continuing()
    }
    metrics.reverseOrbitInvalidSeconds = 0
    if (metrics.reverseOrbitProgressDegrees + 1e-8 >= REVERSE_ORBIT_COMPLETION_DEGREES) {
      metrics.reverseOrbitCompleted = 1
      metrics.reverseOrbitLapAngularSpeedRadPerSec = Math.abs(tangentSpeed / radius)
      metrics.reverseOrbitCompletionRadiusM = radius
      metrics.reverseOrbitExitDistanceM = 0
    }
  }
  // Milestones can survive a local retry; only current episode evidence can
  // satisfy later milestones or recovery. Never reuse old reverseOrbit-lap-N flags.
  if (phase >= 3 && phase <= 5 && metrics.reverseOrbitProgressDegrees + 1e-8 >= (phase - 2) * 360) return advance()
  if (phase === 6 && metrics.reverseOrbitEpisodeValid > 0.5 && metrics.reverseOrbitCompleted > 0.5) {
    const exiting = metrics.reverseOrbitExitDistanceM + 1e-8 >= REVERSE_ORBIT_EXIT_DISTANCE_M && radialSpeed >= REVERSE_ORBIT_EXIT_MIN_SPEED_MPS
    metrics.reverseOrbitExitQualifying = exiting ? 1 : 0
    const recovered = exiting && motion.tiltDegrees <= 40 && motion.bodyRateDegreesPerSecond <= 180
      && motion.horizontalSpeedMps <= 20 && motion.verticalSpeedMps >= -4 && motion.verticalSpeedMps <= 5
    metrics.reverseOrbitRecoveryQualifying = recovered ? 1 : 0
    metrics.reverseOrbitRecoveryDwellSeconds = recovered && metric(context, 'reverseOrbitRecoveryQualifying') > 0.5
      ? Math.min(REVERSE_ORBIT_HOLD_SECONDS, metric(context, 'reverseOrbitRecoveryDwellSeconds') + delta) : 0
    if (metrics.reverseOrbitRecoveryDwellSeconds + 1e-8 >= REVERSE_ORBIT_HOLD_SECONDS) return advance()
  } else {
    metrics.reverseOrbitRecoveryQualifying = 0
    metrics.reverseOrbitRecoveryDwellSeconds = 0
  }
  return continuing()
}

export const reverseOrbitEvaluator: LessonEvaluatorContract = { evaluate: evaluateReverseOrbit }
export const REVERSE_ORBIT_LESSON: LessonDefinition = {
  id: 'reverse-orbit', priority: 4.5, title: '倒刷鍋', availability: 'available', available: true,
  description: '從地面自行起飛，仰視高處起重機機臂，同方向環繞三個完整圈，再朝外離開並恢復控制。',
  objectives: ['辨識高處起重機機臂與寬闊環繞區。', '保持向上推力，仰視參照物並真正環繞。', '連續完成同方向三圈，再實際向外離開並恢復控制。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', 'reverse-orbit-zone'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'reverse-orbit-ground', title: '地面開始', description: '在起飛區實際接地，明確解鎖。' },
    { id: 'reverse-orbit-liftoff', title: '自行起飛至練習高度', description: `至少 4 m，建議升至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m（起重機塔高的一半），再接近前方起重機。` },
    { id: 'reverse-orbit-entry', title: '仰視機臂並建立環繞', description: '距起重機約 10 m，抬高視線，將高處機臂保留在 FPV 視野，建立真正側向環繞。' },
    { id: 'reverse-orbit-lap-1', title: '仰視完成第一圈', description: '同方向實際繞行完整 360°，持續仰看高處機臂。' },
    { id: 'reverse-orbit-lap-2', title: '連續完成第二圈', description: '同一段仰視環繞累積至少 720°，保持實際移動。' },
    { id: 'reverse-orbit-lap-3', title: '連續完成第三圈', description: '同一段仰視環繞累積至少 1080°，每圈都是完整 360°。' },
    { id: 'reverse-orbit-recovered', title: '向外離開並恢復控制', description: '向外離開至少 3 m、向外速度至少 0.5 m/s，修平姿態並減緩升降，確認 0.2 秒。' },
  ],
  success: { title: '倒刷鍋完成', description: '已觀察到持續仰視高處機臂的連續三圈與實際向外改出。', criteria: ['地面自行起飛', '仰視高處參照物真正環繞三圈', '實際向外飛離並恢復控制'] },
  failure: { title: '倒刷鍋尚未完成', description: '一般偏離可在空中重新準備；墜毀、上鎖或無效資料需要重試。', criteria: ['原地偏航不算環繞', '平視正刷鍋不能代替仰視環繞', '不能把中斷前後圈數拼成三圈'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['reverseOrbitCompletedLaps', 'reverseOrbitProgressDegrees', 'reverseOrbitViewElevationDegrees', 'reverseOrbitTargetViewErrorDegrees', 'reverseOrbitRecoveryDwellSeconds'] },
  hints: [`先自行起飛至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m（起重機塔高的一半），仰視約 ${REVERSE_ORBIT_TARGET_HEIGHT_M} m 高的起重機機臂，在約 ${REVERSE_ORBIT_TARGET_RADIUS_M} m 半徑真正環繞三圈；向外飛離後修平，不要求完美圓形、精準停點或降落。`],
  evaluator: reverseOrbitEvaluator,
}
export const REVERSE_ORBIT_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L16', title: '倒刷鍋', level: '花飛進階', prerequisiteIds: ['orbit'],
  objectives: ['分辨仰視與機體倒置，觀察高處起重機機臂。', '配合姿態與油門連續環繞三圈，再恢復控制。'],
  steps: [`從地面自行起飛至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m（起重機塔高的一半），找到前方起重機；至少 4 m 才開始環繞。`, '到起重機旁約 10 m，建立左右任一方向的實際環繞。初版示範逐步讓機頭朝外並抬高，鏡頭仰看機臂；可先用 Chase 觀察機體與推力方向。', '保持高處機臂在實際 FPV 視野內，配合偏航追看參照物，並以油門支撐高度；推力朝圓心且保留向上分量，不需要翻成機腹朝天。', '每圈完整 360°，同方向連續完成三圈、累積至少 1080°；不用貼線或維持完美半徑。', '完成三圈後實際朝外飛離至少 3 m，向外速度至少 0.5 m/s，修平姿態並減緩升降，確認 0.2 秒。'],
  commonMistakes: ['原地仰頭偏航，沒有真正繞起重機移動。', '只看天空，讓高處機臂離開視野。', '把仰視誤當成機腹朝天，讓推力朝下。', '左右反覆刷小段弧線，把局部動作當完整三圈。', '只顧方向，忽略半徑、高度與油門。'],
}
