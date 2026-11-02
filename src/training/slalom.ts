import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3 } from '../math/vector'
import { findSweptObstacleHit, OBSTACLE_CRASH_WARNING_PREFIX } from '../simulation/obstacles'
import { createSlalomFlags, slalomFlagCrossing, SLALOM_FLAG_IDS, SLALOM_EXIT_DISTANCE_M, SLALOM_TARGET_HEIGHT_M } from '../world/slalomFlags'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const SLALOM_TIME_LIMIT_SECONDS = 300
export const SLALOM_AREA_RADIUS_M = 150
export const SLALOM_BACKTRACK_ALLOWANCE_M = 3
export const SLALOM_RECOVERY_SECONDS = 0.2
export const SLALOM_PHASE_IDS = Object.freeze(['slalom-ground', 'slalom-liftoff', ...SLALOM_FLAG_IDS, 'slalom-exit', 'slalom-recovered'] as const)
const DEGREES = 180 / Math.PI
function previousMetric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function defaults(): Record<string, number> {
  return { slalomEpisodeValid: 0, slalomInterrupted: 0, slalomInterruptionReason: 0, slalomFlagsPassed: 0,
    slalomExited: 0, slalomRecovered: 0, slalomFurthestForwardM: 0, slalomBacktrackM: 0,
    slalomRecoveryQualifying: 0, slalomRecoveryDwellSeconds: 0,
    interruptionSlalomFlagIndex: 0, interruptionSlalomSideOffsetM: 0, interruptionSlalomAltitudeM: 0,
    interruptionSlalomBacktrackM: 0, interruptionSlalomForwardDistanceM: 0 }
}
function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', message, metrics, hint: '按「再練一次」，從地面自行起飛後重新練習刀旗 S 彎。' }
}
function routeHint(metrics: Readonly<Record<string, number>>): string {
  if (metrics.slalomPhase === 0) return '先在起飛區實際接地，保持低油門明確解鎖。'
  if (metrics.slalomPhase === 1) return `自行起飛至約 ${SLALOM_TARGET_HEIGHT_M} m，第一面旗從左側通過；不用先定點懸停。`
  if (metrics.slalomInterrupted > 0.5) return '本段路線已中斷；查看第一個原因，回到第一旗前方至少 3 m 再重新進場。先前勾選保留，但本次仍須依序完整通過六旗。'
  if (metrics.slalomFlagsPassed < 6) return `下一面是第 ${metrics.slalomFlagsPassed + 1} 旗，從${metrics.slalomFlagsPassed % 2 === 0 ? '左' : '右'}側通過；沿旗列向前、交替切彎，不繞圈或回頭。`
  if (metrics.slalomExited < 0.5) return '六旗已依序完成；繼續向前飛過離場標記，不要求停住。'
  return '已向前離開旗列；修回正飛、減緩升降及旋轉，確認 0.2 秒即可，不用懸停或降落。'
}

function evaluateSlalom(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('刀旗 S 彎停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) {
    const obstacle = sample.state.warnings.find((warning) => warning.startsWith(OBSTACLE_CRASH_WARNING_PREFIX))
    return terminal(obstacle ? `刀旗 S 彎停止：已碰撞實體刀旗。${obstacle}` : '刀旗 S 彎停止：機體已墜毀。', context.previousEvaluation?.metrics)
  }
  if (sample.armed === false) return terminal('刀旗 S 彎停止：已上鎖或失去焦點。', context.previousEvaluation?.metrics)
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('刀旗 S 彎缺少有效起飛點或地面參考。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('刀旗 S 彎停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || contact.touching && Math.abs(clearance) > 0.003) return terminal('刀旗 S 彎停止：接地標記與機體支撐高度不一致。')
  const flags = createSlalomFlags(launch.positionM, surface.positionM.y)
  const exitZ = flags.at(-1)!.positionM.z - SLALOM_EXIT_DISTANCE_M
  const previous = context.previousFlightSample ?? context.previousSample
  const state = sample.state
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const stored = defaults()
  for (const key of Object.keys(stored)) stored[key] = previousMetric(context, key)
  const passed = stored.slalomFlagsPassed
  if (!Number.isInteger(passed) || passed < 0 || passed > flags.length) return terminal('刀旗 S 彎停止：路線進度無效。')
  const grounded = context.checkpoints['slalom-ground']?.completed === true
  const lifted = context.checkpoints['slalom-liftoff']?.completed === true
  const altitude = position.y - contact.heightM
  const airborne = !contact.touching && clearance >= 0.15
  const forwardDistance = launch.positionM.z - position.z
  const metrics: Record<string, number> = { ...stored, altitudeM: altitude, groundClearanceM: clearance,
    groundTouching: contact.touching ? 1 : 0, launchDistanceM: Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z),
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * DEGREES,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * DEGREES,
    horizontalSpeedMps: Math.hypot(state.velocityMps.x, state.velocityMps.z), verticalSpeedMps: state.velocityMps.y,
    slalomForwardSpeedMps: -state.velocityMps.z, slalomForwardProgressM: forwardDistance, targetAltitudeM: SLALOM_TARGET_HEIGHT_M,
    slalomPhase: !grounded ? 0 : !lifted ? 1 : passed < 6 ? passed + 2 : stored.slalomExited > 0.5 ? stored.slalomRecovered > 0.5 ? 10 : 9 : 8,
    slalomTargetIndex: passed < 6 ? passed : stored.slalomExited > 0.5 ? 7 : 6 }
  const updateTarget = (): void => {
    const count = metrics.slalomFlagsPassed
    const flag = flags[Math.min(count, flags.length - 1)]
    metrics.slalomNextFlagDistanceM = position.z - (count < flags.length ? flag.positionM.z : exitZ)
    metrics.slalomSideOffsetM = (position.x - flag.positionM.x) * flag.passSideSign
    metrics.slalomTargetIndex = count < 6 ? count : metrics.slalomExited > 0.5 ? 7 : 6
    metrics.slalomPhase = !grounded ? 0 : !lifted ? 1 : count < 6 ? count + 2 : metrics.slalomExited > 0.5 ? metrics.slalomRecovered > 0.5 ? 10 : 9 : 8
  }
  updateTarget()
  let delta = 0
  if (!previous && metrics.slalomEpisodeValid > 0.5) return terminal('刀旗 S 彎停止：缺少連續飛行觀察。', metrics)
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || state.stepIndex <= previous.state.stepIndex) return terminal('刀旗 S 彎停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = state.velocityMps, beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta)
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('刀旗 S 彎停止：位置跳躍與實際速度不一致。', metrics)
    let rotation = normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(normalizeQuaternion(previous.state.orientation)), normalizeQuaternion(state.orientation)))
    if (rotation.w < 0) rotation = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: -rotation.w }
    const sine = Math.hypot(rotation.x, rotation.y, rotation.z)
    const turn = 2 * Math.atan2(sine, Math.max(0, rotation.w))
    const factor = sine > 1e-10 ? turn / sine : 2
    const rateAfter = rotateVectorByQuaternion(rotation, state.angularVelocityBodyRadPerSec)
    const beforeRate = previous.state.angularVelocityBodyRadPerSec
    metrics.angularConsistencyErrorDegrees = Math.hypot(rotation.x * factor - (beforeRate.x + rateAfter.x) * 0.5 * delta,
      rotation.y * factor - (beforeRate.y + rateAfter.y) * 0.5 * delta,
      rotation.z * factor - (beforeRate.z + rateAfter.z) * 0.5 * delta) * DEGREES
    if (turn * DEGREES > 90 || metrics.angularConsistencyErrorDegrees > 2 + 400 * delta * delta) return terminal('刀旗 S 彎停止：姿態變化與實際旋轉速度不一致。', metrics)
    const hit = findSweptObstacleHit(previous.state.positionM, position, 0, flags.flatMap((flag) => flag.colliders))
    if (hit) return terminal(`刀旗 S 彎停止：路線穿過實體刀旗。${OBSTACLE_CRASH_WARNING_PREFIX}${hit.colliderId}`, metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > SLALOM_TIME_LIMIT_SECONDS) return terminal('刀旗 S 彎挑戰逾時：尚未依序完成六旗與離場。', metrics)
  const checkpointIds: string[] = []
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, checkpointIds, hint: routeHint(metrics) })
  const interrupt = (reason: number, offset = metrics.slalomSideOffsetM, height = altitude): TrainingEvaluation => {
    if (metrics.slalomEpisodeValid < 0.5 && metrics.slalomInterrupted > 0.5) return continuing()
    const first = { slalomInterrupted: 1, slalomInterruptionReason: reason,
      interruptionSlalomFlagIndex: Math.min(metrics.slalomFlagsPassed, 5), interruptionSlalomSideOffsetM: offset,
      interruptionSlalomAltitudeM: height, interruptionSlalomBacktrackM: metrics.slalomBacktrackM,
      interruptionSlalomForwardDistanceM: metrics.slalomNextFlagDistanceM }
    Object.assign(metrics, defaults(), first)
    checkpointIds.length = 0
    updateTarget()
    return continuing()
  }
  if (!grounded) {
    if (contact.touching && metrics.launchDistanceM <= 1.9) { checkpointIds.push('slalom-ground'); metrics.slalomPhase = 1 }
    return continuing()
  }
  if (!lifted) {
    if (airborne && altitude >= 1) { checkpointIds.push('slalom-liftoff'); metrics.slalomPhase = 2 }
    return continuing()
  }
  if (!airborne) return interrupt(contact.touching ? 1 : 2)
  if (altitude < 0.5) return interrupt(2)
  if (metrics.launchDistanceM > SLALOM_AREA_RADIUS_M) return interrupt(3)
  const staging = position.z >= flags[0].positionM.z + SLALOM_BACKTRACK_ALLOWANCE_M
  if (metrics.slalomEpisodeValid < 0.5) {
    if (!staging) return metrics.slalomInterrupted > 0.5 ? continuing() : interrupt(8)
    Object.assign(metrics, defaults(), { slalomEpisodeValid: 1, slalomFurthestForwardM: forwardDistance })
  }
  metrics.slalomFurthestForwardM = Math.max(metrics.slalomFurthestForwardM, forwardDistance)
  metrics.slalomBacktrackM = metrics.slalomFurthestForwardM - forwardDistance
  if (metrics.slalomFlagsPassed > 0 && metrics.slalomBacktrackM > SLALOM_BACKTRACK_ALLOWANCE_M + 1e-8) return interrupt(9)
  if (previous) {
    let count = metrics.slalomFlagsPassed
    while (count < flags.length) {
      const passage = slalomFlagCrossing(previous.state.positionM, position, flags[count])
      if (!passage) break
      if (!passage.insidePassage) {
        const reason = !passage.heightValid ? 7 : passage.sideOffsetM < 0 ? 4 : passage.sideOffsetM < 1 ? 5 : 6
        return interrupt(reason, passage.sideOffsetM, passage.altitudeM)
      }
      checkpointIds.push(flags[count].id)
      count += 1
      metrics.slalomFlagsPassed = count
    }
    if (count < flags.length && position.z < flags[count].positionM.z - 0.05) return interrupt(8)
    const crossedExit = position.z < previous.state.positionM.z && previous.state.positionM.z >= exitZ && position.z <= exitZ
    if (count === flags.length && crossedExit) {
      const fraction = (exitZ - previous.state.positionM.z) / (position.z - previous.state.positionM.z)
      const exitX = previous.state.positionM.x + (position.x - previous.state.positionM.x) * fraction
      const exitY = previous.state.positionM.y + (position.y - previous.state.positionM.y) * fraction - contact.heightM
      if (Math.abs(exitX - launch.positionM.x) > 12 || exitY < 1 || exitY > 10) return interrupt(10, metrics.slalomSideOffsetM, exitY)
      metrics.slalomExited = 1
      checkpointIds.push('slalom-exit')
    }
  }
  const validRoute = metrics.slalomEpisodeValid > 0.5 && metrics.slalomFlagsPassed === flags.length && metrics.slalomExited > 0.5
  const recovered = validRoute && position.z <= exitZ + 1e-8 && metrics.tiltDegrees <= 50 && metrics.bodyRateDegreesPerSecond <= 180
    && metrics.verticalSpeedMps >= -6 && metrics.verticalSpeedMps <= 6 && metrics.horizontalSpeedMps <= 25
  metrics.slalomRecoveryQualifying = recovered ? 1 : 0
  metrics.slalomRecoveryDwellSeconds = recovered && previousMetric(context, 'slalomRecoveryQualifying') > 0.5
    ? metrics.slalomRecoveryDwellSeconds + delta : 0
  if (metrics.slalomRecoveryDwellSeconds + 1e-8 >= SLALOM_RECOVERY_SECONDS) {
    metrics.slalomRecovered = 1
    checkpointIds.push('slalom-recovered')
  }
  updateTarget()
  return validRoute && metrics.slalomRecovered > 0.5
    ? { status: 'success', metrics, checkpointIds, score: 100, message: '已一路向前，依序左右交替通過六旗，離場後恢復控制。', hint: '刀旗 S 彎完成；不需要降落或懸停。' }
    : continuing()
}

export const slalomEvaluator: LessonEvaluatorContract = { evaluate: evaluateSlalom }
export const SLALOM_LESSON: LessonDefinition = {
  id: 'slalom', priority: 17.5, title: '刀旗 S 彎', availability: 'available', available: true,
  description: '從地面起飛，沿六面刀旗一路向前，依序左、右交替切彎，最後向前飛離並恢復正飛。',
  objectives: ['辨認六面刀旗的通過側與前進方向。', '讓實際航跡連續左右換向，不用固定側立角度、原地晃動或繞圈代替。', '配合姿態與油門維持可控高度，最後向前離場。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface', ...SLALOM_FLAG_IDS, 'slalom-exit'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'slalom-ground', title: '地面開始', description: '起飛區實際接地，低油門明確解鎖。' },
    { id: 'slalom-liftoff', title: '自行起飛', description: '自行離地，建議約 4 m，不用先懸停。' },
    ...SLALOM_FLAG_IDS.map((id, index) => ({ id, title: `第 ${index + 1} 旗：${index % 2 === 0 ? '左' : '右'}側通過`, description: `向前通過第 ${index + 1} 面刀旗的${index % 2 === 0 ? '左' : '右'}側，換邊銜接下一彎。` })),
    { id: 'slalom-exit', title: '向前離開旗列', description: '六旗後繼續向前飛過離場標記，不用停住。' },
    { id: 'slalom-recovered', title: '恢復正飛與控制', description: '減緩旋轉與升降，修回正飛確認 0.2 秒，不用懸停或降落。' },
  ],
  success: { title: '刀旗 S 彎完成', description: '已從地面起飛，在同一段有效前進路線交替通過六旗並離場恢復控制。', criteria: ['實際地面起飛', '左、右交替依序通過六旗', '向前離場並恢復正飛'] },
  failure: { title: '刀旗 S 彎尚未完成', description: '走錯側、漏旗或回頭可重新進場；碰旗墜毀或資料無效需重設。', criteria: ['不能原地翻滾代替實際路線', '不能從旗列外側直線繞過', '不能拼接中斷前後的通旗證據'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0,
    metricLabels: ['slalomFlagsPassed', 'slalomNextFlagDistanceM', 'slalomSideOffsetM', 'slalomForwardSpeedMps', 'altitudeM', 'slalomRecoveryDwellSeconds'] },
  hints: ['先起飛至約 4 m，第一旗左側、第二旗右側，沿旗列一路向前交替切彎；不要求固定傾角或精準速度。'], evaluator: slalomEvaluator,
}
export const SLALOM_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L18', title: '刀旗 S 彎', level: '近障礙航線', prerequisiteIds: ['coordinated-turn', 'figure-eight', 'wide-gate'],
  objectives: ['掌握前進中的左右連續切彎與提前量。', '依刀旗間距調整速度與換邊節奏，完成實際 S 形航跡。'],
  steps: ['從地面自行起飛至約 4 m，認清第一旗左側及沿旗列向前的方向。', '逐旗從左、右交替的一側通過；旗間距 12 m，不要求貼旗、固定傾角或停住。', '用橫滾、俯仰、偏航與油門配合實際航線，換邊時留意高度與下一面旗。', '第六旗後繼續向前飛離，再修回正飛、減緩升降與旋轉，不用懸停或降落。'],
  commonMistakes: ['只左右晃動機身，實際卻沿同一側直飛。', '漏過一旗後直接追下一旗，或回頭繞同一組旗。', '太貼刀旗撞到機體或螺旋槳。', '換邊時只顧轉向，忽略高度與前進速度。'],
}
