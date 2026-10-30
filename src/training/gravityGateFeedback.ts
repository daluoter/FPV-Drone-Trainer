import type { TrainingObjective } from './feedback'
import type { TrainingResultFeedback } from './resultFeedback'
import type { TrainingEvaluation, TrainingResult } from './types'
import { GRAVITY_GATE_AREA_RADIUS_M, GRAVITY_GATE_MIN_HEIGHT_M, GRAVITY_GATE_PHASE_IDS, GRAVITY_GATE_RECOVERY_SECONDS, GRAVITY_GATE_TIME_LIMIT_SECONDS } from './gravityGate'
import { GRAVITY_GATE_OPENING_WIDTH_M, GRAVITY_GATE_OPENING_DEPTH_M, GRAVITY_GATE_TOP_HEIGHT_M } from '../world/gravityGate'

type Metrics = Readonly<Record<string, number>>
const RESTART = '按「再練一次」，從地面重新開始本次練習。'
function observed(metrics: Metrics, key: string, unit: string, digits = 1): string {
  return Number.isFinite(metrics[key]) ? `${metrics[key].toFixed(digits)} ${unit}` : '尚無有效量測'
}
function hasPassageProof(metrics: Metrics): boolean {
  return metrics.gravityGateEpisodeValid > 0.5 && !(metrics.gravityGateInterrupted > 0.5)
    && metrics.gravityGateForwardEstablished > 0.5 && metrics.gravityGateTossed > 0.5 && metrics.gravityGateAdjusted > 0.5
    && metrics.gravityGateEntered > 0.5 && metrics.gravityGateExited > 0.5
}
function hasCompleteProof(metrics: Metrics): boolean {
  return hasPassageProof(metrics) && metrics.gravityGatePhase === GRAVITY_GATE_PHASE_IDS.length
    && metrics.gravityGateRecovered > 0.5 && metrics.gravityGateRecoveryQualifying > 0.5
    && metrics.gravityGateRecoveryDwellSeconds + 1e-8 >= GRAVITY_GATE_RECOVERY_SECONDS
}
export function gravityGateCollisionCause(warning: string): string | null {
  const match = /Obstacle collision: gravity-gate-(?:(left|right)-(near|far)-(post)|(top|bottom)-(near|far|left|right)-(bar))/u.exec(warning)
  if (!match) return null
  const sides: Readonly<Record<string, string>> = { left: '左', right: '右', near: '近側', far: '遠側' }
  return match[3] ? `${sides[match[1]]}${sides[match[2]]}立柱` : `${match[4] === 'top' ? '頂部' : '底部'}${sides[match[5]]}橫樑`
}
export function gravityGateRouteGuide(): string {
  return `地面自行起飛至約 14 m → 在門框近側建立前速 → 帶速上拋至約 28～30 m → 收油並以橫滾或俯仰調姿 → 由黃色頂部開口向下落入框內 → 從前方青色側出口飛出 → 回正並恢復空中控制。頂部離地 ${GRAVITY_GATE_TOP_HEIGHT_M} m，淨開口寬 ${GRAVITY_GATE_OPENING_WIDTH_M} m、深 ${GRAVITY_GATE_OPENING_DEPTH_M} m；門框有實際碰撞。先完成單次流程，不要求固定翻轉圈數、緊貼門框、精準停點或八字串接。漏門可重新前飛、上拋及進出；先前勾選不會代替新一段完整路線。引導練習不限時，挑戰 ${GRAVITY_GATE_TIME_LIMIT_SECONDS} 秒。`
}
export function gravityGateInterruptionReason(metrics: Metrics): string | null {
  if (!(metrics.gravityGateInterrupted > 0.5)) return null
  switch (metrics.gravityGateInterruptionReason) {
    case 1: return '本段因接地中斷；地面停住不能算重力門改出。'
    case 2: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，低於 ${GRAVITY_GATE_MIN_HEIGHT_M} m，已沒有足夠改出空間。`
    case 3: return `中斷時距起飛點 ${observed(metrics, 'interruptionLaunchDistanceM', 'm')}，超出 ${GRAVITY_GATE_AREA_RADIUS_M} m 練習區。`
    case 4: return `向下穿過頂部高度時沒有對準開口：左右偏差 ${observed(metrics, 'interruptionGravityGateEntryHorizontalErrorM', 'm')}（右＋）、前後偏差 ${observed(metrics, 'interruptionGravityGateEntryForwardErrorM', 'm')}（後＋）。先拉開距離再上拋，從黃色開口內向下進入。`
    case 5: return '這次從側面或底部進入框內，尚未從頂部向下入框；請拉開距離，重新前飛及上拋。'
    case 6: return `進框後沒有從指定青色側面飛出：中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，距指定側出口 ${observed(metrics, 'interruptionGravityGateExitDistanceM', 'm')}。頂部進入後，沿前方青色箭頭改出。`
    case 7: return '側面飛出後又回到框內；本段進出已中斷，重新完成頂部進入與側面飛出再回正。'
    case 9: return '雖由頂部穿入，但此前尚未完成同一段帶速上拋、收油與實際調姿；先重新前飛、上拋並對準開口。'
    case 10: return '上拋前已失去朝前的移動慣性；先重新建立前速，再保留前速向上拋，不能先停住後直上直下。'
    default: return '本段進出路線已中斷，重新前飛、上拋、由頂部進入再從指定側面飛出。'
  }
}
export function gravityGateObjective(metrics: Metrics): TrainingObjective {
  const phase = Number.isInteger(metrics.gravityGatePhase) && metrics.gravityGatePhase >= 0 && metrics.gravityGatePhase <= 8 ? metrics.gravityGatePhase : 0
  if (phase === 0) return { title: '1／8 起飛區地面準備', detail: '保持低油門，在起飛區實際接地並明確解鎖，再自行起飛。' }
  if (phase === 1) return { title: '2／8 自行起飛至進場高度', detail: '先起飛至約 14 m，至少離地 4 m；認清前方黃色頂部入口、青色側出口，拉開距離再前飛。' }
  const interruption = gravityGateInterruptionReason(metrics)
  if (interruption) return { title: '本段已中斷，重新準備進場', detail: `${interruption}先前步驟保留，本段仍須重新前飛、上拋、頂部進入及側面改出。` }
  if (!(metrics.gravityGateEpisodeValid > 0.5)) return { title: '3／8 建立前進速度', detail: `在門框近側朝前方飛行，前速至少 1.5 m/s，先穩住升降約 0.1 秒再上拋。目前前速 ${observed(metrics, 'gravityGateForwardSpeedMps', 'm/s')}。起飛的上升不能直接代替帶速上拋。` }
  if (!(metrics.gravityGateTossed > 0.5)) return { title: '4／8 帶速向上拋', detail: `保留前速並向上拋，取得頂部開口上方的高度；頂部離地 24 m，建議升到約 28～30 m。本段已升高 ${observed(metrics, 'gravityGateHeightGainM', 'm')}，目前升降速度 ${observed(metrics, 'verticalSpeedMps', 'm/s')}（上＋）。` }
  if (!(metrics.gravityGateAdjusted > 0.5)) return { title: '5／8 收油並調整姿態', detail: `降低上拋時的油門，以橫滾或俯仰修正路線，觀察升速減少並對準黃色頂部開口；不要求翻滿一圈。已量到姿態變化 ${observed(metrics, 'gravityGateAttitudeChangeDegrees', '°')}，${metrics.gravityGateThrottleCutObserved > 0.5 ? '已觀察到收油。' : '尚待觀察收油。'}` }
  if (!(metrics.gravityGateEntered > 0.5)) return { title: '6／8 從頂部向下入框', detail: `從黃色開口內由上往下落入，不從側面或底部進入。比頂入口高低 ${observed(metrics, 'gravityGateTopHeightDifferenceM', 'm')}（高＋），左右偏差 ${observed(metrics, 'gravityGateEntryHorizontalErrorM', 'm')}（右＋）、前後偏差 ${observed(metrics, 'gravityGateEntryForwardErrorM', 'm')}（後＋）；先調整實際航線再穿入。` }
  if (!(metrics.gravityGateExited > 0.5)) return { title: '7／8 由指定側面飛出', detail: `已由頂部進入，沿青色箭頭朝前方側出口飛出，還差 ${observed(metrics, 'gravityGateExitDistanceM', 'm')}。保留高度與出口空間，不從頂部回飛或改由其他面離框。` }
  return hasCompleteProof(metrics)
    ? { title: '8／8 重力門與恢復完成', detail: '已觀察到同一次前飛上拋、收油調姿、頂部向下入框、指定側面飛出與正飛恢復；不需要降落。' }
    : { title: '8／8 恢復正飛與控制', detail: `已從指定側面飛出；主動修回機腹朝地，傾角減至 45° 內、升降速度回到 −6～+6 m/s，減緩旋轉並穩住 0.2 秒。目前傾角 ${observed(metrics, 'tiltDegrees', '°')}、升降速度 ${observed(metrics, 'verticalSpeedMps', 'm/s')}。` }
}
export function gravityGateTrainingHint(evaluation: Pick<TrainingEvaluation, 'status' | 'message' | 'hint' | 'metrics' | 'recovery'>): string {
  if (evaluation.status === 'failure') {
    const message = evaluation.message ?? ''
    const part = gravityGateCollisionCause(message)
    if (part) return `本次碰到${part}，重力門已停止。下次對準開口中央，為機體與槳保留距離。${RESTART}`
    if (/墜毀|碰撞|crash|impact/iu.test(message)) return `本次發生墜毀或碰框，重力門已停止；先保留上拋及改出高度。${RESTART}`
    if (/上鎖|失去焦點|斷線|disarm|focus/iu.test(message)) return `本次因上鎖、失去焦點或連線中斷而停止。${RESTART}`
    if (/無效|中斷|倒退|不一致|缺少|重設|跳躍|invalid|telemetry/iu.test(message)) return `本次飛行資料無效、中斷或被重設，無法判定重力門表現。${RESTART}`
    if (/逾時|timeout/iu.test(message)) return `本次重力門挑戰逾時。${RESTART}`
    return `本次重力門尚未完成。${RESTART}`
  }
  const objective = gravityGateObjective(evaluation.metrics ?? {})
  return `${objective.title}：${objective.detail}`
}
export function gravityGateResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'gravity-gate') return null
  const metrics = result.metrics
  if (result.outcome === 'SUCCESS' && result.totalCheckpoints === 8 && result.completedCheckpoints === 8
    && result.sampleCount > 0 && hasCompleteProof(metrics)) return {
    observedStrength: '本次已自行起飛、帶速上拋與收油調姿，從頂部向下進框、指定側面飛出，並在同一次連續飛行恢復正飛。',
    observedGap: null, nextPractice: '再練一次，觀察上拋後的動量、頂部落點及側出口位置，讓收油、調姿與改出更平順。', scopeNote: scope }
  if (result.outcome !== 'SUCCESS' && /墜毀|碰撞|Obstacle collision:|上鎖|失去焦點|無效|中斷|倒退|不一致|缺少|重設|跳躍|逾時/iu.test(result.message ?? '')) return {
    observedStrength: null, observedGap: gravityGateTrainingHint({ status: 'failure', message: result.message }),
    nextPractice: '下次先拉開進場距離，帶速上拋至頂部開口上方；黃色頂部進，青色側面出。', scopeNote: scope }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return { observedStrength: null,
    observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定重力門表現。', nextPractice: `${RESTART}明確解鎖後自行起飛。`, scopeNote: scope }
  const objective = gravityGateObjective(metrics)
  return { observedStrength: hasPassageProof(metrics) ? '已觀察到同一次頂部進入與指定側面飛出，尚待確認正飛恢復。' : null,
    observedGap: result.outcome === 'SUCCESS' ? '完成標記缺少同一次上拋、頂部入框、指定側面飛出與恢復證據，不能判定通過。' : `尚未完成重力門。${objective.title}：${objective.detail}`,
    nextPractice: `${RESTART}從近側前飛上拋、收油調姿，再依序完成頂部進入及側面改出。`, scopeNote: scope }
}
