import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import { TRAINING_ROUTE_ALTITUDE_AGL_M } from './field'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const DIRECTION_CONTROL_TARGET_RADIUS_M = 1.5
export const DIRECTION_CONTROL_EDGE_TOLERANCE_M = 0.1
export const DIRECTION_CONTROL_DISTANCE_M = 4
export const DIRECTION_CONTROL_TARGET_HEIGHT_AGL_M = TRAINING_ROUTE_ALTITUDE_AGL_M
export const DIRECTION_CONTROL_HEADING_TOLERANCE_DEGREES = 60
export const DIRECTION_CONTROL_YAW_TOLERANCE_DEGREES = 45
export const DIRECTION_CONTROL_MINIMUM_YAW_CHANGE_DEGREES = 45
export const DIRECTION_CONTROL_TIME_LIMIT_SECONDS = 180

export interface DirectionControlTarget {
  readonly id: string
  readonly label: string
  readonly kind: 'move' | 'yaw'
  readonly positionM: Vector3
  readonly headingForward: Vector3
}

const RADIUS_M = DIRECTION_CONTROL_TARGET_RADIUS_M + DIRECTION_CONTROL_EDGE_TOLERANCE_M
const FORWARD: Vector3 = Object.freeze({ x: 0, y: 0, z: -1 })
const TURNED_FORWARD: Vector3 = Object.freeze({ x: 1, y: 0, z: 0 })

const TARGET_LAYOUT = [
  { id: 'direction-right', label: '向右側移', x: 1, z: 0, kind: 'move', headingForward: FORWARD },
  { id: 'direction-left', label: '向左側移', x: -1, z: 0, kind: 'move', headingForward: FORWARD },
  { id: 'direction-forward', label: '向前移動', x: -1, z: -1, kind: 'move', headingForward: FORWARD },
  { id: 'direction-back', label: '向後移動', x: -1, z: 0, kind: 'move', headingForward: FORWARD },
  { id: 'direction-yaw', label: '轉向右方，重新辨認前方', x: -1, z: 0, kind: 'yaw', headingForward: TURNED_FORWARD },
  { id: 'direction-turned-forward', label: '換向後向前移動', x: 0, z: 0, kind: 'move', headingForward: TURNED_FORWARD },
  { id: 'direction-turned-right', label: '換向後向右側移', x: 0, z: 1, kind: 'move', headingForward: TURNED_FORWARD },
] as const

export const DIRECTION_CONTROL_TARGET_IDS = Object.freeze(TARGET_LAYOUT.map(({ id }) => id))

/** Fixed field targets shared by the scene, evaluator and physics-generated example. */
export function createDirectionControlTargets(launch: Vector3, groundHeightM: number): readonly DirectionControlTarget[] {
  return Object.freeze(TARGET_LAYOUT.map(({ id, label, x, z, kind, headingForward }) => Object.freeze({
    id, label, kind,
    positionM: Object.freeze({
      x: launch.x + x * DIRECTION_CONTROL_DISTANCE_M,
      y: groundHeightM + DIRECTION_CONTROL_TARGET_HEIGHT_AGL_M,
      z: launch.z + z * DIRECTION_CONTROL_DISTANCE_M,
    }),
    headingForward,
  })))
}

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', metrics, message, hint: '先 Disarm 停止馬達，再重設課程並自行起飛。' }
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function horizontalAngle(a: Vector3, b: Vector3): number {
  const aLength = Math.hypot(a.x, a.z)
  const bLength = Math.hypot(b.x, b.z)
  if (aLength < 1e-6 || bLength < 1e-6) return 180
  const cosine = (a.x * b.x + a.z * b.z) / (aLength * bLength)
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI
}

/** Continuous entry remains observable even if one fixed-step segment exits the far side. */
function intersectsTarget(before: Vector3 | undefined, current: Vector3, target: Vector3): boolean {
  if (distance(current, target) <= RADIUS_M) return true
  if (!before) return false
  const dx = current.x - before.x
  const dy = current.y - before.y
  const dz = current.z - before.z
  const lengthSquared = dx * dx + dy * dy + dz * dz
  if (lengthSquared <= 1e-12) return false
  const fraction = Math.max(0, Math.min(1,
    ((target.x - before.x) * dx + (target.y - before.y) * dy + (target.z - before.z) * dz) / lengthSquared,
  ))
  return distance({ x: before.x + fraction * dx, y: before.y + fraction * dy, z: before.z + fraction * dz }, target) <= RADIUS_M
}

function targetFacts(sample: TrainingSample, target: DirectionControlTarget): Readonly<Record<string, number>> {
  const delta = {
    x: target.positionM.x - sample.state.positionM.x,
    y: target.positionM.y - sample.state.positionM.y,
    z: target.positionM.z - sample.state.positionM.z,
  }
  const bodyDelta = inverseRotateVectorByQuaternion(sample.state.orientation, delta)
  return {
    targetDistanceM: Math.hypot(delta.x, delta.y, delta.z),
    targetRightM: bodyDelta.x,
    targetForwardM: -bodyDelta.z,
    targetUpM: bodyDelta.y,
    targetAltitudeM: target.positionM.y - (sample.groundContact?.heightM ?? 0),
  }
}

function relativeHint(metrics: Readonly<Record<string, number>>): string {
  const right = metrics.targetRightM
  const forward = metrics.targetForwardM
  const vertical = metrics.targetUpM
  return `目標在機身${right >= 0 ? '右' : '左'}側 ${Math.abs(right).toFixed(1)} m、${forward >= 0 ? '前' : '後'}方 ${Math.abs(forward).toFixed(1)} m、${vertical >= 0 ? '上' : '下'}方 ${Math.abs(vertical).toFixed(1)} m。`
}

function evaluateDirectionControl(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0
    || !Number.isFinite(context.elapsedSeconds) || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) {
    return terminal('方向練習停止：時間或飛行狀態含無效數值。')
  }
  if (sample.state.crashed) return terminal('方向練習停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('方向練習停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }

  const launch = context.sceneReferences.find((reference) => reference.id === 'training-launch')
  const surface = context.sceneReferences.find((reference) => reference.id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) {
    return terminal('方向練習缺少有效的起飛點或地面參考，請重設訓練場。')
  }
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM)
    || !Number.isFinite(contact.supportOffsetM) || contact.supportOffsetM < 0
    || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) {
    return terminal('方向練習停止：缺少有效的地面接觸資料。')
  }
  const position = sample.state.positionM
  const groundClearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (groundClearance < -0.003 || (contact.touching && Math.abs(groundClearance) > 0.003)) {
    return terminal('方向練習停止：接地標記與機體支撐高度不一致。')
  }

  const targets = createDirectionControlTargets(launch.positionM, surface.positionM.y)
  const grounded = context.checkpoints['direction-ground']?.completed === true
  let lifted = context.checkpoints['direction-liftoff']?.completed === true
  let targetIndex = 0
  while (targetIndex < targets.length && context.checkpoints[targets[targetIndex].id]?.completed) targetIndex += 1
  const target = targets[Math.min(targetIndex, targets.length - 1)]
  const forward = rotateVectorByQuaternion(sample.state.orientation, FORWARD)
  const headingError = horizontalAngle(forward, target.headingForward)
  const yawEntry = context.checkpoints['direction-back']?.metrics
  const entryForward = { x: yawEntry?.yawEntryForwardX ?? Number.NaN, y: 0, z: yawEntry?.yawEntryForwardZ ?? Number.NaN }
  const yawEntryValid = isFiniteVector3(entryForward) && Math.hypot(entryForward.x, entryForward.z) > 0.5
  const headingChange = yawEntryValid ? horizontalAngle(forward, entryForward) : 0
  const metrics: Record<string, number> = {
    groundClearanceM: groundClearance,
    altitudeM: position.y - surface.positionM.y,
    launchDistanceM: Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z),
    directionPhase: !grounded ? 0 : !lifted ? 1 : targetIndex + 2,
    directionTargetIndex: targetIndex,
    directionTargetsCompleted: targetIndex,
    groundTouching: contact.touching ? 1 : 0,
    headingErrorDegrees: headingError,
    headingChangeDegrees: headingChange,
    yawEntryRecorded: yawEntryValid ? 1 : 0,
    ...targetFacts(sample, target),
  }

  const previous = context.previousFlightSample ?? context.previousSample
  if (previous) {
    const delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35
      || physicsDelta <= 0 || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) {
      return terminal('方向練習停止：資料中斷、時間倒退或模擬被重設。', metrics)
    }
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    const error = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.velocityConsistencyErrorM = error
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (error > metrics.integrationToleranceM) return terminal('方向練習停止：位置跳躍與速度不一致，不能跳過目標。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > DIRECTION_CONTROL_TIME_LIMIT_SECONDS) {
    return terminal('方向挑戰逾時：尚未完成側移、前後移動及換向後的目標。', metrics)
  }

  const checkpointIds: string[] = []
  if (!grounded) {
    const onLaunchGround = contact.touching && metrics.launchDistanceM <= RADIUS_M
    if (onLaunchGround) checkpointIds.push('direction-ground')
    return {
      status: 'continue', checkpointIds, metrics: { ...metrics, directionPhase: onLaunchGround ? 1 : 0 },
      hint: onLaunchGround ? '地面準備完成；自行加油門起飛，先往右側目標移動。'
        : '請先在起飛區實際接地，再自行起飛；不能從空中跳過地面開始。',
    }
  }
  if (!lifted) {
    lifted = !contact.touching && groundClearance >= 0.15
    if (!lifted) return {
      status: 'continue', metrics,
      hint: `尚未觀察到實際起飛：支撐點離地 ${Math.max(0, groundClearance).toFixed(2)} m；緩慢增加油門，建議高度約 ${DIRECTION_CONTROL_TARGET_HEIGHT_AGL_M} m。`,
    }
    checkpointIds.push('direction-liftoff')
    metrics.directionPhase = 2
  }
  if (targetIndex >= targets.length) return { status: 'success', checkpointIds, metrics: { ...metrics, directionPhase: 9 }, score: 100, message: '已完成側移、前後移動與換向後的方向練習。' }

  const near = target.kind === 'yaw' ? distance(position, target.positionM) <= RADIUS_M
    : intersectsTarget(previous?.state.positionM, position, target.positionM)
  const airborne = !contact.touching && groundClearance >= 0.15
  const correctHeading = headingError <= (target.kind === 'yaw' ? DIRECTION_CONTROL_YAW_TOLERANCE_DEGREES : DIRECTION_CONTROL_HEADING_TOLERANCE_DEGREES) + 1e-8
  const actualYaw = target.kind !== 'yaw' || (yawEntryValid && headingChange + 1e-8 >= DIRECTION_CONTROL_MINIMUM_YAW_CHANGE_DEGREES)
  if (airborne && near && correctHeading && actualYaw) {
    checkpointIds.push(target.id)
    if (target.id === 'direction-back') {
      const length = Math.hypot(forward.x, forward.z)
      metrics.yawEntryForwardX = forward.x / length
      metrics.yawEntryForwardZ = forward.z / length
      metrics.yawEntryRecorded = 1
    }
    targetIndex += 1
    metrics.directionTargetsCompleted = targetIndex
    metrics.directionTargetIndex = targetIndex
    metrics.directionPhase = targetIndex + 2
    if (targetIndex >= targets.length) return {
      status: 'success', checkpointIds, metrics: { ...metrics, directionPhase: 9 }, score: 100,
      message: '已從地面起飛，完成左右、前後移動、偏航換向與換向後的方向練習。',
      hint: '本課目標已完成。先 Disarm，再查看結果與回放。',
    }
    const next = targets[targetIndex]
    Object.assign(metrics, targetFacts(sample, next), { headingErrorDegrees: horizontalAngle(forward, next.headingForward) })
    return {
      status: 'continue', checkpointIds, metrics,
      hint: `「${target.label}」完成。下一步：${next.label}。${relativeHint(metrics)}已完成的步驟會保留，不需停穩或回地面。`,
    }
  }

  let action: string
  if (!airborne) action = '目前尚未在空中；可以就地再次起飛，已完成的目標會保留。'
  else if (!near) action = `朝目前目標區移動；${relativeHint(metrics)}進入半徑 ${RADIUS_M.toFixed(1)} m 的可見區域即可，不要求停留。`
  else if (!correctHeading) action = `機頭朝向偏差 ${headingError.toFixed(0)}°，需在 ${target.kind === 'yaw' ? DIRECTION_CONTROL_YAW_TOLERANCE_DEGREES : DIRECTION_CONTROL_HEADING_TOLERANCE_DEGREES}° 內。${targetIndex < 4 ? '先把機頭轉回原來的前方，再保持朝向側移。' : '把機頭朝向場地右側，再依新的前／右方向移動。'}`
  else if (!yawEntryValid) action = '尚缺換向前的朝向紀錄，請重設課程後依序完成前後移動。'
  else action = `已在換向區，實際轉向 ${headingChange.toFixed(0)}°，至少需 ${DIRECTION_CONTROL_MINIMUM_YAW_CHANGE_DEGREES}°；用偏航把機頭轉向場地右側。`
  return { status: 'continue', checkpointIds, metrics, hint: `${target.label}：${action}` }
}

export const directionControlEvaluator: LessonEvaluatorContract = { evaluate: evaluateDirectionControl }

export const DIRECTION_CONTROL_LESSON: LessonDefinition = {
  id: 'direction-control', priority: 1.9, title: '側移與方向感',
  description: '從地面自行起飛，依序完成左右側移、前後移動，再偏航換向並辨認新的前方與右側。',
  availability: 'available', available: true,
  objectives: ['從地面自行起飛，保持機頭大致朝前，飛入左右與前後目標。', '實際偏航換向後，依新的機身方向完成前移與右移。', '目標範圍寬鬆，不要求精準速度或停穩；已完成步驟保留。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'direction-ground', title: '地面開始', description: '在起飛區實際地面開始。' },
    { id: 'direction-liftoff', title: '自行起飛', description: '實際離開地面，不要求先懸停。' },
    { id: 'direction-right', title: '向右側移', description: '保持機頭大致朝前，移入右側目標。' },
    { id: 'direction-left', title: '向左側移', description: '保持機頭大致朝前，移入左側目標。' },
    { id: 'direction-forward', title: '向前移動', description: '保持機頭大致朝前，移入前方目標。' },
    { id: 'direction-back', title: '向後移動', description: '退回前一個位置，記錄換向前的機頭朝向。' },
    { id: 'direction-yaw', title: '偏航換向', description: '在換向區實際轉動機頭，朝向場地右側。' },
    { id: 'direction-turned-forward', title: '換向後前移', description: '沿新的機頭前方移入目標。' },
    { id: 'direction-turned-right', title: '換向後右移', description: '沿新的機身右側移入最後目標。' },
  ],
  success: { title: '側移與方向感完成', description: '已完成依序移動、實際換向與換向後的方向練習。', criteria: ['自行起飛', '依序進入可見目標', '實際偏航後再平移'] },
  failure: { title: '方向練習尚未完成', description: '可保留已完成目標繼續嘗試；墜毀或失效資料需重試。', criteria: ['不能以地面滑行、抖桿或原地轉向代替平移', '不能瞬移、重設或使用示範通關'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['directionTargetsCompleted', 'targetDistanceM', 'headingErrorDegrees', 'altitudeM'] },
  hints: ['側移時保持機頭大致朝前，向右／左移動不等於偏航。換向後前方與右側會跟著機頭改變。'],
  evaluator: directionControlEvaluator,
}

export const DIRECTION_CONTROL_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L05', title: '側移與方向感', level: '入門', prerequisiteIds: ['landing'],
  objectives: ['學會保持朝向的左右與前後移動。', '理解偏航後，機身前方與右側會跟著改變。'],
  steps: [
    '從起飛區地面自行加油門離地，建議高度約三公尺。',
    '保持機頭大致朝原來前方，依序飛入右、左、前、後目標區；不需要精準停穩。',
    '目標不在畫面內時，查看目前任務中的機身左右／前後距離；世界 X／Y／Z 不隨機頭轉向。',
    '在換向區使用偏航把機頭轉向場地右側，再依新的前方與右側移動。',
    '漏過目標可直接補飛，已完成的步驟會保留；看見完成結果後再 Disarm。',
  ],
  commonMistakes: ['把偏航當成側移：機頭轉動本身不會完成移動目標。', '換向後仍照原場地方向判斷機身前方；先看機頭，再看目前目標相對位置。'],
}
