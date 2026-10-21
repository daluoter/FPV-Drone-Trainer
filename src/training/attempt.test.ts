import { describe, expect, it } from 'vitest'

import {
  fingerprintTrainingSettings,
  isTrainingAttemptContext,
  trainingAttemptContextKey,
  type TrainingAttemptContext,
} from './attempt'

function context(overrides: Partial<TrainingAttemptContext> = {}): TrainingAttemptContext {
  return {
    rulesVersion: 1,
    physicsVersion: 1,
    presetId: 'beginner',
    settingsFingerprint: fingerprintTrainingSettings({ rates: { roll: 250, pitch: 250 }, camera: 10 }),
    inputSource: 'controller',
    mode: 'challenge',
    assistance: 'none',
    ...overrides,
  }
}

describe('training attempt provenance', () => {
  it('identifies the same settings independently of object insertion order', () => {
    expect(fingerprintTrainingSettings({ camera: 10, rates: { pitch: 250, roll: 250 } }))
      .toBe(fingerprintTrainingSettings({ rates: { roll: 250, pitch: 250 }, camera: 10 }))
    expect(fingerprintTrainingSettings({ camera: 20 })).not.toBe(fingerprintTrainingSettings({ camera: 10 }))
  })

  it('rejects non-finite and non-JSON settings instead of collapsing them to an identity', () => {
    for (const settings of [{ rate: Number.NaN }, { rate: Number.POSITIVE_INFINITY }, { rate: undefined }, new Date()]) {
      expect(() => fingerprintTrainingSettings(settings)).toThrow(/finite JSON/)
    }
  })

  it('separates input, preset, settings and learning mode into distinct storage scopes', () => {
    const base = context()
    const keys = [
      base,
      context({ inputSource: 'keyboard' }),
      context({ presetId: 'standard' }),
      context({ mode: 'practice' }),
      context({ rulesVersion: 2 }),
      context({ rulesVersion: 3 }),
      context({ settingsFingerprint: fingerprintTrainingSettings({ rates: 900 }) }),
    ].map(trainingAttemptContextKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(trainingAttemptContextKey({ ...base })).toBe(trainingAttemptContextKey(base))
  })

  it('rejects unsupported provenance instead of silently treating it as legacy', () => {
    expect(isTrainingAttemptContext(context())).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 2 })).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 3 })).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 4 })).toBe(false)
    expect(isTrainingAttemptContext({ ...context(), settingsFingerprint: '' })).toBe(false)
    expect(() => trainingAttemptContextKey({ ...context(), inputSource: 'unknown' } as unknown as TrainingAttemptContext)).toThrow()
  })
})
