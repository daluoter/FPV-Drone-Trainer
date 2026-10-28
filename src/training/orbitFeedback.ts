import {
  ORBIT_AREA_RADIUS_M, ORBIT_COMPLETION_DEGREES, ORBIT_HOLD_SECONDS, ORBIT_LESSON,
  ORBIT_MAX_ENTRY_HEIGHT_M, ORBIT_MAX_HEADING_ERROR_DEGREES, ORBIT_MAX_RADIUS_M,
  ORBIT_MIN_ENTRY_HEIGHT_M, ORBIT_MIN_RADIUS_M, ORBIT_MIN_TANGENTIAL_SPEED_MPS,
  ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M,
  ORBIT_REQUIRED_LAPS, ORBIT_EXIT_DISTANCE_M, ORBIT_EXIT_MIN_SPEED_MPS,
} from './orbit'
import type { TrainingObjective } from './feedback'
import type { TrainingResultFeedback } from './resultFeedback'
import type { TrainingEvaluation, TrainingResult } from './types'

type Metrics = Readonly<Record<string, number>>
const RESTART = '本次練習已結束；按「再練一次」會清空本次步驟，從地面重新開始。'

function observed(metrics: Metrics, key: string, unit: string, digits = 1): string {
  return Number.isFinite(metrics[key]) ? `${metrics[key].toFixed(digits)} ${unit}` : '尚無有效量測'
}

export function orbitInterruptionReason(metrics: Metrics): string | null {
  if (!(metrics.orbitInterrupted > 0.5)) return null
  switch (metrics.orbitInterruptionReason) {
    case 1: return '本圈因接地中斷；接地不會完成空中繞行。'
    case 2: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，下方空間不足；先重新升高。`
    case 3: return `中斷時距起飛點 ${observed(metrics, 'interruptionLaunchDistanceM', 'm')}，已離開 ${ORBIT_AREA_RADIUS_M} m 練習區。`
    case 4: return `中斷時繞行半徑 ${observed(metrics, 'interruptionOrbitRadiusM', 'm')}，需在 ${ORBIT_MIN_RADIUS_M}～${ORBIT_MAX_RADIUS_M} m 內；先修正與塔的距離。`
    case 5: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，繞行時需在 ${ORBIT_MIN_ENTRY_HEIGHT_M}～${ORBIT_MAX_ENTRY_HEIGHT_M} m 內；先修正油門與高度。`
    case 6: return `中斷時機頭偏離目標 ${observed(metrics, 'interruptionOrbitHeadingErrorDegrees', '°')}，需在 ${ORBIT_MAX_HEADING_ERROR_DEGREES}° 內；配合偏航讓機頭大致朝塔。`
    case 7: return `中斷時繞塔側向速度 ${observed(metrics, 'interruptionOrbitTangentialSpeedMps', 'm/s')}，需至少 ${ORBIT_MIN_TANGENTIAL_SPEED_MPS} m/s；先建立實際側移，原地轉頭不算。`
    case 8: return '本圈反向回走過多；左右來回刷同一小段不能累積成一圈。'
    case 9: return `中斷時傾角 ${observed(metrics, 'interruptionTiltDegrees', '°')}，傾斜過大；先回正並修正油門，再重新繞行。`
    default: return null
  }
}

export function orbitRouteGuide(): string {
  return `地面自行起飛至約 ${ORBIT_TARGET_HEIGHT_M} m → 接近前方 30 m 的紫色參考塔 → 在約 ${ORBIT_TARGET_RADIUS_M} m 半徑，機頭朝塔並建立側向移動 → 沿同一方向連續完成第 1～${ORBIT_REQUIRED_LAPS} 圈 → 朝塔外實際飛離至少 ${ORBIT_EXIT_DISTANCE_M} m，再恢復控制 ${ORBIT_HOLD_SECONDS} 秒。左右任一方向皆可；每圈完整 360°，合計至少 ${ORBIT_COMPLETION_DEGREES}°，需持續對著參考塔盤旋。半徑 ${ORBIT_MIN_RADIUS_M}～${ORBIT_MAX_RADIUS_M} m、離地 ${ORBIT_MIN_ENTRY_HEIGHT_M}～${ORBIT_MAX_ENTRY_HEIGHT_M} m，機頭朝塔容許 ${ORBIT_MAX_HEADING_ERROR_DEGREES}° 偏差。不要求完美圓形、精準定距、回原點或降落；原地偏航、直線掠過及反覆刷小段不能代替盤旋。中斷後里程碑保留，但本組圈數重新計算，仍須連續完成五圈再離開。引導練習不限時，挑戰 300 秒。`
}

export function orbitObjective(metrics: Metrics): TrainingObjective {
  const phase = Number.isInteger(metrics.orbitPhase) && metrics.orbitPhase >= 0 && metrics.orbitPhase <= 9 ? metrics.orbitPhase : 0
  if (phase === 0) return { title: '1／9 起飛區地面準備', detail: '在起飛區實際接地、低油門明確解鎖；再自行起飛，不會由示範代飛。' }
  if (phase === 1) return { title: '2／9 自行起飛至練習高度', detail: `先升至約 ${ORBIT_TARGET_HEIGHT_M} m，至少 ${ORBIT_MIN_ENTRY_HEIGHT_M} m，再接近前方紫色參考塔。油門維持高度，避免一離地就急轉。` }
  if (!(metrics.orbitEpisodeValid > 0.5)) {
    const reason = orbitInterruptionReason(metrics)
    return {
      title: reason ? '本組已中斷，重新進場' : '3／9 朝塔建立側向繞行',
      detail: `${reason ? `${reason}先前里程碑保留，本組圈數已清空，重新連續完成五圈。` : ''}到塔旁約 ${ORBIT_TARGET_RADIUS_M} m，保持 ${ORBIT_MIN_ENTRY_HEIGHT_M}～${ORBIT_MAX_ENTRY_HEIGHT_M} m 高度，機頭朝塔；選左或右側移，配合偏航維持朝向，建立真正繞行。`,
    }
  }
  const lapCompleted = metrics.orbitCompleted > 0.5 && metrics.orbitProgressDegrees >= ORBIT_COMPLETION_DEGREES && metrics.orbitCompletedLaps >= ORBIT_REQUIRED_LAPS
  if (phase === 9 && lapCompleted && metrics.orbitExitQualifying > 0.5 && metrics.orbitRecoveryQualifying > 0.5
    && metrics.orbitExitDistanceM >= ORBIT_EXIT_DISTANCE_M && metrics.orbitRecoveryDwellSeconds + 1e-9 >= ORBIT_HOLD_SECONDS) return {
    title: '9／9 五圈盤旋與飛離完成', detail: '已持續朝參考塔盤旋五圈，朝塔外實際飛離並恢復空中控制；不需降落或回原點。',
  }
  if (lapCompleted) return {
    title: '9／9 朝塔外飛離並恢復控制',
    detail: `已完成 ${ORBIT_REQUIRED_LAPS}／${ORBIT_REQUIRED_LAPS} 圈，共 ${observed(metrics, 'orbitProgressDegrees', '°')}。減少側移，將機頭轉向離塔方向並實際飛離；目前往外距離 ${observed(metrics, 'orbitExitDistanceM', 'm')}，需至少 ${ORBIT_EXIT_DISTANCE_M} m，往外速度需至少 ${ORBIT_EXIT_MIN_SPEED_MPS} m/s（目前 ${observed(metrics, 'orbitRadialSpeedMps', 'm/s')}）。主動拉平並減緩旋轉與升降，確認 ${ORBIT_HOLD_SECONDS} 秒。原地懸停或維持原繞行狀態尚未完成飛離。`,
  }
  const nextPhase = Math.min(7, Math.max(2, phase))
  const stage = ORBIT_LESSON.checkpoints[nextPhase]
  let correction = ''
  if (Number.isFinite(metrics.orbitRadiusM) && (metrics.orbitRadiusM < ORBIT_MIN_RADIUS_M || metrics.orbitRadiusM > ORBIT_MAX_RADIUS_M)) correction = `目前半徑 ${observed(metrics, 'orbitRadiusM', 'm')}，先回到 ${ORBIT_MIN_RADIUS_M}～${ORBIT_MAX_RADIUS_M} m；`
  else if (Number.isFinite(metrics.altitudeM) && (metrics.altitudeM < ORBIT_MIN_ENTRY_HEIGHT_M || metrics.altitudeM > ORBIT_MAX_ENTRY_HEIGHT_M)) correction = `目前離地 ${observed(metrics, 'altitudeM', 'm')}，先回到 ${ORBIT_MIN_ENTRY_HEIGHT_M}～${ORBIT_MAX_ENTRY_HEIGHT_M} m；`
  else if (Number.isFinite(metrics.orbitHeadingErrorDegrees) && metrics.orbitHeadingErrorDegrees > ORBIT_MAX_HEADING_ERROR_DEGREES) correction = `機頭偏離塔 ${observed(metrics, 'orbitHeadingErrorDegrees', '°')}，先小量偏航修回 ${ORBIT_MAX_HEADING_ERROR_DEGREES}° 內；`
  else if (Number.isFinite(metrics.orbitTangentialSpeedMps) && metrics.orbitTangentialSpeedMps < ORBIT_MIN_TANGENTIAL_SPEED_MPS) correction = `繞塔側向速度 ${observed(metrics, 'orbitTangentialSpeedMps', 'm/s')}，需至少 ${ORBIT_MIN_TANGENTIAL_SPEED_MPS} m/s；`
  return {
    title: `${nextPhase + 1}／9 ${stage.title}`,
    detail: `${correction}本組已完成 ${Number.isInteger(metrics.orbitCompletedLaps) ? Math.max(0, Math.min(ORBIT_REQUIRED_LAPS, metrics.orbitCompletedLaps)) : 0}／${ORBIT_REQUIRED_LAPS} 圈，累積 ${observed(metrics, 'orbitProgressDegrees', '°')}，半徑 ${observed(metrics, 'orbitRadiusM', 'm')}。保持同一側移方向，用小量橫滾、偏航及油門讓機頭持續朝塔，完整盤旋五圈後再離開；不必貼線。`,
  }
}

export function orbitTrainingHint(evaluation: Pick<TrainingEvaluation, 'status' | 'message' | 'hint' | 'metrics' | 'recovery'>): string {
  const message = evaluation.message ?? ''
  if (evaluation.status === 'failure') {
    if (/墜毀|crash|impact/iu.test(message)) return `本次發生墜毀，正刷鍋已停止；先重設場景，再用較小的側移與油門重新進場。${RESTART}`
    if (/上鎖|失焦|失去焦點|斷線|disarm|focus|disconnect/iu.test(message)) return `本次因上鎖、失去焦點或連線中斷而停止；確認網頁與控制器就緒後重試。${RESTART}`
    if (/無效|中斷|時間倒退|不一致|缺少有效|重設|跳躍|invalid|reset|telemetry/iu.test(message)) return `本次飛行資料無效、中斷或被重設，無法判定連續繞行。${RESTART}`
    if (/逾時|timeout|timed out/iu.test(message)) return `本次正刷鍋挑戰逾時。${RESTART}`
    return `本次正刷鍋尚未完成。${RESTART}`
  }
  const objective = orbitObjective(evaluation.metrics ?? {})
  return `${objective.title}：${objective.detail}`
}

export function orbitResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'orbit' || result.attemptContext?.rulesVersion !== 6 && !Number.isFinite(result.metrics.orbitPhase)) return null
  const metrics = result.metrics
  const valid = metrics.orbitEpisodeValid > 0.5 && !(metrics.orbitInterrupted > 0.5)
  const lapProof = valid && metrics.orbitCompleted > 0.5 && metrics.orbitProgressDegrees >= ORBIT_COMPLETION_DEGREES && metrics.orbitCompletedLaps >= ORBIT_REQUIRED_LAPS
  const proven = lapProof && metrics.orbitPhase === 9 && metrics.orbitExitQualifying > 0.5 && metrics.orbitRecoveryQualifying > 0.5
    && metrics.orbitExitDistanceM >= ORBIT_EXIT_DISTANCE_M && metrics.orbitRadialSpeedMps >= ORBIT_EXIT_MIN_SPEED_MPS
    && metrics.orbitRecoveryDwellSeconds + 1e-9 >= ORBIT_HOLD_SECONDS
  if (result.outcome === 'SUCCESS' && result.totalCheckpoints === 9 && result.completedCheckpoints === 9 && result.sampleCount > 0 && proven) return {
    observedStrength: '本次已從地面自行起飛，機頭持續朝參考塔完成同方向五圈盤旋，再實際朝塔外飛離並恢復空中控制。', observedGap: null,
    nextPractice: '以相同條件再練一次，觀察側移、偏航與油門如何連續維持五圈的半徑及高度，再練習朝塔外飛離。', scopeNote: scope,
  }
  if (result.outcome !== 'SUCCESS' && /墜毀|上鎖|失焦|失去焦點|無效|資料中斷|時間倒退|不一致|缺少有效|重設|跳躍|逾時|crash|disarm|focus|invalid|timeout/iu.test(result.message ?? '')) return {
    observedStrength: null, observedGap: orbitTrainingHint({ status: 'failure', message: result.message ?? undefined }),
    nextPractice: '下次先起飛至約 10 m，在寬闊範圍建立機頭朝塔的側移；連續完成五圈後朝塔外飛離並恢復控制。', scopeNote: scope,
  }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return {
    observedStrength: null, observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定正刷鍋表現。',
    nextPractice: `${RESTART}確認控制器就緒，再明確解鎖自行起飛。`, scopeNote: scope,
  }
  const objective = orbitObjective(metrics)
  return {
    observedStrength: lapProof ? '本次已觀察到連續五圈的實際盤旋，尚待確認朝塔外飛離。' : null,
    observedGap: result.outcome === 'SUCCESS' ? '完成標記缺少同一組五圈盤旋與實際飛離的證據，不能據此判定正刷鍋通過。' : `尚未完成正刷鍋。${objective.title}：${objective.detail}`,
    nextPractice: `${RESTART}穩住側移及機頭朝向，持續對著參考塔完成五圈盤旋，再朝塔外飛離並恢復控制。`, scopeNote: scope,
  }
}
