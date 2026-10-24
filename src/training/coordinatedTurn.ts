import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import { TRAINING_ROUTE_ALTITUDE_AGL_M } from './field'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const COORDINATED_TURN_TARGET_RADIUS_M = 1.8
export const COORDINATED_TURN_EDGE_TOLERANCE_M = 0.1
export const COORDINATED_TURN_HEADING_TOLERANCE_DEGREES = 70
export const COORDINATED_TURN_MINIMUM_CHANGE_DEGREES = 25
export const COORDINATED_TURN_TIME_LIMIT_SECONDS = 180

export interface CoordinatedTurnTarget {
  readonly id: string
  readonly label: string
  readonly direction: 'right' | 'left'
  readonly stage: 'entry' | 'apex' | 'exit'
  readonly positionM: Vector3
  readonly headingForward: Vector3
}

const RADIUS_M = COORDINATED_TURN_TARGET_RADIUS_M + COORDINATED_TURN_EDGE_TOLERANCE_M
const FORWARD = Object.freeze({ x: 0, y: 0, z: -1 })
const DIAGONAL = Object.freeze({ x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 })
const RIGHT = Object.freeze({ x: 1, y: 0, z: 0 })
const TARGET_LAYOUT = [
  { id: 'turn-right-entry', label: '右轉入口', direction: 'right', stage: 'entry', x: 0, z: -6, headingForward: FORWARD },
  { id: 'turn-right-apex', label: '右轉彎中', direction: 'right', stage: 'apex', x: 2, z: -10, headingForward: DIAGONAL },
  { id: 'turn-right-exit', label: '右轉出口', direction: 'right', stage: 'exit', x: 6, z: -12, headingForward: RIGHT },
  { id: 'turn-left-entry', label: '左轉入口', direction: 'left', stage: 'entry', x: 10, z: -12, headingForward: RIGHT },
  { id: 'turn-left-apex', label: '左轉彎中', direction: 'left', stage: 'apex', x: 14, z: -14, headingForward: DIAGONAL },
  { id: 'turn-left-exit', label: '左轉出口', direction: 'left', stage: 'exit', x: 16, z: -18, headingForward: FORWARD },
] as const

export const COORDINATED_TURN_TARGET_IDS = Object.freeze(TARGET_LAYOUT.map(({ id }) => id))

/** The visible guides and evaluator use the same supported launch and ground. */
export function createCoordinatedTurnTargets(launch: Vector3, groundHeightM: number): readonly CoordinatedTurnTarget[] {
  return Object.freeze(TARGET_LAYOUT.map(({ id, label, direction, stage, x, z, headingForward }) => Object.freeze({
    id, label, direction, stage, headingForward,
    positionM: Object.freeze({ x: launch.x + x, y: groundHeightM + TRAINING_ROUTE_ALTITUDE_AGL_M, z: launch.z + z }),
  })))
}

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', metrics, message, hint: '先 Disarm 停止馬達，再重設課程並自行起飛。' }
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function horizontalUnit(value: Vector3): Vector3 | null {
  const length = Math.hypot(value.x, value.z)
  return isFiniteVector3(value) && length > 1e-6 ? { x: value.x / length, y: 0, z: value.z / length } : null
}

function headingError(a: Vector3, b: Vector3): number {
  const left = horizontalUnit(a)
  const right = horizontalUnit(b)
  return left && right ? Math.acos(Math.max(-1, Math.min(1, left.x * right.x + left.z * right.z))) * 180 / Math.PI : 180
}

function actualMotion(sample: TrainingSample, previous: TrainingSample | null | undefined): Vector3 | null {
  if (Math.hypot(sample.state.velocityMps.x, sample.state.velocityMps.z) > 0.05) return horizontalUnit(sample.state.velocityMps)
  return previous ? horizontalUnit({
    x: sample.state.positionM.x - previous.state.positionM.x,
    y: 0,
    z: sample.state.positionM.z - previous.state.positionM.z,
  }) : null
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

function targetFacts(sample: TrainingSample, target: CoordinatedTurnTarget): Readonly<Record<string, number>> {
  const delta = { x: target.positionM.x - sample.state.positionM.x, y: target.positionM.y - sample.state.positionM.y, z: target.positionM.z - sample.state.positionM.z }
  const body = inverseRotateVectorByQuaternion(sample.state.orientation, delta)
  return {
    targetDistanceM: Math.hypot(delta.x, delta.y, delta.z),
    targetRightM: body.x, targetForwardM: -body.z, targetUpM: body.y,
    targetAltitudeM: target.positionM.y - (sample.groundContact?.heightM ?? 0),
  }
}

function turnFacts(target: CoordinatedTurnTarget, context: TrainingEvaluationContext, motion: Vector3 | null): Readonly<Record<string, number>> {
  const entry = context.checkpoints[`turn-${target.direction}-entry`]?.metrics
  const entryHeading = horizontalUnit({ x: entry?.turnEntryHeadingX ?? Number.NaN, y: 0, z: entry?.turnEntryHeadingZ ?? Number.NaN })
  const direction = target.direction === 'right' ? 1 : -1
  const signedChange = entryHeading && motion
    ? Math.atan2(entryHeading.x * motion.z - entryHeading.z * motion.x, entryHeading.x * motion.x + entryHeading.z * motion.z) * 180 / Math.PI * direction : 0
  return { turnDirection: direction, turnEntryRecorded: entryHeading ? 1 : 0, turnChangeDegrees: signedChange }
}

function evaluateCoordinatedTurn(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('轉彎練習停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('轉彎練習停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('轉彎練習停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }

  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('轉彎練習缺少有效的起飛點或地面參考，請重設訓練場。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('轉彎練習停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const groundClearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (groundClearance < -0.003 || (contact.touching && Math.abs(groundClearance) > 0.003)) return terminal('轉彎練習停止：接地標記與機體支撐高度不一致。')

  const previous = context.previousFlightSample ?? context.previousSample
  const targets = createCoordinatedTurnTargets(launch.positionM, surface.positionM.y)
  const grounded = context.checkpoints['turn-ground']?.completed === true
  let lifted = context.checkpoints['turn-liftoff']?.completed === true
  let targetIndex = 0
  while (targetIndex < targets.length && context.checkpoints[targets[targetIndex].id]?.completed) targetIndex += 1
  const target = targets[Math.min(targetIndex, targets.length - 1)]
  const airborne = !contact.touching && groundClearance >= 0.15
  const currentMotion = airborne ? actualMotion(sample, previous) : null
  const lastMetrics = context.previousEvaluation?.metrics
  const retainedMotion = horizontalUnit({ x: lastMetrics?.turnLastMotionX ?? Number.NaN, y: 0, z: lastMetrics?.turnLastMotionZ ?? Number.NaN })
  // A learner may stop inside the exit without losing the already measured line.
  // Ground rolling never updates this airborne trajectory direction.
  const motion = currentMotion ?? retainedMotion
  const forward = rotateVectorByQuaternion(sample.state.orientation, FORWARD)
  const errorDegrees = headingError(forward, target.headingForward)
  const metrics: Record<string, number> = {
    groundClearanceM: groundClearance, altitudeM: position.y - surface.positionM.y,
    launchDistanceM: Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z), groundTouching: contact.touching ? 1 : 0,
    turnPhase: !grounded ? 0 : !lifted ? 1 : targetIndex + 2,
    turnTargetIndex: targetIndex, turnTargetsCompleted: targetIndex,
    turnMotionReady: (target.stage === 'entry' ? currentMotion : motion) ? 1 : 0,
    headingErrorDegrees: errorDegrees,
    rightTurnChangeDegrees: context.checkpoints['turn-right-exit']?.metrics.rightTurnChangeDegrees ?? 0,
    leftTurnChangeDegrees: context.checkpoints['turn-left-exit']?.metrics.leftTurnChangeDegrees ?? 0,
    ...targetFacts(sample, target), ...turnFacts(target, context, motion),
    ...(motion ? { turnLastMotionX: motion.x, turnLastMotionZ: motion.z } : {}),
  }
  if (previous) {
    const delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('轉彎練習停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('轉彎練習停止：位置跳躍與速度不一致，不能跳過目標。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > COORDINATED_TURN_TIME_LIMIT_SECONDS) return terminal('轉彎挑戰逾時：尚未依序完成右轉與左轉路線。', metrics)

  const checkpointIds: string[] = []
  if (!grounded) {
    const onLaunchGround = contact.touching && metrics.launchDistanceM <= RADIUS_M
    if (onLaunchGround) checkpointIds.push('turn-ground')
    return { status: 'continue', checkpointIds, metrics: { ...metrics, turnPhase: onLaunchGround ? 1 : 0 }, hint: onLaunchGround
      ? '地面準備完成；自行加油門起飛，先朝前方右轉入口移動。'
      : '請先在起飛區實際接地，再自行起飛；不能從空中跳過地面開始。' }
  }
  if (!lifted) {
    lifted = airborne
    if (!lifted) return { status: 'continue', metrics, hint: `尚未觀察到實際起飛：支撐點離地 ${Math.max(0, groundClearance).toFixed(2)} m；緩慢增加油門，建議高度約 3 m。` }
    checkpointIds.push('turn-liftoff')
    metrics.turnPhase = 2
  }
  if (targetIndex >= targets.length) return { status: 'success', checkpointIds, metrics: { ...metrics, turnPhase: 8 }, score: 100, message: '已完成右轉及左轉的實際飛行路線。' }
  const near = intersectsTarget(previous?.state.positionM, position, target.positionM)
  const correctHeading = errorDegrees <= COORDINATED_TURN_HEADING_TOLERANCE_DEGREES + 1e-8
  const measuredTurn = target.stage !== 'exit' || (metrics.turnEntryRecorded === 1 && metrics.turnChangeDegrees + 1e-8 >= COORDINATED_TURN_MINIMUM_CHANGE_DEGREES)
  const measurableEntry = target.stage !== 'entry' || currentMotion !== null
  if (airborne && near && correctHeading && measuredTurn && measurableEntry) {
    checkpointIds.push(target.id)
    if (target.stage === 'entry' && currentMotion) {
      metrics.turnEntryHeadingX = currentMotion.x
      metrics.turnEntryHeadingZ = currentMotion.z
      metrics.turnEntryRecorded = 1
    }
    if (target.stage === 'exit') metrics[target.direction === 'right' ? 'rightTurnChangeDegrees' : 'leftTurnChangeDegrees'] = metrics.turnChangeDegrees
    targetIndex += 1
    metrics.turnTargetIndex = targetIndex
    metrics.turnTargetsCompleted = targetIndex
    metrics.turnPhase = targetIndex + 2
    if (targetIndex >= targets.length) return {
      status: 'success', checkpointIds, score: 100, metrics: { ...metrics, turnPhase: 8 },
      message: '已從地面起飛，依序完成右轉與左轉的入口、彎中與出口，並觀察到實際航線轉向。',
      hint: '本課目標已完成。先 Disarm，再查看結果與回放。',
    }
    const next = targets[targetIndex]
    Object.assign(metrics, targetFacts(sample, next), { headingErrorDegrees: headingError(forward, next.headingForward), turnDirection: next.direction === 'right' ? 1 : -1 })
    if (next.direction !== target.direction) Object.assign(metrics, { turnEntryRecorded: 0, turnChangeDegrees: 0 })
    return { status: 'continue', checkpointIds, metrics, hint: `「${target.label}」完成。下一步：${next.label}。沿亮起目標繼續飛行；已完成的步驟會保留，不需停穩。` }
  }

  let action: string
  if (!airborne) action = '目前尚未在空中；可以就地再次起飛，已完成的目標會保留。'
  else if (!near) action = '朝目前亮起的目標移動；方向提示以目前機頭為準。飛入目標區即可，不要求精準速度或停留。'
  else if (!correctHeading) action = `機頭朝向偏差 ${errorDegrees.toFixed(0)}°，需在 ${COORDINATED_TURN_HEADING_TOLERANCE_DEGREES}° 內；用小量偏航讓機頭跟著航線轉向。`
  else if (!measurableEntry) action = '入口尚未觀察到實際水平移動；輕推 Pitch 往航線前進，原地轉頭不算入彎。'
  else if (metrics.turnEntryRecorded === 0) action = '尚缺此彎入口的移動方向紀錄，請重設課程後依序飛過入口。'
  else action = `實際航線向${target.direction === 'right' ? '右' : '左'}轉 ${metrics.turnChangeDegrees.toFixed(0)}°，出口需至少 ${COORDINATED_TURN_MINIMUM_CHANGE_DEGREES}°；配合 Roll、Yaw 與 Pitch 讓移動方向一起轉彎，只轉機頭不算。`
  return { status: 'continue', checkpointIds, metrics, hint: `${target.label}：${action}` }
}

export const beginnerCoordinatedTurnEvaluator: LessonEvaluatorContract = { evaluate: evaluateCoordinatedTurn }

export const COORDINATED_TURN_LESSON: LessonDefinition = {
  id: 'coordinated-turn', priority: 2, title: '協調轉彎', availability: 'available', available: true,
  description: '從地面自行起飛，依序飛過右轉及左轉的入口、彎中與出口，讓機頭及實際航線一起轉向。',
  objectives: ['自行起飛後依序飛入右轉的三個目標，再接左轉的三個目標。', '用 Roll 建立傾斜、Yaw 轉向並配合 Pitch 與油門，讓實際移動方向也跟著改變。', '不要求精準速度或停留；一般漏點或未墜毀接地會保留進度。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'turn-ground', title: '地面開始', description: '在起飛區實際地面開始。' },
    { id: 'turn-liftoff', title: '自行起飛', description: '自行離地後前往右轉入口，不必先懸停。' },
    ...TARGET_LAYOUT.map(({ id, label, direction, stage }) => ({ id, title: label, description: stage === 'exit'
      ? `依序完成${direction === 'right' ? '右' : '左'}轉並觀察實際航線轉向；只轉機頭不算。` : `飛入${label}，保持機頭大致順著路線。` })),
  ],
  success: { title: '協調轉彎完成', description: '已自行起飛並依序完成實際右轉與左轉航線。', criteria: ['從地面自行起飛', '依序飛入六個目標', '實際航線向右及向左轉彎'] },
  failure: { title: '轉彎路線尚未完成', description: '漏點及一般偏離可保留進度；墜毀或無效飛行資料需重試。', criteria: ['不能以原地偏航代替航線轉向', '不能瞬移、重設或使用示範通關'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['turnTargetsCompleted', 'targetDistanceM', 'turnChangeDegrees', 'altitudeM'] },
  hints: ['先進入右轉入口，再沿亮起目標練右轉與左轉；讓實際移動方向跟著機頭轉向。'],
  evaluator: beginnerCoordinatedTurnEvaluator,
}

export const COORDINATED_TURN_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L05', title: '協調轉彎', level: '基礎航線', prerequisiteIds: ['direction-control'],
  objectives: ['依序完成右轉及左轉的入口、彎中與出口。', '理解轉機頭與改變飛行路線的差別，練習多軸小量配合。'],
  steps: ['從地面自行加油門起飛，建議高度約三公尺；先朝右轉入口移動。', '入彎後用小量 Roll 建立傾斜，配合 Yaw 讓機頭朝向下一個目標，並以 Pitch 與油門保持前進及高度。', '依序飛入右轉的入口、彎中與出口，再接左轉的三個目標。', '出口需要實際移動方向相對入口朝指定方向改變至少 25°，只原地偏航不算；不用精準速度或停穩。', '漏點可補飛，未墜毀接地可就地再次起飛；已完成的目標會保留。'],
  commonMistakes: ['只有機頭轉向，但機體仍沿原方向滑行；觀察目標相對位置，再小量配合 Roll 與 Pitch 修正路線。', '大幅傾斜後忘記維持高度；縮小輸入並以油門修正，Acro 回中不會自動回平。'],
}
