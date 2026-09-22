import { describe, expect, it } from 'vitest'

import { markDirectionsVerified, markNeutralVerified, createControllerProfile } from './profile'
import { evaluateFlightArmEligibility, evaluateFlightEligibility } from './safety'
import { processControllerSnapshot } from './signal'
import type { ControllerDevice, NeutralStabilityReport, RawGamepadSnapshot } from './types'

const device: ControllerDevice = {
  id: 'safety-device',
  index: 0,
  mapping: '',
  axisCount: 4,
  buttonCount: 0,
  connected: true,
}

const snapshot: RawGamepadSnapshot = {
  ...device,
  axes: [0, 0, 0, -1],
  buttons: [],
  timestamp: 1,
  invalidAxisIndices: [],
  invalidButtonIndices: [],
}

const report: NeutralStabilityReport = {
  sampleCount: 100,
  durationMs: 3_000,
  threshold: 0.02,
  maxAbsolute: { roll: 0.01, pitch: 0.01, yaw: 0.01 },
  mean: { roll: 0, pitch: 0, yaw: 0 },
  standardDeviation: { roll: 0.001, pitch: 0.001, yaw: 0.001 },
  stable: true,
}

function makeProfile() {
  return createControllerProfile(device, {
    roll: { axis: 0, center: 0, minimum: -1, maximum: 1 },
    pitch: { axis: 1, center: 0, minimum: -1, maximum: 1 },
    yaw: { axis: 2, center: 0, minimum: -1, maximum: 1 },
    throttle: { axis: 3, center: -1, minimum: -1, maximum: 1 },
  })
}

describe('flight eligibility gate', () => {
  it('does not pass until directions and neutral stability are verified', () => {
    const profile = makeProfile()
    const processed = processControllerSnapshot(snapshot, profile)
    expect(evaluateFlightEligibility(device, profile, processed).eligible).toBe(false)

    const verified = markNeutralVerified(markDirectionsVerified(profile), report, '2026-01-01T00:00:00.000Z', 'test-connection')
    expect(evaluateFlightEligibility(device, verified, processed, { connectionSession: 'test-connection' }).eligible).toBe(true)
  })

  it('requires the neutral approval to match the current connection session', () => {
    const verified = markNeutralVerified(markDirectionsVerified(makeProfile()), report, '2026-01-01T00:00:00.000Z', 'old-session')
    const result = evaluateFlightEligibility(device, verified, processControllerSnapshot(snapshot, verified), { connectionSession: 'new-session' })
    expect(result.eligible).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/fresh timed neutral/i)
  })

  it('checks neutral sticks and low throttle only at the arm handoff', () => {
    const verified = markNeutralVerified(markDirectionsVerified(makeProfile()), report, '2026-01-01T00:00:00.000Z', 'test-connection')
    const movedSnapshot = { ...snapshot, axes: [0.4, 0, 0, -1] }
    const moved = processControllerSnapshot(movedSnapshot, verified)
    expect(evaluateFlightEligibility(device, verified, moved, { connectionSession: 'test-connection' }).eligible).toBe(true)
    expect(evaluateFlightArmEligibility(device, verified, moved, { connectionSession: 'test-connection' }).eligible).toBe(false)
    expect(evaluateFlightArmEligibility(device, verified, processControllerSnapshot(snapshot, verified), { connectionSession: 'test-connection' }).eligible).toBe(true)

    const buttonInvalid = processControllerSnapshot({
      ...snapshot,
      buttonCount: 1,
      buttons: [{ pressed: false, touched: false, value: Number.NaN }],
      invalidButtonIndices: [0],
    }, verified)
    expect(buttonInvalid.valid).toBe(false)
    expect(evaluateFlightEligibility(device, verified, buttonInvalid, { connectionSession: 'test-connection' }).eligible).toBe(false)
  })

  it('rejects a disconnected device even with a valid profile', () => {
    const verified = markNeutralVerified(markDirectionsVerified(makeProfile()), report, '2026-01-01T00:00:00.000Z', 'test-connection')
    const result = evaluateFlightEligibility({ ...device, connected: false }, verified, null)
    expect(result.eligible).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/disconnected/i)
  })
})
