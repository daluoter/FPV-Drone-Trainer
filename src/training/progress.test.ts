import { describe, expect, it } from 'vitest'

import {
  TRAINING_PROGRESS_STORAGE_KEY,
  TrainingProgressStore,
  createDefaultTrainingProgress,
  recordTrainingResult,
  validateTrainingProgress,
} from './progress'
import type { TrainingResult, TrainingStorageLike } from './types'

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
})
