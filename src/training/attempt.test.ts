import { describe, expect, it } from 'vitest'

import {
  CURRENT_TRAINING_RULES_VERSION,
  fingerprintTrainingSettings,
  isTrainingAttemptContext,
  trainingAttemptContextKey,
  trainingRulesVersionForLesson,
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
      context({ rulesVersion: 4 }),
      context({ rulesVersion: 5 }),
      context({ settingsFingerprint: fingerprintTrainingSettings({ rates: 900 }) }),
    ].map(trainingAttemptContextKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(trainingAttemptContextKey({ ...base })).toBe(trainingAttemptContextKey(base))
  })

  it('rejects unsupported provenance instead of silently treating it as legacy', () => {
    expect(isTrainingAttemptContext(context())).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 2 })).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 3 })).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 4 })).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 5 })).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 6 })).toBe(true)
    expect(isTrainingAttemptContext({ ...context(), rulesVersion: 7 })).toBe(false)
    expect(isTrainingAttemptContext({ ...context(), settingsFingerprint: '' })).toBe(false)
    expect(() => trainingAttemptContextKey({ ...context(), inputSource: 'unknown' } as unknown as TrainingAttemptContext)).toThrow()
  })

  it('versions L06 through L10 while retaining the earlier lesson baseline', () => {
    expect(CURRENT_TRAINING_RULES_VERSION).toBe(4)
    expect(trainingRulesVersionForLesson('coordinated-turn')).toBe(5)
    expect(trainingRulesVersionForLesson('square-route')).toBe(5)
    expect(trainingRulesVersionForLesson('figure-eight')).toBe(5)
    expect(trainingRulesVersionForLesson('wide-gate')).toBe(5)
    expect(trainingRulesVersionForLesson('basic-recovery')).toBe(6)
    expect(trainingRulesVersionForLesson('full-roll')).toBe(6)
    expect(trainingRulesVersionForLesson('full-flip')).toBe(6)
    expect(trainingRulesVersionForLesson('front-flip')).toBe(6)
    expect(trainingRulesVersionForLesson('back-flip')).toBe(6)
    expect(trainingRulesVersionForLesson('power-loop')).toBe(6)
    expect(trainingRulesVersionForLesson('split-s')).toBe(6)
    expect(trainingRulesVersionForLesson('orbit')).toBe(6)
    for (const lessonId of [null, 'takeoff', 'hover', 'straight-line', 'landing', 'direction-control']) {
      expect(trainingRulesVersionForLesson(lessonId)).toBe(4)
    }
    // Reading old contexts must not add fields or relabel their original rules.
    for (const rulesVersion of [1, 2, 3, 4] as const) {
      const source = context({ rulesVersion })
      const key = trainingAttemptContextKey(source)
      expect(JSON.parse(decodeURIComponent(key.slice('fpv-drone-trainer.training-progress.context.v1.'.length)))).toEqual(source)
    }
  })
})
