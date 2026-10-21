import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { TRAINING_ROUTE_ALTITUDE_AGL_M } from './field'
import { rotateVectorByQuaternion } from '../math/quaternion'
import type { LessonLearningContent } from './catalog'
import type {
  LessonDefinition,
  LessonEvaluatorContract,
  TrainingEvaluation,
  TrainingEvaluationContext,
  TrainingSample,
} from './types'

/** Prototype geometry/tolerances shared with field presentation, pending pilot trials. */
export const STRAIGHT_LINE_ROUTE_LENGTH_M = 8
export const STRAIGHT_LINE_TARGET_HEIGHT_AGL_M = TRAINING_ROUTE_ALTITUDE_AGL_M
export const STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M = 1.25
export const STRAIGHT_LINE_TRANSIT_DISTANCE_M = 3
export const STRAIGHT_LINE_BRAKE_ZONE_START_M = 5
export const STRAIGHT_LINE_STOP_RADIUS_M = 0.65
export const STRAIGHT_LINE_SETTLED_DWELL_SECONDS = 1.2
export const STRAIGHT_LINE_ALTITUDE_TOLERANCE_M = 0.7
export const STRAIGHT_LINE_MIN_BRAKE_ENTRY_SPEED_MPS = 0.2
export const STRAIGHT_LINE_MIN_BRAKE_REDUCTION_MPS = 0.1
export const STRAIGHT_LINE_BRAKE_REDUCTION_RATIO = 0.3

const MAXIMUM_SAMPLE_GAP_SECONDS = 0.35
const MAXIMUM_SPEED_MPS = 4
const TIME_LIMIT_SECONDS = 90

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function terminal(
  message: string,
  metrics: Readonly<Record<string, number>> = {},
  action = '從起點穩住，再依序前進、減速及停點。',
): TrainingEvaluation {
  return {
    status: 'failure', metrics, message,
    hint: `${action}解除解鎖後重試。`,
  }
}

function excursion(
  context: TrainingEvaluationContext,
  message: string,
  metrics: Readonly<Record<string, number>>,
  action = '平順減速並保持機體水平。',
): TrainingEvaluation {
  if (context.mode !== 'practice') return terminal(message, metrics, action)
  return {
    status: 'continue', recovery: 'restart',
    metrics: {
      ...metrics,
      observedBrakeEntrySpeedMps: metrics.brakeEntrySpeedMps,
      observedFurthestProgressM: metrics.furthestProgressM,
      peakForwardSpeedMps: 0, brakeEntrySpeedMps: 0, furthestProgressM: 0,
      contiguousDwellSeconds: 0, settled: 0, routePhase: 0,
    },
    message,
    hint: `${action}本次路線已重新開始；平穩返回起飛區接地，再自行起飛重練。`,
  }
}

function evaluateStraightLine(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0
    || !Number.isFinite(context.elapsedSeconds) || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) {
    return terminal('直線練習停止：時間或飛行狀態含無效數值。')
  }
  if (sample.state.crashed) return terminal('直線練習停止：機體已撞擊，請重設後重試。')
  if (sample.armed === false) return terminal('直線練習停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖的飛行資料。' }

  const pad = context.sceneReferences.find((reference) => reference.id === 'takeoff-pad')
  const launch = context.sceneReferences.find((reference) => reference.id === 'training-launch')
  const surface = context.sceneReferences.find((reference) => reference.id === 'landing-surface')
  if (!pad || !launch || !surface || !Object.values(pad.positionM).every(Number.isFinite)
    || !Object.values(launch.positionM).every(Number.isFinite) || !Object.values(surface.positionM).every(Number.isFinite)) {
    return terminal('直線練習無法取得有效起飛區參考，請重設訓練場。')
  }
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM)
    || !Number.isFinite(contact.supportOffsetM) || contact.supportOffsetM < 0
    || Math.abs(contact.heightM - surface.positionM.y) > 1e-5
    || (contact.touching && Math.abs(sample.state.positionM.y
      - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M) > 0.003)) {
    return terminal('直線練習停止：缺少有效的地面接觸資料，不能跳過自行起飛。')
  }
  const position = sample.state.positionM
  const velocity = sample.state.velocityMps
  const targetAltitude = surface.positionM.y + STRAIGHT_LINE_TARGET_HEIGHT_AGL_M
  const altitudeError = Math.abs(position.y - targetAltitude)
  const crossTrackError = Math.abs(position.x - pad.positionM.x)
  const progress = pad.positionM.z - position.z
  const forwardSpeed = -velocity.z
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
  const verticalSpeed = Math.abs(velocity.y)
  const groundClearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  const stopError = Math.hypot(position.x - pad.positionM.x, progress - STRAIGHT_LINE_ROUTE_LENGTH_M)
  const launchDistance = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const up = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 1, z: 0 })
  const tilt = Math.acos(Math.max(-1, Math.min(1, up.y))) * 180 / Math.PI
  const groundStarted = context.checkpoints['straight-ground']?.completed === true
  const started = context.checkpoints['straight-start']?.completed === true
  const transited = context.checkpoints['straight-transit']?.completed === true
  const braked = context.checkpoints['straight-brake']?.completed === true
  const peakSpeed = Math.max(metric(context, 'peakForwardSpeedMps'), forwardSpeed, 0)
  const furthestProgress = Math.max(metric(context, 'furthestProgressM'), progress, 0)
  const metrics: Record<string, number> = {
    alongTrackM: progress,
    crossTrackErrorM: crossTrackError,
    launchDistanceM: launchDistance,
    groundClearanceM: groundClearance,
    launchHeightM: Math.max(0, position.y - launch.positionM.y),
    altitudeM: position.y - surface.positionM.y,
    targetAltitudeM: STRAIGHT_LINE_TARGET_HEIGHT_AGL_M,
    altitudeErrorM: altitudeError,
    forwardSpeedMps: forwardSpeed,
    horizontalSpeedMps: horizontalSpeed,
    verticalSpeedMps: verticalSpeed,
    stopErrorM: stopError,
    maxTiltDegrees: tilt,
    peakForwardSpeedMps: peakSpeed,
    brakeEntrySpeedMps: metric(context, 'brakeEntrySpeedMps'),
    furthestProgressM: furthestProgress,
    contiguousDwellSeconds: 0,
    settled: 0,
    groundStarted: groundStarted ? 1 : 0,
    takeoffReady: started ? 1 : 0,
    routePhase: started ? braked ? 3 : transited ? 2 : 1 : 0,
  }

  // Keep the actual previous flight sample across local practice recovery.
  // New objectives cannot hide a reset, frozen physics or a teleport.
  const previousFlight = context.previousFlightSample ?? context.previousSample
  if (previousFlight) {
    const delta = sample.timestampSeconds - previousFlight.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previousFlight.state.timeSeconds
    if (!isFiniteDroneState(previousFlight.state) || !Number.isFinite(delta) || delta <= 0
      || delta > MAXIMUM_SAMPLE_GAP_SECONDS || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previousFlight.state.stepIndex) {
      return terminal('直線練習停止：資料中斷、時間倒退或模擬被重設。', metrics)
    }
    const previousVelocity = previousFlight.state.velocityMps
    const consistencyError = Math.hypot(
      position.x - previousFlight.state.positionM.x - (velocity.x + previousVelocity.x) * 0.5 * delta,
      position.y - previousFlight.state.positionM.y - (velocity.y + previousVelocity.y) * 0.5 * delta,
      position.z - previousFlight.state.positionM.z - (velocity.z + previousVelocity.z) * 0.5 * delta,
    )
    const tolerance = 0.04 + 10 * delta * delta
    metrics.velocityConsistencyErrorM = consistencyError
    metrics.integrationToleranceM = tolerance
    if (consistencyError > tolerance) {
      return terminal('直線練習停止：位置跳躍與速度不一致，不能跳過路線。', metrics)
    }
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > TIME_LIMIT_SECONDS) {
    return terminal('直線挑戰逾時：尚未完成自行起飛、前進、減速與穩定停點。', metrics)
  }
  if (crossTrackError > STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M) {
    return excursion(context,
      `偏離直線走廊：距中心線 ${crossTrackError.toFixed(2)} m，允許最多 ${STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M.toFixed(2)} m。`,
      metrics, '先減少側移，再小幅修正回中心線。')
  }
  if (progress < -1 || progress > STRAIGHT_LINE_ROUTE_LENGTH_M + 1.25) {
    return excursion(context,
      `飛出路線前後範圍：目前前進 ${progress.toFixed(2)} m，允許 −1.00～${(STRAIGHT_LINE_ROUTE_LENGTH_M + 1.25).toFixed(2)} m。`,
      metrics, progress < -1 ? '先停止後退，朝起飛區緩慢修正。' : '提早反向小幅傾斜減速，避免衝過終點。')
  }
  if (horizontalSpeed > MAXIMUM_SPEED_MPS) {
    return excursion(context,
      `水平速度過快：${horizontalSpeed.toFixed(2)} m/s，允許最多 ${MAXIMUM_SPEED_MPS.toFixed(2)} m/s。`,
      metrics, '小幅反向傾斜降低水平速度，再恢復近水平。')
  }
  if (verticalSpeed > 2) {
    return excursion(context,
      `${velocity.y > 0 ? '爬升' : '下降'}速度過快：${verticalSpeed.toFixed(2)} m/s，允許最多 2.00 m/s。`,
      metrics, velocity.y > 0 ? '平順減少油門，先降低爬升速度。' : '提早平順加油門，減慢下降速度。')
  }
  if (tilt > 40) {
    return excursion(context,
      `機體傾角過大：${tilt.toFixed(1)}°，允許最多 40.0°。`,
      metrics, '用小幅反向 Roll／Pitch 修正，讓機體恢復近水平。')
  }
  if (position.y < launch.positionM.y - 0.1) {
    return excursion(context,
      `高度低於起飛地面基準：${(position.y - launch.positionM.y).toFixed(2)} m，允許最低 −0.10 m。`,
      metrics, '先確認機體與地面接觸正常；必要時停止課程並重設。')
  }
  if (position.y > targetAltitude + STRAIGHT_LINE_ALTITUDE_TOLERANCE_M) {
    return excursion(context,
      `高度超過走廊上限：離地 ${metrics.altitudeM.toFixed(2)} m，允許最高 ${(STRAIGHT_LINE_TARGET_HEIGHT_AGL_M + STRAIGHT_LINE_ALTITUDE_TOLERANCE_M).toFixed(2)} m。`,
      metrics, '平順減少油門，降低高度並避免快速下降。')
  }
  if (furthestProgress - progress > 1.25) {
    return excursion(context,
      `後退距離過大：從最遠 ${furthestProgress.toFixed(2)} m 退回 ${progress.toFixed(2)} m，後退 ${(furthestProgress - progress).toFixed(2)} m，允許最多 1.25 m。`,
      metrics, '減速後恢復近水平，避免持續向後漂移。')
  }

  const groundedStart = !groundStarted && contact.touching && launchDistance <= 0.85
    && horizontalSpeed <= 0.6 && verticalSpeed <= 0.2 && tilt <= 15
  if (!groundStarted && !groundedStart) {
    if (!contact.touching) {
      return excursion(context,
        `尚未完成起飛區地面準備：目前未接地，機體支撐點離地 ${groundClearance.toFixed(2)} m；需先實際接地。`,
        metrics, '先在起飛區平穩落地，完成地面準備後才增加油門。')
    }
    if (launchDistance > 0.85) {
      return excursion(context,
        `地面起點不在起飛區內：距起飛中心 ${launchDistance.toFixed(2)} m，允許最多 0.85 m。`,
        metrics, '回到起飛區中心地面再開始。')
    }
    if (horizontalSpeed > 0.6) {
      return excursion(context,
        `地面準備的水平速度過快：${horizontalSpeed.toFixed(2)} m/s，允許最多 0.60 m/s。`,
        metrics, '降低油門與側移，先在起飛區地面停穩。')
    }
    if (verticalSpeed > 0.2) {
      return excursion(context,
        `地面準備的垂直速度過快：${verticalSpeed.toFixed(2)} m/s，允許最多 0.20 m/s。`,
        metrics, '先讓機體穩定接地，停止升降再開始。')
    }
    return excursion(context,
      `地面準備的機體傾角過大：${tilt.toFixed(1)}°，允許最多 15.0°。`,
      metrics, '先把機體恢復近水平，再從起飛區地面起飛。')
  }
  const atStart = groundStarted && !contact.touching && launchDistance <= 0.7
    && altitudeError <= STRAIGHT_LINE_ALTITUDE_TOLERANCE_M
    && horizontalSpeed <= 0.6 && verticalSpeed <= 0.5 && tilt <= 15
  if (!started) {
    if (launchDistance > STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M) {
      return excursion(context,
        `起點尚未穩住就離開起飛區：距起飛中心 ${launchDistance.toFixed(2)} m，起飛階段允許最多 ${STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M.toFixed(2)} m。`,
        metrics, '先在起飛區上方升到 2.30～3.70 m，控制側移與升降，再開始前進。')
    }
    metrics.groundStarted = groundStarted || groundedStart ? 1 : 0
    metrics.takeoffReady = atStart ? 1 : 0
    metrics.routePhase = atStart ? 1 : 0
    const startHint = contact.touching
      ? '地面準備完成；緩慢加油門自行起飛，升到起點環的 2.30～3.70 m 高度。'
      : launchDistance > 0.7
        ? `起點尚未穩住：距起飛中心 ${launchDistance.toFixed(2)} m，需回到 0.70 m 內；先減少側移。`
        : altitudeError > STRAIGHT_LINE_ALTITUDE_TOLERANCE_M
          ? `起點高度尚未到位：離地 ${metrics.altitudeM.toFixed(2)} m，需 2.30～3.70 m；平順調整油門。`
          : horizontalSpeed > 0.6
            ? `起點水平速度 ${horizontalSpeed.toFixed(2)} m/s，需降至 0.60 m/s 以下；小幅反向傾斜減速。`
            : verticalSpeed > 0.5
              ? `起點垂直速度 ${verticalSpeed.toFixed(2)} m/s，需降至 0.50 m/s 以下；平順調整油門穩住高度。`
              : `起點傾角 ${tilt.toFixed(1)}°，需降至 15.0° 以下；先讓機體恢復近水平。`
    return {
      status: 'continue', metrics,
      checkpointIds: [...(groundedStart ? ['straight-ground'] : []), ...(atStart ? ['straight-start'] : [])],
      hint: atStart
        ? '起飛完成。沿直線向前，通過前方三公尺的中途環；保持目前高度。'
        : startHint,
    }
  }
  if (altitudeError > STRAIGHT_LINE_ALTITUDE_TOLERANCE_M) {
    return excursion(context,
      `航線高度偏低：離地 ${metrics.altitudeM.toFixed(2)} m，航線允許 ${(STRAIGHT_LINE_TARGET_HEIGHT_AGL_M - STRAIGHT_LINE_ALTITUDE_TOLERANCE_M).toFixed(2)}～${(STRAIGHT_LINE_TARGET_HEIGHT_AGL_M + STRAIGHT_LINE_ALTITUDE_TOLERANCE_M).toFixed(2)} m。`,
      metrics, '小量增加油門，先穩住高度再向前飛。')
  }

  const previousProgress = context.previousSample
    ? pad.positionM.z - context.previousSample.state.positionM.z : progress
  // Crossing the transit plane is enough: the pilot need not sample an exact
  // ring position, but a continuous forward route at the correct height is required.
  const transit = !transited && previousProgress <= STRAIGHT_LINE_BRAKE_ZONE_START_M
    && progress >= STRAIGHT_LINE_TRANSIT_DISTANCE_M && progress <= STRAIGHT_LINE_BRAKE_ZONE_START_M + 0.5
    && progress > previousProgress && forwardSpeed >= -0.05
  if (!transited && !transit && progress > STRAIGHT_LINE_BRAKE_ZONE_START_M) {
    return excursion(context,
      `漏過中途環的順序檢查：目前前進 ${progress.toFixed(2)} m，尚未記錄向前通過 ${STRAIGHT_LINE_TRANSIT_DISTANCE_M.toFixed(2)} m 中途環，就已超過 ${STRAIGHT_LINE_BRAKE_ZONE_START_M.toFixed(2)} m 減速區入口。`,
      metrics, '先保持航線高度向前通過三公尺中途環，再前往金色減速環。')
  }

  let brakeEntrySpeed = metric(context, 'brakeEntrySpeedMps')
  const previousForwardSpeed = context.previousSample ? -context.previousSample.state.velocityMps.z : 0
  const entryCrossing = previousProgress < STRAIGHT_LINE_BRAKE_ZONE_START_M
    && progress >= STRAIGHT_LINE_BRAKE_ZONE_START_M && progress > previousProgress
  // Interpolate the measured continuous segment at the entry plane instead of
  // requiring a sample exactly at five metres. Pre-zone peak speed never counts.
  if (!brakeEntrySpeed && (transited || transit)) {
    const crossingFraction = entryCrossing
      ? (STRAIGHT_LINE_BRAKE_ZONE_START_M - previousProgress) / (progress - previousProgress) : 0
    const observedEntrySpeed = entryCrossing
      ? previousForwardSpeed + (forwardSpeed - previousForwardSpeed) * crossingFraction
      : previousProgress >= STRAIGHT_LINE_BRAKE_ZONE_START_M ? previousForwardSpeed : 0
    if (observedEntrySpeed >= STRAIGHT_LINE_MIN_BRAKE_ENTRY_SPEED_MPS) brakeEntrySpeed = observedEntrySpeed
  }
  metrics.brakeEntrySpeedMps = brakeEntrySpeed
  const inZoneEnd = Math.min(progress, STRAIGHT_LINE_ROUTE_LENGTH_M)
  const observedInZone = Boolean(context.previousSample)
    && inZoneEnd > Math.max(previousProgress, STRAIGHT_LINE_BRAKE_ZONE_START_M)
  const endFraction = progress > STRAIGHT_LINE_ROUTE_LENGTH_M && previousProgress < STRAIGHT_LINE_ROUTE_LENGTH_M
    ? (STRAIGHT_LINE_ROUTE_LENGTH_M - previousProgress) / (progress - previousProgress) : 1
  const inZoneForwardSpeed = previousForwardSpeed + (forwardSpeed - previousForwardSpeed) * endFraction
  const previousLateralSpeed = context.previousSample?.state.velocityMps.x ?? velocity.x
  const inZoneLateralSpeed = previousLateralSpeed + (velocity.x - previousLateralSpeed) * endFraction
  const inZoneHorizontalSpeed = Math.hypot(inZoneLateralSpeed, inZoneForwardSpeed)
  if (observedInZone) metrics.inZoneHorizontalSpeedMps = inZoneHorizontalSpeed
  metrics.requiredBrakeReductionMps = Math.max(
    STRAIGHT_LINE_MIN_BRAKE_REDUCTION_MPS, brakeEntrySpeed * STRAIGHT_LINE_BRAKE_REDUCTION_RATIO,
  )
  metrics.requiredBrakeSpeedMps = brakeEntrySpeed - metrics.requiredBrakeReductionMps
  const braking = (transited || transit) && !braked && observedInZone
    && progress <= STRAIGHT_LINE_ROUTE_LENGTH_M + STRAIGHT_LINE_STOP_RADIUS_M
    && brakeEntrySpeed >= STRAIGHT_LINE_MIN_BRAKE_ENTRY_SPEED_MPS && inZoneForwardSpeed >= -0.2
    && inZoneHorizontalSpeed <= brakeEntrySpeed - Math.max(
      STRAIGHT_LINE_MIN_BRAKE_REDUCTION_MPS,
      brakeEntrySpeed * STRAIGHT_LINE_BRAKE_REDUCTION_RATIO,
    ) + 1e-9
  // Evaluate this very sample's valid braking before deciding it missed the
  // zone; the former check rejected a valid reduction near the final ring.
  if (transited && !braked && !braking && progress > STRAIGHT_LINE_ROUTE_LENGTH_M + STRAIGHT_LINE_STOP_RADIUS_M) {
    const end = `目前前進 ${progress.toFixed(2)} m，已超過停點範圍 ${(STRAIGHT_LINE_ROUTE_LENGTH_M + STRAIGHT_LINE_STOP_RADIUS_M).toFixed(2)} m。`
    if (brakeEntrySpeed < STRAIGHT_LINE_MIN_BRAKE_ENTRY_SPEED_MPS) {
      return excursion(context,
        `未記錄有效減速入口速度：記錄值 ${brakeEntrySpeed.toFixed(2)} m/s，需在 ${STRAIGHT_LINE_BRAKE_ZONE_START_M.toFixed(2)} m 入口至少 ${STRAIGHT_LINE_MIN_BRAKE_ENTRY_SPEED_MPS.toFixed(2)} m/s；${end}`,
        metrics, '以可控速度飛過金色環，再在五至八公尺區間實際減速。')
    }
    if (!observedInZone) {
      return excursion(context,
        `越過終點前未確認有效減速：${end}目前水平速度 ${horizontalSpeed.toFixed(2)} m/s，已在 ${STRAIGHT_LINE_BRAKE_ZONE_START_M.toFixed(2)}～${STRAIGHT_LINE_ROUTE_LENGTH_M.toFixed(2)} m 減速區外，這次區外速度不採計；入口 ${brakeEntrySpeed.toFixed(2)} m/s，需在區內降低至少 30% 且至少 0.10 m/s，降至 ${metrics.requiredBrakeSpeedMps.toFixed(2)} m/s 以下。`,
        metrics, '在五至八公尺區間完成減速，不能通過終點後才煞停。')
    }
    const reduction = `入口 ${brakeEntrySpeed.toFixed(2)} m/s，區內水平速度 ${inZoneHorizontalSpeed.toFixed(2)} m/s；需降低至少 30% 且至少 0.10 m/s，降至 ${metrics.requiredBrakeSpeedMps.toFixed(2)} m/s 以下`
    if (inZoneForwardSpeed < -0.2) {
      return excursion(context,
        `減速時已反向後退：區內前進速度 ${inZoneForwardSpeed.toFixed(2)} m/s，允許最低 −0.20 m/s；${end}`,
        metrics, '反向小幅傾斜減速後及時恢復水平，避免煞成後退。')
    }
    if (inZoneHorizontalSpeed <= metrics.requiredBrakeSpeedMps + 1e-9) {
      return excursion(context,
        `減速確認晚於終點範圍：${end}${reduction}，但需在前進 ${(STRAIGHT_LINE_ROUTE_LENGTH_M + STRAIGHT_LINE_STOP_RADIUS_M).toFixed(2)} m 前完成確認。`,
        metrics, '提早在五至八公尺區間完成減速，避免超過終點後才確認。')
    }
    return excursion(context,
      `區內減速不足：${reduction}；${end}`,
      metrics, '過金色環後提早反向小幅傾斜，降低水平速度再恢復水平。')
  }
  const settled = (braked || braking) && stopError <= STRAIGHT_LINE_STOP_RADIUS_M && altitudeError <= 0.45
    && horizontalSpeed <= 0.35 && verticalSpeed <= 0.35 && tilt <= 12
  const localDelta = context.previousSample ? sample.timestampSeconds - context.previousSample.timestampSeconds : 0
  const dwell = settled && metric(context, 'settled') === 1
    ? metric(context, 'contiguousDwellSeconds') + localDelta : 0
  metrics.settled = settled ? 1 : 0
  metrics.contiguousDwellSeconds = dwell
  metrics.routePhase = braked || braking ? settled ? 4 : 3 : transited || transit ? 2 : 1
  const stopped = settled && dwell + 1e-9 >= STRAIGHT_LINE_SETTLED_DWELL_SECONDS
  const checkpointIds = [
    ...(transit ? ['straight-transit'] : []),
    ...(braking ? ['straight-brake'] : []),
    ...(stopped ? ['straight-stop'] : []),
  ]
  const score = Math.max(0, Math.min(100,
    100 - stopError * 10 - altitudeError * 15 - horizontalSpeed * 10 - verticalSpeed * 10 - tilt * 0.4,
  ))
  if (stopped && context.elapsedSeconds >= 3) {
    return {
      status: 'success', metrics, checkpointIds, score,
      message: '已自行起飛、沿直線前進，在金色環後減速，並於終點連續穩住。',
    }
  }
  const stopHint = stopError > STRAIGHT_LINE_STOP_RADIUS_M
    ? `距八公尺終點 ${stopError.toFixed(2)} m，需進入 ${STRAIGHT_LINE_STOP_RADIUS_M.toFixed(2)} m 內；低速修正到終點環中心。`
    : altitudeError > 0.45
      ? `停點高度誤差 ${altitudeError.toFixed(2)} m，需不超過 0.45 m；平順調整油門回到 3.00 m 高度。`
      : horizontalSpeed > 0.35
        ? `停點水平速度 ${horizontalSpeed.toFixed(2)} m/s，需降至 0.35 m/s 以下；反向小幅傾斜減速再恢復水平。`
        : verticalSpeed > 0.35
          ? `停點垂直速度 ${verticalSpeed.toFixed(2)} m/s，需降至 0.35 m/s 以下；先穩住油門與高度。`
          : `停點傾角 ${tilt.toFixed(1)}°，需降至 12.0° 以下；先恢復近水平。`
  return {
    status: 'continue', metrics, checkpointIds, score,
    hint: !(transited || transit) ? '通過前方三公尺中途環，保持起點環高度；穿過一圈只完成一個步驟。'
      : !(braked || braking) ? '已通過中途環。飛過金色減速環後，反向小幅傾斜降低速度，再到八公尺終點停穩。'
        : settled ? '已到終點，連續穩住 1.2 秒才會完成；保持低速與高度。'
          : `減速已達標。${stopHint}達標後需連續穩住 1.2 秒。`,
  }
}

export const straightLineEvaluator: LessonEvaluatorContract = { evaluate: evaluateStraightLine }

export const STRAIGHT_LINE_LESSON: LessonDefinition = {
  id: 'straight-line', priority: 1.5, title: 'Straight Line and Stop',
  description: '在起飛墊前方的直線走廊依序前進、減速，最後在八公尺處穩定停點。',
  availability: 'available', available: true,
  objectives: ['從地面自行起飛，到起點環穩住再前進。', '通過中途目標後，在減速區實際降低速度。', '在終點低速、水平地連續穩住。'],
  setup: {
    requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['takeoff-pad', 'training-launch', 'landing-surface'],
    spawnPositionM: { x: 0, y: 0, z: 0 }, spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  checkpoints: [
    { id: 'straight-ground', title: '地面準備', description: '在起飛區地面開始，等待自己增加油門起飛。' },
    { id: 'straight-start', title: '起點穩定', description: '在起點保持水平、低速與目標高度。' },
    { id: 'straight-transit', title: '直線前進', description: '維持高度，實際飛過中途三公尺目標。' },
    { id: 'straight-brake', title: '提早減速', description: '在終點前觀察到實際速度降低。' },
    { id: 'straight-stop', title: '終點穩住', description: '在八公尺終點低速、水平地連續穩住。' },
  ],
  success: {
    title: '直線與停點完成', description: '已依序前進、減速並在終點穩定停留。',
    criteria: ['連續且依序的真實軌跡', '走廊與高度保持', '實際降速與連續穩定停點'],
  },
  failure: {
    title: '直線路線尚未完成', description: '需重新建立受控路線、減速與停點。',
    criteria: ['不能跳過中途與減速', '不能瞬移、重設或以示範取得成績', '未解除解鎖且狀態有效'],
  },
  scoring: {
    maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 3,
    metricLabels: ['alongTrackM', 'crossTrackErrorM', 'altitudeErrorM', 'forwardSpeedMps', 'stopErrorM', 'contiguousDwellSeconds'],
  },
  hints: ['Acro 搖桿回中只停止旋轉，不會消除前進速度；需反向傾斜減速，再恢復近水平。'],
  evaluator: straightLineEvaluator,
}

export const STRAIGHT_LINE_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L03', title: '起飛、直線與減速停點', level: '入門', prerequisiteIds: ['hover'],
  objectives: ['沿直線前進八公尺並維持高度。', '提早減速，在終點連續穩住而非高速掠過。'],
  steps: [
    '從地面自行起飛，升到起飛區上方的起點環並穩住；課程不會把你放在半空中。',
    '小幅前傾建立前進速度，通過三公尺中途目標；適度補油維持高度。',
    '三公尺中途環通過後，飛過五公尺金色減速環，再以反向小幅傾斜降低前進速度。',
    'Acro 回中不會自動煞停；觀察實際速度下降後，再將機體帶回近水平。',
    '在八公尺終點區內把水平速度降至 0.35 m/s 以下，連續穩住 1.2 秒才完成；只穿過金色圈圈不算整課成功。',
  ],
  commonMistakes: [
    '接近終點才大幅反向操作，造成越過終點或向後飛。',
    '只把搖桿回中，誤以為機體會自動煞停或回平。',
    '只顧路線，不補償姿態改變造成的高度與垂直速度變化。',
  ],
}
