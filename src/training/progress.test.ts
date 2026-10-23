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
      context({ rulesVersion: 4 }),
      context({ rulesVersion: 5 }),
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
    const invalid = { ...source, rulesVersion: 6 } as unknown as TrainingAttemptContext
    expect(store.recordResult(result({ attemptContext: invalid })).saved).toBe(false)
    expect(store.loadCurrent(invalid).errors.join(' ')).toMatch(/context.*invalid/i)
    expect(storage.getItem(TRAINING_PROGRESS_STORAGE_KEY)).toBeNull()
  })

  it('keeps approved lesson progress visible while isolating revised L06 from its old scores', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const baseline = context({ rulesVersion: 4, mode: 'practice' })
    const revised = context({ ...baseline, rulesVersion: 5 })
    for (const lessonId of ['straight-line', 'landing', 'direction-control', 'coordinated-turn']) {
      expect(store.recordResult(result({ lessonId, sessionId: `${lessonId}:old`, attemptContext: baseline })).saved).toBe(true)
    }
    const originalBaseline = storage.getItem(trainingAttemptContextKey(baseline))
    const beforeL06 = store.loadCurrent(revised)
    for (const lessonId of ['straight-line', 'landing', 'direction-control']) {
      expect(beforeL06.progress.lessons[lessonId]).toMatchObject({ completed: true, attempts: 1 })
    }
    expect(beforeL06.progress.lessons['coordinated-turn']).toMatchObject({ completed: false, attempts: 0, best: null })
    expect(store.load(baseline).progress.lessons['coordinated-turn']?.best?.sessionId).toBe('coordinated-turn:old')

    expect(store.recordResult(result({
      lessonId: 'coordinated-turn', sessionId: 'coordinated-turn:new', attemptContext: revised,
      completedCheckpoints: 8, totalCheckpoints: 8, metrics: { turnTargetsCompleted: 6 },
    })).saved).toBe(true)
    const originalRevised = storage.getItem(trainingAttemptContextKey(revised))
    for (const selectedContext of [baseline, revised]) {
      const loaded = new TrainingProgressStore(storage).loadCurrent(selectedContext)
      expect(loaded.errors).toEqual([])
      expect(loaded.progress.lessons['coordinated-turn']).toMatchObject({
        completed: true, attempts: 1, best: { sessionId: 'coordinated-turn:new', totalCheckpoints: 8 },
      })
      for (const lessonId of ['straight-line', 'landing', 'direction-control']) {
        expect(loaded.progress.lessons[lessonId]).toMatchObject({ completed: true, attempts: 1 })
      }
    }
    expect(storage.getItem(trainingAttemptContextKey(baseline))).toBe(originalBaseline)
    expect(storage.getItem(trainingAttemptContextKey(revised))).toBe(originalRevised)

    // Adding L07 in the same route-rule scope keeps the approved L06 result.
    expect(store.loadCurrent(revised).progress.lessons['square-route']).toMatchObject({ completed: false, attempts: 0 })
    expect(store.recordResult(result({
      lessonId: 'square-route', sessionId: 'square-route:new', attemptContext: revised,
      completedCheckpoints: 10, totalCheckpoints: 10, metrics: { squareTargetsCompleted: 8, squareLegsCompleted: 4 },
    })).saved).toBe(true)
    const afterL07 = new TrainingProgressStore(storage).loadCurrent(revised).progress
    expect(afterL07.lessons['square-route']).toMatchObject({ completed: true, attempts: 1 })
    expect(afterL07.lessons['coordinated-turn']).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'coordinated-turn:new' } })
    for (const lessonId of ['straight-line', 'landing', 'direction-control']) {
      expect(afterL07.lessons[lessonId]).toMatchObject({ completed: true, attempts: 1 })
    }
    expect(storage.getItem(trainingAttemptContextKey(baseline))).toBe(originalBaseline)

    // The new L08 lesson starts empty and preserves both approved route courses.
    expect(afterL07.lessons['figure-eight']).toMatchObject({ completed: false, attempts: 0 })
    expect(store.recordResult(result({
      lessonId: 'figure-eight', sessionId: 'figure-eight:new', attemptContext: revised,
      completedCheckpoints: 11, totalCheckpoints: 11, metrics: { eightTargetsCompleted: 9, eightLoopsCompleted: 2 },
    })).saved).toBe(true)
    const afterL08 = new TrainingProgressStore(storage).loadCurrent(revised).progress
    expect(afterL08.lessons['figure-eight']).toMatchObject({ completed: true, attempts: 1 })
    expect(afterL08.lessons['square-route']).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'square-route:new' } })
    expect(afterL08.lessons['coordinated-turn']).toEqual(afterL07.lessons['coordinated-turn'])
    for (const lessonId of ['straight-line', 'landing', 'direction-control']) {
      expect(afterL08.lessons[lessonId]).toEqual(afterL07.lessons[lessonId])
    }
    expect(afterL08.lessons['wide-gate']).toMatchObject({ completed: false, attempts: 0 })
    expect(store.recordResult(result({
      lessonId: 'wide-gate', sessionId: 'wide-gate:new', attemptContext: revised,
      completedCheckpoints: 5, totalCheckpoints: 5, metrics: { gatesPassed: 3 },
    })).saved).toBe(true)
    const afterL09 = new TrainingProgressStore(storage).loadCurrent(revised).progress
    expect(afterL09.lessons['wide-gate']).toMatchObject({ completed: true, attempts: 1 })
    for (const lessonId of ['straight-line', 'landing', 'direction-control', 'coordinated-turn', 'square-route', 'figure-eight']) {
      expect(afterL09.lessons[lessonId]).toEqual(afterL08.lessons[lessonId])
    }
    expect(storage.getItem(trainingAttemptContextKey(baseline))).toBe(originalBaseline)
  })

  it('keeps both current rule scopes isolated by mode, preset, input and settings', () => {
    const store = new TrainingProgressStore(new MemoryStorage())
    const baseline = context({ rulesVersion: 4, mode: 'practice' })
    store.recordResult(result({ lessonId: 'direction-control', attemptContext: baseline }))
    store.recordResult(result({ lessonId: 'coordinated-turn', attemptContext: { ...baseline, rulesVersion: 5 } }))
    for (const variation of [
      { mode: 'challenge' as const },
      { presetId: 'standard' as const },
      { inputSource: 'keyboard' as const },
      { settingsFingerprint: fingerprintTrainingSettings({ rates: 500 }) },
    ]) {
      const loaded = store.loadCurrent({ ...baseline, ...variation })
      expect(loaded.progress.lessons['direction-control']?.completed).toBe(false)
      expect(loaded.progress.lessons['coordinated-turn']?.completed).toBe(false)
      expect(loaded.errors).toEqual([])
    }
  })

  it.each([null, '{broken-json'])('retains a healthy current scope when the other scope is missing or corrupt (%s)', (damaged) => {
    for (const healthyVersion of [4, 5] as const) {
      const storage = new MemoryStorage()
      const store = new TrainingProgressStore(storage)
      const healthy = context({ rulesVersion: healthyVersion })
      const other = context({ rulesVersion: healthyVersion === 4 ? 5 : 4 })
      const healthyLessonId = healthyVersion === 4 ? 'direction-control' : 'coordinated-turn'
      const missingLessonId = healthyVersion === 4 ? 'coordinated-turn' : 'direction-control'
      expect(store.recordResult(result({ lessonId: healthyLessonId, attemptContext: healthy })).saved).toBe(true)
      const otherKey = trainingAttemptContextKey(other)
      if (damaged !== null) storage.setItem(otherKey, damaged)
      const loaded = store.loadCurrent(other)
      expect(loaded.loaded).toBe(true)
      expect(loaded.progress.lessons[healthyLessonId]).toMatchObject({ completed: true, attempts: 1 })
      expect(loaded.progress.lessons[missingLessonId]).toMatchObject({ completed: false, attempts: 0 })
      if (damaged === null) expect(loaded.errors).toEqual([])
      else expect(loaded.errors.join(' ')).toMatch(new RegExp(`Rules ${other.rulesVersion}:.*malformed`))
      expect(store.recordResult(result({ lessonId: healthyLessonId, sessionId: 'healthy:2', attemptContext: healthy })).saved).toBe(true)
      expect(storage.getItem(otherKey)).toBe(damaged)
      expect(new TrainingProgressStore(storage).loadCurrent(healthy).progress.lessons[healthyLessonId]?.attempts).toBe(2)
    }
  })
})
