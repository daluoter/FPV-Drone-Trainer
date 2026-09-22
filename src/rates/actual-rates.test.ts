import { describe, expect, it } from 'vitest'
import {
  applyActualRates,
  applyActualRatesForAxis,
  applyActualRatesRadPerSec,
  applyConfiguredRateLimit,
  applyConfiguredRateLimitForAxis,
  applyConfiguredRateLimitRadPerSec,
  createDefaultRatesConfig,
  degreesPerSecondToRadiansPerSecond,
  DEFAULT_RATE_LIMITS_DEG_PER_SEC,
  MAX_ACTUAL_RATE_DEG_PER_SEC,
  radiansPerSecondToDegreesPerSecond,
  validateActualRatesConfig,
  validateRateLimits,
  validateRatesConfig,
  type ActualRatesConfig,
} from './actual-rates'

const DEFAULT_VECTOR_CONFIG: ActualRatesConfig = {
  centerRateDegPerSec: 70,
  maxRateDegPerSec: 670,
  expo: 0,
}

function rateAt(expo: number, normalizedStick: number): number {
  return applyActualRates(normalizedStick, { ...DEFAULT_VECTOR_CONFIG, expo })
}

describe('Betaflight Actual Rates', () => {
  it('matches the verified 4.5.2 numeric vectors without expo', () => {
    expect(rateAt(0, 0)).toBeCloseTo(0, 12)
    expect(rateAt(0, 0.25)).toBeCloseTo(55, 12)
    expect(rateAt(0, 0.5)).toBeCloseTo(185, 12)
    expect(rateAt(0, 1)).toBeCloseTo(670, 12)
    expect(rateAt(0, -0.5)).toBeCloseTo(-185, 12)
  })

  it('matches the verified expo vectors', () => {
    expect(rateAt(0.5, 0.25)).toBeCloseTo(36.3232421875, 12)
    expect(rateAt(0.5, 0.5)).toBeCloseTo(114.6875, 12)
    expect(rateAt(0.5, 1)).toBeCloseTo(670, 12)
    expect(rateAt(1, 0.5)).toBeCloseTo(44.375, 12)
  })

  it('maps zero to zero and preserves odd symmetry', () => {
    for (const expo of [0, 0.25, 0.5, 1]) {
      for (const stick of [0.1, 0.25, 0.5, 0.9]) {
        expect(rateAt(expo, 0)).toBe(0)
        expect(rateAt(expo, -stick)).toBeCloseTo(-rateAt(expo, stick), 12)
      }
    }
  })

  it('uses the configured endpoint when max rate is at least center rate', () => {
    expect(rateAt(0, 1)).toBeCloseTo(670, 12)
    expect(rateAt(0.5, -1)).toBeCloseTo(-670, 12)
  })

  it('preserves the canonical center-rate endpoint when center exceeds max rate', () => {
    const config: ActualRatesConfig = {
      centerRateDegPerSec: 700,
      maxRateDegPerSec: 500,
      expo: 0.75,
    }

    expect(applyActualRates(1, config)).toBeCloseTo(700, 12)
    expect(applyActualRates(-1, config)).toBeCloseTo(-700, 12)
    expect(applyActualRates(0.5, config)).toBeCloseTo(350, 12)
    expect(applyActualRates(0.5, { ...config, expo: 0 })).toBeCloseTo(350, 12)
  })

  it('has center derivative equal to center rate', () => {
    const step = 1e-9
    const derivative = (applyActualRates(step, DEFAULT_VECTOR_CONFIG) - applyActualRates(-step, DEFAULT_VECTOR_CONFIG)) / (2 * step)
    expect(derivative).toBeCloseTo(DEFAULT_VECTOR_CONFIG.centerRateDegPerSec, 5)
  })

  it('makes positive expo progressively slower away from center', () => {
    const linear = rateAt(0, 0.5)
    const halfExpo = rateAt(0.5, 0.5)
    const fullExpo = rateAt(1, 0.5)
    expect(linear).toBeGreaterThan(halfExpo)
    expect(halfExpo).toBeGreaterThan(fullExpo)
  })

  it('rejects non-finite and non-normalized stick input', () => {
    expect(applyActualRates(Number.NaN, DEFAULT_VECTOR_CONFIG)).toBeNaN()
    expect(applyActualRates(Number.POSITIVE_INFINITY, DEFAULT_VECTOR_CONFIG)).toBeNaN()
    expect(applyActualRates(-1.001, DEFAULT_VECTOR_CONFIG)).toBeNaN()
    expect(applyActualRates(1.001, DEFAULT_VECTOR_CONFIG)).toBeNaN()
  })

  it('rejects non-finite and impractical axis configuration', () => {
    expect(validateActualRatesConfig({ ...DEFAULT_VECTOR_CONFIG, centerRateDegPerSec: Number.NaN }).valid).toBe(false)
    expect(validateActualRatesConfig({ ...DEFAULT_VECTOR_CONFIG, maxRateDegPerSec: Number.POSITIVE_INFINITY }).valid).toBe(false)
    expect(validateActualRatesConfig({ ...DEFAULT_VECTOR_CONFIG, expo: 1.01 }).valid).toBe(false)
    expect(validateActualRatesConfig({ ...DEFAULT_VECTOR_CONFIG, centerRateDegPerSec: MAX_ACTUAL_RATE_DEG_PER_SEC + 1 }).valid).toBe(false)
    expect(applyActualRates(0.5, { ...DEFAULT_VECTOR_CONFIG, expo: -0.1 })).toBeNaN()
  })

  it('validates independent axis profiles and defaults', () => {
    const config = createDefaultRatesConfig()
    expect(validateRatesConfig(config).valid).toBe(true)
    expect(config.axes.roll).not.toBe(config.axes.pitch)
    expect(applyActualRatesForAxis(0.5, config, 'roll')).toBeCloseTo(185, 12)
    expect(validateRatesConfig({ axes: { ...config.axes, yaw: null } }).valid).toBe(false)
  })

  it('applies a separate symmetric configured rate limit after Actual Rates', () => {
    const actualRate = applyActualRates(0.5, DEFAULT_VECTOR_CONFIG)
    expect(actualRate).toBeCloseTo(185, 12)
    expect(applyConfiguredRateLimit(actualRate, 100)).toBeCloseTo(100, 12)
    expect(applyConfiguredRateLimit(-actualRate, 100)).toBeCloseTo(-100, 12)
    expect(applyConfiguredRateLimit(actualRate, null)).toBeCloseTo(actualRate, 12)
    expect(applyConfiguredRateLimitForAxis(actualRate, { ...DEFAULT_RATE_LIMITS_DEG_PER_SEC, roll: 100 }, 'roll')).toBeCloseTo(100, 12)
    expect(validateRateLimits({ ...DEFAULT_RATE_LIMITS_DEG_PER_SEC, pitch: Number.NaN }).valid).toBe(false)
  })

  it('converts rates explicitly between degrees/s and radians/s', () => {
    expect(degreesPerSecondToRadiansPerSecond(180)).toBeCloseTo(Math.PI, 12)
    expect(radiansPerSecondToDegreesPerSecond(Math.PI)).toBeCloseTo(180, 12)
    expect(applyActualRatesRadPerSec(0.5, DEFAULT_VECTOR_CONFIG)).toBeCloseTo(185 * Math.PI / 180, 12)
    expect(applyConfiguredRateLimitRadPerSec(2, 1)).toBeCloseTo(1, 12)
    expect(degreesPerSecondToRadiansPerSecond(Number.NaN)).toBeNaN()
    expect(radiansPerSecondToDegreesPerSecond(Number.POSITIVE_INFINITY)).toBeNaN()
  })
})
