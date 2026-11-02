import type { TrainingObjective } from './feedback'
import type { TrainingResultFeedback } from './resultFeedback'
import type { TrainingEvaluation, TrainingResult } from './types'
import { SLALOM_AREA_RADIUS_M, SLALOM_BACKTRACK_ALLOWANCE_M, SLALOM_RECOVERY_SECONDS, SLALOM_TIME_LIMIT_SECONDS } from './slalom'
import { SLALOM_PASS_MIN_OFFSET_M, SLALOM_PASS_MAX_OFFSET_M, SLALOM_PASS_MIN_HEIGHT_M, SLALOM_PASS_MAX_HEIGHT_M, SLALOM_TARGET_HEIGHT_M } from '../world/slalomFlags'

type Metrics = Readonly<Record<string, number>>
const RESTART = '按「再練一次」，從地面自行起飛後重試。'
function observed(metrics: Metrics, key: string, unit: string): string {
  return Number.isFinite(metrics[key]) ? `${metrics[key].toFixed(1)} ${unit}` : '尚無有效量測'
}
function index(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 0 && value! < 6 ? value! : 0
}
const side = (flag: number): string => flag % 2 === 0 ? '左' : '右'
function complete(metrics: Metrics): boolean {
  return metrics.slalomPhase === 10 && metrics.slalomEpisodeValid > 0.5 && !(metrics.slalomInterrupted > 0.5)
    && metrics.slalomFlagsPassed === 6 && metrics.slalomExited > 0.5 && metrics.slalomRecovered > 0.5
    && metrics.slalomRecoveryQualifying > 0.5 && metrics.slalomRecoveryDwellSeconds + 1e-8 >= SLALOM_RECOVERY_SECONDS
}
export function slalomCollisionCause(warning: string): string | null {
  const match = /Obstacle collision: slalom-flag-([1-6])-banner/u.exec(warning)
  return match ? `第 ${match[1]} 面刀旗` : null
}
export function slalomRouteGuide(): string {
  return `地面自行起飛至約 ${SLALOM_TARGET_HEIGHT_M} m → 第一旗左側 → 第二旗右側 → 依序左、右交替通過六旗 → 繼續向前離場 → 修回正飛並恢復控制 ${SLALOM_RECOVERY_SECONDS} 秒。六旗間距 12 m，從起飛時的前進方向看，左側是 −X、右側是＋X；每旗在指定側距中心 ${SLALOM_PASS_MIN_OFFSET_M}～${SLALOM_PASS_MAX_OFFSET_M} m、離地 ${SLALOM_PASS_MIN_HEIGHT_M}～${SLALOM_PASS_MAX_HEIGHT_M} m 的範圍內通過即可。刀旗有實際碰撞，路徑只作引導；不用貼線、固定側立 90°、精準速度、懸停或降落。要改變實際航線，不能只原地左右晃機身；沿旗列一路向前，不回頭繞圈。走錯側、漏旗或回頭會保留第一個原因與當時量測，先前勾選保留，但仍須回第一旗前方至少 3 m 重新走完整路線。引導練習不限時，能力挑戰 ${SLALOM_TIME_LIMIT_SECONDS} 秒。`
}
export function slalomInterruptionReason(metrics: Metrics): string | null {
  if (!(metrics.slalomInterrupted > 0.5)) return null
  const flag = index(metrics.interruptionSlalomFlagIndex)
  const prefix = `第 ${flag + 1} 旗需要從${side(flag)}側通過。`
  switch (metrics.slalomInterruptionReason) {
    case 1: return '本段因接地中斷；地面移動不能代替連續空中 S 彎。'
    case 2: return `本段高度過低，中斷時離地 ${observed(metrics, 'interruptionSlalomAltitudeM', 'm')}；先保留飛行高度。`
    case 3: return `本段已離開起飛點半徑 ${SLALOM_AREA_RADIUS_M} m 的練習區。`
    case 4: return `${prefix}這次從另一側通過，當時相對指定側的偏移為 ${observed(metrics, 'interruptionSlalomSideOffsetM', 'm')}；下一次提前換邊，負值代表仍在錯側。`
    case 5: return `${prefix}這次太貼近旗中心，當時側向距離 ${observed(metrics, 'interruptionSlalomSideOffsetM', 'm')}；通過範圍為指定側 ${SLALOM_PASS_MIN_OFFSET_M}～${SLALOM_PASS_MAX_OFFSET_M} m，留空間給機體與槳。`
    case 6: return `${prefix}這次從太遠的外側繞過，當時側向距離 ${observed(metrics, 'interruptionSlalomSideOffsetM', 'm')}；回到指定側 ${SLALOM_PASS_MIN_OFFSET_M}～${SLALOM_PASS_MAX_OFFSET_M} m 內。`
    case 7: return `${prefix}通過當時離地 ${observed(metrics, 'interruptionSlalomAltitudeM', 'm')}，範圍是 ${SLALOM_PASS_MIN_HEIGHT_M}～${SLALOM_PASS_MAX_HEIGHT_M} m；不要從旗頂上方繞過。`
    case 8: return `${prefix}本次漏過此旗或從旗列中段開始；不能跳到下一旗接續計算。`
    case 9: return `本次向後退回 ${observed(metrics, 'interruptionSlalomBacktrackM', 'm')}，超過 ${SLALOM_BACKTRACK_ALLOWANCE_M} m 修正餘裕；這堂要沿旗列向前交替切彎，不回頭繞圈。`
    case 10: return `六旗後的離場位置超出走廊或高度範圍；當時離地 ${observed(metrics, 'interruptionSlalomAltitudeM', 'm')}。保持可控高度，向前飛過離場標記。`
    default: return '本段 S 彎已中斷，須重新依序通過六旗及向前離場。'
  }
}
export function slalomObjective(metrics: Metrics): TrainingObjective {
  const phase = metrics.slalomPhase ?? 0
  if (phase === 0) return { title: '1／10 起飛區地面準備', detail: '保持低油門，在起飛區實際接地並明確解鎖。' }
  if (phase === 1) return { title: '2／10 自行起飛', detail: '自行離地，建議高度約 4 m，第一旗從左側通過；不用先懸停。' }
  const interruption = slalomInterruptionReason(metrics)
  if (interruption) return { title: '本段已中斷，重新準備 S 彎', detail: `${interruption}先前勾選保留，本段仍須回第一旗前方至少 3 m，重新依序通過六旗；不要在錯過的位置回頭繞旗。` }
  if ((metrics.slalomFlagsPassed ?? 0) < 6) {
    const target = index(metrics.slalomTargetIndex)
    return { title: `${target + 3}／10 第 ${target + 1} 旗：${side(target)}側通過`,
      detail: `下一旗從${side(target)}側通過，距離 ${observed(metrics, 'slalomNextFlagDistanceM', 'm')}；相對指定側偏移 ${observed(metrics, 'slalomSideOffsetM', 'm')}（正值在指定側）。在指定側 1～8 m、離地 1～7 m 內通過即可，不用貼線或固定側立角度；持續向前，提前銜接下一彎。` }
  }
  if (!(metrics.slalomExited > 0.5)) return { title: '9／10 向前離開旗列', detail: `已依序交替通過六旗；繼續向前飛過離場標記，還有 ${observed(metrics, 'slalomNextFlagDistanceM', 'm')}，不用停住。` }
  return complete(metrics)
    ? { title: '10／10 刀旗 S 彎與恢復完成', detail: '已從地面自行起飛，依序左右交替通過六旗，向前離場並恢復控制；不用降落。' }
    : { title: '10／10 恢復正飛與控制', detail: '已向前離開旗列；減緩旋轉與升降、修回正飛，確認 0.2 秒。可以持續前進，不要求懸停或停止。' }
}
export function slalomTrainingHint(evaluation: Pick<TrainingEvaluation, 'status' | 'message' | 'hint' | 'metrics' | 'recovery'>): string {
  if (evaluation.status === 'failure') {
    const message = evaluation.message ?? ''
    const part = slalomCollisionCause(message)
    if (part) return `本次碰到${part}，練習已停止；下次提早換邊，替整架機體及槳保留距離。${RESTART}`
    if (/墜毀|碰撞|crash|impact/iu.test(message)) return `本次發生墜毀，練習已停止；先保留高度與刀旗側向空間。${RESTART}`
    if (/上鎖|失去焦點|斷線|disarm|focus/iu.test(message)) return `本次因上鎖、失去焦點或連線中斷而停止。${RESTART}`
    if (/逾時|timeout/iu.test(message)) return `本次能力挑戰逾時。${RESTART}`
    return `本次飛行資料無效、中斷或被重設，無法判定刀旗 S 彎。${RESTART}`
  }
  const objective = slalomObjective(evaluation.metrics ?? {})
  return `${objective.title}：${objective.detail}`
}
export function slalomResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'slalom') return null
  if (result.outcome === 'SUCCESS' && result.totalCheckpoints === 10 && result.completedCheckpoints === 10 && result.sampleCount > 0 && complete(result.metrics)) return {
    observedStrength: '本次已從地面自行起飛，在同一段向前航線依序左右交替通過六旗，再向前離場並恢復正飛。',
    observedGap: null, nextPractice: '再練一次，觀察每一旗前的換邊提前量與高度，讓 S 彎銜接更平順。', scopeNote: scope }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return { observedStrength: null, observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定刀旗 S 彎表現。', nextPractice: RESTART, scopeNote: scope }
  if (result.outcome !== 'SUCCESS' && /墜毀|碰撞|Obstacle collision:|上鎖|失去焦點|無效|中斷|倒退|不一致|缺少|重設|跳躍|逾時/iu.test(result.message ?? '')) return {
    observedStrength: null, observedGap: slalomTrainingHint({ status: 'failure', message: result.message }), nextPractice: RESTART, scopeNote: scope }
  const objective = slalomObjective(result.metrics)
  return { observedStrength: null,
    observedGap: result.outcome === 'SUCCESS' ? '完成標記缺少同一段完整六旗、向前離場與恢復證據，不能判定通過。' : `${objective.title}：${objective.detail}`,
    nextPractice: '從第一旗前方重新進場，依序左、右交替通過六旗，再向前飛離並恢復控制。', scopeNote: scope }
}
