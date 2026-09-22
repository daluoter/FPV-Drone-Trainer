import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, hoverThrottle } from '../drone'
import { processControllerSnapshot } from '../controller'
import type { ControllerProfile, RawGamepadSnapshot } from '../controller'
import { quaternionNearlyEqual } from '../math'
import { createDefaultFlightControllerConfig } from './config'
import { FlightSimulation, processedControllerStateToNormalizedRc } from './runtime'

function lowRateControllerConfig() {
  const base = createDefaultFlightControllerConfig()
  const axis = { centerRateDegPerSec: 25, maxRateDegPerSec: 25, expo: 0 }
  return {
    ...base,
    rates: { axes: { roll: axis, pitch: axis, yaw: axis } },
    rateLimitsDegPerSec: { roll: 25, pitch: 25, yaw: 25 },
    pid: {
      roll: { kp: 0.025, ki: 0.08, kd: 0.0002, integralLimit: 0.4, outputLimitNm: 0.22 },
      pitch: { kp: 0.025, ki: 0.08, kd: 0.0002, integralLimit: 0.4, outputLimitNm: 0.22 },
      yaw: { kp: 0.012, ki: 0.04, kd: 0.0001, integralLimit: 0.4, outputLimitNm: 0.05 },
    },
  }
}

function runAtRenderRate(renderHz: number, input: { roll: number; pitch: number; yaw: number; throttle: number }) {
  const runtime = new FlightSimulation({
    controller: lowRateControllerConfig(),
    armed: true,
  })
  for (let frame = 0; frame < renderHz; frame += 1) {
    runtime.advance(1 / renderHz, input)
  }
  return runtime
}

describe('flight simulation integration', () => {
  it('holds hover and is equivalent across render rates', () => {
    const input = { roll: 0, pitch: 0, yaw: 0, throttle: hoverThrottle() }
    const at60 = runAtRenderRate(60, input)
    const at120 = runAtRenderRate(120, input)
    const state60 = at60.getState()
    const state120 = at120.getState()

    expect(state60.stepIndex).toBe(240)
    expect(state120.stepIndex).toBe(240)
    expect(state60.motors[0].command).toBeCloseTo(hoverThrottle(), 12)
    expect(state60.motors[0].actualThrustN).toBeCloseTo(
      DEFAULT_DRONE_CONFIG.massKg * DEFAULT_DRONE_CONFIG.gravityMps2 / 4,
      8,
    )
    expect(state60.motors[0].actualThrustN).toBeCloseTo(state60.motors[1].actualThrustN, 12)
    expect(state60.angularVelocityBodyRadPerSec).toEqual({ x: 0, y: 0, z: 0 })
    expect(quaternionNearlyEqual(state60.orientation, state120.orientation, 1e-10)).toBe(true)
    expect(state60.positionM.y).toBeCloseTo(state120.positionM.y, 10)
  })

  it('tracks a rate step and release without self-leveling attitude', () => {
    const runtime = new FlightSimulation({ controller: lowRateControllerConfig(), armed: true })
    const hover = hoverThrottle()
    for (let index = 0; index < 60; index += 1) {
      runtime.advance(1 / 240, { roll: 0.8, pitch: 0, yaw: 0, throttle: hover })
    }
    const steppedOrientation = runtime.getState().orientation
    const steppedRate = runtime.getState().angularVelocityBodyRadPerSec.z
    const targetRollRate = 0.8 * 25 * Math.PI / 180
    expect(Math.abs(steppedRate)).toBeGreaterThan(0.05)
    expect(Math.abs(-steppedRate - targetRollRate)).toBeLessThan(0.1)

    for (let index = 0; index < 480; index += 1) {
      runtime.advance(1 / 240, { roll: 0, pitch: 0, yaw: 0, throttle: hover })
    }
    const released = runtime.getState()
    expect(Math.abs(released.angularVelocityBodyRadPerSec.z)).toBeLessThan(0.2)
    expect(quaternionNearlyEqual(released.orientation, steppedOrientation, 0.05)).toBe(true)
  })

  it('processes calibrated offset/noisy neutral through RC to body for a long run without rotational growth', () => {
    const profile: ControllerProfile = {
      schemaVersion: 1,
      deviceId: 'neutral-device',
      deviceMapping: '',
      axisCount: 4,
      buttonCount: 0,
      channels: {
        roll: { axis: 0, invert: false, center: 0.08, minimum: -0.9, maximum: 0.9, deadband: 0.03 },
        pitch: { axis: 1, invert: false, center: -0.04, minimum: -0.9, maximum: 0.9, deadband: 0.03 },
        yaw: { axis: 2, invert: false, center: 0.12, minimum: -0.9, maximum: 0.9, deadband: 0.03 },
        throttle: { axis: 3, invert: false, center: -1, minimum: -1, maximum: 1, deadband: 0 },
      },
      throttleMode: 'single-ended',
      calibrationTimestamp: '2026-01-01T00:00:00.000Z',
      directionVerifiedAt: null,
      neutralVerifiedAt: null,
      neutralStability: null,
    }
    const runtime = new FlightSimulation({ controller: lowRateControllerConfig(), armed: true })
    const hover = hoverThrottle()
    for (let index = 0; index < 2_400; index += 1) {
      const noise = index % 2 === 0 ? 0.004 : -0.004
      const snapshot: RawGamepadSnapshot = {
        id: 'neutral-device',
        index: 0,
        mapping: '',
        axisCount: 4,
        buttonCount: 0,
        connected: true,
        axes: [0.08 + noise, -0.04 - noise, 0.12 + noise, -1 + 2 * hover],
        buttons: [],
        timestamp: index * 1000 / 240,
        invalidAxisIndices: [],
        invalidButtonIndices: [],
      }
      const processed = processControllerSnapshot(snapshot, profile)
      const input = processedControllerStateToNormalizedRc(processed)
      expect(input).not.toBeNull()
      runtime.advance(1 / 240, input)
    }
    const state = runtime.getState()
    expect(Math.abs(state.angularVelocityBodyRadPerSec.x)).toBeLessThan(0.05)
    expect(Math.abs(state.angularVelocityBodyRadPerSec.y)).toBeLessThan(0.05)
    expect(Math.abs(state.angularVelocityBodyRadPerSec.z)).toBeLessThan(0.05)
    expect(runtime.getTelemetry().warnings.filter((warning) => /non-finite|invalid/i.test(warning))).toHaveLength(0)
  })

  it('disarms and zeroes commands on invalid input instead of retaining a stale command', () => {
    const runtime = new FlightSimulation({ controller: lowRateControllerConfig(), armed: true })
    runtime.step({ roll: 1, pitch: 0, yaw: 0, throttle: hoverThrottle() })
    const result = runtime.step(null)
    expect(runtime.isArmed()).toBe(false)
    expect(result.telemetry.armed).toBe(false)
    expect(result.telemetry.mixer.commands).toEqual([0, 0, 0, 0])
    expect(result.state.motors.every((motor) => motor.command === 0 && motor.targetThrustN === 0)).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/invalid/i)
  })
})
