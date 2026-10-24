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
  it('resumes a retired hover selection at merged L01 without changing stored preferences or flight history', () => {
    for (const mode of ['practice', 'challenge'] as const) {
      const original = JSON.stringify({ ...DEFAULT_LEARNING_PREFERENCES, introCompleted: true, lastLessonId: 'hover', mode })
      const target = memory(original)
      const scoreKey = 'fpv-drone-trainer.training-progress.v1'
      const historicalScores = '{"lessons":{"hover":{"attempts":3},"takeoff":{"attempts":2}}}'
      target.setItem(scoreKey, historicalScores)
      expect(loadLearningPreferences(target)).toEqual({
        loaded: true, error: null,
        preferences: { ...DEFAULT_LEARNING_PREFERENCES, introCompleted: true, lastLessonId: 'takeoff', mode },
      })
      expect(target.getItem(LEARNING_PREFERENCES_KEY)).toBe(original)
      expect(target.getItem(scoreKey)).toBe(historicalScores)
    }
  })
  it('canonicalizes a retired selection on an explicit save while preserving mode and knowledge completion', () => {
    const target = memory()
    const retired = { ...DEFAULT_LEARNING_PREFERENCES, lastLessonId: 'hover', introCompleted: true, mode: 'challenge' as const }
    expect(saveLearningPreferences(retired, target)).toEqual({ saved: true, error: null })
    expect(JSON.parse(target.getItem(LEARNING_PREFERENCES_KEY)!)).toEqual({ ...retired, lastLessonId: 'takeoff' })
    expect(loadLearningPreferences(target).preferences).toEqual({ ...retired, lastLessonId: 'takeoff' })
    expect(target.getItem('fpv-drone-trainer.training-progress.v1')).toBeNull()
  })
  it('reports inaccessible storage without throwing or disabling practice', () => {
    const target = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => undefined }
    expect(saveLearningPreferences(DEFAULT_LEARNING_PREFERENCES, target).saved).toBe(false)
    expect(loadLearningPreferences(null).preferences.mode).toBe('practice')
  })
})
