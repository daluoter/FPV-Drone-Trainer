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
  public orientation: Quaternion = quaternionFromRotationVector({ x: 0, y: Math.PI / 2, z: 0 })
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
  public axisTo(axis: 'x' | 'y' | 'z', destination: number, speed = 4): void {
    for (let count = 0; count < 1000 && Math.abs(this.position[axis] - destination) > 0.2; count += 1) {
      this.safe({ ...ZERO, [axis]: Math.sign(destination - this.position[axis]) * speed })
    }
    this.safe()
    expect(Math.abs(this.position[axis] - destination)).toBeLessThan(0.25)
  }
  public until(key: string, velocity: Vector3, maximum = 400): void {
    for (let index = 0; index < maximum && !((this.evaluation?.metrics?.[key] ?? 0) > 0.5); index += 1) this.safe(velocity)
    expect(this.evaluation?.metrics?.[key], key).toBe(1)
  }
}
function approach(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = new Observer(config)
  const gate = createGravityGate(createTrainingFieldAnchors(config).launch, config.ground.heightM)
  observer.safe()
  observer.axisTo('y', config.ground.heightM + 8)
  observer.axisTo('x', gate.approachPointM.x)
  observer.axisTo('z', gate.approachPointM.z)
  observer.repeat(8, { x: -3, y: 0, z: 0 })
  expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 3, gravityGateEpisodeValid: 1 })
  return observer
}
function above(options: { cut?: boolean; adjust?: boolean; config?: typeof DEFAULT_DRONE_CONFIG; observer?: Observer } = {}): Observer {
  const observer = options.observer ?? approach(options.config)
  while (observer.position.y < observer.config.ground.heightM + 17) observer.safe({ x: -3, y: 4, z: 0 })
  if (options.cut !== false) observer.throttle = 0.04
  observer.repeat(8, { x: -3, y: 0, z: 0 }, options.adjust === false ? ZERO : { x: 0, y: 0, z: 0.6 })
  const gate = createGravityGate(createTrainingFieldAnchors(observer.config).launch, observer.config.ground.heightM)
  observer.axisTo('x', gate.centerM.x + 1.5, 3)
  return observer
}
function entered(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = above({ config })
  observer.until('gravityGateEntered', { x: 0, y: -3, z: 0 })
  observer.safe()
  expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 6, gravityGateLowerReached: 0, gravityGateExited: 0 })
  return observer
}
function lowered(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = entered(config)
  observer.until('gravityGateLowerReached', { x: 0, y: -3, z: 0 })
  const gate = createGravityGate(createTrainingFieldAnchors(config).launch, config.ground.heightM)
  observer.axisTo('y', gate.sideExitCenterM.y, 3)
  expect(observer.evaluation?.metrics).toMatchObject({ gravityGateLowerReached: 1, gravityGateReturnReady: 1, gravityGateReturned: 0 })
  return observer
}
function exited(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = lowered(config)
  observer.until('gravityGateExited', { x: 2, y: 0, z: 0 })
  expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 7, gravityGateReturned: 1 })
  return observer
}

describe('gravity gate ordered top-entry and lower-level return course', () => {
  it('keeps eight Chinese checkpoints and changes the route to a low same-side return', () => {
    expect(GRAVITY_GATE_LESSON).toMatchObject({ id: 'gravity-gate', title: '重力門', available: true })
    expect(GRAVITY_GATE_LEARNING_CONTENT).toMatchObject({ code: 'L19', title: '重力門' })
    expect(GRAVITY_GATE_LESSON.checkpoints.map(({ id }) => id)).toEqual(GRAVITY_GATE_PHASE_IDS)
    expect(GRAVITY_GATE_LESSON.setup).toMatchObject({ requiresDisarmed: true, resetSimulation: true })
    expect(GRAVITY_GATE_LESSON.setup.spawnPositionM).toBeUndefined()
    expect(GRAVITY_GATE_LESSON.checkpoints[6].title).toContain('低層')
  })
  it('accepts real top entry, interior descent and actual reverse displacement without a full flip', () => {
    const observer = exited()
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 8, gravityGateLowerReached: 1,
      gravityGateReturnReady: 1, gravityGateReturned: 1, gravityGateRecovered: 1 })
    expect(observer.evaluation?.metrics?.gravityGateAttitudeChangeDegrees).toBeLessThan(20)
    expect(Object.keys(observer.checkpointStates)).toEqual(GRAVITY_GATE_PHASE_IDS)
  })
  it('uses translated launch anchors and raised ground for the same low return', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 8 }, spawnPositionM: { x: 6, y: 45, z: -3 } }
    const observer = exited(config)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeGreaterThan(4)
    expect(observer.evaluation?.metrics?.altitudeM).toBeLessThan(9)
    expect(observer.evaluation?.metrics?.gravityGateEntryForwardErrorM).toBeCloseTo(0, 1)
  })
  it('creates an independent complete session from the genuinely reversed route', () => {
    const observer = exited()
    observer.repeat(8)
    const session = new TrainingSession({ lessons: [GRAVITY_GATE_LESSON], initialLessonId: 'gravity-gate', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0); session.tick(0)
    for (const sample of observer.trace) {
      session.consumeSample(sample)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ lessonId: 'gravity-gate', outcome: 'SUCCESS', completedCheckpoints: 8, totalCheckpoints: 8 })
  })
  it('does not use takeoff climb or the old frontal approach as a side toss', () => {
    const observer = new Observer()
    observer.safe()
    observer.repeat(60, { x: 0, y: 4, z: -3 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 2, gravityGateEpisodeValid: 0, gravityGateTossed: 0 })
  })
  it('does not grant top entry for direct side-to-side passage', () => {
    const observer = approach()
    observer.repeat(130, { x: -3, y: 0, z: 0 })
    expect(observer.evaluations.some(({ metrics }) => metrics?.gravityGateInterruptionReason === 5)).toBe(true)
    expect(observer.evaluation?.metrics?.gravityGateEntered).toBe(0)
    expect(observer.checkpointStates['gravity-entered']).toBeUndefined()
  })
  it.each([{ cut: false }, { adjust: false }])('requires real throttle reduction and attitude correction: %j', (options) => {
    const observer = above(options)
    observer.repeat(30, { x: 0, y: -3, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEntered: 0, gravityGateInterruptionReason: 9, gravityGateEpisodeValid: 0 })
  })
  it('freezes the first missed top-aperture measurements while later flight continues', () => {
    const observer = above()
    observer.repeat(35, { x: 5, y: 0, z: 0 })
    observer.repeat(30, { x: 0, y: -3, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateInterruptionReason: 4 })
    const frozen = observer.evaluation?.metrics?.interruptionGravityGateEntryHorizontalErrorM
    observer.repeat(20, { x: 5, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.interruptionGravityGateEntryHorizontalErrorM).toBe(frozen)
    expect(observer.evaluation?.metrics?.gravityGateEntryHorizontalErrorM).toBeGreaterThan(frozen ?? 0)
  })
  it('does not count a flyover above the top as entry', () => {
    const observer = above()
    observer.repeat(45, { x: -3, y: 0, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEntered: 0, gravityGateExited: 0 })
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('rejects returning out of the same face while still on the upper level', () => {
    const observer = entered()
    observer.repeat(22, { x: 3, y: 0, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateInterruptionReason: 11, gravityGateLowerReached: 0 })
    expect(observer.checkpointStates['gravity-entered']?.completed).toBe(true)
  })
  it.each([
    { name: 'opposite side straight ahead', velocity: { x: -4, y: 0, z: 0 }, count: 40 },
    { name: 'the old far-Z face', velocity: { x: 0, y: 0, z: -4 }, count: 30 },
    { name: 'the top', velocity: { x: 0, y: 4, z: 0 }, count: 15 },
    { name: 'the bottom', velocity: { x: 0, y: -4, z: 0 }, count: 60 },
  ])('invalidates leaving through $name', ({ velocity, count }) => {
    const observer = entered()
    observer.repeat(count, velocity)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateEntered: 0, gravityGateExited: 0, gravityGateInterruptionReason: 6 })
    expect(observer.checkpointStates['gravity-entered']?.completed).toBe(true)
  })
  it('does not turn upper-level movement into low-level return evidence', () => {
    const observer = lowered()
    observer.axisTo('y', 11, 3)
    observer.axisTo('x', -1, 2)
    observer.axisTo('x', 1.5, 2)
    observer.axisTo('y', 7.5, 3)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateLowerReached: 1, gravityGateReturned: 0, gravityGateReturnDistanceM: 0 })
    observer.repeat(5, { x: 1.5, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.gravityGateReturned).toBe(1)
  })
  it('requires the return to be established on the low level instead of arriving already outward', () => {
    const observer = entered()
    observer.until('gravityGateLowerReached', { x: 0.6, y: -3, z: 0 })
    observer.repeat(12, { x: 0.6, y: 0, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateReturnReady: 0, gravityGateReturned: 0 })
    // Near-stationary is accepted; there is no demand for a negative low-level speed.
    observer.safe()
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateReturnReady: 1, gravityGateReturnDistanceM: 0 })
    observer.repeat(2, { x: 1, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.gravityGateReturned).toBe(0)
    observer.repeat(7, { x: 1, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.gravityGateReturned).toBe(1)
  })
  it('does not confuse yaw reversal with actual return travel', () => {
    const observer = lowered()
    observer.repeat(20, ZERO, { x: 0, y: Math.PI, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateReturned: 0, gravityGateReturnDistanceM: 0, gravityGateExited: 0 })
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('does not borrow historical entry and return checks for a fresh episode', () => {
    const observer = approach()
    observer.checkpointStates = checkpoints(7)
    observer.repeat(10)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 7, gravityGateLowerReached: 0, gravityGateReturned: 0 })
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('cannot retain forward momentum after stopping before the toss', () => {
    const observer = approach()
    observer.repeat(18)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateInterruptionReason: 10 })
    observer.repeat(45, { x: 0, y: 4, z: 0 })
    expect(observer.evaluation?.metrics?.gravityGateTossed).toBe(0)
  })
  it('cannot reuse a completed exit after reentering the frame', () => {
    const observer = exited()
    observer.repeat(6, { x: -2, y: 0, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 0, gravityGateInterruptionReason: 7, gravityGateExited: 0 })
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('cannot score entering upward from the bottom as a top drop', () => {
    const observer = approach()
    observer.axisTo('y', 3, 3)
    observer.axisTo('x', 1.5, 3)
    observer.axisTo('y', 12, 3)
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEntered: 0, gravityGateLowerReached: 0, gravityGateExited: 0 })
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('retains historical checks after interruption but requires and accepts a whole fresh return', () => {
    const observer = entered()
    observer.repeat(22, { x: 3, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.gravityGateInterruptionReason).toBe(11)
    expect(observer.checkpointStates['gravity-entered']?.completed).toBe(true)
    const gate = createGravityGate(createTrainingFieldAnchors(observer.config).launch, observer.config.ground.heightM)
    observer.axisTo('x', gate.approachPointM.x)
    observer.axisTo('y', gate.approachPointM.y)
    observer.throttle = 0.6
    observer.repeat(8, { x: -3, y: 0, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGateEpisodeValid: 1, gravityGateEntered: 0, gravityGateLowerReached: 0, gravityGateReturned: 0 })
    above({ observer })
    observer.until('gravityGateEntered', { x: 0, y: -3, z: 0 })
    observer.until('gravityGateLowerReached', { x: 0, y: -3, z: 0 })
    observer.axisTo('y', gate.sideExitCenterM.y, 3)
    observer.until('gravityGateExited', { x: 2, y: 0, z: 0 })
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ gravityGatePhase: 8, gravityGateEntered: 1,
      gravityGateLowerReached: 1, gravityGateReturnReady: 1, gravityGateReturned: 1 })
  })
  it('requires recovery after low-level return and does not accept excessive descent', () => {
    const observer = exited()
    observer.repeat(2, { x: 2, y: -8, z: 0 })
    expect(observer.evaluation?.metrics?.gravityGateRecoveryDwellSeconds).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('honors authoritative configured-body frame collisions and names their collider', () => {
    const observer = approach()
    const sample = observer.trace.at(-1)!
    const result = gravityGateEvaluator.evaluate({ ...sample, state: { ...sample.state, crashed: true,
      warnings: ['Obstacle collision: gravity-gate-middle-near-bar'] } }, context())
    expect(result.status).toBe('failure')
    expect(result.message).toContain('gravity-gate-middle-near-bar')
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
  it('rejects reset, position teleport and rotation unsupported by angular velocity', () => {
    const observer = approach()
    const before = observer.trace.at(-1)!
    const base = { ...before, timestampSeconds: before.timestampSeconds + STEP,
      state: { ...before.state, timeSeconds: before.state.timeSeconds + STEP, stepIndex: before.state.stepIndex + 1,
        positionM: { ...before.state.positionM, x: before.state.positionM.x - 3 * STEP } } }
    for (const sample of [
      { ...base, state: { ...base.state, timeSeconds: 0, stepIndex: 0 } },
      { ...base, state: { ...base.state, positionM: { ...base.state.positionM, x: -100 } } },
      { ...base, state: { ...base.state, orientation: quaternionFromRotationVector({ x: Math.PI, y: 0, z: 0 }) } },
    ]) expect(gravityGateEvaluator.evaluate(sample, context({ checkpoints: observer.checkpointStates, previousSample: before, previousFlightSample: before, previousEvaluation: observer.evaluation })).status).toBe('failure')
  })
  it('keeps untimed practice while bounding the timed challenge', () => {
    const observer = approach()
    const sample = observer.trace.at(-1)!
    expect(gravityGateEvaluator.evaluate(sample, context({ elapsedSeconds: 301, checkpoints: checkpoints(2) })).status).toBe('continue')
    expect(gravityGateEvaluator.evaluate(sample, context({ mode: 'challenge', elapsedSeconds: 301, checkpoints: checkpoints(2) })).status).toBe('failure')
  })
})
