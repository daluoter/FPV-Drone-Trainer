import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { IDENTITY_QUATERNION } from '../math/quaternion'
import { stepDroneState } from '../simulation/dynamics'
import { LANDING_LESSON, LANDING_ZONE_RADIUS_M, landingEvaluator } from './landing'
import { TrainingSession } from './machine'
import type { TrainingAttemptContext } from './attempt'
import type { TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'

const GROUND_HEIGHT = DEFAULT_DRONE_CONFIG.ground.heightM
const SUPPORT_HEIGHT = droneGroundSupport(DEFAULT_DRONE_CONFIG, IDENTITY_QUATERNION).supportOffsetM
const CONTACT_HEIGHT = GROUND_HEIGHT + SUPPORT_HEIGHT + DRONE_GROUND_CLEARANCE_M
const REFERENCES: readonly TrainingSceneReference[] = [
  { id: 'training-launch', kind: 'spawn', positionM: { x: 0, y: CONTACT_HEIGHT, z: 0 } },
  { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: GROUND_HEIGHT, z: -8 }, sizeM: { x: LANDING_ZONE_RADIUS_M * 2, y: 0, z: LANDING_ZONE_RADIUS_M * 2 } },
]
const PRACTICE: TrainingAttemptContext = {
  rulesVersion: 4, physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}',
  inputSource: 'keyboard', mode: 'practice', assistance: 'none',
}

function sample(index: number, heightM: number, verticalSpeed = 0, z = 0, x = 0, zSpeed = 0): TrainingSample {
  const state = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x, y: heightM, z })
  const timestampSeconds = (index + 1) * 0.1
  return {
    timestampSeconds, armed: true,
    groundContact: { heightM: GROUND_HEIGHT, supportOffsetM: SUPPORT_HEIGHT, touching: heightM <= CONTACT_HEIGHT + 1e-8 },
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: verticalSpeed < 0 ? 0.3 : heightM > CONTACT_HEIGHT ? 0.4 : 0 },
    state: { ...state, velocityMps: { x: 0, y: verticalSpeed, z: zSpeed }, timeSeconds: timestampSeconds, stepIndex: index + 1 },
  }
}

/** Continuous geometric fixture: grounded launch, ascent, travel, descent. */
function flightToLanding(targetX = 0): readonly TrainingSample[] {
  const trace: TrainingSample[] = []
  const append = (height: number, verticalSpeed = 0, z = 0, x = 0, zSpeed = 0) => trace.push(sample(trace.length, height, verticalSpeed, z, x, zSpeed))
  for (let index = 0; index < 3; index++) append(CONTACT_HEIGHT)
  for (let index = 1; index <= 60; index++) {
    const fraction = index / 60
    const eased = fraction * fraction * (3 - 2 * fraction)
    append(CONTACT_HEIGHT + (3 - CONTACT_HEIGHT) * eased, (3 - CONTACT_HEIGHT) * 6 * fraction * (1 - fraction) / 6)
  }
  for (let index = 1; index <= 100; index++) {
    const fraction = index / 100
    const eased = fraction * fraction * (3 - 2 * fraction)
    const current = sample(trace.length, 3, 0, -8 * eased, targetX * eased, -8 * 6 * fraction * (1 - fraction) / 10)
    trace.push({ ...current, state: { ...current.state, velocityMps: { ...current.state.velocityMps, x: targetX * 6 * fraction * (1 - fraction) / 10 } } })
  }
  for (let index = 1; index <= 60; index++) append(3 + (CONTACT_HEIGHT + 0.02 - 3) * index / 60, -0.5, -8, targetX)
  append(CONTACT_HEIGHT, 0, -8, targetX)
  return trace
}

function newSession(mode: 'practice' | 'challenge' = 'practice', references = REFERENCES): TrainingSession {
  const session = new TrainingSession({
    lessons: [LANDING_LESSON], initialLessonId: 'landing', sceneReferences: references,
    countdownDurationSeconds: 0, attemptContext: { ...PRACTICE, mode },
  })
  session.start(0)
  session.tick(0)
  return session
}

function run(samples: readonly TrainingSample[], mode: 'practice' | 'challenge' = 'practice') {
  const session = newSession(mode)
  for (const current of samples) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: LANDING_LESSON, elapsedSeconds: 0, checkpoints: {}, trajectory: [], sceneReferences: REFERENCES, ...overrides }
}

const liftedCheckpoints = Object.fromEntries(['landing-launch', 'landing-liftoff'].map((id) => [
  id, { id, completed: true, completedAtSeconds: 0.1, metrics: {} },
]))

describe('accessible ground-to-zone landing lesson', () => {
  it.each(['practice', 'challenge'] as const)('completes %s at the first non-crashed contact without approach precision or dwell', (mode) => {
    const trace = flightToLanding(1.3)
    const before = run(trace.slice(0, -1), mode)
    expect(before.phase).toBe('ACTIVE')
    expect(before.checkpoints['landing-liftoff']?.completed).toBe(true)
    const landed = run(trace, mode)
    expect(landed.phase).toBe('SUCCESS')
    expect(landed.result?.completedCheckpoints).toBe(5)
    expect(landed.result?.metrics.groundTouching).toBe(1)
    expect(landed.result?.metrics.contiguousDwellSeconds).toBe(0)
    expect(landed.result?.score).toBe(100)
  })

  it('uses the actual ground solver to accept 1.2 m/s contact while retaining physical crash failure', () => {
    for (const impactSpeed of [1.2, 5]) {
      const previousBase = sample(9, CONTACT_HEIGHT + 0.01, -impactSpeed, -8)
      const stepped = stepDroneState(previousBase.state, [0, 0, 0, 0], DEFAULT_DRONE_CONFIG, 0.02).state
      expect(stepped.crashed).toBe(impactSpeed === 5)
      const current: TrainingSample = {
        ...previousBase, timestampSeconds: stepped.timeSeconds, state: stepped,
        groundContact: { ...previousBase.groundContact!, touching: true },
      }
      const evaluation = landingEvaluator.evaluate(current, context({ previousSample: previousBase, checkpoints: liftedCheckpoints }))
      expect(evaluation.status).toBe(impactSpeed === 5 ? 'failure' : 'success')
      if (impactSpeed === 1.2) expect(evaluation.metrics?.touchdownDescentSpeedMps).toBeCloseTo(1.2)
      else expect(evaluation.message).toContain('墜毀')
    }
  })

  it('retains takeoff progress after landing outside the zone, allowing another attempt in place', () => {
    const trace = flightToLanding(1.8)
    const session = newSession()
    for (const current of trace) session.consumeSample(current)
    const wrong = session.getState()
    expect(wrong.phase).toBe('ACTIVE')
    expect(wrong.checkpoints['landing-liftoff']?.completed).toBe(true)
    expect(wrong.lastEvaluation?.recovery).toBeUndefined()
    expect(wrong.lastEvaluation?.hint).toContain('1.80 m')
    expect(wrong.lastEvaluation?.hint).toContain('不必返回起飛點')
    // Ground sliding into the destination cannot replace air-to-ground contact.
    const start = trace.length
    for (let index = 0; index < 20; index++) {
      const current = sample(start + index, CONTACT_HEIGHT, 0, -8, 1.8 - (index + 1) * 0.04)
      session.consumeSample({ ...current, state: { ...current.state, velocityMps: { x: -0.4, y: 0, z: 0 } } })
    }
    expect(session.getState().phase).toBe('ACTIVE')
    expect(session.getState().lastEvaluation?.hint).toContain('沿地面滑入不算完成')
  })

  it('accepts a non-crashed recontact after a small bounce without resetting takeoff progress', () => {
    const previous = sample(0, CONTACT_HEIGHT + 0.02, -0.4, -8)
    const current = sample(1, CONTACT_HEIGHT, 0, -8)
    const evaluation = landingEvaluator.evaluate(current, context({ checkpoints: liftedCheckpoints, previousSample: previous }))
    expect(evaluation.status).toBe('success')
    expect(evaluation.recovery).toBeUndefined()
    const airborne = landingEvaluator.evaluate(previous, context({ checkpoints: liftedCheckpoints }))
    expect(airborne.status).toBe('continue')
    expect(airborne.hint).toContain('離地 0.02 m')
  })

  it('does not require a slow transit or perfect approach before an otherwise valid landing', () => {
    const previous = sample(0, CONTACT_HEIGHT + 0.06, -1.2, -8, 1.4, -2)
    const current = sample(1, CONTACT_HEIGHT, 0, -8.2, 1.4, -1.5)
    const evaluation = landingEvaluator.evaluate(current, context({ checkpoints: liftedCheckpoints, previousSample: previous }))
    expect(evaluation.status).toBe('success')
    expect(evaluation.metrics?.preImpactHorizontalSpeedMps).toBe(2)
  })

  it('requires ground preparation, genuine airborne travel and actual contact', () => {
    expect(run(Array.from({ length: 20 }, (_, index) => sample(index, CONTACT_HEIGHT))).phase).toBe('ACTIVE')
    expect(run([sample(0, CONTACT_HEIGHT, 0, -8)]).phase).toBe('ACTIVE')
    expect(run([sample(0, 3)]).phase).toBe('ACTIVE')
    const groundTravel = [sample(0, CONTACT_HEIGHT), ...Array.from({ length: 200 }, (_, index) => sample(index + 1, CONTACT_HEIGHT, 0, -(index + 1) * 0.04, 0, -0.4))]
    const groundOnly = run(groundTravel)
    expect(groundOnly.phase).toBe('ACTIVE')
    expect(groundOnly.checkpoints['landing-liftoff']?.completed).toBe(false)
    expect(run(flightToLanding().slice(0, -1)).phase).toBe('ACTIVE')
    const fake = sample(0, 3)
    expect(landingEvaluator.evaluate({ ...fake, groundContact: { ...fake.groundContact!, touching: true } }, context()).message).toMatch(/接地標記/)
  })

  it('uses the configured nonzero ground and the separate visible destination', () => {
    const references = REFERENCES.map((reference) => ({ ...reference, positionM: { ...reference.positionM, y: reference.positionM.y + 10 } }))
    const session = newSession('practice', references)
    for (const current of flightToLanding()) {
      session.consumeSample({ ...current,
        state: { ...current.state, positionM: { ...current.state.positionM, y: current.state.positionM.y + 10 } },
        groundContact: { ...current.groundContact!, heightM: GROUND_HEIGHT + 10 },
      })
    }
    expect(session.getState().phase).toBe('SUCCESS')
    expect(session.getState().result?.metrics.landingHeightM).toBeCloseTo(0)
  })

  it('rejects crash, disarm, invalid contact data and nonfinite state', () => {
    const first = sample(0, CONTACT_HEIGHT)
    for (const invalid of [
      { ...first, armed: false },
      { ...first, state: { ...first.state, crashed: true } },
      { ...first, groundContact: undefined },
      { ...first, groundContact: { ...first.groundContact!, heightM: GROUND_HEIGHT + 1 } },
      { ...first, state: { ...first.state, velocityMps: { x: Infinity, y: 0, z: 0 } } },
    ]) expect(landingEvaluator.evaluate(invalid, context()).status).toBe('failure')
    expect(landingEvaluator.evaluate({ ...first, armed: undefined }, context()).status).toBe('continue')
    expect(landingEvaluator.evaluate(first, context({ elapsedSeconds: Number.NaN })).status).toBe('failure')
  })

  it('rejects gaps, clock rewinds, frozen physics and teleports even with valid prior takeoff', () => {
    const before = sample(0, CONTACT_HEIGHT)
    const previous = context({ previousFlightSample: before, checkpoints: liftedCheckpoints })
    for (const invalid of [sample(1, 3, 0, -8), { ...sample(1, CONTACT_HEIGHT), timestampSeconds: 1 }, { ...before, timestampSeconds: 0.2 }]) {
      const failure = landingEvaluator.evaluate(invalid, previous)
      expect(failure.status).toBe('failure')
      expect(failure.recovery).toBeUndefined()
    }
  })

  it('keeps practice untimed while retaining the challenge time limit', () => {
    const first = sample(0, CONTACT_HEIGHT)
    expect(landingEvaluator.evaluate(first, context({ mode: 'practice', elapsedSeconds: 120 })).status).toBe('continue')
    expect(landingEvaluator.evaluate(first, context({ mode: 'challenge', elapsedSeconds: 89 })).status).toBe('continue')
    expect(landingEvaluator.evaluate(first, context({ mode: 'challenge', elapsedSeconds: 91 })).message).toMatch(/逾時/)
  })
})
