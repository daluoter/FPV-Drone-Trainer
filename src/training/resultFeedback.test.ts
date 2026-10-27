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

  it('reports an L09 pass as three actual forward crossings, without speed or mastery goals', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate', outcome: 'SUCCESS',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 5, totalCheckpoints: 5,
      metrics: { gatePhase: 5, gateTargetIndex: 3, gatesPassed: 3, horizontalSpeedMps: 40,
        headingErrorDegrees: 179, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('從地面自行起飛')
    expect(feedback.observedStrength).toContain('依序向前穿過三道寬門')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('為機身、槳葉保留間距')
    expect(feedback.nextPractice).toContain('不需降落或停穩')
    expect(feedback.scopeNote).toContain('不代表已熟練')
    expect(feedback.observedStrength).not.toMatch(/速度|179|熟練/)
  })

  it('records completed L09 gates while identifying the missed current gate from signed observations', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate',
      attemptContext: { ...currentContext, rulesVersion: 5 }, completedCheckpoints: 3, totalCheckpoints: 5,
      metrics: { gatePhase: 3, gateTargetIndex: 1, gatesPassed: 1, nextGateDistanceM: -4,
        nextGateHorizontalErrorM: -3.2, nextGateVerticalErrorM: 2.8,
        horizontalSpeedMps: 30, headingErrorDegrees: 175, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('1 / 3 道寬門')
    expect(feedback.observedGap).toContain('尚未穿過第 2 道寬門')
    expect(feedback.observedGap).toContain('尚餘 2 道門')
    expect(feedback.observedGap).toContain('已在該門後方 4.0 m')
    expect(feedback.observedGap).toContain('未記錄有效的正向門洞穿越')
    expect(feedback.observedGap).toContain('門洞左側外，偏離中心 3.2 m')
    expect(feedback.observedGap).toContain('門洞上方外，偏離中心 2.8 m')
    expect(feedback.observedGap).not.toMatch(/速度|175|停留|碰到第/)
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).toContain('下次先在門前對準門洞中心')
    expect(feedback.nextPractice).toContain('反向穿越不算')
    expect(feedback.nextPractice).not.toContain('保留')
  })

  it('keeps an L09 target still ahead distinct from a missed gate behind and ignores absolute errors', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate',
      metrics: { gatePhase: 2, gateTargetIndex: 0, gatesPassed: 0, nextGateDistanceM: 5,
        nextGateErrorM: 40, targetDistanceM: 10, nextGateHorizontalErrorM: Number.NaN,
        nextGateVerticalErrorM: Infinity } })
    expect(feedback.observedStrength).toContain('從地面自行起飛')
    expect(feedback.observedGap).toContain('仍在該門前 5.0 m')
    expect(feedback.observedGap).not.toMatch(/門後方|左側外|右側外|上方外|下方外|NaN|Infinity|40/)
  })

  it('does not label a grounded L09 timeout as a crash or promise retained progress on retry', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate',
      attemptContext: { ...currentContext, rulesVersion: 5, mode: 'challenge' },
      message: '寬門穿越挑戰逾時：尚未完成三道寬門。', elapsedSeconds: 241,
      completedCheckpoints: 4, totalCheckpoints: 5,
      metrics: { gatePhase: 4, gateTargetIndex: 2, gatesPassed: 2, groundTouching: 1,
        groundClearanceM: 0, nextGateDistanceM: -2, nextGateHorizontalErrorM: 8 } })
    expect(feedback.observedStrength).toContain('2 / 3 道寬門')
    expect(feedback.observedGap).toContain('挑戰逾時')
    expect(feedback.observedGap).toContain('尚未穿過第 3 道寬門')
    expect(feedback.observedGap).toContain('結束時尚未在空中')
    expect(feedback.observedGap).not.toMatch(/墜毀|門後方|右側外/)
    expect(feedback.nextPractice).toContain('再練一次')
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).toContain('從地面重新開始')
    expect(feedback.nextPractice).not.toMatch(/保留|目前位置/)
  })

  it.each([1, 2, 3].flatMap((gate) => [
    ['left-post', '左柱'], ['right-post', '右柱'], ['top-bar', '上橫樑'], ['bottom-bar', '下橫樑'],
  ].map(([part, label]) => [gate, part, label] as const)))('prioritizes actual gate %s %s collision even with no samples', (gate, part, label) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate',
      sampleCount: 0, metrics: {}, message: `Obstacle collision: wide-gate-${gate}-${part}; reset required.` })
    expect(feedback.observedGap).toContain(`碰到第 ${gate} 道門的${label}`)
    expect(feedback.observedGap).toContain('墜毀')
    expect(feedback.observedGap).not.toContain('沒有有效的已解鎖飛行樣本')
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.nextPractice).toContain('Reset')
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).not.toContain('保留')
  })

  it('reports a hit on an earlier L09 gate rather than inventing a hit on the current target', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate', sampleCount: 0,
      metrics: { gatePhase: 4, gateTargetIndex: 2, gatesPassed: 2 },
      message: 'Obstacle collision: wide-gate-1-bottom-bar; reset required.' })
    expect(feedback.observedGap).toContain('碰到第 1 道門的下橫樑')
    expect(feedback.observedGap).not.toContain('第 3 道門')
    expect(feedback.observedStrength).toBeNull()
  })

  it.each([
    'Obstacle collision: wide-gate-4-left-post; reset required.',
    'Obstacle collision: wide-gate-1-left-post-extra; reset required.',
    'Obstacle collision: wide-gate-2-unknown; reset required.',
    'Obstacle collision: another-box; reset required.',
  ])('does not invent a specific L09 frame part from an unknown collision: %s', (message) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate', sampleCount: 0,
      metrics: { gatePhase: 3, gateTargetIndex: 1 }, message })
    expect(feedback.observedGap).toContain('撞到障礙物並墜毀')
    expect(feedback.observedGap).toContain('無法判定碰到哪一道門')
    expect(feedback.observedGap).not.toMatch(/碰到第 [123] 道門/)
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '地面撞擊造成墜毀'],
    ['Attempt disarmed because focus was lost.', '解除解鎖、失去焦點'],
    ['寬門穿越停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
    ['寬門穿越停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效或中斷'],
  ])('preserves the explicit L09 stop cause before missing samples or stage facts: %s', (message, cause) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'wide-gate', sampleCount: 0,
      metrics: {}, message })
    expect(feedback.observedGap).toContain(cause)
    expect(feedback.observedGap).not.toMatch(/碰到第|沒有有效的已解鎖飛行樣本/)
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.nextPractice).toContain('清空本次步驟')
  })

  it('distinguishes absent L09 phase evidence from an observed failure to take off', () => {
    const missing = summarizeTrainingResult({ ...result, lessonId: 'wide-gate', metrics: {} })
    expect(missing.observedGap).toContain('分段資料不足')
    expect(missing.observedGap).not.toContain('尚未完成從地面')
    expect(missing.observedStrength).toBeNull()
    expect(missing.nextPractice).toContain('從地面重新開始')
    const initial = summarizeTrainingResult({ ...result, lessonId: 'wide-gate',
      metrics: { gatePhase: 1, gatesPassed: 0 } })
    expect(initial.observedGap).toContain('尚未完成從地面自行起飛')
    expect(initial.nextPractice).toContain('不需要先懸停')
    const noSamples = summarizeTrainingResult({ ...result, lessonId: 'wide-gate', sampleCount: 0,
      metrics: {}, message: '寬門穿越挑戰逾時。' })
    expect(noSamples.observedGap).toContain('挑戰逾時')
    expect(noSamples.observedGap).toContain('沒有有效的已解鎖飛行樣本')
    expect(noSamples.nextPractice).toContain('清空本次步驟')
  })

})

describe('L10 observed recovery results', () => {
  const recoveryResult: TrainingResult = { ...result, lessonId: 'basic-recovery', totalCheckpoints: 8,
    attemptContext: { ...currentContext, rulesVersion: 6 }, message: 'Stopped',
    metrics: { recoveryPhase: 2, exercisesCompleted: 0, exerciseReady: 0, currentEpisodeValid: 0,
      episodeInterrupted: 0, altitudeM: 6, groundTouching: 0, insideRecoveryArea: 1 } }

  it('reports the three actual error/recovery pairs without claiming mastery or precise position holding', () => {
    const feedback = summarizeTrainingResult({ ...recoveryResult, outcome: 'SUCCESS', completedCheckpoints: 8,
      metrics: { recoveryPhase: 8, exercisesCompleted: 3 } })
    expect(feedback.observedStrength).toContain('實際製造並修正傾斜、下沉與漂移')
    expect(feedback.observedStrength).toContain('從地面自行起飛')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('相同條件再練一次')
    expect(feedback.nextPractice).toContain('不需回到原位置或降落')
    expect(feedback.scopeNote).toContain('不代表已熟練')
  })

  it('does not infer takeoff or recovery skill from missing phase evidence or no samples', () => {
    const unknown = summarizeTrainingResult({ ...recoveryResult, metrics: {} })
    expect(unknown.observedStrength).toBeNull()
    expect(unknown.observedGap).toContain('分段資料不足')
    expect(unknown.observedGap).not.toContain('尚未完成從地面')
    const ground = summarizeTrainingResult({ ...recoveryResult, metrics: { recoveryPhase: 1 } })
    expect(ground.observedStrength).toBeNull()
    expect(ground.observedGap).toContain('尚未完成從地面自行起飛並取得練習高度')
    const none = summarizeTrainingResult({ ...recoveryResult, sampleCount: 0, outcome: 'SUCCESS',
      metrics: { recoveryPhase: 8, exercisesCompleted: 3 } })
    expect(none.observedStrength).toBeNull()
    expect(none.observedGap).toContain('沒有有效的已解鎖飛行樣本')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '本次發生墜毀'],
    ['Obstacle collision: unexpected-box; reset required.', '本次發生墜毀'],
    ['Attempt disarmed because focus was lost.', '解除解鎖、失去焦點'],
    ['失誤恢復停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效、中斷或被重設'],
    ['失誤恢復停止：缺少有效的地面接觸資料。', '飛行資料無效、中斷或被重設'],
  ])('preserves explicit cause before stage performance or missing samples: %s', (message, cause) => {
    const feedback = summarizeTrainingResult({ ...recoveryResult, sampleCount: 0, message,
      metrics: { recoveryPhase: 7, exercisesCompleted: 2, currentEpisodeValid: 1, horizontalSpeedMps: 4 } })
    expect(feedback.observedGap).toContain(cause)
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).not.toMatch(/水平速度|沒有有效的已解鎖飛行樣本/)
    expect(feedback.nextPractice).toContain('再練一次')
    expect(feedback.nextPractice).toContain('清空本次步驟')
  })

  it('identifies incomplete preparation and ready-onset separately without crediting input gestures', () => {
    const prepare = summarizeTrainingResult(recoveryResult)
    expect(prepare.observedGap).toContain('尚未完成本項的準備確認')
    expect(prepare.observedGap).not.toContain('已記錄本項偏差')
    const ready = summarizeTrainingResult({ ...recoveryResult,
      metrics: { ...recoveryResult.metrics, exerciseReady: 1 } })
    expect(ready.observedGap).toContain('已準備完成，但尚未偵測到本項實際傾斜')
    expect(ready.observedGap).toContain('只推動搖桿不能代替飛行狀態')
    expect(ready.observedStrength).not.toContain('恢復練習')
  })

  it('names the incomplete recovery and final measured tilt and rate without guessing its cause', () => {
    const feedback = summarizeTrainingResult({ ...recoveryResult, metrics: { ...recoveryResult.metrics,
      recoveryPhase: 3, currentEpisodeValid: 1, tiltDegrees: 17, bodyRateDegreesPerSecond: 100,
      recoveryDwellSeconds: 0 } })
    expect(feedback.observedGap).toContain('尚未完成「主動修回水平」')
    expect(feedback.observedGap).toContain('結束時傾角 17.0°')
    expect(feedback.observedGap).toContain('100.0°/s 旋轉')
    expect(feedback.observedGap).not.toContain('因為')
    expect(feedback.nextPractice).toContain('回中會停止旋轉，回到水平需要主動修正')
  })

  it('distinguishes excessive upward velocity from recovered sinking and reports the final signed speed', () => {
    const feedback = summarizeTrainingResult({ ...recoveryResult, metrics: { ...recoveryResult.metrics,
      recoveryPhase: 5, exercisesCompleted: 1, currentEpisodeValid: 1, verticalSpeedMps: 2.1,
      tiltDegrees: 0, bodyRateDegreesPerSecond: 0, recoveryDwellSeconds: 0 } })
    expect(feedback.observedStrength).toContain('1 / 3 項恢復練習')
    expect(feedback.observedGap).toContain('升降速度 2.1 m/s（上＋／下−）')
    expect(feedback.observedGap).toContain('−0.2～+2 m/s 內')
    expect(feedback.observedGap).not.toContain('仍在下沉')
  })

  it('does not classify a brief speed reduction with a tilted body as complete drift recovery', () => {
    const feedback = summarizeTrainingResult({ ...recoveryResult, metrics: { ...recoveryResult.metrics,
      recoveryPhase: 7, exercisesCompleted: 2, currentEpisodeValid: 1,
      horizontalSpeedMps: 0.4, verticalSpeedMps: 0, tiltDegrees: 22,
      bodyRateDegreesPerSecond: 0, recoveryDwellSeconds: 0.1 } })
    expect(feedback.observedStrength).toContain('2 / 3 項恢復練習')
    expect(feedback.observedGap).toContain('機身仍傾斜 22.0°')
    expect(feedback.observedGap).toContain('恢復確認 0.10／0.25 s')
    expect(feedback.nextPractice).toContain('反方向適度傾斜減速')
    expect(feedback.nextPractice).toContain('回中不會自動煞停')
  })

  it('allows modest climb in sink results and applies each exercise tilt limit', () => {
    const sink = summarizeTrainingResult({ ...recoveryResult, metrics: { ...recoveryResult.metrics,
      recoveryPhase: 5, currentEpisodeValid: 1, verticalSpeedMps: 1.5, tiltDegrees: 20,
      bodyRateDegreesPerSecond: 60, recoveryDwellSeconds: 0.1 } })
    expect(sink.observedGap).toContain('恢復確認 0.10／0.25 s')
    expect(sink.observedGap).not.toMatch(/升降速度|機身仍傾斜|仍以/)
    expect(sink.nextPractice).toContain('容許適度爬升')
  })

  it.each([5, undefined] as const)('keeps historical/unknown-rule results separate from eased comparisons: %s', (version) => {
    const historical = { ...recoveryResult, attemptContext: version === undefined ? undefined
      : { ...currentContext, rulesVersion: version }, metrics: { recoveryPhase: 5, currentEpisodeValid: 1,
        exercisesCompleted: 1, verticalSpeedMps: -0.4, tiltDegrees: 20, recoveryDwellSeconds: 0.3 } }
    const before = JSON.stringify(historical)
    const feedback = summarizeTrainingResult(historical)
    expect(feedback.observedGap).toContain('保留當時結果')
    expect(feedback.observedGap).not.toMatch(/−0.2|25°|0.25/)
    expect(feedback.scopeNote).toContain('沒有以新版門檻重新評分')
    expect(feedback.nextPractice).toContain('分開保存')
    expect(JSON.stringify(historical)).toBe(before)
    const success = summarizeTrainingResult({ ...historical, outcome: 'SUCCESS', completedCheckpoints: 8 })
    expect(success.observedStrength).toContain('原始完成結果保留')
    expect(success.observedGap).toBeNull()
  })

  it.each([
    [{ groundTouching: 1, altitudeM: 0.06 }, '碰地停住不能算空中恢復'],
    [{ altitudeM: 0.8 }, '未保留恢復需要的 1 m 高度餘裕'],
    [{ currentEpisodeValid: 0, episodeInterrupted: 1 }, '先前的偏差已中斷'],
    [{ insideRecoveryArea: 0 }, '恢復確認已暫停'],
  ] as const)('reports episode interruption or pause without promising retained progress after terminal retry: %j', (changes, cause) => {
    const feedback = summarizeTrainingResult({ ...recoveryResult,
      message: '失誤恢復挑戰逾時：尚未完成三種實際偏差與恢復。',
      metrics: { ...recoveryResult.metrics, recoveryPhase: 5, exercisesCompleted: 1,
        currentEpisodeValid: 1, ...changes } })
    expect(feedback.observedGap).toContain('挑戰逾時')
    expect(feedback.observedGap).toContain(cause)
    expect(feedback.observedStrength).toContain('1 / 3 項恢復練習')
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).toContain('從地面重新開始')
    expect(feedback.nextPractice).not.toMatch(/保留|就地|繼續本項/)
  })
})

describe('L10 observed complete-roll results', () => {
  const rollResult: TrainingResult = { ...result, lessonId: 'full-roll', totalCheckpoints: 6,
    attemptContext: { ...currentContext, rulesVersion: 6 }, completedCheckpoints: 3,
    metrics: { rollPhase: 3, rollEpisodeValid: 1, rollProgressDegrees: 0, rollDirection: 0,
      rollInverted: 0, rollCompleted: 0, rollInterrupted: 0, groundTouching: 0,
      insideRollArea: 1, altitudeM: 10, tiltDegrees: 0, bodyRateDegreesPerSecond: 0,
      horizontalSpeedMps: 0, verticalSpeedMps: 0, recoveryDwellSeconds: 0 } }

  it('reports measured full-turn and airborne recovery without implying mastery or requiring a landing', () => {
    const feedback = summarizeTrainingResult({ ...rollResult, outcome: 'SUCCESS', completedCheckpoints: 6,
      metrics: { ...rollResult.metrics, rollPhase: 6, rollCompleted: 1, rollInverted: 1, rollProgressDegrees: 359 } })
    expect(feedback.observedStrength).toContain('同一圈的實際倒置、完整橫滾')
    expect(feedback.observedStrength).toContain('空中正飛與控制恢復')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('熟悉後再練另一側')
    expect(feedback.nextPractice).toContain('不需要回到原位置或降落')
    expect(feedback.scopeNote).toContain('不代表已熟練')
  })

  it('does not infer rotation, liftoff or completion from absent phase data or zero samples', () => {
    const unknown = summarizeTrainingResult({ ...rollResult, metrics: {} })
    expect(unknown.observedStrength).toBeNull()
    expect(unknown.observedGap).toContain('分段資料不足')
    expect(unknown.observedGap).not.toContain('尚未完成從地面')
    const ground = summarizeTrainingResult({ ...rollResult, metrics: { rollPhase: 1 } })
    expect(ground.observedStrength).toBeNull()
    expect(ground.observedGap).toContain('尚未完成從地面自行起飛並取得橫滾練習高度')
    const none = summarizeTrainingResult({ ...rollResult, sampleCount: 0, outcome: 'SUCCESS', completedCheckpoints: 6,
      metrics: { rollPhase: 6, rollCompleted: 1 } })
    expect(none.observedStrength).toBeNull()
    expect(none.observedGap).toContain('沒有有效的已解鎖飛行樣本')
  })

  it('keeps preparation, real partial rotation and the inverted milestone distinct', () => {
    const preparing = summarizeTrainingResult({ ...rollResult,
      metrics: { ...rollResult.metrics, rollPhase: 2, rollEpisodeValid: 0 } })
    expect(preparing.observedGap).toContain('尚未完成橫滾前的短暫準備')
    const partial = summarizeTrainingResult({ ...rollResult, metrics: { ...rollResult.metrics, rollProgressDegrees: 97 } })
    expect(partial.observedGap).toContain('本圈橫滾進度約 97.0°')
    expect(partial.observedGap).toContain('尚未觀察到這一圈的實際倒置與完整橫滾')
    expect(partial.observedStrength).not.toContain('倒置姿態')
    const inverted = summarizeTrainingResult({ ...rollResult, metrics: { ...rollResult.metrics,
      rollPhase: 4, rollInverted: 1, rollProgressDegrees: 184 } })
    expect(inverted.observedStrength).toContain('這一圈的實際倒置姿態')
    expect(inverted.observedGap).toContain('尚未沿同一方向完成一圈並回正')
    expect(inverted.observedGap).toContain('倒置後反向翻回不等於完成')
    expect(inverted.observedStrength).not.toContain('完整橫滾')
  })

  it('does not reuse invalidated inversion or upright milestones as a new valid rotation', () => {
    const feedback = summarizeTrainingResult({ ...rollResult, completedCheckpoints: 5,
      metrics: { ...rollResult.metrics, rollPhase: 5, rollEpisodeValid: 0, rollInterrupted: 1,
        rollInverted: 0, rollCompleted: 0, rollProgressDegrees: 0 } })
    expect(feedback.observedGap).toContain('先前這一圈已中斷')
    expect(feedback.observedGap).toContain('歷史倒置或回正標記不代替新一圈')
    expect(feedback.observedStrength).not.toContain('實際倒置姿態')
    expect(feedback.observedStrength).not.toContain('一圈完整橫滾')
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).not.toMatch(/(?:步驟|進度)[^。；]*保留|保留[^。；]*(?:步驟|進度)/)
  })

  it('reports the actual tilt and unfinished hold after a valid complete turn', () => {
    const feedback = summarizeTrainingResult({ ...rollResult, metrics: { ...rollResult.metrics,
      rollPhase: 5, rollInverted: 1, rollCompleted: 1, rollProgressDegrees: 350,
      tiltDegrees: 30, recoveryDwellSeconds: 0.1 } })
    expect(feedback.observedStrength).toContain('已觀察到一圈完整橫滾')
    expect(feedback.observedGap).toContain('結束時傾角 30.0°')
    expect(feedback.observedGap).toContain('恢復確認 0.10／0.25 s')
    expect(feedback.nextPractice).toContain('回中不會自動回平或煞停')
    expect(feedback.observedGap).not.toContain('因為')
  })

  it('allows modest climb during recovery but names an excessive signed vertical speed', () => {
    const climb = { ...rollResult.metrics, rollPhase: 5, rollInverted: 1, rollCompleted: 1,
      rollProgressDegrees: 358, verticalSpeedMps: 2, recoveryDwellSeconds: 0.12 }
    expect(summarizeTrainingResult({ ...rollResult, metrics: climb }).observedGap).not.toContain('升降速度')
    expect(summarizeTrainingResult({ ...rollResult, metrics: { ...climb, verticalSpeedMps: 4 } }).observedGap)
      .toContain('升降速度 4.0 m/s（上＋／下−），尚未回到 −1.5～+3 m/s')
  })

  it.each([
    [{ groundTouching: 1 }, '地面停住不能算空中恢復'],
    [{ altitudeM: 1.1 }, '未保留空中恢復需要的 1.5 m 高度'],
    [{ insideRollArea: 0 }, '超出起飛點半徑 60 m'],
  ] as const)('records an interrupted episode on timeout without promising retained checkpoints on retry: %j', (changes, reason) => {
    const feedback = summarizeTrainingResult({ ...rollResult,
      message: '橫滾挑戰逾時：尚未完成完整橫滾與空中恢復。', metrics: { ...rollResult.metrics, ...changes } })
    expect(feedback.observedGap).toContain('挑戰逾時')
    expect(feedback.observedGap).toContain(reason)
    expect(feedback.nextPractice).toContain('從地面重新開始')
    expect(feedback.nextPractice).not.toMatch(/(?:步驟|進度)[^。；]*保留|保留[^。；]*(?:步驟|進度)|就地/)
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '本次發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['橫滾停止：姿態與角速度不一致。', '飛行資料無效、中斷或被重設'],
    ['橫滾停止：缺少有效的地面接觸資料。', '飛行資料無效、中斷或被重設'],
  ])('preserves the explicit terminal cause before missing samples or partial skill: %s', (message, reason) => {
    const feedback = summarizeTrainingResult({ ...rollResult, message, sampleCount: 0,
      metrics: { ...rollResult.metrics, rollPhase: 5, rollInverted: 1, rollCompleted: 1 } })
    expect(feedback.observedGap).toContain(reason)
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).not.toContain('沒有有效的已解鎖飛行樣本')
    expect(feedback.nextPractice).toContain('清空本次步驟')
  })
})

describe('captured roll interruption in terminal summaries', () => {
  it.each([
    [4, { interruptionOffAxisDegrees: 126 }, '俯仰／偏航旋轉累積約 126.0°'],
    [5, {}, '這一圈持續過轉'],
    [6, {}, '這一圈反向轉過了起始姿態'],
  ] as const)('preserves the actual interrupted-maneuver cause without reviving historical inversion: %s', (reason, captured, expected) => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'full-roll', totalCheckpoints: 6,
      completedCheckpoints: 4, attemptContext: { ...currentContext, rulesVersion: 6 },
      message: '橫滾挑戰逾時：尚未完成完整橫滾與空中恢復。',
      metrics: { rollPhase: 4, rollInterrupted: 1, rollInterruptionReason: reason, rollEpisodeValid: 0,
        rollInverted: 0, rollCompleted: 0, altitudeM: 10, insideRollArea: 1, groundTouching: 0, ...captured } })
    expect(feedback.observedGap).toContain(expected)
    expect(feedback.observedGap).toContain('挑戰逾時')
    expect(feedback.observedStrength).not.toContain('實際倒置姿態')
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).not.toContain('本次先前步驟保留')
  })
})

describe('L11 observed front and back flip results', () => {
  const flipResult: TrainingResult = { ...result, lessonId: 'full-flip', totalCheckpoints: 6,
    completedCheckpoints: 3, attemptContext: { ...currentContext, rulesVersion: 6 },
    metrics: { flipPhase: 3, flipEpisodeValid: 1, flipProgressDegrees: 0, flipDirection: 0,
      flipInverted: 0, flipCompleted: 0, flipInterrupted: 0, groundTouching: 0,
      insideFlipArea: 1, altitudeM: 10, tiltDegrees: 0, bodyRateDegreesPerSecond: 0,
      horizontalSpeedMps: 0, verticalSpeedMps: 0, recoveryDwellSeconds: 0 } }

  it.each([[1, '前翻'], [-1, '後翻']] as const)('reports only the measured completed direction %s and airborne recovery', (direction, label) => {
    const feedback = summarizeTrainingResult({ ...flipResult, outcome: 'SUCCESS', completedCheckpoints: 6,
      metrics: { ...flipResult.metrics, flipPhase: 6, flipCompleted: 1, flipInverted: 1,
        flipDirection: direction, flipProgressDegrees: 359 } })
    expect(feedback.observedStrength).toContain(`實際倒置與${label}一整圈`)
    expect(feedback.observedStrength).toContain('空中正飛與控制恢復')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('熟悉後再練另一方向')
    expect(feedback.nextPractice).toContain('不需要回到原位置或降落')
    expect(feedback.scopeNote).toContain('不代表已熟練')
    expect(JSON.stringify(feedback)).not.toMatch(/Roll|Pitch|Yaw|Flip|倒飛/)
  })

  it('does not infer success, inversion or liftoff from absent observations', () => {
    const missing = summarizeTrainingResult({ ...flipResult, metrics: {} })
    expect(missing.observedStrength).toBeNull()
    expect(missing.observedGap).toContain('分段資料不足')
    expect(missing.observedGap).not.toContain('尚未完成從地面')
    const inconsistent = summarizeTrainingResult({ ...flipResult, outcome: 'SUCCESS', completedCheckpoints: 6,
      metrics: { flipPhase: 6 } })
    expect(inconsistent.observedStrength).toBeNull()
    expect(inconsistent.observedGap).toContain('分段資料不足')
    const none = summarizeTrainingResult({ ...flipResult, outcome: 'SUCCESS', sampleCount: 0,
      completedCheckpoints: 6, metrics: { flipPhase: 6, flipInverted: 1, flipCompleted: 1 } })
    expect(none.observedStrength).toBeNull()
    expect(none.observedGap).toContain('沒有有效的已解鎖飛行樣本')
    const ground = summarizeTrainingResult({ ...flipResult, metrics: { flipPhase: 1 } })
    expect(ground.observedStrength).toBeNull()
    expect(ground.observedGap).toContain('尚未完成從地面自行起飛並取得翻轉練習高度')
  })

  it('keeps preparation, partial pitch rotation and inversion distinct', () => {
    const prepare = summarizeTrainingResult({ ...flipResult,
      metrics: { ...flipResult.metrics, flipPhase: 2, flipEpisodeValid: 0 } })
    expect(prepare.observedGap).toContain('尚未完成翻轉前的短暫準備')
    const partial = summarizeTrainingResult({ ...flipResult,
      metrics: { ...flipResult.metrics, flipProgressDegrees: 97, flipDirection: 1 } })
    expect(partial.observedGap).toContain('本圈翻轉進度約 97.0°')
    expect(partial.observedGap).toContain('尚未觀察到這一圈的實際倒置與完整翻轉')
    expect(partial.observedStrength).not.toContain('倒置姿態')
    const inverted = summarizeTrainingResult({ ...flipResult,
      metrics: { ...flipResult.metrics, flipPhase: 4, flipProgressDegrees: 184, flipInverted: 1 } })
    expect(inverted.observedStrength).toContain('這一圈的實際倒置姿態')
    expect(inverted.observedGap).toContain('尚未沿同一方向完成一圈並回正')
    expect(inverted.observedGap).toContain('倒置後反向翻回不等於完成')
    expect(inverted.observedStrength).not.toContain('一圈完整翻轉')
  })

  it('reports measured recovery blockers using the more permissive flip limits', () => {
    const recoveredTurn = { ...flipResult.metrics, flipPhase: 5, flipInverted: 1,
      flipCompleted: 1, flipProgressDegrees: 356, recoveryDwellSeconds: 0.08 }
    const tilt = summarizeTrainingResult({ ...flipResult,
      metrics: { ...recoveredTurn, tiltDegrees: 37 } })
    expect(tilt.observedStrength).toContain('已觀察到一圈完整翻轉')
    expect(tilt.observedGap).toContain('結束時傾角 37.0°，需修回 30° 內')
    expect(tilt.observedGap).toContain('恢復確認 0.08／0.20 s')
    expect(tilt.nextPractice).toContain('回中不會自動回平或煞停')
    const acceptedClimb = summarizeTrainingResult({ ...flipResult,
      metrics: { ...recoveredTurn, verticalSpeedMps: 3.8, horizontalSpeedMps: 7 } })
    expect(acceptedClimb.observedGap).not.toMatch(/升降速度|水平速度/)
    const sink = summarizeTrainingResult({ ...flipResult,
      metrics: { ...recoveredTurn, verticalSpeedMps: -3.2 } })
    expect(sink.observedGap).toContain('升降速度 -3.2 m/s（上＋／下−），尚未回到 −2.5～+4 m/s')
  })

  it.each([
    [1, {}, '這一圈曾接地'],
    [2, { interruptionAltitudeM: 1.1 }, '中斷時離地 1.1 m'],
    [3, { interruptionLaunchDistanceM: 85 }, '中斷時距起飛點 85.0 m'],
    [4, { interruptionOffAxisDegrees: 126 }, '橫滾／偏航旋轉累積約 126.0°'],
    [5, {}, '這一圈持續過轉'],
    [6, {}, '這一圈反向轉過了起始姿態'],
    [7, { interruptionAltitudeM: 7.8 }, '尚未開始翻轉便降到離地 7.8 m'],
  ] as const)('retains interruption evidence on timeout without reviving historical milestones: %s', (reason, captured, expected) => {
    const feedback = summarizeTrainingResult({ ...flipResult, completedCheckpoints: 5,
      message: '翻轉挑戰逾時：尚未完成完整翻轉與空中恢復。',
      metrics: { ...flipResult.metrics, flipPhase: 5, flipEpisodeValid: 0,
        flipInterrupted: 1, flipInterruptionReason: reason, flipInverted: 1, flipCompleted: 1,
        ...captured } })
    expect(feedback.observedGap).toContain(expected)
    expect(feedback.observedGap).toContain('挑戰逾時')
    expect(feedback.observedGap).toContain('歷史倒置或回正標記不代替新一圈')
    expect(feedback.observedStrength).not.toMatch(/實際倒置姿態|一圈完整翻轉/)
    expect(feedback.nextPractice).toContain('清空本次步驟')
    expect(feedback.nextPractice).not.toMatch(/步驟保留|就地/)
  })

  it.each([
    [{ groundTouching: 1 }, '地面停住不能算空中恢復'],
    [{ altitudeM: 1.2 }, '未保留空中恢復需要的 1.5 m 高度'],
    [{ insideFlipArea: 0 }, '超出起飛點半徑 80 m'],
  ] as const)('reports current grounding or envelope facts without inventing a recorded interruption: %j', (changes, expected) => {
    const feedback = summarizeTrainingResult({ ...flipResult,
      metrics: { ...flipResult.metrics, ...changes } })
    expect(feedback.observedGap).toContain(expected)
    expect(feedback.nextPractice).toContain('從地面重新開始')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '本次發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['翻轉停止：姿態與角速度不一致。', '飛行資料無效、中斷或被重設'],
    ['翻轉停止：缺少有效的地面接觸資料。', '飛行資料無效、中斷或被重設'],
  ])('prioritizes the terminal stop cause over missing samples or stale completed flags: %s', (message, cause) => {
    const feedback = summarizeTrainingResult({ ...flipResult, message, sampleCount: 0,
      metrics: { ...flipResult.metrics, flipPhase: 5, flipInverted: 1, flipCompleted: 1 } })
    expect(feedback.observedGap).toContain(cause)
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).not.toContain('沒有有效的已解鎖飛行樣本')
    expect(feedback.nextPractice).toContain('清空本次步驟')
  })
})

describe('separate directional flip results', () => {
  const complete = { flipPhase: 6, flipEpisodeValid: 1, flipCompleted: 1, flipInverted: 1,
    flipDirection: 1, flipRequiredDirection: 1, flipProgressDegrees: 360, flipInterrupted: 0 }
  const courses = [['front-flip', 1, '前翻', '後翻'], ['back-flip', -1, '後翻', '前翻']] as const
  const directedResult = (lessonId: string, metrics: Readonly<Record<string, number>>): TrainingResult => ({
    ...result, lessonId, totalCheckpoints: 6, completedCheckpoints: 6, outcome: 'SUCCESS',
    attemptContext: { ...currentContext, rulesVersion: 6 }, metrics,
  })

  it.each(courses)('recognizes only the measured matching direction for %s', (id, direction, expected) => {
    const feedback = summarizeTrainingResult(directedResult(id, { ...complete,
      flipDirection: direction, flipRequiredDirection: -direction }))
    expect(feedback.observedStrength).toContain(`實際倒置與${expected}一整圈`)
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain(`再練一次${expected}`)
    expect(feedback.nextPractice).toContain('另一方向須在另一堂課獨立完成')
  })

  it.each(courses)('does not turn an opposite full rotation or stale requirement into %s credit', (id, direction, expected, opposite) => {
    const feedback = summarizeTrainingResult(directedResult(id, { ...complete,
      flipDirection: -direction, flipRequiredDirection: -direction }))
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).toContain(`本課練${expected}；本次觀察到${opposite}約 360.0°`)
    expect(feedback.observedGap).toContain('不能計入本課')
    expect(feedback.nextPractice).toContain('先回正重新準備')
    expect(feedback.nextPractice).toContain(`以${expected}完成同一方向的一整圈`)
  })

  it.each(courses)('does not derive the missing measured direction from required-direction metadata in %s', (id, direction) => {
    const feedback = summarizeTrainingResult(directedResult(id, { ...complete,
      flipDirection: 0, flipRequiredDirection: direction }))
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).toContain('分段資料不足')
    expect(feedback.observedGap).not.toContain('已完成')
  })

  it.each(courses)('reports captured direction errors on timeout in %s', (id, direction, expected, opposite) => {
    const feedback = summarizeTrainingResult({ ...directedResult(id, { ...complete,
      flipPhase: 5, flipEpisodeValid: 0, flipDirection: 0, flipRequiredDirection: -direction,
      flipInterrupted: 1, flipInterruptionReason: 8, interruptionFlipDirection: -direction,
      interruptionFlipProgressDegrees: 21.7 }), outcome: 'FAILED', message: '翻轉挑戰逾時。' })
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).toContain('本次挑戰逾時')
    expect(feedback.observedGap).toContain(`本課練${expected}`)
    expect(feedback.observedGap).toContain(`中斷時往${opposite}約 21.7°`)
    expect(feedback.nextPractice).toContain('清空本次步驟')
  })

  it.each(courses)('preserves crash cause before wrong-direction result metadata in %s', (id, direction) => {
    const feedback = summarizeTrainingResult({ ...directedResult(id, { ...complete,
      flipDirection: -direction }), outcome: 'FAILED', message: 'Ground impact latched a crash.' })
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).toContain('本次發生墜毀')
    expect(feedback.observedGap).not.toContain('本次觀察到')
  })
})

describe('大迴旋 result observations', () => {
  const loopResult: TrainingResult = { ...result, lessonId: 'power-loop', totalCheckpoints: 8, completedCheckpoints: 7,
    metrics: { loopPhase: 7, loopEpisodeValid: 1, loopInterrupted: 0, loopProgressDegrees: 360,
      loopHeightGainM: 7, loopForwardSpanM: 12, loopReverseTravelM: 4, loopCompleted: 1, loopInverted: 1, loopDescended: 1 } }

  it('only recognizes success with current continuous spatial evidence', () => {
    const complete = summarizeTrainingResult({ ...loopResult, outcome: 'SUCCESS', completedCheckpoints: 8,
      metrics: { ...loopResult.metrics, loopPhase: 8 } })
    expect(complete.observedStrength).toContain('同一圈的拉升、越頂倒置、下降、向前改出')
    expect(complete.observedGap).toBeNull()
    for (const metrics of [
      { ...loopResult.metrics, loopPhase: 8, loopEpisodeValid: 0 },
      { ...loopResult.metrics, loopPhase: 8, loopInterrupted: 1 },
      { ...loopResult.metrics, loopPhase: 8, loopHeightGainM: 0 },
      { ...loopResult.metrics, loopPhase: 8, loopForwardSpanM: 0 },
      { ...loopResult.metrics, loopPhase: 8, loopReverseTravelM: 0 },
    ]) {
      const stale = summarizeTrainingResult({ ...loopResult, outcome: 'SUCCESS', completedCheckpoints: 8, metrics })
      expect(stale.observedStrength).toBeNull()
      expect(stale.observedGap).toContain('證據不足')
    }
  })

  it('reports missing real rise/span even after a full pitch turn', () => {
    const incomplete = summarizeTrainingResult({ ...loopResult, metrics: { ...loopResult.metrics, loopPhase: 3, loopHeightGainM: 0.8, loopForwardSpanM: 2 } })
    expect(incomplete.observedGap).toContain('拉升 0.8 m')
    expect(incomplete.observedGap).toContain('前後跨度 2.0 m')
    expect(incomplete.observedGap).toContain('原地後翻不能代替')
    expect(incomplete.nextPractice).toContain('前速')
  })

  it('retains the interruption event instead of praising stale over-top evidence', () => {
    const interrupted = summarizeTrainingResult({ ...loopResult, metrics: { ...loopResult.metrics, loopEpisodeValid: 0, loopInterrupted: 1, loopInterruptionReason: 2, interruptionAltitudeM: 0.5, altitudeM: 12 } })
    expect(interrupted.observedStrength).not.toContain('越頂倒置')
    expect(interrupted.observedGap).toContain('中斷時離地 0.5 m')
    expect(interrupted.observedGap).toContain('舊的倒置或改出標記')
  })

  it('names the current recovery blocker', () => {
    const recovery = summarizeTrainingResult({ ...loopResult, metrics: { ...loopResult.metrics, tiltDegrees: 49, verticalSpeedMps: -7 } })
    expect(recovery.observedStrength).toContain('向前出口')
    expect(recovery.observedGap).toContain('49.0°')
    expect(recovery.observedGap).toContain('−4～+5 m/s')
  })

  it.each([
    ['墜毀', '發生墜毀'], ['disconnect', '連線中斷'], ['位置跳躍', '資料無效'],
  ])('does not infer skill from terminal stop %s', (message, observed) => {
    const stopped = summarizeTrainingResult({ ...loopResult, message })
    expect(stopped.observedStrength).toBeNull()
    expect(stopped.observedGap).toContain(observed)
    expect(stopped.nextPractice).toContain('再練一次')
  })

  it('explains a too-narrow completed flip from the interruption snapshot', () => {
    const narrow = summarizeTrainingResult({ ...loopResult, metrics: { ...loopResult.metrics,
      loopPhase: 6, loopEpisodeValid: 0, loopInterrupted: 1, loopInterruptionReason: 9,
      loopForwardSpanM: 0, interruptionForwardSpanM: 2.4 } })
    expect(narrow.observedStrength).not.toContain('向前出口')
    expect(narrow.observedGap).toContain('只有 2.4 m')
    expect(narrow.observedGap).toContain('進場直線與回正後直飛不計入')
    expect(narrow.nextPractice).toContain('真正的拉升、越頂與下降')
  })

  it('does not infer a loop from no armed samples', () => {
    const empty = summarizeTrainingResult({ ...loopResult, sampleCount: 0, outcome: 'SUCCESS' })
    expect(empty.observedStrength).toBeNull()
    expect(empty.observedGap).toContain('沒有有效')
  })
})

describe('破S current-rule result observations', () => {
  const splitContext: TrainingAttemptContext = { ...currentContext, rulesVersion: 6 }
  const metrics = { splitPhase: 7, splitEpisodeValid: 1, splitInterrupted: 0, splitInverted: 1,
    splitDescended: 1, splitReversed: 1, splitCompleted: 1, splitRollProgressDegrees: 180,
    splitPitchProgressDegrees: 178, splitHeightLossM: 12, splitReverseTravelM: 5, splitHeadingChangeDegrees: 178 }
  const splitResult: TrainingResult = { ...result, lessonId: 'split-s', attemptContext: splitContext,
    totalCheckpoints: 8, completedCheckpoints: 7, metrics }

  it('recognizes a complete current sequence and rejects stale or missing spatial proof', () => {
    const complete = summarizeTrainingResult({ ...splitResult, outcome: 'SUCCESS', completedCheckpoints: 8, metrics: { ...metrics, splitPhase: 8 } })
    expect(complete.observedStrength).toContain('從地面自行起飛')
    expect(complete.observedStrength).toContain('橫滾倒置、走出下降半迴圈')
    expect(complete.observedGap).toBeNull()
    for (const missing of ['splitEpisodeValid', 'splitInverted', 'splitDescended', 'splitReversed', 'splitCompleted', 'splitHeightLossM', 'splitReverseTravelM']) {
      const rejected = summarizeTrainingResult({ ...splitResult, outcome: 'SUCCESS', completedCheckpoints: 8,
        metrics: { ...metrics, splitPhase: 8, [missing]: 0 } })
      expect(rejected.observedStrength).toBeNull()
      expect(rejected.observedGap).toContain('證據不足')
    }
  })

  it('retains the old airborne five-step result without claiming new ground-start completion', () => {
    const legacy = summarizeTrainingResult({ ...splitResult, attemptContext: currentContext, outcome: 'SUCCESS',
      completedCheckpoints: 5, totalCheckpoints: 5, metrics: { entryAltitudeM: 25, headingChangeDegrees: 180 } })
    expect(legacy.observedStrength).toContain('5 / 5')
    expect(legacy.observedGap).toBeNull()
    expect(legacy.observedStrength).not.toContain('地面自行起飛')
    expect(legacy.observedStrength).not.toContain('八步')
    const missingCurrent = summarizeTrainingResult({ ...splitResult, outcome: 'SUCCESS', completedCheckpoints: 8, metrics: { headingChangeDegrees: 180 } })
    expect(missingCurrent.observedStrength).toBeNull()
    expect(missingCurrent.observedGap).toContain('證據不足')
  })

  it('reports actual descending and reverse-flight gaps rather than just a heading turn', () => {
    const dive = summarizeTrainingResult({ ...splitResult, metrics: { ...metrics, splitPhase: 4,
      splitDescended: 0, splitReversed: 0, splitCompleted: 0, splitHeightLossM: 0.8 } })
    expect(dive.observedGap).toContain('本段下降 0.8 m')
    expect(dive.observedGap).toContain('至少需 3 m')
    const reverse = summarizeTrainingResult({ ...splitResult, metrics: { ...metrics, splitPhase: 5,
      splitReversed: 0, splitCompleted: 0, splitReverseTravelM: 0.4 } })
    expect(reverse.observedGap).toContain('反向行程 0.4 m')
    expect(reverse.observedGap).toContain('只轉機頭不算')
  })

  it('follows new episode evidence after retained late checkpoints', () => {
    const fresh = summarizeTrainingResult({ ...splitResult, metrics: { ...metrics,
      splitInverted: 0, splitDescended: 0, splitReversed: 0, splitCompleted: 0 } })
    expect(fresh.observedStrength).not.toContain('反向正飛改出')
    expect(fresh.observedGap).toContain('尚未以橫滾完成倒置')
    expect(fresh.nextPractice).toContain('先留出下方空間')
  })

  it('keeps the captured low-altitude event after the pilot climbs again', () => {
    const stopped = summarizeTrainingResult({ ...splitResult, metrics: { ...metrics, splitEpisodeValid: 0,
      splitInterrupted: 1, splitInterruptionReason: 2, interruptionAltitudeM: 0.6, altitudeM: 20 } })
    expect(stopped.observedStrength).not.toContain('反向正飛改出')
    expect(stopped.observedGap).toContain('中斷時離地 0.6 m')
    expect(stopped.observedGap).toContain('舊倒置與下降標記')
  })

  it('names measured recovery blockers and timeout separately', () => {
    const recovery = summarizeTrainingResult({ ...splitResult, metrics: { ...metrics, tiltDegrees: 54, verticalSpeedMps: -7 } })
    expect(recovery.observedStrength).toContain('反向正飛改出')
    expect(recovery.observedGap).toContain('傾角 54.0°')
    expect(recovery.observedGap).toContain('−4～+5 m/s')
    const timeout = summarizeTrainingResult({ ...splitResult, message: '破S挑戰逾時。' })
    expect(timeout.observedGap).toContain('本次挑戰逾時')
    expect(timeout.nextPractice).toContain('清空本次步驟')
  })

  it.each([['Ground impact crash', '發生墜毀'], ['disconnect', '連線中斷'], ['資料中斷', '資料無效']])('does not infer maneuver skill from terminal stop %s', (message, expected) => {
    const stopped = summarizeTrainingResult({ ...splitResult, message })
    expect(stopped.observedStrength).toBeNull()
    expect(stopped.observedGap).toContain(expected)
    expect(stopped.nextPractice).toContain('再練一次')
  })

  it('does not credit a result without armed samples', () => {
    const empty = summarizeTrainingResult({ ...splitResult, sampleCount: 0, outcome: 'SUCCESS' })
    expect(empty.observedStrength).toBeNull()
    expect(empty.observedGap).toContain('沒有有效')
  })
})
