import { backwardFlightResultFeedback } from './backwardFlightFeedback'
import {
  BASIC_RECOVERY_TARGET_HEIGHT_M as RECOVERY_TARGET_HEIGHT,
  BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M as RECOVERY_PREP_HEIGHT,
  BASIC_RECOVERY_MIN_HEIGHT_M as RECOVERY_MIN_HEIGHT,
  BASIC_RECOVERY_AREA_RADIUS_M as RECOVERY_AREA_RADIUS,
  BASIC_RECOVERY_HOLD_SECONDS as RECOVERY_HOLD_SECONDS,
  BASIC_RECOVERY_LEVEL_DEGREES as RECOVERY_TILT_LEVEL,
  BASIC_RECOVERY_SINK_LEVEL_DEGREES as RECOVERY_SINK_LEVEL,
  BASIC_RECOVERY_DRIFT_LEVEL_DEGREES as RECOVERY_DRIFT_LEVEL,
  BASIC_RECOVERY_MAX_BODY_RATE_DEGREES as RECOVERY_MAX_RATE,
  BASIC_RECOVERY_SINK_STOP_MPS as RECOVERY_SINK_STOP,
  BASIC_RECOVERY_SINK_CLIMB_MPS as RECOVERY_SINK_CLIMB,
  BASIC_RECOVERY_DRIFT_STOP_MPS as RECOVERY_DRIFT_STOP,
  BASIC_RECOVERY_DRIFT_VERTICAL_MPS as RECOVERY_DRIFT_VERTICAL,
} from './basicRecovery'
import { basicRecoveryStageLabel, coordinatedTurnTargetLabel, directionControlTargetLabel, figureEightTargetLabel, fullFlipInterruptionReason, fullRollInterruptionReason, powerLoopInterruptionReason, powerLoopStageLabel, splitSInterruptionReason, splitSStageLabel, squareRouteTargetLabel, trainingHint, trainingObjective, wideGateCollisionCause } from './feedback'
import { LANDING_LIFTOFF_HEIGHT_M, LANDING_ZONE_RADIUS_M } from './landing'
import { TAKEOFF_SETTLED_DWELL_SECONDS } from './takeoff'
import {
  FULL_ROLL_TARGET_HEIGHT_M as ROLL_TARGET_HEIGHT,
  FULL_ROLL_MIN_PREPARATION_HEIGHT_M as ROLL_PREP_HEIGHT,
  FULL_ROLL_MIN_HEIGHT_M as ROLL_MIN_HEIGHT,
  FULL_ROLL_AREA_RADIUS_M as ROLL_AREA_RADIUS,
  FULL_ROLL_HOLD_SECONDS as ROLL_HOLD_SECONDS,
  FULL_ROLL_RECOVERY_TILT_DEGREES as ROLL_RECOVERY_TILT,
  FULL_ROLL_MAX_BODY_RATE_DEGREES as ROLL_MAX_RATE,
  FULL_ROLL_MAX_HORIZONTAL_SPEED_MPS as ROLL_MAX_HORIZONTAL,
  FULL_ROLL_RECOVERY_DESCENT_MPS as ROLL_RECOVERY_DESCENT,
  FULL_ROLL_RECOVERY_CLIMB_MPS as ROLL_RECOVERY_CLIMB,
} from './fullRoll'
import {
  fullFlipRequiredDirection,
  FULL_FLIP_TARGET_HEIGHT_M as FLIP_TARGET_HEIGHT,
  FULL_FLIP_MIN_PREPARATION_HEIGHT_M as FLIP_PREP_HEIGHT,
  FULL_FLIP_MIN_HEIGHT_M as FLIP_MIN_HEIGHT,
  FULL_FLIP_AREA_RADIUS_M as FLIP_AREA_RADIUS,
  FULL_FLIP_HOLD_SECONDS as FLIP_HOLD_SECONDS,
  FULL_FLIP_RECOVERY_TILT_DEGREES as FLIP_RECOVERY_TILT,
  FULL_FLIP_MAX_BODY_RATE_DEGREES as FLIP_MAX_RATE,
  FULL_FLIP_MAX_HORIZONTAL_SPEED_MPS as FLIP_MAX_HORIZONTAL,
  FULL_FLIP_RECOVERY_DESCENT_MPS as FLIP_RECOVERY_DESCENT,
  FULL_FLIP_RECOVERY_CLIMB_MPS as FLIP_RECOVERY_CLIMB,
} from './fullFlip'
import type { TrainingResult } from './types'
import { orbitResultFeedback } from './orbitFeedback'
import { POWER_LOOP_TARGET_HEIGHT_M } from './powerLoop'

export interface TrainingResultFeedback {
  readonly observedStrength: string | null
  readonly observedGap: string | null
  readonly nextPractice: string
  readonly scopeNote: string
}

interface MetricGoal {
  readonly key: string
  readonly label: string
  readonly unit: string
  readonly target: number
  readonly minimum?: boolean
  readonly tip: string
}

// Route goals here describe historical rules: L03/L04 before 4 and L06 before
// 5. New results use observed progress below instead of the old precision goals.
const GOALS: Readonly<Record<string, readonly MetricGoal[]>> = {
  takeoff: [
    { key: 'altitudeErrorM', label: '高度偏差', unit: 'm', target: 0.35, tip: '下一次接近目標高度時，改用小量油門修正上升或下降速度。' },
    { key: 'horizontalDriftM', label: '偏離中心距離', unit: 'm', target: 1.2, tip: '下一次先減少水平移動，再回到起飛區上方。' },
    { key: 'verticalSpeedMps', label: '垂直速度', unit: 'm/s', target: 0.6, tip: '下一次提早用小量油門降低上升或下降速度，再保持高度。' },
    { key: 'contiguousDwellSeconds', label: '連續穩定時間', unit: 's', target: TAKEOFF_SETTLED_DWELL_SECONDS, minimum: true, tip: '下一次先穩住位置與速度，再重新累積完整的連續穩定時間。' },
  ],
  hover: [
    { key: 'altitudeErrorM', label: '高度偏差', unit: 'm', target: 0.65, tip: '下一次先觀察升降方向，再用小量油門修正高度。' },
    { key: 'horizontalSpeedMps', label: '水平速度', unit: 'm/s', target: 0.8, tip: '下一次先小量反向修正，減少水平移動後再回到目標中心。' },
    { key: 'maxTiltDegrees', label: '機身傾角', unit: '°', target: 10, tip: '下一次用小量反向輸入恢復接近水平；Acro 搖桿回中不會自動回平。' },
    { key: 'contiguousDwellSeconds', label: '連續停留時間', unit: 's', target: 3.2, minimum: true, tip: '下一次留在目標區，穩住高度與移動速度，再連續保持。' },
  ],
  landing: [
    { key: 'landingPositionErrorM', label: '落點偏差', unit: 'm', target: 0.85, tip: '下一次先對準墊中心並消除側移，再繼續下降。' },
    { key: 'touchdownDescentSpeedMps', label: '接地前下降速度', unit: 'm/s', target: 0.8, tip: '下一次在接地前提早減少下降速度，不要等碰地才修正油門。' },
    { key: 'horizontalSpeedMps', label: '水平速度', unit: 'm/s', target: 0.2, tip: '下一次先減少側移，接地後維持低油門並留在指定區。' },
    { key: 'contiguousDwellSeconds', label: '接地後連續穩定時間', unit: 's', target: 1, minimum: true, tip: '下一次平穩接地後保持水平與低油門，等完成結果出現再 Disarm。' },
  ],
  'straight-line': [
    { key: 'stopErrorM', label: '終點偏差', unit: 'm', target: 0.65, tip: '下一次進入減速區就開始小量反向傾斜，提早降低前進速度。' },
    { key: 'altitudeErrorM', label: '高度偏差', unit: 'm', target: 0.45, tip: '下一次前進或減速時同時觀察高度，用小量油門保持目標高度。' },
    { key: 'horizontalSpeedMps', label: '水平速度', unit: 'm/s', target: 0.35, tip: '下一次觀察實際速度下降後，再把機體帶回接近水平；回中不會自動煞停。' },
    { key: 'contiguousDwellSeconds', label: '終點連續穩定時間', unit: 's', target: 1.2, minimum: true, tip: '下一次在終點先穩住位置、速度與高度，再連續保持。' },
  ],
  'coordinated-turn': [
    { key: 'routeCorridorErrorM', label: '偏離航線', unit: 'm', target: 3.2, tip: '這是舊版單彎航線紀錄；依當時入口、轉彎點及出口練習，讓實際航線留在走廊內。' },
    { key: 'headingChangeDegrees', label: '實際航向變化', unit: '°', target: 55, minimum: true, tip: '這是舊版單彎航線紀錄；讓實際飛行方向隨入口、轉彎點到出口改變，原地轉頭不能代替轉彎。' },
  ],
}

function amount(value: number, unit: string): string {
  return `${value.toFixed(unit === '°' ? 1 : 2)} ${unit}`
}

function isLegacyRouteResult(result: TrainingResult): boolean {
  const version = result.attemptContext?.rulesVersion
  return version !== undefined && (['straight-line', 'landing'].includes(result.lessonId) && version < 4
    || result.lessonId === 'coordinated-turn' && version < 5)
}

function fullRollResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'full-roll') return null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const message = result.message ?? ''
  const timedOut = /逾時|timed out|timeout/iu.test(message)
  if (result.outcome !== 'SUCCESS') {
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次發生墜毀，完整橫滾與空中恢復尚未完成。',
      nextPractice: `先按 Reset 重設。${restart}下次先取得約 ${ROLL_TARGET_HEIGHT} m 高度，配合油門保留橫滾與恢復的高度餘裕。`,
      scopeNote: scope,
    }
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定橫滾操控表現。',
      nextPractice: `${restart}確認網頁與控制器就緒，倒數完成後再明確 Arm。`,
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|位置跳躍|姿態跳躍|缺少有效|支撐高度不一致|不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效、中斷或被重設，無法以這段資料判定完整橫滾表現。',
      nextPractice: `${restart}保持網頁在前景，重新取得高度後，以實際飛行完成同方向的一圈 Roll。`,
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null,
    observedGap: `${timedOut ? '本次挑戰逾時；' : ''}本次沒有有效的已解鎖飛行樣本，無法判定橫滾表現。`,
    nextPractice: `${restart}確認畫面與控制器就緒，倒數完成後明確 Arm。`,
    scopeNote: scope,
  }
  const metrics = result.metrics
  const phase = Number.isInteger(metrics.rollPhase) && metrics.rollPhase >= 0 && metrics.rollPhase <= 6 ? metrics.rollPhase : null
  if (result.outcome === 'SUCCESS' && phase === 6 && result.completedCheckpoints === 6) return {
    observedStrength: '本次已從地面自行起飛，完成同一圈的實際倒置、完整橫滾，以及其後的空中正飛與控制恢復。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，觀察適時停止橫滾與油門配合；熟悉後再練另一側，不需要回到原位置或降落。',
    scopeNote: scope,
  }
  const validEpisode = metrics.rollEpisodeValid > 0.5
  const completedRoll = validEpisode && metrics.rollCompleted > 0.5
  const strength = completedRoll ? '本次已觀察到一圈完整橫滾，尚待完成其後的空中恢復。'
    : validEpisode && metrics.rollInverted > 0.5 ? '本次已觀察到這一圈的實際倒置姿態。'
      : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛並取得練習高度。' : null
  const ended = timedOut ? '本次挑戰逾時，' : '本次'
  if (phase === null || phase === 6) return {
    observedStrength: null,
    observedGap: `${ended}完整橫滾的分段資料不足，無法判定這一圈的旋轉與恢復過程。`,
    nextPractice: `${restart}先取得高度，再依提示完成一圈 Roll 及空中恢復。`,
    scopeNote: scope,
  }
  if (phase <= 1) return {
    observedStrength: null,
    observedGap: `${ended}尚未完成從地面自行起飛並取得橫滾練習高度。`,
    nextPractice: `${restart}自行起飛到至少 ${ROLL_PREP_HEIGHT} m，建議約 ${ROLL_TARGET_HEIGHT} m，再準備橫滾。`,
    scopeNote: scope,
  }
  let observation: string
  if (metrics.groundTouching > 0.5) observation = '結束時已接地；地面停住不能算空中恢復，本圈證據已中斷。'
  else if (metrics.insideRollArea === 0) observation = `結束時超出起飛點半徑 ${ROLL_AREA_RADIUS} m 的練習區，本圈需要重新準備與完整橫滾。`
  else if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < ROLL_MIN_HEIGHT) observation = `結束時離地 ${metrics.altitudeM.toFixed(1)} m，未保留空中恢復需要的 ${ROLL_MIN_HEIGHT} m 高度，本圈已中斷。`
  else if (!validEpisode) observation = metrics.rollInterrupted > 0.5
    ? `先前這一圈已中斷；${fullRollInterruptionReason(metrics) ?? ''}歷史倒置或回正標記不代替新一圈，尚未重新完成準備與完整橫滾。`
    : '尚未完成橫滾前的短暫準備；先取得高度並減少過大旋轉、升降與漂移。'
  else if (!completedRoll) {
    const progress = Number.isFinite(metrics.rollProgressDegrees) ? `結束時本圈橫滾進度約 ${Math.max(0, Math.min(360, metrics.rollProgressDegrees)).toFixed(1)}°，` : ''
    observation = metrics.rollInverted > 0.5
      ? `${progress}已通過本圈倒置，但尚未沿同一方向完成一圈並回正；倒置後反向翻回不等於完成。`
      : `${progress}尚未觀察到這一圈的實際倒置與完整橫滾；只推動搖桿、原地偏航或前後翻轉不能代替 Roll。`
  } else {
    const observations: string[] = []
    if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > ROLL_RECOVERY_TILT) observations.push(`結束時傾角 ${metrics.tiltDegrees.toFixed(1)}°，需修回 ${ROLL_RECOVERY_TILT}° 內`)
    if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > ROLL_MAX_RATE) observations.push(`機身仍以 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s 旋轉，需減緩到 ${ROLL_MAX_RATE}°/s 內`)
    if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > ROLL_MAX_HORIZONTAL) observations.push(`水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s，尚未降低到 ${ROLL_MAX_HORIZONTAL} m/s 內`)
    if (Number.isFinite(metrics.verticalSpeedMps) && (metrics.verticalSpeedMps < -ROLL_RECOVERY_DESCENT || metrics.verticalSpeedMps > ROLL_RECOVERY_CLIMB)) observations.push(`升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−），尚未回到 −${ROLL_RECOVERY_DESCENT}～+${ROLL_RECOVERY_CLIMB} m/s`)
    if (Number.isFinite(metrics.recoveryDwellSeconds) && metrics.recoveryDwellSeconds < ROLL_HOLD_SECONDS) observations.push(`恢復確認 ${Math.max(0, metrics.recoveryDwellSeconds).toFixed(2)}／${ROLL_HOLD_SECONDS.toFixed(2)} s，尚未連續完成`)
    observation = observations.length ? `${observations.slice(0, 2).join('；')}。` : '已完成本圈橫滾，尚未連續確認正飛與控制恢復。'
  }
  const action = completedRoll
    ? '下次接近正飛時提早回中減緩旋轉，再主動回平與調整油門；回中不會自動回平或煞停。'
    : '下次選左或右的同一方向連續橫滾，實際通過倒置並完成一圈後，再停止旋轉、修回正飛；先保留足夠高度。'
  return { observedStrength: strength, observedGap: `${ended}完整橫滾尚未完成。${observation}`,
    nextPractice: `${restart}${action}`, scopeNote: scope }
}

function splitSResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'split-s') return null
  // Earlier airborne five-step results retain their historical meaning. They
  // cannot be relabeled as evidence of the new ground-start eight-step course.
  if (result.attemptContext?.rulesVersion !== 6 && !Number.isFinite(result.metrics.splitPhase)) return null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const message = result.message ?? ''
  const timedOut = /逾時|timed out|timeout/iu.test(message)
  if (result.outcome !== 'SUCCESS') {
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message)) return {
      observedStrength: null, observedGap: '本次發生墜毀，破S與空中改出尚未完成。',
      nextPractice: `先重設場景。${restart}下次取得約 25 m 進場高度，下降時提早拉平、補油止降。`, scopeNote: scope,
    }
    if (/解除解鎖|上鎖|失焦|失去焦點|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null, observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定破S操控表現。',
      nextPractice: `${restart}確認畫面與控制器就緒，倒數後再明確解鎖。`, scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|跳躍|缺少有效|不一致|重設|invalid|non-finite|telemetry.*gap|reset|rewind/iu.test(message)) return {
      observedStrength: null, observedGap: '本次飛行資料無效、中斷或被重設，無法判定連續的破S航跡。',
      nextPractice: `${restart}保持網頁在前景，依序完成橫滾倒置、下降半迴圈與反向改出。`, scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null, observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定破S表現。',
    nextPractice: `${restart}確認畫面與控制器就緒，再明確解鎖自行起飛。`, scopeNote: scope,
  }
  const metrics = result.metrics
  let phase = Number.isInteger(metrics.splitPhase) && metrics.splitPhase >= 0 && metrics.splitPhase <= 8 ? metrics.splitPhase : null
  const valid = metrics.splitEpisodeValid > 0.5 && !(metrics.splitInterrupted > 0.5)
  if (valid && phase !== null && phase >= 3 && phase < 8) phase = !(metrics.splitInverted > 0.5) ? 3
    : !(metrics.splitDescended > 0.5) ? 4 : !(metrics.splitReversed > 0.5) ? 5 : !(metrics.splitCompleted > 0.5) ? 6 : 7
  const proof = metrics.splitCompleted > 0.5 && metrics.splitInverted > 0.5 && metrics.splitDescended > 0.5
    && metrics.splitReversed > 0.5 && metrics.splitHeightLossM >= 3 && metrics.splitReverseTravelM >= 1.5
  if (result.outcome === 'SUCCESS' && phase === 8 && result.completedCheckpoints === 8 && valid && proof) return {
    observedStrength: '本次已從地面自行起飛，依序橫滾倒置、走出下降半迴圈，反轉實際飛行方向並恢復正飛控制。', observedGap: null,
    nextPractice: '以相同條件再練一次，觀察進場高度、倒置後油門、持續後拉與提早改出的配合；不需要回原點或降落。', scopeNote: scope,
  }
  const ended = timedOut ? '本次挑戰逾時；' : ''
  if (phase === null || phase === 8) return {
    observedStrength: null, observedGap: `${ended}破S的連續分段或實際反向航跡證據不足，不能只以完成標記判定通過。`,
    nextPractice: `${restart}先取得高度與前速，再依序橫滾倒置、後拉下降及反向改出。`, scopeNote: scope,
  }
  let observation: string
  if (!valid && metrics.splitInterrupted > 0.5) observation = `先前這一段已中斷；${splitSInterruptionReason(metrics) ?? ''}舊倒置與下降標記不能代替新的一整段。`
  else if (phase <= 1) observation = '尚未從地面自行起飛並取得足夠進場高度。'
  else if (phase === 2) observation = `尚未建立有效前速${Number.isFinite(metrics.splitForwardSpeedMps) ? `，結束時沿原進場方向速度為 ${metrics.splitForwardSpeedMps.toFixed(1)} m/s` : ''}；至少需 3 m/s，再開始橫滾倒置。`
  else if (phase === 3) observation = `尚未以橫滾完成倒置${Number.isFinite(metrics.splitRollProgressDegrees) ? `，本段橫滾約 ${metrics.splitRollProgressDegrees.toFixed(1)}°` : ''}；直接前後翻不能代替。`
  else if (phase === 4) observation = `已進入倒置階段，尚未完成實際下降半迴圈${Number.isFinite(metrics.splitHeightLossM) ? `；本段下降 ${metrics.splitHeightLossM.toFixed(1)} m，至少需 3 m` : ''}。`
  else if (phase === 5) observation = `尚未反轉實際飛行方向${Number.isFinite(metrics.splitReverseTravelM) ? `；反向行程 ${metrics.splitReverseTravelM.toFixed(1)} m，至少需 1.5 m` : ''}；只轉機頭不算向來路改出。`
  else if (phase === 6) observation = '已觀察到反向飛行，尚未完成正飛改出；需沿同一後拉方向接回水平，不以再次橫滾回平代替下降半迴圈。'
  else observation = trainingObjective('split-s', { metrics })?.detail ?? '已改出，尚未完成空中恢復確認。'
  const strength = valid && metrics.splitCompleted > 0.5 && phase >= 7 ? '本次已觀察到這一段的下降半迴圈與反向正飛改出，尚待確認空中恢復。'
    : valid && metrics.splitInverted > 0.5 && metrics.splitDescended > 0.5 && phase >= 5 ? '本次已觀察到這一段的實際橫滾倒置與下降。'
      : phase >= 2 ? '本次已觀察到從地面自行起飛並取得進場高度。' : null
  return {
    observedStrength: strength, observedGap: `${ended}尚未完成「${splitSStageLabel(phase)}」。${observation}`,
    nextPractice: `${restart}${valid && phase >= 7 ? '下次接近正飛時提早回中減緩旋轉，主動拉平並調整油門止降；回中不會自動回平。' : '先留出下方空間，建立前速，橫滾至倒置後持續後拉，真正下降並向來路方向改出。'}`, scopeNote: scope,
  }
}

function powerLoopResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'power-loop') return null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const message = result.message ?? ''
  const timedOut = /逾時|timed out|timeout/iu.test(message)
  if (result.outcome !== 'SUCCESS') {
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次發生墜毀，大迴旋與空中改出尚未完成。',
      nextPractice: `先重設場景。${restart}下次保留約 ${POWER_LOOP_TARGET_HEIGHT_M} m 進場高度，下降時提早拉平並補油止降。`,
      scopeNote: scope,
    }
    if (/解除解鎖|上鎖|失焦|失去焦點|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定大迴旋操控表現。',
      nextPractice: `${restart}確認網頁與控制器就緒，倒數後再明確解鎖。`,
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|跳躍|不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效、中斷或被重設，無法判定連續的大迴旋航跡。',
      nextPractice: `${restart}保持網頁在前景，以實際飛行走完拉升、越頂、下降與改出。`,
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null,
    observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定大迴旋表現。',
    nextPractice: `${restart}確認畫面與控制器就緒，再明確解鎖自行起飛。`,
    scopeNote: scope,
  }
  const metrics = result.metrics
  const phase = Number.isInteger(metrics.loopPhase) && metrics.loopPhase >= 0 && metrics.loopPhase <= 8 ? metrics.loopPhase : null
  const valid = metrics.loopEpisodeValid > 0.5 && !(metrics.loopInterrupted > 0.5)
  const spatialProof = metrics.loopHeightGainM >= 3 && metrics.loopForwardSpanM >= 6 && metrics.loopReverseTravelM >= 1.5
    && metrics.loopCompleted > 0.5 && metrics.loopInverted > 0.5 && metrics.loopDescended > 0.5
  if (result.outcome === 'SUCCESS' && phase === 8 && result.completedCheckpoints === 8 && valid && spatialProof) return {
    observedStrength: '本次已從地面自行起飛，建立前速並完成同一圈的拉升、越頂倒置、下降、向前改出及空中恢復。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，觀察進場速度、拉升高度、倒置時油門與提早改出的配合；不需要回原點或降落。',
    scopeNote: scope,
  }
  const ended = timedOut ? '本次挑戰逾時；' : ''
  if (phase === null || phase === 8) return {
    observedStrength: null,
    observedGap: `${ended}大迴旋的連續分段或空間航跡證據不足，不能只以完成標記判定通過。`,
    nextPractice: `${restart}依提示完成前進、拉升、越頂、下降及空中改出。`,
    scopeNote: scope,
  }
  let observation: string
  if (!valid && metrics.loopInterrupted > 0.5) observation = `先前這一圈已中斷；${powerLoopInterruptionReason(metrics) ?? ''}舊的倒置或改出標記不能代替新的一圈。`
  else if (phase <= 1) observation = '尚未從地面自行起飛並取得進場高度。'
  else if (phase === 2) observation = `尚未建立有效前速${Number.isFinite(metrics.loopForwardSpeedMps) ? `，結束時為 ${metrics.loopForwardSpeedMps.toFixed(1)} m/s` : ''}；至少需 3 m/s，再開始拉升。`
  else if (phase === 3) observation = `實際拉升或前後跨度尚未足夠${Number.isFinite(metrics.loopHeightGainM) ? `；本圈拉升 ${metrics.loopHeightGainM.toFixed(1)} m` : ''}${Number.isFinite(metrics.loopForwardSpanM) ? `、前後跨度 ${metrics.loopForwardSpanM.toFixed(1)} m` : ''}。原地後翻不能代替空間迴圈。`
  else if (phase === 4) observation = `尚未完成越頂倒置與向來路方向移動${Number.isFinite(metrics.loopReverseTravelM) ? `；越頂後退行程 ${metrics.loopReverseTravelM.toFixed(1)} m，需至少 1.5 m` : ''}。`
  else if (phase === 5) observation = '已到越頂階段，尚未實際沿迴圈下降到距最高點至少 2 m。'
  else if (phase === 6) observation = '已進入下降，尚未完成同方向的一圈並向前拉平改出；反向翻回或原地回平不能代替出口。'
  else observation = trainingObjective('power-loop', { metrics })?.detail ?? '已走出出口，尚未連續完成空中恢復確認。'
  const strength = valid && phase >= 7 ? '本次已觀察到這一圈的空間迴圈與向前出口，尚待確認空中恢復。'
    : valid && phase >= 5 ? '本次已觀察到這一圈的拉升與越頂倒置。'
      : phase >= 2 ? '本次已觀察到從地面自行起飛並取得練習高度。' : null
  return {
    observedStrength: strength,
    observedGap: `${ended}尚未完成「${powerLoopStageLabel(phase)}」。${observation}`,
    nextPractice: `${restart}${valid && phase >= 7 ? '下次接近正飛時提早回中減緩旋轉，再主動拉平與調整油門；回中不會自動回平。' : '先保留高度並建立前速，沿同一後拉方向完成真正的拉升、越頂與下降，再向前改出。'}`,
    scopeNote: scope,
  }
}

function fullFlipResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  const required = fullFlipRequiredDirection(result.lessonId)
  if (result.lessonId !== 'full-flip' && required === 0) return null
  const expected = required === 1 ? '前翻' : required === -1 ? '後翻' : null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const message = result.message ?? ''
  const timedOut = /逾時|timed out|timeout/iu.test(message)
  if (result.outcome !== 'SUCCESS') {
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次發生墜毀，完整翻轉與空中恢復尚未完成。',
      nextPractice: `先重設場景。${restart}下次先取得約 ${FLIP_TARGET_HEIGHT} m 高度，配合油門保留翻轉與恢復的高度餘裕。`,
      scopeNote: scope,
    }
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定翻轉操控表現。',
      nextPractice: `${restart}確認網頁與控制器就緒，倒數完成後再明確解鎖。`,
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|位置跳躍|姿態跳躍|缺少有效|支撐高度不一致|不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效、中斷或被重設，無法以這段資料判定完整翻轉表現。',
      nextPractice: `${restart}保持網頁在前景，重新取得高度後，以實際飛行完成同方向的一圈俯仰翻轉。`,
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null,
    observedGap: `${timedOut ? '本次挑戰逾時；' : ''}本次沒有有效的已解鎖飛行樣本，無法判定翻轉表現。`,
    nextPractice: `${restart}確認畫面與控制器就緒，倒數完成後明確解鎖。`,
    scopeNote: scope,
  }
  const metrics = result.metrics
  const observedDirection = metrics.flipDirection === 1 ? '前翻' : metrics.flipDirection === -1 ? '後翻' : null
  const directionMatches = required === 0 || metrics.flipDirection === required
  const interruptedWrongDirection = required !== 0 && metrics.flipInterrupted > 0.5 && metrics.flipInterruptionReason === 8
  if (required !== 0 && (interruptedWrongDirection || observedDirection !== null && !directionMatches)) {
    const wrongTurn = interruptedWrongDirection
      ? fullFlipInterruptionReason(metrics, result.lessonId) ?? `本課練${expected}；中斷時翻轉方向不符。`
      : `本課練${expected}；本次觀察到${observedDirection}${Number.isFinite(metrics.flipProgressDegrees) ? `約 ${Math.max(0, metrics.flipProgressDegrees).toFixed(1)}°` : ''}，不能計入本課。`
    return {
      observedStrength: null,
      observedGap: `${timedOut ? '本次挑戰逾時；' : ''}${wrongTurn}`,
      nextPractice: `${restart}先回正重新準備，再以${expected}完成同一方向的一整圈及空中恢復。另一方向須在另一堂課獨立完成。`,
      scopeNote: scope,
    }
  }
  const phase = Number.isInteger(metrics.flipPhase) && metrics.flipPhase >= 0 && metrics.flipPhase <= 6 ? metrics.flipPhase : null
  if (result.outcome === 'SUCCESS' && phase === 6 && result.completedCheckpoints === 6
    && metrics.flipEpisodeValid > 0.5 && metrics.flipInverted > 0.5 && metrics.flipCompleted > 0.5 && directionMatches) return {
    observedStrength: `本次已從地面自行起飛，完成同一圈的實際倒置與${metrics.flipDirection === 1 ? '前翻' : metrics.flipDirection === -1 ? '後翻' : '俯仰翻轉'}一整圈，以及其後的空中正飛與控制恢復。`,
    observedGap: null,
    nextPractice: expected ? `以相同條件再練一次${expected}，觀察適時停止翻轉與油門配合；另一方向須在另一堂課獨立完成，不需要回到原位置或降落。` : '以相同條件再練一次，觀察適時停止翻轉與油門配合；熟悉後再練另一方向，不需要回到原位置或降落。',
    scopeNote: scope,
  }
  const validEpisode = metrics.flipEpisodeValid > 0.5
  const completedFlip = validEpisode && metrics.flipCompleted > 0.5 && directionMatches
  const strength = completedFlip ? '本次已觀察到一圈完整翻轉，尚待完成其後的空中恢復。'
    : validEpisode && metrics.flipInverted > 0.5 ? '本次已觀察到這一圈的實際倒置姿態。'
      : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛並取得練習高度。' : null
  const ended = timedOut ? '本次挑戰逾時，' : '本次'
  if (phase === null || phase === 6) return {
    observedStrength: null,
    observedGap: `${ended}完整翻轉的分段資料不足，無法判定這一圈的旋轉與恢復過程。`,
    nextPractice: `${restart}先取得高度，再依提示完成一圈俯仰翻轉及空中恢復。`,
    scopeNote: scope,
  }
  if (phase <= 1) return {
    observedStrength: null,
    observedGap: `${ended}尚未完成從地面自行起飛並取得翻轉練習高度。`,
    nextPractice: `${restart}自行起飛到至少 ${FLIP_PREP_HEIGHT} m，建議約 ${FLIP_TARGET_HEIGHT} m，再準備翻轉。`,
    scopeNote: scope,
  }
  let observation: string
  if (!validEpisode && metrics.flipInterrupted > 0.5) observation = `先前這一圈已中斷；${fullFlipInterruptionReason(metrics, result.lessonId) ?? ''}歷史倒置或回正標記不代替新一圈，尚未重新完成準備與完整翻轉。`
  else if (metrics.groundTouching > 0.5) observation = '結束時已接地；地面停住不能算空中恢復，本圈證據已中斷。'
  else if (metrics.insideFlipArea === 0) observation = `結束時超出起飛點半徑 ${FLIP_AREA_RADIUS} m 的練習區，本圈需要重新準備與完整翻轉。`
  else if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < FLIP_MIN_HEIGHT) observation = `結束時離地 ${metrics.altitudeM.toFixed(1)} m，未保留空中恢復需要的 ${FLIP_MIN_HEIGHT} m 高度，本圈已中斷。`
  else if (!validEpisode) observation = '尚未完成翻轉前的短暫準備；先取得高度並減少過大旋轉、升降與漂移。'
  else if (!completedFlip) {
    const progress = Number.isFinite(metrics.flipProgressDegrees) ? `結束時本圈翻轉進度約 ${Math.max(0, Math.min(360, metrics.flipProgressDegrees)).toFixed(1)}°，` : ''
    observation = metrics.flipInverted > 0.5
      ? `${progress}已通過本圈倒置，但尚未沿同一方向完成一圈並回正；倒置後反向翻回不等於完成。`
      : `${progress}尚未觀察到這一圈的實際倒置與完整翻轉；只推動搖桿、原地偏航或左右橫滾不能代替俯仰翻轉。`
  } else {
    const observations: string[] = []
    if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > FLIP_RECOVERY_TILT) observations.push(`結束時傾角 ${metrics.tiltDegrees.toFixed(1)}°，需修回 ${FLIP_RECOVERY_TILT}° 內`)
    if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > FLIP_MAX_RATE) observations.push(`機身仍以 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s 旋轉，需減緩到 ${FLIP_MAX_RATE}°/s 內`)
    if (Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > FLIP_MAX_HORIZONTAL) observations.push(`水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s，尚未降低到 ${FLIP_MAX_HORIZONTAL} m/s 內`)
    if (Number.isFinite(metrics.verticalSpeedMps) && (metrics.verticalSpeedMps < -FLIP_RECOVERY_DESCENT || metrics.verticalSpeedMps > FLIP_RECOVERY_CLIMB)) observations.push(`升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−），尚未回到 −${FLIP_RECOVERY_DESCENT}～+${FLIP_RECOVERY_CLIMB} m/s`)
    if (Number.isFinite(metrics.recoveryDwellSeconds) && metrics.recoveryDwellSeconds < FLIP_HOLD_SECONDS) observations.push(`恢復確認 ${Math.max(0, metrics.recoveryDwellSeconds).toFixed(2)}／${FLIP_HOLD_SECONDS.toFixed(2)} s，尚未連續完成`)
    observation = observations.length ? `${observations.slice(0, 2).join('；')}。` : '已完成本圈翻轉，尚未連續確認正飛與控制恢復。'
  }
  const action = completedFlip
    ? '下次接近正飛時提早回中減緩旋轉，再主動回平與調整油門；回中不會自動回平或煞停。'
    : `下次${expected ? `依本課要求${expected}` : '選定前翻或後翻後'}，沿同一方向連續翻轉，實際通過倒置並完成一圈後，再停止旋轉、修回正飛；先保留足夠高度。`
  return { observedStrength: strength, observedGap: `${ended}完整翻轉尚未完成。${observation}`,
    nextPractice: `${restart}${action}`, scopeNote: scope }
}

function basicRecoveryResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'basic-recovery') return null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const message = result.message ?? ''
  const timedOut = /逾時|timed out|timeout/iu.test(message)
  const version = result.attemptContext?.rulesVersion
  if (version !== 6) {
    const validSamples = Number.isFinite(result.sampleCount) && result.sampleCount > 0
    const completed = validSamples && result.outcome === 'SUCCESS'
    const cause = /墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message) ? '該次發生墜毀。'
      : /解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message) ? '該次因解除解鎖、失去焦點或連線中斷而停止。'
        : /無效|資料中斷|時間倒退|位置跳躍|重設|invalid|reset|rewind/iu.test(message) ? '該次資料無效、中斷或被重設。'
          : timedOut ? '該次挑戰逾時。' : ''
    return {
      observedStrength: completed ? version === undefined ? '這筆紀錄標記為完成，原始完成結果保留。' : `這筆紀錄依當時規則 ${version} 完成三項恢復練習，原始完成結果保留。` : null,
      observedGap: completed ? null : `${cause}${validSamples ? '這筆舊版恢復練習未完成，保留當時結果。' : '這筆紀錄沒有有效的已解鎖飛行樣本，無法判定操控表現。'}`,
      nextPractice: '可按「再練一次」依新版較寬鬆的條件練習；新版與舊版紀錄分開保存。',
      scopeNote: `${scope} ${version === undefined ? '這筆紀錄未標示規則版本' : `這是規則 ${version} 的歷史紀錄`}，沒有以新版門檻重新評分。`,
    }
  }
  if (result.outcome !== 'SUCCESS') {
    if (/墜毀|撞擊|crash|impact|Obstacle collision:/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次發生墜毀，基礎失誤恢復尚未完成。',
      nextPractice: `先按 Reset 重設。${restart}下次先取得約 ${RECOVERY_TARGET_HEIGHT} m 的練習高度，再依提示製造小偏差並修正。`,
      scopeNote: scope,
    }
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定恢復操控表現。',
      nextPractice: `${restart}確認網頁與控制器就緒，倒數結束後再明確 Arm。`,
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|位置跳躍|缺少有效|支撐高度不一致|重設|invalid|non-finite|telemetry.*gap|impossible.*jump|reset|rewind/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效、中斷或被重設，無法以這段資料判定恢復表現。',
      nextPractice: `${restart}保持網頁在前景，自行起飛後，先依提示產生實際偏差，再練習修正。`,
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null,
    observedGap: `${timedOut ? '本次挑戰逾時；' : ''}本次沒有有效的已解鎖飛行樣本，無法判定操控表現。`,
    nextPractice: `${restart}確認畫面與控制器就緒，倒數完成後明確 Arm。`,
    scopeNote: scope,
  }
  if (result.outcome === 'SUCCESS') return {
    observedStrength: '本次已從地面自行起飛，實際製造並修正傾斜、下沉與漂移，完成三項基礎失誤恢復。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，練習辨認偏差後及早修正；主動帶回水平、止住下降與降低漂移，不需回到原位置或降落。',
    scopeNote: scope,
  }
  const metrics = result.metrics
  const phase = Number.isInteger(metrics.recoveryPhase) && metrics.recoveryPhase >= 0 && metrics.recoveryPhase <= 8
    ? metrics.recoveryPhase : null
  const completed = Number.isInteger(metrics.exercisesCompleted) && metrics.exercisesCompleted >= 0 && metrics.exercisesCompleted <= 3
    ? metrics.exercisesCompleted : null
  const strength = completed !== null && completed > 0 ? `本次已完成 ${completed} / 3 項恢復練習。`
    : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛並取得練習高度。' : null
  const ended = timedOut ? '本次挑戰逾時，' : '本次'
  if (phase === null || phase === 8) return {
    observedStrength: strength,
    observedGap: `${ended}基礎失誤恢復尚未完成；分段資料不足，無法判定卡在哪項練習。`,
    nextPractice: `${restart}從地面自行起飛，依提示製造傾斜、下沉與漂移，再分別完成恢復。`,
    scopeNote: scope,
  }
  if (phase <= 1) return {
    observedStrength: null,
    observedGap: `${ended}尚未完成從地面自行起飛並取得練習高度。`,
    nextPractice: `${restart}先自行起飛到離地 ${RECOVERY_PREP_HEIGHT} m 以上，建議約 ${RECOVERY_TARGET_HEIGHT} m，再依提示開始製造小偏差。`,
    scopeNote: scope,
  }
  const exercise = phase <= 3 ? '傾斜' : phase <= 5 ? '下沉' : '漂移'
  let observation: string
  if (metrics.groundTouching > 0.5) observation = '結束時已接地；碰地停住不能算空中恢復。'
  else if (metrics.insideRecoveryArea === 0) observation = `結束時超出起飛點半徑 ${RECOVERY_AREA_RADIUS} m 的練習區，本項恢復確認已暫停。`
  else if (Number.isFinite(metrics.altitudeM) && metrics.altitudeM < RECOVERY_MIN_HEIGHT) observation = `結束時離地 ${metrics.altitudeM.toFixed(1)} m，未保留恢復需要的 ${RECOVERY_MIN_HEIGHT} m 高度餘裕。`
  else if (!(metrics.currentEpisodeValid > 0.5)) observation = metrics.episodeInterrupted > 0.5
    ? `本項先前的偏差已中斷，尚未重新完成準備並製造實際${exercise}。`
    : metrics.exerciseReady > 0.5 ? `已準備完成，但尚未偵測到本項實際${exercise}；只推動搖桿不能代替飛行狀態。`
      : '尚未完成本項的準備確認，還未開始製造小偏差。'
  else {
    const observations: string[] = []
    const tiltLimit = phase <= 3 ? RECOVERY_TILT_LEVEL : phase <= 5 ? RECOVERY_SINK_LEVEL : RECOVERY_DRIFT_LEVEL
    if (Number.isFinite(metrics.tiltDegrees) && metrics.tiltDegrees > tiltLimit) observations.push(`${phase <= 3 ? '結束時傾角' : '機身仍傾斜'} ${metrics.tiltDegrees.toFixed(1)}°，需主動修回 ${tiltLimit}° 內`)
    if (phase >= 4 && phase <= 5 && Number.isFinite(metrics.verticalSpeedMps)
      && (metrics.verticalSpeedMps < -RECOVERY_SINK_STOP || metrics.verticalSpeedMps > RECOVERY_SINK_CLIMB)) observations.push(`結束時升降速度 ${metrics.verticalSpeedMps.toFixed(1)} m/s（上＋／下−），尚未回到 −${RECOVERY_SINK_STOP}～+${RECOVERY_SINK_CLIMB} m/s 內`)
    if (phase >= 6 && Number.isFinite(metrics.horizontalSpeedMps) && metrics.horizontalSpeedMps > RECOVERY_DRIFT_STOP) observations.push(`結束時水平速度 ${metrics.horizontalSpeedMps.toFixed(1)} m/s，尚未降低到 ${RECOVERY_DRIFT_STOP.toFixed(1)} m/s 內`)
    if (Number.isFinite(metrics.bodyRateDegreesPerSecond) && metrics.bodyRateDegreesPerSecond > RECOVERY_MAX_RATE) observations.push(`機身仍以 ${metrics.bodyRateDegreesPerSecond.toFixed(1)}°/s 旋轉，需減緩到 ${RECOVERY_MAX_RATE}°/s 內`)
    if (phase >= 6 && Number.isFinite(metrics.verticalSpeedMps) && Math.abs(metrics.verticalSpeedMps) > RECOVERY_DRIFT_VERTICAL) observations.push(`升降速度仍為 ${metrics.verticalSpeedMps.toFixed(1)} m/s，需調整到 ±${RECOVERY_DRIFT_VERTICAL} m/s 內`)
    if (Number.isFinite(metrics.recoveryDwellSeconds) && metrics.recoveryDwellSeconds < RECOVERY_HOLD_SECONDS) observations.push(`恢復確認 ${Math.max(0, metrics.recoveryDwellSeconds).toFixed(2)}／${RECOVERY_HOLD_SECONDS.toFixed(2)} s，尚未連續完成`)
    observation = observations.length ? `${observations.slice(0, 2).join('；')}。` : '已記錄本項偏差，尚未連續確認恢復完成。'
  }
  const action = phase <= 3
    ? '下次先製造小幅傾斜，再朝反方向小量修正，主動帶回水平；回中會停止旋轉，回到水平需要主動修正。'
    : phase <= 5 ? '下次稍收油門，看升降速度變成負值；偵測到下沉後就補油止降，容許適度爬升，保持空中與高度餘裕。'
      : '下次先建立實際漂移，再朝移動反方向適度傾斜減速，接著主動帶回接近水平；回中不會自動煞停。'
  return {
    observedStrength: strength,
    observedGap: `${ended}尚未完成「${basicRecoveryStageLabel(phase)}」。${observation}`,
    nextPractice: `${restart}${action}每項恢復需短暫確認 ${RECOVERY_HOLD_SECONDS} 秒，不要求回到原位置或精準懸停。`,
    scopeNote: scope,
  }
}

function wideGateResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'wide-gate') return null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const message = result.message ?? ''
  const timedOut = /逾時|timed out|timeout/iu.test(message)
  if (result.outcome !== 'SUCCESS') {
    const collision = wideGateCollisionCause(message)
    if (collision) return {
      observedStrength: null,
      observedGap: `本次${collision}，造成墜毀，寬門穿越尚未完成。`,
      nextPractice: `先按 Reset 重設。${restart}下次對準門洞中心，為整架飛機與槳葉留出門框間距。`,
      scopeNote: scope,
    }
    if (/Obstacle collision:/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次撞到障礙物並墜毀；碰撞資料未指出可辨識的門框部位，無法判定碰到哪一道門。',
      nextPractice: `先按 Reset 重設。${restart}對準門洞中心並留出機身與槳葉空間。`,
      scopeNote: scope,
    }
    if (/墜毀|撞擊|crash|impact/iu.test(message)) return {
      observedStrength: null,
      observedGap: `${/ground|地面/iu.test(message) ? '本次地面撞擊造成墜毀' : '本次發生墜毀'}，寬門穿越尚未完成。`,
      nextPractice: `先按 Reset 重設。${restart}先維持足夠離地高度，再向門洞前進。`,
      scopeNote: scope,
    }
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定寬門穿越的操控表現。',
      nextPractice: `${restart}確認網頁與控制器就緒，倒數結束後再明確 Arm。`,
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|位置跳躍|模擬被重設|缺少有效|支撐高度不一致|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效或中斷，無法以這段資料判定寬門穿越表現。',
      nextPractice: `${restart}保持網頁在前景，從地面自行起飛後依序向前穿過三道門洞。`,
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null,
    observedGap: `${timedOut ? '本次挑戰逾時；' : ''}本次沒有有效的已解鎖飛行樣本，無法判定操控表現。`,
    nextPractice: `${restart}確認畫面與控制器就緒，倒數完成後明確 Arm。`,
    scopeNote: scope,
  }
  if (result.outcome === 'SUCCESS') return {
    observedStrength: '本次已從地面自行起飛，依序向前穿過三道寬門的門洞，且未碰到實體門框。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，練習連貫地對準門洞並為機身、槳葉保留間距；穿過第三道門即可，不需降落或停穩。',
    scopeNote: scope,
  }
  const metrics = result.metrics
  const phase = Number.isInteger(metrics.gatePhase) && metrics.gatePhase >= 0 && metrics.gatePhase <= 5
    ? metrics.gatePhase : null
  const passed = Number.isInteger(metrics.gatesPassed) && metrics.gatesPassed >= 0 && metrics.gatesPassed <= 3
    ? metrics.gatesPassed : null
  const index = Number.isInteger(metrics.gateTargetIndex) && metrics.gateTargetIndex >= 0 && metrics.gateTargetIndex < 3
    ? metrics.gateTargetIndex : phase !== null && phase >= 2 && phase <= 4 ? phase - 2 : null
  const strength = passed !== null && passed > 0 ? `本次已依序向前穿過 ${passed} / 3 道寬門。`
    : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛。' : null
  const ended = timedOut ? '本次挑戰逾時，' : '本次'
  if (phase !== null && phase <= 1) return {
    observedStrength: strength,
    observedGap: `${ended}尚未完成從地面自行起飛。`,
    nextPractice: `${restart}自行加油門離地，再對準約高 3 m 的第一道門洞中心；不需要先懸停。`,
    scopeNote: scope,
  }
  if (index !== null) {
    let cause = ''
    if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) {
      cause = '結束時尚未在空中，剩餘寬門尚未通過。'
    } else {
      const distance = metrics.nextGateDistanceM
      if (Number.isFinite(distance)) cause = distance < 0
        ? `結束時已在該門後方 ${Math.abs(distance).toFixed(1)} m，但尚未記錄有效的正向門洞穿越。`
        : `結束時仍在該門前 ${distance.toFixed(1)} m，尚未完成正向穿越。`
      const horizontal = metrics.nextGateHorizontalErrorM
      const vertical = metrics.nextGateVerticalErrorM
      if (Number.isFinite(horizontal) && Math.abs(horizontal) > 2) {
        cause += `結束時在門洞${horizontal > 0 ? '右' : '左'}側外，偏離中心 ${Math.abs(horizontal).toFixed(1)} m。`
      }
      if (Number.isFinite(vertical) && Math.abs(vertical) > 2) {
        cause += `結束時在門洞${vertical > 0 ? '上' : '下'}方外，偏離中心 ${Math.abs(vertical).toFixed(1)} m。`
      }
    }
    return {
      observedStrength: strength,
      observedGap: `${ended}尚未穿過第 ${index + 1} 道寬門${passed !== null ? `，尚餘 ${3 - passed} 道門` : ''}。${cause}`,
      nextPractice: `${restart}下次先在門前對準門洞中心，再向前穿過；漏門時回到該門前補飛，反向穿越不算。門洞寬、高各 4 m，仍需為機身與槳葉留出門框間距；不要求精準速度、朝向、停留或降落。`,
      scopeNote: scope,
    }
  }
  return {
    observedStrength: strength,
    observedGap: `${ended}寬門穿越尚未完成；分段資料不足，無法判定卡在哪一道門。`,
    nextPractice: `${restart}依亮起目標，從門洞中心附近依序向前穿過三道門。`,
    scopeNote: scope,
  }
}

function figureEightResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'figure-eight') return null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const timedOut = /逾時|timed out|timeout/iu.test(result.message ?? '')
  if (result.outcome !== 'SUCCESS') {
    const message = result.message ?? ''
    if (/墜毀|撞擊|crash|impact/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次發生墜毀，左右八字航線尚未完成。',
      nextPractice: `${restart}先按 Reset 重設，以小量傾斜與轉向沿目標飛行，留意高度。`,
      scopeNote: scope,
    }
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定八字航線的操控表現。',
      nextPractice: `${restart}確認網頁與控制器就緒，倒數結束後再明確 Arm。`,
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|位置跳躍|模擬被重設|缺少有效|支撐高度不一致|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效或中斷，無法以這段資料判定八字航線表現。',
      nextPractice: `${restart}保持網頁在前景，依序完成左環、中央換向與右環。`,
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null,
    observedGap: `${timedOut ? '本次挑戰逾時；' : ''}本次沒有有效的已解鎖飛行樣本，無法判定操控表現。`,
    nextPractice: `${restart}確認畫面與控制器就緒，倒數完成後明確 Arm。`,
    scopeNote: scope,
  }
  if (result.outcome === 'SUCCESS') return {
    observedStrength: '本次已依序完成左環、中央換向與右環的九個目標，並回到中央空中終點。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，讓左轉、中央換向與右轉更連貫；最後飛入中央空中終點即可，不需降落或停穩。',
    scopeNote: scope,
  }
  const metrics = result.metrics
  const phase = Number.isInteger(metrics.eightPhase) && metrics.eightPhase >= 0 && metrics.eightPhase <= 11
    ? metrics.eightPhase : null
  const passed = Number.isInteger(metrics.eightTargetsCompleted) && metrics.eightTargetsCompleted >= 0 && metrics.eightTargetsCompleted <= 9
    ? metrics.eightTargetsCompleted : null
  const loops = Number.isInteger(metrics.eightLoopsCompleted) && metrics.eightLoopsCompleted >= 0 && metrics.eightLoopsCompleted <= 2
    ? metrics.eightLoopsCompleted : passed !== null ? passed >= 9 ? 2 : passed >= 5 ? 1 : 0 : null
  const index = Number.isInteger(metrics.eightTargetIndex) && metrics.eightTargetIndex >= 0 && metrics.eightTargetIndex < 9
    ? metrics.eightTargetIndex : phase !== null && phase >= 2 && phase <= 10 ? phase - 2 : null
  const strength = passed !== null && passed > 0
    ? `本次已依序完成 ${passed} / 9 個八字目標${loops !== null && loops > 0 ? `，完成 ${loops} / 2 環${loops === 1 ? '（左環已完成）' : ''}` : ''}。`
    : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛。' : null
  const ended = timedOut ? '本次挑戰逾時，' : '本次'
  if (phase !== null && phase <= 1) return {
    observedStrength: strength,
    observedGap: `${ended}尚未完成從地面自行起飛。`,
    nextPractice: `${restart}自行加油門離地，再前往前方中央入口；不需要先懸停。`,
    scopeNote: scope,
  }
  if (index !== null) {
    let cause = ''
    if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) {
      cause = '結束時尚未在空中，剩餘空中目標未完成。'
    } else if (Number.isFinite(metrics.headingErrorDegrees) && metrics.headingErrorDegrees > 70) {
      cause = `結束時機頭偏離箭頭方向 ${metrics.headingErrorDegrees.toFixed(0)}°，需在 70° 內。`
    } else if (Number.isFinite(metrics.targetDistanceM)) {
      cause = `結束時距該目標 ${metrics.targetDistanceM.toFixed(1)} m。`
    }
    const practice = Number.isFinite(metrics.headingErrorDegrees) && metrics.headingErrorDegrees > 70
      ? '下次接近該目標時，用小量偏航配合傾斜，讓機頭大致跟隨航線箭頭。'
      : index === 4 ? '下次回到中央後，看向右環的下一個目標，把左轉切換成右轉；不需要原地停留。'
        : index === 8 ? '最後飛入前方中央的空中終點即可；位置是起飛點前方 6 m，不是原起飛點，不需降落或停穩。'
          : index === 0 ? '先前往前方中央入口，再沿左環目標依序飛行；不能直接取得同位置的終點。'
            : `下次沿${index < 4 ? '左' : '右'}環，以小量 Roll 傾斜配合 Yaw 轉頭，讓實際航線依序通過目標。`
    return {
      observedStrength: strength,
      observedGap: `${ended}尚未完成「${figureEightTargetLabel(index)}」${passed !== null ? `，尚餘 ${9 - passed} 個八字目標` : ''}。${cause}`,
      nextPractice: `${restart}${practice}`,
      scopeNote: scope,
    }
  }
  return {
    observedStrength: null,
    observedGap: `${ended}八字航線尚未完成；分段資料不足，無法判定卡在哪個目標。`,
    nextPractice: `${restart}依亮起目標完成左環、中央換向與右環，最後飛入中央空中終點；不要求降落或停穩。`,
    scopeNote: scope,
  }
}

function squareRouteResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'square-route') return null
  if (result.outcome !== 'SUCCESS') {
    const message = result.message ?? ''
    if (/墜毀|撞擊|crash|impact/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次發生墜毀，方形航線尚未完成。',
      nextPractice: '先按 Reset 重設，再從地面自行起飛；以小量操作沿目前目標前進，轉彎時留意高度。',
      scopeNote: scope,
    }
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定方形航線的操控表現。',
      nextPractice: '確認網頁與控制器就緒，重試課程；倒數結束後再明確 Arm。',
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|位置跳躍|模擬被重設|缺少有效|支撐高度不一致|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效或中斷，無法以這段資料判定方形航線表現。',
      nextPractice: '重設課程，保持網頁在前景，從地面重新起飛後依序完成四段航線。',
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return null
  if (result.outcome === 'SUCCESS') return {
    observedStrength: '本次已依序完成四段方形航線與八個目標，並回到起點上方。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，練習連貫地串接直線與轉彎；飛入最後目標即可完成，不需降落或停穩。',
    scopeNote: scope,
  }
  const metrics = result.metrics
  const phase = Number.isInteger(metrics.squarePhase) && metrics.squarePhase >= 0 && metrics.squarePhase <= 10
    ? metrics.squarePhase : null
  const passed = Number.isInteger(metrics.squareTargetsCompleted) && metrics.squareTargetsCompleted >= 0 && metrics.squareTargetsCompleted <= 8
    ? metrics.squareTargetsCompleted : null
  const legs = Number.isInteger(metrics.squareLegsCompleted) && metrics.squareLegsCompleted >= 0 && metrics.squareLegsCompleted <= 4
    ? metrics.squareLegsCompleted : passed !== null ? Math.floor(passed / 2) : null
  const index = Number.isInteger(metrics.squareTargetIndex) && metrics.squareTargetIndex >= 0 && metrics.squareTargetIndex < 8
    ? metrics.squareTargetIndex : phase !== null && phase >= 2 && phase <= 9 ? phase - 2 : null
  const strength = passed !== null && passed > 0
    ? `本次已依序完成 ${passed} / 8 個方形目標${legs !== null && legs > 0 ? `，完成 ${legs} / 4 段航線` : ''}。`
    : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛。' : null
  const restart = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'
  const timedOut = /逾時|timed out|timeout/iu.test(result.message ?? '')
  if (phase !== null && phase <= 1) return {
    observedStrength: strength,
    observedGap: `${timedOut ? '本次挑戰逾時；' : ''}本次尚未完成從地面自行起飛。`,
    nextPractice: `${restart}自行加油門離地，再前往前方亮起的第一段目標；不需要先懸停。`,
    scopeNote: scope,
  }
  if (index !== null) {
    let cause = ''
    if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) {
      cause = '結束時尚未在空中，剩餘空中目標未完成。'
    } else if (Number.isFinite(metrics.headingErrorDegrees) && metrics.headingErrorDegrees > 70) {
      cause = `結束時機頭偏離箭頭方向 ${metrics.headingErrorDegrees.toFixed(0)}°，需在 70° 內；先小量偏航，讓機頭大致跟隨目前航段。`
    } else if (Number.isFinite(metrics.targetDistanceM)) {
      cause = `結束時距該目標 ${metrics.targetDistanceM.toFixed(1)} m。`
    }
    return {
      observedStrength: strength,
      observedGap: `${timedOut ? '本次挑戰逾時；' : ''}本次尚未完成「${squareRouteTargetLabel(index)}」${passed !== null ? `，尚餘 ${8 - passed} 個方形目標` : ''}。${cause}`,
      nextPractice: `${restart}下次接近「${squareRouteTargetLabel(index)}」時，${Number.isFinite(metrics.headingErrorDegrees) && metrics.headingErrorDegrees > 70
        ? '用小量偏航配合傾斜，讓機頭大致跟隨航線箭頭。'
        : index === 7 ? '飛入起點上方的空中終點即可，不需降落或停穩。'
          : index % 2 === 1 ? '提早看向下一邊，小量配合傾斜、轉向與油門完成轉彎。'
            : '小量維持前進與高度，先飛入直線目標，再接下一個轉角。'}`,
      scopeNote: scope,
    }
  }
  return {
    observedStrength: null,
    observedGap: '本次方形航線尚未完成；分段資料不足，無法判定卡在哪個目標。',
    nextPractice: '重試課程，依亮起目標完成四段直線與轉彎，最後飛回起點上方；不要求降落或停穩。',
    scopeNote: scope,
  }
}

function coordinatedTurnResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'coordinated-turn' || result.attemptContext === undefined || result.attemptContext.rulesVersion < 5) return null
  if (result.outcome !== 'SUCCESS') {
    const message = result.message ?? ''
    if (/墜毀|撞擊|crash|impact/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次發生墜毀，左右轉彎航線尚未完成。',
      nextPractice: '先按 Reset 重設，再從地面自行起飛；用小量傾斜與偏航帶動轉彎，接近地面時提早修正高度。',
      scopeNote: scope,
    }
    if (/解除解鎖|失焦|斷線|disarm|focus|disconnect/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次因解除解鎖、失去焦點或連線中斷而停止，不能據此判定轉彎技巧。',
      nextPractice: '確認網頁與控制器就緒，重試課程；倒數結束後再明確 Arm。',
      scopeNote: scope,
    }
    if (/無效|資料中斷|時間倒退|位置跳躍|缺少有效|支撐高度不一致|invalid|non-finite|telemetry.*gap|impossible.*jump/iu.test(message)) return {
      observedStrength: null,
      observedGap: '本次飛行資料無效或中斷，無法以這段資料判定轉彎表現。',
      nextPractice: '重設課程，保持網頁在前景，從地面重新起飛後依序完成左右轉目標。',
      scopeNote: scope,
    }
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return null
  if (result.outcome === 'SUCCESS') return {
    observedStrength: '本次已依序完成右轉與左轉的入口、轉彎點及出口，並觀察到實際航線朝兩側轉向。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，練習小量 Roll 傾斜、Yaw 跟隨路線與油門修正高度，逐步讓轉彎連貫。',
    scopeNote: scope,
  }
  const metrics = result.metrics
  const phase = Number.isInteger(metrics.turnPhase) && metrics.turnPhase >= 0 && metrics.turnPhase <= 8
    ? metrics.turnPhase : null
  const passed = Number.isInteger(metrics.turnTargetsCompleted) && metrics.turnTargetsCompleted >= 0 && metrics.turnTargetsCompleted <= 6
    ? metrics.turnTargetsCompleted : null
  const index = Number.isInteger(metrics.turnTargetIndex) && metrics.turnTargetIndex >= 0 && metrics.turnTargetIndex < 6
    ? metrics.turnTargetIndex : phase !== null && phase >= 2 && phase <= 7 ? phase - 2 : null
  const strength = passed !== null && passed > 0
    ? `本次已依序完成 ${passed} / 6 個轉彎目標${passed >= 3 ? '，其中右轉航線已完成' : ''}。`
    : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛。' : null
  if (phase !== null && phase <= 1) return {
    observedStrength: strength,
    observedGap: '本次尚未完成從地面自行起飛。',
    nextPractice: '從起飛區自行加油門離地，再前往前方亮起的右轉入口，不需要先懸停。',
    scopeNote: scope,
  }
  if (index !== null) {
    const direction = index < 3 ? '右' : '左'
    let cause = ''
    if (metrics.groundTouching > 0.5 || (Number.isFinite(metrics.groundClearanceM) && metrics.groundClearanceM < 0.15)) {
      cause = '結束時尚未在空中；可在目前位置再次起飛，已完成目標會保留。'
    } else if (Number.isFinite(metrics.headingErrorDegrees) && metrics.headingErrorDegrees > 70) {
      cause = `結束時機頭偏離箭頭方向 ${metrics.headingErrorDegrees.toFixed(0)}°，需在 70° 內。`
    } else if (index % 3 > 0 && metrics.turnEntryRecorded === 0) {
      cause = '尚缺本彎入口的實際移動方向紀錄。'
    } else if (metrics.turnMotionReady === 0 && (index % 3 === 0 || index % 3 === 2)) {
      cause = '尚未觀察到本步的實際移動方向；原地轉頭不能完成航線。'
    } else if (index % 3 === 2 && Number.isFinite(metrics.turnChangeDegrees) && metrics.turnChangeDegrees < 25) {
      cause = metrics.turnChangeDegrees < 0
        ? `實際航線朝相反方向轉了 ${Math.abs(metrics.turnChangeDegrees).toFixed(0)}°；本彎需朝${direction}轉至少 25°。`
        : `實際航線已朝${direction}轉 ${metrics.turnChangeDegrees.toFixed(0)}°，尚未達到本彎至少 25° 的目標。`
    } else if (Number.isFinite(metrics.targetDistanceM)) {
      cause = `結束時距該目標 ${metrics.targetDistanceM.toFixed(1)} m。`
    }
    return {
      observedStrength: strength,
      observedGap: `本次尚未完成「${coordinatedTurnTargetLabel(index)}」${passed !== null ? `，尚餘 ${6 - passed} 個轉彎目標` : ''}。${cause}`,
      nextPractice: trainingObjective('coordinated-turn', { metrics: { ...metrics, turnPhase: phase ?? index + 2, turnTargetIndex: index } })!.detail,
      scopeNote: scope,
    }
  }
  return {
    observedStrength: null,
    observedGap: '本次左右轉彎尚未完成；分段資料不足，無法判定卡在哪個目標。',
    nextPractice: '重試課程，依亮起目標完成右轉與左轉的入口、轉彎點及出口；讓實際航線轉向，不只轉動機頭。',
    scopeNote: scope,
  }
}

function scopeNote(result: TrainingResult): string {
  if (!result.attemptContext) return '本次缺少操控條件紀錄，不與新版條件成績直接比較。'
  const mode = result.attemptContext.mode === 'practice'
    ? '引導練習與能力挑戰分開保存；完成一次目標不代表已熟練。'
    : '能力挑戰只比較相同條件的紀錄；完成一次挑戰不代表已熟練。'
  return isLegacyRouteResult(result)
    ? `本次為舊規則 ${result.attemptContext.rulesVersion} 的紀錄，保留當時條件說明。${mode}`
    : mode
}

function directionControlResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'direction-control') return null
  if (result.outcome !== 'SUCCESS' && /墜毀|撞擊|crash|impact/iu.test(result.message ?? '')) return {
    observedStrength: null,
    observedGap: '本次發生墜毀，方向練習尚未完成。',
    nextPractice: '先按 Reset 重設，再自行起飛；用小量操作前往目前亮起的目標，接近地面時提早控制下降。',
    scopeNote: scope,
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return null
  if (result.outcome === 'SUCCESS') return {
    observedStrength: '本次已完成左右、前後移動、實際偏航換向，以及新朝向下的移動目標。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，先辨認目標位於目前機頭的哪一側，再小量操作移動。',
    scopeNote: scope,
  }

  const metrics = result.metrics
  const phase = Number.isInteger(metrics.directionPhase) && metrics.directionPhase >= 0 && metrics.directionPhase <= 9
    ? metrics.directionPhase : null
  const passed = Number.isInteger(metrics.directionTargetsCompleted) && metrics.directionTargetsCompleted >= 0 && metrics.directionTargetsCompleted <= 7
    ? metrics.directionTargetsCompleted : null
  const index = Number.isInteger(metrics.directionTargetIndex) && metrics.directionTargetIndex >= 0 && metrics.directionTargetIndex < 7
    ? metrics.directionTargetIndex : phase !== null && phase >= 2 && phase <= 8 ? phase - 2 : null
  const strength = passed !== null && passed > 0
    ? `本次已依序完成 ${passed} / 7 個方向目標。`
    : phase !== null && phase >= 2 ? '本次已觀察到從地面自行起飛。'
      : null
  if (phase !== null && phase <= 1) return {
    observedStrength: strength,
    observedGap: '本次尚未完成從地面自行起飛。',
    nextPractice: '從起飛區自行加油門離地，再前往右側亮起的目標；不需要先懸停。',
    scopeNote: scope,
  }
  if (index === 4) {
    const change = metrics.headingChangeDegrees
    const error = metrics.headingErrorDegrees
    const observed = [
      Number.isFinite(change) ? `已轉 ${change.toFixed(0)}°` : null,
      Number.isFinite(error) ? `距新朝向 ${error.toFixed(0)}°` : null,
    ].filter(Boolean).join('、')
    return {
      observedStrength: strength,
      observedGap: `本次尚未完成實際偏航換向${observed ? `；結束時${observed}` : ''}。`,
      nextPractice: '靠近換向目標區，用 Yaw 向右轉動機頭約 90°，看到下一目標亮起後，再依新機頭方向移動；單純側移不能代替換向。',
      scopeNote: scope,
    }
  }
  if (index !== null) return {
    observedStrength: strength,
    observedGap: `本次尚未完成「${directionControlTargetLabel(index)}」目標。${Number.isFinite(metrics.targetDistanceM) ? `結束時距該目標 ${metrics.targetDistanceM.toFixed(1)} m。` : ''}`,
    nextPractice: `${index >= 5 ? '以換向後的新機頭方向為準' : '機頭大致保持原朝向'}，小量操作進入目前亮起的目標區；偏離時可繼續補飛，不需重做已完成的目標。`,
    scopeNote: scope,
  }
  return {
    observedStrength: null,
    observedGap: '本次方向練習尚未完成；分段資料不足，無法判定卡在哪個目標。',
    nextPractice: '重試課程，確認目前亮起的目標與機頭方向，再依序完成移動及換向。',
    scopeNote: scope,
  }
}

function relaxedRouteFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (isLegacyRouteResult(result) || !['straight-line', 'landing'].includes(result.lessonId)) return null
  const metrics = result.metrics
  // Runtime integrity failures can stop before the evaluator emits phase
  // metrics. The explicit crash cause still takes priority over missing data.
  if (result.outcome !== 'SUCCESS' && /墜毀|撞擊|crash|impact/iu.test(result.message ?? '')) return {
    observedStrength: null,
    observedGap: '本次發生墜毀，尚未完成本課目標。',
    nextPractice: '先按 Reset 重設，再自行起飛重試；接近地面時提早減少下降速度並保持近水平。',
    scopeNote: scope,
  }
  if (result.lessonId === 'straight-line') {
    if (result.outcome === 'SUCCESS') return {
      observedStrength: '本次已依序穿過藍色、金色與綠色三個圓環。',
      observedGap: null,
      nextPractice: '以相同條件再練一次，練習對準三個圓環；接著再逐步練習控制速度。',
      scopeNote: scope,
    }
    const phase = Number.isFinite(metrics.routePhase) ? metrics.routePhase : 0
    const passed = Number.isFinite(metrics.gatesPassed)
      ? Math.max(0, Math.min(3, Math.floor(metrics.gatesPassed)))
      : Math.max(0, Math.min(3, Math.floor(phase - 1)))
    const color = passed === 0 ? '藍色' : passed === 1 ? '金色' : '綠色'
    return {
      observedStrength: passed > 0 ? `本次已依序穿過 ${passed} / 3 個圓環。` : null,
      observedGap: phase === 0
        ? '本次尚未完成從地面自行起飛。'
        : `本次尚未穿過第 ${Math.min(3, passed + 1)} 個${color}圓環，三圈尚未全部完成。`,
      nextPractice: phase === 0
        ? '自行加油門起飛，直接朝前方藍色圈飛行，不需要先懸停。'
        : `對準${color}圈，從圈內向前穿過；若漏圈，可退回該圈前再穿一次，已完成的圈會保留。`,
      scopeNote: scope,
    }
  }
  if (result.outcome === 'SUCCESS') return {
    observedStrength: '本次已從地面起飛，並在指定降落區內接地且沒有墜毀。',
    observedGap: null,
    nextPractice: '以相同條件再練一次，練習朝藍色降落區對準並控制下降，完成後再 Disarm。',
    scopeNote: scope,
  }
  const airborne = Number.isFinite(metrics.landingPhase) && metrics.landingPhase >= 2
  const distance = metrics.landingPositionErrorM
  const wrongZone = airborne && metrics.groundTouching === 1
    && Number.isFinite(distance) && distance > LANDING_ZONE_RADIUS_M
  return {
    observedStrength: airborne ? '本次已觀察到從起飛區實際離地。' : null,
    observedGap: !airborne ? '本次尚未完成從起飛墊實際離地的步驟。'
      : wrongZone ? `落地位置距指定區中心 ${distance.toFixed(2)} m；需在半徑 ${LANDING_ZONE_RADIUS_M.toFixed(2)} m 內接地。`
        : '本次尚未在指定降落區內完成沒有墜毀的實際接地。',
    nextPractice: !airborne
      ? `先在起飛墊上方緩慢起飛，離地至少 ${LANDING_LIFTOFF_HEIGHT_M} m，再前往藍色降落區。`
      : '朝藍色光柱與地面標記對準，在指定區內接地且沒有墜毀即可；落在區外可直接再起飛重試。',
    scopeNote: scope,
  }
}

function phaseProgress(result: TrainingResult): { observedGap: string; nextPractice: string } | null {
  if (result.outcome === 'SUCCESS') return null
  const metrics = result.metrics
  if (result.lessonId === 'straight-line' && Number.isFinite(metrics.routePhase)) {
    if (metrics.routePhase === 0) return {
      observedGap: '本次尚未完成地面起飛並穩定到達起點高度。',
      nextPractice: '先留在起飛墊上方，緩慢升至起點高度環，穩住後再前進。',
    }
    if (metrics.routePhase === 1) return {
      observedGap: '本次尚未完成前往藍色中途目標的步驟。',
      nextPractice: '保持高度沿直線前進到藍色中途環，之後再進入金色減速區。',
    }
    if (metrics.routePhase === 2) return {
      observedGap: '本次尚未在金色減速區完成實際降速；穿過圓環不等於完成。',
      nextPractice: '進入金色減速區後小幅反向修正，觀察前進速度確實降低，再接近綠色停點。',
    }
  }
  if (result.lessonId === 'landing' && Number.isFinite(metrics.landingPhase)) {
    if (metrics.landingPhase <= 1) return {
      observedGap: '本次尚未完成從起飛墊離地的步驟。',
      nextPractice: `先在起飛墊上方緩慢起飛，離地至少 0.8 m，再前往藍色降落區。`,
    }
    if (metrics.landingPhase === 2) return {
      observedGap: '本次尚未完成從空中對準藍色降落區進場。',
      nextPractice: '先保持高度飛向藍色光柱與地面標記，到達區域上方後減少側移，再開始下降。',
    }
  }
  return null
}

/** Final-sample observations and checkpoint facts, never inferred causes or a claim about the whole flight. */
export function summarizeTrainingResult(result: TrainingResult): TrainingResultFeedback {
  const scope = scopeNote(result)
  const backward = backwardFlightResultFeedback(result, scope)
  if (backward) return backward
  const orbit = orbitResultFeedback(result, scope)
  if (orbit) return orbit
  const split = splitSResultFeedback(result, scope)
  if (split) return split
  const loop = powerLoopResultFeedback(result, scope)
  if (loop) return loop
  const flip = fullFlipResultFeedback(result, scope)
  if (flip) return flip
  const roll = fullRollResultFeedback(result, scope)
  if (roll) return roll
  const recovery = basicRecoveryResultFeedback(result, scope)
  if (recovery) return recovery
  const gate = wideGateResultFeedback(result, scope)
  if (gate) return gate
  const eight = figureEightResultFeedback(result, scope)
  if (eight) return eight
  const square = squareRouteResultFeedback(result, scope)
  if (square) return square
  const turn = coordinatedTurnResultFeedback(result, scope)
  if (turn) return turn
  const direction = directionControlResultFeedback(result, scope)
  if (direction) return direction
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) {
    return {
      observedStrength: null,
      observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定操控表現。',
      nextPractice: '確認畫面與控制器就緒，倒數完成後明確 Arm，再開始飛行。',
      scopeNote: scope,
    }
  }

  const relaxed = relaxedRouteFeedback(result, scope)
  if (relaxed) return relaxed

  const phase = phaseProgress(result)
  const known = (phase ? [] : GOALS[result.lessonId] ?? []).flatMap((goal) => {
    if (goal.key === 'touchdownDescentSpeedMps' && result.metrics.groundTouching !== 1) return []
    const value = result.metrics[goal.key]
    if (!Number.isFinite(value) || value < 0) return []
    const deviation = goal.minimum ? (goal.target - value) / goal.target : (value - goal.target) / goal.target
    return [{ goal, value, deviation }]
  })
  const strongest = known.filter((item) => item.deviation <= 1e-9)
    .sort((left, right) => left.deviation - right.deviation)[0]
  const gap = known.filter((item) => item.deviation > 1e-9)
    .sort((left, right) => right.deviation - left.deviation)[0]
  const total = Number.isFinite(result.totalCheckpoints) ? Math.max(0, Math.floor(result.totalCheckpoints)) : 0
  const completed = Number.isFinite(result.completedCheckpoints) ? Math.max(0, Math.min(total, Math.floor(result.completedCheckpoints))) : 0
  const observedStrength = strongest
    ? `${strongest.goal.minimum ? '已觀察到' : '結束時'}${strongest.goal.label} ${amount(strongest.value, strongest.goal.unit)}，此項達到本課目標。`
    : completed > 0 ? `本次已完成 ${completed} / ${total} 個步驟。` : null
  const observedGap = phase?.observedGap ?? (gap
    ? `${gap.goal.minimum ? '已累積的' : '結束時'}${gap.goal.label}為 ${amount(gap.value, gap.goal.unit)}；本課目標為${gap.goal.minimum ? '連續至少' : '不超過'} ${amount(gap.goal.target, gap.goal.unit)}。`
    : total > completed ? `本次尚有 ${total - completed} 個步驟未完成。`
      : result.outcome === 'FAILED' ? '本次未通關；現有項目資料不足以判定操控原因。' : null)
  const nextPractice = phase?.nextPractice ?? gap?.goal.tip ?? (result.outcome === 'SUCCESS'
    ? '以相同條件再練一次，觀察能否持續完成相同步驟。'
    : trainingHint(result.lessonId, { status: 'failure', hint: result.hint ?? undefined }))
  return { observedStrength, observedGap, nextPractice, scopeNote: scope }
}
