import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { integrateBodyAngularVelocity, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createGravityGate } from '../world/gravityGate'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import { GRAVITY_GATE_LEARNING_CONTENT, GRAVITY_GATE_LESSON, GRAVITY_GATE_PHASE_IDS, gravityGateEvaluator } from './gravityGate'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG) {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'gravity-gate-frame', kind: 'gate', positionM: createGravityGate(launch, config.ground.heightM).centerM }]
}
function checkpoints(phase = 0): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(GRAVITY_GATE_PHASE_IDS.slice(0, phase).map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
}
function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: GRAVITY_GATE_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: {}, sceneReferences: references(), ...overrides }
}
/** Kinematically coherent observations; the independent demo tests use actual RC physics. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public checkpointStates = checkpoints()
  public readonly trace: TrainingSample[] = []
  public readonly evaluations: TrainingEvaluation[] = []
  public position: Vector3
  public velocity: Vector3 = ZERO
  public rate: Vector3 = ZERO
  public orientation: Quaternion = { x: 0, y: 0, z: 0, w: 1 }
  public throttle = 0.6
  public constructor(public readonly config = DEFAULT_DRONE_CONFIG) {
    this.position = createTrainingFieldAnchors(config).launch
  }
  public tick(velocity: Vector3 = ZERO, rate: Vector3 = ZERO): TrainingEvaluation {
    this.position = { x: this.position.x + (this.velocity.x + velocity.x) * STEP / 2,
      y: this.position.y + (this.velocity.y + velocity.y) * STEP / 2,
      z: this.position.z + (this.velocity.z + velocity.z) * STEP / 2 }
    this.orientation = integrateBodyAngularVelocity(this.orientation, {
      x: (this.rate.x + rate.x) / 2, y: (this.rate.y + rate.y) / 2, z: (this.rate.z + rate.z) / 2,
    }, STEP)
    this.velocity = velocity
    this.rate = rate
    const timestampSeconds = (this.trace.length + 1) * STEP
    const supportOffsetM = droneGroundSupport(this.config, this.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds, armed: true, normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: this.throttle },
      groundContact: { heightM: this.config.ground.heightM, supportOffsetM,
        touching: this.position.y - this.config.ground.heightM - supportOffsetM - DRONE_GROUND_CLEARANCE_M < 1e-8 },
      state: { ...createInitialDroneState(this.config, this.position, this.orientation), velocityMps: velocity,
        angularVelocityBodyRadPerSec: rate, timeSeconds: timestampSeconds, stepIndex: this.trace.length + 1 } }
    const previous = this.trace.at(-1)
    const result = gravityGateEvaluator.evaluate(sample, context({ elapsedSeconds: timestampSeconds,
      sceneReferences: references(this.config), checkpoints: this.checkpointStates, previousSample: previous,
      previousFlightSample: previous, previousEvaluation: this.evaluation }))
    this.evaluation = result
    this.trace.push(sample)
    this.evaluations.push(result)
    for (const id of result.checkpointIds ?? []) this.checkpointStates = { ...this.checkpointStates,
      [id]: { id, completed: true, completedAtSeconds: timestampSeconds, metrics: result.metrics ?? {} } }
    return result
  }
  public safe(velocity: Vector3 = ZERO, rate: Vector3 = ZERO): TrainingEvaluation {
    const result = this.tick(velocity, rate)
    expect(result.status, result.message).not.toBe('failure')
    expect(result.checkpointIds?.length ?? 0).toBeLessThanOrEqual(1)
    return result
  }
  public repeat(count: number, velocity: Vector3 = ZERO, rate: Vector3 = ZERO): void {
    for (let i = 0; i < count; i += 1) this.safe(velocity, rate)
  }
  public until(key: string, velocity: Vector3, maximum = 400): void {
    for (let index = 0; index < maximum && !((this.evaluation?.metrics?.[key] ?? 0) > 0.5); index += 1) this.safe(velocity)
    expect(this.evaluation?.metrics?.[key], key).toBe(1)
  }
}
function approach(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = new Observer(config)
  observer.safe()
  observer.repeat(56, { x: 0, y: 5, z: 0 })
  observer.safe()
  observer.repeat(10, { x: 0, y: 0, z: -5 })
  expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 3, gravityGateEpisodeValid: 1 })
  return observer
}
function above(options: { cut?: boolean; adjust?: boolean; config?: typeof DEFAULT_DRONE_CONFIG } = {}): Observer {
  const observer = approach(options.config)
  observer.repeat(65, { x: 0, y: 5, z: -5 })
  if (options.cut !== false) observer.throttle = 0.04
  observer.repeat(8, { x: 0, y: 0, z: -5 }, options.adjust === false ? ZERO : { x: 0, y: 0, z: 0.6 })
  observer.safe({ x: 0, y: 0, z: -5 })
  observer.repeat(70, { x: 0, y: 0, z: -5 })
  observer.safe()
  return observer
}
function entered(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = above({ config })
  observer.until('gravityGateEntered', { x: 0, y: -4, z: 0 })
  expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 6, gravityGateExited: 0 })
  return observer
}
function exited(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = entered(config)
  observer.until('gravityGateExited', { x: 0, y: 0, z: -5 })
  expect(observer.evaluation?.metrics?.gravityGatePhase).toBe(7)
  return observer
}

describe('gravity gate ordered top-entry and side-exit course', () => {
  it('defines eight independent Chinese steps with an explicit ground reset and L19 metadata', () => {
    expect(GRAVITY_GATE_LESSON).toMatchObject({ id: 'gravity-gate', title: '重力門', available: true })
    expect(GRAVITY_GATE_LEARNING_CONTENT).toMatchObject({ code: 'L19', title: '重力門' })
    expect(GRAVITY_GATE_LESSON.checkpoints.map(({ id }) => id)).toEqual(GRAVITY_GATE_PHASE_IDS)
    expect(GRAVITY_GATE_LESSON.setup.spawnPositionM).toBeUndefined()
    expect(GRAVITY_GATE_LESSON.setup).toMatchObject({ requiresDisarmed: true, resetSimulation: true })
  })
  it('accepts a real toss, throttle reduction and small attitude correction without requiring a full flip', () => {
    const observer = exited()
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 8, gravityGateRecovered: 1 })
    expect(observer.evaluation?.metrics?.gravityGateAttitudeChangeDegrees).toBeLessThan(20)
    expect(Object.keys(observer.checkpointStates)).toEqual(GRAVITY_GATE_PHASE_IDS)
  })
  it('uses translated launch anchors and nonzero ground for the exact same route', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 8 }, spawnPositionM: { x: 6, y: 45, z: -3 } }
    const observer = exited(config)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeGreaterThan(20)
    expect(observer.evaluation?.metrics?.gravityGateEntryHorizontalErrorM).toBeCloseTo(0)
  })
  it('creates a complete independent session result from the observed route', () => {
    const observer = exited()
    observer.repeat(8)
    const session = new TrainingSession({ lessons: [GRAVITY_GATE_LESSON], initialLessonId: 'gravity-gate', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const sample of observer.trace) {
      session.consumeSample(sample)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ lessonId: 'gravity-gate', outcome: 'SUCCESS', completedCheckpoints: 8, totalCheckpoints: 8 })
  })
  it('does not confuse continuing takeoff climb with the separate forward approach and toss', () => {
    const observer = new Observer()
    observer.safe()
    observer.repeat(80, { x: 0, y: 7, z: -3 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 2, gravityGateEpisodeValid: 0, gravityGateTossed: 0 })
  })
  it('does not award top entry to straight passage through the near and far sides', () => {
    const observer = approach()
    observer.repeat(230, { x: 0, y: 0, z: -5 })
    expect(observer.evaluations.some(({ metrics }) => metrics?.gravityGateInterruptionReason === 5)).toBe(true)
    expect(observer.evaluation?.metrics?.gravityGateEntered).toBe(0)
    expect(observer.checkpointStates['gravity-entered']).toBeUndefined()
    expect(observer.evaluation?.status).toBe('continue')
  })
  it.each([{ cut: false }, { adjust: false }])('requires actual reduced throttle and actual attitude evidence: %j', (options) => {
    const observer = above(options)
    observer.repeat(40, { x: 0, y: -4, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEntered: 0, gravityGateInterruptionReason: 9, gravityGateEpisodeValid: 0 })
    expect(observer.checkpointStates['gravity-entered']).toBeUndefined()
  })
  it('rejects a missed top aperture and freezes the first measured failure while flight continues', () => {
    const observer = above()
    observer.repeat(40, { x: 5, y: 0, z: 0 })
    observer.repeat(40, { x: 0, y: -4, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateInterrupted: 1, gravityGateInterruptionReason: 4 })
    const frozen = observer.evaluation?.metrics?.interruptionGravityGateEntryHorizontalErrorM
    observer.repeat(20, { x: 5, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.interruptionGravityGateEntryHorizontalErrorM).toBe(frozen)
    expect(observer.evaluation?.metrics?.gravityGateEntryHorizontalErrorM).toBeGreaterThan(frozen ?? 0)
  })
  it('does not count top-height flyover as top entry', () => {
    const observer = above()
    observer.repeat(100, { x: 0, y: 0, z: -5 })
    observer.repeat(20)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEntered: 0, gravityGateExited: 0 })
    expect(observer.evaluation?.status).toBe('continue')
  })
  it.each([
    { name: 'another side', velocity: { x: 5, y: 0, z: 0 }, count: 40 },
    { name: 'the top', velocity: { x: 0, y: 5, z: 0 }, count: 12 },
    { name: 'the bottom', velocity: { x: 0, y: -5, z: 0 }, count: 65 },
  ])('invalidates entry followed by leaving through $name', ({ velocity, count }) => {
    const observer = entered()
    observer.repeat(count, velocity)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateEntered: 0, gravityGateExited: 0, gravityGateInterruptionReason: 6 })
    expect(observer.checkpointStates['gravity-entered']?.completed).toBe(true)
    expect(observer.checkpointStates['gravity-exited']).toBeUndefined()
  })
  it('invalidates an exit followed by reentry rather than using the old exit for recovery', () => {
    const observer = exited()
    observer.repeat(3, { x: 0, y: 0, z: 5 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateInterruptionReason: 7, gravityGateExited: 0 })
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics?.gravityGatePhase).toBe(7)
  })
  it('does not accept historical entry/exit checkpoints as proof of a new route', () => {
    const observer = approach()
    observer.checkpointStates = checkpoints(7)
    observer.repeat(10)
    expect(observer.evaluation?.metrics?.gravityGatePhase).toBe(7)
    expect(observer.evaluation?.metrics?.gravityGateEntered).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('cannot reuse an earlier forward approach after stopping and climbing vertically', () => {
    const observer = approach()
    observer.repeat(18)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateInterruptionReason: 10 })
    observer.repeat(65, { x: 0, y: 5, z: 0 })
    observer.throttle = 0.04
    observer.repeat(10, ZERO, { x: 0, y: 0, z: 0.6 })
    expect(observer.evaluation?.metrics?.gravityGateTossed).toBe(0)
    expect(observer.checkpointStates['gravity-tossed']).toBeUndefined()
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('cannot score an upward crossing from the bottom as a top entrance', () => {
    const observer = approach()
    // Travel below the bottom opening to its centre, then climb up through it.
    observer.repeat(26, { x: 0, y: -4, z: 0 })
    observer.safe()
    observer.repeat(143, { x: 0, y: 0, z: -5 })
    observer.repeat(100, { x: 0, y: 5, z: 0 })
    expect(observer.evaluation?.metrics?.gravityGateEntered).toBe(0)
    expect(observer.evaluation?.metrics?.gravityGateExited).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('preserves historical checks through an interruption but requires and accepts a full fresh episode', () => {
    const observer = exited()
    observer.repeat(3, { x: 0, y: 0, z: 5 })
    expect(observer.evaluation?.metrics?.gravityGateInterruptionReason).toBe(7)
    expect(observer.evaluation?.metrics?.gravityGatePhase).toBe(7)
    // Fly clear above the real frame, return to its near side and prepare again.
    observer.repeat(30, { x: 0, y: 5, z: 0 })
    while (observer.position.z < observer.config.spawnPositionM.z - 14) observer.safe({ x: 0, y: 0, z: 5 })
    observer.safe()
    while (observer.position.y > observer.config.ground.heightM + 14) observer.safe({ x: 0, y: -5, z: 0 })
    observer.safe()
    observer.throttle = 0.6
    observer.repeat(8, { x: 0, y: 0, z: -5 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 1, gravityGateEntered: 0, gravityGateExited: 0, gravityGatePhase: 7 })
    observer.repeat(65, { x: 0, y: 5, z: -5 })
    observer.throttle = 0.04
    observer.repeat(8, { x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: 0.6 })
    observer.safe({ x: 0, y: 0, z: -5 })
    while (observer.position.z > observer.config.spawnPositionM.z - 38.5) observer.safe({ x: 0, y: 0, z: -5 })
    observer.safe()
    observer.until('gravityGateEntered', { x: 0, y: -4, z: 0 })
    expect(observer.evaluation?.status).toBe('continue')
    observer.until('gravityGateExited', { x: 0, y: 0, z: -5 })
    expect(observer.evaluation?.status).toBe('continue')
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.gravityGatePhase).toBe(8)
  })
  it('requires actual recovery after a complete route', () => {
    const observer = exited()
    observer.repeat(2, { x: 0, y: -8, z: -5 })
    expect(observer.evaluation?.metrics?.gravityGateRecoveryDwellSeconds).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('stops on authoritative configured-body frame contact and preserves the collider ID', () => {
    const observer = approach()
    const sample = observer.trace.at(-1)!
    const result = gravityGateEvaluator.evaluate({ ...sample, state: { ...sample.state, crashed: true,
      warnings: ['Obstacle collision: gravity-gate-top-near-bar'] } }, context())
    expect(result.status).toBe('failure')
    expect(result.message).toContain('gravity-gate-top-near-bar')
  })
  it('rejects fabricated beam crossings even when crash telemetry is omitted', () => {
    const gate = createGravityGate(references()[0].positionM, 0)
    const post = gate.colliders[0]
    const beforePosition = { ...post.centerM, z: post.centerM.z + 1 }
    const velocity = { x: 0, y: 0, z: -10 }
    const sample = (time: number, positionM: Vector3): TrainingSample => ({ timestampSeconds: time, armed: true, normalizedInput: null,
      groundContact: { heightM: 0, supportOffsetM: 0.05, touching: false },
      state: { ...createInitialDroneState(DEFAULT_DRONE_CONFIG, positionM), positionM, velocityMps: velocity, stepIndex: Math.round(time * 100), timeSeconds: time } })
    const before = sample(1, beforePosition)
    const current = sample(1.2, { ...beforePosition, z: beforePosition.z - 2 })
    const result = gravityGateEvaluator.evaluate(current, context({ checkpoints: checkpoints(2), previousSample: before, previousFlightSample: before }))
    expect(result.status).toBe('failure')
    expect(result.message).toContain(post.id)
  })
  it('rejects telemetry resets, position jumps and pose changes unsupported by angular velocity', () => {
    const observer = approach()
    const before = observer.trace.at(-1)!
    const base = { ...before, timestampSeconds: before.timestampSeconds + STEP,
      state: { ...before.state, timeSeconds: before.state.timeSeconds + STEP, stepIndex: before.state.stepIndex + 1,
        positionM: { ...before.state.positionM, z: before.state.positionM.z - 5 * STEP } } }
    for (const sample of [
      { ...base, state: { ...base.state, timeSeconds: 0, stepIndex: 0 } },
      { ...base, state: { ...base.state, positionM: { ...base.state.positionM, z: -100 } } },
      { ...base, state: { ...base.state, orientation: quaternionFromRotationVector({ x: Math.PI, y: 0, z: 0 }) } },
    ]) expect(gravityGateEvaluator.evaluate(sample, context({ checkpoints: observer.checkpointStates, previousSample: before, previousFlightSample: before, previousEvaluation: observer.evaluation })).status).toBe('failure')
  })
  it('keeps practice unlimited while timing out the timed challenge', () => {
    const observer = approach()
    const sample = observer.trace.at(-1)!
    expect(gravityGateEvaluator.evaluate(sample, context({ elapsedSeconds: 301, checkpoints: checkpoints(2) })).status).toBe('continue')
    expect(gravityGateEvaluator.evaluate(sample, context({ mode: 'challenge', elapsedSeconds: 301, checkpoints: checkpoints(2) })).status).toBe('failure')
  })
})
