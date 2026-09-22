import { describe, expect, it } from 'vitest'

import { markDirectionsVerified, markNeutralVerified, createControllerProfile } from './profile'
import { evaluateFlightEligibility } from './safety'
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
  threshold: 0.05,
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

    const verified = markNeutralVerified(markDirectionsVerified(profile), report)
    expect(evaluateFlightEligibility(device, verified, processed).eligible).toBe(true)
  })

  it('rejects a disconnected device even with a valid profile', () => {
    const verified = markNeutralVerified(markDirectionsVerified(makeProfile()), report)
    const result = evaluateFlightEligibility({ ...device, connected: false }, verified, null)
    expect(result.eligible).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/disconnected/i)
  })
})
