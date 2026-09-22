import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, hoverThrottle, validateDroneConfig } from './config'
import { DroneSimulation } from '../simulation/simulation'

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

  it('rejects malformed nested runtime values and safely falls back in the simulation', () => {
    const malformed = {
      ...DEFAULT_DRONE_CONFIG,
      inertiaKgM2: null,
      linearDragCoefficientNPerMps: undefined,
      angularDragCoefficientNmPerRadPerSec: null,
      motors: [null, ...DEFAULT_DRONE_CONFIG.motors.slice(1)],
      ground: undefined,
      safety: null,
      mixer: undefined,
    } as unknown

    expect(() => validateDroneConfig(malformed)).not.toThrow()
    const validation = validateDroneConfig(malformed)
    expect(validation.valid).toBe(false)
    expect(validation.errors.join(' ')).toContain('Ground configuration is missing')
    expect(validation.errors.join(' ')).toContain('Motor 0 configuration is missing')

    expect(() => new DroneSimulation(malformed as typeof DEFAULT_DRONE_CONFIG)).not.toThrow()
    const simulation = new DroneSimulation(malformed as typeof DEFAULT_DRONE_CONFIG)
    expect(simulation.config).toBe(DEFAULT_DRONE_CONFIG)
    expect(simulation.getState().warnings[0]).toContain('Invalid drone configuration')
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
