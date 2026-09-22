import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG } from './config'
import { advanceMotorState, createMotorState, motorResponseFraction } from './motor'

describe('motor dynamics', () => {
  it('follows the exact exponential first-order response', () => {
    const config = DEFAULT_DRONE_CONFIG.motors[0]
    const dt = config.responseTimeConstantSeconds
    const state = advanceMotorState(createMotorState(), 1, config, dt)
    const expected = config.maxThrustN * (1 - Math.exp(-1))
    expect(state.targetThrustN).toBe(config.maxThrustN)
    expect(state.actualThrustN).toBeCloseTo(expected, 12)
  })

  it('keeps motor commands independent and bounded', () => {
    const config = DEFAULT_DRONE_CONFIG.motors[0]
    const state = advanceMotorState(createMotorState(), 4, config, 1 / 240)
    expect(state.command).toBe(1)
    expect(state.targetThrustN).toBe(config.maxThrustN)
    expect(state.actualThrustN).toBeGreaterThan(0)
    expect(state.actualThrustN).toBeLessThan(state.targetThrustN)
  })

  it('reports a finite response fraction only for valid parameters', () => {
    expect(motorResponseFraction(0.01, 0.03)).toBeCloseTo(1 - Math.exp(-1 / 3))
    expect(motorResponseFraction(-1, 0.03)).toBeNaN()
    expect(motorResponseFraction(0.01, 0)).toBeNaN()
  })
})
