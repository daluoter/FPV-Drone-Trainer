import type { TrainingObjective } from './feedback'
import type { TrainingResultFeedback } from './resultFeedback'
import type { TrainingEvaluation, TrainingResult } from './types'
import {
  BACKWARD_FLIGHT_AREA_RADIUS_M, BACKWARD_FLIGHT_MIN_ENTRY_HEIGHT_M, BACKWARD_FLIGHT_MAX_ENTRY_HEIGHT_M,
  BACKWARD_FLIGHT_MIN_HEIGHT_M, BACKWARD_FLIGHT_MAX_HEADING_ERROR_DEGREES,
  BACKWARD_FLIGHT_MIN_RETAINED_SPEED_MPS, BACKWARD_FLIGHT_MIN_SPEED_MPS,
  BACKWARD_FLIGHT_REQUIRED_DISTANCE_M, BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS, BACKWARD_FLIGHT_RECOVERY_SECONDS,
  BACKWARD_FLIGHT_TIME_LIMIT_SECONDS,
} from './backwardFlight'

type Metrics = Readonly<Record<string, number>>
const RESTART = '按「再練一次」，從地面重新開始本次練習。'

function observed(metrics: Metrics, key: string, unit: string, digits = 1): string {
  return Number.isFinite(metrics[key]) ? `${metrics[key].toFixed(digits)} ${unit}` : '尚無有效量測'
}

function hasBackwardProof(metrics: Metrics): boolean {
  return metrics.backwardEpisodeValid > 0.5 && !(metrics.backwardInterrupted > 0.5)
    && metrics.backwardForwardEstablished > 0.5 && metrics.backwardTurned > 0.5 && metrics.backwardMoving > 0.5
    && metrics.backwardMaintained > 0.5 && metrics.backwardDistanceM + 1e-8 >= BACKWARD_FLIGHT_REQUIRED_DISTANCE_M
    && metrics.backwardHoldSeconds + 1e-8 >= BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS
}

function hasCompleteProof(metrics: Metrics): boolean {
  return hasBackwardProof(metrics) && metrics.backwardPhase === 7
    && metrics.backwardRecoveryQualifying > 0.5 && metrics.backwardRecoveryDwellSeconds + 1e-8 >= BACKWARD_FLIGHT_RECOVERY_SECONDS
}

export function backwardFlightRouteGuide(): string {
  return `地面自行起飛至約 10 m → 沿寬走廊建立前速 → 用偏航向左或右轉頭約 180°，保持機腹朝地 → 保留原本移動方向，機頭朝來向、機尾朝去向，實際後退至少 ${BACKWARD_FLIGHT_REQUIRED_DISTANCE_M} m 並持續 ${BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS} 秒 → 平穩減速或轉回朝向移動方向，再恢復控制。初版允許轉頭與路線偏差，動作高度 ${BACKWARD_FLIGHT_MIN_ENTRY_HEIGHT_M}～${BACKWARD_FLIGHT_MAX_ENTRY_HEIGHT_M} m、起飛點半徑 ${BACKWARD_FLIGHT_AREA_RADIUS_M} m 內，不要求窄門、精準停點或降落。偏航只改變機頭朝向，不會立即反轉速度；原地轉頭、先停住再向前飛、機腹朝天或只有短暫速度雜訊都不算後退飛行。中斷後保留已完成步驟，本段需重新前飛、轉頭與後退。引導練習不限時，挑戰 ${BACKWARD_FLIGHT_TIME_LIMIT_SECONDS} 秒。`
}

export function backwardFlightInterruptionReason(metrics: Metrics): string | null {
  if (!(metrics.backwardInterrupted > 0.5)) return null
  switch (metrics.backwardInterruptionReason) {
    case 1: return '本段因接地中斷；接地不會完成空中後退。'
    case 2: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，低於 ${BACKWARD_FLIGHT_MIN_HEIGHT_M} m；先升高保留改出空間。`
    case 3: return `中斷時距起飛點 ${observed(metrics, 'interruptionLaunchDistanceM', 'm')}，已離開 ${BACKWARD_FLIGHT_AREA_RADIUS_M} m 練習區。`
    case 4: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，動作需在 ${BACKWARD_FLIGHT_MIN_ENTRY_HEIGHT_M}～${BACKWARD_FLIGHT_MAX_ENTRY_HEIGHT_M} m；先調整高度。`
    case 5: return `中斷時傾角 ${observed(metrics, 'interruptionTiltDegrees', '°')}，超過 70°；先修回機腹朝地，避免倒置。`
    case 6: return `中斷時沿原方向速度 ${observed(metrics, 'interruptionBackwardForwardSpeedMps', 'm/s')}，低於 ${BACKWARD_FLIGHT_MIN_RETAINED_SPEED_MPS} m/s 太久，已失去前飛動量；先重新前飛再轉頭。`
    case 7: return `中斷時機頭偏離反向 ${observed(metrics, 'interruptionBackwardHeadingErrorDegrees', '°')}，需在 ${BACKWARD_FLIGHT_MAX_HEADING_ERROR_DEGREES}° 內；先重新前飛，再轉頭朝向來路。`
    case 8: return `中斷時後退速度 ${observed(metrics, 'interruptionBackwardSpeedMps', 'm/s')}，需至少 ${BACKWARD_FLIGHT_MIN_SPEED_MPS} m/s；原地轉頭或停住不能代替後退。`
    default: return '本段後退已中斷；先重新建立前飛速度再轉頭。'
  }
}

export function backwardFlightObjective(metrics: Metrics): TrainingObjective {
  const phase = Number.isInteger(metrics.backwardPhase) && metrics.backwardPhase >= 0 && metrics.backwardPhase <= 7 ? metrics.backwardPhase : 0
  if (phase === 0) return { title: '1／7 起飛區地面準備', detail: '保持低油門，在起飛區實際接地並明確解鎖，再自行起飛。' }
  if (phase === 1) return { title: '2／7 自行起飛至練習高度', detail: '先升至約 10 m，至少 4 m；留出轉頭與減速的空間，再沿來向至去向的寬走廊前進。' }
  const interruption = backwardFlightInterruptionReason(metrics)
  if (interruption) return {
    title: '本段已中斷，重新建立前速',
    detail: `${interruption}先前步驟保留，本段後退距離與時間重新計算；保持機腹朝地，先讓機頭跟著實際移動方向前飛，再偏航約 180°。`,
  }
  if (phase === 2 || !(metrics.backwardEpisodeValid > 0.5)) return {
    title: '3／7 建立真正前進速度',
    detail: `機頭朝去向並沿走廊前進，前速需至少 1.5 m/s，保持約 0.2 秒再轉頭。目前水平速度 ${observed(metrics, 'horizontalSpeedMps', 'm/s')}，機頭與移動方向夾角 ${observed(metrics, 'backwardVelocityHeadingDegrees', '°')}，需在 45° 內；原地轉頭不能替代前飛。`,
  }
  if (phase === 3) return {
    title: '4／7 保留慣性，偏航轉頭約 180°',
    detail: `保持機腹朝地，向左或右偏航，讓機頭朝來向；不要先煞停。已轉頭 ${observed(metrics, 'backwardYawDegrees', '°')}，沿原方向速度 ${observed(metrics, 'backwardForwardSpeedMps', 'm/s')}。轉頭只改變朝向，移動仍可沿原方向持續。`,
  }
  if (phase === 4) return {
    title: '5／7 讓機體實際往機尾方向移動',
    detail: `保持機頭朝來向、機腹朝地，延續原來慣性；以小幅姿態與油門控制後退。相對機頭的後退速度 ${observed(metrics, 'backwardSpeedMps', 'm/s')}，需至少 0.75 m/s。只轉頭而沒有真正移動不算。`,
  }
  if (phase === 5 || !hasBackwardProof(metrics)) return {
    title: '6／7 維持受控後退',
    detail: `後退距離 ${observed(metrics, 'backwardDistanceM', 'm')}／至少 3 m，持續 ${observed(metrics, 'backwardHoldSeconds', 's')}／至少 0.6 秒。保持原本移動方向、機頭朝來向，觀察兩側參照物的相對移動；不用貼線或精準定高。`,
  }
  if (hasCompleteProof(metrics)) return {
    title: '7／7 後退飛行與恢復完成', detail: '已先前飛、轉頭、維持實際後退，再主動減速或轉回朝向移動方向，恢復空中控制。',
  }
  return {
    title: '7／7 減速或轉回，恢復控制',
    detail: `已觀察到後退 ${observed(metrics, 'backwardDistanceM', 'm')}、持續 ${observed(metrics, 'backwardHoldSeconds', 's')}。${Number.isFinite(metrics.backwardRecoverySpeedLimitMps) ? `目前水平速度 ${observed(metrics, 'horizontalSpeedMps', 'm/s')}，請減至 ${observed(metrics, 'backwardRecoverySpeedLimitMps', 'm/s')} 以下；` : '主動降低後退速度，'}或再次偏航讓機頭朝向實際移動方向，再拉平並減緩升降與旋轉，確認 ${BACKWARD_FLIGHT_RECOVERY_SECONDS} 秒；不用降落或回原點。`,
  }
}

export function backwardFlightTrainingHint(evaluation: Pick<TrainingEvaluation, 'status' | 'message' | 'hint' | 'metrics' | 'recovery'>): string {
  if (evaluation.status === 'failure') {
    const message = evaluation.message ?? ''
    if (/墜毀|crash|impact/iu.test(message)) return `本次發生墜毀，後退飛行已停止；下次先起飛至約 10 m，轉頭時以油門保留高度並提早減速。${RESTART}`
    if (/上鎖|失焦|失去焦點|斷線|disarm|focus|disconnect/iu.test(message)) return `本次因上鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒後重試。${RESTART}`
    if (/無效|中斷|時間倒退|不一致|缺少有效|重設|跳躍|invalid|reset|telemetry/iu.test(message)) return `本次飛行資料無效、中斷或被重設，無法判定後退飛行。${RESTART}`
    if (/逾時|timeout|timed out/iu.test(message)) return `本次後退飛行挑戰逾時。${RESTART}`
    return `本次後退飛行尚未完成。${RESTART}`
  }
  const objective = backwardFlightObjective(evaluation.metrics ?? {})
  return `${objective.title}：${objective.detail}`
}

export function backwardFlightResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'backward-flight') return null
  const metrics = result.metrics
  if (result.outcome === 'SUCCESS' && result.totalCheckpoints === 7 && result.completedCheckpoints === 7
    && result.sampleCount > 0 && hasCompleteProof(metrics)) return {
    observedStrength: '本次已從地面自行起飛，先前飛再偏航轉頭，保持機腹朝地並延續原移動方向完成受控後退，最後恢復空中控制。',
    observedGap: null, nextPractice: '再練一次，留意轉頭前後機頭與實際移動方向的差異，練習較平順地保留後退速度及改出。', scopeNote: scope,
  }
  if (result.outcome !== 'SUCCESS' && /墜毀|上鎖|失焦|失去焦點|無效|資料中斷|時間倒退|不一致|缺少有效|重設|跳躍|逾時|crash|disarm|focus|invalid|timeout/iu.test(result.message ?? '')) return {
    observedStrength: null, observedGap: backwardFlightTrainingHint({ status: 'failure', message: result.message }),
    nextPractice: '先在寬闊區域起飛至約 10 m，建立前速後再轉頭，保留高度與慣性。', scopeNote: scope,
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null, observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定後退飛行表現。',
    nextPractice: `${RESTART}確認控制器就緒，再明確解鎖自行起飛。`, scopeNote: scope,
  }
  const objective = backwardFlightObjective(metrics)
  return {
    observedStrength: hasBackwardProof(metrics) ? '已觀察到同一段前飛、轉頭後的實際後退，尚待確認恢復控制。' : null,
    observedGap: result.outcome === 'SUCCESS' ? '完成標記缺少同一段前飛、轉頭、實際後退及恢復的證據，不能據此判定通過。' : `尚未完成後退飛行。${objective.title}：${objective.detail}`,
    nextPractice: `${RESTART}先建立前速，再轉頭保留慣性，維持後退至少 3 m 與 0.6 秒後主動改出。`, scopeNote: scope,
  }
}
