import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import { quaternionFromRotationVector } from '../math/quaternion'
import { TRAINING_SCENE_REFERENCES } from './fixtures'
import { DEFAULT_LESSONS } from './lessons'
import { TrainingSession } from './machine'
import { takeoffEvaluator, TAKEOFF_SETTLED_DWELL_SECONDS, TAKEOFF_TARGET_HEIGHT_M } from './takeoff'
import type { TrainingEvaluationContext, TrainingSample } from './types'

const PAD_HEIGHT = TRAINING_SCENE_REFERENCES.find((reference) => reference.id === 'takeoff-pad')!.positionM.y

function sample(index: number, heightM: number, verticalSpeedMps = 0): TrainingSample {
  const timestampSeconds = (index + 1) * 0.1
  return {
    timestampSeconds,
    armed: true,
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.45 },
    state: {
      ...createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: 0, y: heightM, z: 0 }),
      velocityMps: { x: 0, y: verticalSpeedMps, z: 0 },
      stepIndex: index + 1,
      timeSeconds: timestampSeconds,
    },
  }
}

function takeoffFixture(): readonly TrainingSample[] {
  const samples = Array.from({ length: 21 }, (_, index) => sample(
    index,
    PAD_HEIGHT + index * TAKEOFF_TARGET_HEIGHT_M / 20,
    index === 0 || index === 20 ? 0 : 1,
  ))
  return [...samples, ...Array.from({ length: 19 }, (_, index) => sample(index + 21, PAD_HEIGHT + TAKEOFF_TARGET_HEIGHT_M))]
}

function run(samples: readonly TrainingSample[]) {
  const session = new TrainingSession({
    lessons: DEFAULT_LESSONS,
    initialLessonId: 'takeoff',
    countdownDurationSeconds: 0,
    sceneReferences: TRAINING_SCENE_REFERENCES,
  })
  session.start(0)
  session.tick(0)
  for (const current of samples) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return {
    lesson: DEFAULT_LESSONS.find((lesson) => lesson.id === 'takeoff')!,
    elapsedSeconds: 0.1,
    trajectory: [],
    checkpoints: {},
    sceneReferences: TRAINING_SCENE_REFERENCES,
    ...overrides,
  }
}

describe('takeoff lesson', () => {
  it('allows unlimited explicit practice and restarts ordinary takeoff errors while preserving challenge failures', () => {
    const initial = sample(0, PAD_HEIGHT)
    const practice = context({ mode: 'practice', elapsedSeconds: 120 })
    expect(takeoffEvaluator.evaluate(initial, practice).status).toBe('continue')
    const challenge = takeoffEvaluator.evaluate(initial, context({ elapsedSeconds: 120 }))
    expect(challenge.status).toBe('failure')
    expect(challenge.message).toMatch(/逾時/)

    const ready = { id: 'takeoff-ready', completed: true, completedAtSeconds: 0.1, metrics: {} }
    const lifted = { id: 'takeoff-liftoff', completed: true, completedAtSeconds: 0.8, metrics: {} }
    for (const [current, overrides] of [
      [{ ...initial, state: { ...initial.state, positionM: { x: 4.1, y: PAD_HEIGHT, z: 0 } } }, {}],
      [sample(0, PAD_HEIGHT + TAKEOFF_TARGET_HEIGHT_M), {}],
      [initial, { checkpoints: { 'takeoff-ready': ready, 'takeoff-liftoff': lifted } }],
    ] as const) {
      const recovered = takeoffEvaluator.evaluate(current, context({ ...overrides, mode: 'practice' }))
      expect(recovered.status).toBe('continue')
      expect(recovered.recovery).toBe('restart')
      expect(takeoffEvaluator.evaluate(current, context(overrides)).status).toBe('failure')
    }
  })

  it('retains continuous-flight integrity checks after a practice restart clears the local previous sample', () => {
    const previousFlightSample = sample(0, PAD_HEIGHT)
    const practice = context({ mode: 'practice', previousSample: null, previousFlightSample })
    const teleport = takeoffEvaluator.evaluate(sample(1, PAD_HEIGHT + TAKEOFF_TARGET_HEIGHT_M), practice)
    expect(teleport.status).toBe('failure')
    expect(teleport.recovery).toBeUndefined()
    const gap = takeoffEvaluator.evaluate({ ...sample(1, PAD_HEIGHT), timestampSeconds: 1 }, practice)
    expect(gap.status).toBe('failure')
    expect(gap.recovery).toBeUndefined()
  })

  it('rejects frozen target states with relabelled timestamps', () => {
    const before = sample(0, PAD_HEIGHT + TAKEOFF_TARGET_HEIGHT_M)
    expect(takeoffEvaluator.evaluate({ ...before, timestampSeconds: 0.2 }, context({ previousFlightSample: before })).status).toBe('failure')
    const fixture = takeoffFixture()
    const frozen = fixture[22]!
    expect(run(fixture.map((current, index) => index > 22 ? { ...current, state: frozen.state } : current)).phase).toBe('FAILED')
  })

  it('requires a real pad departure and a continuous settled target-altitude dwell', () => {
    const result = run(takeoffFixture())
    expect(result.phase).toBe('SUCCESS')
    expect(result.result?.completedCheckpoints).toBe(3)
    expect(result.result?.metrics.contiguousDwellSeconds).toBeGreaterThanOrEqual(TAKEOFF_SETTLED_DWELL_SECONDS)
    expect(result.result?.metrics.altitudeM).toBeCloseTo(TAKEOFF_TARGET_HEIGHT_M)
    expect(result.result?.score).toBe(100)
  })

  it('does not pass a stick sequence while still on the pad or an airborne start', () => {
    const grounded = run(Array.from({ length: 45 }, (_, index) => ({
      ...sample(index, PAD_HEIGHT),
      normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: index % 2 ? 1 : 0 },
    })))
    expect(grounded.phase).toBe('ACTIVE')
    expect(grounded.checkpoints['takeoff-liftoff']?.completed).toBe(false)
    const airborne = run(Array.from({ length: 40 }, (_, index) => sample(index, PAD_HEIGHT + TAKEOFF_TARGET_HEIGHT_M)))
    expect(airborne.phase).toBe('FAILED')
    expect(airborne.result?.message).toMatch(/空中|起飛墊/)
  })

  it('resets the dwell when speed exceeds the settled bound even while position stays in the target', () => {
    const fixture = takeoffFixture().map((current, index) => index === 28 ? {
      ...current,
      state: { ...current.state, velocityMps: { x: 1, y: 0, z: 0 } },
    } : current)
    const interrupted = run(fixture)
    expect(interrupted.phase).toBe('ACTIVE')
    expect(interrupted.lastEvaluation?.metrics?.contiguousDwellSeconds).toBeLessThan(TAKEOFF_SETTLED_DWELL_SECONDS)
    const extended = run([...fixture, ...Array.from({ length: 10 }, (_, index) => sample(40 + index, PAD_HEIGHT + TAKEOFF_TARGET_HEIGHT_M))])
    expect(extended.phase).toBe('SUCCESS')
  })

  it('requires low vertical speed throughout the dwell, not merely reaching the correct altitude', () => {
    const moving = run(takeoffFixture().map((current, index) => index >= 20 ? {
      ...current,
      state: { ...current.state, velocityMps: { x: 0, y: 1, z: 0 } },
    } : current))
    expect(moving.phase).toBe('ACTIVE')
    expect(moving.lastEvaluation?.metrics?.contiguousDwellSeconds).toBe(0)
  })

  it('rejects teleporting to the target, inconsistent positions, and telemetry gaps', () => {
    const first = sample(0, PAD_HEIGHT)
    const teleport = run([first, sample(1, PAD_HEIGHT + TAKEOFF_TARGET_HEIGHT_M)])
    expect(teleport.phase).toBe('FAILED')
    expect(teleport.result?.message).toMatch(/位置跳躍/)
    const inconsistent = takeoffEvaluator.evaluate({ ...sample(1, PAD_HEIGHT + 0.4), state: {
      ...sample(1, PAD_HEIGHT + 0.4).state,
      velocityMps: { x: 0, y: 0, z: 0 },
    } }, context({ previousSample: first }))
    expect(inconsistent.status).toBe('failure')
    expect(inconsistent.metrics?.velocityConsistencyErrorM).toBeGreaterThan(inconsistent.metrics?.integrationToleranceM ?? Infinity)
    const later = sample(1, PAD_HEIGHT)
    const gap = run([first, { ...later, timestampSeconds: 1, state: { ...later.state, timeSeconds: 1 } }])
    expect(gap.phase).toBe('FAILED')
    expect(gap.result?.message).toMatch(/中斷/)
  })

  it('fails safely on nonfinite state, crash, disarm, invalid reference, or excessive tilt', () => {
    const initial = sample(0, PAD_HEIGHT)
    const invalid = { ...initial, state: { ...initial.state, velocityMps: { x: NaN, y: 0, z: 0 } } }
    expect(takeoffEvaluator.evaluate(invalid, context()).status).toBe('failure')
    expect(takeoffEvaluator.evaluate({ ...initial, state: { ...initial.state, crashed: true } }, context()).status).toBe('failure')
    expect(takeoffEvaluator.evaluate({ ...initial, armed: false }, context()).status).toBe('failure')
    expect(takeoffEvaluator.evaluate({ ...initial, armed: undefined }, context()).status).toBe('continue')
    expect(takeoffEvaluator.evaluate(initial, context({ sceneReferences: [] })).status).toBe('failure')
    const tilted = { ...initial, state: { ...initial.state, orientation: quaternionFromRotationVector({ x: Math.PI / 3, y: 0, z: 0 }) } }
    expect(takeoffEvaluator.evaluate(tilted, context()).status).toBe('failure')
  })

  it('rejects excessive departure, climb speed, and altitude before a result can pass', () => {
    const initial = sample(0, PAD_HEIGHT)
    const unsafeStates = [
      { ...initial.state, positionM: { x: 4.1, y: PAD_HEIGHT, z: 0 } },
      { ...initial.state, positionM: { x: 0, y: PAD_HEIGHT + 6.1, z: 0 } },
      { ...initial.state, velocityMps: { x: 4.1, y: 0, z: 0 } },
      { ...initial.state, velocityMps: { x: 0, y: 3.6, z: 0 } },
    ]
    for (const state of unsafeStates) {
      const evaluation = takeoffEvaluator.evaluate({ ...initial, state }, context())
      expect(evaluation.status).toBe('failure')
      expect(evaluation.message).toMatch(/安全/)
      expect(Object.values(evaluation.metrics ?? {}).every(Number.isFinite)).toBe(true)
    }
  })

  it('stops a landing after liftoff and a timed-out test without awarding a pass', () => {
    const ready = { id: 'takeoff-ready', completed: true, completedAtSeconds: 0.1, metrics: {} }
    const lifted = { id: 'takeoff-liftoff', completed: true, completedAtSeconds: 0.8, metrics: {} }
    const landed = takeoffEvaluator.evaluate(sample(10, PAD_HEIGHT), context({
      elapsedSeconds: 1.1,
      checkpoints: { 'takeoff-ready': ready, 'takeoff-liftoff': lifted },
    }))
    expect(landed.status).toBe('failure')
    expect(landed.message).toMatch(/落回/)
    const timedOut = takeoffEvaluator.evaluate(sample(260, PAD_HEIGHT), context({ elapsedSeconds: 26 }))
    expect(timedOut.status).toBe('failure')
    expect(timedOut.message).toMatch(/逾時/)
  })
})
