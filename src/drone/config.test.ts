import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, hoverThrottle, validateDroneConfig } from './config'

describe('drone configuration', () => {
  it('provides a valid explicit 5-inch configuration', () => {
    expect(validateDroneConfig(DEFAULT_DRONE_CONFIG)).toEqual({ valid: true, errors: [] })
    expect(DEFAULT_DRONE_CONFIG.motors).toHaveLength(4)
    expect(DEFAULT_DRONE_CONFIG.motors.map((motor) => motor.id)).toEqual([
      'front-left',
      'front-right',
      'rear-left',
      'rear-right',
    ])
  })

  it('rejects unsafe mass, inertia and motor response values', () => {
    const invalid = {
      ...DEFAULT_DRONE_CONFIG,
      massKg: 0,
      inertiaKgM2: { x: -1, y: 1, z: 1 },
      motors: DEFAULT_DRONE_CONFIG.motors.map((motor) => ({
        ...motor,
        responseTimeConstantSeconds: 0,
      })) as unknown as typeof DEFAULT_DRONE_CONFIG.motors,
    }
    const validation = validateDroneConfig(invalid)
    expect(validation.valid).toBe(false)
    expect(validation.errors.join(' ')).toContain('Mass')
    expect(validation.errors.join(' ')).toContain('inertia')
    expect(validation.errors.join(' ')).toContain('response time')
  })

  it('derives a finite hover command from total available thrust', () => {
    const throttle = hoverThrottle()
    expect(throttle).toBeGreaterThan(0)
    expect(throttle).toBeLessThan(1)
    expect(throttle * DEFAULT_DRONE_CONFIG.motors.reduce((sum, motor) => sum + motor.maxThrustN, 0)).toBeCloseTo(
      DEFAULT_DRONE_CONFIG.massKg * DEFAULT_DRONE_CONFIG.gravityMps2,
    )
  })
})
