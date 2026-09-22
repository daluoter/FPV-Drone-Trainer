import { DEFAULT_LESSONS } from './lessons'
import type {
  LessonProgress,
  TrainingAttemptMetric,
  TrainingProgressDocument,
  TrainingProgressLoadResult,
  TrainingProgressPersistenceResult,
  TrainingResult,
  TrainingStorageLike,
} from './types'

export const TRAINING_PROGRESS_SCHEMA_VERSION = 1 as const
export const TRAINING_PROGRESS_STORAGE_KEY = 'fpv-drone-trainer.training-progress.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteBounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function validTimestampString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function copyMetrics(metrics: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(metrics).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
  )
}

function copyAttempt(attempt: TrainingAttemptMetric | null): TrainingAttemptMetric | null {
  if (!attempt) return null
  return { ...attempt, metrics: copyMetrics(attempt.metrics) }
}

function copyLessonProgress(progress: LessonProgress): LessonProgress {
  return {
    recent: copyAttempt(progress.recent),
    best: copyAttempt(progress.best),
    completed: progress.completed,
    attempts: progress.attempts,
  }
}

export function createEmptyLessonProgress(): LessonProgress {
  return { recent: null, best: null, completed: false, attempts: 0 }
}

export function createDefaultTrainingProgress(
  lessonIds: readonly string[] = DEFAULT_LESSONS.map((lesson) => lesson.id),
): TrainingProgressDocument {
  const lessons: Record<string, LessonProgress> = {}
  for (const lessonId of lessonIds) {
    if (typeof lessonId === 'string' && lessonId.length > 0) lessons[lessonId] = createEmptyLessonProgress()
  }
  return { schemaVersion: TRAINING_PROGRESS_SCHEMA_VERSION, lessons }
}

function validateAttempt(value: unknown, label: string, errors: string[]): value is TrainingAttemptMetric {
  if (!isRecord(value)) {
    errors.push(`${label} must be an attempt object.`)
    return false
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) errors.push(`${label}.sessionId is required.`)
  if (value.outcome !== 'SUCCESS' && value.outcome !== 'FAILED') errors.push(`${label}.outcome is invalid.`)
  if (!finiteBounded(value.score, 0, 100)) errors.push(`${label}.score must be in [0, 100].`)
  if (!finiteBounded(value.elapsedSeconds, 0, Number.MAX_SAFE_INTEGER)) errors.push(`${label}.elapsedSeconds is invalid.`)
  if (!Number.isInteger(value.sampleCount) || (value.sampleCount as number) < 0) errors.push(`${label}.sampleCount is invalid.`)
  if (!Number.isInteger(value.completedCheckpoints) || (value.completedCheckpoints as number) < 0) errors.push(`${label}.completedCheckpoints is invalid.`)
  if (!Number.isInteger(value.totalCheckpoints) || (value.totalCheckpoints as number) < 0) errors.push(`${label}.totalCheckpoints is invalid.`)
  if (typeof value.completedCheckpoints === 'number' && typeof value.totalCheckpoints === 'number' && value.completedCheckpoints > value.totalCheckpoints) {
    errors.push(`${label}.completedCheckpoints cannot exceed totalCheckpoints.`)
  }
  if (!validTimestampString(value.completedAt)) errors.push(`${label}.completedAt must be a valid timestamp.`)
  if (!isRecord(value.metrics)) {
    errors.push(`${label}.metrics must be an object.`)
  } else {
    for (const [metric, metricValue] of Object.entries(value.metrics)) {
      if (!finiteBounded(metricValue, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) {
        errors.push(`${label}.metrics.${metric} must be finite.`)
      }
    }
  }
  return errors.length === 0
}

/** Validate a complete progress document before it is used by the UI. */
export function validateTrainingProgress(value: unknown): { valid: boolean; errors: readonly string[] } {
  const errors: string[] = []
  if (!isRecord(value)) return { valid: false, errors: ['Training progress is missing.'] }
  if (value.schemaVersion !== TRAINING_PROGRESS_SCHEMA_VERSION) {
    errors.push(`Training progress schema version ${String(value.schemaVersion)} is unsupported.`)
  }
  if (!isRecord(value.lessons)) {
    errors.push('Training progress lessons are missing.')
    return { valid: false, errors }
  }
  for (const [lessonId, rawProgress] of Object.entries(value.lessons)) {
    if (!lessonId) {
      errors.push('Training progress contains an empty lesson id.')
      continue
    }
    if (!isRecord(rawProgress)) {
      errors.push(`Training progress for ${lessonId} is invalid.`)
      continue
    }
    if (typeof rawProgress.completed !== 'boolean') errors.push(`${lessonId}.completed must be boolean.`)
    if (!Number.isInteger(rawProgress.attempts) || (rawProgress.attempts as number) < 0) errors.push(`${lessonId}.attempts is invalid.`)
    if (rawProgress.recent !== null) validateAttempt(rawProgress.recent, `${lessonId}.recent`, errors)
    if (rawProgress.best !== null) {
      if (validateAttempt(rawProgress.best, `${lessonId}.best`, errors) && rawProgress.best.outcome !== 'SUCCESS') {
        errors.push(`${lessonId}.best must be a successful attempt.`)
      }
    }
    if (rawProgress.completed === true && rawProgress.best === null) errors.push(`${lessonId}.completed requires a best attempt.`)
  }
  return { valid: errors.length === 0, errors }
}

export function copyTrainingProgress(progress: TrainingProgressDocument): TrainingProgressDocument {
  const lessons: Record<string, LessonProgress> = {}
  for (const [lessonId, lessonProgress] of Object.entries(progress.lessons)) {
    lessons[lessonId] = copyLessonProgress(lessonProgress)
  }
  return { schemaVersion: TRAINING_PROGRESS_SCHEMA_VERSION, lessons }
}

function attemptFromResult(result: TrainingResult, completedAt: string): TrainingAttemptMetric {
  return {
    sessionId: result.sessionId,
    outcome: result.outcome,
    score: Math.max(0, Math.min(100, result.score)),
    elapsedSeconds: Math.max(0, result.elapsedSeconds),
    sampleCount: Math.max(0, Math.floor(result.sampleCount)),
    completedCheckpoints: Math.max(0, Math.floor(result.completedCheckpoints)),
    totalCheckpoints: Math.max(0, Math.floor(result.totalCheckpoints)),
    completedAt,
    metrics: copyMetrics(result.metrics),
  }
}

function isBetterAttempt(candidate: TrainingAttemptMetric, current: TrainingAttemptMetric | null): boolean {
  if (!current) return true
  if (candidate.score !== current.score) return candidate.score > current.score
  if (candidate.elapsedSeconds !== current.elapsedSeconds) return candidate.elapsedSeconds < current.elapsedSeconds
  return candidate.sampleCount < current.sampleCount
}

/** Merge a terminal machine result into a copied progress document. */
export function recordTrainingResult(
  progress: TrainingProgressDocument,
  result: TrainingResult,
  completedAt = new Date().toISOString(),
): TrainingProgressDocument {
  const next = copyTrainingProgress(progress)
  const lessons = { ...next.lessons }
  const previous = lessons[result.lessonId] ?? createEmptyLessonProgress()
  const attempt = attemptFromResult(result, completedAt)
  const best = result.outcome === 'SUCCESS' && isBetterAttempt(attempt, previous.best)
    ? attempt
    : previous.best
  lessons[result.lessonId] = {
    recent: attempt,
    best,
    completed: previous.completed || result.outcome === 'SUCCESS',
    attempts: previous.attempts + 1,
  }
  return { ...next, lessons }
}

function browserStorage(): TrainingStorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** Versioned, defensive local progress store. Storage errors never reach runtime. */
export class TrainingProgressStore {
  private readonly storage: TrainingStorageLike | null
  private readonly lessonIds: readonly string[]

  public constructor(
    storage: TrainingStorageLike | null = browserStorage(),
    lessonIds: readonly string[] = DEFAULT_LESSONS.map((lesson) => lesson.id),
  ) {
    this.storage = storage
    this.lessonIds = lessonIds
  }

  public load(): TrainingProgressLoadResult {
    const fallback = createDefaultTrainingProgress(this.lessonIds)
    if (!this.storage) return { progress: fallback, loaded: false, errors: ['Training progress storage is unavailable.'] }
    let raw: string | null
    try {
      raw = this.storage.getItem(TRAINING_PROGRESS_STORAGE_KEY)
    } catch {
      return { progress: fallback, loaded: false, errors: ['Training progress could not be read.'] }
    }
    if (raw === null) return { progress: fallback, loaded: false, errors: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { progress: fallback, loaded: false, errors: ['Saved training progress is malformed JSON.'] }
    }
    const validation = validateTrainingProgress(parsed)
    if (!validation.valid) return { progress: fallback, loaded: false, errors: [...validation.errors] }
    const loaded = parsed as TrainingProgressDocument
    const merged = createDefaultTrainingProgress(this.lessonIds)
    const lessons = { ...merged.lessons }
    for (const [lessonId, progress] of Object.entries(loaded.lessons)) lessons[lessonId] = copyLessonProgress(progress)
    return { progress: { ...merged, lessons }, loaded: true, errors: [] }
  }

  public save(progress: TrainingProgressDocument): TrainingProgressPersistenceResult {
    const validation = validateTrainingProgress(progress)
    if (!validation.valid) {
      return { saved: false, progress: copyTrainingProgress(progress), errors: [...validation.errors] }
    }
    const copied = copyTrainingProgress(progress)
    if (!this.storage) return { saved: false, progress: copied, errors: ['Training progress storage is unavailable.'] }
    try {
      this.storage.setItem(TRAINING_PROGRESS_STORAGE_KEY, JSON.stringify(copied))
      return { saved: true, progress: copied, errors: [] }
    } catch {
      return { saved: false, progress: copied, errors: ['Training progress could not be saved.'] }
    }
  }

  public recordResult(result: TrainingResult, completedAt = new Date().toISOString()): TrainingProgressPersistenceResult {
    const loaded = this.load()
    const progress = recordTrainingResult(loaded.progress, result, completedAt)
    const saved = this.save(progress)
    return {
      ...saved,
      errors: [...loaded.errors, ...saved.errors],
    }
  }

  public clear(): TrainingProgressPersistenceResult {
    const progress = createDefaultTrainingProgress(this.lessonIds)
    if (!this.storage) return { saved: false, progress, errors: ['Training progress storage is unavailable.'] }
    try {
      this.storage.removeItem(TRAINING_PROGRESS_STORAGE_KEY)
      return { saved: true, progress, errors: [] }
    } catch {
      return { saved: false, progress, errors: ['Training progress could not be cleared.'] }
    }
  }
}

export const TrainingProgress = TrainingProgressStore
