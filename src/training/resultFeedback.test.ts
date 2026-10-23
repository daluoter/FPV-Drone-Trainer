import { describe, expect, it } from 'vitest'
import { summarizeTrainingResult } from './resultFeedback'
import type { TrainingResult } from './types'
import type { TrainingAttemptContext } from './attempt'

const result: TrainingResult = {
  lessonId: 'hover', sessionId: 'feedback', outcome: 'FAILED', score: 0,
  elapsedSeconds: 4, sampleCount: 960, completedCheckpoints: 1, totalCheckpoints: 3,
  startedAtSeconds: 0, completedAtSeconds: 4, metrics: {}, message: 'Stopped', hint: null,
}

const currentContext: TrainingAttemptContext = {
  rulesVersion: 4, physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}',
  inputSource: 'keyboard', mode: 'practice', assistance: 'none',
}

describe('observed result coaching', () => {
  it('reports the largest measured final deviation with one concrete action', () => {
    const feedback = summarizeTrainingResult({ ...result, metrics: { altitudeErrorM: 1.3, horizontalSpeedMps: 0.2 } })
    expect(feedback.observedStrength).toContain('水平速度 0.20 m/s')
    expect(feedback.observedGap).toContain('結束時高度偏差為 1.30 m')
    expect(feedback.nextPractice).toContain('小量油門')
    expect(feedback.observedGap).not.toContain('因為')
  })

  it('does not infer flight skill from an aborted attempt or missing metrics', () => {
    const empty = summarizeTrainingResult({ ...result, sampleCount: 0, completedCheckpoints: 0 })
    expect(empty.observedStrength).toBeNull()
    expect(empty.observedGap).toContain('沒有有效')
    const missing = summarizeTrainingResult({ ...result, completedCheckpoints: 0, metrics: { altitudeErrorM: Number.NaN } })
    expect(missing.observedStrength).toBeNull()
    expect(missing.observedGap).toContain('3 個步驟未完成')
  })

  it('does not treat the initial zero touchdown speed as an actual landing', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'landing', completedCheckpoints: 0,
      attemptContext: currentContext,
      metrics: { touchdownDescentSpeedMps: 0, groundTouching: 0, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).toContain('尚未完成從起飛墊實際離地')
    expect(feedback.nextPractice).toContain('起飛')
  })

  it('keeps completion and mastery distinct even with all checkpoints completed', () => {
    const feedback = summarizeTrainingResult({ ...result, outcome: 'SUCCESS', completedCheckpoints: 3 })
    expect(feedback.observedStrength).toContain('3 / 3')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('相同條件再練一次')
  })

  it('does not classify the initial eight-metre target distance or zero speed as stopping or landing skill', () => {
    for (const [lessonId, metrics] of [
      ['straight-line', { routePhase: 0, stopErrorM: 8, horizontalSpeedMps: 0, contiguousDwellSeconds: 0 }],
      ['landing', { landingPhase: 1, landingPositionErrorM: 8, horizontalSpeedMps: 0, touchdownDescentSpeedMps: 0, groundTouching: 1 }],
    ] as const) {
      const feedback = summarizeTrainingResult({ ...result, lessonId, metrics, completedCheckpoints: 0 })
      expect(feedback.observedStrength).toBeNull()
      expect(feedback.observedGap).not.toMatch(/終點偏差|落點偏差|下降速度/)
      expect(feedback.nextPractice).toContain('起飛')
    }
  })

  it('names the next missed ring instead of requiring braking or a stop', () => {
    const gold = summarizeTrainingResult({ ...result, lessonId: 'straight-line', attemptContext: currentContext,
      metrics: { routePhase: 2, gatesPassed: 1, stopErrorM: 2, horizontalSpeedMps: 4 } })
    expect(gold.observedStrength).toContain('1 / 3 個圓環')
    expect(gold.observedGap).toContain('第 2 個金色圓環')
    expect(gold.nextPractice).toContain('已完成的圈會保留')
    expect(gold.nextPractice).not.toMatch(/減速區|降低.*速度|停穩/)
  })

  it('does not apply old precision thresholds after a successful noncrash landing or ring flight', () => {
    const landing = summarizeTrainingResult({ ...result, lessonId: 'landing', attemptContext: currentContext,
      outcome: 'SUCCESS', completedCheckpoints: 5, totalCheckpoints: 5,
      metrics: { landingPhase: 4, landingPositionErrorM: 1.2, touchdownDescentSpeedMps: 1.2,
        horizontalSpeedMps: 0.8, maxTiltDegrees: 20, contiguousDwellSeconds: 0, groundTouching: 1 } })
    expect(landing.observedStrength).toContain('接地且沒有墜毀')
    expect(landing.observedGap).toBeNull()
    expect(landing.nextPractice).not.toMatch(/0.80|連續.*秒|穩定時間/)
    const straight = summarizeTrainingResult({ ...result, lessonId: 'straight-line', attemptContext: currentContext,
      outcome: 'SUCCESS', completedCheckpoints: 5, totalCheckpoints: 5,
      metrics: { routePhase: 4, gatesPassed: 3, horizontalSpeedMps: 7, altitudeErrorM: 1.3, contiguousDwellSeconds: 0 } })
    expect(straight.observedStrength).toContain('三個圓環')
    expect(straight.observedGap).toBeNull()
    expect(straight.nextPractice).not.toMatch(/0.35|連續.*秒|停點/)
  })

  it('distinguishes a wrong-zone landing from a physical crash and keeps the retry local', () => {
    const wrongZone = summarizeTrainingResult({ ...result, lessonId: 'landing', attemptContext: currentContext,
      metrics: { landingPhase: 2, landingPositionErrorM: 2, groundTouching: 1 } })
    expect(wrongZone.observedGap).toContain('2.00 m')
    expect(wrongZone.observedGap).toContain('半徑 1.50 m')
    expect(wrongZone.nextPractice).toContain('可直接再起飛重試')
    const crashed = summarizeTrainingResult({ ...result, lessonId: 'landing', attemptContext: currentContext,
      message: '降落停止：墜毀不能當作成功接地。',
      metrics: { landingPhase: 3, landingPositionErrorM: 0.1, groundTouching: 1 } })
    expect(crashed.observedGap).toContain('發生墜毀')
  })

  it.each(['straight-line', 'landing'])('preserves the explicit %s crash cause when runtime metrics are unavailable', (lessonId) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId, attemptContext: currentContext,
      message: 'Ground impact latched a crash; reset required.', metrics: {} })
    expect(feedback.observedGap).toContain('發生墜毀')
    expect(feedback.observedGap).not.toContain('尚未完成從地面')
    expect(feedback.nextPractice).toContain('Reset')
  })

  it('keeps historical rule-3 results on their original criteria', () => {
    const historical = summarizeTrainingResult({ ...result, lessonId: 'straight-line',
      attemptContext: { ...currentContext, rulesVersion: 3 }, metrics: { routePhase: 2, stopErrorM: 2 } })
    expect(historical.observedGap).toContain('尚未在金色減速區完成實際降速')
    expect(historical.nextPractice).toContain('觀察前進速度確實降低')
    expect(historical.scopeNote).toContain('舊規則 3')
    const historicalLanding = summarizeTrainingResult({ ...result, lessonId: 'landing',
      attemptContext: { ...currentContext, rulesVersion: 3 }, metrics: { landingPhase: 4,
        landingPositionErrorM: 0.3, groundTouching: 1, touchdownDescentSpeedMps: 1.2, contiguousDwellSeconds: 1 } })
    expect(historicalLanding.observedGap).toContain('接地前下降速度')
    expect(historicalLanding.observedGap).toContain('0.80 m/s')
  })

  it('uses observed L05 progress to name the next unfinished direction goal', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'direction-control', attemptContext: currentContext,
      completedCheckpoints: 4, totalCheckpoints: 9,
      metrics: { directionPhase: 4, directionTargetIndex: 2, directionTargetsCompleted: 2,
        targetDistanceM: 3.2, horizontalSpeedMps: 5, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('2 / 7 個方向目標')
    expect(feedback.observedGap).toContain('「向前移動」')
    expect(feedback.observedGap).toContain('3.2 m')
    expect(feedback.nextPractice).toContain('不需重做已完成的目標')
    expect(feedback.nextPractice).not.toMatch(/0.35|速度過快|連續.*秒/)
  })

  it('distinguishes missing L05 yaw from moving without claiming completion from input', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'direction-control', attemptContext: currentContext,
      metrics: { directionPhase: 6, directionTargetIndex: 4, directionTargetsCompleted: 4,
        headingChangeDegrees: 10, headingErrorDegrees: 80 } })
    expect(feedback.observedGap).toContain('尚未完成實際偏航換向')
    expect(feedback.observedGap).toContain('已轉 10°')
    expect(feedback.observedGap).toContain('距新朝向 80°')
    expect(feedback.nextPractice).toContain('單純側移不能代替換向')
  })

  it('does not misclassify an explicit L05 crash or missing progress as failure to take off', () => {
    const crashed = summarizeTrainingResult({ ...result, lessonId: 'direction-control', attemptContext: currentContext,
      sampleCount: 0, message: 'Ground impact latched a crash; reset required.', metrics: {} })
    expect(crashed.observedGap).toContain('發生墜毀')
    expect(crashed.nextPractice).toContain('Reset')
    expect(crashed.observedGap).not.toContain('尚未完成從地面')
    const missing = summarizeTrainingResult({ ...result, lessonId: 'direction-control', metrics: {} })
    expect(missing.observedGap).toContain('分段資料不足')
    expect(missing.observedStrength).toBeNull()
    expect(missing.observedGap).not.toContain('尚未完成從地面')
  })

  it('reports L05 completion without adding speed or dwell requirements or mastery', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'direction-control', attemptContext: currentContext,
      outcome: 'SUCCESS', completedCheckpoints: 9, totalCheckpoints: 9,
      metrics: { directionPhase: 9, directionTargetsCompleted: 7, horizontalSpeedMps: 6, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('實際偏航換向')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('目前機頭的哪一側')
    expect(feedback.scopeNote).toContain('不代表已熟練')
  })

  it('names a partial L06 target and retains progress without applying historical corridor limits', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'coordinated-turn',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 3, totalCheckpoints: 8,
      metrics: { turnPhase: 3, turnTargetIndex: 1, turnTargetsCompleted: 1, targetDistanceM: 2.4,
        turnEntryRecorded: 1, headingErrorDegrees: 10, routeCorridorErrorM: 15, speedMps: 20 } })
    expect(feedback.observedStrength).toContain('1 / 6 個轉彎目標')
    expect(feedback.observedGap).toContain('右轉轉彎點')
    expect(feedback.observedGap).toContain('尚餘 5 個轉彎目標')
    expect(feedback.observedGap).toContain('距該目標 2.4 m')
    expect(feedback.nextPractice).toContain('已完成的目標會保留')
    expect(feedback.observedGap).not.toMatch(/3.20|速度|走廊/)
  })

  it('distinguishes the actual left-turn exit blocker from a yaw or speed requirement', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'coordinated-turn',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 7, totalCheckpoints: 8,
      metrics: { turnPhase: 7, turnTargetIndex: 5, turnTargetsCompleted: 5, turnEntryRecorded: 1,
        turnMotionReady: 1, headingErrorDegrees: 5, targetDistanceM: 0.1, turnChangeDegrees: -10 } })
    expect(feedback.observedStrength).toContain('右轉航線已完成')
    expect(feedback.observedGap).toContain('左轉出口')
    expect(feedback.observedGap).toContain('相反方向轉了 10°')
    expect(feedback.observedGap).toContain('朝左轉至少 25°')
    expect(feedback.nextPractice).toContain('讓移動方向朝左轉')
  })

  it('describes new L06 completion separately from the old three-gate criteria', () => {
    const metrics = { turnPhase: 8, turnTargetsCompleted: 6, routeCorridorErrorM: 5, headingChangeDegrees: 15, contiguousDwellSeconds: 0 }
    const completed = summarizeTrainingResult({ ...result, lessonId: 'coordinated-turn',
      attemptContext: { ...currentContext, rulesVersion: 5 }, outcome: 'SUCCESS', completedCheckpoints: 8, totalCheckpoints: 8, metrics })
    expect(completed.observedStrength).toContain('右轉與左轉')
    expect(completed.observedGap).toBeNull()
    expect(completed.nextPractice).not.toMatch(/55|3.20|連續.*秒/)
    expect(completed.scopeNote).toContain('不代表已熟練')
    const historical = summarizeTrainingResult({ ...result, lessonId: 'coordinated-turn', attemptContext: currentContext, metrics })
    expect(historical.observedGap).toMatch(/3.20 m|55.0 °/)
    expect(historical.nextPractice).toContain('舊版單彎航線紀錄')
    expect(historical.scopeNote).toContain('舊規則 4')
    expect(historical.observedStrength).not.toContain('右轉與左轉')
  })

  it('keeps a grounded L06 result tied to its current target and a local relaunch', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'coordinated-turn',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 4, totalCheckpoints: 8,
      metrics: { turnPhase: 4, turnTargetIndex: 2, turnTargetsCompleted: 2, groundTouching: 1,
        groundClearanceM: 0, turnChangeDegrees: 0, turnMotionReady: 0 } })
    expect(feedback.observedGap).toContain('右轉出口')
    expect(feedback.observedGap).toContain('結束時尚未在空中')
    expect(feedback.nextPractice).toContain('目前位置再次自行起飛')
    expect(feedback.nextPractice).toContain('已完成的目標會保留')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '發生墜毀'],
    ['Attempt disarmed because focus was lost.', '解除解鎖、失去焦點'],
    ['轉彎練習停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
  ])('preserves the L06 terminal cause with zero samples: %s', (message, expected) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'coordinated-turn',
      attemptContext: { ...currentContext, rulesVersion: 5 }, sampleCount: 0, metrics: {}, message })
    expect(feedback.observedGap).toContain(expected)
    expect(feedback.observedGap).not.toContain('沒有有效的已解鎖飛行樣本')
    expect(feedback.observedStrength).toBeNull()
  })

  it('does not invent a takeoff failure when L06 stage metrics are missing', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'coordinated-turn',
      attemptContext: { ...currentContext, rulesVersion: 5 }, metrics: {} })
    expect(feedback.observedGap).toContain('分段資料不足')
    expect(feedback.observedGap).not.toContain('尚未完成從地面')
    expect(feedback.observedStrength).toBeNull()
  })

  it('reports L07 four-leg completion without adding a landing, speed or dwell goal', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      attemptContext: { ...currentContext, rulesVersion: 5 }, outcome: 'SUCCESS',
      completedCheckpoints: 10, totalCheckpoints: 10,
      metrics: { squarePhase: 10, squareTargetsCompleted: 8, squareLegsCompleted: 4,
        horizontalSpeedMps: 12, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('四段方形航線')
    expect(feedback.observedStrength).toContain('回到起點上方')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('不需降落或停穩')
    expect(feedback.scopeNote).toContain('不代表已熟練')
  })

  it('names the next L07 leg from measured progress without applying unrelated route precision goals', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 6, totalCheckpoints: 10,
      metrics: { squarePhase: 6, squareTargetIndex: 4, squareTargetsCompleted: 4, squareLegsCompleted: 2,
        targetDistanceM: 6, targetRightM: 0, targetForwardM: 6, targetUpM: 0,
        headingErrorDegrees: 10, horizontalSpeedMps: 15, routeCorridorErrorM: 20, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('4 / 8 個方形目標')
    expect(feedback.observedStrength).toContain('2 / 4 段航線')
    expect(feedback.observedGap).toContain('第 3 段直線')
    expect(feedback.observedGap).toContain('尚餘 4 個方形目標')
    expect(feedback.observedGap).toContain('6.0 m')
    expect(feedback.nextPractice).toContain('從地面重新開始')
    expect(feedback.nextPractice).toContain('直線目標')
    expect(feedback.observedGap).not.toMatch(/速度|航廊|停留/)
  })

  it('explains an L07 heading blocker using its current leg and observed angle', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 4, totalCheckpoints: 10,
      metrics: { squarePhase: 4, squareTargetIndex: 2, squareTargetsCompleted: 2,
        headingErrorDegrees: 110, targetDistanceM: 0.1 } })
    expect(feedback.observedStrength).toContain('1 / 4 段航線')
    expect(feedback.observedGap).toContain('第 2 段直線')
    expect(feedback.observedGap).toContain('110°')
    expect(feedback.observedGap).toContain('70° 內')
    expect(feedback.nextPractice).toContain('偏航')
  })

  it('distinguishes an L07 timeout result from continuing a grounded active attempt', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      message: '方形航線挑戰逾時：尚未完成四邊與返回起點上方。',
      attemptContext: { ...currentContext, rulesVersion: 5, mode: 'challenge' }, completedCheckpoints: 8, totalCheckpoints: 10,
      metrics: { squarePhase: 8, squareTargetIndex: 6, squareTargetsCompleted: 6, squareLegsCompleted: 3,
        groundTouching: 1, groundClearanceM: 0, headingErrorDegrees: 130 } })
    expect(feedback.observedStrength).toContain('3 / 4 段航線')
    expect(feedback.observedGap).toContain('第 4 段直線')
    expect(feedback.observedGap).toContain('結束時尚未在空中')
    expect(feedback.observedGap).toContain('挑戰逾時')
    expect(feedback.observedGap).not.toContain('130°')
    expect(feedback.nextPractice).toContain('再練一次')
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).not.toContain('保留')
    expect(feedback.nextPractice).not.toContain('目前位置')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '發生墜毀'],
    ['Attempt disarmed because focus was lost.', '解除解鎖、失去焦點'],
    ['方形練習停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
    ['方形練習停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效或中斷'],
  ])('preserves the explicit L07 terminal cause with zero samples: %s', (message, expected) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      attemptContext: { ...currentContext, rulesVersion: 5 }, sampleCount: 0, metrics: {}, message })
    expect(feedback.observedGap).toContain(expected)
    expect(feedback.observedGap).not.toContain('沒有有效的已解鎖飛行樣本')
    expect(feedback.observedStrength).toBeNull()
  })

  it('distinguishes missing L07 stage evidence from an observed failure to take off', () => {
    const missing = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      attemptContext: { ...currentContext, rulesVersion: 5 }, metrics: {} })
    expect(missing.observedStrength).toBeNull()
    expect(missing.observedGap).toContain('分段資料不足')
    expect(missing.observedGap).not.toContain('尚未完成從地面')
    const initial = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      attemptContext: { ...currentContext, rulesVersion: 5 }, metrics: { squarePhase: 1, squareTargetsCompleted: 0 } })
    expect(initial.observedGap).toContain('尚未完成從地面自行起飛')
    expect(initial.nextPractice).toContain('不需要先懸停')
    const aborted = summarizeTrainingResult({ ...result, lessonId: 'square-route', sampleCount: 0, metrics: {} })
    expect(aborted.observedGap).toContain('沒有有效的已解鎖飛行樣本')
  })

  it('identifies the final L07 target as airborne return rather than a landing', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'square-route',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 9, totalCheckpoints: 10,
      metrics: { squarePhase: 9, squareTargetIndex: 7, squareTargetsCompleted: 7,
        squareLegsCompleted: 3, headingErrorDegrees: 0, targetDistanceM: 2 } })
    expect(feedback.observedGap).toContain('返回起點上方')
    expect(feedback.observedGap).toContain('尚餘 1 個方形目標')
    expect(feedback.nextPractice).toMatch(/不必|不需要|不需/)
    expect(feedback.nextPractice).toContain('降落')
  })

  it('reports L08 left/right completion at the central airborne finish without new precision goals', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 }, outcome: 'SUCCESS',
      completedCheckpoints: 11, totalCheckpoints: 11,
      metrics: { eightPhase: 11, eightTargetsCompleted: 9, eightLoopsCompleted: 2,
        horizontalSpeedMps: 15, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('左環、中央換向與右環')
    expect(feedback.observedStrength).toContain('中央空中終點')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('不需降落或停穩')
    expect(feedback.scopeNote).toContain('不代表已熟練')
  })

  it('names an unfinished L08 left-loop target from measured progress', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 5, totalCheckpoints: 11,
      metrics: { eightPhase: 5, eightTargetIndex: 3, eightTargetsCompleted: 3, eightLoopsCompleted: 0,
        targetDistanceM: 4.2, headingErrorDegrees: 5, horizontalSpeedMps: 20, routeCorridorErrorM: 30 } })
    expect(feedback.observedStrength).toContain('3 / 9 個八字目標')
    expect(feedback.observedStrength).not.toContain('左環已完成')
    expect(feedback.observedGap).toContain('左圈回程')
    expect(feedback.observedGap).toContain('尚餘 6 個八字目標')
    expect(feedback.observedGap).toContain('4.2 m')
    expect(feedback.nextPractice).toContain('再練一次')
    expect(feedback.nextPractice).toContain('沿左環')
    expect(feedback.observedGap).not.toMatch(/速度|航廊|停留/)
  })

  it('keeps the repeated L08 center crossing distinct from the later central finish', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 6, totalCheckpoints: 11,
      metrics: { eightPhase: 6, eightTargetIndex: 4, eightTargetsCompleted: 4, eightLoopsCompleted: 0,
        targetDistanceM: 2, headingErrorDegrees: 0 } })
    expect(feedback.observedGap).toContain('中央換向點')
    expect(feedback.observedGap).toContain('尚餘 5 個八字目標')
    expect(feedback.observedGap).not.toContain('中央終點')
    expect(feedback.observedStrength).not.toContain('左環已完成')
    expect(feedback.nextPractice).toContain('把左轉切換成右轉')
    expect(feedback.nextPractice).not.toContain('已完成的目標會保留')
  })

  it('identifies the completed left loop while the L08 right loop remains unfinished', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 8, totalCheckpoints: 11,
      metrics: { eightPhase: 8, eightTargetIndex: 6, eightTargetsCompleted: 6, eightLoopsCompleted: 1,
        targetDistanceM: 3, headingErrorDegrees: 0 } })
    expect(feedback.observedStrength).toContain('1 / 2 環')
    expect(feedback.observedStrength).toContain('左環已完成')
    expect(feedback.observedGap).toContain('右圈外側')
    expect(feedback.observedGap).toContain('尚餘 3 個八字目標')
    expect(feedback.nextPractice).toContain('沿右環')
  })

  it('explains a measured L08 nose-heading blocker without inventing a motion-angle goal', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 },
      metrics: { eightPhase: 7, eightTargetIndex: 5, eightTargetsCompleted: 5, eightLoopsCompleted: 1,
        headingErrorDegrees: 110, targetDistanceM: 0.1, turnChangeDegrees: 0 } })
    expect(feedback.observedGap).toContain('右圈前段')
    expect(feedback.observedGap).toContain('110°')
    expect(feedback.observedGap).toContain('70° 內')
    expect(feedback.nextPractice).toContain('偏航配合傾斜')
    expect(feedback.observedGap).not.toContain('25°')
  })

  it('ends a grounded L08 timeout with explicit restart instructions rather than active progress retention', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5, mode: 'challenge' },
      message: '八字航線挑戰逾時：尚未完成左右兩圈。', elapsedSeconds: 301,
      completedCheckpoints: 9, totalCheckpoints: 11,
      metrics: { eightPhase: 9, eightTargetIndex: 7, eightTargetsCompleted: 7, eightLoopsCompleted: 1,
        groundTouching: 1, groundClearanceM: 0, headingErrorDegrees: 130 } })
    expect(feedback.observedStrength).toContain('左環已完成')
    expect(feedback.observedGap).toContain('挑戰逾時')
    expect(feedback.observedGap).toContain('右圈回程')
    expect(feedback.observedGap).toContain('結束時尚未在空中')
    expect(feedback.observedGap).not.toContain('130°')
    expect(feedback.nextPractice).toContain('再練一次')
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).toContain('從地面重新開始')
    expect(feedback.nextPractice).not.toContain('保留')
    expect(feedback.nextPractice).not.toContain('目前位置')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '發生墜毀'],
    ['Attempt disarmed because focus was lost.', '解除解鎖、失去焦點'],
    ['八字練習停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
    ['八字練習停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效或中斷'],
  ])('preserves the explicit L08 terminal cause even without samples: %s', (message, expected) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 }, sampleCount: 0, metrics: {}, message })
    expect(feedback.observedGap).toContain(expected)
    expect(feedback.observedGap).not.toContain('沒有有效的已解鎖飛行樣本')
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.nextPractice).toContain('再練一次')
    expect(feedback.nextPractice).toContain('清空本次步驟')
  })

  it('distinguishes absent L08 stage evidence from measured failure to take off', () => {
    const missing = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 }, metrics: {} })
    expect(missing.observedGap).toContain('分段資料不足')
    expect(missing.observedGap).not.toContain('尚未完成從地面')
    expect(missing.observedStrength).toBeNull()
    expect(missing.nextPractice).toContain('從地面重新開始')
    const initial = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      metrics: { eightPhase: 1, eightTargetsCompleted: 0, eightLoopsCompleted: 0 } })
    expect(initial.observedGap).toContain('尚未完成從地面自行起飛')
    expect(initial.nextPractice).toContain('不需要先懸停')
    const aborted = summarizeTrainingResult({ ...result, lessonId: 'figure-eight', sampleCount: 0, metrics: {} })
    expect(aborted.observedGap).toContain('沒有有效的已解鎖飛行樣本')
    expect(aborted.observedStrength).toBeNull()
    expect(aborted.nextPractice).toContain('清空本次步驟')
  })

  it('describes the final L08 central airborne goal as distinct from the original launch', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'figure-eight',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 10, totalCheckpoints: 11,
      metrics: { eightPhase: 10, eightTargetIndex: 8, eightTargetsCompleted: 8,
        eightLoopsCompleted: 1, headingErrorDegrees: 0, targetDistanceM: 1.2 } })
    expect(feedback.observedGap).toContain('中央終點')
    expect(feedback.observedGap).toContain('尚餘 1 個八字目標')
    expect(feedback.nextPractice).toContain('起飛點前方 6 m')
    expect(feedback.nextPractice).toContain('不是原起飛點')
    expect(feedback.nextPractice).toContain('不需降落或停穩')
    expect(feedback.nextPractice).toContain('清空本次步驟')
  })

})
