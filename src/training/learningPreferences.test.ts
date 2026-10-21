import { describe, expect, it } from 'vitest'
import { DEFAULT_LEARNING_PREFERENCES, LEARNING_PREFERENCES_KEY, loadLearningPreferences, saveLearningPreferences } from './learningPreferences'
function memory(initial?: string) {
  const values = new Map<string, string>(initial ? [[LEARNING_PREFERENCES_KEY, initial]] : [])
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
describe('local learning preferences', () => {
  it('resumes the lesson and mode while keeping knowledge separate from flight scores', () => {
    const target = memory()
    const next = { ...DEFAULT_LEARNING_PREFERENCES, introCompleted: true, lastLessonId: 'landing', mode: 'challenge' as const }
    expect(saveLearningPreferences(next, target).saved).toBe(true)
    expect(loadLearningPreferences(target)).toEqual({ loaded: true, error: null, preferences: next })
    expect(target.getItem('fpv-drone-trainer.training-progress.v1')).toBeNull()
  })
  it('preserves corrupted or future-version preferences instead of overwriting', () => {
    for (const original of ['{broken', JSON.stringify({ ...DEFAULT_LEARNING_PREFERENCES, schemaVersion: 2 })]) {
      const target = memory(original)
      expect(loadLearningPreferences(target).loaded).toBe(false)
      expect(saveLearningPreferences(DEFAULT_LEARNING_PREFERENCES, target).saved).toBe(false)
      expect(target.getItem(LEARNING_PREFERENCES_KEY)).toBe(original)
    }
  })
  it('reports inaccessible storage without throwing or disabling practice', () => {
    const target = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => undefined }
    expect(saveLearningPreferences(DEFAULT_LEARNING_PREFERENCES, target).saved).toBe(false)
    expect(loadLearningPreferences(null).preferences.mode).toBe('practice')
  })
})
