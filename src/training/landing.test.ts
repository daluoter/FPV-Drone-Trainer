import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { IDENTITY_QUATERNION } from '../math/quaternion'
import { LANDING_LESSON, LANDING_SETTLED_DWELL_SECONDS, landingEvaluator } from './landing'
import { TrainingSession } from './machine'
import type { TrainingAttemptContext } from './attempt'
import type { TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'

const GROUND_HEIGHT = DEFAULT_DRONE_CONFIG.ground.heightM
const SUPPORT_HEIGHT = droneGroundSupport(DEFAULT_DRONE_CONFIG, IDENTITY_QUATERNION).supportOffsetM
const CONTACT_HEIGHT = GROUND_HEIGHT + SUPPORT_HEIGHT + DRONE_GROUND_CLEARANCE_M
const REFERENCES: readonly TrainingSceneReference[] = [
  { id: 'training-launch', kind: 'spawn', positionM: { x: 0, y: CONTACT_HEIGHT, z: 0 } },
  { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: GROUND_HEIGHT, z: -8 }, sizeM: { x: 2.4, y: 0, z: 2.4 } },
]
const PRACTICE: TrainingAttemptContext = {
  rulesVersion: 2, physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}',
  inputSource: 'keyboard', mode: 'practice', assistance: 'none',
}

function sample(index: number, heightM: number, verticalSpeed = 0, z = 0, x = 0, zSpeed = 0): TrainingSample {
  const state = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x, y: heightM, z })
  const timestampSeconds = (index + 1) * 0.1
  return {
    timestampSeconds,
    armed: true,
    groundContact: { heightM: GROUND_HEIGHT, supportOffsetM: SUPPORT_HEIGHT, touching: heightM <= CONTACT_HEIGHT + 1e-8 },
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: verticalSpeed < 0 ? 0.3 : heightM > CONTACT_HEIGHT ? 0.4 : 0 },
    state: { ...state, velocityMps: { x: 0, y: verticalSpeed, z: zSpeed }, timeSeconds: timestampSeconds, stepIndex: index + 1 },
  }
}

/** Continuous geometric fixture: grounded launch, ascent, travel, descent, grounded dwell. */
function successFixture(targetX = 0): readonly TrainingSample[] {
  const trace: TrainingSample[] = []
  const append = (height: number, verticalSpeed = 0, z = 0, x = 0, zSpeed = 0) => trace.push(sample(trace.length, height, verticalSpeed, z, x, zSpeed))
  for (let index = 0; index < 3; index += 1) append(CONTACT_HEIGHT)
  for (let index = 1; index <= 60; index += 1) {
    const fraction = index / 60
    const eased = fraction * fraction * (3 - 2 * fraction)
    const speed = (3 - CONTACT_HEIGHT) * 6 * fraction * (1 - fraction) / 6
    append(CONTACT_HEIGHT + (3 - CONTACT_HEIGHT) * eased, speed)
  }
  for (let index = 1; index <= 100; index += 1) {
    const fraction = index / 100
    const eased = fraction * fraction * (3 - 2 * fraction)
    append(3, 0, -8 * eased, targetX * eased, -8 * 6 * fraction * (1 - fraction) / 10)
  }
  for (let index = 1; index <= 60; index += 1) {
    append(3 + (CONTACT_HEIGHT + 0.02 - 3) * index / 60, -0.5, -8, targetX)
  }
  for (let index = 0; index < 15; index += 1) append(CONTACT_HEIGHT, 0, -8, targetX)
  return trace
}

function touchdownIndex(trace: readonly TrainingSample[]): number {
  return trace.findIndex((current, index) => index > 3 && current.groundContact?.touching)
}

function newSession(practice = false): TrainingSession {
  const session = new TrainingSession({
    lessons: [LANDING_LESSON], initialLessonId: 'landing', sceneReferences: REFERENCES,
    countdownDurationSeconds: 0, ...(practice ? { attemptContext: PRACTICE } : {}),
  })
  session.start(0)
  session.tick(0)
  return session
}
function run(samples: readonly TrainingSample[]) {
  const session = newSession()
  for (const current of samples) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}
function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: LANDING_LESSON, elapsedSeconds: 0, checkpoints: {}, trajectory: [], sceneReferences: REFERENCES, ...overrides }
}


describe('ground-to-separate-zone landing lesson', () => {
  it('waits safely on the ground, then passes a complete takeoff, transit, gentle touchdown and dwell', () => {
    const initial = run(Array.from({ length: 20 }, (_, index) => sample(index, CONTACT_HEIGHT)))
    expect(initial.phase).toBe('ACTIVE')
    expect(initial.checkpoints['landing-launch']?.completed).toBe(true)
    expect(initial.checkpoints['landing-liftoff']?.completed).toBe(false)
    expect(initial.lastEvaluation?.hint).toMatch(/離地|起飛/)
    const landed = run(successFixture())
    expect(landed.phase).toBe('SUCCESS')
    expect(landed.result?.completedCheckpoints).toBe(5)
    expect(landed.result?.metrics.groundTouching).toBe(1)
    expect(landed.result?.metrics.touchdownDescentSpeedMps).toBeCloseTo(0.5)
    expect(landed.result?.metrics.contiguousDwellSeconds).toBeGreaterThanOrEqual(LANDING_SETTLED_DWELL_SECONDS)
    expect(landed.result?.score).toBeGreaterThanOrEqual(90)
  })

  it('rejects starting in the target, starting airborne, and ground-only travel', () => {
    expect(run([sample(0, CONTACT_HEIGHT, 0, -8)]).phase).toBe('FAILED')
    expect(run([sample(0, 3)]).phase).toBe('FAILED')
    const groundTravel = [sample(0, CONTACT_HEIGHT), ...Array.from({ length: 80 }, (_, index) => sample(index + 1, CONTACT_HEIGHT, 0, -(index + 1) * 0.04, 0, -0.4))]
    const result = run(groundTravel)
    expect(result.phase).toBe('FAILED')
    expect(result.result?.message).toMatch(/自行離地|起飛區/)
    expect(result.checkpoints['landing-liftoff']?.completed).toBe(false)
  })

  it('requires actual contact, not hovering just above the destination or fabricated midair touching', () => {
    const fixture = successFixture()
    const end = touchdownIndex(fixture)
    const hovering = [...fixture.slice(0, end - 3), ...Array.from({ length: 30 }, (_, index) => sample(index + end - 3, CONTACT_HEIGHT + 0.2, 0, -8))]
    const pending = run(hovering)
    expect(pending.phase).toBe('ACTIVE')
    expect(pending.checkpoints['landing-touchdown']?.completed).toBe(false)
    const fake = sample(0, 3)
    expect(landingEvaluator.evaluate({ ...fake, groundContact: { ...fake.groundContact!, touching: true } }, context()).message).toMatch(/接地標記/)
  })

  it('checks pre-impact speed instead of the contact-solver zero velocity', () => {
    const fixture = successFixture()
    const contact = touchdownIndex(fixture)
    const rough = fixture.map((current, index) => index === contact - 1
      ? { ...current, state: { ...current.state, velocityMps: { x: 0, y: -1.8, z: 0 } } }
      : current)
    const result = run(rough)
    expect(result.phase).toBe('FAILED')
    expect(result.result?.message).toMatch(/接地前|歸零/)
    expect(result.result?.metrics.touchdownDescentSpeedMps).toBeCloseTo(1.8)
  })

  it('requires the separate specified landing zone and cannot land back on the launch point', () => {
    const wrong = run(successFixture(1))
    expect(wrong.phase).toBe('FAILED')
    expect(wrong.result?.message).toMatch(/降落區|其他位置/)
    const trace = successFixture()
    const liftEnd = trace.findIndex((current) => current.state.positionM.y === 3)
    const atLaunch = [
      ...trace.slice(0, liftEnd + 1),
      ...Array.from({ length: 60 }, (_, index) => sample(index + liftEnd + 1, 3 + (CONTACT_HEIGHT + 0.02 - 3) * (index + 1) / 60, -0.5)),
      sample(liftEnd + 61, CONTACT_HEIGHT),
    ]
    expect(run(atLaunch).phase).toBe('FAILED')
  })

  it('resets grounded continuous dwell after a speed excursion', () => {
    const fixture = successFixture()
    const contact = touchdownIndex(fixture)
    const interrupted = fixture.map((current, index) => index === contact + 4
      ? { ...current, state: { ...current.state, velocityMps: { x: 0.3, y: 0, z: 0 } } }
      : current)
    const short = run(interrupted)
    expect(short.phase).toBe('ACTIVE')
    expect(short.lastEvaluation?.metrics?.contiguousDwellSeconds).toBeLessThan(LANDING_SETTLED_DWELL_SECONDS)
    expect(run([...interrupted, ...Array.from({ length: 10 }, (_, index) => sample(index + fixture.length, CONTACT_HEIGHT, 0, -8))]).phase).toBe('SUCCESS')
  })

  it('rechecks pre-impact speed after a small hop and restarts ordinary practice misses', () => {
    const fixture = successFixture()
    const contact = touchdownIndex(fixture)
    const bounced = fixture.map((current, index) => index === contact + 2 ? sample(index, CONTACT_HEIGHT + 0.02, -1.2, -8) : current)
    const rough = run(bounced)
    expect(rough.phase).toBe('FAILED')
    expect(rough.checkpoints['landing-touchdown']?.completed).toBe(true)
    expect(rough.result?.metrics.touchdownDescentSpeedMps).toBeCloseTo(1.2)
    const practice = newSession(true)
    let recovered = false
    for (const current of bounced) {
      const state = practice.consumeSample(current)
      if (state.lastEvaluation?.recovery === 'restart') {
        recovered = true
        expect(state.phase).toBe('ACTIVE')
        expect(Object.values(state.checkpoints).every((checkpoint) => !checkpoint.completed)).toBe(true)
        break
      }
    }
    expect(recovered).toBe(true)
  })

  it('allows controlled small recontact but requires a fresh grounded dwell', () => {
    const fixture = successFixture()
    const contact = touchdownIndex(fixture)
    const gentle = fixture.map((current, index) => index === contact + 2 ? sample(index, CONTACT_HEIGHT + 0.02, -0.4, -8) : current)
    expect(run(gentle.slice(0, contact + 13)).phase).toBe('ACTIVE')
    expect(run(gentle).phase).toBe('SUCCESS')
  })

  it('rejects crash, disarm, missing or invalid actual-contact data and nonfinite state', () => {
    const first = sample(0, CONTACT_HEIGHT)
    for (const invalid of [
      { ...first, armed: false },
      { ...first, state: { ...first.state, crashed: true } },
      { ...first, groundContact: undefined },
      { ...first, groundContact: { ...first.groundContact!, heightM: GROUND_HEIGHT + 1 } },
      { ...first, state: { ...first.state, velocityMps: { x: Infinity, y: 0, z: 0 } } },
    ]) {
      const result = landingEvaluator.evaluate(invalid, context({ mode: 'practice' }))
      expect(result.status).toBe('failure')
      expect(result.recovery).toBeUndefined()
    }
    expect(landingEvaluator.evaluate({ ...first, armed: undefined }, context()).status).toBe('continue')
  })

  it('rejects gaps, teleports and frozen physics even across local practice restart', () => {
    const before = sample(0, CONTACT_HEIGHT)
    const previous = context({ mode: 'practice', previousFlightSample: before })
    for (const invalid of [sample(1, 3, 0, -8), { ...sample(1, CONTACT_HEIGHT), timestampSeconds: 1 }, { ...before, timestampSeconds: 0.2 }]) {
      const failure = landingEvaluator.evaluate(invalid, previous)
      expect(failure.status).toBe('failure')
      expect(failure.recovery).toBeUndefined()
    }
    const fixture = successFixture()
    const contact = touchdownIndex(fixture)
    const frozen = fixture[contact + 1]!
    expect(run(fixture.map((current, index) => index > contact + 1 ? { ...current, state: frozen.state } : current)).phase).toBe('FAILED')
  })

  it('keeps practice untimed and allows enough challenge time for takeoff and travel', () => {
    const first = sample(0, CONTACT_HEIGHT)
    expect(landingEvaluator.evaluate(first, context({ mode: 'practice', elapsedSeconds: 120 })).status).toBe('continue')
    expect(landingEvaluator.evaluate(first, context({ mode: 'challenge', elapsedSeconds: 36 })).status).toBe('continue')
    expect(landingEvaluator.evaluate(first, context({ mode: 'challenge', elapsedSeconds: 91 })).message).toMatch(/逾時/)
    const missed = sample(0, CONTACT_HEIGHT, 0, 0, 2)
    expect(landingEvaluator.evaluate(missed, context({ mode: 'practice' })).recovery).toBe('restart')
    expect(landingEvaluator.evaluate(missed, context({ mode: 'challenge' })).status).toBe('failure')
  })
})
