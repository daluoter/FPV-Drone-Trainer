import { describe, expect, it } from 'vitest'

import { formatTrainingMetrics, trainingHint, trainingObjective, trainingRouteGuide } from './feedback'

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
})
