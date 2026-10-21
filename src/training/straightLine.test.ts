import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import { quaternionFromRotationVector } from '../math/quaternion'
import { TRAINING_SCENE_REFERENCES } from './fixtures'
import { TrainingSession } from './machine'
import {
  STRAIGHT_LINE_HEIGHT_OFFSET_M,
  STRAIGHT_LINE_LEARNING_CONTENT,
  STRAIGHT_LINE_LESSON,
  STRAIGHT_LINE_ROUTE_LENGTH_M,
  STRAIGHT_LINE_SETTLED_DWELL_SECONDS,
  straightLineEvaluator,
} from './straightLine'
import type { TrainingCheckpointState, TrainingEvaluationContext, TrainingSample } from './types'

const PAD = TRAINING_SCENE_REFERENCES.find((reference) => reference.id === 'takeoff-pad')!.positionM
const ALTITUDE = PAD.y + STRAIGHT_LINE_HEIGHT_OFFSET_M

function sample(index: number, distanceM: number, forwardSpeedMps = 0): TrainingSample {
  const timestampSeconds = (index + 1) * 0.1
  return {
    timestampSeconds, armed: true,
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
    state: {
      ...createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: PAD.x, y: ALTITUDE, z: PAD.z - distanceM }),
      velocityMps: { x: 0, y: 0, z: -forwardSpeedMps },
      timeSeconds: timestampSeconds, stepIndex: index + 1,
    },
  }
}

/** Smooth positions and their analytic velocities; fixture evidence, not flight dynamics. */
function successFixture(): readonly TrainingSample[] {
  return Array.from({ length: 85 }, (_, index) => {
    const fraction = Math.min(1, index * 0.1 / 6)
    const distance = STRAIGHT_LINE_ROUTE_LENGTH_M * (3 * fraction ** 2 - 2 * fraction ** 3)
    const speed = STRAIGHT_LINE_ROUTE_LENGTH_M * (6 * fraction - 6 * fraction ** 2) / 6
    return sample(index, distance, speed)
  })
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return {
    lesson: STRAIGHT_LINE_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: {},
    sceneReferences: TRAINING_SCENE_REFERENCES, ...overrides,
  }
}

function checkpoint(id: string): TrainingCheckpointState {
  return { id, completed: true, completedAtSeconds: 0.1, metrics: {} }
}

function run(samples: readonly TrainingSample[]) {
  const session = new TrainingSession({
    lessons: [STRAIGHT_LINE_LESSON], initialLessonId: STRAIGHT_LINE_LESSON.id,
    countdownDurationSeconds: 0, sceneReferences: TRAINING_SCENE_REFERENCES,
  })
  session.start(0)
  session.tick(0)
  for (const current of samples) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

describe('straight line and deceleration lesson', () => {
  it('requires an ordered real route, observed deceleration and a contiguous settled endpoint', () => {
    const result = run(successFixture())
    expect(result.phase).toBe('SUCCESS')
    expect(result.result?.completedCheckpoints).toBe(4)
    expect(result.result?.metrics.contiguousDwellSeconds).toBeGreaterThanOrEqual(STRAIGHT_LINE_SETTLED_DWELL_SECONDS - 1e-9)
    expect(result.result?.metrics.stopErrorM).toBeLessThan(0.1)
    expect(result.result?.metrics.peakForwardSpeedMps).toBeCloseTo(2)
    expect(result.result?.score).toBeGreaterThan(95)
    expect(STRAIGHT_LINE_LEARNING_CONTENT.steps.join(' ')).toMatch(/回中不會自動煞停/)
  })

  it('does not award a route for stationary stick activity or starting at the endpoint', () => {
    const stationary = run(Array.from({ length: 80 }, (_, index) => ({
      ...sample(index, 0), normalizedInput: { roll: 0, pitch: index % 2 ? 1 : -1, yaw: 0, throttle: 0.4 },
    })))
    expect(stationary.phase).toBe('ACTIVE')
    expect(stationary.checkpoints['straight-transit']?.completed).toBe(false)
    const skipped = run([sample(0, STRAIGHT_LINE_ROUTE_LENGTH_M)])
    expect(skipped.phase).toBe('FAILED')
    expect(skipped.result?.message).toMatch(/起點|跳到/)
  })

  it('rejects wrong-order arrival and a constant-speed pass through the endpoint', () => {
    const wrongOrder = straightLineEvaluator.evaluate(sample(10, 6, 1), context({
      checkpoints: { 'straight-start': checkpoint('straight-start') },
    }))
    expect(wrongOrder.status).toBe('failure')
    expect(wrongOrder.message).toMatch(/順序/)
    const passThrough = run([
      sample(0, 0),
      ...Array.from({ length: 45 }, (_, index) => sample(index + 1, (index + 1) * 0.2, 2)),
    ])
    expect(passThrough.phase).toBe('FAILED')
    expect(passThrough.checkpoints['straight-brake']?.completed).toBe(false)
    expect(passThrough.result?.message).toMatch(/減速|降速/)
  })

  it('resets endpoint dwell when velocity leaves the settled bound', () => {
    const fixture = successFixture()
    const interruptIndex = 65
    const interrupted = fixture.map((current, index) => index === interruptIndex ? {
      ...current, state: { ...current.state, velocityMps: { x: 0.5, y: 0, z: 0 } },
    } : current)
    const beforeComplete = run(interrupted.slice(0, 74))
    expect(beforeComplete.phase).toBe('ACTIVE')
    expect(beforeComplete.lastEvaluation?.metrics?.contiguousDwellSeconds).toBeLessThan(STRAIGHT_LINE_SETTLED_DWELL_SECONDS)
    expect(run(interrupted).phase).toBe('SUCCESS')
  })

  it('requires observed deceleration inside the brake zone rather than arriving already slow', () => {
    const previous = sample(30, 5.2, 0.6)
    const current = sample(31, 5.26, 0.6)
    const evaluation = straightLineEvaluator.evaluate(current, context({
      elapsedSeconds: 3.2,
      previousSample: previous,
      previousEvaluation: { status: 'continue', metrics: { peakForwardSpeedMps: 2, furthestProgressM: 5.2 } },
      checkpoints: {
        'straight-start': checkpoint('straight-start'),
        'straight-transit': checkpoint('straight-transit'),
      },
    }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).not.toContain('straight-brake')
    expect(evaluation.metrics?.brakeEntrySpeedMps).toBe(0)
  })

  it('uses pad-relative route geometry and requires the target altitude', () => {
    const shifted = { x: 12, y: 4, z: -7 }
    const shiftedReferences = [{ id: 'takeoff-pad', kind: 'pad', positionM: shifted }]
    const original = sample(0, 0)
    const shiftedStart = { ...original, state: {
      ...original.state, positionM: { x: shifted.x, y: shifted.y + STRAIGHT_LINE_HEIGHT_OFFSET_M, z: shifted.z },
    } }
    const valid = straightLineEvaluator.evaluate(shiftedStart, context({ sceneReferences: shiftedReferences }))
    expect(valid.checkpointIds).toContain('straight-start')
    const wrongAltitude = straightLineEvaluator.evaluate({ ...original, state: {
      ...original.state, positionM: { ...original.state.positionM, y: ALTITUDE + 1 },
    } }, context())
    expect(wrongAltitude.status).toBe('failure')
    expect(wrongAltitude.message).toMatch(/高度/)
  })

  it('returns local recovery for ordinary practice excursions and skips only its time limit', () => {
    const first = sample(0, 0)
    const outside = { ...first, state: { ...first.state, positionM: { ...first.state.positionM, x: 1.3 } } }
    const practice = straightLineEvaluator.evaluate(outside, context({ mode: 'practice' }))
    expect(practice.status).toBe('continue')
    expect(practice.recovery).toBe('restart')
    expect(practice.metrics?.contiguousDwellSeconds).toBe(0)
    expect(straightLineEvaluator.evaluate(outside, context({ mode: 'challenge' })).status).toBe('failure')
    const fast = { ...first, state: { ...first.state, velocityMps: { x: 0, y: 0, z: -4.1 } } }
    expect(straightLineEvaluator.evaluate(fast, context({ mode: 'practice' })).recovery).toBe('restart')
    expect(straightLineEvaluator.evaluate(first, context({ elapsedSeconds: 46, mode: 'practice' })).status).toBe('continue')
    expect(straightLineEvaluator.evaluate(first, context({ elapsedSeconds: 46, mode: 'challenge' })).message).toMatch(/逾時/)
  })

  it('rejects teleports, sample gaps, clock rewind and physics reset even after practice recovery', () => {
    const previous = sample(0, 0)
    const teleport = straightLineEvaluator.evaluate(sample(1, 8), context({
      mode: 'practice', previousFlightSample: previous, previousSample: null,
    }))
    expect(teleport.status).toBe('failure')
    expect(teleport.recovery).toBeUndefined()
    expect(teleport.message).toMatch(/位置跳躍/)
    const invalidTimeSamples = [
      { ...sample(1, 0), timestampSeconds: 1 },
      { ...sample(1, 0), timestampSeconds: 0.05 },
      { ...sample(1, 0), state: { ...sample(1, 0).state, timeSeconds: 0 } },
      { ...sample(1, 0), state: { ...sample(1, 0).state, stepIndex: 0 } },
    ]
    for (const current of invalidTimeSamples) {
      const evaluation = straightLineEvaluator.evaluate(current, context({
        mode: 'practice', previousFlightSample: previous, previousSample: null,
      }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
      expect(evaluation.message).toMatch(/時間|中斷|重設/)
    }
  })

  it('rejects disarm, crash, nonfinite values and missing references in either mode', () => {
    const first = sample(0, 0)
    for (const mode of ['practice', 'challenge'] as const) {
      expect(straightLineEvaluator.evaluate({ ...first, armed: false }, context({ mode })).status).toBe('failure')
      expect(straightLineEvaluator.evaluate({ ...first, state: { ...first.state, crashed: true } }, context({ mode })).status).toBe('failure')
      expect(straightLineEvaluator.evaluate({ ...first, timestampSeconds: NaN }, context({ mode })).status).toBe('failure')
      expect(straightLineEvaluator.evaluate({ ...first, state: { ...first.state, positionM: { x: 0, y: NaN, z: 0 } } }, context({ mode })).status).toBe('failure')
      expect(straightLineEvaluator.evaluate(first, context({ mode, sceneReferences: [] })).status).toBe('failure')
    }
    const missingArm = straightLineEvaluator.evaluate({ ...first, armed: undefined }, context())
    expect(missingArm.status).toBe('continue')
    expect(missingArm.checkpointIds).toBeUndefined()
    const tilted = { ...first, state: {
      ...first.state, orientation: quaternionFromRotationVector({ x: Math.PI / 3, y: 0, z: 0 }),
    } }
    expect(straightLineEvaluator.evaluate(tilted, context({ mode: 'practice' })).recovery).toBe('restart')
  })
})
