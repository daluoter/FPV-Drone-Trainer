import { describe, expect, it, vi } from 'vitest'

import {
  createControllerProfile,
  markDirectionsVerified,
  markNeutralVerified,
  type ControllerDevice,
  type ControllerProfile,
  type GamepadPoller,
  type PollerState,
  type RawGamepadSnapshot,
} from '../controller'
import { createDefaultFlightControllerConfig, FlightSimulation } from '../flight-controller'
import { FlightRuntime } from './flightRuntime'

const neutralReport = {
  sampleCount: 100,
  durationMs: 3_000,
  threshold: 0.02,
  maxAbsolute: { roll: 0.005, pitch: 0.005, yaw: 0.005 },
  mean: { roll: 0, pitch: 0, yaw: 0 },
  standardDeviation: { roll: 0.001, pitch: 0.001, yaw: 0.001 },
  stable: true,
  reason: 'stable',
} as const

function createHandoff(): { device: ControllerDevice; profile: ControllerProfile; snapshot: RawGamepadSnapshot } {
  const device: ControllerDevice = {
    id: 'runtime-pad',
    index: 0,
    mapping: '',
    axisCount: 4,
    buttonCount: 1,
    connected: true,
    connectionSession: 'session-a',
  }
  const profile = markNeutralVerified(
    markDirectionsVerified(createControllerProfile(device, {
      roll: { axis: 0, center: 0, minimum: -1, maximum: 1 },
      pitch: { axis: 1, center: 0, minimum: -1, maximum: 1 },
      yaw: { axis: 2, center: 0, minimum: -1, maximum: 1 },
      throttle: { axis: 3, center: -1, minimum: -1, maximum: 1 },
    })),
    neutralReport,
    '2026-01-01T00:00:00.000Z',
    'session-a',
  )
  const snapshot: RawGamepadSnapshot = {
    ...device,
    axes: [0, 0, 0, -1],
    buttons: [{ pressed: false, touched: false, value: 0 }],
    timestamp: 1,
    invalidAxisIndices: [],
    invalidButtonIndices: [],
  }
  return { device, profile, snapshot }
}

class FakePoller implements RuntimePollerForTest {
  public state: PollerState
  public snapshot: RawGamepadSnapshot | null

  public constructor(device: ControllerDevice, snapshot: RawGamepadSnapshot) {
    this.snapshot = snapshot
    this.state = { supported: true, devices: [device], snapshots: [snapshot], selectedDeviceIndex: device.index }
  }

  public poll(): PollerState {
    return this.state
  }

  public getState(): PollerState {
    return this.state
  }

  public getSelectedSnapshot(): RawGamepadSnapshot | null {
    return this.snapshot
  }
}

type RuntimePollerForTest = Pick<GamepadPoller, 'poll' | 'getState' | 'getSelectedSnapshot'>

function nextFrameRunner() {
  let callback: ((time: number) => void) | null = null
  return {
    schedule: (next: (time: number) => void): number => {
      callback = next
      return 1
    },
    cancel: vi.fn(),
    run: (time: number): void => callback?.(time),
  }
}

describe('Free Flight runtime safety transitions', () => {
  it('accepts intended stick movement after a gated arm and disarms on disconnect', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })

    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    poller.snapshot = { ...handoff.snapshot, axes: [0.7, 0, 0, 1], timestamp: 2 }
    poller.state = { ...poller.state, snapshots: [poller.snapshot] }
    frames.run(100)
    expect(runtime.getTelemetry().armed).toBe(true)
    // Arm-time neutral/low-throttle conditions are not continuously reapplied.
    poller.snapshot = { ...handoff.snapshot, axes: [0.7, 0, 0, 1], timestamp: 2 }
    poller.state = { ...poller.state, snapshots: [poller.snapshot] }
    frames.run(150)
    expect(runtime.getTelemetry().armed).toBe(true)

    poller.snapshot = null
    poller.state = { ...poller.state, devices: [{ ...handoff.device, connected: false }], snapshots: [], selectedDeviceIndex: null }
    frames.run(200)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/controller|select|disconnected/i)
    runtime.dispose()
  })

  it('disarms and requires explicit rearm when the document becomes hidden', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      runtime.start()
      frames.run(0)
      expect(runtime.arm()).toBe(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(runtime.getTelemetry().armed).toBe(false)
      expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/hidden|rearm/i)
    } finally {
      if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor)
      else Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      runtime.dispose()
    }
  })

  it('requires explicit rearm when a connected controller changes session identity', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)

    const nextDevice = { ...handoff.device, connectionSession: 'session-b' }
    const nextSnapshot = { ...handoff.snapshot, ...nextDevice, timestamp: 4 }
    poller.snapshot = nextSnapshot
    poller.state = { ...poller.state, devices: [nextDevice], snapshots: [nextSnapshot] }
    frames.run(100)

    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/session|device|rearm/i)
    runtime.dispose()
  })

  it('sends keyboard input through the same rates and simulation pipeline as direct RC input', () => {
    const frames = nextFrameRunner()
    let currentTime = 0
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => currentTime,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.simulation.getState().stepIndex).toBe(0)
    expect(runtime.arm()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
    expect(runtime.keyboard.getInput()).toEqual({ roll: 1, pitch: 0, yaw: 0, throttle: 1 })
    currentTime = 100
    frames.run(100)

    const expected = new FlightSimulation()
    expected.arm()
    expected.advance(0.1, { roll: 1, pitch: 0, yaw: 0, throttle: 1 })
    const actual = runtime.simulation.getTelemetry()
    const expectedTelemetry = expected.getTelemetry()
    expect(actual.targetPilotRateRadPerSec).toEqual(expectedTelemetry.targetPilotRateRadPerSec)
    expect(actual.motors.map((motor) => motor.command)).toEqual(expectedTelemetry.motors.map((motor) => motor.command))
    runtime.dispose()
  })

  it('reconfigures only through a disarmed reset boundary', () => {
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    frames.run(16)
    frames.run(100)
    expect(runtime.simulation.getState().stepIndex).toBeGreaterThan(0)

    const defaults = createDefaultFlightControllerConfig()
    const controller = {
      ...defaults,
      rates: {
        ...defaults.rates,
        axes: {
          ...defaults.rates.axes,
          roll: { ...defaults.rates.axes.roll, centerRateDegPerSec: 120 },
        },
      },
    }
    runtime.reconfigure({ controller })

    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/settings|reset|disarmed/i)
    expect(runtime.simulation.getState().stepIndex).toBe(0)
    expect(runtime.simulation.controller.config.rates.axes.roll.centerRateDegPerSec).toBe(120)
    runtime.dispose()
  })

  it('requires explicit rearm after blur, invalid input, and source changes', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)

    window.dispatchEvent(new Event('blur'))
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.arm()).toBe(true)

    poller.snapshot = { ...handoff.snapshot, axes: [Number.NaN, 0, 0, -1], timestamp: 3, invalidAxisIndices: [0] }
    poller.state = { ...poller.state, snapshots: [poller.snapshot] }
    frames.run(100)
    expect(runtime.getTelemetry().armed).toBe(false)

    runtime.setInputSource('keyboard')
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.setInputSource('controller')
    expect(runtime.getTelemetry().armed).toBe(false)

    runtime.setInputSource('keyboard')
    expect(runtime.arm()).toBe(true)
    runtime.setControllerProfile({ ...handoff.profile, calibrationTimestamp: '2026-01-02T00:00:00.000Z' })
    expect(runtime.getTelemetry().armed).toBe(false)
    runtime.dispose()
  })
})