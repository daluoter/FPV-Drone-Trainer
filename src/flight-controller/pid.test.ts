import { describe, expect, it } from 'vitest'
import { RatePidAxisController } from './pid'

const boundedConfig = {
  kp: 1,
  ki: 1,
  kd: 0,
  integralLimit: 10,
  outputLimitNm: 0.5,
  derivativeOnMeasurement: true,
}

describe('angular-rate PID', () => {
  it('bounds output and holds same-direction integral during saturation', () => {
    const pid = new RatePidAxisController(boundedConfig)
    const first = pid.update(10, 0, 0.1)
    const second = pid.update(10, 0, 0.1)

    expect(first.outputNm).toBe(0.5)
    expect(second.outputNm).toBe(0.5)
    expect(first.saturated).toBe(true)
    expect(second.saturated).toBe(true)
    expect(first.integral).toBe(0)
    expect(second.integral).toBe(0)
  })

  it('integrates a bounded error after leaving the output limit', () => {
    const pid = new RatePidAxisController({
      ...boundedConfig,
      kp: 0,
      outputLimitNm: 1,
    })
    const result = pid.update(0.5, 0, 0.1)
    expect(result.integral).toBeCloseTo(0.05, 12)
    expect(result.outputNm).toBeCloseTo(0.05, 12)
    expect(Math.abs(result.integral)).toBeLessThanOrEqual(boundedConfig.integralLimit)
  })

  it('uses derivative on measurement with no setpoint kick and resets on invalid input', () => {
    const pid = new RatePidAxisController({
      kp: 0,
      ki: 0,
      kd: 0.1,
      integralLimit: 1,
      outputLimitNm: 10,
      derivativeOnMeasurement: true,
    })
    const setpointStep = pid.update(1, 0, 0.01)
    const measuredStep = pid.update(1, 0.5, 0.01)
    expect(setpointStep.derivativeRadPerSec2).toBe(0)
    expect(measuredStep.derivativeRadPerSec2).toBe(-50)
    expect(measuredStep.outputNm).toBeCloseTo(-5, 12)

    const invalid = pid.update(1, 0.5, Number.NaN)
    expect(invalid.valid).toBe(false)
    expect(invalid.outputNm).toBe(0)
    expect(pid.integralState).toBe(0)
  })
})
