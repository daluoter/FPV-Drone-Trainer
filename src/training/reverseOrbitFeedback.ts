import {
  REVERSE_ORBIT_AREA_RADIUS_M, REVERSE_ORBIT_COMPLETION_DEGREES, REVERSE_ORBIT_EXIT_DISTANCE_M,
  REVERSE_ORBIT_EXIT_MIN_SPEED_MPS, REVERSE_ORBIT_FLIGHT_HEIGHT_M, REVERSE_ORBIT_HOLD_SECONDS,
  REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M, REVERSE_ORBIT_MAX_RADIUS_M, REVERSE_ORBIT_MAX_TILT_DEGREES,
  REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M, REVERSE_ORBIT_MIN_RADIUS_M, REVERSE_ORBIT_MIN_TANGENTIAL_SPEED_MPS,
  REVERSE_ORBIT_MIN_VIEW_ELEVATION_DEGREES, REVERSE_ORBIT_REQUIRED_LAPS,
  REVERSE_ORBIT_TARGET_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M, REVERSE_ORBIT_TIME_LIMIT_SECONDS,
} from './reverseOrbit'
import type { TrainingObjective } from './feedback'
import type { TrainingResultFeedback } from './resultFeedback'
import type { TrainingEvaluation, TrainingResult } from './types'

type Metrics = Readonly<Record<string, number>>
const RESTART = '按「再練一次」，從地面重新開始本次練習。'
function observed(metrics: Metrics, key: string, unit: string, digits = 1): string {
  return Number.isFinite(metrics[key]) ? `${metrics[key].toFixed(digits)} ${unit}` : '尚無有效量測'
}
function hasLapProof(metrics: Metrics): boolean {
  return metrics.reverseOrbitEpisodeValid > 0.5 && !(metrics.reverseOrbitInterrupted > 0.5)
    && metrics.reverseOrbitCompleted > 0.5 && metrics.reverseOrbitCompletedLaps >= REVERSE_ORBIT_REQUIRED_LAPS
    && metrics.reverseOrbitProgressDegrees + 1e-8 >= REVERSE_ORBIT_COMPLETION_DEGREES
}
function hasCompleteProof(metrics: Metrics): boolean {
  return hasLapProof(metrics) && metrics.reverseOrbitPhase === 7
    && metrics.reverseOrbitExitQualifying > 0.5 && metrics.reverseOrbitRecoveryQualifying > 0.5
    && metrics.reverseOrbitExitDistanceM + 1e-8 >= REVERSE_ORBIT_EXIT_DISTANCE_M
    && metrics.reverseOrbitRadialSpeedMps >= REVERSE_ORBIT_EXIT_MIN_SPEED_MPS
    && metrics.reverseOrbitRecoveryDwellSeconds + 1e-8 >= REVERSE_ORBIT_HOLD_SECONDS
}

export function reverseOrbitInterruptionReason(metrics: Metrics): string | null {
  if (!(metrics.reverseOrbitInterrupted > 0.5)) return null
  switch (metrics.reverseOrbitInterruptionReason) {
    case 1: return '本組因接地中斷；需要在空中重新準備仰視環繞。'
    case 2: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，下方空間不足；先重新升高。`
    case 3: return `中斷時距起飛點 ${observed(metrics, 'interruptionLaunchDistanceM', 'm')}，已離開 ${REVERSE_ORBIT_AREA_RADIUS_M} m 練習區。`
    case 4: return `中斷時環繞半徑 ${observed(metrics, 'interruptionReverseOrbitRadiusM', 'm')}，需在 ${REVERSE_ORBIT_MIN_RADIUS_M}～${REVERSE_ORBIT_MAX_RADIUS_M} m 內；先修正與起重機的距離。`
    case 5: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，動作高度需在 ${REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M}～${REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M} m；先調整高度，保持在機臂下方。`
    case 6: return `中斷時高處參照物偏離視線 ${observed(metrics, 'interruptionReverseOrbitTargetViewErrorDegrees', '°')}，當時視角上限 ${observed(metrics, 'interruptionReverseOrbitViewLimitDegrees', '°')}；配合姿態與偏航，讓機臂回到視野。`
    case 7: return `中斷時環繞速度 ${observed(metrics, 'interruptionReverseOrbitTangentialSpeedMps', 'm/s')}，需至少 ${REVERSE_ORBIT_MIN_TANGENTIAL_SPEED_MPS} m/s；原地仰頭偏航不算一圈。`
    case 8: return '本組反向回走過多；來回刷同一小段不能累積成完整三圈。'
    case 9: return `中斷時傾角 ${observed(metrics, 'interruptionTiltDegrees', '°')}，需小於 ${REVERSE_ORBIT_MAX_TILT_DEGREES}°；推力仍要有向上分量，仰視不需要把機腹翻朝天。`
    case 10: return `中斷時鏡頭仰視 ${observed(metrics, 'interruptionReverseOrbitViewElevationDegrees', '°')}，需至少 ${REVERSE_ORBIT_MIN_VIEW_ELEVATION_DEGREES}°；抬高視線看機臂，平視的一般繞圈不能代替本課。`
    default: return '本組仰視環繞已中斷；先重新準備。'
  }
}

export function reverseOrbitRouteGuide(): string {
  return `地面自行起飛至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m → 接近前方 30 m 的塔式起重機 → 在約 ${REVERSE_ORBIT_TARGET_RADIUS_M} m 半徑，仰視 ${REVERSE_ORBIT_TARGET_HEIGHT_M} m 高的金色機臂並建立真正環繞 → 同方向連續完成 ${REVERSE_ORBIT_REQUIRED_LAPS} 個完整 360° 圈，共 ${REVERSE_ORBIT_COMPLETION_DEGREES}° → 向外實際飛離至少 ${REVERSE_ORBIT_EXIT_DISTANCE_M} m，再恢復控制 ${REVERSE_ORBIT_HOLD_SECONDS} 秒。左右任一方向皆可。鏡頭仰視至少 ${REVERSE_ORBIT_MIN_VIEW_ELEVATION_DEGREES}°，高處參照物保留在當前 FPV 視角內；按實際鏡頭安裝角與視野判定，不因切換 Chase 或 Free 改成別的標準。半徑 ${REVERSE_ORBIT_MIN_RADIUS_M}～${REVERSE_ORBIT_MAX_RADIUS_M} m、高度 ${REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M}～${REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M} m，不要求完美圓形、精準定距或降落。推力仍要有向上分量，仰視不等於機腹朝天；配合油門支撐高度。中斷後里程碑保留，本組圈數清空，仍須重新連續三圈。引導練習不限時，挑戰 ${REVERSE_ORBIT_TIME_LIMIT_SECONDS} 秒。`
}

export function reverseOrbitObjective(metrics: Metrics): TrainingObjective {
  const phase = Number.isInteger(metrics.reverseOrbitPhase) && metrics.reverseOrbitPhase >= 0 && metrics.reverseOrbitPhase <= 7 ? metrics.reverseOrbitPhase : 0
  if (phase === 0) return { title: '1／7 起飛區地面準備', detail: '保持低油門，在起飛區實際接地並明確解鎖，再自行起飛。' }
  if (phase === 1) return { title: '2／7 自行起飛至練習高度', detail: `先升至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m，至少 ${REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M} m；辨認前方起重機的高塔、金色機臂及吊鉤。` }
  const reason = reverseOrbitInterruptionReason(metrics)
  if (!(metrics.reverseOrbitEpisodeValid > 0.5)) return {
    title: reason ? '本組已中斷，重新仰視進場' : '3／7 仰視機臂並建立環繞',
    detail: `${reason ? `${reason}先前里程碑保留，本組圈數已清空，需重新連續三圈。` : ''}到起重機旁約 ${REVERSE_ORBIT_TARGET_RADIUS_M} m，抬高視線看高處機臂，建立左右任一方向的側向環繞。配合油門維持高度，保留向上推力；原地抬頭或低頭的一般繞圈都不算。`,
  }
  if (hasCompleteProof(metrics)) return { title: '7／7 三圈仰視環繞與飛離完成', detail: '已持續仰視高處機臂完成三個完整圈，再向外實際飛離並恢復空中控制；不需降落。' }
  if (hasLapProof(metrics)) return {
    title: '7／7 向外飛離並恢復控制',
    detail: `已完成 ${REVERSE_ORBIT_REQUIRED_LAPS}／${REVERSE_ORBIT_REQUIRED_LAPS} 圈，累積 ${observed(metrics, 'reverseOrbitProgressDegrees', '°')}。逐步修平並朝起重機外側離開；向外距離 ${observed(metrics, 'reverseOrbitExitDistanceM', 'm')}，需至少 ${REVERSE_ORBIT_EXIT_DISTANCE_M} m；往外速度 ${observed(metrics, 'reverseOrbitRadialSpeedMps', 'm/s')}，需至少 ${REVERSE_ORBIT_EXIT_MIN_SPEED_MPS} m/s。減緩升降與旋轉，確認 ${REVERSE_ORBIT_HOLD_SECONDS} 秒；原地停住還沒完成改出。`,
  }
  let correction = ''
  if (Number.isFinite(metrics.reverseOrbitViewElevationDegrees) && metrics.reverseOrbitViewElevationDegrees < REVERSE_ORBIT_MIN_VIEW_ELEVATION_DEGREES) correction = `目前仰視 ${observed(metrics, 'reverseOrbitViewElevationDegrees', '°')}，至少需 ${REVERSE_ORBIT_MIN_VIEW_ELEVATION_DEGREES}°；先抬高視線。`
  else if (Number.isFinite(metrics.reverseOrbitViewLimitDegrees) && metrics.reverseOrbitTargetViewErrorDegrees > metrics.reverseOrbitViewLimitDegrees) correction = `機臂偏離視線 ${observed(metrics, 'reverseOrbitTargetViewErrorDegrees', '°')}，超出當前 ${observed(metrics, 'reverseOrbitViewLimitDegrees', '°')} 上限；先讓機臂回到視野。`
  else if (Number.isFinite(metrics.reverseOrbitRadiusM) && (metrics.reverseOrbitRadiusM < REVERSE_ORBIT_MIN_RADIUS_M || metrics.reverseOrbitRadiusM > REVERSE_ORBIT_MAX_RADIUS_M)) correction = `目前半徑 ${observed(metrics, 'reverseOrbitRadiusM', 'm')}，先回到 ${REVERSE_ORBIT_MIN_RADIUS_M}～${REVERSE_ORBIT_MAX_RADIUS_M} m。`
  const lap = Math.max(1, Math.min(REVERSE_ORBIT_REQUIRED_LAPS, phase - 2))
  return {
    title: `${Math.min(6, Math.max(4, phase + 1))}／7 仰視完成第 ${lap} 圈`,
    detail: `${correction}本組已完成 ${Number.isInteger(metrics.reverseOrbitCompletedLaps) ? Math.max(0, Math.min(REVERSE_ORBIT_REQUIRED_LAPS, metrics.reverseOrbitCompletedLaps)) : 0}／${REVERSE_ORBIT_REQUIRED_LAPS} 圈，累積 ${observed(metrics, 'reverseOrbitProgressDegrees', '°')}，仰視 ${observed(metrics, 'reverseOrbitViewElevationDegrees', '°')}。持續看著高處機臂，沿同一方向真正移動，配合姿態與油門；不用貼線。`,
  }
}

export function reverseOrbitTrainingHint(evaluation: Pick<TrainingEvaluation, 'status' | 'message' | 'hint' | 'metrics' | 'recovery'>): string {
  if (evaluation.status === 'failure') {
    const message = evaluation.message ?? ''
    if (/墜毀|crash|impact/iu.test(message)) return `本次發生墜毀，倒刷鍋已停止；下次先起飛至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m，仰視時配合油門支撐高度，並提早改出。${RESTART}`
    if (/上鎖|失焦|失去焦點|斷線|disarm|focus|disconnect/iu.test(message)) return `本次因上鎖、失去焦點或連線中斷而停止。${RESTART}`
    if (/鏡頭設定|FPV 鏡頭/u.test(message)) return `本次缺少有效鏡頭資料，或中途改變鏡頭設定；無法確認仰視與參照物方向。${RESTART}`
    if (/無效|中斷|時間倒退|不一致|缺少有效|重設|跳躍|invalid|reset|telemetry/iu.test(message)) return `本次飛行資料無效、中斷或被重設，無法判定連續仰視環繞。${RESTART}`
    if (/逾時|timeout|timed out/iu.test(message)) return `本次倒刷鍋挑戰逾時。${RESTART}`
    return `本次倒刷鍋尚未完成。${RESTART}`
  }
  const objective = reverseOrbitObjective(evaluation.metrics ?? {})
  return `${objective.title}：${objective.detail}`
}

export function reverseOrbitResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'reverse-orbit') return null
  const metrics = result.metrics
  if (result.outcome === 'SUCCESS' && result.totalCheckpoints === 7 && result.completedCheckpoints === 7
    && result.sampleCount > 0 && hasCompleteProof(metrics)) return {
    observedStrength: '本次已從地面自行起飛，持續仰視高處起重機機臂完成同方向三圈環繞，再向外實際飛離並恢復空中控制。', observedGap: null,
    nextPractice: '以相同條件再練一次，觀察高處機臂在畫面中的位置，讓姿態、油門與環繞速度更平順，再練習向外改出。', scopeNote: scope,
  }
  if (result.outcome !== 'SUCCESS' && /墜毀|上鎖|失焦|失去焦點|無效|資料中斷|時間倒退|不一致|缺少有效|重設|跳躍|逾時|鏡頭設定|crash|disarm|focus|invalid|timeout/iu.test(result.message ?? '')) return {
    observedStrength: null, observedGap: reverseOrbitTrainingHint({ status: 'failure', message: result.message }),
    nextPractice: `先在起重機旁起飛至約 ${REVERSE_ORBIT_FLIGHT_HEIGHT_M} m，仰視高處機臂時用油門保留高度，再建立實際環繞。`, scopeNote: scope,
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return { observedStrength: null,
    observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定倒刷鍋表現。', nextPractice: `${RESTART}確認控制器與鏡頭設定，再自行起飛。`, scopeNote: scope }
  const objective = reverseOrbitObjective(metrics)
  return {
    observedStrength: hasLapProof(metrics) ? '已觀察到同一段連續三圈仰視環繞，尚待確認實際向外飛離與恢復。' : null,
    observedGap: result.outcome === 'SUCCESS' ? '完成標記缺少同一組三圈仰視環繞及實際飛離的證據，不能據此判定通過。' : `尚未完成倒刷鍋。${objective.title}：${objective.detail}`,
    nextPractice: `${RESTART}重新仰視機臂並連續環繞三圈，再向外飛離與修平；先前勾選不代替本組飛行證據。`, scopeNote: scope,
  }
}
