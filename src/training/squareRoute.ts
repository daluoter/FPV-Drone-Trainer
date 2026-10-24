import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import { TRAINING_ROUTE_ALTITUDE_AGL_M } from './field'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const SQUARE_ROUTE_TARGET_RADIUS_M = 1.8
export const SQUARE_ROUTE_EDGE_TOLERANCE_M = 0.1
export const SQUARE_ROUTE_HEADING_TOLERANCE_DEGREES = 70
export const SQUARE_ROUTE_TIME_LIMIT_SECONDS = 240

export interface SquareRouteTarget {
  readonly id: string
  readonly label: string
  readonly kind: 'leg' | 'corner' | 'finish'
  readonly leg: 1 | 2 | 3 | 4
  readonly positionM: Vector3
  readonly headingForward: Vector3
}

const RADIUS_M = SQUARE_ROUTE_TARGET_RADIUS_M + SQUARE_ROUTE_EDGE_TOLERANCE_M
const FORWARD = Object.freeze({ x: 0, y: 0, z: -1 })
const RIGHT = Object.freeze({ x: 1, y: 0, z: 0 })
const BACK = Object.freeze({ x: 0, y: 0, z: 1 })
const LEFT = Object.freeze({ x: -1, y: 0, z: 0 })
const TARGET_LAYOUT = [
  { id: 'square-leg-1', label: '第一邊直線', kind: 'leg', leg: 1, x: 0, z: -6, headingForward: FORWARD },
  { id: 'square-corner-1', label: '第一個右轉角', kind: 'corner', leg: 1, x: 0, z: -12, headingForward: Object.freeze({ x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 }) },
  { id: 'square-leg-2', label: '第二邊直線', kind: 'leg', leg: 2, x: 6, z: -12, headingForward: RIGHT },
  { id: 'square-corner-2', label: '第二個右轉角', kind: 'corner', leg: 2, x: 12, z: -12, headingForward: Object.freeze({ x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }) },
  { id: 'square-leg-3', label: '第三邊直線', kind: 'leg', leg: 3, x: 12, z: -6, headingForward: BACK },
  { id: 'square-corner-3', label: '第三個右轉角', kind: 'corner', leg: 3, x: 12, z: 0, headingForward: Object.freeze({ x: -Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }) },
  { id: 'square-leg-4', label: '第四邊直線', kind: 'leg', leg: 4, x: 6, z: 0, headingForward: LEFT },
  { id: 'square-finish', label: '回到起點上方', kind: 'finish', leg: 4, x: 0, z: 0, headingForward: LEFT },
] as const

export const SQUARE_ROUTE_TARGET_IDS = Object.freeze(TARGET_LAYOUT.map(({ id }) => id))

/** Shared, immutable field geometry for the lesson, renderer and recorded example. */
export function createSquareRouteTargets(launch: Vector3, groundHeightM: number): readonly SquareRouteTarget[] {
  return Object.freeze(TARGET_LAYOUT.map(({ id, label, kind, leg, x, z, headingForward }) => Object.freeze({
    id, label, kind, leg, headingForward,
    positionM: Object.freeze({ x: launch.x + x, y: groundHeightM + TRAINING_ROUTE_ALTITUDE_AGL_M, z: launch.z + z }),
  })))
}

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', metrics, message, hint: '先 Disarm 停止馬達，再重設課程並自行起飛。' }
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function headingError(a: Vector3, b: Vector3): number {
  const length = Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z)
  return length > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.z * b.z) / length))) * 180 / Math.PI : 180
}

function intersectsTarget(before: Vector3 | undefined, current: Vector3, target: Vector3): boolean {
  if (distance(current, target) <= RADIUS_M) return true
  if (!before) return false
  const delta = { x: current.x - before.x, y: current.y - before.y, z: current.z - before.z }
  const lengthSquared = delta.x * delta.x + delta.y * delta.y + delta.z * delta.z
  if (lengthSquared <= 1e-12) return false
  const fraction = Math.max(0, Math.min(1, ((target.x - before.x) * delta.x + (target.y - before.y) * delta.y + (target.z - before.z) * delta.z) / lengthSquared))
  return distance({ x: before.x + fraction * delta.x, y: before.y + fraction * delta.y, z: before.z + fraction * delta.z }, target) <= RADIUS_M
}

function targetFacts(sample: TrainingSample, target: SquareRouteTarget): Readonly<Record<string, number>> {
  const delta = { x: target.positionM.x - sample.state.positionM.x, y: target.positionM.y - sample.state.positionM.y, z: target.positionM.z - sample.state.positionM.z }
  const body = inverseRotateVectorByQuaternion(sample.state.orientation, delta)
  return {
    targetDistanceM: Math.hypot(delta.x, delta.y, delta.z),
    targetRightM: body.x, targetForwardM: -body.z, targetUpM: body.y,
    targetAltitudeM: target.positionM.y - (sample.groundContact?.heightM ?? 0),
  }
}

function evaluateSquareRoute(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('方形航線停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('方形航線停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('方形航線停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }

  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('方形航線缺少有效的起飛點或地面參考，請重設訓練場。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('方形航線停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const groundClearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (groundClearance < -0.003 || (contact.touching && Math.abs(groundClearance) > 0.003)) return terminal('方形航線停止：接地標記與機體支撐高度不一致。')

  const previous = context.previousFlightSample ?? context.previousSample
  const targets = createSquareRouteTargets(launch.positionM, surface.positionM.y)
  const grounded = context.checkpoints['square-ground']?.completed === true
  let lifted = context.checkpoints['square-liftoff']?.completed === true
  let targetIndex = 0
  while (targetIndex < targets.length && context.checkpoints[targets[targetIndex].id]?.completed) targetIndex += 1
  const target = targets[Math.min(targetIndex, targets.length - 1)]
  const airborne = !contact.touching && groundClearance >= 0.15
  const forward = rotateVectorByQuaternion(sample.state.orientation, FORWARD)
  const errorDegrees = headingError(forward, target.headingForward)
  const metrics: Record<string, number> = {
    groundClearanceM: groundClearance, altitudeM: position.y - surface.positionM.y,
    launchDistanceM: Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z), groundTouching: contact.touching ? 1 : 0,
    squarePhase: !grounded ? 0 : !lifted ? 1 : targetIndex + 2,
    squareTargetIndex: targetIndex, squareTargetsCompleted: targetIndex,
    squareLeg: target.leg, squareLegsCompleted: Math.floor(targetIndex / 2),
    headingErrorDegrees: errorDegrees, ...targetFacts(sample, target),
  }
  if (previous) {
    const delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('方形航線停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('方形航線停止：位置跳躍與速度不一致，不能跳過目標。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > SQUARE_ROUTE_TIME_LIMIT_SECONDS) return terminal('方形航線挑戰逾時：尚未完成四邊與返回起點上方。', metrics)

  const checkpointIds: string[] = []
  if (!grounded) {
    const onLaunchGround = contact.touching && metrics.launchDistanceM <= RADIUS_M
    if (onLaunchGround) checkpointIds.push('square-ground')
    return { status: 'continue', checkpointIds, metrics: { ...metrics, squarePhase: onLaunchGround ? 1 : 0 }, hint: onLaunchGround
      ? '地面準備完成；自行加油門起飛，先向前飛往第一邊目標。'
      : '請先在起飛區實際接地，再自行起飛；不能從空中跳過地面開始。' }
  }
  if (!lifted) {
    lifted = airborne
    if (!lifted) return { status: 'continue', metrics, hint: `尚未觀察到實際起飛：支撐點離地 ${Math.max(0, groundClearance).toFixed(2)} m；緩慢增加油門，建議高度約 3 m。` }
    checkpointIds.push('square-liftoff')
    metrics.squarePhase = 2
  }
  if (targetIndex >= targets.length) return { status: 'success', checkpointIds, metrics: { ...metrics, squarePhase: 10 }, score: 100, message: '已完成方形航線四邊並返回起點上方。' }
  const near = intersectsTarget(previous?.state.positionM, position, target.positionM)
  const correctHeading = errorDegrees <= SQUARE_ROUTE_HEADING_TOLERANCE_DEGREES + 1e-8
  if (airborne && near && correctHeading) {
    checkpointIds.push(target.id)
    targetIndex += 1
    metrics.squareTargetIndex = targetIndex
    metrics.squareTargetsCompleted = targetIndex
    metrics.squareLegsCompleted = Math.floor(targetIndex / 2)
    metrics.squarePhase = targetIndex + 2
    if (targetIndex >= targets.length) return {
      status: 'success', checkpointIds, score: 100, metrics: { ...metrics, squarePhase: 10 },
      message: '已從地面自行起飛，依序完成四邊直線與轉彎目標，並回到起點上方。',
      hint: '方形航線目標已完成，不要求降落。先 Disarm，再查看結果與回放。',
    }
    const next = targets[targetIndex]
    Object.assign(metrics, targetFacts(sample, next), { headingErrorDegrees: headingError(forward, next.headingForward), squareLeg: next.leg })
    return { status: 'continue', checkpointIds, metrics, hint: `「${target.label}」完成。下一步：${next.label}。沿亮起目標繼續飛行；已完成的步驟會保留，不需停穩。` }
  }

  let action: string
  if (!airborne) action = '目前尚未在空中；可以就地再次起飛，已完成的目標會保留。'
  else if (!near) action = '朝目前亮起的目標移動；方向提示以目前機頭為準。飛入目標區即可，不要求精準速度或停留。'
  else action = `機頭朝向偏差 ${errorDegrees.toFixed(0)}°，需在 ${SQUARE_ROUTE_HEADING_TOLERANCE_DEGREES}° 內；用小量偏航與傾斜讓機頭跟著方形航線轉向。`
  return { status: 'continue', checkpointIds, metrics, hint: `${target.label}：${action}` }
}

export const squareRouteEvaluator: LessonEvaluatorContract = { evaluate: evaluateSquareRoute }

export const SQUARE_ROUTE_LESSON: LessonDefinition = {
  id: 'square-route', priority: 2.2, title: '方形航線', availability: 'available', available: true,
  description: '從地面自行起飛，串接四邊直線與右轉，依序通過目標並返回起點上方。',
  objectives: ['自行起飛後依序飛完四邊及轉角目標，最後回到起點上方。', '保持機頭大致跟著航線，小量配合 Roll、Yaw、Pitch 與油門完成連續飛行。', '不要求精準速度、停留或降落；漏點及未墜毀接地會保留進度。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'square-ground', title: '地面開始', description: '在起飛區實際地面開始。' },
    { id: 'square-liftoff', title: '自行起飛', description: '自行起飛後前往第一邊，不必先懸停。' },
    ...TARGET_LAYOUT.map(({ id, label }) => ({ id, title: label, description: `依序飛入${label}，讓機頭大致跟著航線。` })),
  ],
  success: { title: '方形航線完成', description: '已依序完成四邊與轉角，返回起點上方。', criteria: ['地面自行起飛', '依序通過八個目標', '返回起點上方'] },
  failure: { title: '方形航線尚未完成', description: '漏點及一般偏離保留進度；墜毀或無效資料需重試。', criteria: ['不能只轉機頭代替飛行', '不能瞬移或使用示範通關'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['squareLegsCompleted', 'squareTargetsCompleted', 'targetDistanceM', 'altitudeM'] },
  hints: ['先往前飛，再依序向右轉串接四邊，飛入最後起點上方的目標即可完成。'],
  evaluator: squareRouteEvaluator,
}

export const SQUARE_ROUTE_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L06', title: '方形航線', level: '基礎航線', prerequisiteIds: ['coordinated-turn'],
  objectives: ['把直線與轉彎串成完整四邊航線。', '依序通過目標，最後返回起點上方。'],
  steps: ['從地面自行起飛，建議高度約三公尺；先向前飛入第一邊目標。', '直線段小量保持前進與高度，接近轉角時看向下一邊，以 Roll、Yaw 配合帶入右轉。', '沿第一、第二、第三、第四邊的目標依序飛行，不用貼住地面虛線或精準停穩。', '最後飛回起點上方的空中目標即可完成，不要求降落，也不必轉回初始朝向。', '漏點可繞回目前亮起目標補飛；未墜毀接地可就地再起飛，已完成步驟保留。'],
  commonMistakes: ['提早切角或直接飛回起點，漏掉目前應通過的目標；依亮起的目前目標補飛即可。', '轉彎後仍以原場地方向判斷前方；目標方向提示依目前機頭計算，固定 XYZ 不隨機頭改變。'],
}
