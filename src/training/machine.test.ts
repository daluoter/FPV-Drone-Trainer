import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import type { NormalizedRcInput } from '../flight-controller'
import { createTrainingMachineState, reduceTrainingState, TrainingSession } from './machine'
import { TRAINING_TRAJECTORY_MAX_POINTS } from './trajectory'
import type { TrainingAttemptContext } from './attempt'
import type { LessonDefinition, TrainingEvaluation, TrainingSample, TrainingSceneReference } from './types'

const input: NormalizedRcInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 }
const practiceContext: TrainingAttemptContext = {
  rulesVersion: 1, physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}',
  inputSource: 'controller', mode: 'practice', assistance: 'none',
}

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
    state: { ...createInitialDroneState(DEFAULT_DRONE_CONFIG), timeSeconds: timestampSeconds, stepIndex: Math.round(timestampSeconds * 240) },
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
  it('restarts only local practice goals while preserving flight continuity, elapsed time and result provenance', () => {
    const contexts: Array<{ elapsed: number; previous?: number; continuous?: number; accumulated?: number; checkpoints: number }> = []
    const lesson: LessonDefinition = {
      ...testLesson,
      evaluator: (current, context) => {
        contexts.push({
          elapsed: context.elapsedSeconds,
          previous: context.previousSample?.state.stepIndex,
          continuous: context.previousFlightSample?.state.stepIndex,
          accumulated: context.previousEvaluation?.metrics?.accumulated,
          checkpoints: Object.values(context.checkpoints).filter((checkpoint) => checkpoint.completed).length,
        })
        expect(context.mode).toBe('practice')
        if (current.state.stepIndex === 2) {
          return { status: 'continue', recovery: 'restart', checkpointIds: ['hold'], metrics: { accumulated: 99 }, hint: 'Return to the entry and try again.' }
        }
        return {
          status: current.state.stepIndex === 4 ? 'success' : 'continue',
          checkpointIds: ['hold'], metrics: { accumulated: 1 }, score: 92,
        }
      },
    }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, attemptContext: practiceContext })
    session.start(0)
    session.tick(0)
    const groundContact = { heightM: 0, supportOffsetM: 0.03, touching: false }
    session.consumeSample({ ...indexedSample(1, 1), groundContact })
    groundContact.heightM = 99
    expect(session.getState().previousFlightSample?.groundContact?.heightM).toBe(0)
    const recovered = session.consumeSample(indexedSample(1.1, 2))
    expect(recovered.phase).toBe('ACTIVE')
    expect(recovered.previousSample).toBeNull()
    expect(recovered.previousFlightSample?.state.stepIndex).toBe(2)
    expect(recovered.checkpoints.hold?.completed).toBe(false)
    expect(recovered.activeStartedAtSeconds).toBe(1)
    expect(recovered.sampleCount).toBe(2)
    expect(recovered.result).toBeNull()
    session.consumeSample(indexedSample(1.2, 3))
    expect(contexts[2]).toEqual({ elapsed: expect.closeTo(0.2), previous: undefined, continuous: 2, accumulated: undefined, checkpoints: 0 })
    const completed = session.consumeSample(indexedSample(1.6, 4))
    expect(completed.phase).toBe('SUCCESS')
    expect(completed.result?.elapsedSeconds).toBeCloseTo(0.6)
    expect(completed.result?.attemptContext?.mode).toBe('practice')
    expect(completed.sampleCount).toBe(4)
  })

  it('still catches a runtime step rewind immediately after a local practice restart', () => {
    const lesson: LessonDefinition = { ...testLesson, evaluator: () => ({ status: 'continue', recovery: 'restart' }) }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, attemptContext: practiceContext })
    session.start(0)
    session.tick(0)
    session.consumeSample(indexedSample(1, 10))
    expect(session.getState().previousSample).toBeNull()
    const rewound = session.consumeSample(indexedSample(1.1, 1))
    expect(rewound.phase).toBe('FAILED')
    expect(rewound.result?.message).toMatch(/reset|rewound/i)
    expect(rewound.sampleCount).toBe(1)
  })

  it('retains the first restart cause until local checkpoint progress permits a new cause', () => {
    const altitudeMetrics = { altitudeM: 4.1, altitudeLimitM: 3.7, invalid: Number.NaN }
    const speedMetrics = { horizontalSpeedMps: 4.8, speedLimitMps: 4 }
    const lesson: LessonDefinition = {
      ...testLesson,
      evaluator: (current): TrainingEvaluation => {
        switch (current.state.stepIndex) {
          case 2: return { status: 'continue', recovery: 'restart', message: '高度 4.1 m，超過上限 3.7 m。', hint: '先降低高度。', metrics: altitudeMetrics }
          case 3:
          case 5: return { status: 'continue', recovery: 'restart', message: '請回起飛區地面。', hint: '先接地再起飛。', metrics: { altitudeM: 0.3 } }
          case 4: return { status: 'continue', checkpointIds: ['unknown-checkpoint'], metrics: {} }
          case 6: return { status: 'continue', checkpointIds: ['hold'], metrics: {} }
          case 7: return { status: 'continue', recovery: 'restart', message: '水平速度 4.8 m/s，超過上限 4.0 m/s。', hint: '先減少水平速度。', metrics: speedMetrics }
          case 9: return { status: 'failure', message: 'Stopped after the second recovery.' }
          default: return { status: 'continue', metrics: {} }
        }
      },
    }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, attemptContext: practiceContext })
    session.start(0)
    session.tick(0)
    session.consumeSample(indexedSample(1, 1))
    const first = session.consumeSample(indexedSample(1.1, 2)).lastRecovery!
    expect(first).toEqual({ timestampSeconds: 1.1, message: '高度 4.1 m，超過上限 3.7 m。', hint: '先降低高度。', metrics: { altitudeM: 4.1, altitudeLimitM: 3.7 } })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.metrics)).toBe(true)
    altitudeMetrics.altitudeM = 99
    for (let index = 3; index <= 5; index += 1) {
      const waiting = session.consumeSample(indexedSample(1 + (index - 1) * 0.1, index))
      expect(waiting.lastRecovery).toBe(first)
      expect(waiting.recoveryInProgress).toBe(true)
      expect(waiting.lastRecovery?.metrics.altitudeM).toBe(4.1)
    }
    const progressed = session.consumeSample(indexedSample(1.5, 6))
    expect(progressed.recoveryInProgress).toBe(false)
    expect(progressed.lastRecovery).toBe(first)
    const second = session.consumeSample(indexedSample(1.6, 7)).lastRecovery!
    expect(second).not.toBe(first)
    expect(second.message).toContain('水平速度 4.8 m/s')
    expect(second.timestampSeconds).toBe(1.6)
    speedMetrics.horizontalSpeedMps = 99
    expect(second.metrics.horizontalSpeedMps).toBe(4.8)
    const idleRecovery = session.consumeSample(indexedSample(1.7, 8))
    expect(idleRecovery.lastRecovery).toBe(second)
    expect(idleRecovery.recoveryInProgress).toBe(true)
    const stopped = session.consumeSample(indexedSample(1.8, 9))
    expect(stopped.phase).toBe('FAILED')
    expect(stopped.lastRecovery).toBe(second)
  })

  it('clears recovery history for retry, reset, lesson selection and a fresh start', () => {
    const lesson: LessonDefinition = { ...testLesson, evaluator: () => ({ status: 'continue', recovery: 'restart', message: '高度超標。' }) }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, attemptContext: practiceContext })
    const trigger = (): void => {
      session.start(0)
      session.tick(0)
      session.consumeSample(indexedSample(1, 1))
      expect(session.getState().lastRecovery?.message).toBe('高度超標。')
      expect(session.getState().lastRecovery?.hint).toBeNull()
    }
    trigger()
    const retried = session.retry()
    expect(retried.lastRecovery).toBeNull()
    expect(retried.recoveryInProgress).toBe(false)
    trigger()
    const reset = session.reset()
    expect(reset.lastRecovery).toBeNull()
    expect(reset.recoveryInProgress).toBe(false)
    trigger()
    session.abort('Stopped for selection', 1.1)
    session.showResult()
    const selected = session.selectLesson(lesson.id)
    expect(selected.lastRecovery).toBeNull()
    expect(selected.recoveryInProgress).toBe(false)
    trigger()
    const staleRecovery = session.getState().lastRecovery
    const readyWithStaleRecovery = { ...session.reset(), lastRecovery: staleRecovery, recoveryInProgress: true }
    const started = reduceTrainingState(readyWithStaleRecovery, { type: 'START', timestampSeconds: 0 }, [lesson])
    expect(started.phase).toBe('COUNTDOWN')
    expect(started.lastRecovery).toBeNull()
    expect(started.recoveryInProgress).toBe(false)
  })

  it('stops frozen or relabelled physics before an evaluator can accumulate dwell', () => {
    for (const altered of ['frozen', 'different-clock'] as const) {
      const evaluate = vi.fn(() => ({ status: 'continue' as const, recovery: 'restart' as const }))
      const lesson = { ...testLesson, evaluator: evaluate }
      const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, attemptContext: practiceContext })
      session.start(0)
      session.tick(0)
      const first = indexedSample(1, 1)
      session.consumeSample(first)
      const current = indexedSample(1.1, 2)
      const invalid = { ...current, state: altered === 'frozen' ? first.state : { ...current.state, timeSeconds: 1.3 } }
      const stopped = session.consumeSample(invalid)
      expect(stopped.phase).toBe('FAILED')
      expect(stopped.sampleCount).toBe(1)
      expect(evaluate).toHaveBeenCalledTimes(1)
      expect(stopped.result?.message).toMatch(/physical clock/)
    }
  })

  it('ends active practice on invalid state or contact metadata without scoring the invalid sample', () => {
    const base = sample(1.1)
    for (const invalid of [
      { ...base, state: { ...base.state, positionM: { x: Number.NaN, y: 3, z: 0 } } },
      { ...base, groundContact: { heightM: Number.NaN, supportOffsetM: 0.04, touching: true } },
    ]) {
      const evaluate = vi.fn(() => ({ status: 'continue' as const }))
      const lesson = { ...testLesson, evaluator: evaluate }
      const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, attemptContext: practiceContext })
      session.start(0)
      session.tick(0)
      session.consumeSample(sample(1))
      const stopped = session.consumeSample(invalid)
      expect(stopped.phase).toBe('FAILED')
      expect(stopped.sampleCount).toBe(1)
      expect(stopped.result?.elapsedSeconds).toBe(0)
      expect(stopped.result?.message).toMatch(/invalid|non-finite/)
      expect(evaluate).toHaveBeenCalledTimes(1)
      expect(session.consumeSample(sample(2))).toBe(stopped)
    }
  })

  it('never converts an unmarked evaluator failure into practice recovery', () => {
    const lesson: LessonDefinition = { ...testLesson, evaluator: () => ({ status: 'failure', message: 'Timed out or left the route.' }) }
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, attemptContext: practiceContext })
    session.start(0)
    session.tick(0)
    expect(session.consumeSample(sample(1)).phase).toBe('FAILED')
  })

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
