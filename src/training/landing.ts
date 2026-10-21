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
  action = '先控制側移與下降速度，再對準藍色降落區平穩接地。',
): TrainingEvaluation {
  if (recoverable && context.mode === 'practice') {
    return {
      status: 'continue', recovery: 'restart', metrics,
      message,
      hint: `${action}本次步驟已重新開始；安全返回起飛區接地，再自行起飛重練。`,
    }
  }
  return {
    status: 'failure', metrics, message,
    hint: `${action}解除解鎖後重試，從起飛區地面自行起飛。`,
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
    groundClearanceM: clearance,
    altitudeM: position.y - surface.positionM.y,
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
  // Report the first violated limit within the existing safety priority. Keep
  // hard-stop checks ahead of the narrower, recoverable practice envelope.
  for (const envelope of [
    { route: 25, height: 25, horizontal: 12, vertical: 5, tilt: 70, recoverable: false, label: '安全上限' },
    { route: 4, height: 7, horizontal: 3, vertical: 2, tilt: 40, recoverable: true, label: '練習上限' },
  ]) {
    if (routeError > envelope.route) {
      return stop(context,
        `偏離降落路線：距路線 ${routeError.toFixed(2)} m，${envelope.label} ${envelope.route.toFixed(2)} m。`,
        metrics, envelope.recoverable, '先停止側移，緩慢修正回起飛區與藍色降落區之間的路線。')
    }
    if (clearance > envelope.height) {
      return stop(context,
        `降落練習高度過高：機體支撐點離地 ${clearance.toFixed(2)} m，${envelope.label} ${envelope.height.toFixed(2)} m。`,
        metrics, envelope.recoverable, '平順減少油門降低高度，避免急速下降。')
    }
    if (horizontalSpeed > envelope.horizontal) {
      return stop(context,
        `降落練習水平速度過快：${horizontalSpeed.toFixed(2)} m/s，${envelope.label} ${envelope.horizontal.toFixed(2)} m/s。`,
        metrics, envelope.recoverable, '小幅反向傾斜降低水平速度，再恢復近水平。')
    }
    if (verticalSpeed > envelope.vertical) {
      return stop(context,
        `降落練習${velocity.y > 0 ? '爬升' : '下降'}速度過快：${verticalSpeed.toFixed(2)} m/s，${envelope.label} ${envelope.vertical.toFixed(2)} m/s。`,
        metrics, envelope.recoverable, velocity.y > 0 ? '平順減少油門，先降低爬升速度。' : '提早平順加油門，減慢下降速度。')
    }
    if (tilt > envelope.tilt) {
      return stop(context,
        `降落練習機體傾角過大：${tilt.toFixed(1)}°，${envelope.label} ${envelope.tilt.toFixed(1)}°。`,
        metrics, envelope.recoverable, '用小幅反向 Roll／Pitch 修正，讓機體恢復近水平。')
    }
  }

  if (context.mode !== 'practice' && context.elapsedSeconds > 90) {
    return stop(context, '降落挑戰逾時，尚未完成起飛、前往指定區與受控降落。', metrics)
  }
  const launchReady = contact.touching && launchDistance <= 1
    && horizontalSpeed <= 0.5 && verticalSpeed <= 0.3 && tilt <= 15
  if (!launched) {
    if (!launchReady) {
      if (!contact.touching) {
        return stop(context,
          `尚未完成起飛區地面準備：目前未接地，機體支撐點離地 ${clearance.toFixed(2)} m；需先實際接地。`,
          metrics, true, '先在起飛區平穩落地，完成地面準備後才增加油門。')
      }
      if (launchDistance > 1) {
        return stop(context,
          `地面起點不在起飛區內：距起飛中心 ${launchDistance.toFixed(2)} m，允許最多 1.00 m。`,
          metrics, true, '回到起飛區中心地面，再自行起飛。')
      }
      if (horizontalSpeed > 0.5) {
        return stop(context,
          `地面準備的水平速度過快：${horizontalSpeed.toFixed(2)} m/s，允許最多 0.50 m/s。`,
          metrics, true, '降低油門與側移，先在起飛區地面停穩。')
      }
      if (verticalSpeed > 0.3) {
        return stop(context,
          `地面準備的垂直速度過快：${verticalSpeed.toFixed(2)} m/s，允許最多 0.30 m/s。`,
          metrics, true, '先讓機體穩定接地，停止升降再開始。')
      }
      return stop(context,
        `地面準備的機體傾角過大：${tilt.toFixed(1)}°，允許最多 15.0°。`,
        metrics, true, '先把機體恢復近水平，再從起飛區地面起飛。')
    }
    return {
      status: 'continue', checkpointIds: ['landing-launch'], metrics: { ...metrics, landingPhase: 1 },
      hint: `從起飛區緩慢加油門，自行起飛到至少 ${LANDING_LIFTOFF_HEIGHT_M} 公尺；藍色降落區在前方 ${LANDING_TARGET_DISTANCE_M} 公尺。`,
    }
  }
  const liftoff = !lifted && !contact.touching && clearance >= LANDING_LIFTOFF_HEIGHT_M
    && launchDistance <= 1.5 && horizontalSpeed <= 1.5 && verticalSpeed <= 1.5 && tilt <= 20
  if (!lifted) {
    if (contact.touching && launchDistance > 1) {
      return stop(context,
        `尚未離地就沿地面離開起飛區：距起飛中心 ${launchDistance.toFixed(2)} m，地面階段允許最多 1.00 m。`,
        metrics, true, '先從起飛區緩慢加油門離地，不能沿地面滑往降落區。')
    }
    if (!liftoff && launchDistance > 1.5) {
      const liftoffCondition = clearance < LANDING_LIFTOFF_HEIGHT_M
        ? `機體支撐點離地 ${clearance.toFixed(2)} m，起飛需至少 ${LANDING_LIFTOFF_HEIGHT_M.toFixed(2)} m`
        : horizontalSpeed > 1.5 ? `水平速度 ${horizontalSpeed.toFixed(2)} m/s，起飛需不超過 1.50 m/s`
          : verticalSpeed > 1.5 ? `垂直速度 ${verticalSpeed.toFixed(2)} m/s，起飛需不超過 1.50 m/s`
            : tilt > 20 ? `傾角 ${tilt.toFixed(1)}°，起飛需不超過 20.0°`
              : '尚未在起飛區上方記錄到受控離地'
      return stop(context,
        `起飛未完成就離開起飛區：距起飛中心 ${launchDistance.toFixed(2)} m，起飛階段允許最多 1.50 m；${liftoffCondition}。`,
        metrics, true, '先在起飛區上方完成低速、近水平的離地，再前往藍色降落區。')
    }
    const liftoffHint = contact.touching
      ? '尚未離地；緩慢增加油門，保持機體近水平。'
      : clearance < LANDING_LIFTOFF_HEIGHT_M
        ? `目前機體支撐點離地 ${clearance.toFixed(2)} m，需至少 ${LANDING_LIFTOFF_HEIGHT_M.toFixed(2)} m；在起飛區上方平順增加油門。`
        : horizontalSpeed > 1.5
          ? `起飛水平速度 ${horizontalSpeed.toFixed(2)} m/s，需降至 1.50 m/s 以下；先消除側移。`
          : verticalSpeed > 1.5
            ? `起飛垂直速度 ${verticalSpeed.toFixed(2)} m/s，需降至 1.50 m/s 以下；平順調整油門。`
            : `起飛傾角 ${tilt.toFixed(1)}°，需降至 20.0° 以下；先讓機體恢復近水平。`
    return {
      status: 'continue', checkpointIds: liftoff ? ['landing-liftoff'] : [],
      metrics: { ...metrics, landingPhase: liftoff ? 2 : 1 },
      hint: liftoff ? `已起飛。前方 ${LANDING_TARGET_DISTANCE_M} 公尺有藍色降落區與光柱；保持高度、緩慢飛近。`
        : liftoffHint,
    }
  }
  const approach = !contact.touching && clearance >= LANDING_LIFTOFF_HEIGHT_M && clearance <= 5
    && horizontalError <= 1.2 && horizontalSpeed <= 1.5 && verticalSpeed <= 1.2 && tilt <= 15
  if (contact.touching && (!approached || horizontalError > 0.85)) {
    if (horizontalError > 0.85) {
      return stop(context,
        `落在指定降落區外：距藍色降落區中心 ${horizontalError.toFixed(2)} m，接地允許最多 0.85 m。`,
        metrics, true, '先飛到藍色光柱，在墊中心上方減速對準後再下降。')
    }
    return stop(context,
      `接地前未完成空中進場：距降落區中心 ${horizontalError.toFixed(2)} m，尚未記錄在中心 1.20 m 內、離地 0.80～5.00 m 的受控進場。`,
      metrics, true, '先在藍色降落區上方減速並保持近水平，看到進場完成後才下降。')
  }
  if (!approached && !approach) {
    const approachHint = clearance < LANDING_LIFTOFF_HEIGHT_M || clearance > 5
      ? `進場高度尚未到位：機體支撐點離地 ${clearance.toFixed(2)} m，需在 0.80～5.00 m；先調整高度，再開始下降。`
      : horizontalSpeed > 1.5
        ? `進場水平速度 ${horizontalSpeed.toFixed(2)} m/s，需降至 1.50 m/s 以下；先消除側移再下降。`
        : verticalSpeed > 1.2
          ? `進場垂直速度 ${verticalSpeed.toFixed(2)} m/s，需降至 1.20 m/s 以下；先穩住油門。`
          : `進場傾角 ${tilt.toFixed(1)}°，需降至 15.0° 以下；先讓機體恢復近水平。`
    return {
      status: 'continue', metrics: { ...metrics, landingPhase: 2 },
      hint: horizontalError > 1.2
        ? `距藍色降落區中心 ${horizontalError.toFixed(2)} m，需進入 1.20 m 內；保持高度飛近光柱，再減速對準。`
        : approachHint,
    }
  }
  if (approach && !approached) {
    return {
      status: 'continue', checkpointIds: ['landing-approach'], metrics: { ...metrics, landingPhase: 3 },
      hint: '已對準藍色降落區。小量減少油門下降，接地前把下降速度降到 0.8 m/s 以下。',
    }
  }
  if (touched && !contact.touching && clearance > 0.08) {
    return stop(context,
      `接地後再次升空：機體支撐點離地 ${clearance.toFixed(2)} m，接地後允許最多 0.08 m。`,
      metrics, true, '接地後保持低油門，避免再加油門彈起；重新完成進場與平穩接地。')
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
    if (Number.isFinite(previousDescent)) metrics.preImpactDescentSpeedMps = previousDescent
    if (Number.isFinite(previousHorizontalSpeed)) metrics.preImpactHorizontalSpeedMps = previousHorizontalSpeed
    const validAirApproach = approached && descentObserved && newContact
      && previousDescent > 0 && previousDescent <= LANDING_MAX_TOUCHDOWN_SPEED_MPS
      && previousHorizontalSpeed <= 0.8 && horizontalSpeed <= 0.6 && verticalSpeed <= 0.3 && tilt <= 12
    if (!validAirApproach) {
      if (Number.isFinite(previousDescent)) metrics.touchdownDescentSpeedMps = previousDescent
      if (!flightPrevious || !newContact) {
        return stop(context,
          '未觀察到從空中轉為接地：需有前一筆離地資料及本次實際接地，不能直接以地面狀態完成。',
          metrics, true, '從起飛區重新起飛，在藍色降落區受控下降並實際接地。')
      }
      if (previousDescent > LANDING_MAX_TOUCHDOWN_SPEED_MPS) {
        return stop(context,
          `接地前下降速度過快：${previousDescent.toFixed(2)} m/s，允許最多 ${LANDING_MAX_TOUCHDOWN_SPEED_MPS.toFixed(2)} m/s；碰地後速度歸零不代表平穩降落。`,
          metrics, true, '在接地前提早平順加油門減慢下降，不能等碰地才減速。')
      }
      if (previousHorizontalSpeed > 0.8) {
        return stop(context,
          `接地前水平速度過快：${previousHorizontalSpeed.toFixed(2)} m/s，允許最多 0.80 m/s。`,
          metrics, true, '先在降落區上方反向小幅傾斜消除側移，再恢復水平並下降。')
      }
      if (horizontalSpeed > 0.6) {
        return stop(context,
          `接地當下水平速度過快：${horizontalSpeed.toFixed(2)} m/s，允許最多 0.60 m/s。`,
          metrics, true, '先消除水平漂移，讓機體接近停點再接地。')
      }
      if (verticalSpeed > 0.3) {
        return stop(context,
          `接地當下垂直速度過快：${verticalSpeed.toFixed(2)} m/s，允許最多 0.30 m/s。`,
          metrics, true, '接地前降低升降速度，接地後保持低油門。')
      }
      if (tilt > 12) {
        return stop(context,
          `接地當下機體傾角過大：${tilt.toFixed(1)}°，允許最多 12.0°。`,
          metrics, true, '在接地前用小幅 Roll／Pitch 修正到近水平。')
      }
      if (previousDescent <= 0) {
        return stop(context,
          `接地前未觀察到下降：下降速度 ${previousDescent.toFixed(2)} m/s，需大於 0 且不超過 ${LANDING_MAX_TOUCHDOWN_SPEED_MPS.toFixed(2)} m/s。`,
          metrics, true, '對準降落區後小量減少油門，從空中緩慢下降接地。')
      }
      return stop(context,
        `接地前未記錄受控下降進場：目前支撐點離地 ${clearance.toFixed(2)} m；需先在降落區中心 1.20 m 內、離地超過 0.05 m 時觀察到下降速度大於 0.08 m/s。`,
        metrics, true, '先在藍色降落區上方完成進場，再緩慢下降；不能跳過空中步驟。')
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
  const settledHint = !contact.touching
    ? `目前未接地：機體支撐點離地 ${clearance.toFixed(2)} m，穩定計時已歸零；保持低油門、緩慢重新接地，再連續穩住 ${LANDING_SETTLED_DWELL_SECONDS.toFixed(1)} 秒。`
    : horizontalSpeed > 0.2
      ? `接地後水平速度 ${horizontalSpeed.toFixed(2)} m/s，需降至 0.20 m/s 以下；保持低油門並消除側移。`
      : verticalSpeed > 0.2
        ? `接地後垂直速度 ${verticalSpeed.toFixed(2)} m/s，需降至 0.20 m/s 以下；保持低油門，避免彈起。`
        : tilt > 10
          ? `接地後傾角 ${tilt.toFixed(1)}°，需降至 10.0° 以下；保持機體近水平。`
          : `已接地，連續穩住 ${Math.min(dwell, LANDING_SETTLED_DWELL_SECONDS).toFixed(1)}／${LANDING_SETTLED_DWELL_SECONDS.toFixed(1)} 秒；保持低油門，等結果出現再 Disarm。`
  return {
    status: 'continue', checkpointIds, metrics, score,
    hint: touched || touchdown ? settledHint
      : horizontalError > 0.85 ? `距降落區中心 ${horizontalError.toFixed(2)} m，接地需在 0.85 m 內；先減少側移並對準墊中心，再繼續下降。`
        : verticalSpeed > 0.8 ? `目前${velocity.y > 0 ? '爬升' : '下降'}速度 ${verticalSpeed.toFixed(2)} m/s，接地前下降需不超過 0.80 m/s；提早平順調整油門減速。`
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
