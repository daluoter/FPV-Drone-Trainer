import { describe, expect, it } from 'vitest'

import {
  TRAINING_PROGRESS_STORAGE_KEY,
  TrainingProgressStore,
  createDefaultTrainingProgress,
  recordTrainingResult,
  validateTrainingProgress,
} from './progress'
import type { TrainingResult, TrainingStorageLike } from './types'
import { fingerprintTrainingSettings, trainingAttemptContextKey, type TrainingAttemptContext } from './attempt'

class MemoryStorage implements TrainingStorageLike {
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

function result(overrides: Partial<TrainingResult> = {}): TrainingResult {
  return {
    lessonId: 'hover',
    sessionId: 'hover:1',
    outcome: 'SUCCESS',
    score: 88,
    elapsedSeconds: 12,
    sampleCount: 2880,
    completedCheckpoints: 3,
    totalCheckpoints: 3,
    startedAtSeconds: 0,
    completedAtSeconds: 12,
    metrics: { driftM: 0.12, maxTiltDegrees: 4.5 },
    message: 'Passed',
    hint: null,
    ...overrides,
  }
}

function context(overrides: Partial<TrainingAttemptContext> = {}): TrainingAttemptContext {
  return {
    rulesVersion: 1,
    physicsVersion: 1,
    presetId: 'beginner',
    settingsFingerprint: fingerprintTrainingSettings({ rates: 250, camera: 10 }),
    inputSource: 'controller',
    mode: 'challenge',
    assistance: 'none',
    ...overrides,
  }
}

describe('training progress persistence', () => {
  it('rejects malformed documents and falls back to empty versioned progress', () => {
    const storage = new MemoryStorage()
    storage.setItem(TRAINING_PROGRESS_STORAGE_KEY, '{not-json')
    const loaded = new TrainingProgressStore(storage).load()
    expect(loaded.loaded).toBe(false)
    expect(loaded.errors.join(' ')).toMatch(/malformed/i)
    expect(loaded.progress.schemaVersion).toBe(1)
    expect(loaded.progress.lessons.hover?.completed).toBe(false)

    expect(validateTrainingProgress({ schemaVersion: 1, lessons: { broken: { completed: true } } }).valid).toBe(false)
  })

  it('ignores placeholder lesson IDs instead of relabeling their completion', () => {
    const storage = new MemoryStorage()
    storage.setItem(TRAINING_PROGRESS_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      lessons: {
        'stable-hover': {
          recent: {
            sessionId: 'stable-hover:1',
            outcome: 'SUCCESS',
            score: 90,
            elapsedSeconds: 10,
            sampleCount: 100,
            completedCheckpoints: 1,
            totalCheckpoints: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
            metrics: {},
          },
          best: {
            sessionId: 'stable-hover:1',
            outcome: 'SUCCESS',
            score: 90,
            elapsedSeconds: 10,
            sampleCount: 100,
            completedCheckpoints: 1,
            totalCheckpoints: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
            metrics: {},
          },
          completed: true,
          attempts: 1,
        },
      },
    }))
    const loaded = new TrainingProgressStore(storage).load()
    expect(loaded.loaded).toBe(true)
    expect(loaded.progress.lessons.hover).toEqual({ recent: null, best: null, completed: false, attempts: 0 })
    expect(loaded.progress.lessons['stable-hover']).toBeUndefined()
  })

  it('persists recent, best, completion, attempts, and meaningful metrics', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const first = store.recordResult(result(), '2026-01-01T00:00:00.000Z')
    expect(first.saved).toBe(true)
    expect(first.progress.lessons.hover).toMatchObject({ completed: true, attempts: 1 })
    expect(first.progress.lessons.hover?.best?.metrics).toEqual({ driftM: 0.12, maxTiltDegrees: 4.5 })

    const worse = store.recordResult(result({ sessionId: 'hover:2', score: 70, elapsedSeconds: 8 }), '2026-01-02T00:00:00.000Z')
    expect(worse.progress.lessons.hover?.attempts).toBe(2)
    expect(worse.progress.lessons.hover?.recent?.sessionId).toBe('hover:2')
    expect(worse.progress.lessons.hover?.best?.sessionId).toBe('hover:1')

    const failed = recordTrainingResult(createDefaultTrainingProgress(['hover']), result({ outcome: 'FAILED', score: 10 }), '2026-01-03T00:00:00.000Z')
    expect(failed.lessons.hover?.completed).toBe(false)
    expect(failed.lessons.hover?.best).toBeNull()
  })

  it('retains legacy progress unchanged while storing new attempts in their exact conditions', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    store.recordResult(result(), '2026-01-01T00:00:00.000Z')
    const legacy = storage.getItem(TRAINING_PROGRESS_STORAGE_KEY)
    const controller = context()
    const keyboard = context({ inputSource: 'keyboard' })

    const recorded = store.recordResult(result({ sessionId: 'context:1', score: 70, attemptContext: controller }))
    expect(recorded.saved).toBe(true)
    expect(recorded.progress.lessons.hover?.best?.score).toBe(70)
    expect(storage.getItem(TRAINING_PROGRESS_STORAGE_KEY)).toBe(legacy)
    expect(store.load().progress.lessons.hover?.best?.score).toBe(88)
    expect(store.load(controller).progress.lessons.hover?.attempts).toBe(1)
    expect(store.load(keyboard).progress.lessons.hover?.attempts).toBe(0)
    expect(JSON.parse(storage.getItem(trainingAttemptContextKey(controller)) ?? '{}').context).toEqual(controller)

    store.recordResult(result({ sessionId: 'keyboard:1', score: 95, attemptContext: keyboard }))
    expect(store.load(controller).progress.lessons.hover?.best?.score).toBe(70)
    expect(store.load(keyboard).progress.lessons.hover?.best?.score).toBe(95)
    expect(store.clear(keyboard).saved).toBe(true)
    expect(store.load(keyboard).loaded).toBe(false)
    expect(store.load(controller).loaded).toBe(true)
    expect(storage.getItem(TRAINING_PROGRESS_STORAGE_KEY)).toBe(legacy)
  })

  it('separates practice, presets, and settings while never inferring mastery from legacy records', () => {
    const store = new TrainingProgressStore(new MemoryStorage())
    const base = context()
    store.recordResult(result({ attemptContext: base }))
    for (const variant of [
      context({ rulesVersion: 2 }),
      context({ rulesVersion: 3 }),
      context({ mode: 'practice' }),
      context({ presetId: 'standard' }),
      context({ settingsFingerprint: fingerprintTrainingSettings({ rates: 500, camera: 20 }) }),
    ]) {
      expect(store.load(variant).progress.lessons.hover?.completed).toBe(false)
    }
    store.recordResult(result({ attemptContext: context({ rulesVersion: 2 }), score: 95 }))
    expect(store.load(base).progress.lessons.hover?.best?.score).toBe(88)
    expect(store.load(context({ rulesVersion: 2 })).progress.lessons.hover?.best?.score).toBe(95)
    expect(store.load().progress.lessons.hover?.completed).toBe(false)
  })

  it('preserves malformed stored data on a failed record rather than overwriting it', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const source = context()
    for (const [key, attempt] of [
      [TRAINING_PROGRESS_STORAGE_KEY, result()],
      [trainingAttemptContextKey(source), result({ attemptContext: source })],
    ] as const) {
      storage.setItem(key, '{recoverable-broken-json')
      expect(store.recordResult(attempt).saved).toBe(false)
      expect(storage.getItem(key)).toBe('{recoverable-broken-json')
    }
  })

  it('rejects mismatched or unsupported context envelopes without touching legacy data', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const source = context()
    const key = trainingAttemptContextKey(source)
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, context: context({ inputSource: 'keyboard' }), progress: createDefaultTrainingProgress() }))
    expect(store.load(source).loaded).toBe(false)
    expect(store.load(source).errors.join(' ')).toMatch(/context.*incompatible/i)
    const invalid = { ...source, rulesVersion: 4 } as unknown as TrainingAttemptContext
    expect(store.recordResult(result({ attemptContext: invalid })).saved).toBe(false)
    expect(storage.getItem(TRAINING_PROGRESS_STORAGE_KEY)).toBeNull()
  })
})
