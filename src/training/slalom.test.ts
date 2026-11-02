import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { integrateBodyAngularVelocity, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createSlalomFlags, SLALOM_EXIT_DISTANCE_M, SLALOM_FLAG_IDS } from '../world/slalomFlags'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import { SLALOM_LEARNING_CONTENT, SLALOM_LESSON, SLALOM_PHASE_IDS, slalomEvaluator } from './slalom'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG) {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing },
    ...createSlalomFlags(launch, config.ground.heightM).map((flag) => ({ id: flag.id, kind: 'flag', positionM: flag.positionM }))]
}
function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: SLALOM_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: {}, sceneReferences: references(), ...overrides }
}
/** Continuous kinematic observations; actual motor/RC flight is covered independently by the demo. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public checkpointStates: Readonly<Record<string, TrainingCheckpointState>> = {}
  public readonly trace: TrainingSample[] = []
  public readonly evaluations: TrainingEvaluation[] = []
  public position: Vector3
  public velocity: Vector3 = ZERO
  public rate: Vector3 = ZERO
  public orientation: Quaternion = quaternionFromRotationVector(ZERO)
  public constructor(public readonly config = DEFAULT_DRONE_CONFIG) { this.position = createTrainingFieldAnchors(config).launch }
  public tick(velocity: Vector3 = ZERO, rate: Vector3 = ZERO): TrainingEvaluation {
    this.position = { x: this.position.x + (this.velocity.x + velocity.x) * STEP / 2,
      y: this.position.y + (this.velocity.y + velocity.y) * STEP / 2,
      z: this.position.z + (this.velocity.z + velocity.z) * STEP / 2 }
    this.orientation = integrateBodyAngularVelocity(this.orientation, { x: (this.rate.x + rate.x) / 2,
      y: (this.rate.y + rate.y) / 2, z: (this.rate.z + rate.z) / 2 }, STEP)
    this.velocity = velocity; this.rate = rate
    const t = (this.trace.length + 1) * STEP
    const support = droneGroundSupport(this.config, this.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: t, armed: true, normalizedInput: null,
      groundContact: { heightM: this.config.ground.heightM, supportOffsetM: support,
        touching: Math.abs(this.position.y - this.config.ground.heightM - support - DRONE_GROUND_CLEARANCE_M) < 1e-8 },
      state: { ...createInitialDroneState(this.config, this.position, this.orientation), velocityMps: velocity,
        angularVelocityBodyRadPerSec: rate, timeSeconds: t, stepIndex: this.trace.length + 1 } }
    const previous = this.trace.at(-1)
    const result = slalomEvaluator.evaluate(sample, context({ elapsedSeconds: t, sceneReferences: references(this.config),
      checkpoints: this.checkpointStates, previousSample: previous, previousFlightSample: previous, previousEvaluation: this.evaluation }))
    this.evaluation = result; this.trace.push(sample); this.evaluations.push(result)
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
      // Account for the final trapezoidal braking step instead of oscillating
      // by a fixed velocity quantum around the destination.
      const velocityToStopAtTarget = (destination - this.position[axis]) / STEP - this.velocity[axis] / 2
      if (Math.abs(velocityToStopAtTarget) <= speed) {
        this.safe({ ...ZERO, [axis]: velocityToStopAtTarget })
        this.safe()
        expect(this.position[axis]).toBeCloseTo(destination, 8)
        return
      }
      this.safe({ ...ZERO, [axis]: Math.sign(velocityToStopAtTarget) * speed })
    }
    throw new Error(`Could not reach ${axis}=${destination}.`)
  }
}
function airborne(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = new Observer(config)
  observer.safe(); observer.axisTo('y', config.ground.heightM + 4)
  observer.safe()
  expect(observer.evaluation?.metrics).toMatchObject({ slalomPhase: 2, slalomEpisodeValid: 1, slalomFlagsPassed: 0 })
  return observer
}
function passFlags(observer = airborne(), number = 6): Observer {
  const flags = createSlalomFlags(createTrainingFieldAnchors(observer.config).launch, observer.config.ground.heightM)
  for (let index = 0; index < number; index += 1) {
    if (index > 0) observer.axisTo('z', flags[index - 1].positionM.z - 5, 6)
    observer.axisTo('x', flags[index].passPointM.x)
    observer.axisTo('z', flags[index].positionM.z - 0.7, 6)
    expect(observer.evaluation?.metrics?.slalomFlagsPassed).toBe(index + 1)
  }
  return observer
}
function exited(config = DEFAULT_DRONE_CONFIG): Observer {
  const observer = passFlags(airborne(config))
  const last = createSlalomFlags(createTrainingFieldAnchors(config).launch, config.ground.heightM).at(-1)!
  observer.axisTo('z', last.positionM.z - SLALOM_EXIT_DISTANCE_M - 0.2, 5)
  expect(observer.evaluation?.metrics?.slalomExited).toBe(1)
  return observer
}

describe('L18 forward alternating flag route', () => {
  it('defines ten Chinese stages and real ground setup without an airborne spawn', () => {
    expect(SLALOM_LEARNING_CONTENT).toMatchObject({ code: 'L18', title: '刀旗 S 彎' })
    expect(SLALOM_LESSON).toMatchObject({ id: 'slalom', available: true, title: '刀旗 S 彎' })
    expect(SLALOM_LESSON.checkpoints.map(({ id }) => id)).toEqual(SLALOM_PHASE_IDS)
    expect(SLALOM_PHASE_IDS).toHaveLength(10)
    expect(SLALOM_LESSON.setup.sceneReferenceIds).toEqual(['training-launch', 'landing-surface', ...SLALOM_FLAG_IDS, 'slalom-exit'])
    expect(SLALOM_LESSON.setup.spawnPositionM).toBeUndefined()
  })
  it('finishes six true left-right crossings and a forward exit without a fixed bank, stop or stick ritual', () => {
    const observer = exited()
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ slalomPhase: 10, slalomFlagsPassed: 6,
      slalomEpisodeValid: 1, slalomExited: 1, slalomRecovered: 1, tiltDegrees: 0 })
    expect(Object.keys(observer.checkpointStates)).toEqual(SLALOM_PHASE_IDS)
  })
  it('creates an actual complete ten-checkpoint session from the accepted observations', () => {
    const observer = exited(); observer.repeat(8)
    const session = new TrainingSession({ lessons: [SLALOM_LESSON], initialLessonId: 'slalom', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0); session.tick(0)
    for (const sample of observer.trace) { session.consumeSample(sample); if (session.getState().phase === 'SUCCESS') break }
    expect(session.getState().result).toMatchObject({ lessonId: 'slalom', outcome: 'SUCCESS', completedCheckpoints: 10, totalCheckpoints: 10 })
  })
  it('uses raised ground and translated launch anchors for the identical route', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 7 }, spawnPositionM: { x: 5, y: 40, z: -3 } }
    const observer = exited(config); observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeCloseTo(4, 0)
  })
  it('does not start in the air or give takeoff credit to a missing ground start', () => {
    const observer = new Observer()
    observer.position = { ...observer.position, y: 4 }
    observer.repeat(8)
    expect(observer.checkpointStates).toEqual({})
    expect(observer.evaluation?.metrics?.slalomPhase).toBe(0)
  })
  it.each([
    { name: 'wrong side', x: 4, y: 4, reason: 4 },
    { name: 'too close to the banner', x: -0.8, y: 4, reason: 5 },
    { name: 'far outer bypass', x: -9, y: 4, reason: 6 },
    { name: 'overflight', x: -4, y: 8.5, reason: 7 },
    { name: 'under the passing range', x: -4, y: 0.8, reason: 7 },
  ])('gives concrete frozen evidence for $name', ({ x, y, reason }) => {
    const observer = airborne(); observer.axisTo('y', y, 2); observer.axisTo('x', x, 2); observer.axisTo('z', -17, 4)
    expect(observer.evaluation?.metrics).toMatchObject({ slalomInterrupted: 1, slalomInterruptionReason: reason,
      slalomFlagsPassed: 0, interruptionSlalomFlagIndex: 0 })
    const frozen = observer.evaluation?.metrics?.interruptionSlalomSideOffsetM
    observer.repeat(10, { x: 2, y: 0, z: -2 })
    expect(observer.evaluation?.metrics?.interruptionSlalomSideOffsetM).toBe(frozen)
    expect(observer.checkpointStates['slalom-flag-1']).toBeUndefined()
  })
  it('requires alternating physical sides rather than flying straight down one side', () => {
    const observer = passFlags(airborne(), 1)
    observer.axisTo('z', -29, 5)
    expect(observer.evaluation?.metrics).toMatchObject({ slalomInterruptionReason: 4, interruptionSlalomFlagIndex: 1, slalomFlagsPassed: 0 })
    expect(observer.checkpointStates['slalom-flag-1']?.completed).toBe(true)
    expect(observer.checkpointStates['slalom-flag-2']).toBeUndefined()
  })
  it('cannot replace progress with in-place roll or yaw movement', () => {
    const observer = airborne()
    observer.repeat(20, ZERO, { x: 0, y: 1, z: 0 })
    observer.repeat(20, ZERO, { x: 0, y: -1, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ slalomFlagsPassed: 0, slalomExited: 0 })
  })
  it('invalidates a turn back exceeding the visible three-metre correction allowance', () => {
    const observer = passFlags(airborne(), 1)
    for (let count = 0; count < 25 && observer.evaluation?.metrics?.slalomInterrupted !== 1; count += 1) {
      observer.safe({ x: 0, y: 0, z: 4 })
    }
    expect(observer.evaluation?.metrics).toMatchObject({ slalomInterruptionReason: 9, slalomFlagsPassed: 0 })
    expect(observer.evaluation?.metrics?.interruptionSlalomBacktrackM).toBeGreaterThan(3)
  })
  it('rejects a missing earlier flag instead of borrowing its stored checkpoint', () => {
    const observer = passFlags(airborne(), 1)
    observer.evaluation = { ...observer.evaluation!, metrics: { ...observer.evaluation!.metrics, slalomFlagsPassed: 0 } }
    observer.safe({ x: 0, y: 0, z: -1 })
    expect(observer.evaluation?.metrics).toMatchObject({ slalomInterruptionReason: 8, slalomFlagsPassed: 0 })
  })
  it('restarts before the first flag and requires a complete fresh route despite historical ticks', () => {
    const observer = passFlags(airborne(), 1)
    observer.axisTo('z', -29, 5)
    expect(observer.evaluation?.metrics?.slalomInterrupted).toBe(1)
    observer.axisTo('z', -10, 5)
    expect(observer.evaluation?.metrics).toMatchObject({ slalomInterrupted: 0, slalomEpisodeValid: 1, slalomFlagsPassed: 0 })
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
    passFlags(observer)
    observer.axisTo('z', -85, 5); observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.slalomFlagsPassed).toBe(6)
  })
  it('does not turn historical completed checkpoints into a new route completion', () => {
    const observer = airborne()
    observer.checkpointStates = Object.fromEntries(SLALOM_PHASE_IDS.map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics).toMatchObject({ slalomFlagsPassed: 0, slalomExited: 0, slalomPhase: 2 })
  })
  it('keeps recovery beyond the exit plane instead of recovering after drifting back inside', () => {
    const observer = passFlags()
    const last = createSlalomFlags(references()[0].positionM, 0).at(-1)!
    while (observer.position.z > last.positionM.z - SLALOM_EXIT_DISTANCE_M - 0.03) observer.safe({ x: 0, y: 0, z: -2 })
    // Return inside before the .2 s recovery has completed; three-metre local correction is still allowed.
    observer.repeat(2, { x: 0, y: 0, z: 2 })
    observer.repeat(8)
    expect(observer.evaluation?.metrics?.slalomRecovered).toBe(0)
    observer.axisTo('z', -85, 2); observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('freezes the actual exit-plane crossing height rather than the later sample endpoint', () => {
    const exitZ = createSlalomFlags(references()[0].positionM, 0).at(-1)!.positionM.z - SLALOM_EXIT_DISTANCE_M
    const sample = (t: number, y: number, z: number): TrainingSample => ({
      timestampSeconds: t, armed: true, normalizedInput: null,
      groundContact: { heightM: 0, supportOffsetM: 0.05, touching: false },
      state: { ...createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: 4, y, z }),
        velocityMps: { x: 0, y: 4, z: -2 }, timeSeconds: t, stepIndex: Math.round(t * 100) },
    })
    const before = sample(1, 9.8, exitZ + 0.2)
    const current = sample(1.2, 10.6, exitZ - 0.2)
    const checkpoints = Object.fromEntries(SLALOM_PHASE_IDS.slice(0, 8).map((id) => [id,
      { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
    const evaluation = slalomEvaluator.evaluate(current, context({ checkpoints,
      previousSample: before, previousFlightSample: before, previousEvaluation: { status: 'continue', metrics: {
        slalomEpisodeValid: 1, slalomFlagsPassed: 6, slalomFurthestForwardM: -before.state.positionM.z,
      } } }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.metrics).toMatchObject({ slalomInterrupted: 1, slalomInterruptionReason: 10,
      slalomExited: 0, slalomRecovered: 0 })
    expect(evaluation.metrics?.interruptionSlalomAltitudeM).toBeCloseTo(10.2, 8)
    expect(evaluation.metrics?.altitudeM).toBeCloseTo(10.6, 8)
    expect(evaluation.checkpointIds).toEqual([])
  })
  it('stops a swept path through a solid banner before awarding its flag', () => {
    const observer = airborne()
    for (let count = 0; count < 100 && observer.evaluation?.status !== 'failure'; count += 1) {
      observer.tick({ x: 0, y: 0, z: -5 })
    }
    expect(observer.evaluation?.status).toBe('failure')
    expect(observer.evaluation?.message).toContain('slalom-flag-1-banner')
    expect(observer.checkpointStates['slalom-flag-1']).toBeUndefined()
  })
  it.each(['disarm', 'crash', 'missing-contact', 'teleport', 'clock', 'angular-jump'] as const)('stops invalid %s evidence', (kind) => {
    const observer = airborne()
    const before = observer.trace.at(-1)!
    const current: TrainingSample = { ...before, timestampSeconds: before.timestampSeconds + STEP,
      state: { ...before.state, timeSeconds: before.state.timeSeconds + STEP, stepIndex: before.state.stepIndex + 1 } }
    const altered: TrainingSample = kind === 'disarm' ? { ...current, armed: false }
      : kind === 'crash' ? { ...current, state: { ...current.state, crashed: true } }
        : kind === 'missing-contact' ? { ...current, groundContact: undefined }
          : kind === 'teleport' ? { ...current, state: { ...current.state, positionM: { ...current.state.positionM, z: -70 } } }
            : kind === 'clock' ? { ...current, state: { ...current.state, timeSeconds: before.state.timeSeconds } }
              : { ...current, state: { ...current.state, orientation: quaternionFromRotationVector({ x: 1, y: 0, z: 0 }) } }
    const result = slalomEvaluator.evaluate(altered, context({ checkpoints: observer.checkpointStates, previousSample: before,
      previousFlightSample: before, previousEvaluation: observer.evaluation }))
    expect(result.status).toBe('failure')
  })
  it('makes practice untimed and applies the stated limit only to challenge', () => {
    const observer = airborne()
    const before = observer.trace.at(-1)!
    const sample = { ...before, timestampSeconds: before.timestampSeconds + STEP, state: { ...before.state,
      timeSeconds: before.state.timeSeconds + STEP, stepIndex: before.state.stepIndex + 1 } }
    const ctx = { checkpoints: observer.checkpointStates, previousSample: before, previousEvaluation: observer.evaluation, elapsedSeconds: 301 }
    expect(slalomEvaluator.evaluate(sample, context({ ...ctx, mode: 'practice' })).status).toBe('continue')
    expect(slalomEvaluator.evaluate(sample, context({ ...ctx, mode: 'challenge' })).message).toContain('逾時')
  })
})
