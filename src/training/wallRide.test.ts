import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { integrateBodyAngularVelocity, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createWallRide, WALL_RIDE_REFERENCE_IDS } from '../world/wallRide'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import { WALL_RIDE_LEARNING_CONTENT, WALL_RIDE_LESSON, WALL_RIDE_PHASE_IDS, wallRideEvaluator } from './wallRide'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG) {
  const { launch, landing } = createTrainingFieldAnchors(config)
  const wall = createWallRide(launch, config.ground.heightM)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing },
    ...WALL_RIDE_REFERENCE_IDS.map((id, index) => ({ id, kind: 'marker', positionM: [wall.entryM, wall.rideStartM, wall.rideEndM, wall.exitM][index] }))]
}
function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: WALL_RIDE_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: {}, sceneReferences: references(), ...overrides }
}
/** Consistent observable kinematics; independent demo tests prove ordinary-RC feasibility. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public checkpointStates: Readonly<Record<string, TrainingCheckpointState>> = {}
  public readonly trace: TrainingSample[] = []
  public position: Vector3
  public velocity: Vector3 = ZERO
  public rate: Vector3 = ZERO
  public orientation: Quaternion = quaternionFromRotationVector(ZERO)
  public angle = 0
  public constructor(public readonly config = DEFAULT_DRONE_CONFIG) { this.position = createTrainingFieldAnchors(config).launch }
  public tick(velocity: Vector3 = ZERO, rate: Vector3 = ZERO): TrainingEvaluation {
    this.position = { x: this.position.x + (this.velocity.x + velocity.x) * STEP / 2,
      y: this.position.y + (this.velocity.y + velocity.y) * STEP / 2,
      z: this.position.z + (this.velocity.z + velocity.z) * STEP / 2 }
    this.orientation = integrateBodyAngularVelocity(this.orientation, { x: (this.rate.x + rate.x) / 2,
      y: (this.rate.y + rate.y) / 2, z: (this.rate.z + rate.z) / 2 }, STEP)
    this.angle += (this.rate.z + rate.z) * STEP / 2
    this.velocity = velocity; this.rate = rate
    const t = (this.trace.length + 1) * STEP
    const support = droneGroundSupport(this.config, this.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: t, armed: true, normalizedInput: null,
      groundContact: { heightM: this.config.ground.heightM, supportOffsetM: support,
        touching: Math.abs(this.position.y - this.config.ground.heightM - support - DRONE_GROUND_CLEARANCE_M) < 1e-8 },
      state: { ...createInitialDroneState(this.config, this.position, this.orientation), velocityMps: velocity,
        angularVelocityBodyRadPerSec: rate, timeSeconds: t, stepIndex: this.trace.length + 1 } }
    const previous = this.trace.at(-1)
    const result = wallRideEvaluator.evaluate(sample, context({ elapsedSeconds: t, sceneReferences: references(this.config),
      checkpoints: this.checkpointStates, previousSample: previous, previousFlightSample: previous, previousEvaluation: this.evaluation }))
    this.evaluation = result; this.trace.push(sample)
    for (const id of result.checkpointIds ?? []) this.checkpointStates = { ...this.checkpointStates,
      [id]: { id, completed: true, completedAtSeconds: t, metrics: result.metrics ?? {} } }
    return result
  }
  public safe(velocity: Vector3 = ZERO, rate: Vector3 = ZERO): TrainingEvaluation {
    const result = this.tick(velocity, rate)
    expect(result.status, result.message).not.toBe('failure')
    return result
  }
  public repeat(count: number, velocity: Vector3 = ZERO, rate: Vector3 = ZERO): void {
    for (let i = 0; i < count; i += 1) this.safe(velocity, rate)
  }
  public axisTo(axis: 'x' | 'y' | 'z', destination: number, speed = 4): void {
    for (let count = 0; count < 2000; count += 1) {
      const next = (destination - this.position[axis]) / STEP - this.velocity[axis] / 2
      if (Math.abs(next) <= speed) {
        this.safe({ ...ZERO, [axis]: next }); this.safe()
        expect(this.position[axis]).toBeCloseTo(destination, 8)
        return
      }
      this.safe({ ...ZERO, [axis]: Math.sign(next) * speed })
    }
    throw new Error(`Could not reach ${axis}=${destination}.`)
  }
  public bankTo(degrees: number): void {
    const target = degrees * Math.PI / 180
    for (let count = 0; count < 200; count += 1) {
      const next = (target - this.angle) / STEP - this.rate.z / 2
      if (Math.abs(next) <= 3) { this.safe(ZERO, { ...ZERO, z: next }); this.safe(); return }
      this.safe(ZERO, { ...ZERO, z: Math.sign(next) * 3 })
    }
    throw new Error(`Could not bank to ${degrees}.`)
  }
  public nextSample(): TrainingSample {
    const last = this.trace.at(-1)!
    return { ...last, timestampSeconds: last.timestampSeconds + STEP, state: { ...last.state,
      timeSeconds: last.state.timeSeconds + STEP, stepIndex: last.state.stepIndex + 1 } }
  }
  public evaluate(sample: TrainingSample, overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluation {
    const previous = this.trace.at(-1)
    return wallRideEvaluator.evaluate(sample, context({ elapsedSeconds: sample.timestampSeconds, sceneReferences: references(this.config),
      checkpoints: this.checkpointStates, previousSample: previous, previousFlightSample: previous, previousEvaluation: this.evaluation, ...overrides }))
  }
}
function airborne(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = new Observer(config)
  observer.safe(); observer.axisTo('y', config.ground.heightM + 14); observer.safe()
  expect(observer.evaluation?.metrics).toMatchObject({ wallRidePhase: 2, wallRideEpisodeValid: 1 })
  return observer
}
function entered(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = airborne(config)
  const { launch } = createTrainingFieldAnchors(config)
  observer.axisTo('x', launch.x + 6); observer.axisTo('z', launch.z - 14)
  expect(observer.evaluation?.metrics).toMatchObject({ wallRidePhase: 4, wallRideApproached: 1, wallRideForwardEntered: 1 })
  return observer
}
function ridden(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = entered(config)
  observer.bankTo(75)
  observer.axisTo('z', createTrainingFieldAnchors(config).launch.z - 21, 8)
  expect(observer.evaluation?.metrics).toMatchObject({ wallRideRideComplete: 1, wallRidePhase: 6 })
  return observer
}
function recovered(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = ridden(config)
  observer.axisTo('x', createTrainingFieldAnchors(config).launch.x + 2)
  observer.bankTo(0); observer.repeat(8)
  return observer
}

describe('L20 observable non-contact wall ride', () => {
  it('defines eight Chinese ground-start milestones and independent lesson identity', () => {
    expect(WALL_RIDE_LEARNING_CONTENT).toMatchObject({ code: 'L20', title: '騎牆' })
    expect(WALL_RIDE_LESSON).toMatchObject({ id: 'wall-ride', available: true, title: '騎牆', priority: 20 })
    expect(WALL_RIDE_LESSON.checkpoints.map(({ id }) => id)).toEqual(WALL_RIDE_PHASE_IDS)
    expect(WALL_RIDE_PHASE_IDS).toHaveLength(8)
    expect(WALL_RIDE_LESSON.setup.sceneReferenceIds).toEqual(['training-launch', 'landing-surface', ...WALL_RIDE_REFERENCE_IDS])
    expect(WALL_RIDE_LESSON.setup.spawnPositionM).toBeUndefined()
  })

  it('accepts a continuous true belly-facing pass and outward upright recovery without a fixed speed or stop', () => {
    const observer = recovered()
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ wallRidePhase: 8, wallRideEpisodeValid: 1,
      wallRideRideComplete: 1, wallRideLeft: 1, wallRideRecovered: 1 })
    expect(observer.evaluation?.metrics?.wallRideDistanceM).toBeGreaterThanOrEqual(6)
    expect(Object.keys(observer.checkpointStates)).toEqual(WALL_RIDE_PHASE_IDS)
  })

  it('produces a real eight-checkpoint session from the accepted observation sequence', () => {
    const observer = recovered()
    const session = new TrainingSession({ lessons: [WALL_RIDE_LESSON], initialLessonId: 'wall-ride', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0); session.tick(0)
    for (const sample of observer.trace) { session.consumeSample(sample); if (session.getState().phase === 'SUCCESS') break }
    expect(session.getState().result).toMatchObject({ lessonId: 'wall-ride', outcome: 'SUCCESS', completedCheckpoints: 8, totalCheckpoints: 8 })
  })

  it('preserves the route when ground height and launch coordinates change', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 7 }, spawnPositionM: { x: 5, y: 40, z: -3 } }
    const observer = recovered(config)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeCloseTo(14, 6)
    expect(observer.evaluation?.metrics?.wallRideGapM).toBeCloseTo(8, 6)
  })

  it('never gives ground or takeoff credit to an airborne initial state', () => {
    const observer = new Observer()
    observer.position = { ...observer.position, y: 14 }
    observer.repeat(10)
    expect(observer.checkpointStates).toEqual({})
    expect(observer.evaluation?.metrics?.wallRidePhase).toBe(0)
  })

  it.each(['upright', 'nose-toward-wall', 'belly-away-from-wall', 'pitch-only'] as const)('rejects %s as a substitute for belly-facing travel', (kind) => {
    const observer = entered()
    if (kind === 'belly-away-from-wall') observer.bankTo(-75)
    if (kind === 'nose-toward-wall') { observer.repeat(10, ZERO, { x: 0, y: Math.PI, z: 0 }); observer.safe() }
    if (kind === 'pitch-only') { observer.repeat(10, ZERO, { x: 2.5, y: 0, z: 0 }); observer.safe() }
    observer.axisTo('z', -26, 8)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideBellyFaced: 0, wallRideRideComplete: 0, wallRideDistanceM: 0 })
  })

  it('does not award along-wall distance for an in-place side bank even after sufficient elapsed time', () => {
    const observer = entered(); observer.bankTo(75); observer.repeat(30)
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideBellyFaced: 1, wallRideDistanceM: 0, wallRideRideComplete: 0 })
    expect(observer.evaluation?.metrics?.wallRideSeconds).toBeGreaterThan(0.3)
    expect(observer.evaluation?.status).toBe('continue')
  })

  it.each([
    { name: 'too close', axis: 'x' as const, destination: 9.3, reason: 5 },
    { name: 'too far', axis: 'x' as const, destination: 3, reason: 6 },
    { name: 'over the accepted height', axis: 'y' as const, destination: 25, reason: 7 },
    { name: 'under the accepted height', axis: 'y' as const, destination: 2, reason: 7 },
  ])('freezes the first measured cause when the pass becomes $name', ({ axis, destination, reason }) => {
    const observer = entered(); observer.bankTo(75); observer.axisTo('z', -17, 8)
    observer.axisTo(axis, destination, 2)
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideInterrupted: 1, wallRideInterruptionReason: reason,
      wallRideDistanceM: 0, wallRideSeconds: 0, wallRideRideComplete: 0 })
    const frozen = { ...observer.evaluation?.metrics }
    observer.repeat(10)
    for (const key of ['interruptionWallRideGapM', 'interruptionWallRideAltitudeM', 'interruptionWallRideDistanceM', 'interruptionWallRideSeconds']) {
      expect(observer.evaluation?.metrics?.[key]).toBe(frozen[key])
    }
  })

  it('clears interrupted route evidence while keeping historic ticks and requires a new near-end approach', () => {
    const observer = entered(); observer.bankTo(75); observer.axisTo('z', -17, 8)
    observer.axisTo('x', 3)
    expect(observer.checkpointStates['wall-ride-belly-facing']?.completed).toBe(true)
    observer.axisTo('z', -25, 8)
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideEpisodeValid: 0, wallRideDistanceM: 0, wallRideRideComplete: 0 })
    for (const id of WALL_RIDE_PHASE_IDS) observer.checkpointStates = { ...observer.checkpointStates,
      [id]: { id, completed: true, completedAtSeconds: 1, metrics: {} } }
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
    observer.axisTo('z', -9, 5); observer.axisTo('x', 6); observer.axisTo('z', -20, 8)
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideEpisodeValid: 1, wallRideInterrupted: 0, wallRideRideComplete: 1 })
    observer.axisTo('x', 2); observer.bankTo(0); observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })

  it('cannot count a fast short segment as the complete distance and minimum observed duration', () => {
    const observer = entered(); observer.bankTo(75)
    // Start the actual pass just as orientation first qualifies, without a long hold.
    const sample = observer.nextSample()
    const previous = observer.trace.at(-1)!
    const proof = { ...observer.evaluation!, metrics: { ...observer.evaluation!.metrics,
      wallRideDistanceM: 0, wallRideSeconds: 0, wallRideRideStartZM: previous.state.positionM.z, wallRideQualifying: 1 } }
    const velocity = { x: 0, y: 0, z: -140 }
    const fast: TrainingSample = { ...sample, state: { ...sample.state, velocityMps: velocity,
      positionM: { ...sample.state.positionM, z: previous.state.positionM.z - 7 } } }
    const before = { ...previous, state: { ...previous.state, velocityMps: velocity } }
    const result = observer.evaluate(fast, { previousSample: before, previousFlightSample: before, previousEvaluation: proof })
    expect(result.status).toBe('continue')
    expect(result.metrics?.wallRideDistanceM).toBe(7)
    expect(result.metrics?.wallRideSeconds).toBeCloseTo(STEP)
    expect(result.metrics?.wallRideRideComplete).toBe(0)
  })

  it('requires actual outward clearance after the pass before upright recovery can finish', () => {
    const observer = ridden(); observer.bankTo(0); observer.repeat(20)
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideRideComplete: 1, wallRideLeft: 0, wallRideRecovered: 0 })
    expect(observer.evaluation?.status).toBe('continue')
    observer.axisTo('x', 2); observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })

  it('does not accumulate a completed pass by reversing beyond the correction allowance', () => {
    const observer = entered(); observer.bankTo(75); observer.axisTo('z', -17, 8)
    expect(observer.evaluation?.metrics?.wallRideDistanceM).toBeCloseTo(3)
    observer.axisTo('z', -13, 4)
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideInterrupted: 1, wallRideInterruptionReason: 9,
      wallRideDistanceM: 0, wallRideSeconds: 0, wallRideRideComplete: 0 })
    expect(observer.checkpointStates['wall-ride-belly-facing']?.completed).toBe(true)
    expect(observer.evaluation?.status).toBe('continue')
  })

  it('detects a continuous swept wall crossing even after a local route interruption', () => {
    const observer = entered()
    let result: TrainingEvaluation | null = null
    for (let i = 0; i < 20; i += 1) { result = observer.tick({ x: 12, y: 0, z: 0 }); if (result.status === 'failure') break }
    expect(result).toMatchObject({ status: 'failure', message: expect.stringContaining('Obstacle collision: wall-ride-wall') })
  })

  it('rejects direct entry from behind the wall or the wall middle without a genuine approach', () => {
    const observer = airborne()
    observer.axisTo('x', 13)
    observer.axisTo('z', -25, 5)
    observer.bankTo(75)
    expect(observer.evaluation?.metrics).toMatchObject({ wallRideInterrupted: 1, wallRideDistanceM: 0, wallRideRideComplete: 0 })
    expect(observer.evaluation?.status).toBe('continue')
  })

  it('keeps challenge timeout separate from unlimited practice', () => {
    const observer = entered(), sample = observer.nextSample()
    expect(observer.evaluate(sample, { mode: 'challenge', elapsedSeconds: 301 })).toMatchObject({ status: 'failure', message: expect.stringContaining('逾時') })
    expect(observer.evaluate(sample, { mode: 'practice', elapsedSeconds: 3000 }).status).toBe('continue')
  })

  it.each(['teleport', 'clock-reset', 'large-gap', 'step-reset', 'pose-jump', 'missing-prior', 'disarmed', 'crashed', 'invalid-contact'] as const)('rejects %s rather than granting route proof', (kind) => {
    const observer = entered(), sample = observer.nextSample()
    let changed = sample
    const overrides: Partial<TrainingEvaluationContext> = kind === 'missing-prior'
      ? { previousSample: null, previousFlightSample: null } : {}
    if (kind === 'teleport') changed = { ...sample, state: { ...sample.state, positionM: { ...sample.state.positionM, z: sample.state.positionM.z - 10 } } }
    if (kind === 'clock-reset') changed = { ...sample, state: { ...sample.state, timeSeconds: 0 } }
    if (kind === 'large-gap') changed = { ...sample, timestampSeconds: sample.timestampSeconds + 1, state: { ...sample.state, timeSeconds: sample.state.timeSeconds + 1 } }
    if (kind === 'step-reset') changed = { ...sample, state: { ...sample.state, stepIndex: 0 } }
    if (kind === 'pose-jump') changed = { ...sample, state: { ...sample.state, orientation: quaternionFromRotationVector({ x: 0, y: 0, z: Math.PI / 2 }) } }
    if (kind === 'disarmed') changed = { ...sample, armed: false }
    if (kind === 'crashed') changed = { ...sample, state: { ...sample.state, crashed: true, warnings: ['Obstacle collision: wall-ride-wall'] } }
    if (kind === 'invalid-contact') changed = { ...sample, groundContact: { ...sample.groundContact!, touching: true } }
    expect(observer.evaluate(changed, overrides).status).toBe('failure')
  })
})
