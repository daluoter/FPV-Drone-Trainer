import { describe, expect, it } from 'vitest'

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
  createOrbitYawInPlaceFixture,
  createSplitSSuccessFixture,
  createSplitSUprightUTurnFixture,
  TRAINING_SCENE_REFERENCES,
} from './fixtures'
import { TrainingSession } from './machine'
import type { TrainingSample } from './types'

function run(lessonId: string, samples: readonly TrainingSample[]) {
  const session = new TrainingSession({
    lessons: DEFAULT_LESSONS,
    initialLessonId: lessonId,
    countdownDurationSeconds: 0,
    sceneReferences: TRAINING_SCENE_REFERENCES,
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
