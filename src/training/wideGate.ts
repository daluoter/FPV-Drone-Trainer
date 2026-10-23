import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { inverseRotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import { OBSTACLE_CRASH_WARNING_PREFIX } from '../simulation/obstacles'
import { createWideGates, WIDE_GATE_IDS, WIDE_GATE_TARGET_HEIGHT_AGL_M, type WideGate } from '../world/wideGates'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export { WIDE_GATE_IDS } from '../world/wideGates'
export const WIDE_GATE_TIME_LIMIT_SECONDS = 240

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', metrics, message, hint: '先 Disarm 停止馬達，再重設課程並自行起飛。' }
}

function gateFacts(sample: TrainingSample, gate: WideGate): Readonly<Record<string, number>> {
  const position = sample.state.positionM
  const delta = { x: gate.positionM.x - position.x, y: gate.positionM.y - position.y, z: gate.positionM.z - position.z }
  const body = inverseRotateVectorByQuaternion(sample.state.orientation, delta)
  return {
    nextGateDistanceM: position.z - gate.positionM.z,
    nextGateHorizontalErrorM: position.x - gate.positionM.x,
    nextGateVerticalErrorM: position.y - gate.positionM.y,
    targetDistanceM: Math.hypot(delta.x, delta.y, delta.z),
    targetRightM: body.x, targetForwardM: -body.z, targetUpM: body.y,
    targetAltitudeM: WIDE_GATE_TARGET_HEIGHT_AGL_M,
  }
}

/** Measure an actual forward segment/plane crossing rather than endpoint proximity. */
function crossing(before: Vector3, current: Vector3, gate: WideGate): { readonly inside: boolean; readonly x: number; readonly y: number } | null {
  if (!(current.z < before.z && before.z >= gate.positionM.z && current.z <= gate.positionM.z)) return null
  const fraction = (gate.positionM.z - before.z) / (current.z - before.z)
  const x = before.x + (current.x - before.x) * fraction - gate.positionM.x
  const y = before.y + (current.y - before.y) * fraction - gate.positionM.y
  return {
    inside: Math.abs(x) <= gate.openingWidthM / 2 + 1e-9 && Math.abs(y) <= gate.openingHeightM / 2 + 1e-9,
    x, y,
  }
}

function evaluateWideGate(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('寬門練習停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) {
    const obstacle = sample.state.warnings.find((warning) => warning.startsWith(OBSTACLE_CRASH_WARNING_PREFIX))
    return terminal(obstacle ? `寬門練習停止：機體已碰撞門框。${obstacle}` : '寬門練習停止：機體已墜毀，請重設後重試。')
  }
  if (sample.armed === false) return terminal('寬門練習停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }

  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('寬門練習缺少有效的起飛點或地面參考，請重設訓練場。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('寬門練習停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const groundClearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (groundClearance < -0.003 || (contact.touching && Math.abs(groundClearance) > 0.003)) return terminal('寬門練習停止：接地標記與機體支撐高度不一致。')

  const gates = createWideGates(launch.positionM, surface.positionM.y)
  const grounded = context.checkpoints['gate-ground']?.completed === true
  let lifted = context.checkpoints['gate-liftoff']?.completed === true
  let gateIndex = 0
  while (gateIndex < gates.length && context.checkpoints[gates[gateIndex].id]?.completed) gateIndex += 1
  const gate = gates[Math.min(gateIndex, gates.length - 1)]
  const airborne = !contact.touching && groundClearance >= 0.15
  const metrics: Record<string, number> = {
    groundClearanceM: groundClearance, altitudeM: position.y - surface.positionM.y,
    launchDistanceM: Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z), groundTouching: contact.touching ? 1 : 0,
    gatePhase: !grounded ? 0 : !lifted ? 1 : gateIndex + 2,
    gateTargetIndex: gateIndex, gatesPassed: gateIndex,
    ...gateFacts(sample, gate),
  }

  const previous = context.previousFlightSample ?? context.previousSample
  if (previous) {
    const delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('寬門練習停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('寬門練習停止：位置跳躍與速度不一致，不能跳過門框。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > WIDE_GATE_TIME_LIMIT_SECONDS) return terminal('寬門挑戰逾時：尚未依序穿過三道寬門。', metrics)

  const checkpointIds: string[] = []
  if (!grounded) {
    const onLaunchGround = contact.touching && metrics.launchDistanceM <= 1.9
    if (onLaunchGround) checkpointIds.push('gate-ground')
    return { status: 'continue', checkpointIds, metrics: { ...metrics, gatePhase: onLaunchGround ? 1 : 0 }, hint: onLaunchGround
      ? '地面準備完成；自行加油門起飛，對準前方第一道寬門的開口。'
      : '請先在起飛區實際接地，再自行起飛；不能從空中跳過地面開始。' }
  }
  if (!lifted) {
    lifted = airborne
    if (!lifted) return { status: 'continue', metrics, hint: '自行加油門離地後，對準第一道門開口；建議高度約 3 m，不必先懸停。' }
    checkpointIds.push('gate-liftoff')
    metrics.gatePhase = 2
  }
  if (gateIndex >= gates.length) return { status: 'success', checkpointIds, metrics: { ...metrics, gatePhase: 5 }, score: 100, message: '已依序穿過三道寬門。' }

  if (previous && airborne) {
    // Physics resolves body/frame contact before this observer receives the
    // sample. The evaluator independently measures the visible opening plane.
    while (gateIndex < gates.length) {
      const passage = crossing(previous.state.positionM, position, gates[gateIndex])
      if (!passage) break
      metrics.lastGateHorizontalErrorM = passage.x
      metrics.lastGateVerticalErrorM = passage.y
      if (!passage.inside) break
      checkpointIds.push(gates[gateIndex].id)
      gateIndex += 1
    }
  }
  metrics.gateTargetIndex = gateIndex
  metrics.gatesPassed = gateIndex
  metrics.gatePhase = gateIndex + 2
  if (gateIndex === gates.length) return {
    status: 'success', checkpointIds, score: 100, metrics: { ...metrics, gatePhase: 5 },
    message: '已自行起飛，並依序從開口朝前穿過三道寬門。',
    hint: '寬門穿越目標已完成，不要求停穩或降落。先 Disarm，再查看結果與回放。',
  }
  const next = gates[gateIndex]
  Object.assign(metrics, gateFacts(sample, next))
  return { status: 'continue', checkpointIds, metrics,
    hint: !airborne ? '目前尚未在空中；可以就地再次起飛，已通過的門會保留。'
      : metrics.nextGateDistanceM <= 0
        ? `尚未穿過${next.label}；繞回這道門前，再對準開口向前穿越，已通過的門會保留。`
        : `已通過 ${gateIndex}／3 道門；對準${next.label}寬 4 m、高 4 m 的開口，還有 ${metrics.nextGateDistanceM.toFixed(1)} m。不要求精準速度或停留，門框有實際碰撞。` }
}

export const wideGateEvaluator: LessonEvaluatorContract = { evaluate: evaluateWideGate }

export const WIDE_GATE_LESSON: LessonDefinition = {
  id: 'wide-gate', priority: 2.6, title: '寬門穿越', availability: 'available', available: true,
  description: '從地面自行起飛，依序穿過三道有實體門框的寬門，練習對準開口與連續穿越。',
  objectives: ['自行起飛後，依序朝前穿過三道寬門的開口。', '留意機身與槳的尺寸，避免碰到左柱、右柱、上樑或下樑。', '不要求精準速度、停留或降落；漏門及未墜毀接地會保留進度。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'gate-ground', title: '地面開始', description: '在起飛區實際地面開始。' },
    { id: 'gate-liftoff', title: '自行起飛', description: '自行離地後對準第一道門開口，不必先懸停。' },
    ...WIDE_GATE_IDS.map((id, index) => ({ id, title: `穿過第 ${index + 1} 道寬門`, description: '從開口朝前穿越，避免碰到實體框架。' })),
  ],
  success: { title: '寬門穿越完成', description: '已自行起飛並依序穿過三道寬門。', criteria: ['從地面自行起飛', '依序從開口朝前穿越', '不以繞門、地面滑行或撞框代替通過'] },
  failure: { title: '寬門穿越尚未完成', description: '漏門及一般偏離可保留進度；碰框墜毀或無效資料需重試。', criteria: ['門框碰撞會停止練習', '不能瞬移、重設或使用示範取得成績'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['gatesPassed', 'nextGateDistanceM', 'altitudeM'] },
  hints: ['先對準目前門的開口，再朝前穿過；碰框後需重設，漏門可繞回該門前補飛。'],
  evaluator: wideGateEvaluator,
}

export const WIDE_GATE_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L09', title: '寬門穿越', level: '基礎航線', prerequisiteIds: ['figure-eight'],
  objectives: ['在實際門框碰撞下，依序穿過三道寬門。', '理解漏門可補飛、碰框需重設的差別。'],
  steps: ['從實際地面自行起飛，建議高度約三公尺，先對準第一道門。', '三道門位於起飛點前方 8、16、24 m；開口寬四公尺、高四公尺，中心高度約三公尺。', '朝路線前方穿過目前門的開口，機身與槳都需避開門框；不要求精準速度或停穩。', '漏門可繞回該門前重新朝前穿過；未墜毀接地可就地再次起飛，已通過的門保留。', '碰到門框會墜毀並指出部位，重試會清空本次步驟；看見完成結果後再 Disarm。'],
  commonMistakes: ['只讓畫面中心穿過門，但機身或槳仍靠近框架；接近時提早對準開口中央。', '從門外繞到後方或反向穿門，不等於朝前穿過開口；繞回目前門前再試。'],
}
