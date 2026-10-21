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

  it('shows current descent while airborne and measured contact speed only after landing', () => {
    const metrics = {
      landingHeightM: 0.8,
      landingPositionErrorM: 0.2,
      verticalSpeedMps: 0.5,
      touchdownDescentSpeedMps: 0,
      groundTouching: 0,
    }
    expect(formatTrainingMetrics(metrics, 'landing').map((metric) => metric.key))
      .toEqual(['landingHeightM', 'landingPositionErrorM', 'verticalSpeedMps'])
    expect(formatTrainingMetrics({ ...metrics, landingPhase: 4, groundTouching: 1, touchdownDescentSpeedMps: 0.6, contiguousDwellSeconds: 0.3 }, 'landing')[1])
      .toEqual({ key: 'touchdownDescentSpeedMps', label: '接地下降速度', value: '0.60 m/s' })
  })

  it('changes straight-line teaching facts from route keeping to braking and settled stop', () => {
    const metrics = {
      alongTrackM: 5,
      crossTrackErrorM: 0.2,
      altitudeErrorM: 0.1,
      stopErrorM: 3,
      forwardSpeedMps: 0.8,
      horizontalSpeedMps: 0.85,
      contiguousDwellSeconds: 0,
      routePhase: 2,
    }
    expect(formatTrainingMetrics(metrics, 'straight-line').map((metric) => metric.key))
      .toEqual(['forwardSpeedMps', 'stopErrorM', 'altitudeErrorM'])
    expect(formatTrainingMetrics({ ...metrics, routePhase: 3 }, 'straight-line').map((metric) => metric.key))
      .toEqual(['stopErrorM', 'forwardSpeedMps', 'altitudeErrorM'])
    expect(formatTrainingMetrics({ ...metrics, routePhase: 4 }, 'straight-line').map((metric) => metric.key))
      .toEqual(['stopErrorM', 'horizontalSpeedMps', 'contiguousDwellSeconds'])
  })

  it('shows takeoff facts before a ground-start course instead of final stopping or touchdown metrics', () => {
    expect(formatTrainingMetrics({ routePhase: 0, launchHeightM: 0.1, altitudeErrorM: 2.8,
      verticalSpeedMps: 0.4, stopErrorM: 8, contiguousDwellSeconds: 0 }, 'straight-line').map((metric) => metric.key))
      .toEqual(['launchHeightM', 'altitudeErrorM', 'verticalSpeedMps'])
    expect(formatTrainingMetrics({ landingPhase: 1, landingHeightM: 0.1, launchDistanceM: 0,
      verticalSpeedMps: 0.4, touchdownDescentSpeedMps: 0, groundTouching: 1 }, 'landing').map((metric) => metric.key))
      .toEqual(['landingHeightM', 'launchDistanceM', 'verticalSpeedMps'])
  })

  it('explains each straight-line stage and explicitly distinguishes crossing gold from completion', () => {
    expect(trainingRouteGuide('straight-line')).toMatch(/地面起飛.*藍色 3 m.*金色 5 m.*綠色 8 m.*1.2 秒/)
    expect(trainingRouteGuide('straight-line')).toContain('穿圈不等於完成')
    expect(trainingObjective('straight-line', { metrics: { routePhase: 0, altitudeErrorM: 2 } })?.detail)
      .toContain('距目標高度 2.0 m')
    expect(trainingObjective('straight-line', { metrics: { routePhase: 1, alongTrackM: 1 } })?.detail)
      .toContain('距中途目標 2.0 m')
    const gold = trainingObjective('straight-line', { metrics: { routePhase: 2, alongTrackM: 5.2, forwardSpeedMps: 1.2 } })
    expect(gold?.detail).toContain('穿過金色環還未完成')
    expect(gold?.detail).toContain('1.2 m/s')
    expect(trainingObjective('straight-line', { metrics: { routePhase: 2, alongTrackM: 5.2, brakeEntrySpeedMps: 0 } })?.detail)
      .toContain('至少 0.2 m/s')
    expect(trainingObjective('straight-line', { metrics: { routePhase: 3, stopErrorM: 1.4, horizontalSpeedMps: 0.5 } })?.detail)
      .toContain('距停點 1.4 m')
    expect(trainingObjective('straight-line', { metrics: { routePhase: 4, contiguousDwellSeconds: 0.7 } })?.detail)
      .toContain('再穩住 0.5 s')
    expect(trainingHint('straight-line', { status: 'continue', metrics: { routePhase: 2, alongTrackM: 5.2, forwardSpeedMps: 1.2 } }))
      .toContain('金色減速區')
  })

  it('directs landing learners from the launch pad to the separate marked target', () => {
    expect(trainingRouteGuide('landing')).toContain('降落目標與起飛墊分開')
    expect(trainingObjective('landing', { metrics: { landingPhase: 1 } })?.detail).toContain('先離地至少 0.8 m')
    expect(trainingObjective('landing', { metrics: { landingPhase: 2, landingPositionErrorM: 6.4 } })?.detail)
      .toContain('距降落區 6.4 m')
    expect(trainingObjective('landing', { metrics: { landingPhase: 3, landingPositionErrorM: 0.3, landingHeightM: 0.4 } })?.detail)
      .toContain('離地間隙 0.4 m')
    expect(trainingObjective('landing', { metrics: { landingPhase: 4, contiguousDwellSeconds: 0.4 } })?.detail)
      .toContain('再穩住 0.6 s')
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

  it('keeps restart guidance in the approved reset → countdown → explicit arm order', () => {
    const hint = trainingHint('hover', {
      status: 'failure',
      hint: 'Re-arm explicitly, then retry the lesson from its reset setup.',
    })
    expect(hint).toMatch(/先重試.*倒數結束後再明確解鎖/)
  })
})
