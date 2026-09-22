import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG } from '../drone'
import {
  bodyAngularRateToPilotAxes,
  pilotAxesToBodyAngularRate,
  pilotTorqueToBodyTorque,
} from './axes'
import { createDefaultFlightControllerConfig } from './config'
import { AngularRateController } from './controller'

function lowRateConfig() {
  const base = createDefaultFlightControllerConfig()
  const axis = {
    centerRateDegPerSec: 30,
    maxRateDegPerSec: 30,
    expo: 0,
  }
  return {
    ...base,
    rates: { axes: { roll: axis, pitch: axis, yaw: axis } },
    rateLimitsDegPerSec: { roll: 30, pitch: 30, yaw: 30 },
    pid: {
      roll: { kp: 0.02, ki: 0, kd: 0, integralLimit: 1, outputLimitNm: 0.2 },
      pitch: { kp: 0.02, ki: 0, kd: 0, integralLimit: 1, outputLimitNm: 0.2 },
      yaw: { kp: 0.01, ki: 0, kd: 0, integralLimit: 1, outputLimitNm: 0.05 },
    },
  }
}

describe('flight-controller axis and rate boundary', () => {
  it('converts every pilot axis with the documented body signs', () => {
    const pilot = { roll: 0.2, pitch: 0.3, yaw: 0.4 }
    expect(pilotAxesToBodyAngularRate(pilot)).toEqual({ x: 0.3, y: -0.4, z: -0.2 })
    expect(bodyAngularRateToPilotAxes({ x: 0.3, y: -0.4, z: -0.2 })).toEqual(pilot)
    expect(pilotTorqueToBodyTorque(pilot)).toEqual({ x: 0.3, y: -0.4, z: -0.2 })
  })

  it('runs Actual Rates, SI PID and mixer signs in one bounded output', () => {
    const controller = new AngularRateController(lowRateConfig(), DEFAULT_DRONE_CONFIG)
    const output = controller.calculate(
      { roll: 0.5, pitch: 0.5, yaw: 0.5, throttle: 0.5 },
      { x: 0, y: 0, z: 0 },
      1 / 240,
    )

    expect(output.valid).toBe(true)
    expect(output.targetBodyRateRadPerSec.x).toBeGreaterThan(0)
    expect(output.targetBodyRateRadPerSec.y).toBeLessThan(0)
    expect(output.targetBodyRateRadPerSec.z).toBeLessThan(0)
    expect(output.pidOutputTorqueBodyNm.x).toBeGreaterThan(0)
    expect(output.pidOutputTorqueBodyNm.y).toBeLessThan(0)
    expect(output.pidOutputTorqueBodyNm.z).toBeLessThan(0)
    expect(output.motorCommands.every((command) => command >= 0 && command <= 1)).toBe(true)
    expect(output.mixer.commands[0]).toBeGreaterThan(output.mixer.commands[3])
  })

  it('resolves malformed controller configuration without throwing', () => {
    expect(() => new AngularRateController(null as unknown as ReturnType<typeof createDefaultFlightControllerConfig>)).not.toThrow()
    const controller = new AngularRateController({
      rates: null,
      rateLimitsDegPerSec: null,
      pid: null,
    } as unknown as ReturnType<typeof createDefaultFlightControllerConfig>)
    const output = controller.calculate(
      { roll: 0, pitch: 0, yaw: 0, throttle: 0 },
      { x: 0, y: 0, z: 0 },
      1 / 240,
    )
    expect(output.motorCommands).toEqual([0, 0, 0, 0])
    expect(output.warnings.join(' ')).toMatch(/invalid flight-controller configuration/i)
  })

  it('zeros commands and clears PID memory for invalid input or timestep', () => {
    const controller = new AngularRateController(lowRateConfig(), DEFAULT_DRONE_CONFIG)
    controller.calculate({ roll: 1, pitch: 0, yaw: 0, throttle: 0.5 }, { x: 0, y: 0, z: 0 }, 1 / 240)
    const invalid = controller.calculate(
      { roll: Number.NaN, pitch: 0, yaw: 0, throttle: 0.5 },
      { x: 0, y: 0, z: 0 },
      1 / 240,
    )
    expect(invalid.valid).toBe(false)
    expect(invalid.motorCommands).toEqual([0, 0, 0, 0])
    expect(invalid.warnings.join(' ')).toMatch(/invalid/i)
    expect(controller.getIntegral('roll')).toBe(0)

    const invalidDt = controller.calculate(
      { roll: 0, pitch: 0, yaw: 0, throttle: 0.5 },
      { x: 0, y: 0, z: 0 },
      Number.NaN,
    )
    expect(invalidDt.motorCommands).toEqual([0, 0, 0, 0])
  })
})
