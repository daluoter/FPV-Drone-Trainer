import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import type { NormalizedRcInput } from '../flight-controller'
import { createTrainingMachineState, reduceTrainingState, TrainingSession } from './machine'
import { TRAINING_TRAJECTORY_MAX_POINTS } from './trajectory'
import type { LessonDefinition, TrainingSample, TrainingSceneReference } from './types'

const input: NormalizedRcInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 }

const testLesson: LessonDefinition = {
  id: 'test-lesson',
  priority: 1,
  title: 'Test lesson',
  description: 'A deterministic evaluator fixture.',
  availability: 'available',
  available: true,
  objectives: ['Hold the fixture state.'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['takeoff-pad'] },
  checkpoints: [{ id: 'hold', title: 'Hold', description: 'Hold the state.' }],
  success: { title: 'Passed', description: 'Passed.', criteria: ['Evaluator says success.'] },
  failure: { title: 'Failed', description: 'Failed.', criteria: ['Evaluator says failure.'] },
  scoring: {
    maxScore: 100,
    minimumPassingScore: 70,
    minimumActiveSeconds: 0.5,
    metricLabels: ['elapsedSeconds'],
  },
  hints: ['Use small corrections.'],
  evaluator: {
    evaluate: (_sample, context) => ({
      status: context.trajectory.length >= 2 ? 'success' : 'continue',
      checkpointIds: context.trajectory.length >= 2 ? ['hold'] : [],
      score: 92,
      metrics: { samples: context.trajectory.length },
    }),
  },
}

function sample(timestampSeconds: number): TrainingSample {
  return {
    timestampSeconds,
    state: createInitialDroneState(DEFAULT_DRONE_CONFIG),
    normalizedInput: input,
    armed: true,
  }
}

function indexedSample(timestampSeconds: number, stepIndex: number): TrainingSample {
  const base = sample(timestampSeconds)
  return {
    ...base,
    state: { ...base.state, stepIndex },
    armed: true,
  }
}

describe('training state machine', () => {
  it('ignores runtime samples while idle or after a terminal result', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 0 })
    const ready = session.getState()
    expect(session.consumeSample(sample(1))).toBe(ready)
    expect(session.getState().lastError).toBeNull()

    session.start(0)
    session.tick(0)
    session.consumeSample(sample(1))
    session.consumeSample(sample(2))
    const success = session.getState()
    expect(success.phase).toBe('SUCCESS')
    expect(session.consumeSample(sample(3))).toBe(success)
  })

  it('allows the explicit first arm at the countdown boundary without evaluating disarmed state', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 2 })
    session.start(0)
    expect(session.tick(2).phase).toBe('WAITING_FOR_ARM')
    const disarmed = session.consumeSample({ ...sample(2.1), armed: false })
    expect(disarmed.phase).toBe('WAITING_FOR_ARM')
    expect(disarmed.activeStartedAtSeconds).toBeNull()
    expect(disarmed.sampleCount).toBe(0)
    expect(session.consumeSample({ ...sample(2.2), armed: true }).phase).toBe('ACTIVE')
    expect(session.consumeSample({ ...sample(2.7), armed: true }).phase).toBe('SUCCESS')
  })

  it('fails an ACTIVE attempt immediately on a latched crash without scoring the crash sample', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 0 })
    session.start(0)
    session.tick(0)
    session.consumeSample(sample(0.05))
    const source = sample(0.1)
    const crashedState = { ...source.state, crashed: true }
    const result = session.consumeSample({ ...source, state: crashedState, armed: false })

    expect(result.phase).toBe('FAILED')
    expect(result.result?.outcome).toBe('FAILED')
    expect(result.result?.message).toMatch(/crashed/i)
    expect(result.sampleCount).toBe(1)
    expect(source.state.crashed).toBe(false)
    expect(crashedState.crashed).toBe(true)
  })

  it('guards countdown timing and only evaluates ACTIVE samples', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 2 })
    expect(session.getState().phase).toBe('READY')
    expect(session.start(0).phase).toBe('COUNTDOWN')
    expect(session.consumeSample({ ...sample(1), armed: false }).phase).toBe('COUNTDOWN')
    expect(session.getState().sampleCount).toBe(0)
    expect(session.tick(2).phase).toBe('WAITING_FOR_ARM')
    expect(session.consumeSample(sample(2)).phase).toBe('ACTIVE')
    expect(session.consumeSample(sample(2.5)).phase).toBe('SUCCESS')
    expect(session.getState().result?.score).toBe(92)
    expect(session.showResult().phase).toBe('RESULT')
  })

  it('rejects backwards and duplicate timestamps without changing the trajectory', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 0 })
    session.start(0)
    session.tick(0)
    expect(session.getState().phase).toBe('WAITING_FOR_ARM')
    session.consumeSample(sample(1))
    const before = session.getState()
    const after = session.consumeSample(sample(0.5))
    expect(after.phase).toBe('ACTIVE')
    expect(after.trajectory).toHaveLength(1)
    expect(after.lastError).toMatch(/increase|monotonic|before ACTIVE/i)
    expect(after.sampleCount).toBe(before.sampleCount)
    const duplicate = session.consumeSample(sample(1))
    expect(duplicate.sampleCount).toBe(before.sampleCount)
    expect(duplicate.lastError).toMatch(/increase/i)
  })

  it('starts the active clock at the first explicit arm after a sixty-second wait', () => {
    const elapsed: number[] = []
    const lesson: LessonDefinition = {
      ...testLesson,
      evaluator: (_source, context) => {
        elapsed.push(context.elapsedSeconds)
        return { status: 'success', score: 92 }
      },
    }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 2 })
    session.start(0)
    session.consumeSample({ ...sample(2), armed: false })
    expect(session.tick(62).phase).toBe('WAITING_FOR_ARM')
    expect(session.getState().sampleCount).toBe(0)
    expect(session.getState().activeStartedAtSeconds).toBeNull()
    const first = session.consumeSample(sample(62))
    expect(first.phase).toBe('ACTIVE')
    expect(first.activeStartedAtSeconds).toBe(62)
    expect(elapsed).toEqual([0])
    const completed = session.consumeSample(sample(63))
    expect(completed.phase).toBe('SUCCESS')
    expect(elapsed).toEqual([0, 1])
    expect(completed.result?.elapsedSeconds).toBe(1)
    expect(completed.result?.startedAtSeconds).toBe(62)
  })

  it('never evaluates countdown or invalid/unarmed waiting samples or charges them to the attempt', () => {
    const evaluate = vi.fn(() => ({ status: 'continue' as const }))
    const lesson: LessonDefinition = { ...testLesson, evaluator: evaluate }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 2 })
    session.start(0)
    session.consumeSample({ ...sample(1), armed: false })
    const invalid = sample(3)
    session.consumeSample({ ...invalid, state: { ...invalid.state, positionM: { x: Number.NaN, y: 0, z: 0 } } })
    expect(session.getState().phase).toBe('COUNTDOWN')
    expect(session.getState().lastTimestampSeconds).toBe(1)
    session.consumeSample({ ...sample(2), armed: false })
    session.consumeSample({ ...sample(3), armed: undefined })
    session.consumeSample({ ...sample(4), armed: false })
    const crashed = sample(5)
    session.consumeSample({ ...crashed, armed: false, state: { ...crashed.state, crashed: true } })
    expect(session.getState().phase).toBe('WAITING_FOR_ARM')
    expect(session.getState().activeStartedAtSeconds).toBeNull()
    expect(session.getState().sampleCount).toBe(0)
    expect(session.getState().trajectory).toHaveLength(0)
    expect(session.getState().result).toBeNull()
    expect(evaluate).not.toHaveBeenCalled()

    session.retry()
    session.start(0)
    session.tick(2)
    session.consumeSample(sample(6))
    expect(evaluate).toHaveBeenCalledTimes(1)
    session.consumeSample({ ...sample(7), armed: undefined })
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(session.getState().sampleCount).toBe(1)
    session.consumeSample({ ...sample(8), armed: false })
    expect(session.getState().phase).toBe('FAILED')
    expect(session.getState().sampleCount).toBe(1)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh disarm and arm after early countdown arm telemetry', () => {
    const evaluate = vi.fn(() => ({ status: 'continue' as const }))
    const lesson: LessonDefinition = { ...testLesson, evaluator: evaluate }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 2 })
    session.start(0)
    session.consumeSample(sample(1))
    expect(session.getState().requiresDisarmBeforeArm).toBe(true)
    const boundary = session.consumeSample(sample(2))
    expect(boundary.phase).toBe('WAITING_FOR_ARM')
    expect(boundary.activeStartedAtSeconds).toBeNull()
    expect(session.consumeSample(sample(3)).phase).toBe('WAITING_FOR_ARM')
    expect(session.getState().lastError).toMatch(/disarm/i)
    expect(evaluate).not.toHaveBeenCalled()
    session.consumeSample({ ...sample(4), armed: false })
    const armed = session.consumeSample(sample(5))
    expect(armed.phase).toBe('ACTIVE')
    expect(armed.activeStartedAtSeconds).toBe(5)
    expect(armed.requiresDisarmBeforeArm).toBe(false)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('rejects backwards waiting samples and clears the arm guard and clock on retry', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 2 })
    session.start(0)
    session.consumeSample(sample(1))
    session.tick(2)
    const backwards = session.consumeSample({ ...sample(1.5), armed: false })
    expect(backwards.phase).toBe('WAITING_FOR_ARM')
    expect(backwards.lastTimestampSeconds).toBe(2)
    expect(backwards.requiresDisarmBeforeArm).toBe(true)
    expect(backwards.lastError).toMatch(/monotonic/i)
    const firstId = backwards.sessionId
    const ready = session.retry()
    expect(ready.phase).toBe('READY')
    expect(ready.requiresDisarmBeforeArm).toBe(false)
    expect(ready.activeStartedAtSeconds).toBeNull()
    expect(ready.previousSample).toBeNull()
    session.start(0)
    expect(session.getState().sessionId).not.toBe(firstId)
    session.consumeSample({ ...sample(2), armed: false })
    expect(session.consumeSample(sample(20)).phase).toBe('ACTIVE')
    expect(session.getState().activeStartedAtSeconds).toBe(20)
    expect(session.getState().sampleCount).toBe(1)
    expect(session.getState().result).toBeNull()
  })

  it('snapshots attempt conditions for the result and replaces them on a new attempt', () => {
    const initialContext = {
      rulesVersion: 1 as const,
      physicsVersion: 1 as const,
      presetId: 'beginner' as const,
      settingsFingerprint: 'initial-settings',
      inputSource: 'controller' as const,
      mode: 'practice' as const,
      assistance: 'none' as const,
    }
    const session = new TrainingSession({
      lessons: [testLesson],
      initialLessonId: testLesson.id,
      countdownDurationSeconds: 0,
      attemptContext: initialContext,
    })
    initialContext.settingsFingerprint = 'caller-mutated'
    session.start(0)
    session.tick(0)
    session.consumeSample(sample(1))
    const completed = session.consumeSample(sample(2))
    expect(completed.result?.attemptContext?.settingsFingerprint).toBe('initial-settings')
    expect(completed.result?.attemptContext?.mode).toBe('practice')
    session.retry()
    const nextContext = { ...initialContext, settingsFingerprint: 'challenge-settings', mode: 'challenge' as const }
    session.start(0, nextContext)
    nextContext.settingsFingerprint = 'changed-after-start'
    session.tick(0)
    session.consumeSample(sample(1))
    const nextResult = session.consumeSample(sample(2)).result
    expect(nextResult?.attemptContext?.settingsFingerprint).toBe('challenge-settings')
    expect(nextResult?.attemptContext?.mode).toBe('challenge')
  })

  it('passes copied scene references to evaluator context and keeps them stable while ACTIVE', () => {
    const sceneReference: TrainingSceneReference = {
      id: 'takeoff-pad',
      kind: 'pad',
      positionM: { x: 0, y: 0.5, z: 0 },
      sizeM: { x: 2.4, y: 0.08, z: 2.4 },
    }
    const continuingLesson: LessonDefinition = {
      ...testLesson,
      evaluator: {
        evaluate: (_sample, context) => ({
          status: 'continue',
          metrics: { referenceCount: context.sceneReferences.length },
        }),
      },
    }
    const session = new TrainingSession({
      lessons: [continuingLesson],
      initialLessonId: continuingLesson.id,
      countdownDurationSeconds: 0,
      sceneReferences: [sceneReference],
    })
    expect(session.getState().sceneReferences).toEqual([sceneReference])
    session.start(0)
    session.tick(0)
    session.consumeSample(sample(1))
    const active = session.getState()
    expect(active.phase).toBe('ACTIVE')
    expect(active.lastEvaluation?.metrics).toEqual({ referenceCount: 1 })
    expect(session.setSceneReferences([])).toBe(active)
    expect(session.getState().sceneReferences).toEqual([sceneReference])
  })

  it('keeps long-run evaluator work and UI path snapshots bounded', () => {
    const previousSteps: Array<number | undefined> = []
    const trajectorySnapshots = new Set<readonly TrainingSample[]>()
    const longLesson: LessonDefinition = {
      ...testLesson,
      evaluator: {
        evaluate: (_sample, context) => {
          previousSteps.push(context.previousSample?.state.stepIndex)
          trajectorySnapshots.add(context.trajectory)
          return {
            status: 'continue',
            metrics: { acceptedSamples: context.sampleCount ?? 0 },
          }
        },
      },
    }
    const session = new TrainingSession({
      lessons: [longLesson],
      initialLessonId: longLesson.id,
      countdownDurationSeconds: 0,
    })
    session.start(0)
    session.tick(0)
    const totalSamples = 6_000
    for (let index = 1; index <= totalSamples; index += 1) {
      session.consumeSample(indexedSample(index / 240, index))
    }

    const state = session.getState()
    expect(state.phase).toBe('ACTIVE')
    expect(state.sampleCount).toBe(totalSamples)
    expect(state.trajectory.length).toBeLessThanOrEqual(TRAINING_TRAJECTORY_MAX_POINTS)
    expect(Object.isFrozen(state.trajectory)).toBe(true)
    expect(trajectorySnapshots.size).toBeLessThan(400)
    expect(previousSteps.slice(0, 3)).toEqual([undefined, 1, 2])
    expect(state.previousSample?.state.stepIndex).toBe(totalSamples)
    expect(state.lastEvaluation?.metrics).toEqual({ acceptedSamples: totalSamples })

    const retried = session.retry()
    expect(retried.phase).toBe('READY')
    expect(retried.sampleCount).toBe(0)
    expect(retried.previousSample).toBeNull()
    expect(retried.trajectory).toHaveLength(0)
    session.start(30)
    session.tick(30)
    const repeated = session.consumeSample(indexedSample(30.1, 1))
    expect(repeated.sampleCount).toBe(1)
    expect(repeated.previousSample?.state.stepIndex).toBe(1)
    expect(repeated.lastEvaluation?.metrics).toEqual({ acceptedSamples: 1 })
  })

  it('cannot start an unavailable lesson and never fabricates a result', () => {
    const state = createTrainingMachineState({ initialLessonId: 'missing' }, [testLesson])
    const next = reduceTrainingState(state, { type: 'START', timestampSeconds: 0 }, [testLesson])
    expect(next.phase).toBe('READY')
    expect(next.result).toBeNull()
    expect(next.lastError).toMatch(/select|available/i)
  })

  it('stops an active session immediately on runtime safety telemetry', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 0 })
    session.start(0)
    session.tick(0)
    session.consumeSample(sample(1))
    const failed = session.abort('Window focus was lost; explicit rearm is required.', 1)
    expect(failed.phase).toBe('FAILED')
    expect(failed.result?.message).toMatch(/focus|rearm/i)
    expect(failed.result?.outcome).toBe('FAILED')
  })

  it('clears trajectory and changes session identity on retry', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 0 })
    session.start(0)
    session.tick(0)
    session.consumeSample(sample(1))
    session.consumeSample(sample(2))
    const first = session.getState()
    expect(first.phase).toBe('SUCCESS')
    const retried = session.retry()
    expect(retried.phase).toBe('READY')
    expect(retried.sessionId).toBeNull()
    expect(retried.trajectory).toHaveLength(0)
    expect(retried.sampleCount).toBe(0)
    expect(retried.sessionNumber).toBe(first.sessionNumber + 1)
    expect(retried.result).toBeNull()
    expect(session.start(10).sessionId).not.toBe(first.sessionId)
  })
})
