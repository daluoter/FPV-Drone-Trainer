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
import { lessonLearningContent } from './catalog'
import { LEARNING_LESSONS } from './lessons'

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
  it('keeps rule-6 L19 records historical while rule-7 gravity-gate progress starts separately', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const baseline = context({ rulesVersion: 4, mode: 'practice' })
    const routes = { ...baseline, rulesVersion: 5 } as const
    const previous = { ...baseline, rulesVersion: 6 } as const
    const revised = { ...baseline, rulesVersion: 7 } as const
    expect(store.recordResult(result({ lessonId: 'takeoff', sessionId: 'takeoff:accepted', attemptContext: baseline })).saved).toBe(true)
    expect(store.recordResult(result({ lessonId: 'wide-gate', sessionId: 'wide-gate:accepted', attemptContext: routes })).saved).toBe(true)
    for (const lessonId of ['full-roll', 'reverse-orbit', 'backward-flight', 'gravity-gate']) {
      expect(store.recordResult(result({ lessonId, sessionId: `${lessonId}:rule-6`, attemptContext: previous,
        completedCheckpoints: 8, totalCheckpoints: 8, metrics: { gravityGatePhase: 8, gravityGateExited: 1 } })).saved).toBe(true)
    }
    const previousKey = trainingAttemptContextKey(previous)
    const revisedKey = trainingAttemptContextKey(revised)
    const originalScopes = [baseline, routes, previous].map((scope) => ({ key: trainingAttemptContextKey(scope),
      raw: storage.getItem(trainingAttemptContextKey(scope)) }))
    const historical = store.load(previous).progress.lessons['gravity-gate']
    const empty = { recent: null, best: null, completed: false, attempts: 0 }
    const current = new TrainingProgressStore(storage).loadCurrent(revised)
    expect(current.errors).toEqual([])
    expect(current.progress.lessons['gravity-gate']).toEqual(empty)
    expect(storage.getItem(revisedKey)).toBeNull()
    for (const lessonId of ['takeoff', 'wide-gate', 'full-roll', 'reverse-orbit', 'backward-flight']) {
      expect(current.progress.lessons[lessonId]).toMatchObject({ completed: true, attempts: 1,
        best: { sessionId: lessonId === 'takeoff' || lessonId === 'wide-gate' ? `${lessonId}:accepted` : `${lessonId}:rule-6` } })
    }
    for (const { key, raw } of originalScopes) expect(storage.getItem(key)).toBe(raw)

    expect(store.recordResult(result({ lessonId: 'gravity-gate', sessionId: 'gravity-gate:rule-7-retry',
      attemptContext: revised, outcome: 'FAILED', score: 0, completedCheckpoints: 4, totalCheckpoints: 8 })).saved).toBe(true)
    expect(store.loadCurrent(revised).progress.lessons['gravity-gate']).toMatchObject({ completed: false, attempts: 1, best: null })
    expect(store.recordResult(result({ lessonId: 'gravity-gate', sessionId: 'gravity-gate:rule-7-passed',
      attemptContext: revised, completedCheckpoints: 8, totalCheckpoints: 8 })).saved).toBe(true)
    const reloaded = new TrainingProgressStore(storage).loadCurrent(revised)
    expect(reloaded.errors).toEqual([])
    expect(reloaded.progress.lessons['gravity-gate']).toMatchObject({ completed: true, attempts: 2,
      best: { sessionId: 'gravity-gate:rule-7-passed' } })
    expect(JSON.parse(storage.getItem(revisedKey)!).context).toEqual(revised)
    expect(new TrainingProgressStore(storage).load(previous).progress.lessons['gravity-gate']).toEqual(historical)
    expect(storage.getItem(previousKey)).toBe(originalScopes[2].raw)
    for (const { key, raw } of originalScopes) expect(storage.getItem(key)).toBe(raw)
    for (const lessonId of ['takeoff', 'wide-gate', 'full-roll', 'reverse-orbit', 'backward-flight']) {
      expect(reloaded.progress.lessons[lessonId]).toEqual(current.progress.lessons[lessonId])
    }
  })

  it('preserves a malformed rule-7 scope without hiding approved lessons or borrowing old L19 completion', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const previous = context({ rulesVersion: 6, mode: 'practice' })
    const revised = { ...previous, rulesVersion: 7 } as const
    for (const lessonId of ['backward-flight', 'gravity-gate']) {
      expect(store.recordResult(result({ lessonId, attemptContext: previous })).saved).toBe(true)
    }
    const previousKey = trainingAttemptContextKey(previous)
    const previousRaw = storage.getItem(previousKey)
    const revisedKey = trainingAttemptContextKey(revised)
    storage.setItem(revisedKey, '{recoverable-rule-7-history')
    const loaded = new TrainingProgressStore(storage).loadCurrent(revised)
    expect(loaded.loaded).toBe(true)
    expect(loaded.errors.join(' ')).toMatch(/Rules 7:.*malformed/)
    expect(loaded.progress.lessons['backward-flight']).toMatchObject({ completed: true, attempts: 1 })
    expect(loaded.progress.lessons['gravity-gate']).toMatchObject({ completed: false, attempts: 0, best: null })
    expect(store.recordResult(result({ lessonId: 'gravity-gate', attemptContext: revised })).saved).toBe(false)
    expect(storage.getItem(revisedKey)).toBe('{recoverable-rule-7-history')
    expect(storage.getItem(previousKey)).toBe(previousRaw)
  })

  it('adds L16 without rewriting accepted L15 or L17 records and keeps result conditions separate', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const scope = context({ rulesVersion: 6, mode: 'practice' })
    for (const lessonId of ['orbit', 'backward-flight']) store.recordResult(result({ lessonId,
      sessionId: `${lessonId}:accepted`, attemptContext: scope }))
    const before = store.loadCurrent(scope).progress.lessons
    const empty = { recent: null, best: null, completed: false, attempts: 0 }
    expect(before['reverse-orbit']).toEqual(empty)
    expect(store.recordResult(result({ lessonId: 'reverse-orbit', sessionId: 'reverse-orbit:retry',
      outcome: 'FAILED', score: 0, completedCheckpoints: 4, totalCheckpoints: 7,
      metrics: { reverseOrbitPhase: 4, reverseOrbitCompletedLaps: 1 }, attemptContext: scope })).saved).toBe(true)
    expect(store.recordResult(result({ lessonId: 'reverse-orbit', sessionId: 'reverse-orbit:passed',
      completedCheckpoints: 7, totalCheckpoints: 7, metrics: { reverseOrbitPhase: 7,
        reverseOrbitCompletedLaps: 3, reverseOrbitProgressDegrees: 1081 }, attemptContext: scope })).saved).toBe(true)
    const loaded = new TrainingProgressStore(storage).loadCurrent(scope)
    expect(loaded.errors).toEqual([])
    expect(loaded.progress.lessons['reverse-orbit']).toMatchObject({ completed: true, attempts: 2,
      best: { sessionId: 'reverse-orbit:passed', totalCheckpoints: 7 } })
    for (const lessonId of ['orbit', 'backward-flight']) expect(loaded.progress.lessons[lessonId]).toEqual(before[lessonId])
    for (const variant of [{ ...scope, mode: 'challenge' as const }, { ...scope, inputSource: 'keyboard' as const }]) {
      expect(store.loadCurrent(variant).progress.lessons['reverse-orbit']).toEqual(empty)
    }
  })

  it('adds L17 independently while retaining accepted L15 and older raw records', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const current = context({ rulesVersion: 6, mode: 'practice' })
    const legacy = { ...current, rulesVersion: 4 } as const
    store.recordResult(result({ lessonId: 'orbit', sessionId: 'orbit:five-laps-accepted', attemptContext: current,
      completedCheckpoints: 9, totalCheckpoints: 9, metrics: { orbitPhase: 9, orbitCompletedLaps: 5 } }))
    store.recordResult(result({ lessonId: 'orbit', sessionId: 'orbit:legacy', attemptContext: legacy }))
    const legacyRaw = storage.getItem(trainingAttemptContextKey(legacy))
    const accepted = store.loadCurrent(current).progress.lessons.orbit
    const empty = { recent: null, best: null, completed: false, attempts: 0 }
    expect(store.loadCurrent(current).progress.lessons['backward-flight']).toEqual(empty)
    expect(store.recordResult(result({ lessonId: 'backward-flight', sessionId: 'backward-flight:retry',
      attemptContext: current, outcome: 'FAILED', score: 0, completedCheckpoints: 4, totalCheckpoints: 7,
      metrics: { backwardPhase: 4 } })).saved).toBe(true)
    expect(store.recordResult(result({ lessonId: 'backward-flight', sessionId: 'backward-flight:passed',
      attemptContext: current, completedCheckpoints: 7, totalCheckpoints: 7,
      metrics: { backwardPhase: 7, backwardDistanceM: 4, backwardHoldSeconds: 0.8 } })).saved).toBe(true)
    const reloaded = new TrainingProgressStore(storage).loadCurrent(current)
    expect(reloaded.errors).toEqual([])
    expect(reloaded.progress.lessons['backward-flight']).toMatchObject({ completed: true, attempts: 2,
      best: { sessionId: 'backward-flight:passed', totalCheckpoints: 7 } })
    expect(reloaded.progress.lessons.orbit).toEqual(accepted)
    expect(storage.getItem(trainingAttemptContextKey(legacy))).toBe(legacyRaw)
    for (const variant of [{ ...current, mode: 'challenge' as const }, { ...current, inputSource: 'keyboard' as const }]) {
      expect(store.loadCurrent(variant).progress.lessons['backward-flight']).toEqual(empty)
    }
  })

  it('preserves rule-4 orbit history while saving the new nine-step ground course separately', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const previous = context({ rulesVersion: 4, mode: 'practice' })
    const current = { ...previous, rulesVersion: 6 } as const
    expect(store.recordResult(result({ lessonId: 'orbit', sessionId: 'orbit:prototype', attemptContext: previous,
      completedCheckpoints: 3, totalCheckpoints: 3, metrics: { orbitProgress: Math.PI * 2 } })).saved).toBe(true)
    for (const lessonId of ['power-loop', 'split-s']) expect(store.recordResult(result({ lessonId,
      sessionId: `${lessonId}:accepted`, attemptContext: current, completedCheckpoints: 8, totalCheckpoints: 8 })).saved).toBe(true)
    const oldKey = trainingAttemptContextKey(previous)
    const oldRaw = storage.getItem(oldKey)
    const empty = { recent: null, best: null, completed: false, attempts: 0 }
    expect(store.loadCurrent(current).progress.lessons.orbit).toEqual(empty)
    expect(store.load(previous).progress.lessons.orbit).toMatchObject({ completed: true, attempts: 1,
      best: { sessionId: 'orbit:prototype', totalCheckpoints: 3 } })
    expect(storage.getItem(oldKey)).toBe(oldRaw)
    expect(store.recordResult(result({ lessonId: 'orbit', sessionId: 'orbit:retry', attemptContext: current,
      outcome: 'FAILED', score: 0, completedCheckpoints: 4, totalCheckpoints: 9, metrics: { orbitPhase: 4 } })).saved).toBe(true)
    expect(store.loadCurrent(current).progress.lessons.orbit).toMatchObject({ completed: false, attempts: 1, best: null })
    expect(store.recordResult(result({ lessonId: 'orbit', sessionId: 'orbit:ground-complete', attemptContext: current,
      completedCheckpoints: 9, totalCheckpoints: 9, metrics: { orbitPhase: 9, orbitProgressDegrees: 1805, orbitCompletedLaps: 5 } })).saved).toBe(true)
    const reloaded = new TrainingProgressStore(storage).loadCurrent(current)
    expect(reloaded.errors).toEqual([])
    expect(reloaded.progress.lessons.orbit).toMatchObject({ completed: true, attempts: 2,
      best: { sessionId: 'orbit:ground-complete', totalCheckpoints: 9 } })
    for (const lessonId of ['power-loop', 'split-s']) expect(reloaded.progress.lessons[lessonId]).toMatchObject({
      completed: true, attempts: 1, best: { sessionId: `${lessonId}:accepted` } })
    expect(storage.getItem(oldKey)).toBe(oldRaw)
    for (const variant of [{ ...current, mode: 'challenge' as const }, { ...current, inputSource: 'keyboard' as const }]) {
      expect(store.loadCurrent(variant).progress.lessons.orbit).toEqual(empty)
    }
  })

  it('keeps airborne split-s rule-4 history separate from the ground-start rule-6 course', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const previous = context({ rulesVersion: 4, mode: 'practice' })
    const current = { ...previous, rulesVersion: 6 } as const
    expect(store.recordResult(result({ lessonId: 'split-s', sessionId: 'split-s:airborne-prototype',
      attemptContext: previous, completedCheckpoints: 5, totalCheckpoints: 5,
      metrics: { entryAltitudeM: 25, headingChangeDegrees: 180 } })).saved).toBe(true)
    expect(store.recordResult(result({ lessonId: 'orbit', sessionId: 'orbit:historical', attemptContext: previous })).saved).toBe(true)
    const previousKey = trainingAttemptContextKey(previous)
    const previousRaw = storage.getItem(previousKey)
    const empty = { recent: null, best: null, completed: false, attempts: 0 }
    expect(new TrainingProgressStore(storage).loadCurrent(current).progress.lessons['split-s']).toEqual(empty)
    expect(new TrainingProgressStore(storage).load(previous).progress.lessons['split-s']).toMatchObject({
      completed: true, attempts: 1, best: { sessionId: 'split-s:airborne-prototype', totalCheckpoints: 5 },
    })
    expect(storage.getItem(previousKey)).toBe(previousRaw)
    expect(store.recordResult(result({ lessonId: 'split-s', sessionId: 'split-s:new-retry', attemptContext: current,
      outcome: 'FAILED', score: 0, completedCheckpoints: 4, totalCheckpoints: 8, metrics: { splitPhase: 4 } })).saved).toBe(true)
    expect(new TrainingProgressStore(storage).loadCurrent(current).progress.lessons['split-s']).toMatchObject({
      completed: false, attempts: 1, best: null, recent: { sessionId: 'split-s:new-retry', totalCheckpoints: 8 },
    })
    expect(store.recordResult(result({ lessonId: 'split-s', sessionId: 'split-s:ground-start-complete', attemptContext: current,
      completedCheckpoints: 8, totalCheckpoints: 8, metrics: { splitPhase: 8, splitHeightLossM: 12, splitHeadingChangeDegrees: 180 } })).saved).toBe(true)
    const reloaded = new TrainingProgressStore(storage).loadCurrent(current)
    expect(reloaded.errors).toEqual([])
    expect(reloaded.progress.lessons['split-s']).toMatchObject({ completed: true, attempts: 2,
      best: { sessionId: 'split-s:ground-start-complete', totalCheckpoints: 8, metrics: { splitPhase: 8 } } })
    expect(reloaded.progress.lessons.orbit).toEqual(empty)
    expect(store.load(previous).progress.lessons.orbit).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'orbit:historical' } })
    expect(reloaded.progress.lessons['power-loop']).toEqual(empty)
    expect(storage.getItem(previousKey)).toBe(previousRaw)
    for (const variant of [{ ...current, mode: 'challenge' as const }, { ...current, inputSource: 'keyboard' as const }]) {
      expect(new TrainingProgressStore(storage).loadCurrent(variant).progress.lessons['split-s']).toEqual(empty)
    }
  })

  it('adds an independent L13 record without crediting old L13 orbit or L12 back flips', () => {
    const storage = new MemoryStorage()
    const scope = context({ rulesVersion: 6, mode: 'practice' })
    const store = new TrainingProgressStore(storage)
    for (const lessonId of ['orbit', 'back-flip']) {
      expect(store.recordResult(result({ lessonId, sessionId: `${lessonId}:historical`, attemptContext: scope })).saved).toBe(true)
    }
    const key = trainingAttemptContextKey(scope)
    const envelope = JSON.parse(storage.getItem(key)!)
    delete envelope.progress.lessons['power-loop']
    const oldRaw = JSON.stringify(envelope)
    storage.setItem(key, oldRaw)
    const loaded = new TrainingProgressStore(storage).loadCurrent(scope)
    expect(loaded.errors).toEqual([])
    expect(loaded.progress.lessons['power-loop']).toEqual({ recent: null, best: null, completed: false, attempts: 0 })
    expect(storage.getItem(key)).toBe(oldRaw)
    expect(store.recordResult(result({ lessonId: 'power-loop', sessionId: 'loop:complete', attemptContext: scope,
      completedCheckpoints: 8, totalCheckpoints: 8, metrics: { loopPhase: 8, loopHeightGainM: 12, loopForwardSpanM: 18 } })).saved).toBe(true)
    const reloaded = new TrainingProgressStore(storage).loadCurrent(scope)
    expect(reloaded.progress.lessons['power-loop']).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'loop:complete', totalCheckpoints: 8 } })
    for (const lessonId of ['orbit', 'back-flip']) expect(reloaded.progress.lessons[lessonId]).toEqual(loaded.progress.lessons[lessonId])
    expect(new TrainingProgressStore(storage).loadCurrent({ ...scope, inputSource: 'keyboard' }).progress.lessons['power-loop'].completed).toBe(false)
    expect(new TrainingProgressStore(storage).loadCurrent({ ...scope, mode: 'challenge' }).progress.lessons['power-loop'].completed).toBe(false)
  })

  it('keeps stable-ID progress and raw scopes intact after merging hover into L01 and renumbering courses', () => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const baseline = context({ rulesVersion: 4, mode: 'practice' })
    const recovery = { ...baseline, rulesVersion: 6 } as const
    expect(store.recordResult(result({ lessonId: 'hover', sessionId: 'old-hover:passed', attemptContext: baseline })).saved).toBe(true)
    expect(store.loadCurrent(baseline).progress.lessons.takeoff).toMatchObject({ completed: false, attempts: 0, best: null })

    for (const attempt of [
      result({ lessonId: 'takeoff', sessionId: 'takeoff:retry', outcome: 'FAILED', attemptContext: baseline }),
      result({ lessonId: 'takeoff', sessionId: 'takeoff:hover-passed', attemptContext: baseline }),
      result({ lessonId: 'straight-line', sessionId: 'old-L03:passed', attemptContext: baseline, completedCheckpoints: 5, totalCheckpoints: 5 }),
      result({ lessonId: 'split-s', sessionId: 'old-L12:passed', attemptContext: baseline, completedCheckpoints: 5, totalCheckpoints: 5 }),
      result({ lessonId: 'orbit', sessionId: 'old-L13:passed', attemptContext: baseline, completedCheckpoints: 3, totalCheckpoints: 3 }),
      result({ lessonId: 'basic-recovery', sessionId: 'old-L10:passed', attemptContext: recovery, completedCheckpoints: 8, totalCheckpoints: 8 }),
    ]) {
      expect(store.recordResult(attempt, '2026-10-23T15:00:00.000Z').saved).toBe(true)
    }
    const keys = [trainingAttemptContextKey(baseline), trainingAttemptContextKey(recovery)]
    const original = keys.map((key) => storage.getItem(key))
    const loaded = new TrainingProgressStore(storage).loadCurrent(recovery)
    expect(loaded.errors).toEqual([])
    expect(loaded.progress.lessons.hover).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'old-hover:passed' } })
    expect(loaded.progress.lessons.takeoff).toMatchObject({ completed: true, attempts: 2, best: { sessionId: 'takeoff:hover-passed' } })
    expect(loaded.progress.lessons['straight-line']).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'old-L03:passed', totalCheckpoints: 5 } })
    expect(loaded.progress.lessons['basic-recovery']).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'old-L10:passed', totalCheckpoints: 8 } })

    const active = LEARNING_LESSONS.map(({ id }) => ({ id, code: lessonLearningContent(id)?.code, progress: loaded.progress.lessons[id] }))
    expect(active).toHaveLength(18)
    expect(active.some(({ id }) => id === 'hover')).toBe(false)
    expect(active.some(({ id }) => id === 'full-flip')).toBe(false)
    expect(active.find(({ id }) => id === 'takeoff')).toMatchObject({ code: 'L01', progress: { completed: true, attempts: 2 } })
    expect(active.find(({ id }) => id === 'straight-line')).toMatchObject({ code: 'L02', progress: { best: { sessionId: 'old-L03:passed' } } })
    expect(active.find(({ id }) => id === 'basic-recovery')).toMatchObject({ code: 'L09', progress: { best: { sessionId: 'old-L10:passed' } } })
    expect(active.find(({ id }) => id === 'split-s')).toMatchObject({ code: 'L14', progress: { completed: false, attempts: 0, best: null } })
    expect(store.load(baseline).progress.lessons['split-s']).toMatchObject({ completed: true, best: { sessionId: 'old-L12:passed' } })
    expect(active.find(({ id }) => id === 'orbit')).toMatchObject({ code: 'L15', progress: { completed: false, attempts: 0, best: null } })
    expect(store.load(baseline).progress.lessons.orbit).toMatchObject({ completed: true, best: { sessionId: 'old-L13:passed' } })
    expect(loaded.progress.lessons['full-roll']).toMatchObject({ completed: false, attempts: 0, best: null })
    expect(keys.map((key) => storage.getItem(key))).toEqual(original)
    const keyboard = new TrainingProgressStore(storage).loadCurrent({ ...recovery, inputSource: 'keyboard' })
    for (const id of ['hover', 'takeoff', 'straight-line', 'basic-recovery']) {
      expect(keyboard.progress.lessons[id]).toMatchObject({ completed: false, attempts: 0, best: null })
    }
    expect(keys.map((key) => storage.getItem(key))).toEqual(original)
    const recordedRoll = store.recordResult(result({ lessonId: 'full-roll', sessionId: 'full-roll:passed',
      attemptContext: recovery, completedCheckpoints: 6, totalCheckpoints: 6 }))
    expect(recordedRoll.saved).toBe(true)
    const withRoll = new TrainingProgressStore(storage).loadCurrent(recovery)
    expect(withRoll.progress.lessons['full-roll']).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'full-roll:passed' } })
    for (const id of ['hover', 'takeoff', 'straight-line', 'basic-recovery']) {
      expect(withRoll.progress.lessons[id]).toEqual(loaded.progress.lessons[id])
    }
    expect(storage.getItem(keys[0])).toBe(original[0])
    expect(store.recordResult(result({ lessonId: 'full-flip', sessionId: 'full-flip:passed',
      attemptContext: recovery, completedCheckpoints: 6, totalCheckpoints: 6 })).saved).toBe(true)
    const withFlip = new TrainingProgressStore(storage).loadCurrent(recovery)
    expect(withFlip.progress.lessons['full-flip']).toMatchObject({ completed: true, attempts: 1, best: { sessionId: 'full-flip:passed' } })
    for (const id of ['front-flip', 'back-flip']) {
      expect(withFlip.progress.lessons[id]).toEqual({ recent: null, best: null, completed: false, attempts: 0 })
    }
    for (const id of ['hover', 'takeoff', 'straight-line', 'basic-recovery', 'full-roll', 'split-s', 'orbit']) {
      expect(withFlip.progress.lessons[id]).toEqual(withRoll.progress.lessons[id])
    }
    expect(storage.getItem(keys[0])).toBe(original[0])
  })

  it.each([1, -1])('keeps a legacy combined-flip result with direction %s historical while saving the split courses independently', (legacyDirection) => {
    const storage = new MemoryStorage()
    const store = new TrainingProgressStore(storage)
    const scope = context({ rulesVersion: 6, mode: 'practice' })
    const baseline = { ...scope, rulesVersion: 4 } as const
    expect(store.recordResult(result({ lessonId: 'full-flip', sessionId: 'combined-flip:accepted',
      attemptContext: scope, completedCheckpoints: 6, totalCheckpoints: 6,
      metrics: { flipDirection: legacyDirection, flipProgressDegrees: 360, flipPhase: 6 } })).saved).toBe(true)
    expect(store.recordResult(result({ lessonId: 'full-roll', sessionId: 'roll:accepted',
      attemptContext: scope, completedCheckpoints: 6, totalCheckpoints: 6 })).saved).toBe(true)
    expect(store.recordResult(result({ lessonId: 'orbit', sessionId: 'orbit:accepted',
      attemptContext: baseline })).saved).toBe(true)
    const key = trainingAttemptContextKey(scope)
    // Emulate an actual older document which predates the two directional IDs.
    const oldEnvelope = JSON.parse(storage.getItem(key)!)
    delete oldEnvelope.progress.lessons['front-flip']
    delete oldEnvelope.progress.lessons['back-flip']
    const oldRaw = JSON.stringify(oldEnvelope)
    storage.setItem(key, oldRaw)
    const baselineRaw = storage.getItem(trainingAttemptContextKey(baseline))
    const historical = new TrainingProgressStore(storage).loadCurrent(scope)
    expect(historical.errors).toEqual([])
    expect(historical.progress.lessons['full-flip']).toMatchObject({ completed: true, attempts: 1,
      best: { sessionId: 'combined-flip:accepted', metrics: { flipDirection: legacyDirection } } })
    for (const id of ['front-flip', 'back-flip']) {
      expect(historical.progress.lessons[id]).toEqual({ recent: null, best: null, completed: false, attempts: 0 })
    }
    expect(storage.getItem(key)).toBe(oldRaw)
    expect(storage.getItem(trainingAttemptContextKey(baseline))).toBe(baselineRaw)

    expect(store.recordResult(result({ lessonId: 'front-flip', sessionId: 'front-flip:passed',
      attemptContext: scope, completedCheckpoints: 6, totalCheckpoints: 6,
      metrics: { flipDirection: 1, flipRequiredDirection: 1, flipProgressDegrees: 360 } })).saved).toBe(true)
    const afterFront = new TrainingProgressStore(storage).loadCurrent(scope).progress
    expect(afterFront.lessons['front-flip']).toMatchObject({ completed: true, attempts: 1,
      best: { sessionId: 'front-flip:passed', metrics: { flipDirection: 1 } } })
    expect(afterFront.lessons['back-flip']).toEqual({ recent: null, best: null, completed: false, attempts: 0 })

    expect(store.recordResult(result({ lessonId: 'back-flip', sessionId: 'back-flip:retry',
      attemptContext: scope, outcome: 'FAILED', score: 0, completedCheckpoints: 3, totalCheckpoints: 6 })).saved).toBe(true)
    const afterRetry = new TrainingProgressStore(storage).loadCurrent(scope).progress
    expect(afterRetry.lessons['back-flip']).toMatchObject({ completed: false, attempts: 1, best: null,
      recent: { sessionId: 'back-flip:retry', outcome: 'FAILED' } })
    expect(afterRetry.lessons['front-flip']).toEqual(afterFront.lessons['front-flip'])

    expect(store.recordResult(result({ lessonId: 'back-flip', sessionId: 'back-flip:passed',
      attemptContext: scope, completedCheckpoints: 6, totalCheckpoints: 6,
      metrics: { flipDirection: -1, flipRequiredDirection: -1, flipProgressDegrees: 360 } })).saved).toBe(true)
    const afterBoth = new TrainingProgressStore(storage).loadCurrent(scope).progress
    expect(afterBoth.lessons['back-flip']).toMatchObject({ completed: true, attempts: 2,
      best: { sessionId: 'back-flip:passed', metrics: { flipDirection: -1 } } })
    expect(afterBoth.lessons['front-flip']).toEqual(afterFront.lessons['front-flip'])
    for (const id of ['full-flip', 'full-roll', 'orbit']) {
      expect(afterBoth.lessons[id]).toEqual(historical.progress.lessons[id])
    }
    const savedScope = storage.getItem(key)
    for (const variant of [{ ...scope, mode: 'challenge' as const }, { ...scope, inputSource: 'keyboard' as const }]) {
      const isolated = new TrainingProgressStore(storage).loadCurrent(variant)
      for (const id of ['front-flip', 'back-flip', 'full-flip']) {
        expect(isolated.progress.lessons[id]).toEqual({ recent: null, best: null, completed: false, attempts: 0 })
      }
    }
    expect(storage.getItem(key)).toBe(savedScope)
    expect(storage.getItem(trainingAttemptContextKey(baseline))).toBe(baselineRaw)
  })

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
    const invalid = { ...source, rulesVersion: 8 } as unknown as TrainingAttemptContext
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
    expect(afterL09.lessons['basic-recovery']).toMatchObject({ completed: false, attempts: 0 })
    expect(store.recordResult(result({
      lessonId: 'basic-recovery', sessionId: 'basic-recovery:original', attemptContext: revised,
      completedCheckpoints: 8, totalCheckpoints: 8,
    })).saved).toBe(true)
    const originalL10Scope = storage.getItem(trainingAttemptContextKey(revised))
    expect(store.loadCurrent(revised).progress.lessons['basic-recovery']).toMatchObject({ completed: false, attempts: 0 })
    expect(store.recordResult(result({
      lessonId: 'basic-recovery', sessionId: 'basic-recovery:new', attemptContext: { ...revised, rulesVersion: 6 },
      completedCheckpoints: 8, totalCheckpoints: 8, metrics: { exercisesCompleted: 3 },
    })).saved).toBe(true)
    const afterL10 = new TrainingProgressStore(storage).loadCurrent(revised).progress
    expect(afterL10.lessons['basic-recovery']).toMatchObject({ completed: true, attempts: 1 })
    expect(store.load(revised).progress.lessons['basic-recovery']?.best?.sessionId).toBe('basic-recovery:original')
    expect(storage.getItem(trainingAttemptContextKey(revised))).toBe(originalL10Scope)
    for (const lessonId of ['straight-line', 'landing', 'direction-control', 'coordinated-turn', 'square-route', 'figure-eight', 'wide-gate']) {
      expect(afterL10.lessons[lessonId]).toEqual(afterL09.lessons[lessonId])
    }
    expect(storage.getItem(trainingAttemptContextKey(baseline))).toBe(originalBaseline)
  })

  it('keeps all current rule scopes isolated by mode, preset, input and settings', () => {
    const store = new TrainingProgressStore(new MemoryStorage())
    const baseline = context({ rulesVersion: 4, mode: 'practice' })
    store.recordResult(result({ lessonId: 'direction-control', attemptContext: baseline }))
    store.recordResult(result({ lessonId: 'coordinated-turn', attemptContext: { ...baseline, rulesVersion: 5 } }))
    store.recordResult(result({ lessonId: 'basic-recovery', attemptContext: { ...baseline, rulesVersion: 6 } }))
    store.recordResult(result({ lessonId: 'gravity-gate', attemptContext: { ...baseline, rulesVersion: 7 } }))
    for (const variation of [
      { mode: 'challenge' as const },
      { presetId: 'standard' as const },
      { inputSource: 'keyboard' as const },
      { settingsFingerprint: fingerprintTrainingSettings({ rates: 500 }) },
    ]) {
      const loaded = store.loadCurrent({ ...baseline, ...variation })
      expect(loaded.progress.lessons['direction-control']?.completed).toBe(false)
      expect(loaded.progress.lessons['coordinated-turn']?.completed).toBe(false)
      expect(loaded.progress.lessons['basic-recovery']?.completed).toBe(false)
      expect(loaded.progress.lessons['gravity-gate']?.completed).toBe(false)
      expect(loaded.errors).toEqual([])
    }
  })

  it.each([null, '{broken-json'])('retains a healthy current scope when the other scope is missing or corrupt (%s)', (damaged) => {
    for (const healthyVersion of [4, 5, 6, 7] as const) {
      const storage = new MemoryStorage()
      const store = new TrainingProgressStore(storage)
      const healthy = context({ rulesVersion: healthyVersion })
      const other = context({ rulesVersion: healthyVersion === 4 ? 5 : 4 })
      const healthyLessonId = { 4: 'direction-control', 5: 'coordinated-turn', 6: 'basic-recovery', 7: 'gravity-gate' }[healthyVersion]
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
