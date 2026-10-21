import { isFiniteDroneState } from '../drone'
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
export const STRAIGHT_LINE_HEIGHT_OFFSET_M = 2.5
export const STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M = 1.25
export const STRAIGHT_LINE_TRANSIT_DISTANCE_M = 3
export const STRAIGHT_LINE_BRAKE_ZONE_START_M = 5
export const STRAIGHT_LINE_STOP_RADIUS_M = 0.65
export const STRAIGHT_LINE_SETTLED_DWELL_SECONDS = 1.2
export const STRAIGHT_LINE_ALTITUDE_TOLERANCE_M = 0.7

const MAXIMUM_SAMPLE_GAP_SECONDS = 0.35
const MAXIMUM_SPEED_MPS = 4
const TIME_LIMIT_SECONDS = 45

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
    hint: '本次局部目標已重新開始；先降低速度、回到起點與目標高度，穩住後再走完整條路線。',
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
  if (!pad || !Object.values(pad.positionM).every(Number.isFinite)) {
    return terminal('直線練習無法取得有效起飛墊參考，請重設訓練場。')
  }
  const position = sample.state.positionM
  const velocity = sample.state.velocityMps
  const targetAltitude = pad.positionM.y + STRAIGHT_LINE_HEIGHT_OFFSET_M
  const altitudeError = Math.abs(position.y - targetAltitude)
  const crossTrackError = Math.abs(position.x - pad.positionM.x)
  const progress = pad.positionM.z - position.z
  const forwardSpeed = -velocity.z
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
  const verticalSpeed = Math.abs(velocity.y)
  const stopError = Math.hypot(position.x - pad.positionM.x, progress - STRAIGHT_LINE_ROUTE_LENGTH_M)
  const up = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 1, z: 0 })
  const tilt = Math.acos(Math.max(-1, Math.min(1, up.y))) * 180 / Math.PI
  const peakSpeed = Math.max(metric(context, 'peakForwardSpeedMps'), forwardSpeed, 0)
  const furthestProgress = Math.max(metric(context, 'furthestProgressM'), progress, 0)
  const metrics: Record<string, number> = {
    alongTrackM: progress,
    crossTrackErrorM: crossTrackError,
    altitudeM: position.y - pad.positionM.y,
    targetAltitudeM: STRAIGHT_LINE_HEIGHT_OFFSET_M,
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
    routePhase: 0,
  }

  // Local practice recovery clears previousSample; the flight-level sample still
  // guards continuity so resetting objectives cannot hide a teleport or rewind.
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

  if (crossTrackError > STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M || altitudeError > STRAIGHT_LINE_ALTITUDE_TOLERANCE_M
    || progress < -1 || progress > STRAIGHT_LINE_ROUTE_LENGTH_M + 1.25
    || horizontalSpeed > MAXIMUM_SPEED_MPS || verticalSpeed > 2 || tilt > 40
    || furthestProgress - progress > 1.25) {
    return excursion(context, '偏離直線走廊、目標高度或受控速度範圍，請回到起點重練。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > TIME_LIMIT_SECONDS) {
    return terminal('直線挑戰逾時：尚未完成依序前進、減速與穩定停點。', metrics)
  }

  const started = context.checkpoints['straight-start']?.completed === true
  const transited = context.checkpoints['straight-transit']?.completed === true
  const braked = context.checkpoints['straight-brake']?.completed === true
  const atStart = Math.hypot(position.x - pad.positionM.x, progress) <= 0.7
    && horizontalSpeed <= 0.6 && verticalSpeed <= 0.5 && tilt <= 15
  if (!started && !atStart) {
    return excursion(context, '需從起點穩定開始，不能跳到中途或終點。', metrics)
  }
  if (started && !transited && progress > STRAIGHT_LINE_BRAKE_ZONE_START_M) {
    return excursion(context, '必須先通過中途目標，再進入減速區；不可跳過路線順序。', metrics)
  }
  if (transited && !braked && progress >= STRAIGHT_LINE_ROUTE_LENGTH_M - STRAIGHT_LINE_STOP_RADIUS_M) {
    return excursion(context, '尚未在減速區觀察到實際降速；穿過終點不算停點。', metrics)
  }

  const transit = started && !transited && progress >= STRAIGHT_LINE_TRANSIT_DISTANCE_M
    && progress <= STRAIGHT_LINE_BRAKE_ZONE_START_M && forwardSpeed >= 0.6
  const brakeEntrySpeed = metric(context, 'brakeEntrySpeedMps') || (
    transited && progress >= STRAIGHT_LINE_BRAKE_ZONE_START_M
      && progress < STRAIGHT_LINE_ROUTE_LENGTH_M - STRAIGHT_LINE_STOP_RADIUS_M && forwardSpeed >= 0.8
      ? forwardSpeed : 0
  )
  metrics.brakeEntrySpeedMps = brakeEntrySpeed
  const previousProgress = context.previousSample
    ? pad.positionM.z - context.previousSample.state.positionM.z : 0
  const braking = transited && !braked && progress >= STRAIGHT_LINE_BRAKE_ZONE_START_M
    && progress < STRAIGHT_LINE_ROUTE_LENGTH_M - STRAIGHT_LINE_STOP_RADIUS_M
    && previousProgress >= STRAIGHT_LINE_BRAKE_ZONE_START_M
    && brakeEntrySpeed >= 0.8 && forwardSpeed >= -0.2 && horizontalSpeed <= brakeEntrySpeed * 0.7
  const settled = braked && stopError <= STRAIGHT_LINE_STOP_RADIUS_M && altitudeError <= 0.45
    && horizontalSpeed <= 0.35 && verticalSpeed <= 0.35 && tilt <= 12
  const localDelta = context.previousSample ? sample.timestampSeconds - context.previousSample.timestampSeconds : 0
  const dwell = settled && metric(context, 'settled') === 1
    ? metric(context, 'contiguousDwellSeconds') + localDelta : 0
  metrics.settled = settled ? 1 : 0
  metrics.contiguousDwellSeconds = dwell
  metrics.routePhase = braked ? settled ? 4 : 3 : transited || transit ? 2 : started || atStart ? 1 : 0
  const stopped = settled && dwell + 1e-9 >= STRAIGHT_LINE_SETTLED_DWELL_SECONDS
  const checkpointIds = [
    ...(!started && atStart ? ['straight-start'] : []),
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
      message: '已沿直線維持高度，實際降低前進速度，並在終點連續穩住。',
    }
  }
  return {
    status: 'continue', metrics, checkpointIds, score,
    hint: !started ? '先在起點保持水平、低速與目標高度。'
      : !transited ? '小幅前傾建立前進速度，沿直線通過中途目標並維持高度。'
        : !braked ? '接近終點前反向小幅傾斜降低前進速度；搖桿回中不會自動煞停。'
          : settled ? '在終點連續穩住，觀察位置、速度與高度。'
            : '降低剩餘速度，回到終點上方，再以小幅操作維持穩定。',
  }
}

export const straightLineEvaluator: LessonEvaluatorContract = { evaluate: evaluateStraightLine }

export const STRAIGHT_LINE_LESSON: LessonDefinition = {
  id: 'straight-line', priority: 1.75, title: 'Straight Line and Stop',
  description: '在起飛墊前方的直線走廊依序前進、減速，最後在八公尺處穩定停點。',
  availability: 'available', available: true,
  objectives: ['從起點穩定開始並維持目標高度。', '通過中途目標後，在減速區實際降低速度。', '在終點低速、水平地連續穩住。'],
  setup: {
    requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['takeoff-pad'],
    spawnPositionM: { x: 0, y: 3, z: 0 }, spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  checkpoints: [
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
  code: 'L04', title: '直線與減速停點', level: '入門', prerequisiteIds: ['landing'],
  objectives: ['沿直線前進八公尺並維持高度。', '提早減速，在終點連續穩住而非高速掠過。'],
  steps: [
    '從空中起點開始，先確認水平姿態、前方路線與目標高度。',
    '小幅前傾建立前進速度，通過三公尺中途目標；適度補油維持高度。',
    '進入五公尺後的減速區前先看終點，以反向小幅傾斜降低前進速度。',
    'Acro 回中不會自動煞停；觀察實際速度下降後，再將機體帶回近水平。',
    '在八公尺終點小幅修正位置、高度及剩餘速度，連續穩住完成本課。',
  ],
  commonMistakes: [
    '接近終點才大幅反向操作，造成越過終點或向後飛。',
    '只把搖桿回中，誤以為機體會自動煞停或回平。',
    '只顧路線，不補償姿態改變造成的高度與垂直速度變化。',
  ],
}
