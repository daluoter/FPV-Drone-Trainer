import { coordinatedTurnTargetLabel, directionControlTargetLabel, trainingHint, trainingObjective } from './feedback'
import { LANDING_LIFTOFF_HEIGHT_M, LANDING_ZONE_RADIUS_M } from './landing'
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
