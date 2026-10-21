import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { rotateVectorByQuaternion } from '../math/quaternion'
import type { LessonLearningContent } from './catalog'
import type {
  LessonDefinition,
  LessonEvaluatorContract,
  TrainingEvaluation,
  TrainingEvaluationContext,
  TrainingSample,
} from './types'

/** Prototype simulator training tolerances; hardware/human validation is deferred. */
export const LANDING_SETTLED_DWELL_SECONDS = 1
export const LANDING_MAX_TOUCHDOWN_SPEED_MPS = 0.8

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stop(
  context: TrainingEvaluationContext,
  message: string,
  metrics: Readonly<Record<string, number>> = {},
  recoverable = false,
): TrainingEvaluation {
  if (recoverable && context.mode === 'practice') {
    return {
      status: 'continue', recovery: 'restart', metrics,
      message,
      hint: '先回到墊上方至少 0.8 公尺，降低漂移，再從進場重新練習；安全停止與 Disarm 隨時可用。',
    }
  }
  return {
    status: 'failure', metrics, message,
    hint: '解除解鎖並重試；先降低側移速度，再緩慢下降，接地後保持水平至結果出現。',
  }
}

function evaluateLanding(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !isFiniteDroneState(sample.state)) {
    return stop(context, '降落停止：飛行資料含無效或非有限數值。')
  }
  if (sample.state.crashed) return stop(context, '降落停止：墜毀不能當作成功接地。')
  if (sample.armed === false) return stop(context, '降落停止：已解除解鎖或失去焦點，不能以 Disarm 代替受控接地。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的降落資料。' }

  const pad = context.sceneReferences.find((reference) => reference.id === 'takeoff-pad')
  const surface = context.sceneReferences.find((reference) => reference.id === 'landing-surface')
  const contact = sample.groundContact
  if (!pad || !surface || !Object.values(pad.positionM).every(Number.isFinite)
    || !Object.values(surface.positionM).every(Number.isFinite)) {
    return stop(context, '降落場景缺少起飛墊或實際地面參考，無法評分。')
  }
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM)
    || !Number.isFinite(contact.supportOffsetM) || contact.supportOffsetM < 0
    || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) {
    return stop(context, '降落停止：缺少有效的實際地面接觸資料。')
  }

  const position = sample.state.positionM
  const velocity = sample.state.velocityMps
  const contactHeight = contact.heightM + contact.supportOffsetM + DRONE_GROUND_CLEARANCE_M
  const clearance = position.y - contactHeight
  const horizontalError = Math.hypot(position.x - pad.positionM.x, position.z - pad.positionM.z)
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
  const verticalSpeed = Math.abs(velocity.y)
  const up = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 1, z: 0 })
  const tilt = Math.acos(Math.min(1, Math.max(-1, up.y))) * 180 / Math.PI
  const descentObserved = metric(context, 'descentObserved') === 1 || (velocity.y < -0.08 && clearance > 0.05)
  const metrics: Record<string, number> = {
    landingHeightM: Math.max(0, clearance),
    landingPositionErrorM: horizontalError,
    horizontalDriftM: horizontalError,
    horizontalSpeedMps: horizontalSpeed,
    verticalSpeedMps: verticalSpeed,
    touchdownDescentSpeedMps: metric(context, 'touchdownDescentSpeedMps'),
    maxTiltDegrees: tilt,
    descentObserved: descentObserved ? 1 : 0,
    groundTouching: contact.touching ? 1 : 0,
    contiguousDwellSeconds: 0,
    landingSettled: 0,
  }
  if (clearance < -0.003 || (contact.touching && Math.abs(clearance) > 0.003)) {
    return stop(context, '降落停止：接地標記與機體支撐高度不一致，空中停留不能當接地。', metrics)
  }

  const flightPrevious = context.previousFlightSample ?? context.previousSample
  if (flightPrevious) {
    const delta = sample.timestampSeconds - flightPrevious.timestampSeconds
    if (!isFiniteDroneState(flightPrevious.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35
      || sample.state.stepIndex <= flightPrevious.state.stepIndex
      || sample.state.timeSeconds <= flightPrevious.state.timeSeconds
      || Math.abs((sample.state.timeSeconds - flightPrevious.state.timeSeconds) - delta) > 1e-6) {
      return stop(context, '降落停止：飛行資料中斷、時間倒退或模擬被重設。', metrics)
    }
    const before = flightPrevious.state
    const displacement = {
      x: position.x - before.positionM.x,
      y: position.y - before.positionM.y,
      z: position.z - before.positionM.z,
    }
    const error = Math.hypot(
      displacement.x - (velocity.x + before.velocityMps.x) * 0.5 * delta,
      displacement.y - (velocity.y + before.velocityMps.y) * 0.5 * delta,
      displacement.z - (velocity.z + before.velocityMps.z) * 0.5 * delta,
    )
    const tolerance = 0.04 + 10 * delta * delta
    metrics.velocityConsistencyErrorM = error
    metrics.integrationToleranceM = tolerance
    if (error > tolerance || Math.hypot(displacement.x, displacement.y, displacement.z) / delta > 8) {
      return stop(context, '降落停止：位置跳躍與實際速度不一致，瞬移不能當降落。', metrics)
    }
  }
  if (horizontalError > 25 || clearance > 25 || horizontalSpeed > 12 || verticalSpeed > 5 || tilt > 70) {
    return stop(context, '降落停止：已超出安全飛行範圍。', metrics)
  }
  if (horizontalError > 4 || clearance > 7 || horizontalSpeed > 3 || verticalSpeed > 2 || tilt > 40) {
    return stop(context, '降落偏離練習範圍，請回到墊上方並先降低速度。', metrics, true)
  }

  const approached = context.checkpoints['landing-approach']?.completed === true
  const touched = context.checkpoints['landing-touchdown']?.completed === true
  const approach = !contact.touching && clearance >= 0.8 && clearance <= 5
    && horizontalError <= 1.2 && horizontalSpeed <= 1.5 && verticalSpeed <= 1.2 && tilt <= 15
  if (!approached && !approach) {
    return stop(context, '必須先從墊上方進場；已經在地面不能直接累積降落成績。', metrics, true)
  }
  if (contact.touching && horizontalError > 0.85) {
    return stop(context, '落點超出指定降落區，不能在其他位置接地通關。', metrics, true)
  }
  if (touched && !contact.touching && clearance > 0.08) {
    return stop(context, '接地後再次升空，請從進場重新完成連續降落。', metrics, true)
  }

  let touchdown = false
  // A completed checkpoint does not make a later impact safe. Small bounces
  // may recover, but every airborne -> grounded transition must satisfy the
  // same pre-impact limits as the initial touchdown.
  const newContact = contact.touching && flightPrevious?.groundContact?.touching === false
  if (contact.touching && (!touched || flightPrevious?.groundContact?.touching !== true)) {
    const previousDescent = flightPrevious ? Math.max(0, -flightPrevious.state.velocityMps.y) : Infinity
    const previousHorizontalSpeed = flightPrevious
      ? Math.hypot(flightPrevious.state.velocityMps.x, flightPrevious.state.velocityMps.z)
      : Infinity
    const validAirApproach = approached && descentObserved && newContact
      && previousDescent > 0 && previousDescent <= LANDING_MAX_TOUCHDOWN_SPEED_MPS
      && previousHorizontalSpeed <= 0.8 && horizontalSpeed <= 0.6 && verticalSpeed <= 0.3 && tilt <= 12
    if (!validAirApproach) {
      if (Number.isFinite(previousDescent)) metrics.touchdownDescentSpeedMps = previousDescent
      return stop(context, '接地前下降或側移太快，或未觀察到受控進場；碰地後速度歸零不代表平穩降落。', metrics, true)
    }
    touchdown = true
    metrics.touchdownDescentSpeedMps = previousDescent
  }

  // Any loss of contact clears the local continuous dwell, even if the hop is
  // too small to trigger the separately bounded departure failure above.
  const settled = (touched || touchdown) && contact.touching && horizontalError <= 0.85
    && horizontalSpeed <= 0.2 && verticalSpeed <= 0.2 && tilt <= 10
  const localDelta = context.previousSample ? sample.timestampSeconds - context.previousSample.timestampSeconds : 0
  const dwell = settled && metric(context, 'landingSettled') === 1 && localDelta > 0 && localDelta <= 0.35
    ? metric(context, 'contiguousDwellSeconds') + localDelta
    : 0
  metrics.landingSettled = settled ? 1 : 0
  metrics.contiguousDwellSeconds = dwell
  const checkpointIds = [
    ...(approach ? ['landing-approach'] : []),
    ...(touchdown ? ['landing-touchdown'] : []),
    ...(settled && dwell >= LANDING_SETTLED_DWELL_SECONDS ? ['landing-settle'] : []),
  ]
  const score = Math.max(0, Math.min(100,
    100 - horizontalError * 15 - metrics.touchdownDescentSpeedMps * 10 - horizontalSpeed * 10 - tilt * 0.5,
  ))
  if (context.mode !== 'practice' && context.elapsedSeconds > 35) {
    return { ...stop(context, '降落挑戰逾時，尚未完成受控接地與穩定停留。', metrics), checkpointIds, score }
  }
  if (settled && dwell >= LANDING_SETTLED_DWELL_SECONDS && context.elapsedSeconds >= 3) {
    return {
      status: 'success', checkpointIds, metrics, score,
      message: '已在指定區平穩接地並連續穩住；現在可以 Disarm 停止馬達。',
    }
  }
  return {
    status: 'continue', checkpointIds, metrics, score,
    hint: touched || touchdown ? '已接地，保持水平與低油門，等結果出現再 Disarm。'
      : horizontalError > 0.85 ? '先減少側移並對準墊中心，再繼續下降。'
        : verticalSpeed > 0.8 ? '提早減少下降速度，不要等碰地才急加油門。'
          : '對準墊中心緩慢下降，接地前保持低速度與水平姿態。',
  }
}

export const landingEvaluator: LessonEvaluatorContract = { evaluate: evaluateLanding }

export const LANDING_LESSON: LessonDefinition = {
  id: 'landing',
  priority: 1.5,
  title: '定點降落',
  description: '從空中進場，在指定起飛墊附近降低漂移與下降速度，平穩接地並保持穩定。',
  availability: 'available',
  available: true,
  objectives: ['先從墊上方進場，逐步降低高度。', '接地前降低水平與下降速度。', '在指定區實際接地，連續穩住 1 秒後再解除解鎖。'],
  setup: {
    requiresDisarmed: true,
    resetSimulation: true,
    sceneReferenceIds: ['takeoff-pad', 'landing-surface'],
    spawnPositionM: { x: 0, y: 3, z: 0 },
    spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  checkpoints: [
    { id: 'landing-approach', title: '對準降落區', description: '從指定墊上方至少 0.8 公尺進場，先控制漂移與姿態。' },
    { id: 'landing-touchdown', title: '平穩接地', description: '以低下降與側移速度實際接地；不能以墜毀或空中 Disarm 代替。' },
    { id: 'landing-settle', title: '接地後穩住', description: '留在指定區、保持低速度與水平姿態連續 1 秒。' },
  ],
  success: {
    title: '定點降落完成',
    description: '已觀察到實際下降、低速接地與地面連續穩定停留。',
    criteria: ['空中進場後實際下降', '指定落點與低接地速度', '非墜毀狀態連續穩住 1 秒'],
  },
  failure: {
    title: '降落尚未完成',
    description: '此次尚未完成安全進場、低速指定接地與連續停留。',
    criteria: ['不能直接從地面開始', '不能在空中或錯誤落點通關', '不能墜毀、瞬移或以解除解鎖代替降落'],
  },
  scoring: {
    maxScore: 100,
    minimumPassingScore: 70,
    minimumActiveSeconds: 3,
    metricLabels: ['landingHeightM', 'landingPositionErrorM', 'touchdownDescentSpeedMps', 'horizontalSpeedMps', 'maxTiltDegrees', 'contiguousDwellSeconds'],
  },
  hints: ['先減少水平速度，再降低高度；接地前提早減速。原型門檻尚待真人試學與硬體驗證。'],
  evaluator: landingEvaluator,
}

export const LANDING_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L03',
  title: '定點降落',
  level: '入門',
  prerequisiteIds: ['hover'],
  objectives: ['以低速對準指定區接地。', '辨別平穩降落與墜毀，接地穩住後再 Disarm。'],
  steps: [
    '課程從墊上方 3 公尺開始；準備完成再明確解鎖。',
    '先觀察落點，降低側移速度並讓機體接近水平。',
    '逐步減少油門緩慢下降，接近地面時提早減少下降速度。',
    '在墊中心附近平穩接地，保持低油門與水平姿態。',
    '連續穩住 1 秒，看到完成結果後再 Disarm。',
  ],
  commonMistakes: [
    '只盯高度，沒有先消除側移，落點越修越遠。',
    '等到接地才減速；碰地後速度歸零不能證明接地前受控。',
    '在空中先 Disarm，讓機體落地；這會停止挑戰而非完成降落。',
  ],
}
