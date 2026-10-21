import { describe, expect, it } from 'vitest'

import { formatTrainingMetrics, trainingHint } from './feedback'

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
