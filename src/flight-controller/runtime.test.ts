import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, hoverThrottle } from '../drone'
import { processControllerSnapshot } from '../controller'
import type { ControllerProfile, RawGamepadSnapshot } from '../controller'
import { quaternionNearlyEqual } from '../math'
import type { StaticBoxCollider } from '../simulation/obstacles'
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

function mixerSaturationControllerConfig() {
  const base = createDefaultFlightControllerConfig()
  const axis = { centerRateDegPerSec: 30, maxRateDegPerSec: 30, expo: 0 }
  return {
    ...base,
    rates: { axes: { roll: axis, pitch: axis, yaw: axis } },
    rateLimitsDegPerSec: { roll: 30, pitch: 30, yaw: 30 },
    pid: {
      roll: { kp: 0.1, ki: 0.1, kd: 0, integralLimit: 0.5, outputLimitNm: 0.2 },
      pitch: { kp: 0, ki: 0, kd: 0, integralLimit: 0.5, outputLimitNm: 0.2 },
      yaw: { kp: 0, ki: 0, kd: 0, integralLimit: 0.5, outputLimitNm: 0.2 },
    },
  }
}

describe('flight simulation integration', () => {
  const neutralInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0 }
  const frameBottom: StaticBoxCollider = {
    id: 'test-frame-bottom',
    centerM: { x: 0, y: 1, z: 0 },
    halfExtentsM: { x: 2, y: 0.12, z: 0.15 },
  }

  it('installs a copied disarmed environment without moving or restarting the drone', () => {
    const runtime = new FlightSimulation()
    expect(runtime.getStaticObstacles()).toEqual([])
    runtime.resetForTraining({ x: 0, y: 3, z: 0 })
    runtime.advance(1 / 60, neutralInput)
    const before = runtime.getState()
    const box = { ...frameBottom, centerM: { ...frameBottom.centerM } }
    expect(runtime.setStaticObstacles([box])).toBe(true)
    expect(runtime.getState()).toBe(before)
    expect(runtime.getState().timeSeconds).toBeCloseTo(1 / 60, 10)
    box.centerM.x = 100
    expect(runtime.getStaticObstacles()).toEqual([frameBottom])
    expect(runtime.setStaticObstacles([{ ...frameBottom, halfExtentsM: { x: Number.NaN, y: 1, z: 1 } }])).toBe(false)
    expect(runtime.getStaticObstacles()).toEqual([frameBottom])
    expect(runtime.getState()).toBe(before)
    runtime.arm()
    expect(runtime.setStaticObstacles([])).toBe(false)
    expect(runtime.getStaticObstacles()).toEqual([frameBottom])
  })

  it('collides through the real controller and solver, disarms, and retains the cause until reset', () => {
    const runtime = new FlightSimulation()
    runtime.resetForTraining({ x: 0, y: 3, z: 0 }, undefined, [frameBottom])
    runtime.arm()
    for (let step = 0; step < 240 && !runtime.getState().crashed; step += 1) runtime.step(neutralInput)
    const collision = runtime.getState()
    expect(collision.crashed).toBe(true)
    expect(collision.positionM.y).toBeGreaterThan(1)
    expect(collision.warnings).toContain('Obstacle collision: test-frame-bottom; reset required.')
    expect(runtime.isArmed()).toBe(false)
    expect(collision.motors.every((motor) => motor.command === 0 && motor.actualThrustN === 0)).toBe(true)
    expect(runtime.getTelemetry().warnings).toContain('Obstacle collision: test-frame-bottom; reset required.')
    runtime.arm()
    expect(runtime.isArmed()).toBe(false)
    expect(runtime.getTelemetry().warnings).toContain('Obstacle collision: test-frame-bottom; reset required.')
    runtime.disarm()
    runtime.setStaticObstacles([])
    runtime.step(neutralInput)
    expect(runtime.getState().positionM).toEqual(collision.positionM)
    expect(runtime.getState().crashed).toBe(true)
    expect(runtime.getTelemetry().warnings).toContain('Obstacle collision: test-frame-bottom; reset required.')
    runtime.reset()
    expect(runtime.getStaticObstacles()).toEqual([])
    expect(runtime.getState().crashed).toBe(false)
    runtime.arm()
    expect(runtime.isArmed()).toBe(true)
  })

  it('passes through an open physical frame using ordinary hover RC input', () => {
    const runtime = new FlightSimulation()
    const frame: StaticBoxCollider[] = [
      { id: 'left', centerM: { x: -2.2, y: 3, z: 0 }, halfExtentsM: { x: 0.12, y: 2.2, z: 0.15 } },
      { id: 'right', centerM: { x: 2.2, y: 3, z: 0 }, halfExtentsM: { x: 0.12, y: 2.2, z: 0.15 } },
      { id: 'top', centerM: { x: 0, y: 5.2, z: 0 }, halfExtentsM: { x: 2.32, y: 0.12, z: 0.15 } },
      { id: 'bottom', centerM: { x: 0, y: 0.8, z: 0 }, halfExtentsM: { x: 2.32, y: 0.12, z: 0.15 } },
    ]
    const pitch = -0.12
    runtime.resetForTraining({ x: 0, y: 3, z: 1.5 }, { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) }, frame)
    runtime.arm()
    for (let step = 0; step < 720 && runtime.getState().positionM.z > -0.7 && !runtime.getState().crashed; step += 1) {
      runtime.step({ ...neutralInput, throttle: hoverThrottle() / Math.cos(pitch) })
    }
    expect(runtime.getState().positionM.z).toBeLessThan(-0.7)
    expect(runtime.getState().positionM.y).toBeGreaterThan(1.5)
    expect(runtime.getState().crashed).toBe(false)
    expect(runtime.isArmed()).toBe(true)
  })

  it('clears old frame geometry on ordinary reset and on training setup without obstacles', () => {
    const runtime = new FlightSimulation()
    runtime.resetForTraining({ x: 0, y: 3, z: 0 }, undefined, [frameBottom])
    runtime.resetAt({ x: 0, y: 3, z: 0 })
    expect(runtime.getStaticObstacles()).toEqual([])
    runtime.arm()
    for (let step = 0; step < 240 && runtime.getState().positionM.y > 0.5; step += 1) runtime.step(neutralInput)
    expect(runtime.getState().positionM.y).toBeLessThan(0.5)
    expect(runtime.getState().crashed).toBe(false)
    runtime.resetForTraining({ x: 0, y: 3, z: 0 }, undefined, [frameBottom])
    runtime.resetForTraining({ x: 0, y: 3, z: 0 })
    expect(runtime.getStaticObstacles()).toEqual([])
  })

  it('holds and refuses to arm an invalid training environment until a valid explicit reset', () => {
    const runtime = new FlightSimulation()
    runtime.resetForTraining({ x: 0, y: 3, z: 0 }, undefined, [{ ...frameBottom, halfExtentsM: { x: 1, y: -1, z: 1 } }])
    runtime.arm()
    expect(runtime.isArmed()).toBe(false)
    runtime.advance(0.1, neutralInput)
    expect(runtime.getState().positionM).toEqual({ x: 0, y: 3, z: 0 })
    expect(runtime.getTelemetry().warnings).toContain('Training environment contains invalid obstacles; reset is required before arming.')
    runtime.setStaticObstacles([frameBottom])
    runtime.arm()
    expect(runtime.isArmed()).toBe(false)
    runtime.resetForTraining({ x: 0, y: 3, z: 0 }, undefined, [frameBottom])
    runtime.arm()
    expect(runtime.isArmed()).toBe(true)
  })

  it('holds a disarmed lesson spawn through countdown and releases physics only after explicit arm', () => {
    const runtime = new FlightSimulation()
    const prepared = runtime.resetForTraining({ x: 1, y: 3, z: 2 })
    let samples = 0
    for (let frame = 0; frame < 600; frame += 1) {
      runtime.advance(1 / 60, null, (step) => {
        samples += 1
        expect(step.telemetry.armed).toBe(false)
      })
    }
    expect(samples).toBe(2_400)
    expect(runtime.getState().timeSeconds).toBeCloseTo(10, 8)
    expect(runtime.getState().positionM).toEqual(prepared.positionM)
    expect(runtime.getState().motors).toEqual(prepared.motors)

    runtime.arm()
    expect(runtime.isArmed()).toBe(true)
    const flying = runtime.step({ roll: 0, pitch: 0, yaw: 0, throttle: 0 }).state
    expect(flying.positionM.y).toBeLessThan(3)
    runtime.disarm()
    const falling = runtime.step({ roll: 0, pitch: 0, yaw: 0, throttle: 0 }).state
    expect(falling.positionM.y).toBeLessThan(flying.positionM.y)
  })

  it('does not hold ordinary disarmed flight or retain preparation after a normal reset', () => {
    const runtime = new FlightSimulation()
    runtime.resetAt({ x: 0, y: 3, z: 0 })
    expect(runtime.step({ roll: 0, pitch: 0, yaw: 0, throttle: 0 }).state.positionM.y).toBeLessThan(3)
    runtime.resetForTraining({ x: 0, y: 5, z: 0 })
    runtime.resetAt({ x: 0, y: 3, z: 0 })
    expect(runtime.step({ roll: 0, pitch: 0, yaw: 0, throttle: 0 }).state.positionM.y).toBeLessThan(3)
  })

  it('retains the prepared pose if an invalid configuration prevents arming', () => {
    const runtime = new FlightSimulation({ drone: { ...DEFAULT_DRONE_CONFIG, massKg: 0 } })
    runtime.resetForTraining({ x: 0, y: 3, z: 0 })
    runtime.arm()
    expect(runtime.isArmed()).toBe(false)
    for (let frame = 0; frame < 60; frame += 1) runtime.advance(1 / 60, null)
    expect(runtime.getState().positionM.y).toBe(3)
    expect(runtime.getState().timeSeconds).toBeCloseTo(1, 8)
  })

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

  it('holds a bounded integral through sustained mixer saturation and unwinds after authority returns', () => {
    const runtime = new FlightSimulation({ controller: mixerSaturationControllerConfig(), armed: true })
    const saturatedInput = { roll: 1, pitch: 0, yaw: 0, throttle: 1 }

    for (let index = 0; index < 240; index += 1) {
      const result = runtime.advance(1 / 240, saturatedInput)
      expect(result.steps).toBe(1)
      expect(result.telemetry.mixerSaturated).toBe(true)
      expect(Math.abs(result.telemetry.pidIntegral.roll)).toBeLessThanOrEqual(0.5)
    }

    const heldIntegral = runtime.getTelemetry().pidIntegral.roll
    expect(heldIntegral).not.toBe(0)
    for (let index = 0; index < 240; index += 1) {
      const result = runtime.advance(1 / 240, saturatedInput)
      expect(result.telemetry.mixerSaturated).toBe(true)
      expect(result.telemetry.pidIntegral.roll).toBeCloseTo(heldIntegral, 12)
      expect(Math.abs(result.telemetry.pidIntegral.roll)).toBeLessThanOrEqual(0.5)
    }

    const authorityReturnedInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0.5 }
    let sawUnsaturatedAllocation = false
    for (let index = 0; index < 480; index += 1) {
      const result = runtime.advance(1 / 240, authorityReturnedInput)
      sawUnsaturatedAllocation ||= !result.telemetry.mixerSaturated
      expect(Math.abs(result.telemetry.pidIntegral.roll)).toBeLessThanOrEqual(0.5)
    }

    const recovered = runtime.getTelemetry()
    expect(sawUnsaturatedAllocation).toBe(true)
    expect(recovered.mixerSaturated).toBe(false)
    expect(Math.abs(recovered.pidIntegral.roll)).toBeLessThan(Math.abs(heldIntegral))
    expect(recovered.warnings.filter((warning) => /non-finite|invalid/i.test(warning))).toHaveLength(0)
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

  it('disarms and latches a ground crash until explicit reset before re-arming', () => {
    const drone = {
      ...DEFAULT_DRONE_CONFIG,
      spawnPositionM: { x: 0, y: DEFAULT_DRONE_CONFIG.ground.heightM, z: 0 },
    }
    const runtime = new FlightSimulation({ drone, armed: true })
    const input = { roll: 1, pitch: 1, yaw: 0, throttle: 0 }
    let result = runtime.step(input)
    for (let index = 0; index < 2_000 && !result.state.crashed; index += 1) result = runtime.step(input)

    expect(result.state.crashed).toBe(true)
    expect(runtime.isArmed()).toBe(false)
    expect(result.telemetry.armed).toBe(false)
    expect(result.telemetry.mixer.commands).toEqual([0, 0, 0, 0])
    expect(result.state.motors.every((motor) => motor.command === 0 && motor.targetThrustN === 0 && motor.actualThrustN === 0)).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/crash|tip-over/i)

    const crashedPose = { ...result.state.positionM }
    runtime.arm()
    expect(runtime.isArmed()).toBe(false)
    for (let index = 0; index < 240; index += 1) result = runtime.step(input)
    expect(result.state.crashed).toBe(true)
    expect(result.state.positionM).toEqual(crashedPose)
    expect(result.state.motors.every((motor) => motor.actualThrustN === 0)).toBe(true)

    runtime.reset()
    expect(runtime.getState().crashed).toBe(false)
    runtime.arm()
    expect(runtime.isArmed()).toBe(true)
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
