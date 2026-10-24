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
export const LANDING_ZONE_DISTANCE_M = LANDING_TARGET_DISTANCE_M
export const LANDING_ZONE_RADIUS_M = 1.5
export const LANDING_LIFTOFF_HEIGHT_M = 0.15

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stop(
  message: string,
  metrics: Readonly<Record<string, number>> = {},
): TrainingEvaluation {
  return {
    status: 'failure', metrics, message,
    hint: '請重設後再從起飛區地面自行起飛，飛往藍色降落區。',
  }

}

function evaluateLanding(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0
    || !Number.isFinite(context.elapsedSeconds) || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) {
    return stop('降落停止：飛行資料含無效或非有限數值。')
  }
  if (sample.state.crashed) return stop('降落停止：墜毀不能當作成功接地。')
  if (sample.armed === false) return stop('降落停止：已解除解鎖或失去焦點，不能以 Disarm 代替受控接地。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的降落資料。' }

  const launch = context.sceneReferences.find((reference) => reference.id === 'training-launch')
  const surface = context.sceneReferences.find((reference) => reference.id === 'landing-surface')
  const contact = sample.groundContact
  if (!launch || !surface || !Object.values(launch.positionM).every(Number.isFinite)
    || !Object.values(surface.positionM).every(Number.isFinite)) {
    return stop('降落場景缺少地面起飛點或指定降落區，無法評分。')
  }
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM)
    || !Number.isFinite(contact.supportOffsetM) || contact.supportOffsetM < 0
    || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) {
    return stop('降落停止：缺少有效的實際地面接觸資料。')
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
  if (routeLengthSquared < 4) return stop('降落區必須與起飛區分開，請重設訓練場。')
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
  const metrics: Record<string, number> = {
    landingHeightM: Math.max(0, clearance),
    groundClearanceM: clearance,
    altitudeM: position.y - surface.positionM.y,
    landingPositionErrorM: horizontalError,
    launchDistanceM: launchDistance,
    landingRouteErrorM: routeError,
    landingPhase: approached ? 3 : lifted ? 2 : launched ? 1 : 0,
    horizontalDriftM: horizontalError,
    horizontalSpeedMps: horizontalSpeed,
    verticalSpeedMps: verticalSpeed,
    touchdownDescentSpeedMps: metric(context, 'touchdownDescentSpeedMps'),
    maxTiltDegrees: tilt,
    groundTouching: contact.touching ? 1 : 0,
    contiguousDwellSeconds: 0,
    landingSettled: 0,
  }
  if (clearance < -0.003 || (contact.touching && Math.abs(clearance) > 0.003)) {
    return stop('降落停止：接地標記與機體支撐高度不一致，空中停留不能當接地。', metrics)
  }

  const flightPrevious = context.previousFlightSample ?? context.previousSample
  if (flightPrevious) {
    const delta = sample.timestampSeconds - flightPrevious.timestampSeconds
    if (!isFiniteDroneState(flightPrevious.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35
      || sample.state.stepIndex <= flightPrevious.state.stepIndex
      || sample.state.timeSeconds <= flightPrevious.state.timeSeconds
      || Math.abs((sample.state.timeSeconds - flightPrevious.state.timeSeconds) - delta) > 1e-6) {
      return stop('降落停止：飛行資料中斷、時間倒退或模擬被重設。', metrics)
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
    if (error > tolerance) {
      return stop('降落停止：位置跳躍與實際速度不一致，瞬移不能當降落。', metrics)
    }
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > 90) {
    return stop('降落挑戰逾時：尚未在藍色降落區接地。', metrics)
  }

  // Completion follows the visible goal: leave the launch ground, then make
  // genuine, non-crashed air-to-ground contact inside the painted destination.
  // Speed, attitude and approach precision remain coaching, not extra gates.
  if (!launched) {
    if (!contact.touching || launchDistance > LANDING_ZONE_RADIUS_M) {
      return {
        status: 'continue', metrics,
        hint: `請先從起飛區地面開始；目前距起飛中心 ${launchDistance.toFixed(2)} m。`,
      }
    }
    return {
      status: 'continue', checkpointIds: ['landing-launch'], metrics: { ...metrics, landingPhase: 1 },
      hint: `自行加油門起飛，再飛往前方 ${LANDING_TARGET_DISTANCE_M} m 的藍色降落區。`,
    }
  }

  const liftoff = !contact.touching && clearance >= LANDING_LIFTOFF_HEIGHT_M
  const hasLifted = lifted || liftoff
  if (!hasLifted) {
    return {
      status: 'continue', metrics: { ...metrics, landingPhase: 1 },
      hint: `尚未觀察到實際起飛：機體支撐點離地 ${Math.max(0, clearance).toFixed(2)} m；緩慢加油門離地後再前往藍色區。`,
    }
  }

  const inside = horizontalError <= LANDING_ZONE_RADIUS_M
  const approach = !contact.touching && inside
  const newContact = contact.touching && flightPrevious?.groundContact?.touching === false
  const landed = inside && newContact
  const checkpointIds = [
    ...(!lifted && liftoff ? ['landing-liftoff'] : []),
    ...(!approached && (approach || landed) ? ['landing-approach'] : []),
    ...(landed ? ['landing-touchdown', 'landing-settle'] : []),
  ]
  const previousDescent = flightPrevious ? Math.max(0, -flightPrevious.state.velocityMps.y) : 0
  const previousHorizontalSpeed = flightPrevious
    ? Math.hypot(flightPrevious.state.velocityMps.x, flightPrevious.state.velocityMps.z) : 0
  if (newContact) {
    metrics.touchdownDescentSpeedMps = previousDescent
    metrics.preImpactDescentSpeedMps = previousDescent
    metrics.preImpactHorizontalSpeedMps = previousHorizontalSpeed
  }
  metrics.landingPhase = landed ? 4 : approached || approach ? 3 : 2
  metrics.landingSettled = landed ? 1 : 0
  if (landed) {
    return {
      status: 'success', checkpointIds, metrics, score: 100,
      message: '已自行起飛，並在藍色降落區接地且未墜毀。現在可以 Disarm 停止馬達。',
    }
  }
  const hint = contact.touching
    ? inside
      ? '目前在降落區地面，但尚未觀察到從空中接地；請自行離地後再降落，沿地面滑入不算完成。'
      : `這次接地在藍色降落區外：距中心 ${horizontalError.toFixed(2)} m，區域半徑 ${LANDING_ZONE_RADIUS_M.toFixed(2)} m。可以直接再次起飛前往藍色區，不必返回起飛點。`
    : inside
      ? `已到藍色降落區上方，機體支撐點離地 ${Math.max(0, clearance).toFixed(2)} m；慢慢下降，只要接地且未墜毀就完成。`
      : `距藍色降落區中心 ${horizontalError.toFixed(2)} m；朝藍色光柱飛近，在半徑 ${LANDING_ZONE_RADIUS_M.toFixed(2)} m 內接地且未墜毀即可。`
  return { status: 'continue', checkpointIds, metrics, hint }
}

export const landingEvaluator: LessonEvaluatorContract = { evaluate: evaluateLanding }

export const LANDING_LESSON: LessonDefinition = {
  id: 'landing', priority: 1.75, title: '起飛、前往降落區與降落',
  description: `自行起飛，飛往前方 ${LANDING_TARGET_DISTANCE_M} m 的藍色降落區；在區內接地且未墜毀即可完成。`,
  availability: 'available', available: true,
  objectives: ['從起飛區地面自行起飛。', `飛往前方 ${LANDING_TARGET_DISTANCE_M} m 的藍色降落區。`, '在藍色區內實際接地且未墜毀，不要求精準進場或停留秒數。'],
  setup: {
    requiresDisarmed: true, resetSimulation: true,
    sceneReferenceIds: ['training-launch', 'landing-surface'],
    spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  checkpoints: [
    { id: 'landing-launch', title: '地面開始', description: '從起飛區地面自行開始。' },
    { id: 'landing-liftoff', title: '自行起飛', description: '實際離開地面，不能只沿地面滑行。' },
    { id: 'landing-approach', title: '前往藍色區', description: '找到藍色光柱及地面降落區。' },
    { id: 'landing-touchdown', title: '區內接地', description: `從空中降落在半徑 ${LANDING_ZONE_RADIUS_M} m 的藍色區內。` },
    { id: 'landing-settle', title: '未墜毀', description: '接地且未墜毀即可完成，不另要求穩定停留。' },
  ],
  success: {
    title: '降落完成', description: '已自行起飛，並在指定區實際接地且未墜毀。',
    criteria: ['實際從起飛區離地', '在藍色區內由空中接地', '機體未墜毀'],
  },
  failure: {
    title: '降落尚未完成', description: '繼續嘗試在藍色區內接地；墜毀則重設後再試。',
    criteria: ['不能以地面滑行或空中 Disarm 代替降落', '不能以墜毀、瞬移或重設取得成績'],
  },
  scoring: {
    maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0,
    metricLabels: ['landingHeightM', 'landingPositionErrorM', 'groundTouching'],
  },
  hints: ['先朝藍色光柱飛近，再減少油門下降。接地未墜毀即可完成，慢速與近水平仍有助於避免撞擊。'],
  evaluator: landingEvaluator,
}

export const LANDING_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L03', title: '起飛與藍色區降落', level: '入門', prerequisiteIds: ['straight-line'],
  objectives: [`自行起飛並找到前方 ${LANDING_TARGET_DISTANCE_M} m 的藍色降落區。`, '在區內接地且未墜毀即可完成。'],
  steps: [
    '從起飛區地面自行加油門離地；課程不會把你放在半空中。',
    `朝正前方 ${LANDING_TARGET_DISTANCE_M} m 的藍色光柱飛近，地面藍色圓區就是落點。`,
    `在藍色區半徑 ${LANDING_ZONE_RADIUS_M} m 內下降接地；不要求精準進場、固定接地速度或停留秒數。`,
    '如果落在區外，可以就地再次起飛前往藍色區，不必返回起飛點。',
    '看到完成後再 Disarm；真的墜毀仍需 Reset 後重試。',
  ],
  commonMistakes: ['在起飛墊落地、沿地面滑入藍色區或在空中 Disarm 都不算降落；先離地再飛到藍色區。'],
}
