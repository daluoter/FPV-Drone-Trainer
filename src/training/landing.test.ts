import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { IDENTITY_QUATERNION } from '../math/quaternion'
import { TRAINING_SCENE_REFERENCES } from './fixtures'
import { LANDING_LESSON, LANDING_SETTLED_DWELL_SECONDS, landingEvaluator } from './landing'
import { TrainingSession } from './machine'
import type { TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'

const GROUND_HEIGHT = DEFAULT_DRONE_CONFIG.ground.heightM
const SUPPORT_HEIGHT = droneGroundSupport(DEFAULT_DRONE_CONFIG, IDENTITY_QUATERNION).supportOffsetM
const CONTACT_HEIGHT = GROUND_HEIGHT + SUPPORT_HEIGHT + DRONE_GROUND_CLEARANCE_M
const REFERENCES: readonly TrainingSceneReference[] = [
  ...TRAINING_SCENE_REFERENCES,
  { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: GROUND_HEIGHT, z: 0 }, sizeM: { x: 2.4, y: 0, z: 2.4 } },
]

function sample(index: number, heightM: number, verticalSpeed = 0, x = 0): TrainingSample {
  const state = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x, y: heightM, z: 0 })
  const timestampSeconds = (index + 1) * 0.1
  return {
    timestampSeconds,
    armed: true,
    groundContact: { heightM: GROUND_HEIGHT, supportOffsetM: SUPPORT_HEIGHT, touching: heightM <= CONTACT_HEIGHT + 1e-8 },
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: verticalSpeed < 0 ? 0.3 : 0 },
    state: { ...state, velocityMps: { x: 0, y: verticalSpeed, z: 0 }, timeSeconds: timestampSeconds, stepIndex: index + 1 },
  }
}

/** Airborne descent, a gentle final contact, then a continuous grounded hold. */
function successFixture(x = 0): readonly TrainingSample[] {
  const air = Array.from({ length: 61 }, (_, index) => sample(
    index,
    3 + (CONTACT_HEIGHT + 0.02 - 3) * index / 60,
    index === 0 ? 0 : -0.5,
    x,
  ))
  return [...air, ...Array.from({ length: 15 }, (_, index) => sample(index + 61, CONTACT_HEIGHT, 0, x))]
}

function run(samples: readonly TrainingSample[]) {
  const session = new TrainingSession({
    lessons: [LANDING_LESSON],
    initialLessonId: 'landing',
    sceneReferences: REFERENCES,
    countdownDurationSeconds: 0,
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
    lesson: LANDING_LESSON,
    elapsedSeconds: 0,
    checkpoints: {},
    trajectory: [],
    sceneReferences: REFERENCES,
    ...overrides,
  }
}

describe('controlled landing lesson', () => {
  it('passes an armed, low-speed descent with actual contact and a grounded continuous dwell', () => {
    const landed = run(successFixture())
    expect(landed.phase).toBe('SUCCESS')
    expect(landed.result?.completedCheckpoints).toBe(3)
    expect(landed.result?.metrics.groundTouching).toBe(1)
    expect(landed.result?.metrics.touchdownDescentSpeedMps).toBeCloseTo(0.5)
    expect(landed.result?.metrics.contiguousDwellSeconds).toBeGreaterThanOrEqual(LANDING_SETTLED_DWELL_SECONDS)
    expect(landed.result?.score).toBeGreaterThanOrEqual(90)
  })

  it('cannot pass by starting grounded, hovering above ground, or fabricating midair contact', () => {
    const alreadyGrounded = run(Array.from({ length: 20 }, (_, index) => sample(index, CONTACT_HEIGHT)))
    expect(alreadyGrounded.phase).toBe('FAILED')
    expect(alreadyGrounded.result?.message).toMatch(/地面|進場/)
    const hoveringTrace = [
      ...Array.from({ length: 61 }, (_, index) => sample(index, 3 + (CONTACT_HEIGHT + 0.2 - 3) * index / 60, index === 0 ? 0 : -0.5)),
      ...Array.from({ length: 20 }, (_, index) => sample(index + 61, CONTACT_HEIGHT + 0.2)),
    ]
    const midair = run(hoveringTrace)
    expect(midair.phase).toBe('ACTIVE')
    expect(midair.checkpoints['landing-touchdown']?.completed).toBe(false)
    const fake = sample(0, 3)
    const fabricated = landingEvaluator.evaluate({ ...fake, groundContact: { ...fake.groundContact!, touching: true } }, context())
    expect(fabricated.status).toBe('failure')
    expect(fabricated.message).toMatch(/接地標記/)
  })

  it('uses pre-impact speed rather than the zeroed contact-solver velocity', () => {
    const rough = successFixture().map((current, index) => index === 60
      ? { ...current, state: { ...current.state, velocityMps: { x: 0, y: -1.8, z: 0 } } }
      : current)
    const result = run(rough)
    expect(result.phase).toBe('FAILED')
    expect(result.result?.message).toMatch(/接地前|歸零/)
    expect(result.result?.metrics.touchdownDescentSpeedMps).toBeCloseTo(1.8)
  })

  it('requires the specified pad even for otherwise gentle contact', () => {
    const wrongPad = run(successFixture(1))
    expect(wrongPad.phase).toBe('FAILED')
    expect(wrongPad.result?.message).toMatch(/落點|指定/)
  })

  it('restarts continuous grounded dwell after a speed excursion', () => {
    const interrupted = successFixture().map((current, index) => index === 65
      ? { ...current, state: { ...current.state, velocityMps: { x: 0.3, y: 0, z: 0 } } }
      : current)
    const pending = run(interrupted)
    expect(pending.phase).toBe('ACTIVE')
    expect(pending.lastEvaluation?.metrics?.contiguousDwellSeconds).toBeLessThan(LANDING_SETTLED_DWELL_SECONDS)
    const extended = run([...interrupted, ...Array.from({ length: 10 }, (_, index) => sample(index + 76, CONTACT_HEIGHT))])
    expect(extended.phase).toBe('SUCCESS')
  })

  it('rechecks impact speed after a small hop despite a completed touchdown checkpoint', () => {
    const bounced = successFixture().map((current, index) => index === 63
      ? sample(index, CONTACT_HEIGHT + 0.02, -1.2)
      : current)
    const roughReimpact = run(bounced)
    expect(roughReimpact.phase).toBe('FAILED')
    expect(roughReimpact.checkpoints['landing-touchdown']?.completed).toBe(true)
    expect(roughReimpact.result?.metrics.touchdownDescentSpeedMps).toBeCloseTo(1.2)
    expect(roughReimpact.result?.message).toMatch(/接地前|歸零/)

    const previous = bounced[63]
    const checkpoint = (id: string) => ({ id, completed: true, completedAtSeconds: 6.2, metrics: {} })
    const practice = landingEvaluator.evaluate(bounced[64], context({
      mode: 'practice',
      elapsedSeconds: 6.4,
      previousSample: previous,
      previousFlightSample: previous,
      previousEvaluation: { status: 'continue', metrics: { descentObserved: 1, landingSettled: 0, contiguousDwellSeconds: 0 } },
      checkpoints: {
        'landing-approach': checkpoint('landing-approach'),
        'landing-touchdown': checkpoint('landing-touchdown'),
      },
    }))
    expect(practice.status).toBe('continue')
    expect(practice.recovery).toBe('restart')
    expect(practice.metrics?.touchdownDescentSpeedMps).toBeCloseTo(1.2)
  })

  it('allows a controlled small recontact but requires a new full grounded dwell', () => {
    const gentleBounce = successFixture().map((current, index) => index === 63
      ? sample(index, CONTACT_HEIGHT + 0.02, -0.4)
      : current)
    const beforeNewDwell = run(gentleBounce.slice(0, 74))
    expect(beforeNewDwell.phase).toBe('ACTIVE')
    expect(beforeNewDwell.lastEvaluation?.metrics?.touchdownDescentSpeedMps).toBeCloseTo(0.4)
    expect(beforeNewDwell.lastEvaluation?.metrics?.contiguousDwellSeconds).toBeLessThan(LANDING_SETTLED_DWELL_SECONDS)
    expect(run(gentleBounce).phase).toBe('SUCCESS')
  })

  it('rejects crash, disarm, invalid contact metadata and nonfinite state', () => {
    const first = sample(0, 3)
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

  it('rejects telemetry gaps and teleports even after a practice checkpoint restart', () => {
    const before = sample(0, 3)
    const jump = landingEvaluator.evaluate(sample(1, CONTACT_HEIGHT), context({
      mode: 'practice', previousFlightSample: before,
    }))
    expect(jump.status).toBe('failure')
    expect(jump.message).toMatch(/位置跳躍|瞬移/)
    expect(jump.recovery).toBeUndefined()
    const gap = landingEvaluator.evaluate({ ...sample(1, 3), timestampSeconds: 1 }, context({
      mode: 'practice', previousFlightSample: before,
    }))
    expect(gap.status).toBe('failure')
    expect(gap.message).toMatch(/中斷/)
  })

  it('rejects frozen contact states relabelled with later sample timestamps', () => {
    const before = sample(0, CONTACT_HEIGHT)
    const invalid = { ...before, timestampSeconds: before.timestampSeconds + 0.1 }
    expect(landingEvaluator.evaluate(invalid, context({ previousFlightSample: before })).status).toBe('failure')
    const fixture = successFixture()
    const frozen = fixture[62]!
    const result = run(fixture.map((current, index) => index > 62 ? { ...current, state: frozen.state } : current))
    expect(result.phase).toBe('FAILED')
    expect(result.result?.completedCheckpoints).toBeLessThan(3)
  })

  it('keeps practice unbounded in time and restarts ordinary misses while challenges end', () => {
    const first = sample(0, 3)
    expect(landingEvaluator.evaluate(first, context({ mode: 'practice', elapsedSeconds: 120 })).status).toBe('continue')
    const timeout = landingEvaluator.evaluate(first, context({ mode: 'challenge', elapsedSeconds: 36 }))
    expect(timeout.status).toBe('failure')
    expect(timeout.message).toMatch(/逾時/)
    const missed = sample(0, 3, 0, 2)
    const practice = landingEvaluator.evaluate(missed, context({ mode: 'practice' }))
    expect(practice.status).toBe('continue')
    expect(practice.recovery).toBe('restart')
    expect(landingEvaluator.evaluate(missed, context({ mode: 'challenge' })).status).toBe('failure')
  })
})
