import { describe, expect, it } from 'vitest'

import { figureEightTargetLabel, formatTrainingMetrics, fullFlipInterruptionReason, fullFlipStageLabel, squareRouteTargetLabel, trainingHint, trainingObjective, trainingRouteGuide, wideGateCollisionCause } from './feedback'

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

  it('introduces the ordered left loop, central switch and right loop from supported ground', () => {
    const guide = trainingRouteGuide('figure-eight')
    expect(guide).toMatch(/地面起飛.*中央入口.*左圈.*中央換向點.*右圈.*中央空中終點/)
    expect(guide).toContain('起飛點前方 6 m')
    expect(guide).toContain('相同位置要依順序經過')
    expect(guide).toContain('不要求精準速度、停留或降落')
    expect(guide).toContain('挑戰 300 秒')
    expect(trainingObjective('figure-eight', null)?.title).toBe('1／11 起飛區地面準備')
    expect(trainingObjective('figure-eight', { metrics: { eightPhase: 1 } })?.title).toBe('2／11 自行起飛')
    expect(trainingObjective('figure-eight', { metrics: { eightPhase: 1 } })?.detail).toContain('不需要先懸停')
    expect(trainingHint('figure-eight', null)).toContain('中央換向點接右圈')
  })

  it('distinguishes the three visits to the shared center without calling an entry completion', () => {
    const entry = trainingObjective('figure-eight', { metrics: { eightPhase: 2, eightTargetIndex: 0 } })
    expect(entry?.title).toBe('3／11 中央入口')
    expect(entry?.detail).toContain('仍須依序飛完左右兩圈')
    const crossing = trainingObjective('figure-eight', { metrics: { eightPhase: 6, eightTargetIndex: 4 } })
    expect(crossing?.title).toBe('7／11 中央換向點')
    expect(crossing?.detail).toContain('先飛過中央換向點完成左圈')
    expect(crossing?.detail).toContain('下一個目標亮起後改向右轉')
    expect(crossing?.detail).not.toContain('現在可以 Disarm')
    const finish = trainingObjective('figure-eight', { metrics: { eightPhase: 10, eightTargetIndex: 8 } })
    expect(finish?.title).toBe('11／11 中央終點')
    expect(finish?.detail).toContain('仍需在空中，不必降落或停穩')
    expect(finish?.detail).toContain('與地面起飛區不同')
    expect(finish?.detail).not.toContain('現在可以 Disarm')
    expect(figureEightTargetLabel(-1)).toBe('目前八字航線目標')
  })

  it('shows left and right arc coaching with only two body-relative offsets', () => {
    const metrics = { eightPhase: 3, eightTargetIndex: 1, eightLoop: 1,
      targetRightM: -4, targetForwardM: 2, targetUpM: 0.5, headingErrorDegrees: 10,
      positionXM: 400, positionZM: -600 }
    const left = trainingObjective('figure-eight', { metrics })
    expect(left?.title).toBe('4／11 左圈前段')
    expect(left?.detail).toContain('目標在左方 4.0 m、前方 2.0 m')
    expect(left?.detail).not.toContain('上方 0.5 m')
    expect(left?.detail).not.toMatch(/400|600/)
    expect(left?.detail).toContain('Roll 向左傾斜')
    expect(left?.detail).toContain('XYZ 不會隨機頭旋轉')
    const right = trainingObjective('figure-eight', { metrics: { ...metrics, eightPhase: 7, eightTargetIndex: 5, eightLoop: 2 } })
    expect(right?.title).toBe('8／11 右圈前段')
    expect(right?.detail).toContain('Roll 向右傾斜')
    expect(right?.detail).toContain('已完成的步驟會保留')
  })

  it('places an observed L08 heading blocker before arc movement and keeps grounded retries local', () => {
    const metrics = { eightPhase: 8, eightTargetIndex: 6, eightLoop: 2,
      headingErrorDegrees: 112, targetDistanceM: 0.6, eightLoopsCompleted: 1 }
    const heading = trainingObjective('figure-eight', { metrics })
    expect(heading?.title).toBe('9／11 右圈外側')
    expect(heading?.detail).toContain('偏離本步箭頭方向 112°，需在 70° 內')
    expect(heading?.detail).not.toContain('Roll 向右傾斜')
    expect(formatTrainingMetrics(metrics, 'figure-eight').map(({ key }) => key))
      .toEqual(['headingErrorDegrees', 'targetDistanceM', 'eightLoopsCompleted'])
    const grounded = trainingObjective('figure-eight', { metrics: { ...metrics, groundTouching: 1, groundClearanceM: 0 } })
    expect(grounded?.detail).toContain('目前位置再次自行起飛')
    expect(grounded?.detail).toContain('已完成的步驟會保留')
    expect(grounded?.detail).toContain('不需要回原起飛點或中央入口')
    expect(grounded?.detail).not.toContain('112°')
  })

  it('formats the actual two-loop progress and hides non-finite or internal L08 facts', () => {
    expect(formatTrainingMetrics({ eightPhase: 8, eightTargetsCompleted: 6, eightLoopsCompleted: 1,
      targetDistanceM: 4.2, headingErrorDegrees: 10, turnChangeDegrees: 0, contiguousDwellSeconds: 0 }, 'figure-eight'))
      .toEqual([
        { key: 'eightTargetsCompleted', label: '已完成八字目標', value: '6 / 9' },
        { key: 'eightLoopsCompleted', label: '已完成八字圈段', value: '1 / 2' },
        { key: 'targetDistanceM', label: '距目前目標', value: '4.20 m' },
      ])
    expect(formatTrainingMetrics({ eightPhase: 1, groundClearanceM: 0.02, altitudeM: 0.1, eightTargetsCompleted: 0 }, 'figure-eight').map(({ key }) => key))
      .toEqual(['groundClearanceM', 'altitudeM', 'eightTargetsCompleted'])
    const missing = trainingObjective('figure-eight', { metrics: { eightPhase: 4,
      targetRightM: Number.NaN, targetForwardM: Infinity, targetUpM: Number.NaN, headingErrorDegrees: Number.NaN } })
    expect(missing?.detail).not.toMatch(/NaN|Infinity/)
    expect(missing?.detail).toContain('方向以目前機頭為準')
  })

  it('marks L08 complete only at the terminal stage and avoids a landing or mastery claim', () => {
    const done = trainingObjective('figure-eight', { metrics: { eightPhase: 11, eightTargetsCompleted: 9, eightLoopsCompleted: 2 } })
    expect(done?.title).toBe('11／11 八字航線已完成')
    expect(done?.detail).toContain('左圈、中央換向與右圈')
    expect(done?.detail).toContain('中央空中終點')
    expect(done?.detail).toContain('不必降落或停留，現在可以 Disarm')
    expect(done?.detail).not.toContain('熟練')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['八字航線停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
    ['八字航線停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效或中斷'],
  ])('keeps the explicit L08 stop cause before absent stage facts: %s', (message, expected) => {
    const hint = trainingHint('figure-eight', { status: 'failure', message, metrics: {} })
    expect(hint).toContain(expected)
    expect(hint).not.toContain('先飛向前方中央入口')
  })

  it('distinguishes a terminated L08 timeout from active progress-preserving ground recovery', () => {
    const metrics = { eightPhase: 7, eightTargetIndex: 5, groundTouching: 1, groundClearanceM: 0 }
    expect(trainingHint('figure-eight', { status: 'continue', metrics })).toContain('已完成的步驟會保留')
    const stopped = trainingHint('figure-eight', { status: 'failure', metrics, message: '八字航線挑戰逾時：尚未完成左右兩圈。' })
    expect(stopped).toContain('挑戰逾時')
    expect(stopped).toContain('再練一次')
    expect(stopped).toContain('清空本次步驟')
    expect(stopped).not.toContain('保留')
  })

  it('introduces three real wide frames after a ground start, without extra precision goals', () => {
    const guide = trainingRouteGuide('wide-gate')
    expect(guide).toMatch(/地面起飛.*8 m.*16 m.*24 m/)
    expect(guide).toContain('寬、高各 4 m')
    expect(guide).toContain('中心離地 3 m')
    expect(guide).toContain('碰到柱子或橫樑會墜毀')
    expect(guide).toContain('反向穿越不算')
    expect(guide).toContain('引導練習不限時，挑戰 240 秒')
    expect(guide).toContain('不要求精準速度、朝向、停留或降落')
    expect(trainingObjective('wide-gate', null)?.title).toBe('1／5 起飛區地面準備')
    const liftoff = trainingObjective('wide-gate', { metrics: { gatePhase: 1 } })
    expect(liftoff?.title).toBe('2／5 自行起飛')
    expect(liftoff?.detail).toContain('不需要先懸停')
    expect(trainingHint('wide-gate', null)).toContain('實體門框')
  })

  it('explains signed missed-gate position separately from body-relative guidance', () => {
    const metrics = { gatePhase: 3, gateTargetIndex: 1, gatesPassed: 1,
      nextGateDistanceM: -3, nextGateHorizontalErrorM: 2.8, nextGateVerticalErrorM: -2.4,
      targetRightM: -4, targetForwardM: 2, targetUpM: 0.5 }
    const goal = trainingObjective('wide-gate', { metrics })
    expect(goal?.title).toBe('4／5 穿過第 2 道寬門')
    expect(goal?.detail).toContain('已在這道門後方 3.0 m，但尚未有效通過')
    expect(goal?.detail).toContain('先回到這道門前')
    expect(goal?.detail).toContain('反向穿越不算')
    expect(goal?.detail).toContain('門洞右側外，偏離中心 2.8 m')
    expect(goal?.detail).toContain('門洞下方外，偏離中心 2.4 m')
    expect(goal?.detail).toContain('以目前機頭為準：目標在左方 4.0 m、前方 2.0 m')
    expect(goal?.detail).not.toContain('上方 0.5 m')
    expect(goal?.detail).toContain('已通過的門會保留')
    expect(goal?.detail).toContain('為整架飛機與槳葉留出門框間距')
    expect(goal?.detail).not.toContain('碰到第')
    const before = trainingObjective('wide-gate', { metrics: { ...metrics, nextGateDistanceM: 3,
      nextGateHorizontalErrorM: -2.8, nextGateVerticalErrorM: 2.4 } })
    expect(before?.detail).toContain('仍在門前 3.0 m')
    expect(before?.detail).toContain('門洞左側外')
    expect(before?.detail).toContain('門洞上方外')
    expect(before?.detail).not.toContain('先回到這道門前')
  })

  it('does not infer a signed opening cause from absolute or missing observations', () => {
    const goal = trainingObjective('wide-gate', { metrics: { gatePhase: 2,
      nextGateErrorM: 20, horizontalSpeedMps: 100, headingErrorDegrees: 179,
      nextGateDistanceM: Number.NaN, nextGateHorizontalErrorM: Number.NaN,
      nextGateVerticalErrorM: Infinity, targetRightM: Number.NaN, targetForwardM: Infinity } })
    expect(goal?.detail).not.toMatch(/NaN|Infinity|左側外|右側外|上方外|下方外|179|100|20/)
    expect(goal?.detail).toContain('方向以目前機頭為準')
    expect(goal?.detail).toContain('不要求精準速度、朝向、停留或降落')
    expect(goal?.detail).not.toContain('需在 70°')
  })

  it('preserves gates during active non-crash ground recovery and overrides stale generic hints', () => {
    const metrics = { gatePhase: 4, gateTargetIndex: 2, gatesPassed: 2, groundTouching: 1,
      groundClearanceM: 0, nextGateDistanceM: -2, nextGateHorizontalErrorM: 4 }
    const active = trainingHint('wide-gate', { status: 'continue', metrics, hint: '依序穿越目標。' })
    expect(active).toContain('5／5 穿過第 3 道寬門')
    expect(active).toContain('在目前位置再次自行起飛')
    expect(active).toContain('已通過的門會保留')
    expect(active).toContain('不需要回原起飛點')
    expect(active).not.toContain('門後方')
    expect(active).not.toContain('清空本次步驟')
    const stopped = trainingHint('wide-gate', { status: 'failure', metrics,
      message: '寬門穿越挑戰逾時：尚未完成三道寬門。' })
    expect(stopped).toContain('挑戰逾時')
    expect(stopped).toContain('再練一次')
    expect(stopped).toContain('清空本次步驟')
    expect(stopped).not.toContain('保留')
    expect(stopped).not.toContain('目前位置')
  })

  it('formats at most three signed gate facts without changing L03 circle labels', () => {
    const metrics = { gatePhase: 3, gatesPassed: 1, nextGateDistanceM: -2,
      nextGateHorizontalErrorM: 2.5, nextGateVerticalErrorM: 1, targetDistanceM: 4,
      horizontalSpeedMps: 20, contiguousDwellSeconds: 0 }
    expect(formatTrainingMetrics(metrics, 'wide-gate', 10)).toEqual([
      { key: 'gatesPassed', label: '已通過寬門', value: '1 / 3' },
      { key: 'nextGateDistanceM', label: '距目前門平面（前＋／後−）', value: '-2.00 m' },
      { key: 'nextGateHorizontalErrorM', label: '相對門中心左右偏差（右＋）', value: '2.50 m' },
    ])
    expect(formatTrainingMetrics({ ...metrics, nextGateHorizontalErrorM: 1, nextGateVerticalErrorM: -3 }, 'wide-gate')[2])
      .toEqual({ key: 'nextGateVerticalErrorM', label: '相對門中心高度偏差（上＋）', value: '-3.00 m' })
    expect(formatTrainingMetrics({ gatePhase: 1, groundClearanceM: 0.1, altitudeM: 0.2, gatesPassed: 0 }, 'wide-gate').map(({ key }) => key))
      .toEqual(['groundClearanceM', 'altitudeM', 'gatesPassed'])
    expect(formatTrainingMetrics({ routePhase: 2, gatesPassed: 1, nextGateDistanceM: 3 }, 'straight-line')[0].label)
      .toBe('已通過圓環')
    expect(formatTrainingMetrics(metrics, 'wide-gate').map(({ key }) => key))
      .not.toContain('horizontalSpeedMps')
  })

  it('keeps the final gate distinct from completion and accepts a fast completed route', () => {
    const final = trainingObjective('wide-gate', { metrics: { gatePhase: 4, gateTargetIndex: 2 } })
    expect(final?.title).toBe('5／5 穿過第 3 道寬門')
    expect(final?.detail).not.toContain('現在可以 Disarm')
    const done = trainingObjective('wide-gate', { metrics: { gatePhase: 5, gatesPassed: 3,
      horizontalSpeedMps: 30, contiguousDwellSeconds: 0, headingErrorDegrees: 170 } })
    expect(done?.title).toBe('5／5 三道寬門已完成')
    expect(done?.detail).toContain('不必降落或停留，現在可以 Disarm')
    expect(done?.detail).not.toMatch(/熟練|速度|170/)
  })

  it.each([1, 2, 3].flatMap((gate) => [
    ['left-post', '左柱'], ['right-post', '右柱'], ['top-bar', '上橫樑'], ['bottom-bar', '下橫樑'],
  ].map(([part, label]) => [gate, part, label] as const)))('identifies only the reported gate %s %s contact', (gate, part, label) => {
    const message = `Obstacle collision: wide-gate-${gate}-${part}; reset required.`
    const cause = `碰到第 ${gate} 道門的${label}`
    expect(wideGateCollisionCause(message)).toBe(cause)
    const hint = trainingHint('wide-gate', { status: 'failure', message, metrics: {} })
    expect(hint).toContain(cause)
    expect(hint).toContain('墜毀')
    expect(hint).toContain('Reset')
    expect(hint).toContain('清空本次步驟')
  })

  it.each([
    'Obstacle collision: wide-gate-4-left-post; reset required.',
    'Obstacle collision: wide-gate-1-left-post-extra; reset required.',
    'Obstacle collision: wide-gate-2-unknown; reset required.',
    'Obstacle collision: another-box; reset required.',
    'Ground impact latched a crash; reset required.',
    'Target wide-gate-1-left-post is ahead.',
    'wide-gate-1-left-post',
    '',
  ])('does not invent a specific contact from an unrecognized warning: %s', (message) => {
    expect(wideGateCollisionCause(message)).toBeNull()
    expect(trainingHint('wide-gate', { status: 'failure', message, metrics: {} })).not.toMatch(/碰到第 [123] 道門/)
  })

  it('uses the first reported collider rather than inferring the current target was hit', () => {
    const message = 'Obstacle collision: wide-gate-1-right-post; reset required. Obstacle collision: wide-gate-3-top-bar; reset required.'
    expect(wideGateCollisionCause(message)).toBe('碰到第 1 道門的右柱')
    const hint = trainingHint('wide-gate', { status: 'failure', message,
      metrics: { gatePhase: 4, gateTargetIndex: 2, gatesPassed: 2 } })
    expect(hint).toContain('碰到第 1 道門的右柱')
    expect(hint).not.toContain('碰到第 3')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '地面撞擊造成墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['寬門穿越停止：缺少有效的地面接觸資料。', '飛行資料無效或中斷'],
    ['寬門穿越停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效或中斷'],
  ])('prioritizes an explicit L09 terminal cause without stage facts: %s', (message, cause) => {
    const hint = trainingHint('wide-gate', { status: 'failure', message, metrics: {} })
    expect(hint).toContain(cause)
    expect(hint).toContain('清空本次步驟')
    expect(hint).not.toMatch(/碰到第|門洞右側外|已通過的門會保留/)
  })

})

describe('L10 guided recovery coaching', () => {
  const baseline = { recoveryPhase: 2, recoveryExercise: 1, exerciseReady: 0, currentEpisodeValid: 0,
    episodeInterrupted: 0, preparationDwellSeconds: 0.1, recoveryDwellSeconds: 0,
    exercisesCompleted: 0, groundTouching: 0, insideRecoveryArea: 1, altitudeM: 6,
    tiltDegrees: 0, bodyRateDegreesPerSecond: 0, verticalSpeedMps: 0, horizontalSpeedMps: 0 }

  it('explains a self-operated ground start and actual onset before recovery', () => {
    const guide = trainingRouteGuide('basic-recovery')!
    expect(guide).toMatch(/地面自行起飛.*3 m.*4 m.*傾斜.*下沉.*漂移/)
    expect(guide).toContain('先確認實際偏差，再確認恢復 0.25 秒')
    expect(guide).toContain('全程由你操控')
    expect(guide).toContain('不要求回到固定座標或精準懸停')
    expect(guide).toContain('引導練習不限時，挑戰 300 秒')
    expect(trainingObjective('basic-recovery', null)?.title).toBe('1／8 起飛區地面準備')
    expect(trainingObjective('basic-recovery', { metrics: { recoveryPhase: 1 } })?.detail).toContain('從地面自行起飛到離地 3 m 以上')
    const preparing = trainingObjective('basic-recovery', { metrics: baseline })!
    expect(preparing.detail).toContain('準備確認 0.10／0.10 s')
    expect(preparing.detail).not.toContain('已偵測')
  })

  it.each([
    [2, '製造小幅傾斜', '實際傾角達到 15°'],
    [4, '製造小幅下沉', '下降速度達到 0.5 m/s'],
    [6, '建立水平漂移', '實際水平速度達到 1.2 m/s'],
  ] as const)('uses the ready state to guide phase %s onset without claiming recovery', (recoveryPhase, label, threshold) => {
    const goal = trainingObjective('basic-recovery', { metrics: { ...baseline, recoveryPhase, exerciseReady: 1 } })!
    expect(goal.title).toContain(label)
    expect(goal.detail).toContain('現在由你製造小幅偏差')
    expect(goal.detail).toContain(threshold)
    expect(goal.detail).not.toContain('已偵測到實際')
  })

  it.each([
    [3, '主動修回水平', '已偵測到實際傾斜', '主動修回 12° 內'],
    [5, '止住下沉', '已偵測到實際下沉', '−0.2～+2 m/s'],
    [7, '減速並修回水平', '已偵測到實際水平漂移', '水平速度降至 1.0 m/s 內'],
  ] as const)('guides the actual observed phase %s recovery and short confirmation', (recoveryPhase, label, observed, action) => {
    const metrics = { ...baseline, recoveryPhase, currentEpisodeValid: 1, recoveryDwellSeconds: 0.23 }
    const goal = trainingObjective('basic-recovery', { metrics })!
    expect(goal.title).toContain(label)
    expect(goal.detail).toContain(observed)
    expect(goal.detail).toContain(action)
    expect(goal.detail).toContain('恢復確認 0.23／0.25 s')
    expect(goal.detail).toContain('至少 1 m 高度')
    expect(goal.detail).toContain('不要求回到原位置')
    expect(trainingHint('basic-recovery', { status: 'continue', metrics, hint: '依序穿越下一個目標。' })).toContain(observed)
  })

  it('shows the actual blocker while preparing rather than telling a learner to induce an error too early', () => {
    for (const [changes, cause] of [
      [{ altitudeM: 2.8 }, '先自行升到 3 m 以上'],
      [{ tiltDegrees: 16 }, '目前傾角 16.0°'],
      [{ bodyRateDegreesPerSecond: 100 }, '目前旋轉速度 100.0°/s'],
      [{ verticalSpeedMps: -1.6 }, '調整到 -1.5～+1.5 m/s'],
    ] as const) {
      const goal = trainingObjective('basic-recovery', { metrics: { ...baseline, ...changes } })!
      expect(goal.detail).toContain(cause)
      expect(goal.detail).not.toContain('現在由你製造')
    }
    const sinkTooLow = trainingObjective('basic-recovery', { metrics: { ...baseline,
      recoveryPhase: 4, exerciseReady: 1, altitudeM: 2.3 } })!
    expect(sinkTooLow.detail).toContain('下沉練習要先回到至少 2.5 m')
    expect(sinkTooLow.detail).not.toContain('下降速度達到')
  })

  it.each([
    [{ groundTouching: 1, altitudeM: 0.06 }, '碰地停住不算空中恢復'],
    [{ altitudeM: 0.8 }, '低於本項恢復需要的 1 m'],
  ] as const)('requires a fresh actual onset after unsafe episode interruption: %j', (changes, cause) => {
    const metrics = { ...baseline, recoveryPhase: 5, exercisesCompleted: 1,
      currentEpisodeValid: 0, episodeInterrupted: 1, ...changes }
    const goal = trainingObjective('basic-recovery', { metrics })!
    expect(goal.detail).toContain(cause)
    expect(goal.detail).toContain('先前已完成的整項練習會保留')
    expect(goal.detail).toContain('本項需重新製造偏差')
    expect(goal.detail).not.toContain('已偵測到實際下沉')
  })

  it('distinguishes re-preparation and re-onset from resuming a stale recovery checkpoint', () => {
    const interrupted = { ...baseline, recoveryPhase: 7, exercisesCompleted: 2, episodeInterrupted: 1 }
    const prepare = trainingObjective('basic-recovery', { metrics: interrupted })!
    expect(prepare.detail).toContain('本項恢復已中斷')
    expect(prepare.detail).toContain('準備確認')
    expect(prepare.detail).not.toContain('已偵測到實際水平漂移')
    const repeat = trainingObjective('basic-recovery', { metrics: { ...interrupted, exerciseReady: 1 } })!
    expect(repeat.detail).toContain('重新製造本項偏差')
    expect(repeat.detail).toContain('先前的偏差不會沿用')
    expect(repeat.detail).toContain('實際水平速度達到 1.2 m/s')
  })

  it('pauses outside the broad area and preserves a still-valid onset for return', () => {
    const goal = trainingObjective('basic-recovery', { metrics: { ...baseline,
      recoveryPhase: 5, currentEpisodeValid: 1, insideRecoveryArea: 0 } })!
    expect(goal.detail).toContain('起飛點半徑 40 m')
    expect(goal.detail).toContain('不必回到原起飛點')
    expect(goal.detail).toContain('已偵測到的偏差會保留')
    expect(goal.detail).toContain('出區期間不累積確認時間')
    expect(goal.detail).not.toContain('重新製造')
  })

  it('limits stage facts to three localized finite observations and keeps signed vertical motion clear', () => {
    const sink = { ...baseline, recoveryPhase: 5, currentEpisodeValid: 1, verticalSpeedMps: -1.2,
      recoveryDwellSeconds: 0.12, impossibleInternalAccumulator: 99 }
    expect(formatTrainingMetrics(sink, 'basic-recovery', 10)).toEqual([
      { key: 'verticalSpeedMps', label: '升降速度（上＋／下−）', value: '-1.20 m/s' },
      { key: 'altitudeM', label: '離地高度', value: '6.00 m' },
      { key: 'recoveryDwellSeconds', label: '恢復確認時間', value: '0.12 / 0.25 s' },
    ])
    const drift = formatTrainingMetrics({ ...baseline, recoveryPhase: 7, currentEpisodeValid: 1,
      horizontalSpeedMps: 2.1, tiltDegrees: 12 }, 'basic-recovery')
    expect(drift.map(({ key }) => key)).toEqual(['horizontalSpeedMps', 'tiltDegrees', 'recoveryDwellSeconds'])
    expect(formatTrainingMetrics({ ...baseline, verticalSpeedMps: -1.6 }, 'basic-recovery').map(({ key }) => key))
      .toEqual(['verticalSpeedMps', 'altitudeM', 'preparationDwellSeconds'])
    const unknown = trainingObjective('basic-recovery', { metrics: { ...baseline,
      preparationDwellSeconds: Number.NaN, altitudeM: Infinity, tiltDegrees: Infinity,
      bodyRateDegreesPerSecond: Infinity, horizontalSpeedMps: Infinity, verticalSpeedMps: Infinity } })!
    expect(unknown.detail).not.toMatch(/NaN|Infinity/)
  })

  it('uses only the current exercise preparation limits and accepts relaxed sink recovery', () => {
    const tilt = trainingObjective('basic-recovery', { metrics: { ...baseline, horizontalSpeedMps: 4 } })!
    expect(tilt.detail).toContain('容許持續水平移動')
    expect(tilt.detail).not.toContain('先朝移動反方向')
    const sink = trainingObjective('basic-recovery', { metrics: { ...baseline, recoveryPhase: 4,
      tiltDegrees: 20, horizontalSpeedMps: 2, verticalSpeedMps: 1 } })!
    expect(sink.detail).toContain('容許些微傾斜與側移')
    const descending = trainingObjective('basic-recovery', { metrics: { ...baseline, recoveryPhase: 4,
      verticalSpeedMps: -0.3 } })!
    expect(descending.detail).toContain('調整到 -0.2～+1.5 m/s')
    const drift = trainingObjective('basic-recovery', { metrics: { ...baseline, recoveryPhase: 6,
      horizontalSpeedMps: 0.9 } })!
    expect(drift.detail).toContain('減速至 0.8 m/s 內')
    const recoveringSink = trainingObjective('basic-recovery', { metrics: { ...baseline, recoveryPhase: 5,
      currentEpisodeValid: 1, tiltDegrees: 20, verticalSpeedMps: 1 } })!
    expect(recoveringSink.detail).toContain('容許適度爬升')
    expect(recoveringSink.detail).toContain('機身在 25° 內')
    expect(recoveringSink.detail).not.toContain('±0.6')
  })

  it('only declares completion at the final stage and describes repeated practice rather than mastery', () => {
    expect(trainingObjective('basic-recovery', { metrics: { ...baseline, recoveryPhase: 7,
      currentEpisodeValid: 1 } })?.detail).not.toContain('現在可以 Disarm')
    const done = trainingObjective('basic-recovery', { metrics: { recoveryPhase: 8, exercisesCompleted: 3 } })!
    expect(done.title).toContain('三項基礎失誤恢復已完成')
    expect(done.detail).toContain('現在可以 Disarm')
    expect(done.detail).not.toMatch(/熟練|完美/)
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '本次發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['失誤恢復停止：資料中斷、時間倒退或模擬被重設。', '飛行資料無效、中斷或被重設'],
    ['失誤恢復挑戰逾時：尚未完成三種實際偏差與恢復。', '基礎恢復挑戰逾時'],
  ])('prioritizes terminal cause over stale active retention: %s', (message, cause) => {
    const hint = trainingHint('basic-recovery', { status: 'failure', message,
      metrics: { ...baseline, recoveryPhase: 5, currentEpisodeValid: 1, episodeInterrupted: 1 } })
    expect(hint).toContain(cause)
    expect(hint).toContain('再練一次')
    expect(hint).toContain('清空本次步驟')
    expect(hint).not.toMatch(/保留|已偵測到實際/)
  })
})

describe('L10 full-roll coaching', () => {
  const ready = { rollPhase: 3, rollEpisodeValid: 1, rollInterrupted: 0, rollProgressDegrees: 0,
    rollDirection: 0, rollInverted: 0, rollCompleted: 0, altitudeM: 10, insideRollArea: 1,
    groundTouching: 0, tiltDegrees: 0, bodyRateDegreesPerSecond: 0, horizontalSpeedMps: 0,
    verticalSpeedMps: 0, preparationDwellSeconds: 0.1, recoveryDwellSeconds: 0 }

  it('introduces self takeoff, sufficient height, continuous Roll and airborne recovery in order', () => {
    const route = trainingRouteGuide('full-roll')!
    expect(route).toMatch(/地面自行起飛.*至少 8 m.*約 10 m.*短暫準備 0.1 秒.*橫滾一圈.*空中恢復控制 0.25 秒/)
    expect(route).toContain('沿機頭到機尾的軸翻轉')
    expect(route).toContain('引導練習不限時，挑戰 300 秒')
    expect(trainingObjective('full-roll', null)?.title).toContain('地面準備')
    expect(trainingObjective('full-roll', { metrics: { rollPhase: 1 } })?.detail).toContain('完整橫滾會經過倒置')
  })

  it('shows actual progress and direction without treating a large bank as a complete roll', () => {
    const metrics = { ...ready, rollProgressDegrees: 120, rollDirection: -1 }
    expect(formatTrainingMetrics(metrics, 'full-roll')).toEqual([
      { key: 'rollProgressDegrees', label: '本圈橫滾進度', value: '120.0 / 360°' },
      { key: 'rollDirection', label: '橫滾方向', value: '向左' },
      { key: 'altitudeM', label: '離地高度', value: '10.00 m' },
    ])
    const detail = trainingObjective('full-roll', { metrics })!.detail
    expect(detail).toContain('約 120.0°')
    expect(detail).toContain('繼續向左橫滾，保持本圈同一方向')
    expect(detail).not.toContain('已完成本圈橫滾')
    expect(trainingObjective('full-roll', { metrics: ready })?.detail).toContain('選擇向左或向右 Roll')
  })

  it('distinguishes the observed inverted halfway point from full-turn recovery', () => {
    const halfway = { ...ready, rollPhase: 4, rollProgressDegrees: 181, rollDirection: 1, rollInverted: 1 }
    const detail = trainingObjective('full-roll', { metrics: halfway })!.detail
    expect(detail).toContain('已觀察到本圈倒置')
    expect(detail).toContain('繼續向右完成剩下的橫滾')
    expect(detail).toContain('倒置後反向翻回原姿態尚未完成一圈')
    expect(detail).not.toContain('現在停止旋轉並恢復正飛')
    const finishedTurn = trainingObjective('full-roll', { metrics: { ...halfway,
      rollPhase: 5, rollProgressDegrees: 355, rollCompleted: 1, tiltDegrees: 30,
      bodyRateDegreesPerSecond: 110, recoveryDwellSeconds: 0.1 } })!
    expect(finishedTurn.detail).toContain('已完成本圈橫滾，現在停止旋轉並恢復正飛')
    expect(finishedTurn.detail).toContain('目前傾角 30.0°')
    expect(finishedTurn.detail).toContain('110.0°/s')
    expect(finishedTurn.detail).toContain('恢復確認 0.10／0.25 s')
  })

  it('names preparation blockers with measured values and prioritizes the blocked instrument', () => {
    const low = { ...ready, rollPhase: 2, rollEpisodeValid: 0, altitudeM: 7.2 }
    expect(trainingObjective('full-roll', { metrics: low })?.detail).toContain('目前離地 7.2 m；先升回至少 8 m')
    expect(formatTrainingMetrics(low, 'full-roll').map(({ key }) => key)).toEqual(['altitudeM', 'verticalSpeedMps', 'preparationDwellSeconds'])
    expect(trainingObjective('full-roll', { metrics: { ...low, altitudeM: 10, tiltDegrees: 27 } })?.detail)
      .toContain('目前傾角 27.0°；先主動帶回 20° 內')
    expect(trainingObjective('full-roll', { metrics: { ...low, altitudeM: 10, verticalSpeedMps: -4 } })?.detail)
      .toContain('目前升降速度 -4.0 m/s（上＋／下−）')
    expect(trainingObjective('full-roll', { metrics: { ...low, altitudeM: 10, preparationDwellSeconds: 0.04 } })?.detail)
      .toContain('準備確認 0.04／0.10 s')
  })

  it.each([
    [{ groundTouching: 1, altitudeM: 0.1 }, '地面停住不能完成空中恢復'],
    [{ altitudeM: 1.2 }, '低於空中恢復需要的 1.5 m'],
    [{ insideRollArea: 0, launchDistanceM: 63 }, '距起飛點 63.0 m'],
    [{ rollEpisodeValid: 0, rollInterrupted: 1 }, '本圈橫滾已中斷'],
  ])('requires a fresh complete maneuver after an interrupted episode: %j', (changes, reason) => {
    const objective = trainingObjective('full-roll', { metrics: { ...ready, rollPhase: 5,
      rollCompleted: 0, rollInverted: 0, ...changes } })!
    expect(objective.detail).toContain(reason)
    expect(objective.detail).toContain('重新準備並完成一整圈')
    expect(objective.detail).not.toContain('已完成本圈橫滾')
    expect(objective.detail).not.toContain('可以 Disarm')
  })

  it('continues a freshly prepared maneuver despite historical inverted and upright checkpoints', () => {
    const objective = trainingObjective('full-roll', { metrics: { ...ready, rollPhase: 5,
      rollInterrupted: 1, rollProgressDegrees: 0, rollCompleted: 0, rollInverted: 0 } })!
    expect(objective.detail).toContain('本圈重新開始')
    expect(objective.detail).toContain('選擇向左或向右 Roll')
    expect(objective.detail).not.toContain('已完成本圈橫滾')
  })

  it('only offers disarm after all stages and explains recovery rather than granting mastery', () => {
    const recovering = { ...ready, rollPhase: 5, rollInverted: 1, rollCompleted: 1,
      rollProgressDegrees: 357, verticalSpeedMps: -2, recoveryDwellSeconds: 0.15 }
    expect(trainingHint('full-roll', { status: 'continue', metrics: recovering })).toContain('升降速度 -2.0 m/s')
    expect(trainingHint('full-roll', { status: 'continue', metrics: recovering })).toContain('−1.5～+3 m/s')
    expect(formatTrainingMetrics(recovering, 'full-roll')[2]).toEqual({ key: 'recoveryDwellSeconds', label: '正飛恢復確認', value: '0.15 / 0.25 s' })
    expect(trainingObjective('full-roll', { metrics: recovering })?.detail).not.toContain('可以 Disarm')
    const done = trainingObjective('full-roll', { metrics: { ...recovering, rollPhase: 6 } })!
    expect(done.detail).toContain('可以 Disarm')
    expect(done.detail).not.toMatch(/熟練|完美/)
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '本次發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['橫滾停止：姿態與角速度不一致。', '飛行資料無效、中斷或被重設'],
    ['橫滾挑戰逾時：尚未完成完整橫滾與空中恢復。', '完整橫滾挑戰逾時'],
  ])('preserves the terminal cause before stale live coaching: %s', (message, reason) => {
    const text = trainingHint('full-roll', { status: 'failure', message,
      metrics: { ...ready, rollPhase: 5, rollInterrupted: 1, rollCompleted: 1 } })
    expect(text).toContain(reason)
    expect(text).toContain('清空本次步驟')
    expect(text).not.toMatch(/先前步驟保留|已完成本圈橫滾|可以 Disarm/)
  })
})

describe('retained full-roll interruption diagnostics', () => {
  it.each([
    [1, {}, '這一圈曾接地'],
    [2, { interruptionAltitudeM: 1.1 }, '中斷時離地 1.1 m'],
    [3, { interruptionLaunchDistanceM: 65 }, '中斷時距起飛點 65.0 m'],
    [4, { interruptionOffAxisDegrees: 123 }, '俯仰／偏航旋轉累積約 123.0°'],
    [5, {}, '這一圈持續過轉'],
    [6, {}, '這一圈反向轉過了起始姿態'],
    [7, { interruptionAltitudeM: 7.7 }, '尚未開始橫滾便降到離地 7.7 m'],
  ] as const)('keeps the captured cause readable after returning to an otherwise ready position: %s', (reason, captured, expected) => {
    const detail = trainingObjective('full-roll', { metrics: { rollPhase: 4, rollInterrupted: 1,
      rollInterruptionReason: reason, rollEpisodeValid: 0, groundTouching: 0, insideRollArea: 1,
      altitudeM: 10, tiltDegrees: 0, bodyRateDegreesPerSecond: 0, horizontalSpeedMps: 0,
      verticalSpeedMps: 0, preparationDwellSeconds: 0, ...captured } })!.detail
    expect(detail).toContain(expected)
    expect(detail).toContain('重新準備並完成一整圈')
    expect(detail).not.toContain('已完成本圈橫滾')
  })
})

describe('L11 front and back flip coaching', () => {
  const ready = { flipPhase: 3, flipEpisodeValid: 1, flipInterrupted: 0,
    flipProgressDegrees: 0, flipDirection: 0, flipInverted: 0, flipCompleted: 0,
    altitudeM: 10, insideFlipArea: 1, groundTouching: 0, tiltDegrees: 0,
    bodyRateDegreesPerSecond: 0, horizontalSpeedMps: 0, verticalSpeedMps: 0,
    preparationDwellSeconds: 0.1, recoveryDwellSeconds: 0 }

  it('teaches the ground-start pitch maneuver without confusing inversion and backward flight', () => {
    const guide = trainingRouteGuide('full-flip')!
    expect(guide).toMatch(/地面自行起飛.*至少 8 m.*約 10 m.*前翻或後翻.*空中恢復控制 0.2 秒/)
    expect(guide).toContain('機身左右兩側的俯仰軸')
    expect(guide).toContain('半徑 80 m')
    expect(guide).toContain('引導練習不限時，挑戰 300 秒')
    expect(guide).not.toMatch(/Flip|Roll|Pitch|Yaw|倒飛/)
    expect(trainingHint('full-flip', null)).toContain('選擇前翻或後翻')
    expect(trainingObjective('full-flip', null)?.title).toContain('地面準備')
    expect(trainingObjective('full-flip', { metrics: { flipPhase: 1 } })?.detail).toContain('完整翻轉會經過倒置')
    expect(fullFlipStageLabel(3)).toBe('通過倒置姿態')
    expect(fullFlipStageLabel(Number.NaN)).toBe('目前翻轉練習')
  })

  it.each([[1, '前翻'], [-1, '後翻']] as const)('shows measured progress and the actual direction %s', (direction, name) => {
    const metrics = { ...ready, flipProgressDegrees: 83, flipDirection: direction }
    expect(formatTrainingMetrics(metrics, 'full-flip')).toEqual([
      { key: 'flipProgressDegrees', label: '本圈翻轉進度', value: '83.0 / 360°' },
      { key: 'flipDirection', label: '翻轉方向', value: name },
      { key: 'altitudeM', label: '離地高度', value: '10.00 m' },
    ])
    const detail = trainingObjective('full-flip', { metrics })!.detail
    expect(detail).toContain('約 83.0°')
    expect(detail).toContain(`繼續${name}`)
    expect(detail).not.toContain('已完成本圈翻轉')
    expect(detail).not.toMatch(/側立|Roll|Pitch|Yaw|Flip/)
  })

  it('keeps an unselected direction distinct from observed front or back rotation', () => {
    expect(formatTrainingMetrics(ready, 'full-flip')[1].value).toBe('尚未選定')
    expect(trainingObjective('full-flip', { metrics: ready })?.detail).toContain('選擇前翻或後翻')
    const detail = trainingObjective('full-flip', { metrics: { ...ready,
      flipPhase: 4, flipInverted: 1, flipDirection: -1, flipProgressDegrees: 181 } })!.detail
    expect(detail).toContain('已觀察到本圈倒置')
    expect(detail).toContain('繼續後翻完成剩下的翻轉')
    expect(detail).toContain('倒置後反向翻回原姿態尚未完成一圈')
    expect(detail).not.toContain('現在停止旋轉並恢復正飛')
  })

  it.each([
    [{ altitudeM: 7.2 }, '目前離地 7.2 m；先升回至少 8 m', 'altitudeM'],
    [{ tiltDegrees: 31 }, '目前傾角 31.0°；先主動帶回 25° 內', 'tiltDegrees'],
    [{ bodyRateDegreesPerSecond: 140 }, '目前機身旋轉速度 140.0°/s', 'bodyRateDegreesPerSecond'],
    [{ horizontalSpeedMps: 9.3 }, '目前水平速度 9.3 m/s', 'horizontalSpeedMps'],
    [{ verticalSpeedMps: -4.2 }, '目前升降速度 -4.2 m/s（上＋／下−）', 'verticalSpeedMps'],
  ] as const)('names the actual preparation blocker: %j', (changes, observed, instrument) => {
    const metrics = { ...ready, flipPhase: 2, flipEpisodeValid: 0, ...changes }
    expect(trainingObjective('full-flip', { metrics })?.detail).toContain(observed)
    expect(formatTrainingMetrics(metrics, 'full-flip')[0].key).toBe(instrument)
  })

  it('shows actual recovery blockers only after a valid completed turn', () => {
    const recovery = { ...ready, flipPhase: 5, flipInverted: 1, flipCompleted: 1,
      flipProgressDegrees: 355, tiltDegrees: 37, bodyRateDegreesPerSecond: 150,
      recoveryDwellSeconds: 0.08 }
    const goal = trainingObjective('full-flip', { metrics: recovery })!
    expect(goal.detail).toContain('已完成本圈翻轉，現在停止旋轉並恢復正飛')
    expect(goal.detail).toContain('目前傾角 37.0°，先主動修回 30° 內')
    expect(goal.detail).toContain('150.0°/s')
    expect(goal.detail).toContain('恢復確認 0.08／0.20 s')
    expect(goal.detail).not.toContain('可以解除解鎖')
    expect(formatTrainingMetrics(recovery, 'full-flip')[2]).toEqual({
      key: 'recoveryDwellSeconds', label: '正飛恢復確認', value: '0.08 / 0.20 s',
    })
    expect(trainingHint('full-flip', { status: 'continue', metrics: {
      ...recovery, tiltDegrees: 0, bodyRateDegreesPerSecond: 0, verticalSpeedMps: -3.1,
    } })).toContain('−2.5～+4 m/s')
    const done = trainingObjective('full-flip', { metrics: { ...recovery, flipPhase: 6 } })!
    expect(done.detail).toContain('可以解除解鎖')
    expect(done.detail).not.toMatch(/熟練|完美/)
  })

  it.each([
    [1, {}, '這一圈曾接地'],
    [2, { interruptionAltitudeM: 1.1 }, '中斷時離地 1.1 m'],
    [3, { interruptionLaunchDistanceM: 85 }, '中斷時距起飛點 85.0 m'],
    [4, { interruptionOffAxisDegrees: 124 }, '橫滾／偏航旋轉累積約 124.0°'],
    [5, {}, '這一圈持續過轉'],
    [6, {}, '這一圈反向轉過了起始姿態'],
    [7, { interruptionAltitudeM: 7.7 }, '尚未開始翻轉便降到離地 7.7 m'],
  ] as const)('retains the captured interrupted-maneuver cause after current values normalize: %s', (reason, captured, expected) => {
    const metrics = { ...ready, flipPhase: 5, flipEpisodeValid: 0,
      flipInterrupted: 1, flipInterruptionReason: reason, ...captured }
    expect(fullFlipInterruptionReason(metrics)).toContain(expected)
    const detail = trainingObjective('full-flip', { metrics })!.detail
    expect(detail).toContain(expected)
    expect(detail).toContain('重新準備並完成一整圈')
    expect(detail).not.toMatch(/已完成本圈翻轉|可以解除解鎖/)
  })

  it('keeps the original interruption separate from the present correction', () => {
    const detail = trainingObjective('full-flip', { metrics: { ...ready,
      flipPhase: 5, flipEpisodeValid: 0, flipInterrupted: 1, flipInterruptionReason: 4,
      interruptionOffAxisDegrees: 129, altitudeM: 6.7,
    } })!.detail
    expect(detail).toContain('橫滾／偏航旋轉累積約 129.0°')
    expect(detail).toContain('目前離地 6.7 m；先升回至少 8 m')
    expect(detail).not.toContain('中斷時離地 6.7 m')
    const fresh = trainingObjective('full-flip', { metrics: { ...ready,
      flipPhase: 5, flipProgressDegrees: 0, flipCompleted: 0, flipInverted: 0,
    } })!.detail
    expect(fresh).toContain('選擇前翻或後翻')
    expect(fresh).not.toContain('已完成本圈翻轉')
  })

  it.each([
    ['Ground impact latched a crash; reset required.', '本次發生墜毀'],
    ['Flight disarmed after focus was lost.', '解除解鎖、失去焦點'],
    ['翻轉停止：姿態與角速度不一致。', '飛行資料無效、中斷或被重設'],
    ['翻轉挑戰逾時：尚未完成完整翻轉。', '完整翻轉挑戰逾時'],
  ])('preserves the terminal cause before stale live progress: %s', (message, cause) => {
    const hint = trainingHint('full-flip', { status: 'failure', message,
      metrics: { ...ready, flipPhase: 6, flipCompleted: 1, flipInverted: 1 } })
    expect(hint).toContain(cause)
    expect(hint).toContain('清空本次步驟')
    expect(hint).not.toMatch(/先前步驟保留|已完成本圈翻轉|可以解除解鎖/)
  })
})

describe('separate forward and backward flip coaching', () => {
  const ready = { flipPhase: 3, flipEpisodeValid: 1, flipInterrupted: 0,
    flipProgressDegrees: 0, flipDirection: 0, flipInverted: 0, flipCompleted: 0,
    altitudeM: 10, insideFlipArea: 1, groundTouching: 0, tiltDegrees: 0,
    bodyRateDegreesPerSecond: 0, horizontalSpeedMps: 0, verticalSpeedMps: 0,
    preparationDwellSeconds: 0.1, recoveryDwellSeconds: 0 }
  const courses = [['front-flip', 1, '前翻', '後翻'], ['back-flip', -1, '後翻', '前翻']] as const

  it.each(courses)('teaches only the required direction of %s even with a stale requirement metric', (id, direction, expected) => {
    expect(trainingHint(id, null)).toContain(`本課練${expected}`)
    expect(trainingRouteGuide(id)).toContain(`沿俯仰軸連續${expected}一整圈`)
    expect(trainingRouteGuide(id)).toContain('反方向翻轉不計入本課')
    expect(trainingRouteGuide(id)).not.toContain('選前翻或後翻')
    const detail = trainingObjective(id, { metrics: { ...ready, flipRequiredDirection: -direction } })!.detail
    expect(detail).toContain(`本課練${expected}`)
    expect(detail).toContain(`繼續${expected}`)
    expect(detail).not.toContain('選擇前翻或後翻')
    expect(formatTrainingMetrics(ready, id)[1].value).toBe(`尚未開始${expected}`)
  })

  it.each(courses)('rejects opposite-direction live completion claims in %s', (id, direction, expected, opposite) => {
    for (const phase of [3, 5, 6]) {
      const evaluation = { status: 'continue' as const, metrics: { ...ready, flipPhase: phase,
        flipDirection: -direction, flipRequiredDirection: -direction, flipProgressDegrees: phase === 3 ? 43 : 360,
        flipInverted: 1, flipCompleted: 1 } }
      const detail = trainingObjective(id, evaluation)!.detail
      expect(detail).toContain(`本課練${expected}；剛才往${opposite}`)
      expect(detail).toContain('先回正重新準備')
      expect(detail).not.toMatch(/已完成本圈翻轉|可以解除解鎖/)
      expect(trainingHint(id, evaluation)).toContain(`本課練${expected}`)
    }
  })

  it.each(courses)('retains the actual wrong-direction snapshot in %s after controls normalize', (id, direction, expected, opposite) => {
    const metrics = { ...ready, flipPhase: 5, flipEpisodeValid: 0, flipInterrupted: 1,
      flipInterruptionReason: 8, flipRequiredDirection: -direction,
      interruptionFlipDirection: -direction, interruptionFlipProgressDegrees: 17.4 }
    const reason = fullFlipInterruptionReason(metrics, id)!
    expect(reason).toContain(`本課練${expected}`)
    expect(reason).toContain(`中斷時往${opposite}約 17.4°`)
    expect(reason).toContain('這一圈不計入本課')
    const detail = trainingObjective(id, { metrics })!.detail
    expect(detail).toContain(reason)
    expect(detail).toContain('先回正重新準備')
    expect(formatTrainingMetrics(metrics, id).slice(0, 2)).toEqual([
      { key: 'interruptionFlipDirection', label: '中斷時翻轉方向', value: opposite },
      { key: 'interruptionFlipProgressDegrees', label: '中斷時翻轉進度', value: '17.4 °' },
    ])
    const fresh = trainingObjective(id, { metrics: { ...metrics, flipInterrupted: 0,
      flipEpisodeValid: 1, flipDirection: direction, flipProgressDegrees: 354,
      flipInverted: 1, flipCompleted: 1 } })!.detail
    expect(fresh).toContain('已完成本圈翻轉')
    expect(fresh).not.toContain('中斷時往')
  })

  it.each(courses)('does not accept a phase-six marker without measured direction in %s', (id, _direction, expected) => {
    const detail = trainingObjective(id, { metrics: { ...ready, flipPhase: 6 } })!.detail
    expect(detail).toContain(`本課練${expected}`)
    expect(detail).toContain('缺少指定方向的實際旋轉證據')
    expect(detail).not.toContain('可以解除解鎖')
  })

  it.each(courses)('keeps terminal flight failures ahead of opposite-direction metadata in %s', (id, direction) => {
    const text = trainingHint(id, { status: 'failure', message: 'Ground impact latched a crash.',
      metrics: { ...ready, flipPhase: 6, flipDirection: -direction, flipCompleted: 1 } })
    expect(text).toContain('本次發生墜毀')
    expect(text).toContain('清空本次步驟')
    expect(text).not.toContain('剛才往')
  })
})

describe('大迴旋 observations and recovery guidance', () => {
  it('introduces actual spatial flight and eight separate stages', () => {
    const guide = trainingRouteGuide('power-loop')
    expect(guide).toContain('前速')
    expect(guide).toContain('前後跨度')
    expect(guide).toContain('原地後翻')
    expect(guide).toContain('引導練習不限時')
    expect(trainingObjective('power-loop', null)?.title).toBe('1／8 起飛區地面準備')
    for (let phase = 1; phase < 8; phase += 1) {
      expect(trainingObjective('power-loop', { metrics: { loopPhase: phase, loopEpisodeValid: 1 } })?.title)
        .toContain(`${phase + 1}／8`)
    }
  })

  it('shows the specific entry blocker before asking for a loop', () => {
    const low = trainingObjective('power-loop', { metrics: { loopPhase: 2, loopEpisodeValid: 0, altitudeM: 4.3, loopForwardSpeedMps: 1.2 } })
    expect(low?.detail).toContain('4.3 m')
    expect(low?.detail).toContain('至少 6 m')
    const slow = trainingHint('power-loop', { status: 'continue', metrics: { loopPhase: 2, loopEpisodeValid: 0, altitudeM: 10, loopForwardSpeedMps: 1.2 } })
    expect(slow).toContain('1.2 m/s')
    expect(slow).toContain('至少 3 m/s')
    expect(slow).toContain('原地後翻不算')
  })

  it('reports rise/span and rearward movement without pretending body rotation proves a loop', () => {
    const climb = trainingObjective('power-loop', { metrics: { loopPhase: 3, loopEpisodeValid: 1, loopHeightGainM: 1.2, loopForwardSpanM: 3.1, loopProgressDegrees: 360 } })
    expect(climb?.detail).toContain('拉升 1.2 m')
    expect(climb?.detail).toContain('跨度 3.1 m')
    expect(climb?.detail).toContain('原地翻一圈不會完成')
    const crest = trainingObjective('power-loop', { metrics: { loopPhase: 4, loopEpisodeValid: 1 } })
    expect(crest?.detail).toContain('1.5 m')
    const descent = trainingObjective('power-loop', { metrics: { loopPhase: 5, loopEpisodeValid: 1, loopProgressDegrees: 210 } })
    expect(descent?.detail).toContain('210.0 °')
    expect(descent?.detail).toContain('下降至少 2 m')
  })

  it('keeps interruption facts after altitude is regained and never congratulates stale final phases', () => {
    const detail = trainingObjective('power-loop', { metrics: { loopPhase: 7, loopEpisodeValid: 0, loopInterrupted: 1, loopInterruptionReason: 2, interruptionAltitudeM: 0.8, altitudeM: 10 } })?.detail
    expect(detail).toContain('中斷時離地 0.8 m')
    expect(detail).toContain('舊倒置')
    const stale = trainingObjective('power-loop', { metrics: { loopPhase: 8, loopEpisodeValid: 0, loopInterrupted: 1, loopInterruptionReason: 1 } })
    expect(stale?.title).not.toContain('完成')
    expect(stale?.detail).toContain('曾接地')
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('explains interruption reason %s', (reason) => {
    const objective = trainingObjective('power-loop', { metrics: { loopPhase: 5, loopEpisodeValid: 0, loopInterrupted: 1, loopInterruptionReason: reason } })
    expect(objective?.detail).toContain('本圈已中斷')
    expect(objective?.detail).toContain('新的一整圈')
  })

  it('reports the too-small maneuver span rather than counting approach or exit travel', () => {
    const objective = trainingObjective('power-loop', { metrics: { loopPhase: 6, loopEpisodeValid: 0,
      loopInterrupted: 1, loopInterruptionReason: 9, interruptionForwardSpanM: 2.4,
      loopForwardSpanM: 0, altitudeM: 12 } })
    expect(objective?.detail).toContain('只有 2.4 m')
    expect(objective?.detail).toContain('尚未達到 6 m')
    expect(objective?.detail).toContain('進場直線與回正後直飛不計入')
    expect(objective?.detail).toContain('放慢後拉')
    expect(objective?.title).not.toContain('完成')
  })

  it('prioritizes usable measurements and explicit recovery limits', () => {
    expect(formatTrainingMetrics({ loopPhase: 3, loopEpisodeValid: 1, loopHeightGainM: 2.5, loopForwardSpanM: 7.2, verticalSpeedMps: 3.1 }, 'power-loop')).toEqual([
      { key: 'loopHeightGainM', label: '本圈拉升高度', value: '2.50 m' },
      { key: 'loopForwardSpanM', label: '本圈前後跨度', value: '7.20 m' },
      { key: 'verticalSpeedMps', label: '升降速度（上＋／下−）', value: '3.10 m/s' },
    ])
    const recovering = trainingObjective('power-loop', { metrics: { loopPhase: 7, loopEpisodeValid: 1, tiltDegrees: 42, bodyRateDegreesPerSecond: 170, loopRecoveryDwellSeconds: 0.1 } })
    expect(recovering?.detail).toContain('42.0°')
    expect(recovering?.detail).toContain('170.0°/s')
    expect(recovering?.detail).toContain('0.10 s／0.20 s')
    expect(trainingObjective('power-loop', { metrics: { loopPhase: 8, loopEpisodeValid: 1, loopCompleted: 1, loopInverted: 1, loopDescended: 1 } })?.title).toContain('8／8 大迴旋與空中改出完成')
  })

  it.each([
    ['Obstacle collision: ground', '墜毀'],
    ['Controller disconnect', '連線中斷'],
    ['姿態跳躍', '資料無效'],
    ['timeout', '挑戰逾時'],
  ])('distinguishes final failure %s', (message, expected) => {
    expect(trainingHint('power-loop', { status: 'failure', message })).toContain(expected)
  })
})

describe('翻轉下降 measured guidance', () => {
  const ready = { splitPhase: 3, splitEpisodeValid: 1, splitInterrupted: 0, splitInverted: 0,
    splitDescended: 0, splitReversed: 0, splitCompleted: 0 }
  const proofFor = (phase: number) => ({ ...ready, splitPhase: phase,
    splitInverted: phase >= 4 ? 1 : 0, splitDescended: phase >= 5 ? 1 : 0,
    splitReversed: phase >= 6 ? 1 : 0, splitCompleted: phase >= 7 ? 1 : 0 })

  it('shows the full ground-start route and ordered roll then pitch', () => {
    const guide = trainingRouteGuide('split-s')
    expect(guide).toContain('地面自行起飛')
    expect(guide).toContain('至少 15 m')
    expect(guide).toContain('建議約 25 m')
    expect(guide).toContain('橫滾半圈至倒置')
    expect(guide).toContain('後拉俯仰走下降半迴圈')
    expect(guide).toContain('引導練習不限時')
    expect(trainingObjective('split-s', null)?.title).toBe('1／8 起飛區地面準備')
    for (let phase = 1; phase <= 7; phase += 1) expect(trainingObjective('split-s', { metrics: proofFor(phase) })?.title).toContain(`${phase + 1}／8`)
  })

  it('names altitude, speed and attitude entry blockers using measured values', () => {
    const detail = (metrics: Record<string, number>) => trainingObjective('split-s', { metrics: { splitPhase: 2, splitEpisodeValid: 0, ...metrics } })!.detail
    expect(detail({ altitudeM: 9.2 })).toContain('目前離地 9.2 m')
    expect(detail({ altitudeM: 20, splitForwardSpeedMps: 0.9 })).toContain('目前前進速度 0.9 m/s')
    expect(detail({ altitudeM: 20, splitForwardSpeedMps: 4, tiltDegrees: 49 })).toContain('目前傾角 49.0°')
  })

  it('separates roll inversion, descending pitch and actual reverse travel', () => {
    const roll = trainingObjective('split-s', { metrics: { ...proofFor(3), splitRollProgressDegrees: 83 } })!.detail
    expect(roll).toContain('本段橫滾 83.0 °')
    expect(roll).toContain('先完成實際橫滾倒置')
    expect(roll).toContain('前翻或後翻不代替')
    const dive = trainingObjective('split-s', { metrics: { ...proofFor(4), splitPitchProgressDegrees: 34, splitHeightLossM: 1.1 } })!.detail
    expect(dive).toContain('本段已下降 1.1 m')
    expect(dive).toContain('下降至少 3 m')
    const reverse = trainingObjective('split-s', { metrics: { ...proofFor(5), splitHeadingChangeDegrees: 112, splitReverseTravelM: 0.4 } })!.detail
    expect(reverse).toContain('航向變化 112.0 °')
    expect(reverse).toContain('反向行程 0.4 m')
    expect(reverse).toContain('轉機頭但仍朝原方向滑行不算')
  })

  it('follows the new episode instead of retained recovery checkpoints', () => {
    const fresh = trainingObjective('split-s', { metrics: { ...ready, splitPhase: 7 } })!
    expect(fresh.title).toBe('4／8 橫滾至倒置')
    expect(fresh.detail).not.toContain('已反向正飛改出')
    const stale = trainingObjective('split-s', { metrics: { ...proofFor(8), splitEpisodeValid: 0,
      splitInterrupted: 1, splitInterruptionReason: 2, interruptionAltitudeM: 0.7, altitudeM: 20 } })!
    expect(stale.title).not.toContain('完成')
    expect(stale.detail).toContain('中斷時離地 0.7 m')
    expect(stale.detail).toContain('舊倒置')
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('explains maneuver interruption reason %s and a fresh retry', (reason) => {
    const detail = trainingObjective('split-s', { metrics: { splitPhase: 6, splitEpisodeValid: 0, splitInterrupted: 1,
      splitInterruptionReason: reason, interruptionAltitudeM: 0.8, interruptionLaunchDistanceM: 158 } })!.detail
    expect(detail).toContain('本段已中斷')
    expect(detail).toContain('新的一整段')
  })

  it('uses measured dimensions and names recovery limits rather than generic failure', () => {
    expect(formatTrainingMetrics({ ...proofFor(4), splitPitchProgressDegrees: 44, splitHeightLossM: 1.2, splitReverseTravelM: 0.5 }, 'split-s')).toEqual([
      { key: 'splitPitchProgressDegrees', label: '倒置後俯仰轉角', value: '44.0 / 180°' },
      { key: 'splitHeightLossM', label: '本段下降高度', value: '1.20 m' },
      { key: 'splitReverseTravelM', label: '反向飛行行程', value: '0.50 m' },
    ])
    const detail = trainingObjective('split-s', { metrics: { ...proofFor(7), tiltDegrees: 51,
      verticalSpeedMps: -8, splitRecoveryDwellSeconds: 0.1 } })!.detail
    expect(detail).toContain('傾角 51.0°')
    expect(detail).toContain('−4～+5 m/s')
    expect(detail).toContain('0.10 s／0.20 s')
    expect(trainingObjective('split-s', { metrics: proofFor(8) })?.title).toContain('8／8 翻轉下降與反向改出完成')
    expect(trainingObjective('split-s', { metrics: { ...proofFor(8), splitInverted: 0 } })?.detail).toContain('缺少同一段')
  })

  it.each([['Ground impact crash', '墜毀'], ['失去焦點', '連線中斷'], ['位置跳躍', '資料無效'], ['timeout', '挑戰逾時']])('keeps terminal cause %s ahead of stale maneuver proof', (message, expected) => {
    const text = trainingHint('split-s', { status: 'failure', message, metrics: proofFor(8) })
    expect(text).toContain(expected)
    expect(text).toContain('再練一次')
    expect(text).not.toContain('改出完成')
  })
})
