import { describe, expect, it } from 'vitest'

import {
  applyRemappedDeadband,
  ControllerSignalHistory,
  normalizeCentered,
  normalizeThrottle,
  processChannel,
  processControllerSnapshot,
} from './signal'
import type { ChannelCalibration, ControllerProfile, RawGamepadSnapshot } from './types'

const centered: ChannelCalibration = {
  axis: 0,
  invert: false,
  center: 0.1,
  minimum: -0.9,
  maximum: 0.9,
  deadband: 0.03,
}

const profile: ControllerProfile = {
  schemaVersion: 1,
  deviceId: 'test-device',
  deviceMapping: '',
  axisCount: 4,
  buttonCount: 0,
  channels: {
    roll: centered,
    pitch: { ...centered, axis: 1 },
    yaw: { ...centered, axis: 2 },
    throttle: { axis: 3, invert: false, center: -1, minimum: -1, maximum: 1, deadband: 0 },
  },
  throttleMode: 'single-ended',
  calibrationTimestamp: '2026-01-01T00:00:00.000Z',
  directionVerifiedAt: null,
  neutralVerifiedAt: null,
  neutralStability: null,
}

const snapshot: RawGamepadSnapshot = {
  id: 'test-device',
  index: 0,
  mapping: '',
  axisCount: 4,
  buttonCount: 0,
  connected: true,
  axes: [0.1, 0.1, 0.1, -1],
  buttons: [],
  timestamp: 1,
  invalidAxisIndices: [],
  invalidButtonIndices: [],
}

describe('controller signal transforms', () => {
  it('remaps a small deadband without reducing full-stick output', () => {
    expect(applyRemappedDeadband(0.02, 0.03)).toBe(0)
    expect(applyRemappedDeadband(-0.03, 0.03)).toBe(0)
    expect(applyRemappedDeadband(1, 0.03)).toBeCloseTo(1)
    expect(applyRemappedDeadband(-0.515, 0.03)).toBeCloseTo(-0.5, 5)
  })

  it('uses measured center and asymmetric endpoints', () => {
    expect(normalizeCentered(0.1, centered)).toBeCloseTo(0)
    expect(normalizeCentered(0.9, centered)).toBeCloseTo(1)
    expect(normalizeCentered(-0.9, centered)).toBeCloseTo(-1)
    expect(normalizeCentered(0.5, centered)).toBeCloseTo(0.5)
  })

  it('inverts centered and throttle channels at the normalized boundary', () => {
    expect(normalizeCentered(0.9, { ...centered, invert: true })).toBeCloseTo(-1)
    const throttle: ChannelCalibration = {
      axis: 3,
      invert: false,
      center: -1,
      minimum: -0.8,
      maximum: 0.7,
      deadband: 0,
    }
    expect(normalizeThrottle(-0.8, throttle)).toBe(0)
    expect(normalizeThrottle(0.7, throttle)).toBe(1)
    expect(normalizeThrottle(-0.8, { ...throttle, invert: true })).toBe(1)
  })

  it('keeps centered neutral at zero rather than creating a yaw command', () => {
    const processed = processControllerSnapshot(snapshot, profile)
    expect(processed.valid).toBe(true)
    expect(processed.channels.roll.final).toBe(0)
    expect(processed.channels.pitch.final).toBe(0)
    expect(processed.channels.yaw.final).toBe(0)
  })

  it('keeps filtering history live outside React and resets it for a new source', () => {
    const history = new ControllerSignalHistory()
    const first = history.process({ ...snapshot, timestamp: 100, connectionSession: 'session-a' }, profile)
    const moved = history.process({ ...snapshot, axes: [0.7, 0.1, 0.1, -1], timestamp: 116, connectionSession: 'session-a' }, profile)
    expect(first.channels.roll.filtered).toBe(0)
    expect(moved.channels.roll.filtered).not.toBe(moved.channels.roll.deadband)

    const fresh = history.process({ ...snapshot, timestamp: 132, connectionSession: 'session-b' }, profile)
    expect(fresh.channels.roll.filtered).toBe(0)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-finite timestamp %s and clears filtering history before the next valid sample',
    (timestamp) => {
      const nonFiniteSnapshot = { ...snapshot, timestamp }
      expect(processControllerSnapshot(nonFiniteSnapshot, profile).valid).toBe(false)

      const history = new ControllerSignalHistory()
      history.process({ ...snapshot, timestamp: 100, connectionSession: 'session-a' }, profile)
      const moved = history.process({
        ...snapshot,
        axes: [0.7, 0.1, 0.1, -1],
        timestamp: 116,
        connectionSession: 'session-a',
      }, profile)
      expect(moved.channels.roll.filtered).not.toBe(moved.channels.roll.deadband)

      const invalid = history.process({ ...nonFiniteSnapshot, connectionSession: 'session-a' }, profile)
      expect(invalid.valid).toBe(false)

      const fresh = history.process({ ...snapshot, timestamp: 132, connectionSession: 'session-a' }, profile)
      expect(fresh.valid).toBe(true)
      expect(fresh.channels.roll.filtered).toBe(0)
    },
  )

  it('preserves a measured full endpoint through the filter boundary', () => {
    const endpoint = processChannel('roll', 0.9, centered, -0.5, 1 / 60)
    expect(endpoint.final).toBe(1)
  })

  it('rejects non-finite raw input instead of hiding it in a deadband', () => {
    const processed = processChannel('roll', Number.NaN, centered, undefined, 1 / 60)
    expect(processed.valid).toBe(false)
    expect(Number.isNaN(processed.final)).toBe(true)

    const invalidSnapshot = { ...snapshot, axes: [Number.NaN, 0.1, 0.1, -1], invalidAxisIndices: [0] }
    const state = processControllerSnapshot(invalidSnapshot, profile)
    expect(state.valid).toBe(false)
    expect(state.invalidChannels).toContain('roll')
  })
})
