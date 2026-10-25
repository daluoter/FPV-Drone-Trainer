import type { TrainingStorageLike } from './types'

export const LEARNING_PREFERENCES_KEY = 'fpv-drone-trainer.learning.v1'
export interface LearningPreferences {
  readonly schemaVersion: 1
  readonly introCompleted: boolean
  readonly lastLessonId: string
  readonly mode: 'practice' | 'challenge'
}
export const DEFAULT_LEARNING_PREFERENCES: LearningPreferences = {
  schemaVersion: 1, introCompleted: false, lastLessonId: 'takeoff', mode: 'practice',
}
function storage(): TrainingStorageLike | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}
function valid(value: unknown): value is LearningPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return entry.schemaVersion === 1 && typeof entry.introCompleted === 'boolean'
    && typeof entry.lastLessonId === 'string' && /^[a-z][a-z-]{0,63}$/.test(entry.lastLessonId)
    && (entry.mode === 'practice' || entry.mode === 'challenge')
}
/** Retired navigation aliases never rewrite a historical flight result. */
function currentLessonId(lessonId: string): string {
  if (lessonId === 'hover') return 'takeoff'
  if (lessonId === 'full-flip') return 'front-flip'
  return lessonId
}
export function loadLearningPreferences(target = storage()): { preferences: LearningPreferences; loaded: boolean; error: string | null } {
  const fallback = { ...DEFAULT_LEARNING_PREFERENCES }
  if (!target) return { preferences: fallback, loaded: false, error: '無法使用本機學習紀錄；本次仍可練習。' }
  try {
    const raw = target.getItem(LEARNING_PREFERENCES_KEY)
    if (raw === null) return { preferences: fallback, loaded: false, error: null }
    const parsed: unknown = JSON.parse(raw)
    if (!valid(parsed)) return { preferences: fallback, loaded: false, error: '學習偏好暫時無法讀取，原始資料仍保留。' }
    return { preferences: { schemaVersion: 1, introCompleted: parsed.introCompleted, lastLessonId: currentLessonId(parsed.lastLessonId), mode: parsed.mode }, loaded: true, error: null }
  } catch { return { preferences: fallback, loaded: false, error: '學習偏好讀取失敗，原始資料仍保留。' } }
}
export function saveLearningPreferences(preferences: LearningPreferences, target = storage()): { saved: boolean; error: string | null } {
  if (!valid(preferences)) return { saved: false, error: '學習偏好格式不正確。' }
  const existing = loadLearningPreferences(target)
  if (existing.error) return { saved: false, error: existing.error }
  try {
    if (!target) return { saved: false, error: '本次學習偏好未能保存。' }
    target.setItem(LEARNING_PREFERENCES_KEY, JSON.stringify({ ...preferences, lastLessonId: currentLessonId(preferences.lastLessonId) }))
    return { saved: true, error: null }
  } catch { return { saved: false, error: '本次學習偏好未能保存；可繼續練習。' } }
}
