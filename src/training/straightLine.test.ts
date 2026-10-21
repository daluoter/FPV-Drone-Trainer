import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, droneGroundSupport, DRONE_GROUND_CLEARANCE_M } from '../drone'
import { quaternionFromRotationVector } from '../math/quaternion'
import { TRAINING_SCENE_REFERENCES } from './fixtures'
import { TrainingSession } from './machine'
import {
  STRAIGHT_LINE_TARGET_HEIGHT_AGL_M,
  STRAIGHT_LINE_LEARNING_CONTENT,
  STRAIGHT_LINE_LESSON,
  STRAIGHT_LINE_ROUTE_LENGTH_M,
  STRAIGHT_LINE_SETTLED_DWELL_SECONDS,
  straightLineEvaluator,
} from './straightLine'
import type { TrainingCheckpointState, TrainingEvaluationContext, TrainingSample } from './types'

const PAD = TRAINING_SCENE_REFERENCES.find((reference) => reference.id === 'takeoff-pad')!.positionM
const ALTITUDE = DEFAULT_DRONE_CONFIG.ground.heightM + STRAIGHT_LINE_TARGET_HEIGHT_AGL_M
const SUPPORT = droneGroundSupport(DEFAULT_DRONE_CONFIG, { x: 0, y: 0, z: 0, w: 1 }).supportOffsetM
const GROUND_HEIGHT = DEFAULT_DRONE_CONFIG.ground.heightM
const GROUND_COM = GROUND_HEIGHT + SUPPORT + DRONE_GROUND_CLEARANCE_M
const REFERENCES = [...TRAINING_SCENE_REFERENCES, {
  id: 'training-launch', kind: 'spawn', positionM: { ...PAD, y: GROUND_COM },
}, {
  id: 'landing-surface', kind: 'zone', positionM: { ...PAD, y: GROUND_HEIGHT, z: PAD.z - 8 },
}]

function sample(index: number, distanceM: number, forwardSpeedMps = 0, heightM = ALTITUDE, verticalSpeedMps = 0): TrainingSample {
  const timestampSeconds = (index + 1) * 0.1
  return {
    timestampSeconds, armed: true,
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
    groundContact: { heightM: GROUND_HEIGHT, supportOffsetM: SUPPORT, touching: heightM <= GROUND_COM + 1e-8 },
    state: {
      ...createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: PAD.x, y: heightM, z: PAD.z - distanceM }),
      velocityMps: { x: 0, y: verticalSpeedMps, z: -forwardSpeedMps },
      timeSeconds: timestampSeconds, stepIndex: index + 1,
    },
  }
}

/** Analytic ground->climb->route trace; evaluator fixture, not human-flight evidence. */
function takeoffFixture(): readonly TrainingSample[] {
  return Array.from({ length: 45 }, (_, index) => {
    const fraction = Math.min(1, index * 0.1 / 4)
    const height = GROUND_COM + (ALTITUDE - GROUND_COM) * (3 * fraction ** 2 - 2 * fraction ** 3)
    const speed = (ALTITUDE - GROUND_COM) * (6 * fraction - 6 * fraction ** 2) / 4
    return sample(index, 0, 0, height, speed)
  })
}

function successFixture(): readonly TrainingSample[] {
  return [...takeoffFixture(), ...Array.from({ length: 85 }, (_, index) => {
    const fraction = Math.min(1, index * 0.1 / 6)
    const distance = STRAIGHT_LINE_ROUTE_LENGTH_M * (3 * fraction ** 2 - 2 * fraction ** 3)
    const speed = STRAIGHT_LINE_ROUTE_LENGTH_M * (6 * fraction - 6 * fraction ** 2) / 6
    return sample(index + 45, distance, speed)
  })]
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return {
    lesson: STRAIGHT_LINE_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: {},
    sceneReferences: REFERENCES, ...overrides,
  }
}

function checkpoint(id: string): TrainingCheckpointState {
  return { id, completed: true, completedAtSeconds: 0.1, metrics: {} }
}

function routeCheckpoints(transited = false) {
  return {
    'straight-ground': checkpoint('straight-ground'),
    'straight-start': checkpoint('straight-start'),
    ...(transited ? { 'straight-transit': checkpoint('straight-transit') } : {}),
  }
}

function run(samples: readonly TrainingSample[]) {
  const session = new TrainingSession({
    lessons: [STRAIGHT_LINE_LESSON], initialLessonId: STRAIGHT_LINE_LESSON.id,
    countdownDurationSeconds: 0, sceneReferences: REFERENCES,
  })
  session.start(0)
  session.tick(0)
  for (const current of samples) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

describe('ground-start straight line and deceleration lesson', () => {
  it('waits safely on the ground, accepts manual climb, then requires the ordered route and settled stop', () => {
    const grounded = run(Array.from({ length: 20 }, (_, index) => sample(index, 0, 0, GROUND_COM)))
    expect(grounded.phase).toBe('ACTIVE')
    expect(grounded.checkpoints['straight-ground']?.completed).toBe(true)
    expect(grounded.checkpoints['straight-start']?.completed).toBe(false)
    expect(grounded.lastEvaluation?.hint).toMatch(/自行起飛/)
    const climbed = run(takeoffFixture())
    expect(climbed.phase).toBe('ACTIVE')
    expect(climbed.checkpoints['straight-start']?.completed).toBe(true)
    expect(climbed.lastEvaluation?.metrics?.routePhase).toBe(1)
    const result = run(successFixture())
    expect(result.phase, result.result?.message).toBe('SUCCESS')
    expect(result.result?.completedCheckpoints).toBe(5)
    expect(result.result?.metrics.contiguousDwellSeconds).toBeGreaterThanOrEqual(STRAIGHT_LINE_SETTLED_DWELL_SECONDS - 1e-9)
    expect(result.result?.metrics.stopErrorM).toBeLessThan(0.1)
    expect(result.result?.metrics.peakForwardSpeedMps).toBeCloseTo(2)
    expect(result.result?.score).toBeGreaterThan(95)
    expect(STRAIGHT_LINE_LEARNING_CONTENT.steps.join(' ')).toMatch(/回中不會自動煞停/)
  })

  it('does not skip takeoff from an airborne start, endpoint or stationary stick activity', () => {
    for (const distance of [0, STRAIGHT_LINE_ROUTE_LENGTH_M]) {
      const skipped = run([sample(0, distance)])
      expect(skipped.phase).toBe('FAILED')
      expect(skipped.result?.message).toMatch(/地面|起飛/)
    }
    const stationary = run([
      ...takeoffFixture(),
      ...Array.from({ length: 30 }, (_, index) => ({
        ...sample(index + 45, 0), normalizedInput: { roll: 0, pitch: index % 2 ? 1 : -1, yaw: 0, throttle: 0.4 },
      })),
    ])
    expect(stationary.phase).toBe('ACTIVE')
    expect(stationary.checkpoints['straight-transit']?.completed).toBe(false)
  })

  it('rejects an airborne pose with a fabricated elevated contact surface', () => {
    const airborne = sample(0, 0)
    const forged = { ...airborne, groundContact: { heightM: ALTITUDE - SUPPORT - DRONE_GROUND_CLEARANCE_M, supportOffsetM: SUPPORT, touching: true } }
    const result = straightLineEvaluator.evaluate(forged, context())
    expect(result.status).toBe('failure')
    expect(result.checkpointIds).toBeUndefined()
  })

  it('rejects wrong-order arrival and a constant-speed pass through the final ring', () => {
    const wrongOrder = straightLineEvaluator.evaluate(sample(10, 6, 1), context({ checkpoints: routeCheckpoints() }))
    expect(wrongOrder.status).toBe('failure')
    expect(wrongOrder.message).toMatch(/順序/)
    const passThrough = run([
      ...takeoffFixture(), sample(45, 0),
      ...Array.from({ length: 47 }, (_, index) => sample(index + 46, (index + 1) * 0.2, 2)),
    ])
    expect(passThrough.phase).toBe('FAILED')
    expect(passThrough.checkpoints['straight-transit']?.completed).toBe(true)
    expect(passThrough.checkpoints['straight-brake']?.completed).toBe(false)
    expect(passThrough.checkpoints['straight-stop']?.completed).toBe(false)
    expect(passThrough.result?.message).toMatch(/降速/)
  })

  it('counts observed braking while crossing the brake plane without requiring an exact five-metre sample', () => {
    const previous = sample(50, 4.9, 2)
    const current = sample(51, 5.05, 1)
    const evaluation = straightLineEvaluator.evaluate(current, context({
      previousSample: previous, checkpoints: routeCheckpoints(true),
      previousEvaluation: { status: 'continue', metrics: { peakForwardSpeedMps: 2, furthestProgressM: 4.9 } },
    }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.metrics?.brakeEntrySpeedMps).toBeCloseTo(4 / 3)
    // Entry at 1.333m/s to 1m/s has not yet reduced by 30%; a subsequent
    // continuous in-zone reduction must still be observed.
    expect(evaluation.checkpointIds).not.toContain('straight-brake')
    const next = sample(52, 5.135, 0.7)
    const braked = straightLineEvaluator.evaluate(next, context({
      previousSample: current, checkpoints: routeCheckpoints(true), previousEvaluation: evaluation,
    }))
    expect(braked.checkpointIds).toContain('straight-brake')
  })

  it('counts a slow genuine transit crossing instead of leaving the learner stuck after the ring', () => {
    const previous = sample(50, 2.99, 0.2)
    const current = sample(51, 3.01, 0.2)
    const evaluation = straightLineEvaluator.evaluate(current, context({ previousSample: previous, checkpoints: routeCheckpoints() }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).toContain('straight-transit')
    expect(evaluation.metrics?.routePhase).toBe(2)
  })

  it('does not count speed reductions which only occur after the eight-metre brake zone', () => {
    const previous = sample(50, 8.05, 1.5)
    const current = sample(51, 8.16, 0.7)
    const evaluation = straightLineEvaluator.evaluate(current, context({
      previousSample: previous, checkpoints: routeCheckpoints(true),
      previousEvaluation: { status: 'continue', metrics: { brakeEntrySpeedMps: 2, furthestProgressM: 8.05 } },
    }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).not.toContain('straight-brake')
  })

  it('accepts a slow complete route with genuine 0.3 to 0.1 m/s braking, without requiring fast flight', () => {
    const route: TrainingSample[] = [...takeoffFixture()]
    let distance = 0
    let speed = 0
    const append = (nextSpeed: number): void => {
      distance += (speed + nextSpeed) * 0.5 * 0.1
      speed = nextSpeed
      route.push(sample(route.length, distance, speed))
    }
    append(0)
    for (let index = 1; index <= 10; index += 1) append(index * 0.03)
    while (distance < 5.1 - 1e-8) append(0.3)
    for (let index = 1; index <= 10; index += 1) append(0.3 - index * 0.02)
    while (distance < 7.95 - 1e-8) append(0.1)
    for (let index = 1; index <= 10; index += 1) append(0.1 - index * 0.01)
    for (let index = 0; index < 20; index += 1) append(0)
    const result = run(route)
    expect(result.phase, result.result?.message).toBe('SUCCESS')
    expect(result.result?.metrics.brakeEntrySpeedMps).toBeCloseTo(0.3)
    expect(result.result?.completedCheckpoints).toBe(5)
  })

  it('does not count a small 0.02 m/s fluctuation as braking', () => {
    const previous = sample(50, 5.2, 0.3)
    const current = sample(51, 5.229, 0.28)
    const evaluation = straightLineEvaluator.evaluate(current, context({
      previousSample: previous, checkpoints: routeCheckpoints(true),
      previousEvaluation: { status: 'continue', metrics: { brakeEntrySpeedMps: 0.3, furthestProgressM: 5.2 } },
    }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).not.toContain('straight-brake')
  })

  it('evaluates a valid final braking sample before declaring a missed brake zone', () => {
    const previous = sample(50, 7.3, 1.5)
    const current = sample(51, 7.41, 0.7)
    const evaluation = straightLineEvaluator.evaluate(current, context({
      previousSample: previous, checkpoints: routeCheckpoints(true),
      previousEvaluation: { status: 'continue', metrics: { brakeEntrySpeedMps: 2, furthestProgressM: 7.3 } },
    }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).toContain('straight-brake')
    expect(evaluation.metrics?.routePhase).toBe(3)
    expect(evaluation.hint).toMatch(/終點區|穩住/)
  })

  it('resets endpoint dwell when velocity leaves the settled bound', () => {
    const fixture = successFixture()
    const interruptIndex = 110
    const interrupted = fixture.map((current, index) => index === interruptIndex ? {
      ...current, state: { ...current.state, velocityMps: { x: 0.5, y: 0, z: 0 } },
    } : current)
    const beforeComplete = run(interrupted.slice(0, 119))
    expect(beforeComplete.phase).toBe('ACTIVE')
    expect(beforeComplete.lastEvaluation?.metrics?.contiguousDwellSeconds).toBeLessThan(STRAIGHT_LINE_SETTLED_DWELL_SECONDS)
    expect(run(interrupted).phase).toBe('SUCCESS')
  })

  it('requires in-zone deceleration rather than reusing a pre-zone peak when already slow', () => {
    const previous = sample(50, 5.2, 0.15)
    const current = sample(51, 5.215, 0.15)
    const evaluation = straightLineEvaluator.evaluate(current, context({
      previousSample: previous, checkpoints: routeCheckpoints(true),
      previousEvaluation: { status: 'continue', metrics: { peakForwardSpeedMps: 2, furthestProgressM: 5.2 } },
    }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).not.toContain('straight-brake')
    expect(evaluation.metrics?.brakeEntrySpeedMps).toBe(0)
  })

  it('uses the configured ground height even when a free-flight spawn is elevated', () => {
    const shifted = { x: 12, y: 10, z: -7 }
    const groundHeight = 3.5
    const references = [
      { id: 'takeoff-pad', kind: 'pad', positionM: shifted },
      { id: 'training-launch', kind: 'spawn', positionM: { ...shifted, y: groundHeight + SUPPORT + DRONE_GROUND_CLEARANCE_M } },
      { id: 'landing-surface', kind: 'zone', positionM: { ...shifted, y: groundHeight, z: shifted.z - 8 } },
    ]
    const original = sample(0, 0)
    const shiftedStart = { ...original, groundContact: { heightM: groundHeight, supportOffsetM: SUPPORT, touching: false }, state: {
      ...original.state, positionM: { x: shifted.x, y: groundHeight + STRAIGHT_LINE_TARGET_HEIGHT_AGL_M, z: shifted.z },
    } }
    const valid = straightLineEvaluator.evaluate(shiftedStart, context({
      sceneReferences: references, checkpoints: { 'straight-ground': checkpoint('straight-ground') },
    }))
    expect(valid.checkpointIds).toContain('straight-start')
    const wrongAltitude = straightLineEvaluator.evaluate({ ...original, state: {
      ...original.state, positionM: { ...original.state.positionM, y: ALTITUDE + 1 },
    } }, context({ checkpoints: routeCheckpoints() }))
    expect(wrongAltitude.status).toBe('failure')
    expect(wrongAltitude.message).toMatch(/高度/)
  })

  it('returns local practice recovery that requires a fresh grounded start and extends challenge time for takeoff', () => {
    const first = sample(0, 0, 0, GROUND_COM)
    const outside = { ...first, state: { ...first.state, positionM: { ...first.state.positionM, x: 1.3 } } }
    const practice = straightLineEvaluator.evaluate(outside, context({ mode: 'practice' }))
    expect(practice.status).toBe('continue')
    expect(practice.recovery).toBe('restart')
    expect(practice.metrics?.routePhase).toBe(0)
    expect(straightLineEvaluator.evaluate(outside, context({ mode: 'challenge' })).status).toBe('failure')
    expect(straightLineEvaluator.evaluate(first, context({ elapsedSeconds: 91, mode: 'practice' })).status).toBe('continue')
    expect(straightLineEvaluator.evaluate(first, context({ elapsedSeconds: 91, mode: 'challenge' })).message).toMatch(/逾時/)
    const inAir = straightLineEvaluator.evaluate(sample(1, 0), context({ mode: 'practice', previousEvaluation: practice }))
    expect(inAir.recovery).toBe('restart')
    expect(inAir.checkpointIds).toBeUndefined()
  })

  it('rejects teleports, sample gaps, clock rewind and physics reset even after practice recovery', () => {
    const previous = sample(0, 0)
    const teleport = straightLineEvaluator.evaluate(sample(1, 8), context({
      mode: 'practice', previousFlightSample: previous, previousSample: null,
    }))
    expect(teleport.status).toBe('failure')
    expect(teleport.recovery).toBeUndefined()
    expect(teleport.message).toMatch(/位置跳躍/)
    for (const current of [
      { ...sample(1, 0), timestampSeconds: 1 },
      { ...sample(1, 0), timestampSeconds: 0.05 },
      { ...sample(1, 0), state: { ...sample(1, 0).state, timeSeconds: 0 } },
      { ...sample(1, 0), state: { ...sample(1, 0).state, stepIndex: 0 } },
    ]) {
      const evaluation = straightLineEvaluator.evaluate(current, context({ mode: 'practice', previousFlightSample: previous, previousSample: null }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
      expect(evaluation.message).toMatch(/時間|中斷|重設/)
    }
  })

  it('rejects disarm, crash, nonfinite values and missing contact/references in either mode', () => {
    const first = sample(0, 0, 0, GROUND_COM)
    for (const mode of ['practice', 'challenge'] as const) {
      for (const invalid of [
        { ...first, armed: false },
        { ...first, state: { ...first.state, crashed: true } },
        { ...first, timestampSeconds: NaN },
        { ...first, groundContact: undefined },
        { ...first, state: { ...first.state, positionM: { x: 0, y: NaN, z: 0 } } },
      ]) expect(straightLineEvaluator.evaluate(invalid, context({ mode })).status).toBe('failure')
      expect(straightLineEvaluator.evaluate(first, context({ mode, sceneReferences: [] })).status).toBe('failure')
    }
    expect(straightLineEvaluator.evaluate({ ...first, armed: undefined }, context()).status).toBe('continue')
    const tilted = { ...first, state: {
      ...first.state, orientation: quaternionFromRotationVector({ x: Math.PI / 3, y: 0, z: 0 }),
    } }
    expect(straightLineEvaluator.evaluate(tilted, context({ mode: 'practice' })).recovery).toBe('restart')
  })
})
