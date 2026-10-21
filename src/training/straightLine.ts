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

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return {
    status: 'failure', metrics, message,
    hint: '解除解鎖並重試；從起點穩住，再依序前進、減速及停點。',
  }
}

function excursion(
  context: TrainingEvaluationContext,
  message: string,
  metrics: Readonly<Record<string, number>>,
): TrainingEvaluation {
  if (context.mode !== 'practice') return terminal(message, metrics)
  return {
    status: 'continue', recovery: 'restart',
    metrics: { ...metrics, peakForwardSpeedMps: 0, brakeEntrySpeedMps: 0, furthestProgressM: 0, contiguousDwellSeconds: 0, settled: 0, routePhase: 0 },
    message,
    hint: '本次局部目標已重新開始；先降低速度，回起飛區平穩接地，再自行起飛並走完整條路線。',
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
  if (crossTrackError > STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M
    || progress < -1 || progress > STRAIGHT_LINE_ROUTE_LENGTH_M + 1.25
    || horizontalSpeed > MAXIMUM_SPEED_MPS || verticalSpeed > 2 || tilt > 40
    || position.y < launch.positionM.y - 0.1
    || position.y > targetAltitude + STRAIGHT_LINE_ALTITUDE_TOLERANCE_M
    || furthestProgress - progress > 1.25) {
    return excursion(context, '偏離直線走廊、高度或受控速度範圍，請回起飛區接地後重練。', metrics)
  }

  const groundedStart = !groundStarted && contact.touching && launchDistance <= 0.85
    && horizontalSpeed <= 0.6 && verticalSpeed <= 0.2 && tilt <= 15
  if (!groundStarted && !groundedStart) {
    return excursion(context, '本課須先從起飛區地面開始，再自行起飛；不能從空中或終點跳過起飛。', metrics)
  }
  const atStart = groundStarted && !contact.touching && launchDistance <= 0.7
    && altitudeError <= STRAIGHT_LINE_ALTITUDE_TOLERANCE_M
    && horizontalSpeed <= 0.6 && verticalSpeed <= 0.5 && tilt <= 15
  if (!started) {
    if (launchDistance > STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M) {
      return excursion(context, '先在起飛區上方升到起點環並穩住，再開始前進。', metrics)
    }
    metrics.groundStarted = groundStarted || groundedStart ? 1 : 0
    metrics.takeoffReady = atStart ? 1 : 0
    metrics.routePhase = atStart ? 1 : 0
    return {
      status: 'continue', metrics,
      checkpointIds: [...(groundedStart ? ['straight-ground'] : []), ...(atStart ? ['straight-start'] : [])],
      hint: atStart
        ? '起飛完成。沿直線向前，通過前方三公尺的中途環；保持目前高度。'
        : '從地面自行起飛，升到起飛區上方的起點環；先穩住高度與速度，再向前飛。',
    }
  }
  if (altitudeError > STRAIGHT_LINE_ALTITUDE_TOLERANCE_M) {
    return excursion(context, '航線已開始，請保持起點環的目標高度；回起飛區重練。', metrics)
  }

  const previousProgress = context.previousSample
    ? pad.positionM.z - context.previousSample.state.positionM.z : progress
  // Crossing the transit plane is enough: the pilot need not sample an exact
  // ring position, but a continuous forward route at the correct height is required.
  const transit = !transited && previousProgress <= STRAIGHT_LINE_BRAKE_ZONE_START_M
    && progress >= STRAIGHT_LINE_TRANSIT_DISTANCE_M && progress <= STRAIGHT_LINE_BRAKE_ZONE_START_M + 0.5
    && progress > previousProgress && forwardSpeed >= -0.05
  if (!transited && !transit && progress > STRAIGHT_LINE_BRAKE_ZONE_START_M) {
    return excursion(context, '需先通過三公尺中途環，再到金色減速環；不可跳過路線順序。', metrics)
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
    return excursion(context, '已越過終點，但尚未在金色減速環後觀察到降速；請從地面完整重練。', metrics)
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
  return {
    status: 'continue', metrics, checkpointIds, score,
    hint: !(transited || transit) ? '通過前方三公尺中途環，保持起點環高度；穿過一圈只完成一個步驟。'
      : !(braked || braking) ? '已通過中途環。飛過金色減速環後，反向小幅傾斜降低速度，再到八公尺終點停穩。'
        : settled ? '已到終點，連續穩住 1.2 秒才會完成；保持低速與高度。'
          : '減速已達標。回到八公尺終點區，將水平速度降至 0.35 m/s 以下，再連續穩住 1.2 秒。',
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
