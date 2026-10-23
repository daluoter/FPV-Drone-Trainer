import { describe, expect, it } from 'vitest'

import { formatTrainingMetrics, squareRouteTargetLabel, trainingHint, trainingObjective, trainingRouteGuide } from './feedback'

describe('beginner-facing training feedback', () => {
  it('prioritizes lesson facts with Chinese names and units, without guessing error direction', () => {
    const display = formatTrainingMetrics({
      stickVariation: 200,
      verticalSpeedMps: 3,
      altitudeErrorM: 0.8,
      horizontalDriftM: 0.4,
      contiguousDwellSeconds: 1.2,
    }, 'hover')
    expect(display).toEqual([
      { key: 'altitudeErrorM', label: '高度偏差', value: '0.80 m' },
      { key: 'horizontalDriftM', label: '偏離中心', value: '0.40 m' },
      { key: 'contiguousDwellSeconds', label: '連續穩定', value: '1.2 s' },
    ])
    expect(JSON.stringify(display)).not.toMatch(/低於|高於|油門不足/)
  })

  it('does not expose unknown/internal metrics or non-finite values', () => {
    expect(formatTrainingMetrics({ previousInternalAccumulator: 1, speedMps: Number.NaN })).toEqual([])
    expect(formatTrainingMetrics(undefined)).toEqual([])
    expect(formatTrainingMetrics({ altitudeErrorM: 1 }, 'hover', 0)).toEqual([])
  })

  it('formats geometric orbit progress as one-lap percentage and caps the teaching display at three facts', () => {
    const display = formatTrainingMetrics({
      orbitProgress: Math.PI,
      radialErrorM: 0.2,
      altitudeErrorM: 0.1,
      orbitSpeedMps: 5,
    }, 'orbit', 10)
    expect(display).toHaveLength(3)
    expect(display[0]).toEqual({ key: 'orbitProgress', label: '繞行進度', value: '50 %' })
  })

  it('shows target distance, physical height and readable ground contact for landing', () => {
    const metrics = { landingPhase: 3, landingHeightM: 0.8, landingPositionErrorM: 0.2,
      verticalSpeedMps: 1.2, touchdownDescentSpeedMps: 0, groundTouching: 0 }
    expect(formatTrainingMetrics(metrics, 'landing')).toEqual([
      { key: 'landingPositionErrorM', label: '距降落區中心', value: '0.20 m' },
      { key: 'landingHeightM', label: '離地間隙', value: '0.80 m' },
      { key: 'groundTouching', label: '地面接觸', value: '尚未接地' },
    ])
    expect(formatTrainingMetrics({ ...metrics, landingPhase: 4, groundTouching: 1 }, 'landing')[2]?.value)
      .toBe('已接地')
  })

  it('prioritizes gate progress and the next gate instead of removed stopping requirements', () => {
    const metrics = { gatesPassed: 1, nextGateDistanceM: 1.2, nextGateErrorM: 0.4,
      routePhase: 2, alongTrackM: 3.8, contiguousDwellSeconds: 0, horizontalSpeedMps: 3 }
    expect(formatTrainingMetrics(metrics, 'straight-line')).toEqual([
      { key: 'gatesPassed', label: '已通過圓環', value: '1 / 3' },
      { key: 'nextGateDistanceM', label: '距下一個圓環', value: '1.20 m' },
      { key: 'nextGateErrorM', label: '對準圓環偏差', value: '0.40 m' },
    ])
  })

  it('shows current takeoff facts before ground-start courses', () => {
    expect(formatTrainingMetrics({ routePhase: 0, launchHeightM: 0.1, altitudeM: 0.15,
      gatesPassed: 0, stopErrorM: 8, contiguousDwellSeconds: 0 }, 'straight-line').map((metric) => metric.key))
      .toEqual(['launchHeightM', 'altitudeM', 'gatesPassed'])
    expect(formatTrainingMetrics({ landingPhase: 1, landingHeightM: 0.1, launchDistanceM: 0,
      verticalSpeedMps: 0.4, groundTouching: 1 }, 'landing').map((metric) => metric.key))
      .toEqual(['landingHeightM', 'launchDistanceM', 'groundTouching'])
  })

  it('explains ordered ring passage and retains passed gates when a ring is missed', () => {
    expect(trainingRouteGuide('straight-line')).toMatch(/地面起飛.*藍色 3 m.*金色 5 m.*綠色 8 m/)
    expect(trainingRouteGuide('straight-line')).toContain('依序從圈內穿過三圈即可完成')
    expect(trainingRouteGuide('straight-line')).toContain('不要求減速比例或終點停留')
    expect(trainingObjective('straight-line', { metrics: { routePhase: 0 } })?.title).toContain('地面自行起飛')
    expect(trainingObjective('straight-line', { metrics: { routePhase: 1, nextGateDistanceM: 2 } })?.detail)
      .toContain('距下一圈平面 2.0 m')
    const gold = trainingObjective('straight-line', { metrics: { routePhase: 2, nextGateDistanceM: -0.2 } })
    expect(gold?.title).toContain('第 2 個金色圓環')
    expect(gold?.detail).toContain('退回這一圈前再穿一次')
    expect(gold?.detail).toContain('已完成的圈會保留')
    expect(gold?.detail).not.toContain('接地')
    const green = trainingObjective('straight-line', { metrics: { routePhase: 3, nextGateDistanceM: 1 } })
    expect(green?.detail).toContain('穿過這一圈即可完成，不需停穩')
    expect(trainingHint('straight-line', { status: 'continue', metrics: { routePhase: 2, nextGateDistanceM: 1 } }))
      .toContain('金色圓環')
  })

  it('directs landing learners to the separate enlarged target without a dwell requirement', () => {
    expect(trainingRouteGuide('landing')).toContain('降落目標與起飛墊分開')
    expect(trainingRouteGuide('landing')).toContain('半徑 1.5 m 內接地且沒有墜毀即可完成')
    expect(trainingObjective('landing', { metrics: { landingPhase: 1 } })?.detail).toContain('先離地至少 0.15 m')
    const transit = trainingObjective('landing', { metrics: { landingPhase: 2, landingPositionErrorM: 6.4 } })
    expect(transit?.detail).toContain('距區域中心 6.4 m')
    expect(transit?.detail).toContain('可直接再起飛重試')
    expect(trainingObjective('landing', { metrics: { landingPhase: 3, landingPositionErrorM: 0.3, landingHeightM: 0.4 } })?.detail)
      .toContain('離地間隙 0.4 m')
    expect(trainingObjective('landing', { metrics: { landingPhase: 4 } })?.detail).toContain('不必再等待穩定計時')
  })

  it('uses the current evaluator hint rather than replacing it with generic coaching', () => {
    expect(trainingHint('hover', {
      status: 'continue',
      hint: 'Climb into the green hover target above the takeoff pad.',
    })).toContain('綠色目標區')
    expect(trainingHint('takeoff', { status: 'continue', hint: '接近目標時，請改用小量修正。' }))
      .toBe('接近目標時，請改用小量修正。')
  })

  it('falls back to useful lesson-aware Chinese instead of exposing implementation hints', () => {
    expect(trainingHint('orbit', { status: 'continue', hint: 'orbitValid accumulator rejected by internal seam' }))
      .toContain('半徑與高度')
    expect(trainingHint('hover', { status: 'failure' })).toContain('重試')
    expect(trainingHint('hover', { status: 'success' })).toContain('解除解鎖')
  })

  it('shows the measured restart or failure cause before the corrective action', () => {
    const message = '偏離直線走廊：距中心線 1.40 m，允許最多 1.25 m。'
    const hint = '先減少側移，再回起飛區平穩接地。'
    expect(trainingHint('straight-line', { status: 'continue', recovery: 'restart', message, hint }))
      .toBe(`${message} ${hint}`)
    expect(trainingHint('landing', { status: 'failure', message: '接地下降速度 1.20 m/s，允許最多 0.80 m/s。', hint }))
      .toContain('接地下降速度 1.20 m/s')
    expect(trainingHint('straight-line', { status: 'continue', recovery: 'restart', message: 'internal accumulator failed', hint }))
      .toBe(hint)
  })

  it('keeps restart guidance in the approved reset → countdown → explicit arm order', () => {
    const hint = trainingHint('hover', {
      status: 'failure',
      hint: 'Re-arm explicitly, then retry the lesson from its reset setup.',
    })
    expect(hint).toMatch(/先重試.*倒數結束後再明確解鎖/)
  })

  it('gives body-relative offscreen target directions without interpreting them as fixed XYZ', () => {
    const goal = trainingObjective('direction-control', { metrics: {
      directionPhase: 2, directionTargetIndex: 0, targetRightM: 3.2, targetForwardM: -1.1,
      targetUpM: 0.1, targetDistanceM: 3.4, headingErrorDegrees: 5,
    } })
    expect(goal?.title).toContain('向右側移')
    expect(goal?.detail).toContain('以目前機頭為準')
    expect(goal?.detail).toContain('右方 3.2 m、後方 1.1 m')
    expect(goal?.detail).not.toContain('上方')
    expect(goal?.detail).toContain('不要求停穩')
    const turned = trainingObjective('direction-control', { metrics: {
      directionPhase: 8, directionTargetIndex: 6, targetRightM: 2, targetForwardM: -0.8,
      targetUpM: 0, headingErrorDegrees: 0,
    } })
    expect(turned?.title).toContain('換向後向右側移')
    expect(turned?.detail).toContain('右方 2.0 m、後方 0.8 m')
    expect(turned?.detail).toContain('XYZ 不會跟著機頭旋轉')
  })

  it('explains yaw progress separately from sideways movement and retains authoritative blockers', () => {
    const metrics = { directionPhase: 6, directionTargetIndex: 4, headingChangeDegrees: 20,
      headingErrorDegrees: 70, targetDistanceM: 0.3 }
    const goal = trainingObjective('direction-control', { metrics })
    expect(goal?.title).toContain('向右偏航換向')
    expect(goal?.detail).toContain('Yaw 改變朝向，Roll 才是側移')
    expect(goal?.detail).toContain('目前已轉 20 °')
    expect(goal?.detail).toContain('距新朝向還差約 70 °')
    const blocker = '缺少換向起始朝向資料，請重試課程。'
    expect(trainingHint('direction-control', { status: 'continue', metrics, hint: blocker })).toBe(blocker)
    expect(formatTrainingMetrics(metrics, 'direction-control').map(({ key }) => key))
      .toEqual(['headingChangeDegrees', 'headingErrorDegrees', 'targetDistanceM'])
  })

  it('shows actual airborne and yaw-reference blockers before further movement instructions', () => {
    const grounded = trainingObjective('direction-control', { metrics: {
      directionPhase: 4, directionTargetIndex: 2, groundTouching: 1, groundClearanceM: 0,
      targetRightM: 3, targetForwardM: 2, targetUpM: 3,
    } })
    expect(grounded?.detail).toContain('目前尚未在空中')
    expect(grounded?.detail).toContain('目前位置自行加油門起飛')
    expect(grounded?.detail).toContain('已完成的目標會保留')
    expect(grounded?.detail).not.toMatch(/Roll|Pitch/)
    const missingAnchor = trainingObjective('direction-control', { metrics: {
      directionPhase: 6, directionTargetIndex: 4, groundTouching: 0, groundClearanceM: 3,
      yawEntryRecorded: 0, targetDistanceM: 0.2, headingChangeDegrees: 0, headingErrorDegrees: 0,
    } })
    expect(missingAnchor?.detail).toContain('尚缺換向前的朝向紀錄')
    expect(missingAnchor?.detail).toContain('請重設課程')
  })

  it('keeps direction practice goals simple while showing only finite progress and location facts', () => {
    expect(trainingRouteGuide('direction-control')).toMatch(/地面起飛.*左右側移.*前後移動.*偏航換向.*新朝向/)
    expect(trainingRouteGuide('direction-control')).toContain('無須停穩')
    expect(formatTrainingMetrics({ directionPhase: 4, directionTargetsCompleted: 2, targetDistanceM: 3.4,
      headingErrorDegrees: 8, targetUpM: Number.NaN, contiguousDwellSeconds: 0 }, 'direction-control'))
      .toEqual([
        { key: 'directionTargetsCompleted', label: '已完成方向目標', value: '2 / 7' },
        { key: 'targetDistanceM', label: '距目前目標', value: '3.40 m' },
        { key: 'headingErrorDegrees', label: '航向偏差', value: '8.0 °' },
      ])
    const unknown = trainingObjective('direction-control', { metrics: {
      directionPhase: 3, targetRightM: Number.NaN, targetForwardM: Infinity, targetUpM: Number.NaN,
    } })
    expect(unknown?.detail).not.toMatch(/NaN|Infinity/)
    expect(unknown?.detail).toContain('方向以目前機頭為準')
  })

  it('introduces a ground-start right and left route without a speed or dwell target', () => {
    expect(trainingRouteGuide('coordinated-turn')).toMatch(/地面起飛.*右轉入口.*左轉入口/)
    expect(trainingRouteGuide('coordinated-turn')).toContain('只原地轉頭不算')
    expect(trainingRouteGuide('coordinated-turn')).toContain('不要求精準速度或停留')
    expect(trainingObjective('coordinated-turn', null)?.title).toContain('1／8')
    expect(trainingObjective('coordinated-turn', { metrics: { turnPhase: 1 } })?.detail).toContain('不需要先懸停')
    expect(trainingObjective('coordinated-turn', { metrics: { turnPhase: 8 } })?.detail).toContain('現在可以 Disarm')
  })

  it('directs a turn learner using at most two body-relative directions and the current stage', () => {
    const objective = trainingObjective('coordinated-turn', { metrics: {
      turnPhase: 3, turnTargetIndex: 1, targetRightM: 4, targetForwardM: -2,
      targetUpM: 0.3, targetDistanceM: 4.5, headingErrorDegrees: 20, turnEntryRecorded: 1,
    } })
    expect(objective?.title).toBe('4／8 右轉轉彎點')
    expect(objective?.detail).toContain('以目前機頭為準：目標在右方 4.0 m、後方 2.0 m')
    expect(objective?.detail).not.toContain('上方')
    expect(objective?.detail).toContain('用小量 Roll 向右傾斜')
    expect(objective?.detail).toContain('已完成的目標會保留')
    const invalidOffsets = trainingObjective('coordinated-turn', { metrics: {
      turnPhase: 6, turnTargetIndex: 4, targetRightM: Number.NaN, targetForwardM: Infinity,
    } })
    expect(invalidOffsets?.detail).not.toMatch(/NaN|Infinity/)
    expect(invalidOffsets?.detail).toContain('方向以目前機頭為準')
  })

  it('keeps a noncrash landing local and distinguishes a stationary entry from a missed target', () => {
    const grounded = trainingObjective('coordinated-turn', { metrics: {
      turnPhase: 6, turnTargetIndex: 4, groundTouching: 1, groundClearanceM: 0, headingErrorDegrees: 110,
    } })
    expect(grounded?.detail).toContain('目前位置再次自行起飛')
    expect(grounded?.detail).toContain('已完成的目標會保留')
    expect(grounded?.detail).not.toContain('110°')
    const atEntry = { turnPhase: 2, turnTargetIndex: 0, turnMotionReady: 0, targetDistanceM: 0.2 }
    expect(trainingObjective('coordinated-turn', { metrics: atEntry })?.detail).toContain('尚未觀察到入口的實際移動方向')
    expect(trainingObjective('coordinated-turn', { metrics: { ...atEntry, targetDistanceM: 5 } })?.detail).toContain('通過右轉入口後再逐步帶入轉彎')
  })

  it('explains missing and wrong-way exit turns using the signed measured flight direction', () => {
    const exit = { turnPhase: 4, turnTargetIndex: 2, turnEntryRecorded: 1,
      turnMotionReady: 1, headingErrorDegrees: 5, targetDistanceM: 0.3, turnChangeDegrees: 8 }
    expect(trainingObjective('coordinated-turn', { metrics: exit })?.detail).toContain('實際航線已朝右轉 8°')
    expect(trainingObjective('coordinated-turn', { metrics: exit })?.detail).toContain('本彎需至少 25°')
    const wrongLeft = trainingObjective('coordinated-turn', { metrics: {
      ...exit, turnPhase: 7, turnTargetIndex: 5, turnChangeDegrees: -14,
    } })
    expect(wrongLeft?.title).toBe('8／8 左轉出口')
    expect(wrongLeft?.detail).toContain('往相反方向轉了 14°')
    expect(wrongLeft?.detail).toContain('朝左轉至少 25°')
    expect(trainingObjective('coordinated-turn', { metrics: { ...exit, turnEntryRecorded: 0 } })?.detail).toContain('尚缺本彎入口')
    expect(trainingObjective('coordinated-turn', { metrics: { ...exit, turnMotionReady: 0 } })?.detail).toContain('尚未觀察到出口')
    expect(trainingObjective('coordinated-turn', { metrics: { ...exit, headingErrorDegrees: 95 } })?.detail).toContain('需在 70° 內')
  })

  it('prioritizes measured turn progress while retaining historical route metric names', () => {
    expect(formatTrainingMetrics({ turnPhase: 7, turnTargetIndex: 5, turnChangeDegrees: -12,
      targetDistanceM: 0.5, turnTargetsCompleted: 5, routeCorridorErrorM: 10 }, 'coordinated-turn'))
      .toEqual([
        { key: 'turnChangeDegrees', label: '朝本彎方向的航線轉角', value: '-12.0 °' },
        { key: 'targetDistanceM', label: '距目前目標', value: '0.50 m' },
        { key: 'turnTargetsCompleted', label: '已完成轉彎目標', value: '5 / 6' },
      ])
    expect(formatTrainingMetrics({ routeCorridorErrorM: 1, headingChangeDegrees: 60, speedMps: 4 }, 'coordinated-turn').map(({ key }) => key))
      .toEqual(['routeCorridorErrorM', 'headingChangeDegrees', 'speedMps'])
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['轉彎練習停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
  ])('keeps the explicit L06 stop cause ahead of missing stage facts: %s', (message, expected) => {
    const hint = trainingHint('coordinated-turn', { status: 'failure', message, metrics: {} })
    expect(hint).toContain(expected)
    expect(hint).not.toContain('尚未觀察到實際起飛')
  })

  it('introduces four ordered square legs from ground without adding landing or dwell requirements', () => {
    const guide = trainingRouteGuide('square-route')
    expect(guide).toMatch(/地面起飛.*第 1 段.*第 2 段.*第 3 段.*第 4 段返回起點上方/)
    expect(guide).toContain('不要求精準速度、停留或降落')
    expect(guide).toContain('未墜毀接地保留進度')
    expect(guide).toContain('XYZ 維持固定場地方向')
    expect(trainingObjective('square-route', null)?.title).toBe('1／10 起飛區地面準備')
    const takeoff = trainingObjective('square-route', { metrics: { squarePhase: 1 } })
    expect(takeoff?.title).toBe('2／10 自行起飛')
    expect(takeoff?.detail).toContain('約 3 m，不需要先懸停')
    expect(trainingHint('square-route', null)).toContain('依序沿四段直線與右轉角')
  })

  it('keeps square directions body-relative and limits them to the two most useful offsets', () => {
    const goal = trainingObjective('square-route', { metrics: {
      squarePhase: 6, squareTargetIndex: 4, squareLeg: 3,
      targetRightM: -4, targetForwardM: -2, targetUpM: 0.5, headingErrorDegrees: 10,
      positionXM: 100, positionZM: 200,
    } })
    expect(goal?.title).toBe('7／10 第 3 段直線')
    expect(goal?.detail).toContain('以目前機頭為準：目標在左方 4.0 m、後方 2.0 m')
    expect(goal?.detail).not.toContain('上方 0.5 m')
    expect(goal?.detail).not.toMatch(/100|200/)
    expect(goal?.detail).toContain('固定 XYZ 不會跟著機頭轉向')
    const corner = trainingObjective('square-route', { metrics: { squarePhase: 7, squareTargetIndex: 5 } })
    expect(corner?.title).toBe('8／10 第 3 個右轉角')
    expect(corner?.detail).toContain('Roll 右傾')
    expect(corner?.detail).toContain('已完成的步驟會保留')
  })

  it('gives the measured square heading blocker before further forward flight instructions', () => {
    const metrics = { squarePhase: 4, squareTargetIndex: 2, squareLeg: 2,
      headingErrorDegrees: 96, targetDistanceM: 0.6, squareLegsCompleted: 1 }
    const goal = trainingObjective('square-route', { metrics })
    expect(goal?.title).toBe('5／10 第 2 段直線')
    expect(goal?.detail).toContain('偏離本步箭頭方向 96°，需在 70° 內')
    expect(goal?.detail).toContain('先小量偏航')
    expect(goal?.detail).not.toContain('小量 Pitch 前進')
    expect(formatTrainingMetrics(metrics, 'square-route').map(({ key }) => key))
      .toEqual(['headingErrorDegrees', 'targetDistanceM', 'squareLegsCompleted'])
  })

  it('keeps a grounded square retry local and preserves existing steps without a heading distraction', () => {
    const goal = trainingObjective('square-route', { metrics: {
      squarePhase: 5, squareTargetIndex: 3, groundTouching: 1, groundClearanceM: 0,
      headingErrorDegrees: 150, squareTargetsCompleted: 3,
    } })
    expect(goal?.title).toBe('6／10 第 2 個右轉角')
    expect(goal?.detail).toContain('目前位置再次自行起飛')
    expect(goal?.detail).toContain('已完成的步驟會保留')
    expect(goal?.detail).toContain('不需要回原起飛點')
    expect(goal?.detail).not.toContain('150°')
    expect(formatTrainingMetrics({ squarePhase: 1, groundClearanceM: 0.05, altitudeM: 0.1,
      squareTargetsCompleted: 0 }, 'square-route').map(({ key }) => key))
      .toEqual(['groundClearanceM', 'altitudeM', 'squareTargetsCompleted'])
  })

  it('distinguishes the current airborne square finish from a completed ten-step route', () => {
    const finish = trainingObjective('square-route', { metrics: { squarePhase: 9, squareTargetIndex: 7 } })
    expect(finish?.title).toBe('10／10 返回起點上方')
    expect(finish?.detail).toContain('仍需在空中，不必降落或停穩')
    expect(finish?.detail).not.toContain('現在可以 Disarm')
    const done = trainingObjective('square-route', { metrics: { squarePhase: 10, squareTargetsCompleted: 8 } })
    expect(done?.title).toBe('10／10 方形航線已完成')
    expect(done?.detail).toContain('四段方形航線並回到起點上方')
    expect(done?.detail).toContain('不必降落或停留，現在可以 Disarm')
  })

  it('shows finite square progress without exposing internal state or inventing a speed goal', () => {
    expect(formatTrainingMetrics({ squarePhase: 6, squareTargetsCompleted: 4, squareLegsCompleted: 2,
      targetDistanceM: 2.5, headingErrorDegrees: 12, turnChangeDegrees: 0, contiguousDwellSeconds: 0 }, 'square-route'))
      .toEqual([
        { key: 'squareTargetsCompleted', label: '已完成方形目標', value: '4 / 8' },
        { key: 'squareLegsCompleted', label: '已完成方形路段', value: '2 / 4' },
        { key: 'targetDistanceM', label: '距目前目標', value: '2.50 m' },
      ])
    const unknown = trainingObjective('square-route', { metrics: {
      squarePhase: 4, targetRightM: Number.NaN, targetForwardM: Infinity, targetUpM: Number.NaN,
      headingErrorDegrees: Number.NaN,
    } })
    expect(unknown?.detail).not.toMatch(/NaN|Infinity/)
    expect(unknown?.detail).toContain('方向以目前機頭為準')
    expect(squareRouteTargetLabel(-1)).toBe('目前方形航線目標')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['方形航線停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
    ['方形航線停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效或中斷'],
  ])('keeps the explicit L07 stop cause before missing stage facts: %s', (message, expected) => {
    const hint = trainingHint('square-route', { status: 'failure', message, metrics: {} })
    expect(hint).toContain(expected)
    expect(hint).not.toContain('第一段亮起的直線目標')
  })
})
