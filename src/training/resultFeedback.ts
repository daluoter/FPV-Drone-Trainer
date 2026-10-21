import { trainingHint } from './feedback'
import { LANDING_LIFTOFF_HEIGHT_M, LANDING_MAX_TOUCHDOWN_SPEED_MPS, LANDING_SETTLED_DWELL_SECONDS } from './landing'
import { STRAIGHT_LINE_SETTLED_DWELL_SECONDS, STRAIGHT_LINE_STOP_RADIUS_M } from './straightLine'
import { TAKEOFF_SETTLED_DWELL_SECONDS } from './takeoff'
import type { TrainingResult } from './types'

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
    { key: 'touchdownDescentSpeedMps', label: '接地前下降速度', unit: 'm/s', target: LANDING_MAX_TOUCHDOWN_SPEED_MPS, tip: '下一次在接地前提早減少下降速度，不要等碰地才修正油門。' },
    { key: 'horizontalSpeedMps', label: '水平速度', unit: 'm/s', target: 0.2, tip: '下一次先減少側移，接地後維持低油門並留在指定區。' },
    { key: 'contiguousDwellSeconds', label: '接地後連續穩定時間', unit: 's', target: LANDING_SETTLED_DWELL_SECONDS, minimum: true, tip: '下一次平穩接地後保持水平與低油門，等完成結果出現再 Disarm。' },
  ],
  'straight-line': [
    { key: 'stopErrorM', label: '終點偏差', unit: 'm', target: STRAIGHT_LINE_STOP_RADIUS_M, tip: '下一次進入減速區就開始小量反向傾斜，提早降低前進速度。' },
    { key: 'altitudeErrorM', label: '高度偏差', unit: 'm', target: 0.45, tip: '下一次前進或減速時同時觀察高度，用小量油門保持目標高度。' },
    { key: 'horizontalSpeedMps', label: '水平速度', unit: 'm/s', target: 0.35, tip: '下一次觀察實際速度下降後，再把機體帶回接近水平；回中不會自動煞停。' },
    { key: 'contiguousDwellSeconds', label: '終點連續穩定時間', unit: 's', target: STRAIGHT_LINE_SETTLED_DWELL_SECONDS, minimum: true, tip: '下一次在終點先穩住位置、速度與高度，再連續保持。' },
  ],
}

function amount(value: number, unit: string): string {
  return `${value.toFixed(unit === '°' ? 1 : 2)} ${unit}`
}

function scopeNote(result: TrainingResult): string {
  if (!result.attemptContext) return '本次缺少操控條件紀錄，不與新版條件成績直接比較。'
  return result.attemptContext.mode === 'practice'
    ? '引導練習與能力挑戰分開保存；完成一次目標不代表已熟練。'
    : '能力挑戰只比較相同條件的紀錄；完成一次挑戰不代表已熟練。'
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
      nextPractice: `先在起飛墊上方緩慢起飛，離地至少 ${LANDING_LIFTOFF_HEIGHT_M} m，再前往藍色降落區。`,
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
  if (!Number.isFinite(result.sampleCount) || result.sampleCount <= 0) {
    return {
      observedStrength: null,
      observedGap: '本次沒有有效的已解鎖飛行樣本，無法判定操控表現。',
      nextPractice: '確認畫面與控制器就緒，倒數完成後明確 Arm，再開始飛行。',
      scopeNote: scope,
    }
  }

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
