import type { TrainingObjective } from './feedback'
import type { TrainingResultFeedback } from './resultFeedback'
import type { TrainingEvaluation, TrainingResult } from './types'
import { GRAVITY_GATE_AREA_RADIUS_M, GRAVITY_GATE_MIN_HEIGHT_M, GRAVITY_GATE_PHASE_IDS, GRAVITY_GATE_RECOVERY_SECONDS, GRAVITY_GATE_TIME_LIMIT_SECONDS, GRAVITY_GATE_PRACTICE_HEIGHT_M, GRAVITY_GATE_MIN_RETURN_SPEED_MPS, GRAVITY_GATE_RETURN_DISTANCE_M } from './gravityGate'
import { GRAVITY_GATE_OPENING_WIDTH_M, GRAVITY_GATE_OPENING_DEPTH_M, GRAVITY_GATE_TOP_HEIGHT_M, GRAVITY_GATE_MIDDLE_HEIGHT_M, GRAVITY_GATE_FRAME_THICKNESS_M } from '../world/gravityGate'

type Metrics = Readonly<Record<string, number>>
const RESTART = '按「再練一次」，從地面重新開始本次練習。'
function observed(metrics: Metrics, key: string, unit: string, digits = 1): string {
  return Number.isFinite(metrics[key]) ? `${metrics[key].toFixed(digits)} ${unit}` : '尚無有效量測'
}
function hasPassageProof(metrics: Metrics): boolean {
  return metrics.gravityGateEpisodeValid > 0.5 && !(metrics.gravityGateInterrupted > 0.5)
    && metrics.gravityGateForwardEstablished > 0.5 && metrics.gravityGateTossed > 0.5 && metrics.gravityGateAdjusted > 0.5
    && metrics.gravityGateEntered > 0.5 && metrics.gravityGateLowerReached > 0.5
    && metrics.gravityGateReturnReady > 0.5 && metrics.gravityGateReturned > 0.5
    && metrics.gravityGateReturnDistanceM + 1e-8 >= GRAVITY_GATE_RETURN_DISTANCE_M
    && metrics.gravityGateExited > 0.5
}
function hasCompleteProof(metrics: Metrics): boolean {
  return hasPassageProof(metrics) && metrics.gravityGatePhase === GRAVITY_GATE_PHASE_IDS.length
    && metrics.gravityGateRecovered > 0.5 && metrics.gravityGateRecoveryQualifying > 0.5
    && metrics.gravityGateRecoveryDwellSeconds + 1e-8 >= GRAVITY_GATE_RECOVERY_SECONDS
}
export function gravityGateCollisionCause(warning: string): string | null {
  const match = /Obstacle collision: gravity-gate-(?:(left|right)-(near|far)-(post)|(top|middle|bottom)-(near|far|left|right)-(bar))/u.exec(warning)
  if (!match) return null
  const sides: Readonly<Record<string, string>> = { left: '左', right: '右', near: '近側', far: '遠側' }
  return match[3] ? `${sides[match[1]]}${sides[match[2]]}立柱` : `${match[4] === 'top' ? '頂部' : match[4] === 'middle' ? '中層' : '底部'}${sides[match[5]]}橫樑`
}
export function gravityGateRouteGuide(): string {
  return `地面自行起飛至約 ${GRAVITY_GATE_PRACTICE_HEIGHT_M} m → 繞到門框右側進場點，朝左（−X）建立前速 → 帶速上拋至約 17～18 m → 收油調姿，從黃色水平頂口向下落入 → 留在框內穿過中環下降到低層 → 朝來向（＋X）實際折返，從同一側的青色低層出口飛出 → 回正並恢復空中控制。頂口離地 ${GRAVITY_GATE_TOP_HEIGHT_M} m，淨開口寬 ${GRAVITY_GATE_OPENING_WIDTH_M} m、深 ${GRAVITY_GATE_OPENING_DEPTH_M} m；低層出口上緣約 ${GRAVITY_GATE_MIDDLE_HEIGHT_M - GRAVITY_GATE_FRAME_THICKNESS_M / 2} m，門框有實際碰撞。先完成單次流程，不要求固定翻轉圈數、精準半圓、緊貼門框或八字串接。漏門可重新側向進場、上拋與折返；先前勾選不代替新一段完整路線。引導練習不限時，挑戰 ${GRAVITY_GATE_TIME_LIMIT_SECONDS} 秒。`
}
export function gravityGateInterruptionReason(metrics: Metrics): string | null {
  if (!(metrics.gravityGateInterrupted > 0.5)) return null
  switch (metrics.gravityGateInterruptionReason) {
    case 1: return '本段因接地中斷；地面停住不能算重力門改出。'
    case 2: return `中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，低於 ${GRAVITY_GATE_MIN_HEIGHT_M} m，已沒有足夠改出空間。`
    case 3: return `中斷時距起飛點 ${observed(metrics, 'interruptionLaunchDistanceM', 'm')}，超出 ${GRAVITY_GATE_AREA_RADIUS_M} m 練習區。`
    case 4: return `向下穿過頂部高度時沒有對準開口：左右偏差 ${observed(metrics, 'interruptionGravityGateEntryHorizontalErrorM', 'm')}（右＋）、前後偏差 ${observed(metrics, 'interruptionGravityGateEntryForwardErrorM', 'm')}（後＋）。先回右側進場點，再帶速上拋，從黃色水平頂口內向下落入。`
    case 5: return '這次從側面或底部進入框內，尚未從水平頂口向下落入；請回側邊進場點，重新前飛及上拋。'
    case 6: return `進框後從錯誤的面離框，尚未完成低層折返：中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，距指定側出口 ${observed(metrics, 'interruptionGravityGateExitDistanceM', 'm')}。頂口落入後，留在框內下降至低層，再沿青色箭頭反向飛回來向。`
    case 7: return '低層側面飛出後又回到框內；本段已中斷，重新完成頂口落入、框內下降及低層折返。'
    case 9: return '雖由頂部穿入，但此前尚未完成同一段帶速上拋、收油與實際調姿；先重新前飛、上拋並對準開口。'
    case 10: return '上拋前已失去朝框內（−X）的前進慣性；先重新建立側向前速，不能先停住後直上直下。'
    case 11: return `尚未在框內下降到低層便側出：中斷時離地 ${observed(metrics, 'interruptionAltitudeM', 'm')}，比低層出口上緣高 ${observed(metrics, 'interruptionGravityGateLowerHeightDifferenceM', 'm')}。頂口落入後先穿過中環下降，再從來向那側飛出。`
    case 12: return `尚未在框內低層建立完整折返：當時回程速度 ${observed(metrics, 'interruptionGravityGateReturnSpeedMps', 'm/s')}（朝來向＋）。先在低層減少原方向速度、近乎停住，再朝來向加速至至少 ${GRAVITY_GATE_MIN_RETURN_SPEED_MPS} m/s；上層已轉向後直接落低側出，或只轉動機頭，都不能代替。`
    default: return '本段路線已中斷，重新側向上拋、頂口落入、框內下降，再從低層折返來向。'
  }
}
export function gravityGateObjective(metrics: Metrics): TrainingObjective {
  const phase = Number.isInteger(metrics.gravityGatePhase) && metrics.gravityGatePhase >= 0 && metrics.gravityGatePhase <= 8 ? metrics.gravityGatePhase : 0
  if (phase === 0) return { title: '1／8 起飛區地面準備', detail: '保持低油門，在起飛區實際接地並明確解鎖，再自行起飛。' }
  if (phase === 1) return { title: '2／8 自行起飛至進場高度', detail: '先起飛至約 8 m，至少離地 4 m；繞到門框右側進場點，認清黃色水平頂口及來向那側的青色低層出口。' }
  const interruption = gravityGateInterruptionReason(metrics)
  if (interruption) return { title: '本段已中斷，重新準備進場', detail: `${interruption}先前步驟保留，本段仍須重新前飛、上拋、頂部進入及側面改出。` }
  if (!(metrics.gravityGateEpisodeValid > 0.5)) return { title: '3／8 側邊建立前進速度', detail: `繞到右側進場點，再朝框內（−X）飛行，前速至少 1.5 m/s、升降平穩約 0.1 秒再上拋。目前前速 ${observed(metrics, 'gravityGateForwardSpeedMps', 'm/s')}。起飛的上升不能直接代替帶速上拋。` }
  if (!(metrics.gravityGateTossed > 0.5)) return { title: '4／8 帶速向上拋', detail: `保留前速並向上拋，取得頂部開口上方的高度；水平頂口離地 14 m，建議升到約 17～18 m。本段已升高 ${observed(metrics, 'gravityGateHeightGainM', 'm')}，目前升降速度 ${observed(metrics, 'verticalSpeedMps', 'm/s')}（上＋）。` }
  if (!(metrics.gravityGateAdjusted > 0.5)) return { title: '5／8 收油並調整姿態', detail: `降低上拋時的油門，以橫滾或俯仰修正路線，觀察升速減少並對準黃色水平頂口；不要求翻滿一圈。已量到姿態變化 ${observed(metrics, 'gravityGateAttitudeChangeDegrees', '°')}，${metrics.gravityGateThrottleCutObserved > 0.5 ? '已觀察到收油。' : '尚待觀察收油。'}` }
  if (!(metrics.gravityGateEntered > 0.5)) return { title: '6／8 從頂部向下入框', detail: `從黃色水平頂口內由上往下落入，不從側面或底部進入。比頂入口高低 ${observed(metrics, 'gravityGateTopHeightDifferenceM', 'm')}（高＋），左右偏差 ${observed(metrics, 'gravityGateEntryHorizontalErrorM', 'm')}（右＋）、前後偏差 ${observed(metrics, 'gravityGateEntryForwardErrorM', 'm')}（後＋）；先調整實際航線再穿入。` }
  if (!(metrics.gravityGateLowerReached > 0.5)) return { title: '7／8 在框內下降至低層', detail: `已由水平頂口落入；先留在框內穿過中環下降。比低層出口上緣高 ${observed(metrics, 'gravityGateLowerHeightDifferenceM', 'm')}（高＋）；降至中環下方後，再朝來向折返，上層直接側出不能完成。` }
  if (!(metrics.gravityGateReturnReady > 0.5)) return { title: '7／8 先在低層穩住原方向速度', detail: '已下降至低層；先留在框內減少原方向速度、近乎停住，再向來向折返。可以先停住，不要求仍維持負向速度；不要在上層已轉向後，直接落低側出。' }
  if (!(metrics.gravityGateReturned > 0.5)) return { title: '7／8 在低層實際折返', detail: `已下降到低層，朝右（＋X）飛回來向；回程速度 ${observed(metrics, 'gravityGateReturnSpeedMps', 'm/s')}／至少 ${GRAVITY_GATE_MIN_RETURN_SPEED_MPS} m/s，反向位移 ${observed(metrics, 'gravityGateReturnDistanceM', 'm')}／至少 ${GRAVITY_GATE_RETURN_DISTANCE_M} m。只把機頭轉向而仍往原方向移動不算。` }
  if (!(metrics.gravityGateExited > 0.5)) return { title: '7／8 從來向那側的低層出口飛出', detail: `已在低層反向移動，沿青色箭頭從來向那側的低層出口飛出，還差 ${observed(metrics, 'gravityGateExitDistanceM', 'm')}；不要從另一側直出或爬回上層側出。` }
  return hasCompleteProof(metrics)
    ? { title: '8／8 重力門與恢復完成', detail: '已觀察到同一次側向上拋、頂口落入、框內下降、低層折返來向與正飛恢復；不需要降落。' }
    : { title: '8／8 恢復正飛與控制', detail: `已由來向那側的低層出口改出；主動修回機腹朝地，傾角減至 45° 內、升降速度回到 −6～+6 m/s，減緩旋轉並穩住 0.2 秒。目前傾角 ${observed(metrics, 'tiltDegrees', '°')}、升降速度 ${observed(metrics, 'verticalSpeedMps', 'm/s')}。` }
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
  if (result.attemptContext?.rulesVersion === 6) return { observedStrength: null,
    observedGap: '這是舊版重力門路線的保留紀錄；不轉算新版低層折返完成。',
    nextPractice: '選擇目前的重力門，重新練習側向上拋、頂口落入、框內下降及低層反向改出。', scopeNote: scope }
  if (result.outcome === 'SUCCESS' && result.totalCheckpoints === 8 && result.completedCheckpoints === 8
    && result.sampleCount > 0 && hasCompleteProof(metrics)) return {
    observedStrength: '本次已自行起飛、側向上拋與收油調姿，從水平頂口落入、框內下降到低層，再實際反向飛回來向，最後恢復正飛。',
    observedGap: null, nextPractice: '再練一次，觀察上拋後的動量、頂口落點、低層高度及返出口位置，讓收油、調姿與改出更平順。', scopeNote: scope }
  if (result.outcome !== 'SUCCESS' && /墜毀|碰撞|Obstacle collision:|上鎖|失去焦點|無效|中斷|倒退|不一致|缺少|重設|跳躍|逾時/iu.test(result.message ?? '')) return {
    observedStrength: null, observedGap: gravityGateTrainingHint({ status: 'failure', message: result.message }),
    nextPractice: '下次先繞到右側進場點，帶速上拋至水平頂口上方；黃色頂口落入，框內下降後由青色低層出口折返。', scopeNote: scope }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return { observedStrength: null,
    observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定重力門表現。', nextPractice: `${RESTART}明確解鎖後自行起飛。`, scopeNote: scope }
  const objective = gravityGateObjective(metrics)
  return { observedStrength: hasPassageProof(metrics) ? '已觀察到同一次頂口落入、框內下降與低層折返，尚待確認正飛恢復。' : null,
    observedGap: result.outcome === 'SUCCESS' ? '完成標記缺少同一次上拋、頂口落入、框內下降、低層反向改出與恢復證據，不能判定通過。' : `尚未完成重力門。${objective.title}：${objective.detail}`,
    nextPractice: `${RESTART}從側邊前飛上拋、收油調姿，再依序完成頂口落入、框內下降與低層折返。`, scopeNote: scope }
}
