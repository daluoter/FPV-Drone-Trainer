import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import { TRAINING_ROUTE_ALTITUDE_AGL_M } from './field'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const FIGURE_EIGHT_TARGET_RADIUS_M = 1.8
export const FIGURE_EIGHT_EDGE_TOLERANCE_M = 0.1
export const FIGURE_EIGHT_HEADING_TOLERANCE_DEGREES = 70
export const FIGURE_EIGHT_TIME_LIMIT_SECONDS = 300

export interface FigureEightTarget {
  readonly id: string
  readonly label: string
  readonly kind: 'entry' | 'arc' | 'crossing' | 'finish'
  readonly loop: 1 | 2
  readonly positionM: Vector3
  readonly headingForward: Vector3
}

const RADIUS_M = FIGURE_EIGHT_TARGET_RADIUS_M + FIGURE_EIGHT_EDGE_TOLERANCE_M
const FORWARD = Object.freeze({ x: 0, y: 0, z: -1 })
const RIGHT = Object.freeze({ x: 1, y: 0, z: 0 })
const BACK = Object.freeze({ x: 0, y: 0, z: 1 })
const LEFT = Object.freeze({ x: -1, y: 0, z: 0 })
const TARGET_LAYOUT = [
  { id: 'eight-entry', label: '中央入口', kind: 'entry', loop: 1, x: 0, z: -6, headingForward: FORWARD },
  { id: 'eight-left-top', label: '左圈前段', kind: 'arc', loop: 1, x: -6, z: -12, headingForward: LEFT },
  { id: 'eight-left-outer', label: '左圈外側', kind: 'arc', loop: 1, x: -12, z: -6, headingForward: BACK },
  { id: 'eight-left-bottom', label: '左圈回程', kind: 'arc', loop: 1, x: -6, z: 0, headingForward: RIGHT },
  { id: 'eight-crossing', label: '中央換向點', kind: 'crossing', loop: 1, x: 0, z: -6, headingForward: FORWARD },
  { id: 'eight-right-top', label: '右圈前段', kind: 'arc', loop: 2, x: 6, z: -12, headingForward: RIGHT },
  { id: 'eight-right-outer', label: '右圈外側', kind: 'arc', loop: 2, x: 12, z: -6, headingForward: BACK },
  { id: 'eight-right-bottom', label: '右圈回程', kind: 'arc', loop: 2, x: 6, z: 0, headingForward: LEFT },
  { id: 'eight-finish', label: '中央終點', kind: 'finish', loop: 2, x: 0, z: -6, headingForward: FORWARD },
] as const

export const FIGURE_EIGHT_TARGET_IDS = Object.freeze(TARGET_LAYOUT.map(({ id }) => id))

/** Shared, immutable field geometry for the lesson, renderer and recorded example. */
export function createFigureEightTargets(launch: Vector3, groundHeightM: number): readonly FigureEightTarget[] {
  return Object.freeze(TARGET_LAYOUT.map(({ id, label, kind, loop, x, z, headingForward }) => Object.freeze({
    id, label, kind, loop, headingForward,
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

function targetFacts(sample: TrainingSample, target: FigureEightTarget): Readonly<Record<string, number>> {
  const delta = { x: target.positionM.x - sample.state.positionM.x, y: target.positionM.y - sample.state.positionM.y, z: target.positionM.z - sample.state.positionM.z }
  const body = inverseRotateVectorByQuaternion(sample.state.orientation, delta)
  return {
    targetDistanceM: Math.hypot(delta.x, delta.y, delta.z),
    targetRightM: body.x, targetForwardM: -body.z, targetUpM: body.y,
    targetAltitudeM: target.positionM.y - (sample.groundContact?.heightM ?? 0),
  }
}

function evaluateFigureEight(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('八字航線停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('八字航線停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('八字航線停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }

  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('八字航線缺少有效的起飛點或地面參考，請重設訓練場。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('八字航線停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const groundClearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (groundClearance < -0.003 || (contact.touching && Math.abs(groundClearance) > 0.003)) return terminal('八字航線停止：接地標記與機體支撐高度不一致。')

  const previous = context.previousFlightSample ?? context.previousSample
  const targets = createFigureEightTargets(launch.positionM, surface.positionM.y)
  const grounded = context.checkpoints['eight-ground']?.completed === true
  let lifted = context.checkpoints['eight-liftoff']?.completed === true
  let targetIndex = 0
  while (targetIndex < targets.length && context.checkpoints[targets[targetIndex].id]?.completed) targetIndex += 1
  const target = targets[Math.min(targetIndex, targets.length - 1)]
  const airborne = !contact.touching && groundClearance >= 0.15
  const forward = rotateVectorByQuaternion(sample.state.orientation, FORWARD)
  const errorDegrees = headingError(forward, target.headingForward)
  const metrics: Record<string, number> = {
    groundClearanceM: groundClearance, altitudeM: position.y - surface.positionM.y,
    launchDistanceM: Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z), groundTouching: contact.touching ? 1 : 0,
    eightPhase: !grounded ? 0 : !lifted ? 1 : targetIndex + 2,
    eightTargetIndex: targetIndex, eightTargetsCompleted: targetIndex,
    eightLoop: target.loop, eightLoopsCompleted: targetIndex >= 9 ? 2 : targetIndex >= 5 ? 1 : 0,
    headingErrorDegrees: errorDegrees, ...targetFacts(sample, target),
  }
  if (previous) {
    const delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('八字航線停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('八字航線停止：位置跳躍與速度不一致，不能跳過目標。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > FIGURE_EIGHT_TIME_LIMIT_SECONDS) return terminal('八字航線挑戰逾時：尚未完成左圈、中央換向與右圈。', metrics)

  const checkpointIds: string[] = []
  if (!grounded) {
    const onLaunchGround = contact.touching && metrics.launchDistanceM <= RADIUS_M
    if (onLaunchGround) checkpointIds.push('eight-ground')
    return { status: 'continue', checkpointIds, metrics: { ...metrics, eightPhase: onLaunchGround ? 1 : 0 }, hint: onLaunchGround
      ? '地面準備完成；自行加油門起飛，先向前飛往中央入口。'
      : '請先在起飛區實際接地，再自行起飛；不能從空中跳過地面開始。' }
  }
  if (!lifted) {
    lifted = airborne
    if (!lifted) return { status: 'continue', metrics, hint: `尚未觀察到實際起飛：支撐點離地 ${Math.max(0, groundClearance).toFixed(2)} m；緩慢增加油門，建議高度約 3 m。` }
    checkpointIds.push('eight-liftoff')
    metrics.eightPhase = 2
  }
  if (targetIndex >= targets.length) return { status: 'success', checkpointIds, metrics: { ...metrics, eightPhase: 11 }, score: 100, message: '已完成八字航線的左圈、中央換向與右圈。' }
  const near = intersectsTarget(previous?.state.positionM, position, target.positionM)
  const correctHeading = errorDegrees <= FIGURE_EIGHT_HEADING_TOLERANCE_DEGREES + 1e-8
  if (airborne && near && correctHeading) {
    checkpointIds.push(target.id)
    targetIndex += 1
    metrics.eightTargetIndex = targetIndex
    metrics.eightTargetsCompleted = targetIndex
    metrics.eightLoopsCompleted = targetIndex >= 9 ? 2 : targetIndex >= 5 ? 1 : 0
    metrics.eightPhase = targetIndex + 2
    if (targetIndex >= targets.length) return {
      status: 'success', checkpointIds, score: 100, metrics: { ...metrics, eightPhase: 11 },
      message: '已從地面自行起飛，依序完成左圈、中央換向與右圈，並回到中央終點。',
      hint: '八字航線目標已完成，不要求降落。先 Disarm，再查看結果與回放。',
    }
    const next = targets[targetIndex]
    Object.assign(metrics, targetFacts(sample, next), { headingErrorDegrees: headingError(forward, next.headingForward), eightLoop: next.loop })
    return { status: 'continue', checkpointIds, metrics, hint: `「${target.label}」完成。下一步：${next.label}。沿亮起目標繼續飛行；已完成的步驟會保留，不需停穩。` }
  }

  let action: string
  if (!airborne) action = '目前尚未在空中；可以就地再次起飛，已完成的目標會保留。'
  else if (!near) action = '朝目前亮起的目標移動；方向提示以目前機頭為準。飛入目標區即可，不要求精準速度或停留。'
  else action = `機頭朝向偏差 ${errorDegrees.toFixed(0)}°，需在 ${FIGURE_EIGHT_HEADING_TOLERANCE_DEGREES}° 內；用小量偏航與傾斜讓機頭跟著八字航線轉向。`
  return { status: 'continue', checkpointIds, metrics, hint: `${target.label}：${action}` }
}

export const figureEightEvaluator: LessonEvaluatorContract = { evaluate: evaluateFigureEight }

export const FIGURE_EIGHT_LESSON: LessonDefinition = {
  id: 'figure-eight', priority: 2.4, title: '八字航線', availability: 'available', available: true,
  description: '從地面自行起飛，先飛左圈，通過中央換向後再飛右圈，最後回到中央終點。',
  objectives: ['自行起飛後依序完成左圈、中央換向與右圈的目標。', '小量配合 Roll、Yaw、Pitch 與油門，練習由左轉切換為右轉。', '不要求精準速度、停留或降落；漏點及未墜毀接地會保留進度。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'eight-ground', title: '地面開始', description: '在起飛區實際地面開始。' },
    { id: 'eight-liftoff', title: '自行起飛', description: '自行離地後前往中央入口，不必先懸停。' },
    ...TARGET_LAYOUT.map(({ id, label }) => ({ id, title: label, description: `依序飛入${label}，讓機頭大致跟隨八字航線。` })),
  ],
  success: { title: '八字航線完成', description: '已依序完成左圈、中央換向與右圈，返回中央終點。', criteria: ['從地面自行起飛', '依序通過九個目標', '完成左右兩圈及中央換向'] },
  failure: { title: '八字航線尚未完成', description: '漏點及一般偏離保留進度；墜毀或無效資料需重試。', criteria: ['不能以原地轉頭或提前返回中央代替飛行', '不能瞬移或使用示範通關'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['eightLoopsCompleted', 'eightTargetsCompleted', 'targetDistanceM', 'altitudeM'] },
  hints: ['先進中央入口，依序飛左圈；返回中央後由左轉換成右轉，完成右圈再通過中央終點。'],
  evaluator: figureEightEvaluator,
}

export const FIGURE_EIGHT_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L07', title: '八字航線', level: '基礎航線', prerequisiteIds: ['square-route'],
  objectives: ['把左轉與右轉串接成完整八字航線。', '依序完成左圈、中央換向及右圈，辨認重複經過的中央目標。'],
  steps: ['從地面自行起飛，建議高度約三公尺；先向前飛入中央入口。', '用小量傾斜、偏航與前進串接左圈前段、外側和回程目標，油門修正高度。', '完成左圈後通過中央換向點，再由左轉切換為右轉，依序飛完右圈。', '最後飛回中央的空中終點即可完成，不要求降落、停穩或精準速度。', '中央入口、換向和終點位置相同，但必須依序完成左右兩圈；漏點可補飛，未墜毀接地可就地再次起飛。'],
  commonMistakes: ['提早飛回中央或直接切到另一圈，漏掉目前亮起目標；依序補飛即可，不必重做已完成步驟。', '返回中央後仍持續向同一側轉；先看下一個目標，再小量反向修正傾斜與偏航。'],
}
