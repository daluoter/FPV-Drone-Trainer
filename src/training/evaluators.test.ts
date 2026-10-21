import { describe, expect, it } from 'vitest'
import { quaternionFromRotationVector } from '../math/quaternion'

import { DEFAULT_LESSONS } from './lessons'
import {
  createCoordinatedTurnStraightFixture,
  createCoordinatedTurnSuccessFixture,
  createHoverDisarmedFixture,
  createHoverDriftFixture,
  createHoverSuccessFixture,
  createOrbitOscillatoryFixture,
  createOrbitSuccessFixture,
  createOrbitTeleportFixture,
  createOrbitVelocityMismatchFixture,
  createOrbitYawInPlaceFixture,
  createSplitSSuccessFixture,
  createSplitSUprightUTurnFixture,
  TRAINING_SCENE_REFERENCES,
} from './fixtures'
import { TrainingSession } from './machine'
import { evaluateCoordinatedTurn, evaluateHover, evaluateOrbit, evaluateSplitS } from './evaluators'
import type { TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'

function context(lessonId: string, overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return {
    lesson: DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId)!, elapsedSeconds: 0,
    trajectory: [], checkpoints: {}, sceneReferences: TRAINING_SCENE_REFERENCES, ...overrides,
  }
}

function run(lessonId: string, samples: readonly TrainingSample[], sceneReferences: readonly TrainingSceneReference[] = TRAINING_SCENE_REFERENCES) {
  const session = new TrainingSession({
    lessons: DEFAULT_LESSONS,
    initialLessonId: lessonId,
    countdownDurationSeconds: 0,
    sceneReferences,
  })
  session.start(0)
  session.tick(0)
  for (const sample of samples) {
    session.consumeSample(sample)
    if (session.getState().phase === 'SUCCESS' || session.getState().phase === 'FAILED') break
  }
  return session.getState()
}

describe('Phase 7 geometric lesson evaluators', () => {
  it('rejects relabelled frozen or mismatched physical clocks in every standalone evaluator', () => {
    const scenarios = [
      { id: 'hover', evaluate: evaluateHover, sample: createHoverSuccessFixture()[0]! },
      { id: 'coordinated-turn', evaluate: evaluateCoordinatedTurn, sample: createCoordinatedTurnSuccessFixture()[0]! },
      { id: 'split-s', evaluate: evaluateSplitS, sample: createSplitSSuccessFixture()[0]! },
      { id: 'orbit', evaluate: evaluateOrbit, sample: createOrbitSuccessFixture()[0]! },
    ]
    for (const scenario of scenarios) {
      const previous = scenario.sample
      const current = { ...previous, timestampSeconds: previous.timestampSeconds + 0.1 }
      for (const state of [
        previous.state,
        { ...previous.state, stepIndex: previous.state.stepIndex + 1 },
        { ...previous.state, stepIndex: previous.state.stepIndex + 1, timeSeconds: previous.state.timeSeconds + 0.05 },
      ]) {
        const evaluation = scenario.evaluate({ ...current, state }, context(scenario.id, {
          mode: 'practice', previousFlightSample: previous, previousSample: null, elapsedSeconds: 4,
        }))
        expect(evaluation.status).toBe('failure')
        expect(evaluation.recovery).toBeUndefined()
      }
    }
  })

  it('requires consecutive settled hover rather than one good sample after unstable time inside the zone', () => {
    const initial = createHoverSuccessFixture()[0]!
    for (const unstable of ['tilt', 'speed'] as const) {
      const trace = Array.from({ length: 69 }, (_, index): TrainingSample => {
        const isUnstable = index < 35
        const timestampSeconds = (index + 1) * 0.1
        return {
          ...initial, timestampSeconds,
          state: {
            ...initial.state, timeSeconds: timestampSeconds, stepIndex: index + 1,
            velocityMps: { x: isUnstable && unstable === 'speed' ? 2 : 0, y: 0, z: 0 },
            orientation: isUnstable && unstable === 'tilt'
              ? quaternionFromRotationVector({ x: Math.PI / 6, y: 0, z: 0 }) : initial.state.orientation,
          },
        }
      })
      const oneGoodSample = run('hover', trace.slice(0, 36))
      expect(oneGoodSample.phase).toBe('ACTIVE')
      expect(oneGoodSample.lastEvaluation?.metrics?.contiguousDwellSeconds).toBe(0)
      expect(oneGoodSample.checkpoints['settle-hover']?.completed).toBe(false)
      expect(run('hover', trace).phase).toBe('SUCCESS')
    }
  })

  it('measures Split-S clearance above configured ground and requires a currently valid recovery', () => {
    const references: readonly TrainingSceneReference[] = [
      ...TRAINING_SCENE_REFERENCES.map((reference) => ({
        ...reference, positionM: { ...reference.positionM, y: reference.positionM.y + 30 },
      })),
      { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: 30, z: 0 } },
    ]
    const shiftedTrace = createSplitSSuccessFixture().map((sample) => ({
      ...sample, state: { ...sample.state, positionM: { ...sample.state.positionM, y: sample.state.positionM.y + 30 } },
    }))
    expect(run('split-s', shiftedTrace, references).phase).toBe('SUCCESS')

    const recovery = shiftedTrace.at(-1)!
    const recoveryContext = context('split-s', {
      elapsedSeconds: 3, sceneReferences: references,
      checkpoints: Object.fromEntries(['entry', 'inverted', 'descent', 'reversed', 'recovered'].map((id) => [id, {
        id, completed: true, completedAtSeconds: 1, metrics: {},
      }])),
      previousEvaluation: { status: 'continue', metrics: { entryHeadingReady: 1, entryHeadingRad: -Math.PI / 2, invertedAltitudeM: 19 } },
    })
    const barelyAboveGround = { ...recovery, state: { ...recovery.state, positionM: { ...recovery.state.positionM, y: 30.05 } } }
    expect(evaluateSplitS(barelyAboveGround, recoveryContext).status).toBe('continue')
    expect(evaluateSplitS(recovery, recoveryContext).status).toBe('success')
    const entryTooLow = evaluateSplitS({ ...barelyAboveGround, state: { ...barelyAboveGround.state, positionM: { ...barelyAboveGround.state.positionM, y: 35 } } }, context('split-s', { sceneReferences: references }))
    expect(entryTooLow.checkpointIds ?? []).not.toContain('entry')
  })

  it('omits each challenge timeout in explicit practice while leaving default challenge rules intact', () => {
    const scenarios = [
      { id: 'hover', evaluate: evaluateHover, sample: createHoverSuccessFixture()[0]! },
      { id: 'coordinated-turn', evaluate: evaluateCoordinatedTurn, sample: createCoordinatedTurnSuccessFixture()[0]! },
      { id: 'split-s', evaluate: evaluateSplitS, sample: createSplitSSuccessFixture()[0]! },
      { id: 'orbit', evaluate: evaluateOrbit, sample: createOrbitSuccessFixture()[0]! },
    ]
    for (const scenario of scenarios) {
      expect(scenario.evaluate(scenario.sample, context(scenario.id, { mode: 'practice', elapsedSeconds: 120 })).status).toBe('continue')
      const challenge = scenario.evaluate(scenario.sample, context(scenario.id, { elapsedSeconds: 120 }))
      expect(challenge.status).toBe('failure')
      expect(challenge.message).toMatch(/timed out/i)
      expect(challenge.recovery).toBeUndefined()
    }
  })

  it('explicitly restarts ordinary practice envelopes and direction errors without weakening challenge failures', () => {
    const hover = createHoverSuccessFixture()[0]!
    const turn = createCoordinatedTurnSuccessFixture()[0]!
    const split = createSplitSSuccessFixture()[0]!
    const orbit = createOrbitSuccessFixture()[0]!
    const scenarios = [
      { id: 'hover', evaluate: evaluateHover, sample: { ...hover, state: { ...hover.state, positionM: { ...hover.state.positionM, x: 13 } } }, extra: {} },
      { id: 'coordinated-turn', evaluate: evaluateCoordinatedTurn, sample: { ...turn, state: { ...turn.state, positionM: { ...turn.state.positionM, z: 20 } } }, extra: {
        checkpoints: { 'turn-entry': { id: 'turn-entry', completed: true, completedAtSeconds: 0, metrics: {} } },
      } },
      { id: 'split-s', evaluate: evaluateSplitS, sample: { ...split, state: { ...split.state, positionM: { ...split.state.positionM, y: 0.5 } } }, extra: {} },
      { id: 'orbit', evaluate: evaluateOrbit, sample: orbit, extra: { previousEvaluation: { status: 'continue' as const, metrics: { directionReversals: 3 } } } },
    ]
    for (const scenario of scenarios) {
      const practice = scenario.evaluate(scenario.sample, context(scenario.id, { ...scenario.extra, mode: 'practice' }))
      expect(practice.status).toBe('continue')
      expect(practice.recovery).toBe('restart')
      expect(practice.checkpointIds ?? []).toHaveLength(0)
      const challenge = scenario.evaluate(scenario.sample, context(scenario.id, scenario.extra))
      expect(challenge.status).toBe('failure')
      expect(challenge.recovery).toBeUndefined()
    }
  })

  it('keeps telemetry gaps, teleports, crashes and disarm terminal in practice, including immediately after recovery', () => {
    const scenarios = [
      { id: 'hover', evaluate: evaluateHover, sample: createHoverSuccessFixture()[0]! },
      { id: 'coordinated-turn', evaluate: evaluateCoordinatedTurn, sample: createCoordinatedTurnSuccessFixture()[0]! },
      { id: 'split-s', evaluate: evaluateSplitS, sample: createSplitSSuccessFixture()[0]! },
      { id: 'orbit', evaluate: evaluateOrbit, sample: createOrbitSuccessFixture()[0]! },
    ]
    for (const scenario of scenarios) {
      const current = { ...scenario.sample, timestampSeconds: scenario.sample.timestampSeconds + 0.1 }
      const practice = context(scenario.id, { mode: 'practice', previousSample: null, previousFlightSample: scenario.sample })
      for (const invalid of [
        { ...current, state: { ...current.state, positionM: { ...current.state.positionM, x: current.state.positionM.x + 100 } } },
        { ...current, timestampSeconds: scenario.sample.timestampSeconds + 1 },
        { ...current, state: { ...current.state, crashed: true } },
        { ...current, armed: false },
        { ...current, state: { ...current.state, velocityMps: { x: NaN, y: 0, z: 0 } } },
      ]) {
        const failure = scenario.evaluate(invalid, practice)
        expect(failure.status).toBe('failure')
        expect(failure.recovery).toBeUndefined()
      }
    }
  })

  it('passes the positive hover and coordinated-turn traces', () => {
    const hover = run('hover', createHoverSuccessFixture())
    expect(hover.phase).toBe('SUCCESS')
    expect(hover.result?.completedCheckpoints).toBe(3)

    const turn = run('coordinated-turn', createCoordinatedTurnSuccessFixture())
    expect(turn.phase).toBe('SUCCESS')
    expect(turn.result?.completedCheckpoints).toBe(3)
    expect(turn.result?.metrics.headingChangeDegrees).toBeGreaterThan(45)
  })

  it('passes a real Split-S but not an upright U-turn', () => {
    const splitS = run('split-s', createSplitSSuccessFixture())
    expect(splitS.phase).toBe('SUCCESS')
    expect(splitS.result?.completedCheckpoints).toBe(5)

    const uTurn = run('split-s', createSplitSUprightUTurnFixture())
    expect(uTurn.phase).not.toBe('SUCCESS')
    expect(uTurn.result?.completedCheckpoints ?? 0).toBeLessThan(5)
  })

  it('passes one directed orbit and rejects yaw-in-place and teleport traces', () => {
    const orbit = run('orbit', createOrbitSuccessFixture())
    expect(orbit.phase).toBe('SUCCESS')
    expect(orbit.result?.completedCheckpoints).toBe(3)
    expect(orbit.result?.metrics.orbitProgress).toBeGreaterThanOrEqual(Math.PI * 2)

    const yawInPlace = run('orbit', createOrbitYawInPlaceFixture())
    expect(yawInPlace.phase).not.toBe('SUCCESS')

    const teleport = run('orbit', createOrbitTeleportFixture())
    expect(teleport.phase).toBe('FAILED')
    expect(teleport.result?.message).toMatch(/gap|teleport/i)

    const velocityMismatch = run('orbit', createOrbitVelocityMismatchFixture())
    expect(velocityMismatch.phase).toBe('FAILED')
    expect(velocityMismatch.result?.message).toMatch(/gap|teleport/i)
    expect(velocityMismatch.result?.metrics.velocityConsistencyErrorM).toBeGreaterThan(
      velocityMismatch.result?.metrics.integrationToleranceM ?? Number.POSITIVE_INFINITY,
    )

    const oscillatory = run('orbit', createOrbitOscillatoryFixture())
    expect(oscillatory.phase).toBe('FAILED')
    expect(oscillatory.result?.message).toMatch(/oscillat|directed/i)
  })

  it('fails disarmed telemetry before any evaluator can create a pass', () => {
    const disarmed = run('hover', createHoverDisarmedFixture())
    expect(disarmed.phase).toBe('FAILED')
    expect(disarmed.result?.message).toMatch(/disarm|focus/i)

    const drift = run('hover', createHoverDriftFixture())
    expect(drift.phase).not.toBe('SUCCESS')

    const straight = run('coordinated-turn', createCoordinatedTurnStraightFixture())
    expect(straight.phase).not.toBe('SUCCESS')
  })

  it('clears Phase 7 trajectory/checkpoints and session identity on retry', () => {
    const session = new TrainingSession({
      lessons: DEFAULT_LESSONS,
      initialLessonId: 'hover',
      countdownDurationSeconds: 0,
      sceneReferences: TRAINING_SCENE_REFERENCES,
    })
    session.start(0)
    session.tick(0)
    for (const sample of createHoverDisarmedFixture()) session.consumeSample(sample)
    const failed = session.getState()
    expect(failed.phase).toBe('FAILED')
    const retried = session.retry()
    expect(retried.phase).toBe('READY')
    expect(retried.sessionId).toBeNull()
    expect(retried.trajectory).toHaveLength(0)
    expect(retried.sampleCount).toBe(0)
    expect(retried.checkpoints).toEqual({})
    expect(retried.sessionNumber).toBe(failed.sessionNumber + 1)
  })
})
