import type { TrainingEvaluation } from './types'
import { LANDING_LIFTOFF_HEIGHT_M, LANDING_ZONE_DISTANCE_M, LANDING_ZONE_RADIUS_M } from './landing'
import {
  STRAIGHT_LINE_BRAKE_ZONE_START_M,
  STRAIGHT_LINE_GATE_RADIUS_M,
  STRAIGHT_LINE_ROUTE_LENGTH_M,
  STRAIGHT_LINE_TRANSIT_DISTANCE_M,
} from './straightLine'

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
  positionErrorM: { label: '位置偏差', unit: 'm', digits: 2 },
  radialErrorM: { label: '繞行半徑偏差', unit: 'm', digits: 2 },
  orbitRadiusM: { label: '繞行半徑', unit: 'm', digits: 2 },
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
      label: lessonId === 'wide-gate' && key === 'gatesPassed' ? '已通過寬門'
        : lessonId === 'wide-gate' && key === 'nextGateDistanceM' ? '距目前門平面（前＋／後−）' : definition.label,
      value: key === 'groundTouching' ? value > 0.5 ? '已接地' : '尚未接地'
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
  takeoff: '緩推油門，留在起飛區上方；接近目標高度時改用小量修正。',
  landing: `先從地面起飛，再前往正前方 ${LANDING_ZONE_DISTANCE_M} m 的藍色降落區；在區內接地且沒有墜毀即可完成。`,
  'straight-line': '先自行起飛，再依序穿過藍色、金色與綠色三個圓環；穿過綠色終點環即可完成。',
  'direction-control': '從地面自行起飛，依亮起目標練左右、前後移動，再向右偏航換向；方向提示以目前機頭為準。',
  hover: '先減少水平移動，再用小量油門修正高度，避免連續大幅補桿。',
  'coordinated-turn': '從地面自行起飛，依序飛過右轉與左轉的入口、轉彎點和出口；小量傾斜並配合轉頭，讓實際航線一起轉彎。',
  'square-route': '從地面自行起飛，依序沿四段直線與右轉角飛行，再回到起點上方；漏點可補飛，不需精準速度、停留或降落。',
  'figure-eight': '從地面自行起飛，進中央入口後先飛左圈，經中央換向點接右圈，再回到中央空中終點；依目前亮起的目標前進，漏點可補飛。',
  'wide-gate': '從地面自行起飛，依序向前穿過三道寬門的門洞；對準約 3 m 高的中心並留出槳葉空間，碰到實體門框會墜毀。',
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
