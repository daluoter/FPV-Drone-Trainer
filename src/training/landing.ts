import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { rotateVectorByQuaternion } from '../math/quaternion'
import type { LessonLearningContent } from './catalog'
import { LANDING_TARGET_DISTANCE_M } from './field'
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
export const LANDING_ZONE_DISTANCE_M = LANDING_TARGET_DISTANCE_M
export const LANDING_LIFTOFF_HEIGHT_M = 0.8

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
      hint: '本次步驟已重新開始；安全返回起飛區並落地，再自行起飛、飛往前方藍色降落區。也可停止課程後重試。',
    }
  }
  return {
    status: 'failure', metrics, message,
    hint: '重試後從地面自行起飛，飛往前方藍色降落區；先降低側移與下降速度，平穩接地後保持至結果出現。',
  }
}

function evaluateLanding(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !isFiniteDroneState(sample.state)) {
    return stop(context, '降落停止：飛行資料含無效或非有限數值。')
  }
  if (sample.state.crashed) return stop(context, '降落停止：墜毀不能當作成功接地。')
  if (sample.armed === false) return stop(context, '降落停止：已解除解鎖或失去焦點，不能以 Disarm 代替受控接地。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的降落資料。' }

  const launch = context.sceneReferences.find((reference) => reference.id === 'training-launch')
  const surface = context.sceneReferences.find((reference) => reference.id === 'landing-surface')
  const contact = sample.groundContact
  if (!launch || !surface || !Object.values(launch.positionM).every(Number.isFinite)
    || !Object.values(surface.positionM).every(Number.isFinite)) {
    return stop(context, '降落場景缺少地面起飛點或指定降落區，無法評分。')
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
  const horizontalError = Math.hypot(position.x - surface.positionM.x, position.z - surface.positionM.z)
  const launchDistance = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const routeX = surface.positionM.x - launch.positionM.x
  const routeZ = surface.positionM.z - launch.positionM.z
  const routeLengthSquared = routeX * routeX + routeZ * routeZ
  if (routeLengthSquared < 4) return stop(context, '降落區必須與起飛區分開，請重設訓練場。')
  const routeProjection = Math.max(0, Math.min(1,
    ((position.x - launch.positionM.x) * routeX + (position.z - launch.positionM.z) * routeZ) / routeLengthSquared,
  ))
  const routeError = Math.hypot(
    position.x - launch.positionM.x - routeX * routeProjection,
    position.z - launch.positionM.z - routeZ * routeProjection,
  )
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
  const verticalSpeed = Math.abs(velocity.y)
  const up = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 1, z: 0 })
  const tilt = Math.acos(Math.min(1, Math.max(-1, up.y))) * 180 / Math.PI
  const launched = context.checkpoints['landing-launch']?.completed === true
  const lifted = context.checkpoints['landing-liftoff']?.completed === true
  const approached = context.checkpoints['landing-approach']?.completed === true
  const touched = context.checkpoints['landing-touchdown']?.completed === true
  const descentObserved = metric(context, 'descentObserved') === 1
    || (approached && velocity.y < -0.08 && clearance > 0.05 && horizontalError <= 1.2)
  const metrics: Record<string, number> = {
    landingHeightM: Math.max(0, clearance),
    landingPositionErrorM: horizontalError,
    launchDistanceM: launchDistance,
    landingRouteErrorM: routeError,
    landingPhase: touched ? 4 : approached ? 3 : lifted ? 2 : launched ? 1 : 0,
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
  if (routeError > 25 || clearance > 25 || horizontalSpeed > 12 || verticalSpeed > 5 || tilt > 70) {
    return stop(context, '降落停止：已超出安全飛行範圍。', metrics)
  }
  if (routeError > 4 || clearance > 7 || horizontalSpeed > 3 || verticalSpeed > 2 || tilt > 40) {
    return stop(context, '降落偏離練習路線，請先降低速度，返回起飛區重練。', metrics, true)
  }

  if (context.mode !== 'practice' && context.elapsedSeconds > 90) {
    return stop(context, '降落挑戰逾時，尚未完成起飛、前往指定區與受控降落。', metrics)
  }
  const launchReady = contact.touching && launchDistance <= 1
    && horizontalSpeed <= 0.5 && verticalSpeed <= 0.3 && tilt <= 15
  if (!launched) {
    if (!launchReady) return stop(context, '需先在起飛區地面開始，不能直接從空中或降落區開始通關。', metrics, true)
    return {
      status: 'continue', checkpointIds: ['landing-launch'], metrics: { ...metrics, landingPhase: 1 },
      hint: `從起飛區緩慢加油門，自行起飛到至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺；藍色降落區在前方 ${LANDING_TARGET_DISTANCE_M} 公尺。`,
    }
  }
  const liftoff = !lifted && !contact.touching && clearance >= LANDING_LIFTOFF_HEIGHT_M
    && launchDistance <= 1.5 && horizontalSpeed <= 1.5 && verticalSpeed <= 1.5 && tilt <= 20
  if (!lifted) {
    if (contact.touching && launchDistance > 1) {
      return stop(context, '仍需從起飛區自行離地；不能沿地面移動到降落區。', metrics, true)
    }
    if (!liftoff && launchDistance > 1.5) {
      return stop(context, `先在起飛區上方升到至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺，再前往藍色降落區。`, metrics, true)
    }
    return {
      status: 'continue', checkpointIds: liftoff ? ['landing-liftoff'] : [],
      metrics: { ...metrics, landingPhase: liftoff ? 2 : 1 },
      hint: liftoff ? `已起飛。前方 ${LANDING_TARGET_DISTANCE_M} 公尺有藍色降落區與光柱；保持高度、緩慢飛近。`
        : `先緩慢加油門離地，保持水平，在起飛區上方升到至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺。`,
    }
  }
  const approach = !contact.touching && clearance >= LANDING_LIFTOFF_HEIGHT_M && clearance <= 5
    && horizontalError <= 1.2 && horizontalSpeed <= 1.5 && verticalSpeed <= 1.2 && tilt <= 15
  if (contact.touching && (!approached || horizontalError > 0.85)) {
    return stop(context, '需飛往前方藍色降落區後再接地；起飛區或其他位置落地不能完成本課。', metrics, true)
  }
  if (!approached && !approach) {
    return {
      status: 'continue', metrics: { ...metrics, landingPhase: 2 },
      hint: horizontalError > 1.2
        ? `藍色降落區還有 ${horizontalError.toFixed(1)} 公尺；保持高度飛近光柱，再減速對準。`
        : `已接近藍色降落區；先在區上方至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺降低側移與傾角，再開始下降。`,
    }
  }
  if (approach && !approached) {
    return {
      status: 'continue', checkpointIds: ['landing-approach'], metrics: { ...metrics, landingPhase: 3 },
      hint: '已對準藍色降落區。小量減少油門下降，接地前把下降速度降到 0.8 m/s 以下。',
    }
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
  metrics.landingPhase = touched || touchdown ? 4 : 3
  metrics.contiguousDwellSeconds = dwell
  const checkpointIds = [
    ...(approach ? ['landing-approach'] : []),
    ...(touchdown ? ['landing-touchdown'] : []),
    ...(settled && dwell >= LANDING_SETTLED_DWELL_SECONDS ? ['landing-settle'] : []),
  ]
  const score = Math.max(0, Math.min(100,
    100 - horizontalError * 15 - metrics.touchdownDescentSpeedMps * 10 - horizontalSpeed * 10 - tilt * 0.5,
  ))
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
  priority: 1.75,
  title: '起飛、前往降落區與降落',
  description: `從地面自行起飛，飛往前方 ${LANDING_TARGET_DISTANCE_M} 公尺的藍色降落區，減速、對準並平穩接地。`,
  availability: 'available',
  available: true,
  objectives: [`從地面自行起飛，飛往前方 ${LANDING_TARGET_DISTANCE_M} 公尺的藍色降落區。`, '在區上方先減速對準，再控制下降。', '平穩接地並連續穩住 1 秒，看到完成結果後再解除解鎖。'],
  setup: {
    requiresDisarmed: true,
    resetSimulation: true,
    sceneReferenceIds: ['training-launch', 'landing-surface'],
    spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  checkpoints: [
    { id: 'landing-launch', title: '起飛區地面準備', description: '在起飛區保持水平與低油門，從地面自行開始。' },
    { id: 'landing-liftoff', title: '自行起飛', description: `在起飛區上方實際離地，升到至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺。` },
    { id: 'landing-approach', title: '對準降落區', description: `從指定墊上方至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺進場，先控制漂移與姿態。` },
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
    criteria: ['不能省略起飛或直接從降落區開始', '不能在空中或錯誤落點通關', '不能墜毀、瞬移或以解除解鎖代替降落'],
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
  code: 'L04',
  title: '起飛、前往降落區與降落',
  level: '入門',
  prerequisiteIds: ['straight-line'],
  objectives: ['自行起飛並飛往另一個降落區。', '在藍色區低速接地，穩住後再 Disarm。'],
  steps: [
    '課程從起飛區地面開始；倒數後自行解鎖，緩慢加油門離地。',
    `升到至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺，再飛往前方 ${LANDING_TARGET_DISTANCE_M} 公尺的藍色降落區；光柱標示落點。`,
    '先觀察落點，降低側移速度並讓機體接近水平。',
    '逐步減少油門緩慢下降，接近地面時提早減少下降速度。',
    '在藍色降落區中心平穩接地，保持低油門與水平姿態。',
    '連續穩住 1 秒，看到完成結果後再 Disarm。',
  ],
  commonMistakes: [
    '只盯高度，沒有先消除側移，落點越修越遠。',
    '等到接地才減速；碰地後速度歸零不能證明接地前受控。',
    '在空中先 Disarm，讓機體落地；這會停止挑戰而非完成降落。',
  ],
}
