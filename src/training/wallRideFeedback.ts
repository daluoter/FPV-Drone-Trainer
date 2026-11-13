import type { TrainingObjective } from './feedback'
import type { TrainingResultFeedback } from './resultFeedback'
import type { TrainingEvaluation, TrainingResult } from './types'
import { WALL_RIDE_AREA_RADIUS_M, WALL_RIDE_RECOVERY_SECONDS, WALL_RIDE_TIME_LIMIT_SECONDS } from './wallRide'
import { WALL_RIDE_COLLIDER_ID, WALL_RIDE_DISTANCE_M, WALL_RIDE_MAX_BELLY_ANGLE_DEGREES,
  WALL_RIDE_MAX_GAP_M, WALL_RIDE_MAX_HEIGHT_M, WALL_RIDE_MIN_GAP_M, WALL_RIDE_MIN_HEIGHT_M,
  WALL_RIDE_SECONDS, WALL_RIDE_TARGET_HEIGHT_M } from '../world/wallRide'

type Metrics = Readonly<Record<string, number>>
const RESTART = '按「再練一次」，從地面自行起飛後重試。'
const REENTER = '回到牆面近端前方，保留高度與間隙，再重新建立沿牆前進及機腹朝牆的完整一段。'
function observed(metrics: Metrics, key: string, unit: string): string {
  return Number.isFinite(metrics[key]) ? `${metrics[key].toFixed(1)}${unit === '°' ? '' : ' '}${unit}` : '尚無有效量測'
}
function complete(metrics: Metrics): boolean {
  const proofKeys = ['wallRidePhase', 'wallRideEpisodeValid', 'wallRideApproached', 'wallRideForwardEntered',
    'wallRideBellyFaced', 'wallRideRideComplete', 'wallRideLeft', 'wallRideRecovered', 'wallRideDistanceM',
    'wallRideSeconds', 'wallRideRecoveryQualifying', 'wallRideRecoveryDwellSeconds']
  return proofKeys.every((key) => Number.isFinite(metrics[key])) && metrics.wallRidePhase === 8 && metrics.wallRideEpisodeValid > 0.5 && !(metrics.wallRideInterrupted > 0.5)
    && metrics.wallRideApproached > 0.5 && metrics.wallRideForwardEntered > 0.5 && metrics.wallRideBellyFaced > 0.5
    && metrics.wallRideRideComplete > 0.5 && metrics.wallRideLeft > 0.5 && metrics.wallRideRecovered > 0.5
    && metrics.wallRideDistanceM + 1e-8 >= WALL_RIDE_DISTANCE_M && metrics.wallRideSeconds + 1e-8 >= WALL_RIDE_SECONDS
    && metrics.wallRideRecoveryQualifying > 0.5 && metrics.wallRideRecoveryDwellSeconds + 1e-8 >= WALL_RIDE_RECOVERY_SECONDS
}
export function wallRideCollisionCause(warning: string): string | null {
  return new RegExp(`Obstacle collision: ${WALL_RIDE_COLLIDER_ID}(?:$|[\\s;。；])`, 'u').test(warning) ? '騎牆練習牆面' : null
}
export function wallRideRouteGuide(): string {
  return `地面自行起飛至約 ${WALL_RIDE_TARGET_HEIGHT_M} m → 從右側牆面近端帶速進場 → 機腹朝向牆面 → 保留間隙沿牆向前至少 ${WALL_RIDE_DISTANCE_M} m，連續維持 ${WALL_RIDE_SECONDS} 秒 → 回正、離牆並恢復控制 ${WALL_RIDE_RECOVERY_SECONDS} 秒。牆面位於起飛點右側（＋X），沿牆前方為 −Z。有效騎牆段距牆 ${WALL_RIDE_MIN_GAP_M}～${WALL_RIDE_MAX_GAP_M} m、離地 ${WALL_RIDE_MIN_HEIGHT_M}～${WALL_RIDE_MAX_HEIGHT_M} m，機腹朝牆的夾角在 ${WALL_RIDE_MAX_BELLY_ANGLE_DEGREES}° 內；距牆數字以機體中心量測，仍須替整架機體及槳保留空間。牆體有實際碰撞，應保留間隙；不靠接觸、吸附或自動定高完成。沿牆實際位移與機腹方向都要符合，不要求固定側立 90°、精準速度、停住或降落。離牆時向外增加間隙，再修回正飛；路徑只作引導。局部中斷會保留第一個原因與當時數值，先前勾選不能代替新一段完整騎牆。引導練習不限時，能力挑戰 ${WALL_RIDE_TIME_LIMIT_SECONDS} 秒。`
}
export function wallRideInterruptionReason(metrics: Metrics): string | null {
  if (!(metrics.wallRideInterrupted > 0.5)) return null
  switch (metrics.wallRideInterruptionReason) {
    case 1: return '本段因接地中斷；須保持空中沿牆飛行，接地不能代替騎牆或改出。'
    case 2: return `本段高度過低，當時離地 ${observed(metrics, 'interruptionWallRideAltitudeM', 'm')}；先拉開地面改出空間。`
    case 3: return `已離開起飛點半徑 ${WALL_RIDE_AREA_RADIUS_M} m 的練習區。`
    case 4: return '本次未從牆面近端建立完整進場，或從牆體中段開始；須先沿牆建立前進位移，再連續完成騎牆。'
    case 5: return `這次離牆太近，當時距牆 ${observed(metrics, 'interruptionWallRideGapM', 'm')}；有效間隙為 ${WALL_RIDE_MIN_GAP_M}～${WALL_RIDE_MAX_GAP_M} m，留空間給機體與槳。`
    case 6: return `這次離牆太遠，當時距牆 ${observed(metrics, 'interruptionWallRideGapM', 'm')}；完成前須維持在 ${WALL_RIDE_MIN_GAP_M}～${WALL_RIDE_MAX_GAP_M} m 的近牆空間。`
    case 7: return `騎牆途中高度超出範圍，當時離地 ${observed(metrics, 'interruptionWallRideAltitudeM', 'm')}；有效高度為 ${WALL_RIDE_MIN_HEIGHT_M}～${WALL_RIDE_MAX_HEIGHT_M} m。`
    case 8: return `騎牆尚未完成就失去機腹朝牆姿態，當時夾角 ${observed(metrics, 'interruptionWallRideBellyAngleDegrees', '°')}，應在 ${WALL_RIDE_MAX_BELLY_ANGLE_DEGREES}° 內；本段已沿牆 ${observed(metrics, 'interruptionWallRideDistanceM', 'm')}、維持 ${observed(metrics, 'interruptionWallRideSeconds', 's')}。`
    case 9: return '本段明顯向後退回；騎牆須沿牆向前持續移動，不能回頭拼接先前的距離。'
    case 10: return `尚未完成就越過牆面遠端；本段已沿牆 ${observed(metrics, 'interruptionWallRideDistanceM', 'm')}、維持 ${observed(metrics, 'interruptionWallRideSeconds', 's')}，須完成至少 ${WALL_RIDE_DISTANCE_M} m 及 ${WALL_RIDE_SECONDS} 秒後再改出。`
    default: return '本段騎牆已中斷，須重新建立進場、機腹朝牆、連續沿牆移動與離牆改出。'
  }
}
export function wallRideObjective(metrics: Metrics): TrainingObjective {
  const interruption = wallRideInterruptionReason(metrics)
  if (interruption) return { title: '本段已中斷，重新準備騎牆', detail: `${interruption}${REENTER}先前勾選保留，但本次沿牆距離與時間須來自新的連續一段。` }
  const phase = metrics.wallRidePhase ?? 0
  if (phase === 0) return { title: '1／8 起飛區地面準備', detail: '保持低油門，在起飛區實際接地並明確解鎖。' }
  if (phase === 1) return { title: '2／8 自行起飛', detail: `自行起飛至約 ${WALL_RIDE_TARGET_HEIGHT_M} m，替側傾、下沉與改出保留空間，不用先定點懸停。` }
  if (phase === 2) return { title: '3／8 對準牆面近端進場', detail: '前往右側實體牆面的近端，保留間隙與高度，準備沿牆向前飛行。' }
  if (phase === 3) return { title: '4／8 建立沿牆前進', detail: `沿牆面向前建立實際位移；當前前進速度 ${observed(metrics, 'wallRideForwardSpeedMps', 'm/s')}，先有動量再側傾，不要求精準速度或停住。` }
  if (phase === 4) return { title: '5／8 機腹朝向牆面', detail: `逐漸側傾，讓機腹朝向右側牆面；當前夾角 ${observed(metrics, 'wallRideBellyAngleDegrees', '°')}，有效範圍為 ${WALL_RIDE_MAX_BELLY_ANGLE_DEGREES}° 內。保留距牆 ${WALL_RIDE_MIN_GAP_M}～${WALL_RIDE_MAX_GAP_M} m 的空間，不要求固定側立 90°。` }
  if (phase === 5) return { title: '6／8 保留間隙沿牆飛行', detail: `已沿牆 ${observed(metrics, 'wallRideDistanceM', 'm')}／${WALL_RIDE_DISTANCE_M} m，維持 ${observed(metrics, 'wallRideSeconds', 's')}／${WALL_RIDE_SECONDS} s；目前距牆 ${observed(metrics, 'wallRideGapM', 'm')}。保持機腹朝牆及向前實際位移，允許自然下沉，留意高度。` }
  if (phase === 6) return { title: '7／8 回正並向外離牆', detail: `騎牆段已完成，逐步回正並向遠離牆面的方向拉開間隙；目前距牆 ${observed(metrics, 'wallRideGapM', 'm')}。離牆至少增加 1 m，並達到 5.5 m 以上，不要求最低離牆速度。` }
  if (phase >= 8 && !complete(metrics)) return { title: '騎牆完成證據不足', detail: '仍須同一段有效進場、機腹朝牆、沿牆距離與時間、離牆及恢復控制的完整證據。' }
  return complete(metrics)
    ? { title: '8／8 騎牆與恢復完成', detail: '已保留間隙沿牆飛行，回正離牆並恢復控制；不用停住或降落。' }
    : { title: '8／8 恢復正飛與控制', detail: `已向外離牆；修回正飛，減緩旋轉與升降，確認 ${WALL_RIDE_RECOVERY_SECONDS} 秒即可。可持續前進，不要求懸停或降落。` }
}
export function wallRideTrainingHint(evaluation: Pick<TrainingEvaluation, 'status' | 'message' | 'hint' | 'metrics' | 'recovery'>): string {
  if (evaluation.status === 'failure') {
    const message = evaluation.message ?? ''
    const part = wallRideCollisionCause(message)
    if (part) return `本次碰到${part}，練習已停止；下次保留間隙並提早回正離牆，碰牆不能算完成。${RESTART}`
    if (/墜毀|碰撞|crash|impact/iu.test(message)) return `本次發生墜毀，練習已停止；先保留高度與距牆空間。${RESTART}`
    if (/上鎖|失去焦點|斷線|disarm|focus/iu.test(message)) return `本次因上鎖、失去焦點或連線中斷而停止。${RESTART}`
    if (/逾時|timeout/iu.test(message)) return `本次能力挑戰逾時。${RESTART}`
    return `本次飛行資料無效、中斷或被重設，無法判定騎牆。${RESTART}`
  }
  const objective = wallRideObjective(evaluation.metrics ?? {})
  return `${objective.title}：${objective.detail}`
}
export function wallRideResultFeedback(result: TrainingResult, scope: string): TrainingResultFeedback | null {
  if (result.lessonId !== 'wall-ride') return null
  if (result.outcome === 'SUCCESS' && result.totalCheckpoints === 8 && result.completedCheckpoints === 8 && Number.isFinite(result.sampleCount) && result.sampleCount > 0 && complete(result.metrics)) return {
    observedStrength: '本次已從地面自行起飛，在同一段進場中讓機腹朝牆、保留間隙沿牆移動，再向外離牆並恢復正飛。',
    observedGap: null, nextPractice: '再練一次，觀察帶速進場、距牆變化與回正時機，讓沿牆及改出更平順。', scopeNote: scope }
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) return { observedStrength: null, observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定騎牆表現。', nextPractice: RESTART, scopeNote: scope }
  if (result.outcome !== 'SUCCESS' && /墜毀|碰撞|Obstacle collision:|上鎖|失去焦點|無效|中斷|倒退|不一致|缺少|重設|跳躍|逾時/iu.test(result.message ?? '')) return {
    observedStrength: null, observedGap: wallRideTrainingHint({ status: 'failure', message: result.message }), nextPractice: RESTART, scopeNote: scope }
  return { observedStrength: null,
    observedGap: result.outcome === 'SUCCESS' ? '完成標記缺少同一段進場、機腹朝牆、沿牆距離與時間、離牆及恢復證據，不能判定通過。' : `${wallRideObjective(result.metrics).title}：${wallRideObjective(result.metrics).detail}`,
    nextPractice: `${REENTER}完成後再回正離牆，不必降落。`, scopeNote: scope }
}
