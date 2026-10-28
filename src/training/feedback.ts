import type { TrainingEvaluation } from './types'
import { orbitObjective, orbitRouteGuide, orbitTrainingHint } from './orbitFeedback'
import { ORBIT_REQUIRED_LAPS } from './orbit'
import {
  BASIC_RECOVERY_AREA_RADIUS_M as RECOVERY_AREA_RADIUS,
  BASIC_RECOVERY_TARGET_HEIGHT_M as RECOVERY_TARGET_HEIGHT,
  BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M as RECOVERY_PREP_HEIGHT,
  BASIC_RECOVERY_MIN_HEIGHT_M as RECOVERY_MIN_HEIGHT,
  BASIC_RECOVERY_SINK_ONSET_MIN_HEIGHT_M as RECOVERY_SINK_HEIGHT,
  BASIC_RECOVERY_HOLD_SECONDS as RECOVERY_HOLD_SECONDS,
  BASIC_RECOVERY_PREPARATION_SECONDS as RECOVERY_PREP_SECONDS,
  BASIC_RECOVERY_PREPARATION_VERTICAL_MPS as RECOVERY_PREP_VERTICAL,
  BASIC_RECOVERY_PREPARATION_HORIZONTAL_MPS as RECOVERY_PREP_HORIZONTAL,
  BASIC_RECOVERY_DRIFT_PREPARATION_MPS as RECOVERY_DRIFT_PREP,
  BASIC_RECOVERY_TILT_ONSET_DEGREES as RECOVERY_TILT_ONSET,
  BASIC_RECOVERY_LEVEL_DEGREES as RECOVERY_TILT_LEVEL,
  BASIC_RECOVERY_SINK_LEVEL_DEGREES as RECOVERY_SINK_LEVEL,
  BASIC_RECOVERY_DRIFT_LEVEL_DEGREES as RECOVERY_DRIFT_LEVEL,
  BASIC_RECOVERY_MAX_BODY_RATE_DEGREES as RECOVERY_MAX_RATE,
  BASIC_RECOVERY_SINK_ONSET_MPS as RECOVERY_SINK_ONSET,
  BASIC_RECOVERY_SINK_STOP_MPS as RECOVERY_SINK_STOP,
  BASIC_RECOVERY_SINK_CLIMB_MPS as RECOVERY_SINK_CLIMB,
  BASIC_RECOVERY_DRIFT_ONSET_MPS as RECOVERY_DRIFT_ONSET,
  BASIC_RECOVERY_DRIFT_STOP_MPS as RECOVERY_DRIFT_STOP,
  BASIC_RECOVERY_DRIFT_VERTICAL_MPS as RECOVERY_DRIFT_VERTICAL,
  BASIC_RECOVERY_TIME_LIMIT_SECONDS as RECOVERY_TIME_LIMIT,
} from './basicRecovery'
import { LANDING_LIFTOFF_HEIGHT_M, LANDING_ZONE_DISTANCE_M, LANDING_ZONE_RADIUS_M } from './landing'
import {
  FULL_ROLL_AREA_RADIUS_M as ROLL_AREA_RADIUS,
  FULL_ROLL_TARGET_HEIGHT_M as ROLL_TARGET_HEIGHT,
  FULL_ROLL_MIN_PREPARATION_HEIGHT_M as ROLL_PREP_HEIGHT,
  FULL_ROLL_MIN_HEIGHT_M as ROLL_MIN_HEIGHT,
  FULL_ROLL_PREPARATION_SECONDS as ROLL_PREP_SECONDS,
  FULL_ROLL_HOLD_SECONDS as ROLL_HOLD_SECONDS,
  FULL_ROLL_PREPARATION_TILT_DEGREES as ROLL_PREP_TILT,
  FULL_ROLL_RECOVERY_TILT_DEGREES as ROLL_RECOVERY_TILT,
  FULL_ROLL_MAX_BODY_RATE_DEGREES as ROLL_MAX_RATE,
  FULL_ROLL_MAX_HORIZONTAL_SPEED_MPS as ROLL_MAX_HORIZONTAL,
  FULL_ROLL_PREPARATION_VERTICAL_MPS as ROLL_PREP_VERTICAL,
  FULL_ROLL_RECOVERY_DESCENT_MPS as ROLL_RECOVERY_DESCENT,
  FULL_ROLL_RECOVERY_CLIMB_MPS as ROLL_RECOVERY_CLIMB,
  FULL_ROLL_TIME_LIMIT_SECONDS as ROLL_TIME_LIMIT,
} from './fullRoll'
import {
  fullFlipRequiredDirection,
  FULL_FLIP_AREA_RADIUS_M as FLIP_AREA_RADIUS,
  FULL_FLIP_TARGET_HEIGHT_M as FLIP_TARGET_HEIGHT,
  FULL_FLIP_MIN_PREPARATION_HEIGHT_M as FLIP_PREP_HEIGHT,
  FULL_FLIP_MIN_HEIGHT_M as FLIP_MIN_HEIGHT,
  FULL_FLIP_PREPARATION_SECONDS as FLIP_PREP_SECONDS,
  FULL_FLIP_HOLD_SECONDS as FLIP_HOLD_SECONDS,
  FULL_FLIP_PREPARATION_TILT_DEGREES as FLIP_PREP_TILT,
  FULL_FLIP_RECOVERY_TILT_DEGREES as FLIP_RECOVERY_TILT,
  FULL_FLIP_MAX_BODY_RATE_DEGREES as FLIP_MAX_RATE,
  FULL_FLIP_MAX_HORIZONTAL_SPEED_MPS as FLIP_MAX_HORIZONTAL,
  FULL_FLIP_PREPARATION_VERTICAL_MPS as FLIP_PREP_VERTICAL,
  FULL_FLIP_RECOVERY_DESCENT_MPS as FLIP_RECOVERY_DESCENT,
  FULL_FLIP_RECOVERY_CLIMB_MPS as FLIP_RECOVERY_CLIMB,
  FULL_FLIP_TIME_LIMIT_SECONDS as FLIP_TIME_LIMIT,
} from './fullFlip'
import {
  POWER_LOOP_TARGET_HEIGHT_M as LOOP_TARGET_HEIGHT,
  POWER_LOOP_MIN_ENTRY_HEIGHT_M as LOOP_ENTRY_HEIGHT,
  POWER_LOOP_MIN_HEIGHT_M as LOOP_MIN_HEIGHT,
  POWER_LOOP_AREA_RADIUS_M as LOOP_AREA_RADIUS,
  POWER_LOOP_MIN_ENTRY_SPEED_MPS as LOOP_ENTRY_SPEED,
  POWER_LOOP_MIN_HEIGHT_GAIN_M as LOOP_HEIGHT_GAIN,
  POWER_LOOP_MIN_FORWARD_SPAN_M as LOOP_SPAN,
  POWER_LOOP_MIN_REVERSE_TRAVEL_M as LOOP_REVERSE,
  POWER_LOOP_HOLD_SECONDS as LOOP_HOLD,
  POWER_LOOP_RECOVERY_TILT_DEGREES as LOOP_RECOVERY_TILT,
  POWER_LOOP_TIME_LIMIT_SECONDS as LOOP_TIME_LIMIT,
} from './powerLoop'
import {
  SPLIT_S_TARGET_HEIGHT_M as SPLIT_TARGET_HEIGHT,
  SPLIT_S_MIN_ENTRY_HEIGHT_M as SPLIT_ENTRY_HEIGHT,
  SPLIT_S_MIN_HEIGHT_M as SPLIT_MIN_HEIGHT,
  SPLIT_S_AREA_RADIUS_M as SPLIT_AREA_RADIUS,
  SPLIT_S_MIN_ENTRY_SPEED_MPS as SPLIT_ENTRY_SPEED,
  SPLIT_S_MIN_HEIGHT_LOSS_M as SPLIT_HEIGHT_LOSS,
  SPLIT_S_MIN_REVERSE_TRAVEL_M as SPLIT_REVERSE,
  SPLIT_S_HOLD_SECONDS as SPLIT_HOLD,
  SPLIT_S_RECOVERY_TILT_DEGREES as SPLIT_RECOVERY_TILT,
  SPLIT_S_TIME_LIMIT_SECONDS as SPLIT_TIME_LIMIT,
} from './splitS'
import {
  STRAIGHT_LINE_BRAKE_ZONE_START_M,
  STRAIGHT_LINE_GATE_RADIUS_M,
  STRAIGHT_LINE_ROUTE_LENGTH_M,
  STRAIGHT_LINE_TRANSIT_DISTANCE_M,
} from './straightLine'

function isFullFlipLesson(lessonId: string | null): boolean {
  return lessonId === 'full-flip' || fullFlipRequiredDirection(lessonId ?? '') !== 0
}

function flipCourseDirection(lessonId: string | null): string | null {
  const required = fullFlipRequiredDirection(lessonId ?? '')
  return required === 1 ? '前翻' : required === -1 ? '後翻' : null
}

export interface TrainingMetricDisplay {
  readonly key: string
  readonly label: string
  readonly value: string
}

interface MetricDefinition {
  readonly label: string
  readonly unit: string
  readonly digits: number
  readonly transform?: (value: number) => number
}

const METRICS: Readonly<Record<string, MetricDefinition>> = {
  launchHeightM: { label: '離起飛地面', unit: 'm', digits: 2 },
  launchDistanceM: { label: '距離起飛點', unit: 'm', digits: 2 },
  altitudeM: { label: '起飛點上方', unit: 'm', digits: 2 },
  landingHeightM: { label: '離地間隙', unit: 'm', digits: 2 },
  landingPositionErrorM: { label: '距降落區中心', unit: 'm', digits: 2 },
  landingRouteErrorM: { label: '偏離前往路線', unit: 'm', digits: 2 },
  groundTouching: { label: '地面接觸', unit: '', digits: 0 },
  groundClearanceM: { label: '支撐點離地', unit: 'm', digits: 2 },
  directionTargetsCompleted: { label: '已完成方向目標', unit: '/ 7', digits: 0 },
  turnTargetsCompleted: { label: '已完成轉彎目標', unit: '/ 6', digits: 0 },
  turnChangeDegrees: { label: '朝本彎方向的航線轉角', unit: '°', digits: 1 },
  squareTargetsCompleted: { label: '已完成方形目標', unit: '/ 8', digits: 0 },
  squareLegsCompleted: { label: '已完成方形路段', unit: '/ 4', digits: 0 },
  eightTargetsCompleted: { label: '已完成八字目標', unit: '/ 9', digits: 0 },
  eightLoopsCompleted: { label: '已完成八字圈段', unit: '/ 2', digits: 0 },
  targetDistanceM: { label: '距目前目標', unit: 'm', digits: 2 },
  gatesPassed: { label: '已通過圓環', unit: '/ 3', digits: 0 },
  nextGateDistanceM: { label: '距下一個圓環', unit: 'm', digits: 2 },
  nextGateErrorM: { label: '對準圓環偏差', unit: 'm', digits: 2 },
  nextGateHorizontalErrorM: { label: '相對門中心左右偏差（右＋）', unit: 'm', digits: 2 },
  nextGateVerticalErrorM: { label: '相對門中心高度偏差（上＋）', unit: 'm', digits: 2 },
  touchdownDescentSpeedMps: { label: '接地下降速度', unit: 'm/s', digits: 2 },
  alongTrackM: { label: '前進距離', unit: 'm', digits: 2 },
  crossTrackErrorM: { label: '偏離直線', unit: 'm', digits: 2 },
  forwardSpeedMps: { label: '前進速度', unit: 'm/s', digits: 2 },
  peakForwardSpeedMps: { label: '最高前進速度', unit: 'm/s', digits: 2 },
  brakeEntrySpeedMps: { label: '進入減速區速度', unit: 'm/s', digits: 2 },
  stopErrorM: { label: '距離停點', unit: 'm', digits: 2 },
  targetAltitudeM: { label: '目標高度', unit: 'm', digits: 2 },
  altitudeErrorM: { label: '高度偏差', unit: 'm', digits: 2 },
  horizontalDriftM: { label: '偏離中心', unit: 'm', digits: 2 },
  horizontalSpeedMps: { label: '水平速度', unit: 'm/s', digits: 2 },
  verticalSpeedMps: { label: '垂直速度', unit: 'm/s', digits: 2 },
  maxTiltDegrees: { label: '機身傾角', unit: '°', digits: 1 },
  contiguousDwellSeconds: { label: '連續穩定', unit: 's', digits: 1 },
  stickSmoothness: { label: '操作平順度', unit: '/ 100', digits: 0 },
  entryErrorM: { label: '入口偏差', unit: 'm', digits: 2 },
  apexErrorM: { label: '轉彎頂點偏差', unit: 'm', digits: 2 },
  exitErrorM: { label: '出口偏差', unit: 'm', digits: 2 },
  headingChangeDegrees: { label: '航向變化', unit: '°', digits: 1 },
  routeCorridorErrorM: { label: '偏離航線', unit: 'm', digits: 2 },
  routeHeadingAlignment: { label: '航線對齊度', unit: '', digits: 2 },
  speedMps: { label: '飛行速度', unit: 'm/s', digits: 2 },
  entryAltitudeM: { label: '進入高度', unit: 'm', digits: 2 },
  invertedTiltDegrees: { label: '倒置傾角', unit: '°', digits: 1 },
  descentRateMps: { label: '下降速度', unit: 'm/s', digits: 2 },
  recoveryAltitudeErrorM: { label: '改出高度偏差', unit: 'm', digits: 2 },
  exercisesCompleted: { label: '已完成恢復練習', unit: '/ 3', digits: 0 },
  tiltDegrees: { label: '機身傾角', unit: '°', digits: 1 },
  bodyRateDegreesPerSecond: { label: '機身旋轉速度', unit: '°/s', digits: 1 },
  preparationDwellSeconds: { label: '準備確認時間', unit: `/ ${RECOVERY_PREP_SECONDS.toFixed(2)} s`, digits: 2 },
  recoveryDwellSeconds: { label: '恢復確認時間', unit: `/ ${RECOVERY_HOLD_SECONDS.toFixed(2)} s`, digits: 2 },
  rollProgressDegrees: { label: '本圈橫滾進度', unit: '/ 360°', digits: 1 },
  rollDirection: { label: '橫滾方向', unit: '', digits: 0 },
  flipProgressDegrees: { label: '本圈翻轉進度', unit: '/ 360°', digits: 1 },
  flipDirection: { label: '翻轉方向', unit: '', digits: 0 },
  splitRollProgressDegrees: { label: '本段橫滾轉角', unit: '/ 180°', digits: 1 },
  splitPitchProgressDegrees: { label: '倒置後俯仰轉角', unit: '/ 180°', digits: 1 },
  splitHeightLossM: { label: '本段下降高度', unit: 'm', digits: 2 },
  splitHeadingChangeDegrees: { label: '相對進場航向變化', unit: '°', digits: 1 },
  splitReverseTravelM: { label: '反向飛行行程', unit: 'm', digits: 2 },
  splitForwardSpeedMps: { label: '沿原進場方向速度', unit: 'm/s', digits: 2 },
  splitRecoveryDwellSeconds: { label: '正飛恢復確認', unit: 's', digits: 2 },
  loopForwardSpeedMps: { label: '迴圈進場方向速度', unit: 'm/s', digits: 2 },
  loopProgressDegrees: { label: '本圈俯仰轉角', unit: '/ 360°', digits: 1 },
  loopPathTurnDegrees: { label: '垂直航跡轉角', unit: '°', digits: 1 },
  loopHeightGainM: { label: '本圈拉升高度', unit: 'm', digits: 2 },
  loopForwardSpanM: { label: '本圈前後跨度', unit: 'm', digits: 2 },
  loopReverseTravelM: { label: '越頂後退行程', unit: 'm', digits: 2 },
  loopRecoveryDwellSeconds: { label: '正飛恢復確認', unit: 's', digits: 2 },
  interruptionFlipDirection: { label: '中斷時翻轉方向', unit: '', digits: 0 },
  interruptionFlipProgressDegrees: { label: '中斷時翻轉進度', unit: '°', digits: 1 },
  positionErrorM: { label: '位置偏差', unit: 'm', digits: 2 },
  radialErrorM: { label: '繞行半徑偏差', unit: 'm', digits: 2 },
  orbitRadiusM: { label: '繞行半徑', unit: 'm', digits: 2 },
  orbitProgressDegrees: { label: '累積盤旋角度', unit: '°', digits: 1 },
  orbitCompletedLaps: { label: '已完成盤旋圈數', unit: `/ ${ORBIT_REQUIRED_LAPS} 圈`, digits: 0 },
  orbitExitDistanceM: { label: '完成五圈後向外飛離', unit: 'm', digits: 2 },
  orbitHeadingErrorDegrees: { label: '機頭偏離目標', unit: '°', digits: 1 },
  orbitTangentialSpeedMps: { label: '繞塔側向速度', unit: 'm/s', digits: 2 },
  orbitRadialSpeedMps: { label: '往塔外速度（外＋）', unit: 'm/s', digits: 2 },
  orbitRecoveryDwellSeconds: { label: '恢復控制確認', unit: 's', digits: 2 },
  orbitSpeedMps: { label: '繞行速度', unit: 'm/s', digits: 2 },
  headingErrorDegrees: { label: '航向偏差', unit: '°', digits: 1 },
  cameraHeadingErrorDegrees: { label: '鏡頭方向偏差', unit: '°', digits: 1 },
  orbitProgress: {
    label: '繞行進度', unit: '%', digits: 0,
    transform: (value) => Math.max(0, Math.min(100, value / (2 * Math.PI) * 100)),
  },
  pathLengthM: { label: '飛行距離', unit: 'm', digits: 1 },
}

const LESSON_METRICS: Readonly<Record<string, readonly string[]>> = {
  takeoff: ['altitudeM', 'horizontalDriftM', 'contiguousDwellSeconds'],
  landing: ['landingHeightM', 'landingPositionErrorM', 'verticalSpeedMps'],
  'straight-line': ['alongTrackM', 'crossTrackErrorM', 'altitudeErrorM'],
  hover: ['altitudeErrorM', 'horizontalDriftM', 'contiguousDwellSeconds'],
  'coordinated-turn': ['routeCorridorErrorM', 'headingChangeDegrees', 'speedMps'],
  'split-s': ['entryAltitudeM', 'headingChangeDegrees', 'recoveryAltitudeErrorM'],
  orbit: ['orbitProgress', 'radialErrorM', 'altitudeErrorM'],
}

function metricPriorities(metrics: Readonly<Record<string, number>>, lessonId: string | null): readonly string[] {
  if (lessonId === 'orbit' && Number.isFinite(metrics.orbitPhase)) {
    if (metrics.orbitPhase <= 1) return ['altitudeM', 'groundTouching', 'orbitRadiusM']
    if (metrics.orbitCompleted > 0.5) return ['orbitCompletedLaps', 'orbitExitDistanceM', 'orbitRadialSpeedMps']
    return ['orbitCompletedLaps', 'orbitRadiusM', 'orbitHeadingErrorDegrees']
  }
  if (lessonId === 'split-s' && Number.isFinite(metrics.splitPhase)) {
    if (metrics.splitPhase <= 1 || metrics.groundTouching > 0.5) return ['altitudeM', 'groundTouching', 'splitForwardSpeedMps']
    if (metrics.insideSplitArea === 0) return ['launchDistanceM', 'altitudeM', 'splitPitchProgressDegrees']
    if (!(metrics.splitEpisodeValid > 0.5)) return ['altitudeM', 'splitForwardSpeedMps', 'tiltDegrees']
    if (metrics.splitPhase <= 3) return ['splitRollProgressDegrees', 'altitudeM', 'verticalSpeedMps']
    if (metrics.splitPhase <= 5) return ['splitPitchProgressDegrees', 'splitHeightLossM', 'splitReverseTravelM']
    return ['splitHeadingChangeDegrees', 'tiltDegrees', 'splitRecoveryDwellSeconds']
  }
  if (lessonId === 'power-loop') {
    if (metrics.loopPhase <= 1 || metrics.groundTouching > 0.5) return ['altitudeM', 'groundTouching', 'loopForwardSpeedMps']
    if (metrics.insideLoopArea === 0) return ['launchDistanceM', 'altitudeM', 'loopProgressDegrees']
    if (!(metrics.loopEpisodeValid > 0.5)) return ['altitudeM', 'loopForwardSpeedMps', 'tiltDegrees']
    if (metrics.loopPhase <= 3) return ['loopHeightGainM', 'loopForwardSpanM', 'verticalSpeedMps']
    if (metrics.loopPhase <= 5) return ['loopProgressDegrees', 'loopReverseTravelM', 'verticalSpeedMps']
    return ['loopProgressDegrees', 'tiltDegrees', 'loopRecoveryDwellSeconds']
  }
  if (lessonId === 'full-roll') {
    if (metrics.rollPhase <= 1 || metrics.groundTouching > 0.5) return ['altitudeM', 'groundTouching', 'rollProgressDegrees']
    if (metrics.insideRollArea === 0) return ['launchDistanceM', 'altitudeM', 'rollProgressDegrees']
    if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < ROLL_MIN_HEIGHT) return ['altitudeM', 'verticalSpeedMps', 'rollProgressDegrees']
    if (!(metrics.rollEpisodeValid > 0.5) && metrics.rollPhase < 6) {
      if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < ROLL_PREP_HEIGHT) return ['altitudeM', 'verticalSpeedMps', 'preparationDwellSeconds']
      if (metrics.tiltDegrees > ROLL_PREP_TILT) return ['tiltDegrees', 'bodyRateDegreesPerSecond', 'preparationDwellSeconds']
      if (metrics.bodyRateDegreesPerSecond > ROLL_MAX_RATE) return ['bodyRateDegreesPerSecond', 'tiltDegrees', 'preparationDwellSeconds']
      if (metrics.horizontalSpeedMps > ROLL_MAX_HORIZONTAL) return ['horizontalSpeedMps', 'altitudeM', 'preparationDwellSeconds']
      if (Math.abs(metrics.verticalSpeedMps) > ROLL_PREP_VERTICAL) return ['verticalSpeedMps', 'altitudeM', 'preparationDwellSeconds']
      return ['altitudeM', 'tiltDegrees', 'preparationDwellSeconds']
    }
    return metrics.rollCompleted > 0.5 || metrics.rollPhase >= 5
      ? ['rollProgressDegrees', 'tiltDegrees', 'recoveryDwellSeconds']
      : ['rollProgressDegrees', 'rollDirection', 'altitudeM']
  }
  if (isFullFlipLesson(lessonId)) {
    if (metrics.flipInterrupted > 0.5 && metrics.flipInterruptionReason === 8) return ['interruptionFlipDirection', 'interruptionFlipProgressDegrees', 'altitudeM']
    const required = fullFlipRequiredDirection(lessonId ?? '')
    if (required !== 0 && metrics.flipDirection !== 0 && Number.isFinite(metrics.flipDirection) && metrics.flipDirection !== required) return ['flipDirection', 'flipProgressDegrees', 'altitudeM']
    if (metrics.flipPhase <= 1 || metrics.groundTouching > 0.5) return ['altitudeM', 'groundTouching', 'flipProgressDegrees']
    if (metrics.insideFlipArea === 0) return ['launchDistanceM', 'altitudeM', 'flipProgressDegrees']
    if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < FLIP_MIN_HEIGHT) return ['altitudeM', 'verticalSpeedMps', 'flipProgressDegrees']
    if (!(metrics.flipEpisodeValid > 0.5) && metrics.flipPhase < 6) {
      if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < FLIP_PREP_HEIGHT) return ['altitudeM', 'verticalSpeedMps', 'preparationDwellSeconds']
      if (metrics.tiltDegrees > FLIP_PREP_TILT) return ['tiltDegrees', 'bodyRateDegreesPerSecond', 'preparationDwellSeconds']
      if (metrics.bodyRateDegreesPerSecond > FLIP_MAX_RATE) return ['bodyRateDegreesPerSecond', 'tiltDegrees', 'preparationDwellSeconds']
      if (metrics.horizontalSpeedMps > FLIP_MAX_HORIZONTAL) return ['horizontalSpeedMps', 'altitudeM', 'preparationDwellSeconds']
      if (Math.abs(metrics.verticalSpeedMps) > FLIP_PREP_VERTICAL) return ['verticalSpeedMps', 'altitudeM', 'preparationDwellSeconds']
      return ['altitudeM', 'tiltDegrees', 'preparationDwellSeconds']
    }
    return metrics.flipCompleted > 0.5 || metrics.flipPhase >= 5
      ? ['flipProgressDegrees', 'tiltDegrees', 'recoveryDwellSeconds']
      : ['flipProgressDegrees', 'flipDirection', 'altitudeM']
  }
  if (lessonId === 'basic-recovery') {
    if (metrics.recoveryPhase <= 1 || metrics.groundTouching > 0.5) return ['altitudeM', 'groundTouching', 'exercisesCompleted']
    if (metrics.recoveryPhase >= 8) return ['exercisesCompleted', 'altitudeM', 'horizontalSpeedMps']
    if (metrics.insideRecoveryArea === 0) return ['launchDistanceM', 'altitudeM', 'exercisesCompleted']
    if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < RECOVERY_MIN_HEIGHT) return ['altitudeM', 'verticalSpeedMps', 'exercisesCompleted']
    if (!(metrics.currentEpisodeValid > 0.5) && !(metrics.exerciseReady > 0.5)) {
      const limits = basicRecoveryPreparationLimits(metrics)
      if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < RECOVERY_PREP_HEIGHT) return ['altitudeM', 'verticalSpeedMps', 'preparationDwellSeconds']
      if (metrics.tiltDegrees > limits.tilt) return ['tiltDegrees', 'bodyRateDegreesPerSecond', 'preparationDwellSeconds']
      if (metrics.bodyRateDegreesPerSecond > RECOVERY_MAX_RATE) return ['bodyRateDegreesPerSecond', 'tiltDegrees', 'preparationDwellSeconds']
      if (limits.horizontal !== null && metrics.horizontalSpeedMps > limits.horizontal) return ['horizontalSpeedMps', 'tiltDegrees', 'preparationDwellSeconds']
      if (metrics.verticalSpeedMps < limits.minVertical || metrics.verticalSpeedMps > RECOVERY_PREP_VERTICAL) return ['verticalSpeedMps', 'altitudeM', 'preparationDwellSeconds']
      return ['altitudeM', 'tiltDegrees', 'preparationDwellSeconds']
    }
    if (metrics.recoveryPhase <= 3) return ['tiltDegrees', 'bodyRateDegreesPerSecond', 'recoveryDwellSeconds']
    if (metrics.recoveryPhase <= 5) return ['verticalSpeedMps', 'altitudeM', 'recoveryDwellSeconds']
    return ['horizontalSpeedMps', 'tiltDegrees', 'recoveryDwellSeconds']
  }
  if (lessonId === 'wide-gate') {
    if (metrics.gatePhase <= 1 || metrics.groundTouching > 0.5) return ['groundClearanceM', 'altitudeM', 'gatesPassed']
    const horizontal = metrics.nextGateHorizontalErrorM
    const vertical = metrics.nextGateVerticalErrorM
    const alignment = Number.isFinite(horizontal) && Math.abs(horizontal) > 2
      ? 'nextGateHorizontalErrorM' : Number.isFinite(vertical) && Math.abs(vertical) > 2
        ? 'nextGateVerticalErrorM' : 'targetDistanceM'
    return ['gatesPassed', 'nextGateDistanceM', alignment]
  }
  if (lessonId === 'figure-eight') {
    if (metrics.eightPhase <= 1) return ['groundClearanceM', 'altitudeM', 'eightTargetsCompleted']
    if (metrics.headingErrorDegrees > 70) return ['headingErrorDegrees', 'targetDistanceM', 'eightLoopsCompleted']
    return ['eightTargetsCompleted', 'eightLoopsCompleted', 'targetDistanceM']
  }
  if (lessonId === 'square-route') {
    if (metrics.squarePhase <= 1) return ['groundClearanceM', 'altitudeM', 'squareTargetsCompleted']
    if (metrics.headingErrorDegrees > 70) return ['headingErrorDegrees', 'targetDistanceM', 'squareLegsCompleted']
    return ['squareTargetsCompleted', 'squareLegsCompleted', 'targetDistanceM']
  }
  if (lessonId === 'coordinated-turn' && Number.isFinite(metrics.turnPhase)) {
    if (metrics.turnPhase <= 1) return ['groundClearanceM', 'altitudeM', 'turnTargetsCompleted']
    if (metrics.turnTargetIndex === 2 || metrics.turnTargetIndex === 5) return ['turnChangeDegrees', 'targetDistanceM', 'turnTargetsCompleted']
    return ['turnTargetsCompleted', 'targetDistanceM', 'headingErrorDegrees']
  }
  if (lessonId === 'direction-control') {
    if (metrics.directionPhase <= 1) return ['groundClearanceM', 'altitudeM', 'directionTargetsCompleted']
    if (metrics.directionPhase === 6) return ['headingChangeDegrees', 'headingErrorDegrees', 'targetDistanceM']
    return ['directionTargetsCompleted', 'targetDistanceM', 'headingErrorDegrees']
  }
  if (lessonId === 'landing') {
    return metrics.landingPhase <= 1
      ? ['landingHeightM', 'launchDistanceM', 'groundTouching']
      : ['landingPositionErrorM', 'landingHeightM', 'groundTouching']
  }
  if (lessonId === 'straight-line') {
    if (metrics.routePhase === 0) return ['launchHeightM', 'altitudeM', 'gatesPassed']
    if (metrics.routePhase >= 4) return ['gatesPassed', 'altitudeM', 'forwardSpeedMps']
    return ['gatesPassed', 'nextGateDistanceM', 'nextGateErrorM']
  }
  return lessonId ? LESSON_METRICS[lessonId] ?? [] : []
}

/** Show observations with units; internal accumulator keys are not teaching copy. */
export function formatTrainingMetrics(
  metrics: Readonly<Record<string, number>> | undefined,
  lessonId: string | null = null,
  limit = 3,
): readonly TrainingMetricDisplay[] {
  if (!metrics) return []
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(3, Math.floor(limit))) : 3
  const priorities = metricPriorities(metrics, lessonId)
  const keys = [...new Set([...priorities, ...Object.keys(metrics)])]
  return keys.flatMap((key): TrainingMetricDisplay[] => {
    const definition = METRICS[key]
    const value = metrics[key]
    if (!definition || !Number.isFinite(value)) return []
    const displayed = definition.transform?.(value) ?? value
    return [{
      key,
      label: (lessonId === 'basic-recovery' || lessonId === 'full-roll' || lessonId === 'power-loop' || lessonId === 'split-s' || lessonId === 'orbit' || isFullFlipLesson(lessonId)) && key === 'verticalSpeedMps' ? '升降速度（上＋／下−）'
        : (lessonId === 'basic-recovery' || lessonId === 'full-roll' || lessonId === 'power-loop' || lessonId === 'split-s' || lessonId === 'orbit' || isFullFlipLesson(lessonId)) && key === 'altitudeM' ? '離地高度'
        : isFullFlipLesson(lessonId) && key === 'preparationDwellSeconds' ? '翻轉準備確認'
        : isFullFlipLesson(lessonId) && key === 'recoveryDwellSeconds' ? '正飛恢復確認'
        : lessonId === 'full-roll' && key === 'preparationDwellSeconds' ? '橫滾準備確認'
        : (lessonId === 'full-roll' || lessonId === 'power-loop') && key === 'recoveryDwellSeconds' ? '正飛恢復確認'
        : lessonId === 'wide-gate' && key === 'gatesPassed' ? '已通過寬門'
        : lessonId === 'wide-gate' && key === 'nextGateDistanceM' ? '距目前門平面（前＋／後−）' : definition.label,
      value: key === 'groundTouching' ? value > 0.5 ? '已接地' : '尚未接地'
        : isFullFlipLesson(lessonId) && (key === 'flipDirection' || key === 'interruptionFlipDirection') ? value === 1 ? '前翻' : value === -1 ? '後翻' : flipCourseDirection(lessonId) ? `尚未開始${flipCourseDirection(lessonId)}` : '尚未選定'
        : isFullFlipLesson(lessonId) && key === 'preparationDwellSeconds' ? `${displayed.toFixed(2)} / ${FLIP_PREP_SECONDS.toFixed(2)} s`
        : isFullFlipLesson(lessonId) && key === 'recoveryDwellSeconds' ? `${displayed.toFixed(2)} / ${FLIP_HOLD_SECONDS.toFixed(2)} s`
        : lessonId === 'full-roll' && key === 'rollDirection' ? value === 1 ? '向右' : value === -1 ? '向左' : '尚未選定'
        : lessonId === 'full-roll' && key === 'preparationDwellSeconds' ? `${displayed.toFixed(2)} / ${ROLL_PREP_SECONDS.toFixed(2)} s`
        : lessonId === 'full-roll' && key === 'recoveryDwellSeconds' ? `${displayed.toFixed(2)} / ${ROLL_HOLD_SECONDS.toFixed(2)} s`
        : lessonId === 'power-loop' && key === 'loopRecoveryDwellSeconds' ? `${displayed.toFixed(2)} / ${LOOP_HOLD.toFixed(2)} s`
        : `${displayed.toFixed(definition.digits)}${definition.unit ? ` ${definition.unit}` : ''}`,
    }]
  }).slice(0, maximum)
}

const HINT_TRANSLATIONS: Readonly<Record<string, string>> = {
  'Retry to apply the lesson setup while disarmed, then arm explicitly after the countdown.': '先按重試重設場景；倒數結束後，再明確解鎖開始。',
  'Re-arm explicitly, then retry the lesson from its reset setup.': '先重試並完成場景重設，倒數結束後再明確解鎖。',
  'Arm only after the countdown and keep the runtime focused.': '倒數結束後再解鎖，練習時保持網頁在前景。',
  'Reset the training field and retry.': '重設練習場景後，再試一次。',
  'Enter the target gently, then keep drift and altitude corrections small.': '輕柔進入目標區，再用小量操作修正漂移與高度。',
  'Retry and reduce horizontal drift before correcting altitude.': '重試時先減少水平漂移，再小量修正高度。',
  'Hold the zone and let velocity settle before making the next correction.': '先留在目標區，等移動速度降低後再做下一次小量修正。',
  'Climb into the green hover target above the takeoff pad.': '緩慢增加油門，飛入起飛區上方的綠色目標區。',
  'Keep fixed-step telemetry connected and fly the gates in order.': '保持網頁在前景，依序通過入口、轉彎點與出口；飛行資料中斷後請重試。',
  'Enter the first gate, look through the apex, and let the heading change come from the flight path.': '先通過入口，再看向轉彎點，讓飛行路線逐步轉向。',
  'Use a smoother coordinated line and keep altitude near the gate references.': '用小量操作保持順暢轉彎，讓高度接近標示目標。',
  'Carry the line through the apex; the heading change must come from position and velocity, not stick timing.': '沿航線通過轉彎點，確認飛行路線也跟著改變方向。',
  'Reach the turn-entry gate with the nose and velocity pointed into the route.': '先接近入口，讓機頭與移動方向都朝向航線。',
  'Keep the fixed-step path continuous through the inversion and recovery.': '保持網頁在前景；倒置到改出之間資料中斷時，請重新開始。',
  'Start high, complete the inverted descending half-loop, then recover level.': '從足夠高度開始，完成倒置下降半圈後再恢復水平。',
  'Enter with more altitude and delay the recovery until the heading has reversed.': '重試時保留更多高度，完成航向反轉後再改出。',
  'Use the available altitude to manage energy through the half-loop.': '保留足夠高度，控制下降速度完成半圈。',
  'Reverse the heading through the descent, then recover upright with energy remaining.': '讓航向隨下降半圈反轉，保留高度與速度再恢復正向。',
  'Keep descending through the inverted half-loop before asking for the heading reversal.': '先持續完成倒置下降半圈，再接續航向反轉。',
  'Roll fully inverted before descending; an upright U-turn does not count as a Split-S.': '先完整橫滾至倒置，再進入下降；保持正向的迴轉不算 Split-S。',
  'Build enough altitude and speed for the entry before beginning the half-loop.': '開始半圈前，先取得足夠的進入高度與速度。',
  'Choose one direction around the tower and keep the tangent line smooth.': '選定同一繞行方向，沿塔周圍保持順暢路線。',
  'Keep fixed-step samples continuous and fly the radius instead of jumping between points.': '保持連續飛行與網頁焦點，沿繞行半徑飛行；位置跳變後請重試。',
  'Translate around the tower with real lateral speed before turning the camera.': '先真正移動到塔的周圍，再配合轉動鏡頭；原地轉頭不算繞行。',
  'Use a steady radius, altitude, speed, and camera heading around the POI.': '繞行時保持半徑、高度、速度與鏡頭方向穩定。',
  'Keep the point of interest in a steady camera reference while preserving speed.': '保持移動速度，讓目標在畫面中維持穩定位置。',
  'Enter the orbit with real lateral motion; yawing in place does not establish a lap direction.': '先沿塔周圍移動，建立繞行方向；原地偏航不算一圈。',
  'Hold the valid envelope for one more stable sample to finish the orbit exit.': '維持目前穩定的繞行狀態，完成最後一段退出。',
  'Keep one direction, approximately ten metres of radius, and the POI in the camera heading.': '維持同一方向、約十公尺半徑與目標的鏡頭位置。',
}

const LESSON_HINTS: Readonly<Record<string, string>> = {
  takeoff: '緩推油門，留在起飛區上方；接近目標高度時減少升降與漂移，以小量修正連續定點懸停 1.5 秒。',
  landing: `先從地面起飛，再前往正前方 ${LANDING_ZONE_DISTANCE_M} m 的藍色降落區；在區內接地且沒有墜毀即可完成。`,
  'straight-line': '先自行起飛，再依序穿過藍色、金色與綠色三個圓環；穿過綠色終點環即可完成。',
  'direction-control': '從地面自行起飛，依亮起目標練左右、前後移動，再向右偏航換向；方向提示以目前機頭為準。',
  hover: '先減少水平移動，再用小量油門修正高度，避免連續大幅補桿。',
  'coordinated-turn': '從地面自行起飛，依序飛過右轉與左轉的入口、轉彎點和出口；小量傾斜並配合轉頭，讓實際航線一起轉彎。',
  'square-route': '從地面自行起飛，依序沿四段直線與右轉角飛行，再回到起點上方；漏點可補飛，不需精準速度、停留或降落。',
  'figure-eight': '從地面自行起飛，進中央入口後先飛左圈，經中央換向點接右圈，再回到中央空中終點；依目前亮起的目標前進，漏點可補飛。',
  'wide-gate': '從地面自行起飛，依序向前穿過三道寬門的門洞；對準約 3 m 高的中心並留出槳葉空間，碰到實體門框會墜毀。',
  'basic-recovery': `從地面自行起飛到約 ${RECOVERY_TARGET_HEIGHT} m，按提示製造小幅傾斜、下沉與漂移，再親手修正；先偵測到實際偏差，才開始判定恢復。`,
  'full-roll': `從地面自行起飛到約 ${ROLL_TARGET_HEIGHT} m，短暫準備後向左或右完成一圈橫滾，再停止旋轉並恢復正飛與控制。`,
  'full-flip': `從地面自行起飛到約 ${FLIP_TARGET_HEIGHT} m，短暫準備後選擇前翻或後翻，沿俯仰軸完成一圈，再停止旋轉並恢復正飛與控制。`,
  'front-flip': `本課練前翻。從地面自行起飛到約 ${FLIP_TARGET_HEIGHT} m，短暫準備後向前翻一圈，再恢復正飛與控制；後翻不計入本課。`,
  'back-flip': `本課練後翻。從地面自行起飛到約 ${FLIP_TARGET_HEIGHT} m，短暫準備後向後翻一圈，再恢復正飛與控制；前翻不計入本課。`,
  'power-loop': `地面自行起飛至約 ${LOOP_TARGET_HEIGHT} m，建立前速後拉升、越頂、下降再拉平；需真正飛出空間迴圈，原地後翻不能代替。`,
  'split-s': '先確認進入高度，再依序完成倒置、下降半圈與恢復正向。',
  orbit: '沿目標周圍保持同一繞行方向，先穩住半徑與高度。',
}

export interface TrainingObjective {
  readonly title: string
  readonly detail: string
}

function fact(metrics: Readonly<Record<string, number>>, key: string, unit: string, digits = 1): string | null {
  const value = metrics[key]
  return Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : null
}

const DIRECTION_TARGET_LABELS = ['向右側移', '向左側移', '向前移動', '向後移動', '向右偏航換向', '換向後向前移動', '換向後向右側移'] as const
const TURN_TARGET_LABELS = ['右轉入口', '右轉轉彎點', '右轉出口', '左轉入口', '左轉轉彎點', '左轉出口'] as const
const EIGHT_TARGET_LABELS = ['中央入口', '左圈前段', '左圈外側', '左圈回程', '中央換向點', '右圈前段', '右圈外側', '右圈回程', '中央終點'] as const
const SQUARE_TARGET_LABELS = ['第 1 段直線', '第 1 個右轉角', '第 2 段直線', '第 2 個右轉角', '第 3 段直線', '第 3 個右轉角', '第 4 段直線', '返回起點上方'] as const

/** Shared teaching names; the evaluator remains authoritative about progress. */
export function directionControlTargetLabel(index: number): string {
  return Number.isInteger(index) && index >= 0 && index < DIRECTION_TARGET_LABELS.length
    ? DIRECTION_TARGET_LABELS[index] : '目前方向目標'
}

export function coordinatedTurnTargetLabel(index: number): string {
  return Number.isInteger(index) && index >= 0 && index < TURN_TARGET_LABELS.length
    ? TURN_TARGET_LABELS[index] : '目前轉彎目標'
}

export function squareRouteTargetLabel(index: number): string {
  return Number.isInteger(index) && index >= 0 && index < SQUARE_TARGET_LABELS.length
    ? SQUARE_TARGET_LABELS[index] : '目前方形航線目標'
}

export function figureEightTargetLabel(index: number): string {
  return Number.isInteger(index) && index >= 0 && index < EIGHT_TARGET_LABELS.length
    ? EIGHT_TARGET_LABELS[index] : '目前八字航線目標'
}

/** Only a reported physics contact identifies a particular gate and frame part. */
export function wideGateCollisionCause(message: string): string | null {
  const reported = /\bObstacle collision:\s*([^;\s]+)\s*(?:;|$)/iu.exec(message)?.[1]
  const collider = reported ? /^wide-gate-([123])-(left-post|right-post|top-bar|bottom-bar)$/u.exec(reported) : null
  if (!collider) return null
  const parts: Readonly<Record<string, string>> = {
    'left-post': '左柱', 'right-post': '右柱', 'top-bar': '上橫樑', 'bottom-bar': '下橫樑',
  }
  return `碰到第 ${collider[1]} 道門的${parts[collider[2]]}`
}

const BASIC_RECOVERY_STAGE_LABELS = ['起飛區地面準備', '自行起飛至練習高度', '製造小幅傾斜', '主動修回水平', '製造小幅下沉', '止住下沉', '建立水平漂移', '減速並修回水平'] as const

export function basicRecoveryStageLabel(phase: number): string {
  return Number.isInteger(phase) && phase >= 0 && phase < BASIC_RECOVERY_STAGE_LABELS.length
    ? BASIC_RECOVERY_STAGE_LABELS[phase] : '目前恢復練習'
}

const FULL_ROLL_STAGE_LABELS = ['起飛區地面準備', '自行起飛至練習高度', '橫滾前短暫準備', '通過倒置姿態', '完成一圈橫滾', '恢復正飛與控制'] as const

export function fullRollStageLabel(phase: number): string {
  return Number.isInteger(phase) && phase >= 0 && phase < FULL_ROLL_STAGE_LABELS.length
    ? FULL_ROLL_STAGE_LABELS[phase] : '目前橫滾練習'
}

/** Captured interruption facts survive returning to height/area until a new episode is ready. */
export function fullRollInterruptionReason(metrics: Readonly<Record<string, number>>): string | null {
  if (!(metrics.rollInterrupted > 0.5)) return null
  const height = Number.isFinite(metrics.interruptionAltitudeM) ? `${metrics.interruptionAltitudeM.toFixed(1)} m` : null
  const distance = Number.isFinite(metrics.interruptionLaunchDistanceM) ? `${metrics.interruptionLaunchDistanceM.toFixed(1)} m` : null
  switch (metrics.rollInterruptionReason) {
    case 1: return '這一圈曾接地；地面停住不能代替空中恢復。'
    case 2: return `中斷時${height ? `離地 ${height}` : '高度不足'}，低於恢復需要的 ${ROLL_MIN_HEIGHT} m。`
    case 3: return `中斷時${distance ? `距起飛點 ${distance}` : '已離開練習區'}，超出半徑 ${ROLL_AREA_RADIUS} m。`
    case 4: return `這一圈的俯仰／偏航旋轉累積${Number.isFinite(metrics.interruptionOffAxisDegrees) ? `約 ${metrics.interruptionOffAxisDegrees.toFixed(1)}°` : '過多'}，已偏離橫滾軸；下次主要使用 Roll，減少 Pitch／Yaw。`
    case 5: return '這一圈持續過轉，已超出可接受的完整橫滾範圍；下次接近正飛時提早回中減緩旋轉。'
    case 6: return '這一圈反向轉過了起始姿態；下次選左或右後，沿同一方向完成一整圈。'
    case 7: return `準備後尚未開始橫滾便降到${height ? `離地 ${height}` : '準備高度以下'}；先升回至少 ${ROLL_PREP_HEIGHT} m，再重新準備。`
    default: return null
  }
}

function fullRollPreparation(metrics: Readonly<Record<string, number>>): string {
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < ROLL_PREP_HEIGHT) return `目前離地 ${metrics.altitudeM.toFixed(1)} m；先升回至少 ${ROLL_PREP_HEIGHT} m，建議約 ${ROLL_TARGET_HEIGHT} m，再開始完整橫滾。`
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > ROLL_PREP_TILT) return `目前傾角 ${metrics.tiltDegrees.toFixed(1)}°；先主動帶回 ${ROLL_PREP_TILT}° 內，再開始橫滾。`
  if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > ROLL_MAX_RATE) return `目前機身旋轉速度 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s；先回中並小量修正，減緩到 ${ROLL_MAX_RATE}°/s 內再準備。`
  if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > ROLL_MAX_HORIZONTAL) return `目前水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s；先朝移動反方向適度傾斜減速至 ${ROLL_MAX_HORIZONTAL} m/s 內，再主動回平。`
  if (Number.isFinite(metrics.verticalSpeedMps) && Math.abs(metrics.verticalSpeedMps) > ROLL_PREP_VERTICAL) return `目前升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−）；先調整油門到 ±${ROLL_PREP_VERTICAL} m/s 內，取得高度餘裕再準備。`
  const dwell = Number.isFinite(metrics.preparationDwellSeconds)
    ? `準備確認 ${Math.max(0, Math.min(ROLL_PREP_SECONDS, metrics.preparationDwellSeconds)).toFixed(2)}／${ROLL_PREP_SECONDS.toFixed(2)} s。`
    : `連續準備 ${ROLL_PREP_SECONDS.toFixed(2)} s。`
  return `${dwell}保持離地至少 ${ROLL_PREP_HEIGHT} m、傾角 ${ROLL_PREP_TILT}° 內，稍微降低升降與漂移；準備完成後再選左或右橫滾，不要求固定位置懸停。`
}

function fullRollObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.rollPhase) && metrics.rollPhase >= 0 && metrics.rollPhase <= 6 ? metrics.rollPhase : 0
  if (phase === 6) return {
    title: '6／6 完整橫滾與正飛恢復完成',
    detail: '已觀察到同一圈的實際倒置、完整橫滾與空中恢復控制；可以 Disarm，不需要降落或回到原位置。',
  }
  const title = `${phase + 1}／6 ${fullRollStageLabel(phase)}`
  if (phase === 0) return { title, detail: '先在起飛區實際接地並保持低油門，再明確 Arm；本課由地面自行起飛。' }
  if (phase === 1) return {
    title,
    detail: `自行起飛至至少 ${ROLL_PREP_HEIGHT} m，建議約 ${ROLL_TARGET_HEIGHT} m；完整橫滾會經過倒置，需要留出下降與恢復高度。接近高度時提早減少上升速度。`,
  }
  const interrupted = metrics.rollInterrupted > 0.5
  const reprepare = `先前步驟保留，但本圈需要重新準備並完成一整圈，舊的倒置或回正標記不代替本圈證據。`
  if (metrics.groundTouching > 0.5) return {
    title,
    detail: `目前已接地；地面停住不能完成空中恢復。先自行起飛到至少 ${ROLL_PREP_HEIGHT} m，再重新準備。${reprepare}`,
  }
  if (metrics.insideRollArea === 0) return {
    title,
    detail: `目前超出起飛點半徑 ${ROLL_AREA_RADIUS} m 的練習區${Number.isFinite(metrics.launchDistanceM) ? `，距起飛點 ${metrics.launchDistanceM.toFixed(1)} m` : ''}；先回到區內。${reprepare}`,
  }
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < ROLL_MIN_HEIGHT) return {
    title,
    detail: `目前離地 ${metrics.altitudeM.toFixed(1)} m，低於空中恢復需要的 ${ROLL_MIN_HEIGHT} m；先止住下降、取得高度再練。${reprepare}`,
  }
  if (!(metrics.rollEpisodeValid > 0.5)) return {
    title,
    detail: `${interrupted ? `本圈橫滾已中斷。${fullRollInterruptionReason(metrics) ?? ''}${reprepare}` : ''}${fullRollPreparation(metrics)}`,
  }
  const progress = Number.isFinite(metrics.rollProgressDegrees)
    ? `本圈已觀察到約 ${Math.max(0, Math.min(360, metrics.rollProgressDegrees)).toFixed(1)}°。` : ''
  const direction = metrics.rollDirection === 1 ? '向右' : metrics.rollDirection === -1 ? '向左' : null
  if (!(metrics.rollCompleted > 0.5)) {
    if (!(metrics.rollInverted > 0.5)) return {
      title,
      detail: `${interrupted ? '本圈重新開始。' : ''}${progress}${direction ? `繼續${direction}橫滾，保持本圈同一方向，觀察機身轉過側立並通過倒置。` : '準備完成；選擇向左或向右 Roll，讓機身沿機頭到機尾的軸連續翻轉。'}配合油門保留高度，倒置時適度收油；只推搖桿或原地轉機頭不會計入完整橫滾。`,
    }
    return {
      title,
      detail: `${progress}已觀察到本圈倒置；${direction ? `繼續${direction}` : '保持本圈原來方向'}完成剩下的橫滾，接近正飛時提早回中減緩旋轉。倒置後反向翻回原姿態尚未完成一圈；以實際姿態與旋轉路徑判定。`,
    }
  }
  const blockers: string[] = []
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > ROLL_RECOVERY_TILT) blockers.push(`目前傾角 ${metrics.tiltDegrees.toFixed(1)}°，先主動修回 ${ROLL_RECOVERY_TILT}° 內`)
  if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > ROLL_MAX_RATE) blockers.push(`仍以 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s 旋轉，減緩至 ${ROLL_MAX_RATE}°/s 內`)
  if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > ROLL_MAX_HORIZONTAL) blockers.push(`水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s，需降低到 ${ROLL_MAX_HORIZONTAL} m/s 內`)
  if (Number.isFinite(metrics.verticalSpeedMps) && (metrics.verticalSpeedMps < -ROLL_RECOVERY_DESCENT || metrics.verticalSpeedMps > ROLL_RECOVERY_CLIMB)) blockers.push(`升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−），調整到 −${ROLL_RECOVERY_DESCENT}～+${ROLL_RECOVERY_CLIMB} m/s`)
  const dwell = Number.isFinite(metrics.recoveryDwellSeconds)
    ? `恢復確認 ${Math.max(0, Math.min(ROLL_HOLD_SECONDS, metrics.recoveryDwellSeconds)).toFixed(2)}／${ROLL_HOLD_SECONDS.toFixed(2)} s。` : ''
  return {
    title,
    detail: `${progress}已完成本圈橫滾，現在停止旋轉並恢復正飛。${blockers.length ? `${blockers.slice(0, 2).join('；')}。` : `將機身主動帶回 ${ROLL_RECOVERY_TILT}° 內，以小量油門止住過快升降。`}${dwell}保持空中、至少 ${ROLL_MIN_HEIGHT} m 高度，連續確認 ${ROLL_HOLD_SECONDS} 秒即可；不要求回原位置或降落。Acro 回中只停止旋轉，回平與減速仍需自行修正。`,
  }
}

const SPLIT_S_STAGE_LABELS = ['起飛區地面準備', '自行起飛至進場高度', '建立前進速度', '橫滾至倒置', '沿下降半迴圈下拉', '反轉實際飛行方向', '拉平反向改出', '恢復正飛與控制'] as const

export function splitSStageLabel(phase: number): string {
  return Number.isInteger(phase) && phase >= 0 && phase < SPLIT_S_STAGE_LABELS.length
    ? SPLIT_S_STAGE_LABELS[phase] : '目前破S練習'
}

/** Interruption snapshots describe the stopped maneuver, not the later recovered position. */
export function splitSInterruptionReason(metrics: Readonly<Record<string, number>>): string | null {
  if (!(metrics.splitInterrupted > 0.5)) return null
  const height = fact(metrics, 'interruptionAltitudeM', 'm')
  const distance = fact(metrics, 'interruptionLaunchDistanceM', 'm')
  switch (metrics.splitInterruptionReason) {
    case 1: return '這段破S曾接地，地面停住不能代替空中改出。'
    case 2: return `中斷時${height ? `離地 ${height}` : '高度不足'}，低於空中改出需要的 ${SPLIT_MIN_HEIGHT} m；下次先保留高度，提早拉平止降。`
    case 3: return `中斷時${distance ? `距起飛點 ${distance}` : '已離開練習區'}，超出半徑 ${SPLIT_AREA_RADIUS} m。`
    case 4: return '破S混入過多其他軸旋轉；先以橫滾翻至倒置，再以後拉俯仰走出下降半迴圈，不以偏航轉頭代替。'
    case 5: return '本段旋轉過量，已超出半橫滾與下降半迴圈範圍；接近倒置及正飛時提早回中減緩旋轉。'
    case 6: return '本段反向翻回或折返，連續動作已中斷；先重新準備，再橫滾至倒置，沿同一後拉方向下降並改出。'
    case 7: return `尚未開始翻轉便失去進場高度${height ? `，中斷時離地 ${height}` : ''}；先升回至少 ${SPLIT_ENTRY_HEIGHT} m，再建立前速。`
    case 8: return '倒置後的實際下降或反向飛行證據中斷；原地翻轉、只轉機頭或分段拼湊不能代替下降半迴圈。'
    default: return null
  }
}

function splitSEntry(metrics: Readonly<Record<string, number>>): string {
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < SPLIT_ENTRY_HEIGHT) return `目前離地 ${metrics.altitudeM.toFixed(1)} m；先升至至少 ${SPLIT_ENTRY_HEIGHT} m，建議約 ${SPLIT_TARGET_HEIGHT} m，再建立前進速度。下降半迴圈需要足夠下方空間。`
  if (Number.isFinite(metrics.splitForwardSpeedMps) && metrics.splitForwardSpeedMps < SPLIT_ENTRY_SPEED) return `目前前進速度 ${metrics.splitForwardSpeedMps.toFixed(1)} m/s；稍微前傾配合油門，建立至少 ${SPLIT_ENTRY_SPEED} m/s 前速，再翻成倒置。`
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > SPLIT_RECOVERY_TILT) return `目前傾角 ${metrics.tiltDegrees.toFixed(1)}°；先主動帶回 ${SPLIT_RECOVERY_TILT}° 內，再重新準備進場。`
  return `在至少 ${SPLIT_ENTRY_HEIGHT} m 高度、接近水平，建立至少 ${SPLIT_ENTRY_SPEED} m/s 前速後短暫準備；接著選左或右橫滾至倒置。`
}

function splitSObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  let phase = Number.isInteger(metrics.splitPhase) && metrics.splitPhase >= 0 && metrics.splitPhase <= 8 ? metrics.splitPhase : 0
  const valid = metrics.splitEpisodeValid > 0.5 && !(metrics.splitInterrupted > 0.5)
  if (valid && phase >= 3 && phase < 8) phase = !(metrics.splitInverted > 0.5) ? 3
    : !(metrics.splitDescended > 0.5) ? 4 : !(metrics.splitReversed > 0.5) ? 5 : !(metrics.splitCompleted > 0.5) ? 6 : 7
  if (phase === 8 && valid && metrics.splitCompleted > 0.5 && metrics.splitInverted > 0.5 && metrics.splitDescended > 0.5 && metrics.splitReversed > 0.5) return {
    title: '8／8 破S與反向改出完成',
    detail: '已觀察到同一段橫滾倒置、下降半迴圈、反轉實際飛行方向及正飛改出，並恢復空中控制；可解除解鎖，不需回原點或降落。',
  }
  const title = `${Math.min(8, phase + 1)}／8 ${splitSStageLabel(Math.min(7, phase))}`
  if (phase === 0) return { title, detail: '先在起飛區實際接地，保持低油門，再明確解鎖；本課由地面自行起飛，不會從空中自動開始。' }
  if (phase === 1) return { title, detail: `自行起飛至至少 ${SPLIT_ENTRY_HEIGHT} m，建議約 ${SPLIT_TARGET_HEIGHT} m；下降半迴圈會明顯掉高，先取得足夠下方空間。` }
  const reprepare = '先前步驟保留，但需重新進場完成新的一整段；舊倒置、下降或回正標記不代替本段證據。'
  if (!valid) return { title, detail: `${metrics.splitInterrupted > 0.5 ? `本段已中斷。${splitSInterruptionReason(metrics) ?? ''}${reprepare}` : ''}${splitSEntry(metrics)}` }
  if (phase === 2) return { title, detail: splitSEntry(metrics) }
  const roll = fact(metrics, 'splitRollProgressDegrees', '°')
  const pitch = fact(metrics, 'splitPitchProgressDegrees', '°')
  const descent = fact(metrics, 'splitHeightLossM', 'm')
  const heading = fact(metrics, 'splitHeadingChangeDegrees', '°')
  const rearward = fact(metrics, 'splitReverseTravelM', 'm')
  if (phase === 3) return { title, detail: `${roll ? `本段橫滾 ${roll}。` : ''}選左或右橫滾約半圈至機腹朝天，接近倒置時回中減緩橫滾；先完成實際橫滾倒置，再向後拉俯仰。只做前翻或後翻不代替本段順序。` }
  if (phase === 4) return { title, detail: `${pitch ? `倒置後俯仰 ${pitch}。` : ''}${descent ? `本段已下降 ${descent}。` : ''}已橫滾倒置；適度收油並持續向後拉俯仰，讓實際航跡往下繞出半迴圈，需下降至少 ${SPLIT_HEIGHT_LOSS} m。保留下方空間，不要只用偏航轉頭。` }
  if (phase === 5) return { title, detail: `${heading ? `相對進場航向變化 ${heading}。` : ''}${rearward ? `反向行程 ${rearward}。` : ''}繼續沿下降半迴圈後拉，讓飛行方向轉向來路，並實際往回移動至少 ${SPLIT_REVERSE} m。轉機頭但仍朝原方向滑行不算反向改出。` }
  if (phase === 6) return { title, detail: `${pitch ? `倒置後俯仰 ${pitch}。` : ''}已觀察到往來路方向飛行；繼續後拉至正飛，接近水平時提早回中減緩旋轉，補油止住過快下降。不要再加半圈翻成倒置。` }
  if (phase === 8) return { title, detail: `缺少同一段的實際橫滾倒置、下降與反向改出證據，不能只由完成標記判定通過。${reprepare}${splitSEntry(metrics)}` }
  const blockers: string[] = []
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < SPLIT_MIN_HEIGHT) blockers.push(`離地 ${metrics.altitudeM.toFixed(1)} m，先止降保留至少 ${SPLIT_MIN_HEIGHT} m`)
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > SPLIT_RECOVERY_TILT) blockers.push(`傾角 ${metrics.tiltDegrees.toFixed(1)}°，先主動修回 ${SPLIT_RECOVERY_TILT}° 內`)
  if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > 140) blockers.push(`機身仍以 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s 旋轉，先減緩至 140°/s 內`)
  if (Number.isFinite(metrics.verticalSpeedMps) && (metrics.verticalSpeedMps < -4 || metrics.verticalSpeedMps > 5)) blockers.push(`升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s，調整油門回到 −4～+5 m/s`)
  if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > 15) blockers.push(`水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s，先降低至 15 m/s 內`)
  const dwell = fact(metrics, 'splitRecoveryDwellSeconds', 's', 2)
  return { title, detail: `已反向正飛改出，現在恢復控制。${blockers.length ? `${blockers.slice(0, 2).join('；')}。` : '保持接近水平，減緩旋轉與過快升降。'}${dwell ? `恢復確認 ${dwell}／${SPLIT_HOLD.toFixed(2)} s。` : ''}保持離地至少 ${SPLIT_MIN_HEIGHT} m，連續確認 ${SPLIT_HOLD} 秒；不要求精準懸停、回原點或降落。回中不會自動回平。` }
}

const POWER_LOOP_STAGE_LABELS = ['起飛區地面準備', '自行起飛至練習高度', '建立前進速度', '拉升並展開迴圈', '越頂通過倒置', '沿迴圈下降', '拉平向前改出', '恢復正飛與控制'] as const

export function powerLoopStageLabel(phase: number): string {
  return Number.isInteger(phase) && phase >= 0 && phase < POWER_LOOP_STAGE_LABELS.length
    ? POWER_LOOP_STAGE_LABELS[phase] : '目前大迴旋練習'
}

/** Report the event that invalidated this episode, even after the learner regains altitude. */
export function powerLoopInterruptionReason(metrics: Readonly<Record<string, number>>): string | null {
  if (!(metrics.loopInterrupted > 0.5)) return null
  const height = fact(metrics, 'interruptionAltitudeM', 'm')
  const distance = fact(metrics, 'interruptionLaunchDistanceM', 'm')
  switch (metrics.loopInterruptionReason) {
    case 1: return '這一圈曾接地，地面停住不能代替空中改出。'
    case 2: return `中斷時${height ? `離地 ${height}` : '高度不足'}，低於空中改出需要的 ${LOOP_MIN_HEIGHT} m。`
    case 3: return `中斷時${distance ? `距起飛點 ${distance}` : '已離開練習區'}，超出半徑 ${LOOP_AREA_RADIUS} m。`
    case 4: return '這一圈累積過多橫滾或偏航，已偏離垂直迴圈；下次主要用俯仰拉升與改出，減少左右翻轉及轉頭。'
    case 5: return '這一圈持續過轉；接近正飛時提早回中減緩旋轉，並沿出口向前飛。'
    case 6: return '這一圈向前翻或反向折返過多；下次帶前速拉機頭向上，保持同一後拉方向經過頂點再改出。'
    case 7: return `尚未展開拉升便失去進場高度${height ? `，中斷時離地 ${height}` : ''}；先升回至少 ${LOOP_ENTRY_HEIGHT} m，再建立前速。`
    case 8: return '這一圈的實際航跡停住或反向折返，空間迴圈證據已中斷；先重新建立前速，再連續拉升、越頂與下降，原地翻轉不能代替。'
    case 9: return `這一圈實際前後跨度${Number.isFinite(metrics.interruptionForwardSpanM) ? `只有 ${metrics.interruptionForwardSpanM.toFixed(1)} m` : '不足'}，尚未達到 ${LOOP_SPAN} m；進場直線與回正後直飛不計入迴圈大小。下次先帶前速，再放慢後拉，讓拉升、越頂與下降真正展開，重新完成一整圈。`
    default: return null
  }
}

function powerLoopEntry(metrics: Readonly<Record<string, number>>): string {
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < LOOP_ENTRY_HEIGHT) return `目前離地 ${metrics.altitudeM.toFixed(1)} m；先取得至少 ${LOOP_ENTRY_HEIGHT} m、建議約 ${LOOP_TARGET_HEIGHT} m 高度，再建立前速。`
  if (Number.isFinite(metrics.loopForwardSpeedMps) && metrics.loopForwardSpeedMps < LOOP_ENTRY_SPEED) return `目前前進速度 ${metrics.loopForwardSpeedMps.toFixed(1)} m/s；稍微前傾配合油門，建立至少 ${LOOP_ENTRY_SPEED} m/s 前速，再拉機頭向上。原地後翻不算大迴旋。`
  return `在至少 ${LOOP_ENTRY_HEIGHT} m 高度建立 ${LOOP_ENTRY_SPEED} m/s 以上的前進速度，再配合油門拉機頭向上，讓實際航線開始向上彎。`
}

function powerLoopObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.loopPhase) && metrics.loopPhase >= 0 && metrics.loopPhase <= 8 ? metrics.loopPhase : 0
  if (phase === 8 && metrics.loopEpisodeValid > 0.5 && !(metrics.loopInterrupted > 0.5)
    && metrics.loopCompleted > 0.5 && metrics.loopInverted > 0.5 && metrics.loopDescended > 0.5) return {
    title: '8／8 大迴旋與空中改出完成',
    detail: '已觀察到同一圈的前進、拉升、越頂倒置、下降及向前改出，並恢復空中控制；可解除解鎖，不需回原點或降落。',
  }
  const title = `${Math.min(8, phase + 1)}／8 ${powerLoopStageLabel(Math.min(7, phase))}`
  if (phase === 0) return { title, detail: '先在起飛區實際接地，保持低油門，再明確解鎖；本課由地面自行起飛。' }
  if (phase === 1) return { title, detail: `自行起飛至至少 ${LOOP_ENTRY_HEIGHT} m，建議約 ${LOOP_TARGET_HEIGHT} m；先保留上升、下降與改出的高度餘裕。` }
  const reprepare = '先前步驟保留，但需重新建立進場並完成新的一整圈；舊倒置、下降或回正標記不代替本圈證據。'
  if (!(metrics.loopEpisodeValid > 0.5) || metrics.loopInterrupted > 0.5) return {
    title,
    detail: `${metrics.loopInterrupted > 0.5 ? `本圈已中斷。${powerLoopInterruptionReason(metrics) ?? ''}${reprepare}` : ''}${powerLoopEntry(metrics)}`,
  }
  const rise = fact(metrics, 'loopHeightGainM', 'm')
  const span = fact(metrics, 'loopForwardSpanM', 'm')
  const turn = fact(metrics, 'loopProgressDegrees', '°')
  const observed = `${rise ? `本圈拉升 ${rise}。` : ''}${span ? `前後跨度 ${span}。` : ''}`
  if (phase === 2) return { title, detail: powerLoopEntry(metrics) }
  if (phase === 3) return { title, detail: `${observed}帶前速後拉機頭並配合油門，把飛行路線帶向上；本圈至少需拉升 ${LOOP_HEIGHT_GAIN} m、前後跨度 ${LOOP_SPAN} m。只在原地翻一圈不會完成空間迴圈。` }
  if (phase === 4) return { title, detail: `${observed}繼續同方向後拉通過頂點及實際倒置，適度收油，讓航線越頂往來路方向移動；需有至少 ${LOOP_REVERSE} m 的越頂後退行程。` }
  if (phase === 5) return { title, detail: `${turn ? `本圈俯仰轉角 ${turn}。` : ''}已越頂；沿同一迴圈進入下降，保留下方空間，距最高點實際下降至少 2 m 後再拉平。避免在頂點反向翻回。` }
  if (phase === 6) return { title, detail: `${turn ? `本圈俯仰轉角 ${turn}。` : ''}繼續完成迴圈，接近正飛時提早回中減緩旋轉並補油，讓飛機沿原進場方向向前改出；只轉回水平但沒有前進出口，仍未完成。` }
  const blockers: string[] = []
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > LOOP_RECOVERY_TILT) blockers.push(`傾角 ${metrics.tiltDegrees.toFixed(1)}°，先主動修回 ${LOOP_RECOVERY_TILT}° 內`)
  if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > 140) blockers.push(`機身仍以 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s 旋轉，先減緩至 140°/s 內`)
  if (Number.isFinite(metrics.verticalSpeedMps) && (metrics.verticalSpeedMps < -4 || metrics.verticalSpeedMps > 5)) blockers.push(`升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s，調整油門回到 −4～+5 m/s`)
  if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > 15) blockers.push(`水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s，先降低至 15 m/s 內`)
  const dwell = fact(metrics, 'loopRecoveryDwellSeconds', 's', 2)
  return { title, detail: `已走出本圈出口，現在恢復正飛與控制。${blockers.length ? `${blockers.slice(0, 2).join('；')}。` : `保持接近水平，止住過快升降並減緩旋轉。`}${dwell ? `恢復確認 ${dwell}／${LOOP_HOLD.toFixed(2)} s。` : ''}保持離地至少 ${LOOP_MIN_HEIGHT} m，連續確認 ${LOOP_HOLD} 秒；不用精準懸停、回原點或降落。回中不會自動回平。` }
}

const FULL_FLIP_STAGE_LABELS = ['起飛區地面準備', '自行起飛至練習高度', '翻轉前短暫準備', '通過倒置姿態', '完成一圈翻轉', '恢復正飛與控制'] as const

export function fullFlipStageLabel(phase: number): string {
  return Number.isInteger(phase) && phase >= 0 && phase < FULL_FLIP_STAGE_LABELS.length
    ? FULL_FLIP_STAGE_LABELS[phase] : '目前翻轉練習'
}

/** Captured interruption facts survive returning to height/area until a new episode is ready. */
export function fullFlipInterruptionReason(metrics: Readonly<Record<string, number>>, lessonId: string | null = null): string | null {
  if (!(metrics.flipInterrupted > 0.5)) return null
  const height = Number.isFinite(metrics.interruptionAltitudeM) ? `${metrics.interruptionAltitudeM.toFixed(1)} m` : null
  const distance = Number.isFinite(metrics.interruptionLaunchDistanceM) ? `${metrics.interruptionLaunchDistanceM.toFixed(1)} m` : null
  switch (metrics.flipInterruptionReason) {
    case 1: return '這一圈曾接地；地面停住不能代替空中恢復。'
    case 2: return `中斷時${height ? `離地 ${height}` : '高度不足'}，低於恢復需要的 ${FLIP_MIN_HEIGHT} m。`
    case 3: return `中斷時${distance ? `距起飛點 ${distance}` : '已離開練習區'}，超出半徑 ${FLIP_AREA_RADIUS} m。`
    case 4: return `這一圈的橫滾／偏航旋轉累積${Number.isFinite(metrics.interruptionOffAxisDegrees) ? `約 ${metrics.interruptionOffAxisDegrees.toFixed(1)}°` : '過多'}，已偏離翻轉軸；下次主要使用俯仰，減少橫滾與偏航。`
    case 5: return '這一圈持續過轉，已超出可接受的完整翻轉範圍；下次接近正飛時提早回中減緩旋轉。'
    case 6: return `這一圈反向轉過了起始姿態；下次${flipCourseDirection(lessonId) ? `依本課要求${flipCourseDirection(lessonId)}` : '選定前翻或後翻後'}，沿同一方向完成一整圈。`
    case 7: return `準備後尚未開始翻轉便降到${height ? `離地 ${height}` : '準備高度以下'}；先升回至少 ${FLIP_PREP_HEIGHT} m，再重新準備。`
    case 8: {
      const required = lessonId === null ? metrics.flipRequiredDirection : fullFlipRequiredDirection(lessonId)
      const expected = required === 1 ? '前翻' : required === -1 ? '後翻' : null
      const observed = metrics.interruptionFlipDirection === 1 ? '前翻' : metrics.interruptionFlipDirection === -1 ? '後翻' : null
      const progress = Number.isFinite(metrics.interruptionFlipProgressDegrees) ? `約 ${Math.max(0, metrics.interruptionFlipProgressDegrees).toFixed(1)}°` : ''
      return `${expected ? `本課練${expected}` : '本次翻轉方向不符合課程要求'}；${observed ? `中斷時往${observed}${progress}` : '尚未取得指定方向的有效證據'}，這一圈不計入本課。先回正重新準備，再${expected ? `以${expected}` : '依本課指定方向'}完整翻一圈。`
    }
    default: return null
  }
}

function fullFlipPreparation(metrics: Readonly<Record<string, number>>, lessonId: string | null): string {
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < FLIP_PREP_HEIGHT) return `目前離地 ${metrics.altitudeM.toFixed(1)} m；先升回至少 ${FLIP_PREP_HEIGHT} m，建議約 ${FLIP_TARGET_HEIGHT} m，再開始完整翻轉。`
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > FLIP_PREP_TILT) return `目前傾角 ${metrics.tiltDegrees.toFixed(1)}°；先主動帶回 ${FLIP_PREP_TILT}° 內，再開始翻轉。`
  if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > FLIP_MAX_RATE) return `目前機身旋轉速度 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s；先回中並小量修正，減緩到 ${FLIP_MAX_RATE}°/s 內再準備。`
  if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > FLIP_MAX_HORIZONTAL) return `目前水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s；先朝移動反方向適度傾斜減速至 ${FLIP_MAX_HORIZONTAL} m/s 內，再主動回平。`
  if (Number.isFinite(metrics.verticalSpeedMps) && Math.abs(metrics.verticalSpeedMps) > FLIP_PREP_VERTICAL) return `目前升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−）；先調整油門到 ±${FLIP_PREP_VERTICAL} m/s 內，取得高度餘裕再準備。`
  const dwell = Number.isFinite(metrics.preparationDwellSeconds)
    ? `準備確認 ${Math.max(0, Math.min(FLIP_PREP_SECONDS, metrics.preparationDwellSeconds)).toFixed(2)}／${FLIP_PREP_SECONDS.toFixed(2)} s。`
    : `連續準備 ${FLIP_PREP_SECONDS.toFixed(2)} s。`
  return `${dwell}保持離地至少 ${FLIP_PREP_HEIGHT} m、傾角 ${FLIP_PREP_TILT}° 內，稍微降低升降與漂移；準備完成後${flipCourseDirection(lessonId) ? `再開始${flipCourseDirection(lessonId)}` : '再選前翻或後翻'}，不要求固定位置懸停。`
}

function fullFlipObjectiveBase(metrics: Readonly<Record<string, number>>, lessonId: string | null): TrainingObjective {
  const phase = Number.isInteger(metrics.flipPhase) && metrics.flipPhase >= 0 && metrics.flipPhase <= 6 ? metrics.flipPhase : 0
  if (phase === 6) return {
    title: '6／6 完整翻轉與正飛恢復完成',
    detail: '已觀察到同一圈的實際倒置、完整翻轉與空中恢復控制；可以解除解鎖，不需要降落或回到原位置。',
  }
  const title = `${phase + 1}／6 ${fullFlipStageLabel(phase)}`
  if (phase === 0) return { title, detail: '先在起飛區實際接地並保持低油門，再明確解鎖；本課由地面自行起飛。' }
  if (phase === 1) return {
    title,
    detail: `自行起飛至至少 ${FLIP_PREP_HEIGHT} m，建議約 ${FLIP_TARGET_HEIGHT} m；完整翻轉會經過倒置，需要留出下降與恢復高度。接近高度時提早減少上升速度。`,
  }
  const interrupted = metrics.flipInterrupted > 0.5
  const reprepare = `先前步驟保留，但本圈需要重新準備並完成一整圈，舊的倒置或回正標記不代替本圈證據。`
  if (!(metrics.flipEpisodeValid > 0.5) && interrupted) return {
    title,
    detail: `本圈翻轉已中斷。${fullFlipInterruptionReason(metrics, lessonId) ?? ''}${reprepare}${fullFlipPreparation(metrics, lessonId)}`,
  }
  if (metrics.groundTouching > 0.5) return {
    title,
    detail: `目前已接地；地面停住不能完成空中恢復。先自行起飛到至少 ${FLIP_PREP_HEIGHT} m，再重新準備。${reprepare}`,
  }
  if (metrics.insideFlipArea === 0) return {
    title,
    detail: `目前超出起飛點半徑 ${FLIP_AREA_RADIUS} m 的練習區${Number.isFinite(metrics.launchDistanceM) ? `，距起飛點 ${metrics.launchDistanceM.toFixed(1)} m` : ''}；先回到區內。${reprepare}`,
  }
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < FLIP_MIN_HEIGHT) return {
    title,
    detail: `目前離地 ${metrics.altitudeM.toFixed(1)} m，低於空中恢復需要的 ${FLIP_MIN_HEIGHT} m；先止住下降、取得高度再練。${reprepare}`,
  }
  if (!(metrics.flipEpisodeValid > 0.5)) return {
    title,
    detail: fullFlipPreparation(metrics, lessonId),
  }
  const progress = Number.isFinite(metrics.flipProgressDegrees)
    ? `本圈已觀察到約 ${Math.max(0, Math.min(360, metrics.flipProgressDegrees)).toFixed(1)}°。` : ''
  const direction = metrics.flipDirection === 1 ? '前翻' : metrics.flipDirection === -1 ? '後翻' : flipCourseDirection(lessonId)
  if (!(metrics.flipCompleted > 0.5)) {
    if (!(metrics.flipInverted > 0.5)) return {
      title,
      detail: `${interrupted ? '本圈重新開始。' : ''}${progress}${direction ? `繼續${direction}，保持本圈同一方向，觀察機頭逐漸朝下或朝上，並通過倒置。` : '準備完成；選擇前翻或後翻，讓機身沿左右兩側的俯仰軸連續翻轉。'}配合油門保留高度，倒置時適度收油；只推搖桿或原地轉機頭不會計入完整翻轉。`,
    }
    return {
      title,
      detail: `${progress}已觀察到本圈倒置；${direction ? `繼續${direction}` : '保持本圈原來方向'}完成剩下的翻轉，接近正飛時提早回中減緩旋轉。倒置後反向翻回原姿態尚未完成一圈；以實際姿態與旋轉路徑判定。`,
    }
  }
  const blockers: string[] = []
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > FLIP_RECOVERY_TILT) blockers.push(`目前傾角 ${metrics.tiltDegrees.toFixed(1)}°，先主動修回 ${FLIP_RECOVERY_TILT}° 內`)
  if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > FLIP_MAX_RATE) blockers.push(`仍以 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s 旋轉，減緩至 ${FLIP_MAX_RATE}°/s 內`)
  if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > FLIP_MAX_HORIZONTAL) blockers.push(`水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s，需降低到 ${FLIP_MAX_HORIZONTAL} m/s 內`)
  if (Number.isFinite(metrics.verticalSpeedMps) && (metrics.verticalSpeedMps < -FLIP_RECOVERY_DESCENT || metrics.verticalSpeedMps > FLIP_RECOVERY_CLIMB)) blockers.push(`升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−），調整到 −${FLIP_RECOVERY_DESCENT}～+${FLIP_RECOVERY_CLIMB} m/s`)
  const dwell = Number.isFinite(metrics.recoveryDwellSeconds)
    ? `恢復確認 ${Math.max(0, Math.min(FLIP_HOLD_SECONDS, metrics.recoveryDwellSeconds)).toFixed(2)}／${FLIP_HOLD_SECONDS.toFixed(2)} s。` : ''
  return {
    title,
    detail: `${progress}已完成本圈翻轉，現在停止旋轉並恢復正飛。${blockers.length ? `${blockers.slice(0, 2).join('；')}。` : `將機身主動帶回 ${FLIP_RECOVERY_TILT}° 內，以小量油門止住過快升降。`}${dwell}保持空中、至少 ${FLIP_MIN_HEIGHT} m 高度，連續確認 ${FLIP_HOLD_SECONDS} 秒即可；不要求回原位置或降落。手動角速度模式下回中只停止旋轉，回平與減速仍需自行修正。`,
  }
}

function fullFlipObjective(metrics: Readonly<Record<string, number>>, lessonId: string | null): TrainingObjective {
  const required = fullFlipRequiredDirection(lessonId ?? '')
  const expected = flipCourseDirection(lessonId)
  const observed = metrics.flipDirection === 1 ? '前翻' : metrics.flipDirection === -1 ? '後翻' : null
  if (required !== 0 && observed !== null && metrics.flipDirection !== required) return {
    title: '翻轉方向不符本課要求',
    detail: `本課練${expected}；剛才往${observed}${Number.isFinite(metrics.flipProgressDegrees) ? `約 ${Math.max(0, metrics.flipProgressDegrees).toFixed(1)}°` : ''}，不能計入本課。先回正重新準備，再以${expected}完整翻一圈；舊的倒置或回正標記不能代替指定方向。`,
  }
  if (required !== 0 && metrics.flipPhase === 6 && metrics.flipDirection !== required) return {
    title: '尚未確認本課方向',
    detail: `本課練${expected}；目前缺少指定方向的實際旋轉證據，不能只憑完成標記判定通過。先回正重新準備，再以${expected}完成新的一圈。`,
  }
  const objective = fullFlipObjectiveBase(metrics, lessonId)
  return expected ? { ...objective, detail: `本課練${expected}。${objective.detail}` } : objective
}

function basicRecoveryPreparationLimits(metrics: Readonly<Record<string, number>>) {
  const phase = Number.isFinite(metrics.recoveryPhase) ? metrics.recoveryPhase : 2
  return {
    tilt: phase <= 3 ? RECOVERY_TILT_LEVEL : phase <= 5 ? RECOVERY_SINK_LEVEL : RECOVERY_DRIFT_LEVEL,
    horizontal: phase <= 3 ? null : phase <= 5 ? RECOVERY_PREP_HORIZONTAL : RECOVERY_DRIFT_PREP,
    minVertical: phase >= 4 && phase <= 5 ? -RECOVERY_SINK_STOP : -RECOVERY_PREP_VERTICAL,
  }
}

function basicRecoveryPreparation(metrics: Readonly<Record<string, number>>): string {
  const limits = basicRecoveryPreparationLimits(metrics)
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < RECOVERY_PREP_HEIGHT) return `目前離地 ${metrics.altitudeM.toFixed(1)} m；先自行升到 ${RECOVERY_PREP_HEIGHT} m 以上，建議約 ${RECOVERY_TARGET_HEIGHT} m，再準備製造小偏差。`
  if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > limits.tilt) return `目前傾角 ${metrics.tiltDegrees.toFixed(1)}°；先主動修回 ${limits.tilt}° 內，準備下一次小偏差。`
  if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > RECOVERY_MAX_RATE) return `目前旋轉速度 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s；先小量修正並回中，讓旋轉減緩到 ${RECOVERY_MAX_RATE}°/s 內。`
  if (limits.horizontal !== null && Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > limits.horizontal) return `目前水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s；先朝移動反方向適度傾斜減速至 ${limits.horizontal.toFixed(1)} m/s 內，再主動帶回接近水平。`
  if (Number.isFinite(metrics.verticalSpeedMps) && (metrics.verticalSpeedMps < limits.minVertical || metrics.verticalSpeedMps > RECOVERY_PREP_VERTICAL)) return `目前升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−）；用小量油門調整到 ${limits.minVertical}～+${RECOVERY_PREP_VERTICAL} m/s，保留高度再準備。`
  const dwell = Number.isFinite(metrics.preparationDwellSeconds) ? Math.max(0, Math.min(RECOVERY_PREP_SECONDS, metrics.preparationDwellSeconds)).toFixed(2) : '0.00'
  const preparation = metrics.recoveryPhase <= 3 ? '先把機身稍微帶回平順，容許持續水平移動'
    : metrics.recoveryPhase <= 5 ? '容許些微傾斜與側移，先止住既有下沉' : '先降低水平速度，容許些微傾斜與升降'
  return `準備確認 ${dwell}／${RECOVERY_PREP_SECONDS.toFixed(2)} s：保持離地 ${RECOVERY_PREP_HEIGHT} m 以上，${preparation}；確認後才依提示製造偏差。不要求固定位置或精準懸停。`
}

function basicRecoveryObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.recoveryPhase) && metrics.recoveryPhase >= 0 && metrics.recoveryPhase <= 8 ? metrics.recoveryPhase : 0
  if (phase === 8) return {
    title: '8／8 三項基礎失誤恢復已完成',
    detail: '已實際製造並修正傾斜、下沉與漂移；現在可以 Disarm，不要求回到原位置或降落。',
  }
  const title = `${phase + 1}／8 ${basicRecoveryStageLabel(phase)}`
  if (phase === 0) return { title, detail: '先在起飛區實際地面開始；倒數後保持低油門，明確 Arm，再自行加油門起飛。' }
  if (phase === 1) return { title, detail: `從地面自行起飛到離地 ${RECOVERY_PREP_HEIGHT} m 以上，建議約 ${RECOVERY_TARGET_HEIGHT} m，取得修正餘裕；接著依提示製造小偏差，再親手恢復。` }
  const retained = '先前已完成的整項練習會保留；本項需重新製造偏差，再修正。'
  if (metrics.groundTouching > 0.5) return {
    title,
    detail: `目前已接地，碰地停住不算空中恢復；未墜毀時可就地自行起飛，回到 ${RECOVERY_PREP_HEIGHT} m 以上完成準備。${retained}`,
  }
  if (metrics.insideRecoveryArea === 0) return {
    title,
    detail: `目前超出起飛點半徑 ${RECOVERY_AREA_RADIUS} m 的練習區，先回到區內；不必回到原起飛點。${metrics.currentEpisodeValid > 0.5 ? '本項已偵測到的偏差會保留，回到區內可繼續恢復確認；出區期間不累積確認時間。' : '回到區內後重新準備，再依提示製造小偏差。'}先前已完成的整項練習會保留。`,
  }
  if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < RECOVERY_MIN_HEIGHT) return {
    title,
    detail: `目前離地 ${metrics.altitudeM.toFixed(1)} m，低於本項恢復需要的 ${RECOVERY_MIN_HEIGHT} m 餘裕；先止住下沉並升回 ${RECOVERY_PREP_HEIGHT} m 以上，再重新準備。${retained}`,
  }
  const interrupted = metrics.episodeInterrupted > 0.5
  const observed = metrics.currentEpisodeValid > 0.5
  const ready = metrics.exerciseReady > 0.5
  if (!observed && !ready) return {
    title,
    detail: `${interrupted ? `本項恢復已中斷。${retained}` : ''}${basicRecoveryPreparation(metrics)}`,
  }
  const exercise = phase <= 3 ? 'tilt' : phase <= 5 ? 'sink' : 'drift'
  if (!observed) {
    const again = interrupted ? '請重新製造本項偏差；先前的偏差不會沿用。' : '準備完成，現在由你製造小幅偏差。'
    if (exercise === 'tilt') return {
      title,
      detail: `${again}小量推動 Roll 或 Pitch，讓實際傾角達到 ${RECOVERY_TILT_ONSET}°；偵測到後立刻反向小量修正，主動帶回水平。Acro 回中會停止旋轉，回到水平需要主動修正。`,
    }
    if (exercise === 'sink') return {
      title,
      detail: Number.isFinite(metrics.altitudeM) && metrics.altitudeM < RECOVERY_SINK_HEIGHT
        ? `${again}目前離地 ${metrics.altitudeM.toFixed(1)} m；下沉練習要先回到至少 ${RECOVERY_SINK_HEIGHT} m，再稍收油門。`
        : `${again}先稍收油門，看升降速度變成負值；下降速度達到 ${RECOVERY_SINK_ONSET} m/s（升降速度 −${RECOVERY_SINK_ONSET} m/s）後，就補油止降。`,
    }
    return {
      title,
      detail: `${again}小量前傾或側傾，讓實際水平速度達到 ${RECOVERY_DRIFT_ONSET} m/s；偵測到後朝移動反方向適度傾斜減速，再主動把機身帶回接近水平。`,
    }
  }
  const dwell = Number.isFinite(metrics.recoveryDwellSeconds) ? Math.max(0, Math.min(RECOVERY_HOLD_SECONDS, metrics.recoveryDwellSeconds)).toFixed(2) : '0.00'
  const confirmation = `恢復確認 ${dwell}／${RECOVERY_HOLD_SECONDS.toFixed(2)} s；持續在空中並保留至少 ${RECOVERY_MIN_HEIGHT} m 高度，不要求回到原位置。`
  if (exercise === 'tilt') return {
    title,
    detail: `已偵測到實際傾斜；朝傾斜的反方向小量修正，主動修回 ${RECOVERY_TILT_LEVEL}° 內，再回中讓旋轉減緩到 ${RECOVERY_MAX_RATE}°/s 內。${confirmation}`,
  }
  if (exercise === 'sink') return {
    title,
    detail: `已偵測到實際下沉；現在補油止降，升降速度回到 −${RECOVERY_SINK_STOP}～+${RECOVERY_SINK_CLIMB} m/s 即可，容許適度爬升。機身在 ${RECOVERY_SINK_LEVEL}° 內、旋轉速度在 ${RECOVERY_MAX_RATE}°/s 內便能確認。${confirmation}`,
  }
  return {
    title,
    detail: `已偵測到實際水平漂移；朝移動反方向適度傾斜減速，再主動修回 ${RECOVERY_DRIFT_LEVEL}° 內。水平速度降至 ${RECOVERY_DRIFT_STOP.toFixed(1)} m/s 內、升降速度在 ±${RECOVERY_DRIFT_VERTICAL} m/s 內、旋轉速度在 ${RECOVERY_MAX_RATE}°/s 內即可確認恢復；回中不會自動煞停。${confirmation}`,
  }
}

/** Signed opening coordinates describe an observed offset, never an inferred hit. */
function wideGateAlignment(metrics: Readonly<Record<string, number>>): string {
  const horizontal = metrics.nextGateHorizontalErrorM
  const vertical = metrics.nextGateVerticalErrorM
  const outside = [
    Number.isFinite(horizontal) && Math.abs(horizontal) > 2
      ? `目前在門洞${horizontal > 0 ? '右' : '左'}側外，偏離中心 ${Math.abs(horizontal).toFixed(1)} m` : null,
    Number.isFinite(vertical) && Math.abs(vertical) > 2
      ? `目前在門洞${vertical > 0 ? '上' : '下'}方外，偏離中心 ${Math.abs(vertical).toFixed(1)} m` : null,
  ].filter((value): value is string => value !== null)
  return outside.length ? `${outside.join('；')}。` : ''
}

function wideGateObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.gatePhase) ? metrics.gatePhase : 0
  if (phase <= 1) return {
    title: phase === 0 ? '1／5 起飛區地面準備' : '2／5 自行起飛',
    detail: '從地面自行加油門離地，再向前方第一道門前進；門洞中心約高 3 m，不需要先懸停。',
  }
  if (phase >= 5) return {
    title: '5／5 三道寬門已完成',
    detail: '已依序向前穿過三道門洞，完成寬門穿越；不必降落或停留，現在可以 Disarm。',
  }
  const index = Number.isInteger(metrics.gateTargetIndex) && metrics.gateTargetIndex >= 0 && metrics.gateTargetIndex < 3
    ? metrics.gateTargetIndex : phase - 2
  const title = `${index + 3}／5 穿過第 ${index + 1} 道寬門`
  if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) return {
    title,
    detail: '目前尚未在空中；未墜毀接地可在目前位置再次自行起飛，再對準目前這道門。已通過的門會保留，不需要回原起飛點。',
  }
  const distance = metrics.nextGateDistanceM
  const side = Number.isFinite(distance) && distance < 0
    ? `目前已在這道門後方 ${Math.abs(distance).toFixed(1)} m，但尚未有效通過；先回到這道門前，再從門洞向前穿過，反向穿越不算。`
    : Number.isFinite(distance) ? `目前仍在門前 ${distance.toFixed(1)} m；先對準門洞，再向前穿過門平面。`
      : '先在門前對準門洞，再向前穿過門平面。'
  return {
    title,
    detail: `${side}${wideGateAlignment(metrics)}${directionTargetLocation(metrics)}門洞寬、高各 4 m；以中心附近為目標，為整架飛機與槳葉留出門框間距。依序穿過即可，不要求精準速度、朝向、停留或降落；已通過的門會保留。`,
  }
}

/** At most two useful body-relative directions, never inferred from fixed XYZ. */
function directionTargetLocation(metrics: Readonly<Record<string, number>>): string {
  const offsets = [
    { key: 'targetRightM', positive: '右方', negative: '左方' },
    { key: 'targetForwardM', positive: '前方', negative: '後方' },
    { key: 'targetUpM', positive: '上方', negative: '下方' },
  ].flatMap(({ key, positive, negative }) => {
    const value = metrics[key]
    return Number.isFinite(value) && Math.abs(value) >= 0.2
      ? [{ distance: Math.abs(value), text: `${value > 0 ? positive : negative} ${Math.abs(value).toFixed(1)} m` }] : []
  }).sort((left, right) => right.distance - left.distance).slice(0, 2)
  if (offsets.length) return `以目前機頭為準：目標在${offsets.map(({ text }) => text).join('、')}。`
  const distance = fact(metrics, 'targetDistanceM', 'm')
  return distance ? `距目前亮起的目標 ${distance}。` : '留意目前亮起的目標；方向以目前機頭為準。'
}

function directionObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.directionPhase) ? metrics.directionPhase : 0
  if (phase <= 1) return {
    title: phase === 0 ? '1／9 起飛區地面準備' : '2／9 自行起飛',
    detail: '從起飛區自行加油門離地，再飛往亮起的目標區；建議高度約 3 m，不需要先懸停。',
  }
  if (phase >= 9) return {
    title: '9／9 側移與方向感目標已完成',
    detail: '已完成左右、前後移動、偏航換向與新朝向下的移動；現在可以 Disarm。',
  }
  const index = Number.isInteger(metrics.directionTargetIndex) && metrics.directionTargetIndex >= 0 && metrics.directionTargetIndex < 7
    ? metrics.directionTargetIndex : phase - 2
  const location = directionTargetLocation(metrics)
  if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) return {
    title: `${phase + 1}／9 ${directionControlTargetLabel(index)}`,
    detail: '目前尚未在空中；先在目前位置自行加油門起飛，再前往目標。已完成的目標會保留，不需要回原起飛點。',
  }
  if (phase === 6) {
    const change = fact(metrics, 'headingChangeDegrees', '°', 0)
    const error = fact(metrics, 'headingErrorDegrees', '°', 0)
    const action = metrics.yawEntryRecorded === 0
      ? '尚缺換向前的朝向紀錄；請重設課程，依序完成前後移動後再換向。'
      : Number.isFinite(metrics.targetDistanceM) && metrics.targetDistanceM > 1.6
      ? `先回到換向目標區附近。${location}`
      : '在換向區附近用 Yaw 向右轉頭約 90°；Yaw 改變朝向，Roll 才是側移。'
    return {
      title: '7／9 向右偏航換向',
      detail: `${action}${change ? `目前已轉 ${change}，本步需實際轉向至少 45°；` : ''}${error ? `距新朝向還差約 ${error}，需在 45° 內。` : ''}看到下一個目標亮起後，再按新機頭方向移動。`,
    }
  }
  const heading = metrics.headingErrorDegrees
  const orientation = phase >= 7 ? '換向後的新前方' : '起飛時的前方'
  const action = Number.isFinite(heading) && heading > 60
    ? `機頭偏離本步方向 ${heading.toFixed(0)}°；先轉回大致朝向${orientation}，再靠近目標。`
    : phase === 2 || phase === 3 ? '機頭大致保持原朝向，用小量 Roll 側移。'
      : phase === 4 || phase === 5 ? '機頭大致保持原朝向，用小量 Pitch 前後移動。'
        : '以換向後的新機頭方向移動；固定場地的 XYZ 不會跟著機頭旋轉。'
  return {
    title: `${phase + 1}／9 ${directionControlTargetLabel(index)}`,
    detail: `${location}${action}飛入目標區即可，不要求停穩；已完成的目標會保留。`,
  }
}

function squareRouteObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.squarePhase) ? metrics.squarePhase : 0
  if (phase <= 1) return {
    title: phase === 0 ? '1／10 起飛區地面準備' : '2／10 自行起飛',
    detail: '從地面自行加油門離地，飛向第一段亮起的直線目標；建議高度約 3 m，不需要先懸停。',
  }
  if (phase >= 10) return {
    title: '10／10 方形航線已完成',
    detail: '已依序完成四段方形航線並回到起點上方；不必降落或停留，現在可以 Disarm。',
  }
  const index = Number.isInteger(metrics.squareTargetIndex) && metrics.squareTargetIndex >= 0 && metrics.squareTargetIndex < 8
    ? metrics.squareTargetIndex : phase - 2
  const title = `${index + 3}／10 ${squareRouteTargetLabel(index)}`
  if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) return {
    title,
    detail: '目前尚未在空中；在目前位置再次自行起飛，再前往亮起的目標。已完成的步驟會保留，不需要回原起飛點。',
  }
  const location = directionTargetLocation(metrics)
  const leg = Math.min(4, Math.floor(index / 2) + 1)
  const heading = metrics.headingErrorDegrees
  const action = Number.isFinite(heading) && heading > 70
    ? `機頭偏離本步箭頭方向 ${heading.toFixed(0)}°，需在 70° 內；先小量偏航讓機頭跟隨航線，再接近目前目標。`
    : index === 7
      ? '沿第 4 段飛入起點上方的綠色終點；仍需在空中，不必降落或停穩。'
      : index % 2 === 1
        ? '邊靠近轉角邊小量 Roll 右傾，配合 Yaw 與 Pitch 帶入下一段，並以油門維持高度。'
        : `沿第 ${leg} 段保持大致朝向箭頭，小量 Pitch 前進，油門修正高度；固定 XYZ 不會跟著機頭轉向。`
  return {
    title,
    detail: `${location}${action}依序飛入目前目標即可，不要求精準速度或停留；漏點可補飛，已完成的步驟會保留。`,
  }
}

function figureEightObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.eightPhase) ? metrics.eightPhase : 0
  if (phase <= 1) return {
    title: phase === 0 ? '1／11 起飛區地面準備' : '2／11 自行起飛',
    detail: '從地面自行加油門離地，先飛向前方中央入口；建議高度約 3 m，不需要先懸停。',
  }
  if (phase >= 11) return {
    title: '11／11 八字航線已完成',
    detail: '已依序完成左圈、中央換向與右圈，並回到中央空中終點；不必降落或停留，現在可以 Disarm。',
  }
  const index = Number.isInteger(metrics.eightTargetIndex) && metrics.eightTargetIndex >= 0 && metrics.eightTargetIndex < 9
    ? metrics.eightTargetIndex : phase - 2
  const title = `${index + 3}／11 ${figureEightTargetLabel(index)}`
  if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) return {
    title,
    detail: '目前尚未在空中；在目前位置再次自行起飛，再前往亮起的目標。已完成的步驟會保留，不需要回原起飛點或中央入口。',
  }
  const location = directionTargetLocation(metrics)
  const heading = metrics.headingErrorDegrees
  const action = Number.isFinite(heading) && heading > 70
    ? `機頭偏離本步箭頭方向 ${heading.toFixed(0)}°，需在 70° 內；先小量偏航讓機頭跟隨航線，再接近目前目標。`
    : index === 0
      ? '先飛入中央入口，再向左帶入左圈。入口、換向點與終點雖在同一區域，仍須依序飛完左右兩圈。'
      : index === 4
        ? '先飛過中央換向點完成左圈，再逐步反向修正傾斜；右圈的下一個目標亮起後改向右轉，固定 XYZ 不會隨機頭旋轉。'
        : index === 8
          ? '完成右圈後飛入中央綠色終點；仍需在空中，不必降落或停穩。中央終點在起飛點前方，與地面起飛區不同。'
          : `小量 Roll 向${index < 4 ? '左' : '右'}傾斜，配合 Yaw 讓機頭跟隨${index < 4 ? '左' : '右'}圈目標，以 Pitch 維持前進、油門修正高度；固定 XYZ 不會隨機頭旋轉。`
  return {
    title,
    detail: `${location}${action}依序飛入目前目標即可，不要求精準速度或停留；漏點可補飛，已完成的步驟會保留。`,
  }
}

function coordinatedTurnObjective(metrics: Readonly<Record<string, number>>): TrainingObjective {
  const phase = Number.isInteger(metrics.turnPhase) ? metrics.turnPhase : 0
  if (phase <= 1) return {
    title: phase === 0 ? '1／8 起飛區地面準備' : '2／8 自行起飛',
    detail: '從地面自行加油門離地，飛向前方亮起的右轉入口；建議高度約 3 m，不需要先懸停。',
  }
  if (phase >= 8) return {
    title: '8／8 左右轉彎航線已完成',
    detail: '已依序飛過右轉與左轉目標，實際航線也已轉向；現在可以 Disarm。',
  }
  const index = Number.isInteger(metrics.turnTargetIndex) && metrics.turnTargetIndex >= 0 && metrics.turnTargetIndex < 6
    ? metrics.turnTargetIndex : phase - 2
  const title = `${index + 3}／8 ${coordinatedTurnTargetLabel(index)}`
  if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) return {
    title,
    detail: '目前尚未在空中；在目前位置再次自行起飛，再前往亮起的目標。已完成的目標會保留，不需要回原起飛點。',
  }
  const location = directionTargetLocation(metrics)
  const direction = index < 3 ? '右' : '左'
  const stage = index % 3
  const heading = metrics.headingErrorDegrees
  let action: string
  if (Number.isFinite(heading) && heading > 70) {
    action = `機頭偏離本步箭頭方向 ${heading.toFixed(0)}°，需在 70° 內；先小量偏航，讓機頭大致跟隨航線。`
  } else if (stage > 0 && metrics.turnEntryRecorded === 0) {
    action = '尚缺本彎入口的實際移動方向紀錄；請重設課程，依序飛過入口、轉彎點與出口。'
  } else if ((stage === 0 || stage === 2) && metrics.turnMotionReady === 0
    && (!Number.isFinite(metrics.targetDistanceM) || metrics.targetDistanceM <= 1.9)) {
    action = stage === 0
      ? '尚未觀察到入口的實際移動方向；沿入口箭頭小量前進，原地轉頭不算開始轉彎。'
      : `尚未觀察到出口的實際移動方向；沿${direction}轉出口繼續前進，只轉機頭不會完成航線。`
  } else if (stage === 2 && Number.isFinite(metrics.turnChangeDegrees) && metrics.turnChangeDegrees < 25) {
    action = metrics.turnChangeDegrees < 0
      ? `實際航線目前往相反方向轉了 ${Math.abs(metrics.turnChangeDegrees).toFixed(0)}°；用小量傾斜配合偏航，讓移動方向朝${direction}轉，再飛過出口。本彎需實際朝${direction}轉至少 25°。`
      : `實際航線已朝${direction}轉 ${metrics.turnChangeDegrees.toFixed(0)}°，本彎需至少 25°；繼續帶動移動方向轉彎，再飛過出口。只轉機頭不能代替航線轉向。`
  } else {
    action = stage === 0 ? `沿箭頭前進，通過${direction}轉入口後再逐步帶入轉彎。`
      : stage === 1 ? `用小量 Roll 向${direction}傾斜，配合 Yaw 讓機頭跟隨路線；以 Pitch 維持前進、油門修正高度。`
        : `逐步回正，沿${direction}轉出口繼續前進，讓實際移動方向跟著航線轉向。`
  }
  return {
    title,
    detail: `${location}${action}依序進入目標即可，不要求精準速度或停留；漏點可補飛，已完成的目標會保留。`,
  }
}

/** A visible current objective from authoritative stage facts, separate from success. */
export function trainingObjective(
  lessonId: string | null,
  evaluation: Pick<TrainingEvaluation, 'metrics'> | null | undefined,
): TrainingObjective | null {
  const metrics = evaluation?.metrics ?? {}
  if (lessonId === 'orbit') return orbitObjective(metrics)
  if (lessonId === 'split-s') return splitSObjective(metrics)
  if (lessonId === 'power-loop') return powerLoopObjective(metrics)
  if (lessonId === 'full-roll') return fullRollObjective(metrics)
  if (isFullFlipLesson(lessonId)) return fullFlipObjective(metrics, lessonId)
  if (lessonId === 'basic-recovery') return basicRecoveryObjective(metrics)
  if (lessonId === 'wide-gate') return wideGateObjective(metrics)
  if (lessonId === 'direction-control') return directionObjective(metrics)
  if (lessonId === 'coordinated-turn') return coordinatedTurnObjective(metrics)
  if (lessonId === 'square-route') return squareRouteObjective(metrics)
  if (lessonId === 'figure-eight') return figureEightObjective(metrics)
  if (lessonId === 'straight-line') {
    const phase = metrics.routePhase ?? 0
    if (phase === 0) return {
      title: '1／4 從地面自行起飛',
      detail: '從起飛區自行起飛，接著對準前方藍色圈；建議高度約 3 m，不需要先懸停。',
    }
    if (phase >= 4) return {
      title: '4／4 三個圓環已完成',
      detail: '已依序穿過藍色、金色與綠色圓環；本課不要求在終點停留，完成後可 Disarm。',
    }
    const gate = phase === 1
      ? { number: 1, color: '藍色', distance: STRAIGHT_LINE_TRANSIT_DISTANCE_M }
      : phase === 2 ? { number: 2, color: '金色', distance: STRAIGHT_LINE_BRAKE_ZONE_START_M }
        : { number: 3, color: '綠色', distance: STRAIGHT_LINE_ROUTE_LENGTH_M }
    const distance = fact(metrics, 'nextGateDistanceM', 'm')
    return {
      title: `${gate.number + 1}／4 穿過第 ${gate.number} 個${gate.color}圓環`,
      detail: `對準前方 ${gate.distance} m 的${gate.color}圈，從圈內向前穿過。${distance ? `距下一圈平面 ${distance}。` : ''}${metrics.nextGateDistanceM < 0 ? '若剛才從圈外掠過，退回這一圈前再穿一次；已完成的圈會保留。' : ''}${gate.number === 3 ? '穿過這一圈即可完成，不需停穩。' : '依序穿完三圈即可完成，不要求減速比例。'}`,
    }
  }
  if (lessonId === 'landing') {
    const phase = metrics.landingPhase ?? 0
    if (phase <= 1) return {
      title: '1／3 從地面自行起飛',
      detail: `先離地至少 ${LANDING_LIFTOFF_HEIGHT_M} m，再朝前方藍色降落區飛行；起飛墊不是本課降落目標。`,
    }
    if (phase >= 4) return {
      title: '3／3 已在指定區安全接地',
      detail: '在藍色區內接地且沒有墜毀，降落目標已完成；現在可 Disarm，不必再等待穩定計時。',
    }
    return {
      title: phase === 2 ? '2／3 前往藍色降落區' : '3／3 在藍色區內接地',
      detail: `朝前方藍色光柱與地面標記飛行，在中心 ${LANDING_ZONE_RADIUS_M} m 內接地且沒有墜毀即可。${fact(metrics, 'landingPositionErrorM', 'm') ? `距區域中心 ${fact(metrics, 'landingPositionErrorM', 'm')}；` : ''}${fact(metrics, 'landingHeightM', 'm') ? `離地間隙 ${fact(metrics, 'landingHeightM', 'm')}。` : ''}降落在區外時，可直接再起飛重試，不必返回原起飛墊。`,
    }
  }
  return null
}

/** Short route instructions remain visible before a lesson starts. */
export function trainingRouteGuide(lessonId: string | null): string | null {
  if (lessonId === 'orbit') return orbitRouteGuide()
  if (lessonId === 'split-s') return `地面自行起飛至至少 ${SPLIT_ENTRY_HEIGHT} m（建議約 ${SPLIT_TARGET_HEIGHT} m）→ 建立至少 ${SPLIT_ENTRY_SPEED} m/s 前速 → 向左或右橫滾半圈至倒置 → 後拉俯仰走下降半迴圈 → 反向飛往來路 → 拉平改出 → 空中恢復 ${SPLIT_HOLD} 秒。需先實際橫滾倒置，再下降至少 ${SPLIT_HEIGHT_LOSS} m 並往回移動至少 ${SPLIT_REVERSE} m；只偏航轉頭、原地前後翻或接地停住不能代替。練習區半徑 ${SPLIT_AREA_RADIUS} m，改出保留至少 ${SPLIT_MIN_HEIGHT} m，不要求回原點、穿窄門或降落。一般動作中斷後可重新進場，舊標記不代替新一段。引導練習不限時，挑戰 ${SPLIT_TIME_LIMIT} 秒。`
  if (lessonId === 'power-loop') return `地面自行起飛至至少 ${LOOP_ENTRY_HEIGHT} m（建議約 ${LOOP_TARGET_HEIGHT} m）→ 建立至少 ${LOOP_ENTRY_SPEED} m/s 前速 → 拉升 → 越頂倒置 → 下降 → 向前拉平改出 → 空中恢復 ${LOOP_HOLD} 秒。需真正飛出有高度與前後位移的垂直迴圈：拉升至少 ${LOOP_HEIGHT_GAIN} m、前後跨度至少 ${LOOP_SPAN} m、越頂後退至少 ${LOOP_REVERSE} m，且從頂點下降。原地後翻、純上下升降或反向拼湊不能代替。淡色迴圈是參考，不要求完美圓形、回原點、穿障礙或降落。練習區半徑 ${LOOP_AREA_RADIUS} m，改出保留至少 ${LOOP_MIN_HEIGHT} m；中斷後重新進場完成新一圈。引導練習不限時，挑戰 ${LOOP_TIME_LIMIT} 秒。`
  if (lessonId === 'full-roll') return `地面自行起飛至至少 ${ROLL_PREP_HEIGHT} m（建議約 ${ROLL_TARGET_HEIGHT} m）→ 短暫準備 ${ROLL_PREP_SECONDS} 秒 → 選左或右連續橫滾一圈 → 回中減緩旋轉、主動修回正飛 → 空中恢復控制 ${ROLL_HOLD_SECONDS} 秒。沿機頭到機尾的軸翻轉，需觀察到本圈實際倒置與完整橫滾；反向翻回、原地偏航或前後翻轉不代替 Roll。練習區為起飛點半徑 ${ROLL_AREA_RADIUS} m，恢復時保留至少 ${ROLL_MIN_HEIGHT} m 高度，不要求回原位置或降落。接地、過低或離區中斷本圈後，先重新準備，再完整做一圈；先前步驟保留。引導練習不限時，挑戰 ${ROLL_TIME_LIMIT} 秒。`
  if (fullFlipRequiredDirection(lessonId ?? '') !== 0) return `本課練${flipCourseDirection(lessonId)}。地面自行起飛至至少 ${FLIP_PREP_HEIGHT} m（建議約 ${FLIP_TARGET_HEIGHT} m）→ 短暫準備 ${FLIP_PREP_SECONDS} 秒 → 沿俯仰軸連續${flipCourseDirection(lessonId)}一整圈 → 回中減緩旋轉、主動修回正飛 → 空中恢復控制 ${FLIP_HOLD_SECONDS} 秒。必須觀察到指定方向的實際倒置與完整一圈；反方向翻轉不計入本課，先回正重新準備後再練。練習區為起飛點半徑 ${FLIP_AREA_RADIUS} m，恢復時保留至少 ${FLIP_MIN_HEIGHT} m 高度，不要求回原位置或降落。中斷後先前步驟保留，但需完整做新的一圈。引導練習不限時，挑戰 ${FLIP_TIME_LIMIT} 秒。`
  if (isFullFlipLesson(lessonId)) return `地面自行起飛至至少 ${FLIP_PREP_HEIGHT} m（建議約 ${FLIP_TARGET_HEIGHT} m）→ 短暫準備 ${FLIP_PREP_SECONDS} 秒 → 選前翻或後翻連續翻轉一圈 → 回中減緩旋轉、主動修回正飛 → 空中恢復控制 ${FLIP_HOLD_SECONDS} 秒。沿機身左右兩側的俯仰軸翻轉，需觀察到本圈實際倒置與完整翻轉；反向翻回、原地偏航或左右橫滾不能代替完整前後翻轉。練習區為起飛點半徑 ${FLIP_AREA_RADIUS} m，恢復時保留至少 ${FLIP_MIN_HEIGHT} m 高度，不要求回原位置或降落。接地、過低或離區中斷本圈後，先重新準備，再完整做一圈；先前步驟保留。引導練習不限時，挑戰 ${FLIP_TIME_LIMIT} 秒。`
  if (lessonId === 'basic-recovery') return `地面自行起飛至 ${RECOVERY_PREP_HEIGHT} m 以上（建議約 ${RECOVERY_TARGET_HEIGHT} m）→ 按提示製造小幅傾斜並修回水平 → 稍收油門產生下沉並補油止降 → 建立水平漂移並減速回平。每項先確認實際偏差，再確認恢復 ${RECOVERY_HOLD_SECONDS} 秒；各段只準備目前要練的動作，確認 ${RECOVERY_PREP_SECONDS} 秒後才開始。練習區為起飛點半徑 ${RECOVERY_AREA_RADIUS} m，恢復時保持空中且高度至少 ${RECOVERY_MIN_HEIGHT} m；接地或過低會中斷本項，先前完成的整項保留，重新準備後再製造本項偏差；出區會暫停確認，回區後可繼續有效的恢復。不要求回到固定座標或精準懸停，全程由你操控。引導練習不限時，挑戰 ${RECOVERY_TIME_LIMIT} 秒。`
  if (lessonId === 'wide-gate') return '地面起飛 → 前方 8 m 第一道門 → 16 m 第二道門 → 24 m 第三道門。三道門洞寬、高各 4 m，中心離地 3 m；依序從門前向前穿過，反向穿越不算。門框是實體障礙，碰到柱子或橫樑會墜毀；對準中心並為機身、槳葉留出空間。漏門可回該門前補飛，已通過的門及未墜毀接地的進度會保留；不要求精準速度、朝向、停留或降落。引導練習不限時，挑戰 240 秒。'
  if (lessonId === 'figure-eight') return '地面起飛 → 中央入口 → 左圈 → 中央換向點 → 右圈 → 中央空中終點。中央區位於起飛點前方 6 m；相同位置要依順序經過，不能提早當作終點。沿淡色八字路線依序飛入亮起目標，先左轉再右轉；目標半徑 1.8 m，不要求精準速度、停留或降落。漏點及未墜毀接地保留進度，方位提示依目前機頭，XYZ 維持固定場地方向。引導練習不限時，挑戰 300 秒。'
  if (lessonId === 'square-route') return '地面起飛 → 第 1 段前進 → 右轉 → 第 2 段 → 右轉 → 第 3 段 → 右轉 → 第 4 段返回起點上方。沿淡色方形路線，依序飛入亮起的直線、轉角與綠色終點；目標半徑 1.8 m，不要求精準速度、停留或降落。漏點及未墜毀接地保留進度，方位提示依目前機頭，XYZ 維持固定場地方向。'
  if (lessonId === 'coordinated-turn') return '地面起飛 → 右轉入口、轉彎點、出口 → 左轉入口、轉彎點、出口。沿地面航線與目前亮起的目標依序飛行；用傾斜、偏航及前進配合轉彎，只原地轉頭不算。目標半徑 1.8 m，不要求精準速度或停留；漏點及未墜毀接地保留進度，固定 XYZ 不會隨機頭轉向。'
  if (lessonId === 'direction-control') return '地面起飛 → 左右側移 → 前後移動 → 向右偏航換向 → 以新朝向前進及右移。依序飛入目前亮起的目標區即可，無須停穩；方位提示以目前機頭為準，XYZ 則是固定場地座標。'
  if (lessonId === 'straight-line') {
    return `地面起飛 → 藍色 ${STRAIGHT_LINE_TRANSIT_DISTANCE_M} m → 金色 ${STRAIGHT_LINE_BRAKE_ZONE_START_M} m → 綠色 ${STRAIGHT_LINE_ROUTE_LENGTH_M} m。圓環半徑 ${STRAIGHT_LINE_GATE_RADIUS_M} m；依序從圈內穿過三圈即可完成，不要求減速比例或終點停留。漏圈可退回該圈前重新穿過，已通過的圈保留。`
  }
  if (lessonId === 'landing') return `地面起飛 → 飛往正前方 ${LANDING_ZONE_DISTANCE_M} m 的藍色降落區 → 在半徑 ${LANDING_ZONE_RADIUS_M} m 內接地且沒有墜毀即可完成。降落目標與起飛墊分開，依藍色光柱及地面標記辨認；不需額外等待穩定計時。`
  return null
}

/** Reuse evaluator guidance without inventing a cause from unsigned error metrics. */
export function trainingHint(
  lessonId: string | null,
  evaluation: Pick<TrainingEvaluation, 'status' | 'message' | 'hint' | 'metrics' | 'recovery'> | null | undefined,
): string {
  const hint = evaluation?.hint?.trim()
  const message = evaluation?.message?.trim()
  if (lessonId === 'orbit' && evaluation && (Number.isFinite(evaluation.metrics?.orbitPhase) || /^正刷鍋/u.test(message ?? ''))) return orbitTrainingHint(evaluation)
  if (lessonId === 'split-s' && evaluation?.status === 'failure') {
    const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message ?? '')) return `本次發生墜毀，破S已停止；先重設場景，下一次保留足夠進場高度並提早改出。${restart}`
    if (/解除解鎖|上鎖|失焦|失去焦點|斷線|disarm|focus|disconnect/iu.test(message ?? '')) return `本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒後重試。${restart}`
    if (/無效|資料中斷|時間倒退|跳躍|缺少有效|不一致|重設|invalid|non-finite|telemetry.*gap|reset|rewind/iu.test(message ?? '')) return `本次飛行資料無效、中斷或被重設，無法判定破S表現；保持網頁在前景後重試。${restart}`
    if (/逾時|timed out|timeout/iu.test(message ?? '')) return `本次破S挑戰逾時。${restart}`
    return `本次破S尚未完成。${restart}`
  }
  if (lessonId === 'split-s' && evaluation?.status === 'continue' && evaluation.metrics && evaluation.recovery !== 'restart') {
    const objective = splitSObjective(evaluation.metrics)
    return `${objective.title}：${objective.detail}`
  }
  if (lessonId === 'power-loop' && evaluation?.status === 'failure') {
    const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message ?? '')) return `本次發生墜毀，大迴旋練習已停止；先重設場景。${restart}`
    if (/解除解鎖|上鎖|失焦|失去焦點|斷線|disarm|focus|disconnect/iu.test(message ?? '')) return `本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒後重試。${restart}`
    if (/無效|資料中斷|時間倒退|跳躍|不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message ?? '')) return `本次飛行資料無效、中斷或被重設，無法判定大迴旋表現；保持網頁在前景後重試。${restart}`
    if (/逾時|timed out|timeout/iu.test(message ?? '')) return `本次大迴旋挑戰逾時。${restart}`
    return `本次大迴旋尚未完成。${restart}`
  }
  if (lessonId === 'power-loop' && evaluation?.status === 'continue' && evaluation.metrics && evaluation.recovery !== 'restart') {
    const objective = powerLoopObjective(evaluation.metrics)
    return `${objective.title}：${objective.detail}`
  }
  if (lessonId === 'full-roll' && evaluation?.status === 'failure') {
    const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message ?? '')) return `本次發生墜毀，完整橫滾練習已停止；先按 Reset 重設。${restart}`
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message ?? '')) return `本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒，倒數結束後再明確 Arm。${restart}`
    if (/無效|資料中斷|時間倒退|位置跳躍|姿態跳躍|缺少有效|支撐高度不一致|不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message ?? '')) return `本次飛行資料無效、中斷或被重設，無法判定完整橫滾表現；保持網頁在前景後重試。${restart}`
    if (/逾時|timed out|timeout/iu.test(message ?? '')) return `本次完整橫滾挑戰逾時。${restart}`
    return `本次完整橫滾尚未完成。${restart}`
  }
  if (lessonId === 'full-roll' && evaluation?.status === 'continue' && evaluation.metrics && evaluation.recovery !== 'restart') {
    const objective = fullRollObjective(evaluation.metrics)
    return `${objective.title}：${objective.detail}`
  }
  if (isFullFlipLesson(lessonId) && evaluation?.status === 'failure') {
    const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message ?? '')) return `本次發生墜毀，完整翻轉練習已停止；先重設場景。${restart}`
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message ?? '')) return `本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒，倒數結束後再明確解鎖。${restart}`
    if (/無效|資料中斷|時間倒退|位置跳躍|姿態跳躍|缺少有效|支撐高度不一致|不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message ?? '')) return `本次飛行資料無效、中斷或被重設，無法判定完整翻轉表現；保持網頁在前景後重試。${restart}`
    if (/逾時|timed out|timeout/iu.test(message ?? '')) return `本次完整翻轉挑戰逾時。${restart}`
    return `本次完整翻轉尚未完成。${restart}`
  }
  if (isFullFlipLesson(lessonId) && evaluation?.status === 'continue' && evaluation.metrics && evaluation.recovery !== 'restart') {
    const objective = fullFlipObjective(evaluation.metrics, lessonId)
    return `${objective.title}：${objective.detail}`
  }
  if (lessonId === 'basic-recovery' && evaluation?.status === 'failure') {
    const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message ?? '')) return `本次發生墜毀，基礎恢復練習已停止；先按 Reset 重設。${restart}`
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message ?? '')) return `本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒，倒數結束後再明確 Arm。${restart}`
    if (/無效|資料中斷|時間倒退|位置跳躍|缺少有效|支撐高度不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message ?? '')) return `本次飛行資料無效、中斷或被重設，無法判定恢復表現；保持網頁在前景後重試。${restart}`
    if (/逾時|timed out|timeout/iu.test(message ?? '')) return `本次基礎恢復挑戰逾時。${restart}`
    return `本次基礎失誤恢復尚未完成。${restart}`
  }
  if (lessonId === 'basic-recovery' && evaluation?.status === 'continue' && evaluation.metrics && evaluation.recovery !== 'restart') {
    const objective = basicRecoveryObjective(evaluation.metrics)
    return `${objective.title}：${objective.detail}`
  }
  if (lessonId === 'wide-gate' && evaluation?.status === 'failure') {
    const collision = wideGateCollisionCause(message ?? '')
    const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
    if (collision) return `${collision}，造成墜毀；先按 Reset 重設。${restart}下次對準門洞中心，為機身與槳葉留出門框間距。`
    if (/Obstacle collision:/iu.test(message ?? '')) return `本次撞到障礙物並墜毀；碰撞資料未指出可辨識的門框部位，先按 Reset 重設。${restart}`
    if (/墜毀|撞擊|crash|impact/iu.test(message ?? '')) return `${/ground|地面/iu.test(message ?? '') ? '本次地面撞擊造成墜毀' : '本次發生墜毀'}，寬門穿越練習已停止；先按 Reset 重設。${restart}`
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message ?? '')) return `本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒，倒數結束後再明確 Arm。${restart}`
    if (/無效|資料中斷|時間倒退|位置跳躍|缺少有效|支撐高度不一致|模擬被重設|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message ?? '')) return `本次飛行資料無效或中斷，無法判定寬門穿越表現；保持網頁在前景後重試。${restart}`
    if (/逾時|timed out|timeout/iu.test(message ?? '')) return `本次寬門穿越挑戰逾時。${restart}`
    return `本次寬門穿越尚未完成。${restart}`
  }
  if (lessonId === 'wide-gate' && evaluation?.status === 'continue' && evaluation.metrics && evaluation.recovery !== 'restart') {
    const objective = wideGateObjective(evaluation.metrics)
    return `${objective.title}：${objective.detail}`
  }
  if (lessonId === 'figure-eight' && evaluation?.status === 'failure' && message) {
    if (/墜毀|撞擊|crash|impact/iu.test(message)) return '本次發生墜毀，八字航線練習已停止；先按 Reset 重設，再從地面自行起飛。'
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return '本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒，重試課程後再明確 Arm。'
    if (/無效|資料中斷|時間倒退|位置跳躍|缺少有效|支撐高度不一致|模擬被重設|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message)) return '本次飛行資料無效或中斷，八字航線練習已停止；請重設課程，保持網頁在前景後重試。'
    if (/逾時|timed out|timeout/iu.test(message)) return '本次八字航線挑戰逾時，練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  }
  if (lessonId === 'square-route' && evaluation?.status === 'failure' && message) {
    if (/墜毀|撞擊|crash|impact/iu.test(message)) return '本次發生墜毀，方形航線練習已停止；先按 Reset 重設，再從地面自行起飛。'
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return '本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒，重試課程後再明確 Arm。'
    if (/無效|資料中斷|時間倒退|位置跳躍|缺少有效|支撐高度不一致|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message)) return '本次飛行資料無效或中斷，方形航線練習已停止；請重設課程，保持網頁在前景後重試。'
  }
  if (lessonId === 'coordinated-turn' && evaluation?.status === 'failure' && message) {
    if (/墜毀|撞擊|crash|impact/iu.test(message)) return '本次發生墜毀，轉彎練習已停止；先按 Reset 重設，再從地面自行起飛。'
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return '本次因解除解鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒，重試課程後再明確 Arm。'
    if (/無效|資料中斷|時間倒退|位置跳躍|缺少有效|支撐高度不一致|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message)) return '本次飛行資料無效或中斷，轉彎練習已停止；請重設課程，保持網頁在前景後重試。'
  }
  // Show the measured cause before its corrective action. Internal English
  // diagnostics still use the localized fallback rather than leaking into UI.
  if ((evaluation?.recovery === 'restart' || evaluation?.status === 'failure')
    && message && /[\u3400-\u9fff]/u.test(message)) {
    const action = hint ? HINT_TRANSLATIONS[hint] ?? (/[\u3400-\u9fff]/u.test(hint) ? hint : null) : null
    return action && action !== message ? `${message} ${action}` : message
  }
  if (hint) {
    const translated = HINT_TRANSLATIONS[hint]
    if (translated) return translated
    if (/[\u3400-\u9fff]/u.test(hint)) return hint
  }
  if (evaluation?.status === 'continue' && evaluation.metrics && evaluation.recovery !== 'restart') {
    const objective = trainingObjective(lessonId, evaluation)
    if (objective) return `${objective.title}：${objective.detail}`
  }
  if (evaluation?.status === 'success') return '已完成本課目標。先解除解鎖，再查看結果與回放。'
  if (evaluation?.status === 'failure') return '本次練習已停止。先查看結果，再按重試，倒數後明確解鎖。'
  return (lessonId ? LESSON_HINTS[lessonId] : undefined) ?? '先閱讀本課目標；倒數完成後，確認低油門與搖桿中立再解鎖。'
}
