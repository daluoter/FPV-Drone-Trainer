import { describe, expect, it } from 'vitest'

import {
  ControllerProfileStore,
  createControllerProfile,
  invalidateProfileVerification,
  isProfileCompatible,
  markDirectionsVerified,
  markNeutralVerified,
  parseControllerProfile,
  updateChannelCalibration,
  validateControllerProfile,
  type StorageLike,
} from './profile'
import type { ControllerDevice, NeutralStabilityReport } from './types'

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>()

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  public removeItem(key: string): void {
    this.values.delete(key)
  }
}

const device: ControllerDevice = {
  id: 'RadioMaster test',
  index: 2,
  mapping: '',
  axisCount: 4,
  buttonCount: 8,
  connected: true,
}

const profile = createControllerProfile(device, {
  roll: { axis: 0, center: 0, minimum: -0.8, maximum: 0.9 },
  pitch: { axis: 1, center: 0, minimum: -0.8, maximum: 0.9 },
  yaw: { axis: 2, center: 0, minimum: -0.8, maximum: 0.9 },
  throttle: { axis: 3, center: -1, minimum: -1, maximum: 0.8 },
})

const report: NeutralStabilityReport = {
  sampleCount: 100,
  durationMs: 3_000,
  threshold: 0.02,
  maxAbsolute: { roll: 0.01, pitch: 0.01, yaw: 0.01 },
  mean: { roll: 0, pitch: 0, yaw: 0 },
  standardDeviation: { roll: 0.005, pitch: 0.005, yaw: 0.005 },
  stable: true,
  reason: 'stable',
}

describe('controller profile safety and persistence', () => {
  it('rejects duplicate axes, out-of-range axes, and invalid endpoints', () => {
    const duplicate = { ...profile, channels: { ...profile.channels, pitch: { ...profile.channels.pitch, axis: 0 } } }
    expect(validateControllerProfile(duplicate).valid).toBe(false)
    expect(validateControllerProfile(duplicate).errors.join(' ')).toMatch(/reuses an axis/)

    const outOfRange = { ...profile, channels: { ...profile.channels, yaw: { ...profile.channels.yaw, axis: 8 } } }
    expect(validateControllerProfile(outOfRange).valid).toBe(false)

    const invalidEndpoints = { ...profile, channels: { ...profile.channels, roll: { ...profile.channels.roll, minimum: 0.4, center: 0.2 } } }
    expect(validateControllerProfile(invalidEndpoints).valid).toBe(false)
  })

  it('requires exact device compatibility instead of blindly loading a profile', () => {
    expect(isProfileCompatible(profile, device)).toBe(true)
    expect(isProfileCompatible(profile, { ...device, axisCount: 5 })).toBe(false)
    expect(isProfileCompatible(profile, { ...device, id: 'different' })).toBe(false)

    const storage = new MemoryStorage()
    const store = new ControllerProfileStore(storage)
    expect(store.save(profile).saved).toBe(true)
    expect(store.loadCompatible(device)?.deviceId).toBe(device.id)
    expect(store.loadCompatible({ ...device, id: 'different' })).toBeNull()
  })

  it('invalidates both verification gates whenever calibration is edited', () => {
    const verified = markNeutralVerified(markDirectionsVerified(profile), report, '2026-01-01T00:00:00.000Z', 'test-connection')
    expect(verified.directionVerifiedAt).not.toBeNull()
    expect(verified.neutralVerifiedAt).not.toBeNull()

    const edited = updateChannelCalibration(verified, 'roll', { invert: true })
    expect(edited.directionVerifiedAt).toBeNull()
    expect(edited.neutralVerifiedAt).toBeNull()
    expect(edited.neutralStability).toBeNull()
    expect(invalidateProfileVerification(verified).neutralVerifiedAt).toBeNull()
  })

  it('requires a connection-bound neutral approval', () => {
    const directions = markDirectionsVerified(profile)
    expect(markNeutralVerified(directions, report).neutralVerifiedAt).toBeNull()
    const verified = markNeutralVerified(directions, report, '2026-01-01T00:00:00.000Z', 'connection-a')
    expect(verified.neutralVerificationSession).toBe('connection-a')
  })

  it('rejects malformed neutral evidence from parsing and persistence', () => {
    const malformed = {
      ...profile,
      neutralStability: {
        ...report,
        sampleCount: 0,
        durationMs: 0,
        stable: true,
      },
      neutralVerifiedAt: '2026-01-01T00:00:00.000Z',
      neutralVerificationSession: 'old-connection',
    }
    expect(parseControllerProfile(malformed)).toBeNull()

    const storage = new MemoryStorage()
    storage.setItem(
      'fpv-drone-trainer.controller-profile.v1.RadioMaster%20test',
      JSON.stringify(malformed),
    )
    expect(new ControllerProfileStore(storage).loadCompatible(device)).toBeNull()
  })

  it('parses only the supported versioned profile shape', () => {
    expect(parseControllerProfile(JSON.parse(JSON.stringify(profile)))).not.toBeNull()
    expect(parseControllerProfile({ ...profile, schemaVersion: 99 })).toBeNull()
    expect(parseControllerProfile({ ...profile, channels: null })).toBeNull()
  })
})
