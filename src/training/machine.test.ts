import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import type { NormalizedRcInput } from '../flight-controller'
import { createTrainingMachineState, reduceTrainingState, TrainingSession } from './machine'
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
    expect(session.tick(2).phase).toBe('ACTIVE')
    const disarmed = session.consumeSample({ ...sample(2.1), armed: false })
    expect(disarmed.phase).toBe('ACTIVE')
    expect(disarmed.lastError).toMatch(/arm/i)
    expect(disarmed.sampleCount).toBe(0)
    expect(session.consumeSample({ ...sample(2.2), armed: true }).phase).toBe('ACTIVE')
    expect(session.consumeSample({ ...sample(2.7), armed: true }).phase).toBe('SUCCESS')
  })

  it('guards countdown timing and only evaluates ACTIVE samples', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 2 })
    expect(session.getState().phase).toBe('READY')
    expect(session.start(0).phase).toBe('COUNTDOWN')
    expect(session.consumeSample(sample(1)).phase).toBe('COUNTDOWN')
    expect(session.getState().sampleCount).toBe(0)
    expect(session.tick(2).phase).toBe('ACTIVE')
    expect(session.consumeSample(sample(2)).phase).toBe('ACTIVE')
    expect(session.consumeSample(sample(2.5)).phase).toBe('SUCCESS')
    expect(session.getState().result?.score).toBe(92)
    expect(session.showResult().phase).toBe('RESULT')
  })

  it('rejects backwards and duplicate timestamps without changing the trajectory', () => {
    const session = new TrainingSession({ lessons: [testLesson], initialLessonId: testLesson.id, countdownDurationSeconds: 0 })
    session.start(0)
    session.tick(0)
    expect(session.getState().phase).toBe('ACTIVE')
    session.consumeSample(sample(1))
    const before = session.getState()
    const after = session.consumeSample(sample(0.5))
    expect(after.phase).toBe('ACTIVE')
    expect(after.trajectory).toHaveLength(1)
    expect(after.lastError).toMatch(/increase|monotonic/i)
    expect(after.sampleCount).toBe(before.sampleCount)
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
