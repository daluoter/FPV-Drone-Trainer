import type { TrainingEvaluation } from './types'

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
  altitudeM: { label: '起飛點上方', unit: 'm', digits: 2 },
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
  hover: ['altitudeErrorM', 'horizontalDriftM', 'contiguousDwellSeconds'],
  'coordinated-turn': ['routeCorridorErrorM', 'headingChangeDegrees', 'speedMps'],
  'split-s': ['entryAltitudeM', 'headingChangeDegrees', 'recoveryAltitudeErrorM'],
  orbit: ['orbitProgress', 'radialErrorM', 'altitudeErrorM'],
}

/** Show observations with units; internal accumulator keys are not teaching copy. */
export function formatTrainingMetrics(
  metrics: Readonly<Record<string, number>> | undefined,
  lessonId: string | null = null,
  limit = 3,
): readonly TrainingMetricDisplay[] {
  if (!metrics) return []
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(3, Math.floor(limit))) : 3
  const priorities = lessonId ? LESSON_METRICS[lessonId] ?? [] : []
  const keys = [...new Set([...priorities, ...Object.keys(metrics)])]
  return keys.flatMap((key): TrainingMetricDisplay[] => {
    const definition = METRICS[key]
    const value = metrics[key]
    if (!definition || !Number.isFinite(value)) return []
    const displayed = definition.transform?.(value) ?? value
    return [{
      key,
      label: definition.label,
      value: `${displayed.toFixed(definition.digits)}${definition.unit ? ` ${definition.unit}` : ''}`,
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
  hover: '先減少水平移動，再用小量油門修正高度，避免連續大幅補桿。',
  'coordinated-turn': '先對準入口，再沿標示航線轉彎，同時留意高度。',
  'split-s': '先確認進入高度，再依序完成倒置、下降半圈與恢復正向。',
  orbit: '沿目標周圍保持同一繞行方向，先穩住半徑與高度。',
}

/** Reuse evaluator guidance without inventing a cause from unsigned error metrics. */
export function trainingHint(
  lessonId: string | null,
  evaluation: Pick<TrainingEvaluation, 'status' | 'hint'> | null | undefined,
): string {
  const hint = evaluation?.hint?.trim()
  if (hint) {
    const translated = HINT_TRANSLATIONS[hint]
    if (translated) return translated
    if (/[\u3400-\u9fff]/u.test(hint)) return hint
  }
  if (evaluation?.status === 'success') return '已完成本課目標。先解除解鎖，再查看結果與回放。'
  if (evaluation?.status === 'failure') return '本次練習已停止。先查看結果，再按重試，倒數後明確解鎖。'
  return (lessonId ? LESSON_HINTS[lessonId] : undefined) ?? '先閱讀本課目標；倒數完成後，確認低油門與搖桿中立再解鎖。'
}
