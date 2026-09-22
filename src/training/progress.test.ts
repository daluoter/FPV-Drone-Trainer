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
    lessonId: 'stable-hover',
    sessionId: 'stable-hover:1',
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
    expect(loaded.progress.lessons['stable-hover']?.completed).toBe(false)

    expect(validateTrainingProgress({ schemaVersion: 1, lessons: { broken: { completed: true } } }).valid).toBe(false)
  })

  it('persists recent, best, completion, attempts, and meaningful metrics', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const first = store.recordResult(result(), '2026-01-01T00:00:00.000Z')
    expect(first.saved).toBe(true)
    expect(first.progress.lessons['stable-hover']).toMatchObject({ completed: true, attempts: 1 })
    expect(first.progress.lessons['stable-hover']?.best?.metrics).toEqual({ driftM: 0.12, maxTiltDegrees: 4.5 })

    const worse = store.recordResult(result({ sessionId: 'stable-hover:2', score: 70, elapsedSeconds: 8 }), '2026-01-02T00:00:00.000Z')
    expect(worse.progress.lessons['stable-hover']?.attempts).toBe(2)
    expect(worse.progress.lessons['stable-hover']?.recent?.sessionId).toBe('stable-hover:2')
    expect(worse.progress.lessons['stable-hover']?.best?.sessionId).toBe('stable-hover:1')

    const failed = recordTrainingResult(createDefaultTrainingProgress(['stable-hover']), result({ outcome: 'FAILED', score: 10 }), '2026-01-03T00:00:00.000Z')
    expect(failed.lessons['stable-hover']?.completed).toBe(false)
    expect(failed.lessons['stable-hover']?.best).toBeNull()
  })
})
