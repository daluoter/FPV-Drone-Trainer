import { describe, expect, it } from 'vitest'

import {
  calculateSampleStatistics,
  evaluateNeutralStability,
  identifyAxisByMovement,
  isCenterStable,
  summarizeEndpointRange,
} from './calibration'
import type { ChannelPipelineValues, ProcessedChannels } from './types'

function pipeline(final: number): ChannelPipelineValues {
  return { raw: final, calibrated: final, normalized: final, deadband: final, filtered: final, final, valid: true }
}

function channels(roll: number, pitch: number, yaw: number): ProcessedChannels {
  return {
    roll: pipeline(roll),
    pitch: pipeline(pitch),
    yaw: pipeline(yaw),
    throttle: pipeline(0),
  }
}

describe('controller calibration analysis', () => {
  it('calculates center, jitter and dispersion from a valid sample matrix', () => {
    const summary = calculateSampleStatistics([
      [-0.01, 0.2],
      [0, 0.2],
      [0.01, 0.2],
    ])
    expect(summary.valid).toBe(true)
    expect(summary.axes[0].center).toBeCloseTo(0)
    expect(summary.axes[0].jitter).toBeCloseTo(0.02)
    expect(summary.axes[0].standardDeviation).toBeCloseTo(Math.sqrt(2 / 3) / 100)
    expect(isCenterStable(summary.axes[0], { minSamples: 3 })).toBe(true)
  })

  it('rejects incomplete or non-finite calibration samples', () => {
    expect(calculateSampleStatistics([]).valid).toBe(false)
    expect(calculateSampleStatistics([[0], [Number.NaN]]).valid).toBe(false)
  })

  it('identifies one significantly moved axis and rejects ambiguity', () => {
    const baseline = [0, 0, 0, -1]
    const moved = [[0.8, 0.02, 0, -1], [-0.7, 0, 0.01, -1]]
    const identified = identifyAxisByMovement(baseline, moved)
    expect(identified.status).toBe('identified')
    expect(identified.axis).toBe(0)

    const ambiguous = identifyAxisByMovement(baseline, [[0.8, 0.75, 0, 0], [-0.8, -0.75, 0, 0]])
    expect(ambiguous.status).toBe('ambiguous')
    expect(ambiguous.axis).toBeNull()
  })

  it('requires real endpoints for centered and throttle channels', () => {
    expect(summarizeEndpointRange([-0.9, 0.1, 0.9], 'centered', 0.1).valid).toBe(true)
    expect(summarizeEndpointRange([0.1, 0.3], 'centered', 0.1).valid).toBe(false)
    expect(summarizeEndpointRange([-0.8, 0.7], 'single-ended').valid).toBe(true)
    expect(summarizeEndpointRange([-0.1, 0.1], 'single-ended').valid).toBe(false)
  })

  it('passes only a hands-off neutral window with enough time and samples', () => {
    const stableSamples = Array.from({ length: 40 }, (_, index) => channels(
      index % 2 === 0 ? 0.005 : -0.005,
      0.004,
      -0.003,
    ))
    const stable = evaluateNeutralStability(stableSamples, 2_100)
    expect(stable.stable).toBe(true)
    expect(stable.maxAbsolute.roll).toBeCloseTo(0.005)

    const unstable = evaluateNeutralStability(
      Array.from({ length: 40 }, () => channels(0.12, 0, 0)),
      2_100,
    )
    expect(unstable.stable).toBe(false)
    expect(unstable.reason).toMatch(/roll reached/)
  })
})
