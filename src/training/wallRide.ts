import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3 } from '../math/vector'
import { findSweptObstacleHit, OBSTACLE_CRASH_WARNING_PREFIX } from '../simulation/obstacles'
import { createWallRide, WALL_RIDE_REFERENCE_IDS, WALL_RIDE_TARGET_HEIGHT_M, WALL_RIDE_MIN_GAP_M, WALL_RIDE_MAX_GAP_M, WALL_RIDE_MIN_HEIGHT_M, WALL_RIDE_MAX_HEIGHT_M, WALL_RIDE_MAX_BELLY_ANGLE_DEGREES, WALL_RIDE_DISTANCE_M, WALL_RIDE_SECONDS } from '../world/wallRide'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const WALL_RIDE_TIME_LIMIT_SECONDS = 300
export const WALL_RIDE_AREA_RADIUS_M = 150
export const WALL_RIDE_RECOVERY_SECONDS = 0.2
export const WALL_RIDE_BACKTRACK_ALLOWANCE_M = 3
export const WALL_RIDE_ENTRY_DISTANCE_M = 2
export const WALL_RIDE_PHASE_IDS = Object.freeze(['wall-ride-ground', 'wall-ride-liftoff', 'wall-ride-approach', 'wall-ride-forward-entry', 'wall-ride-belly-facing', 'wall-ride-along-wall', 'wall-ride-leave', 'wall-ride-recovered'] as const)
const DEGREES = 180 / Math.PI
const number = (context: TrainingEvaluationContext, key: string): number => {
  const value = context.previousEvaluation?.metrics?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function freshEpisode(): Record<string, number> {
  return { wallRideEpisodeValid: 0, wallRideInterrupted: 0, wallRideInterruptionReason: 0,
    wallRideApproached: 0, wallRideForwardEntered: 0, wallRideBellyFaced: 0, wallRideRideComplete: 0, wallRideLeft: 0, wallRideRecovered: 0,
    wallRideApproachZM: 0, wallRideEntryDistanceM: 0, wallRideRideStartZM: 0, wallRideDistanceM: 0, wallRideSeconds: 0,
    wallRideQualifying: 0, wallRideCompletionGapM: 0, wallRideFurthestForwardM: 0, wallRideBacktrackM: 0,
    wallRideRecoveryQualifying: 0, wallRideRecoveryDwellSeconds: 0,
    interruptionWallRideGapM: 0, interruptionWallRideBellyAngleDegrees: 0, interruptionWallRideAltitudeM: 0,
    interruptionWallRideDistanceM: 0, interruptionWallRideSeconds: 0 }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按「再練一次」，從地面自行起飛後重新進場；保留間隙，不碰牆。' }
}
function hint(metrics: Readonly<Record<string, number>>): string {
  if (metrics.wallRideInterrupted > 0.5) return '本段騎牆已中斷；查看當時原因，回到牆面前端之前重新進場。先前勾選保留，但本段距離及時間須重新建立。'
  if (metrics.wallRidePhase === 0) return '在起飛區實際接地，低油門明確解鎖。'
  if (metrics.wallRidePhase === 1) return `自行起飛，建議約 ${WALL_RIDE_TARGET_HEIGHT_M} m，保留側傾與下沉的改出空間。`
  if (metrics.wallRidePhase === 2) return '靠近右側牆面前端的藍色進場區，保留間隙並沿牆向前飛。'
  if (metrics.wallRidePhase === 3) return '沿牆建立實際前進路線；先向前移動 2 m，再側傾進入騎牆。'
  if (metrics.wallRidePhase === 4) return '讓機腹朝向右側牆面；姿態、距牆與實際向前路線共同判定，不要求固定 90°。'
  if (metrics.wallRidePhase === 5) return '保持間隙，機腹朝牆連續向前掠飛至少 6 m／0.3 秒；容許下沉，不必精準等高。'
  if (metrics.wallRidePhase === 6) return '騎牆路段已完成；回正並向牆外飛離，擴大距牆間隙。'
  return '已離牆；修回正飛，減緩升降與旋轉，確認 0.2 秒即可，不必停住或降落。'
}

function evaluateWallRide(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('騎牆停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) {
    const collision = sample.state.warnings.find((warning) => warning.startsWith(OBSTACLE_CRASH_WARNING_PREFIX))
    return terminal(collision ? `騎牆停止：已碰撞實體牆面。${collision}` : '騎牆停止：機體已墜毀。', context.previousEvaluation?.metrics)
  }
  if (sample.armed === false) return terminal('騎牆停止：已上鎖或失去焦點。', context.previousEvaluation?.metrics)
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('騎牆缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('騎牆停止：缺少有效的地面接觸資料。')
  const state = sample.state, position = state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('騎牆停止：接地標記與機體支撐高度不一致。')
  const wall = createWallRide(launch.positionM, surface.positionM.y)
  const previous = context.previousFlightSample ?? context.previousSample
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const stored = freshEpisode()
  for (const key of Object.keys(stored)) stored[key] = number(context, key)
  const grounded = context.checkpoints['wall-ride-ground']?.completed === true
  const lifted = context.checkpoints['wall-ride-liftoff']?.completed === true
  const altitude = position.y - contact.heightM
  const airborne = !contact.touching && clearance >= 0.15
  const metrics: Record<string, number> = { ...stored, altitudeM: altitude, groundClearanceM: clearance, groundTouching: contact.touching ? 1 : 0,
    launchDistanceM: Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z),
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    horizontalSpeedMps: Math.hypot(state.velocityMps.x, state.velocityMps.z), verticalSpeedMps: state.velocityMps.y,
    wallRideGapM: wall.faceXM - position.x, wallRideBellyAngleDegrees: Math.acos(Math.max(-1, Math.min(1, -up.x))) * DEGREES,
    wallRideForwardSpeedMps: -state.velocityMps.z, wallRideForwardProgressM: launch.positionM.z - position.z,
    wallRideNextDistanceM: position.z - (stored.wallRideForwardEntered > 0.5 ? wall.rideEndM.z : wall.entryM.z),
    targetAltitudeM: WALL_RIDE_TARGET_HEIGHT_M, wallRidePhase: 0 }
  const updatePhase = (): void => {
    metrics.wallRidePhase = !grounded ? 0 : !lifted ? 1 : metrics.wallRideRecovered > 0.5 ? 8 : metrics.wallRideLeft > 0.5 ? 7
      : metrics.wallRideRideComplete > 0.5 ? 6 : metrics.wallRideBellyFaced > 0.5 ? 5 : metrics.wallRideForwardEntered > 0.5 ? 4
        : metrics.wallRideApproached > 0.5 ? 3 : 2
  }
  updatePhase()
  let delta = 0
  if (!previous && metrics.wallRideEpisodeValid > 0.5) return terminal('騎牆停止：缺少連續飛行觀察。', metrics)
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || state.stepIndex <= previous.state.stepIndex) return terminal('騎牆停止：資料中斷、時間倒退或模擬被重設。', metrics)
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (state.velocityMps.x + previous.state.velocityMps.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (state.velocityMps.y + previous.state.velocityMps.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (state.velocityMps.z + previous.state.velocityMps.z) * 0.5 * delta)
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('騎牆停止：位置跳躍與實際速度不一致。', metrics)
    let rotation = normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(normalizeQuaternion(previous.state.orientation)), normalizeQuaternion(state.orientation)))
    if (rotation.w < 0) rotation = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: -rotation.w }
    const sine = Math.hypot(rotation.x, rotation.y, rotation.z), turn = 2 * Math.atan2(sine, Math.max(0, rotation.w))
    const factor = sine > 1e-10 ? turn / sine : 2
    const afterRate = rotateVectorByQuaternion(rotation, state.angularVelocityBodyRadPerSec), beforeRate = previous.state.angularVelocityBodyRadPerSec
    metrics.angularConsistencyErrorDegrees = Math.hypot(rotation.x * factor - (beforeRate.x + afterRate.x) * 0.5 * delta,
      rotation.y * factor - (beforeRate.y + afterRate.y) * 0.5 * delta,
      rotation.z * factor - (beforeRate.z + afterRate.z) * 0.5 * delta) * DEGREES
    if (turn * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > 2 + 400 * delta * delta) return terminal('騎牆停止：姿態變化與實際旋轉速度不一致。', metrics)
    const hit = findSweptObstacleHit(previous.state.positionM, position, 0, wall.colliders)
    if (hit) return terminal(`騎牆停止：路線穿過實體牆面。${OBSTACLE_CRASH_WARNING_PREFIX}${hit.colliderId}`, metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > WALL_RIDE_TIME_LIMIT_SECONDS) return terminal('騎牆挑戰逾時：尚未完成貼牆路段與改出。', metrics)
  const checkpointIds: string[] = []
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, checkpointIds, hint: hint(metrics) })
  const interrupt = (reason: number): TrainingEvaluation => {
    if (metrics.wallRideEpisodeValid < 0.5 && metrics.wallRideInterrupted > 0.5) return continuing()
    const evidence = { wallRideInterrupted: 1, wallRideInterruptionReason: reason,
      interruptionWallRideGapM: metrics.wallRideGapM, interruptionWallRideBellyAngleDegrees: metrics.wallRideBellyAngleDegrees,
      interruptionWallRideAltitudeM: altitude, interruptionWallRideDistanceM: metrics.wallRideDistanceM, interruptionWallRideSeconds: metrics.wallRideSeconds }
    Object.assign(metrics, freshEpisode(), evidence)
    checkpointIds.length = 0
    updatePhase()
    return continuing()
  }
  if (!grounded) {
    if (contact.touching && metrics.launchDistanceM <= 1.9) { checkpointIds.push('wall-ride-ground'); metrics.wallRidePhase = 1 }
    return continuing()
  }
  if (!lifted) {
    if (airborne && altitude >= WALL_RIDE_MIN_HEIGHT_M) { checkpointIds.push('wall-ride-liftoff'); metrics.wallRidePhase = 2 }
    return continuing()
  }
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitude < 1) return interrupt(2)
  if (metrics.launchDistanceM > WALL_RIDE_AREA_RADIUS_M) return interrupt(3)
  const staging = position.z >= wall.nearZM + (metrics.wallRideInterrupted > 0.5 ? 2 : -4)
  if (metrics.wallRideEpisodeValid < 0.5) {
    if (!staging) return metrics.wallRideInterrupted > 0.5 ? continuing() : interrupt(4)
    Object.assign(metrics, freshEpisode(), { wallRideEpisodeValid: 1, wallRideFurthestForwardM: metrics.wallRideForwardProgressM })
  }
  metrics.wallRideFurthestForwardM = Math.max(metrics.wallRideFurthestForwardM, metrics.wallRideForwardProgressM)
  metrics.wallRideBacktrackM = metrics.wallRideFurthestForwardM - metrics.wallRideForwardProgressM
  if (metrics.wallRideForwardEntered > 0.5 && metrics.wallRideBacktrackM > WALL_RIDE_BACKTRACK_ALLOWANCE_M + 1e-8) return interrupt(9)
  const heightValid = altitude >= WALL_RIDE_MIN_HEIGHT_M && altitude <= WALL_RIDE_MAX_HEIGHT_M
  const gapValid = metrics.wallRideGapM >= WALL_RIDE_MIN_GAP_M && metrics.wallRideGapM <= WALL_RIDE_MAX_GAP_M
  const alongside = position.z <= wall.nearZM && position.z >= wall.farZM
  if (alongside && heightValid && metrics.wallRideGapM < WALL_RIDE_MIN_GAP_M) return interrupt(5)
  const approachCorridor = heightValid && metrics.wallRideGapM >= WALL_RIDE_MIN_GAP_M && metrics.wallRideGapM <= WALL_RIDE_MAX_GAP_M + 2
    && position.z <= wall.nearZM + 8 && position.z >= wall.nearZM - 4
  if (metrics.wallRideApproached < 0.5) {
    if (!approachCorridor) return position.z < wall.nearZM - 4 ? interrupt(4) : continuing()
    metrics.wallRideApproached = 1
    metrics.wallRideApproachZM = position.z
    checkpointIds.push('wall-ride-approach')
  }
  if (metrics.wallRideForwardEntered < 0.5) {
    const entryCorridor = heightValid && metrics.wallRideGapM >= WALL_RIDE_MIN_GAP_M && metrics.wallRideGapM <= WALL_RIDE_MAX_GAP_M + 2
    if (!entryCorridor) {
      metrics.wallRideApproached = 0; metrics.wallRideEntryDistanceM = 0
      updatePhase()
      return continuing()
    }
    metrics.wallRideEntryDistanceM = Math.max(0, metrics.wallRideApproachZM - position.z)
    if (metrics.wallRideEntryDistanceM + 1e-8 < WALL_RIDE_ENTRY_DISTANCE_M) { updatePhase(); return continuing() }
    metrics.wallRideForwardEntered = 1
    checkpointIds.push('wall-ride-forward-entry')
  }
  if (metrics.wallRideRideComplete < 0.5) {
    const bellyValid = metrics.wallRideBellyAngleDegrees <= WALL_RIDE_MAX_BELLY_ANGLE_DEGREES + 1e-8
    const qualifying = alongside && gapValid && heightValid && bellyValid
    if (!qualifying && metrics.wallRideBellyFaced > 0.5) return interrupt(!gapValid ? metrics.wallRideGapM < WALL_RIDE_MIN_GAP_M ? 5 : 6 : !heightValid ? 7 : !alongside ? 10 : 8)
    if (!qualifying) { updatePhase(); return position.z < wall.farZM ? interrupt(10) : continuing() }
    if (metrics.wallRideBellyFaced < 0.5) {
      metrics.wallRideBellyFaced = 1
      metrics.wallRideRideStartZM = position.z
      checkpointIds.push('wall-ride-belly-facing')
    }
    metrics.wallRideQualifying = 1
    metrics.wallRideDistanceM = Math.max(0, metrics.wallRideRideStartZM - position.z)
    if (number(context, 'wallRideQualifying') > 0.5) metrics.wallRideSeconds += delta
    if (metrics.wallRideDistanceM + 1e-8 >= WALL_RIDE_DISTANCE_M && metrics.wallRideSeconds + 1e-8 >= WALL_RIDE_SECONDS) {
      metrics.wallRideRideComplete = 1
      metrics.wallRideCompletionGapM = metrics.wallRideGapM
      checkpointIds.push('wall-ride-along-wall')
    }
  }
  if (metrics.wallRideRideComplete > 0.5 && metrics.wallRideGapM >= Math.max(metrics.wallRideCompletionGapM + 1, 5.5)) {
    if (metrics.wallRideLeft < 0.5) checkpointIds.push('wall-ride-leave')
    metrics.wallRideLeft = 1
  }
  const recovered = metrics.wallRideRideComplete > 0.5 && metrics.wallRideLeft > 0.5 && metrics.wallRideGapM >= 5.5
    && metrics.tiltDegrees <= 50 && metrics.bodyRateDegreesPerSecond <= 220 && Math.abs(metrics.verticalSpeedMps) <= 8 && metrics.horizontalSpeedMps <= 30
  metrics.wallRideRecoveryQualifying = recovered ? 1 : 0
  metrics.wallRideRecoveryDwellSeconds = recovered && number(context, 'wallRideRecoveryQualifying') > 0.5 ? metrics.wallRideRecoveryDwellSeconds + delta : 0
  if (metrics.wallRideRecoveryDwellSeconds + 1e-8 >= WALL_RIDE_RECOVERY_SECONDS) {
    metrics.wallRideRecovered = 1
    checkpointIds.push('wall-ride-recovered')
  }
  updatePhase()
  return metrics.wallRideRecovered > 0.5
    ? { status: 'success', metrics, checkpointIds, score: 100, message: '已保留間隙，機腹朝牆沿牆前進，再回正離牆並恢復控制。', hint: '騎牆完成；不需要停住或降落。' }
    : continuing()
}

export const wallRideEvaluator: LessonEvaluatorContract = { evaluate: evaluateWallRide }
export const WALL_RIDE_LESSON: LessonDefinition = {
  id: 'wall-ride', priority: 20, title: '騎牆', availability: 'available', available: true,
  description: '地面自行起飛，帶速進場，機腹朝向右側牆面、保留間隙沿牆前進，再回正離牆。',
  objectives: ['辨認右側實體牆面、進場方向及改出空間。', '以機腹朝牆的姿態完成真正沿牆位移，保留間隙。', '容許下沉，及時離牆並恢復正飛。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', ...WALL_RIDE_REFERENCE_IDS], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'wall-ride-ground', title: '地面開始', description: '起飛區接地，低油門明確解鎖。' },
    { id: 'wall-ride-liftoff', title: '自行起飛', description: '自行取得高度，建議約 14 m。' },
    { id: 'wall-ride-approach', title: '靠近牆面前端', description: '由藍色進場區靠近，保留間隙。' },
    { id: 'wall-ride-forward-entry', title: '建立沿牆前進', description: '進場後實際向前移動至少 2 m，不用停住。' },
    { id: 'wall-ride-belly-facing', title: '側傾讓機腹朝牆', description: '機腹朝右側牆面，準備短暫掠飛。' },
    { id: 'wall-ride-along-wall', title: '保留間隙沿牆前進', description: '連續沿牆至少 6 m、0.3 秒，不碰牆。' },
    { id: 'wall-ride-leave', title: '向外離開牆面', description: '擴大距牆間隙，離開騎牆路段。' },
    { id: 'wall-ride-recovered', title: '回正並恢復控制', description: '修回正飛，減緩升降與旋轉確認 0.2 秒。' },
  ],
  success: { title: '騎牆完成', description: '同一段有效進場中，以機腹朝牆的姿態保留間隙沿牆飛行，再離牆恢復控制。', criteria: ['地面自行起飛', '機腹朝牆及實際沿牆位移', '不碰牆、回正離牆'] },
  failure: { title: '騎牆尚未完成', description: '碰牆或墜毀需重設，一般路段中斷可回前端重新進場。', criteria: ['不以原地側傾代替沿牆飛行', '不能把正飛平行牆面當作騎牆', '不能拼接中斷前後距離與時間'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0,
    metricLabels: ['wallRideGapM', 'wallRideBellyAngleDegrees', 'wallRideDistanceM', 'wallRideSeconds', 'wallRideForwardSpeedMps', 'altitudeM'] },
  hints: ['先自行起飛至約 14 m，在右側牆前端帶速進場，機腹朝牆並保留 0.8～5 m 間隙，沿牆前飛至少 6 m 後回正離牆。'], evaluator: wallRideEvaluator,
}
export const WALL_RIDE_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L20', title: '騎牆', level: '近障礙花飛', prerequisiteIds: ['direction-control', 'basic-recovery', 'full-roll', 'orbit'],
  objectives: ['理解機腹與牆面相對方向，以及短暫下沉與改出空間。', '在實體牆旁完成非接觸的沿牆飛行。'],
  steps: ['從地面自行起飛至約 14 m，先看清右側牆面、藍色進場及外側改出空間。', '靠近牆面前端，先沿牆建立前進動量，再側傾使機腹朝牆。', '保留 0.8～5 m 間隙，在離地 3～24 m 內沿牆連續飛過至少 6 m／0.3 秒；機腹與朝牆方向偏差 45° 內即可，不要求固定側立 90°。', '回正並向外離牆，再減緩升降與旋轉，不要求停住或降落。'],
  commonMistakes: ['保持正飛沿牆直飛，沒有讓機腹朝向牆面。', '只把機頭轉向牆，或原地側傾卻沒有沿牆移動。', '太貼牆，讓機體或槳碰到牆面。', '側傾後忽略高度，過晚回正改出。'],
}
