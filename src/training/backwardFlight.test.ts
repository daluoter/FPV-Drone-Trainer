import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { integrateBodyAngularVelocity, quaternionFromRotationVector, rotateVectorByQuaternion, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import { BACKWARD_FLIGHT_LEARNING_CONTENT, BACKWARD_FLIGHT_LESSON, BACKWARD_FLIGHT_PHASE_IDS, BACKWARD_FLIGHT_REQUIRED_DISTANCE_M, BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS, BACKWARD_FLIGHT_RECOVERY_SECONDS, backwardFlightEvaluator, measureBackwardFlightMotion } from './backwardFlight'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG) {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing }]
}
function checkpoints(phase = 0): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(BACKWARD_FLIGHT_PHASE_IDS.slice(0, phase).map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
}
function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: BACKWARD_FLIGHT_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: {}, sceneReferences: references(), ...overrides }
}

/** Coherent kinematic observations; actual controls/physics are tested by the demo. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public checkpointStates = checkpoints()
  public readonly trace: TrainingSample[] = []
  public readonly evaluations: TrainingEvaluation[] = []
  public position: Vector3
  private velocity: Vector3 = ZERO
  private rate: Vector3 = ZERO
  private orientation: Quaternion
  public constructor(public readonly config = DEFAULT_DRONE_CONFIG, yawOffset = 0) {
    this.position = createTrainingFieldAnchors(config).launch
    this.orientation = quaternionFromRotationVector({ x: 0, y: yawOffset, z: 0 })
  }
  public tick(velocity: Vector3 = ZERO, rate: Vector3 = ZERO, orientation?: Quaternion): TrainingEvaluation {
    this.position = { x: this.position.x + (this.velocity.x + velocity.x) * STEP / 2,
      y: this.position.y + (this.velocity.y + velocity.y) * STEP / 2,
      z: this.position.z + (this.velocity.z + velocity.z) * STEP / 2 }
    this.orientation = orientation ?? integrateBodyAngularVelocity(this.orientation, {
      x: (this.rate.x + rate.x) / 2, y: (this.rate.y + rate.y) / 2, z: (this.rate.z + rate.z) / 2,
    }, STEP)
    this.velocity = velocity
    this.rate = rate
    const timestampSeconds = (this.trace.length + 1) * STEP
    const supportOffsetM = droneGroundSupport(this.config, this.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds, armed: true, normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
      groundContact: { heightM: this.config.ground.heightM, supportOffsetM,
        touching: this.position.y - this.config.ground.heightM - supportOffsetM - DRONE_GROUND_CLEARANCE_M < 1e-8 },
      state: { ...createInitialDroneState(this.config, this.position, this.orientation), velocityMps: velocity,
        angularVelocityBodyRadPerSec: rate, timeSeconds: timestampSeconds, stepIndex: this.trace.length + 1 } }
    const previous = this.trace.at(-1)
    const result = backwardFlightEvaluator.evaluate(sample, context({ elapsedSeconds: timestampSeconds,
      sceneReferences: references(this.config), checkpoints: this.checkpointStates, previousSample: previous,
      previousFlightSample: previous, previousEvaluation: this.evaluation }))
    this.evaluation = result
    this.trace.push(sample)
    this.evaluations.push(result)
    for (const id of result.checkpointIds ?? []) this.checkpointStates = { ...this.checkpointStates,
      [id]: { id, completed: true, completedAtSeconds: timestampSeconds, metrics: result.metrics ?? {} } }
    return result
  }
  public safe(velocity: Vector3 = ZERO, rate: Vector3 = ZERO, orientation?: Quaternion): TrainingEvaluation {
    const result = this.tick(velocity, rate, orientation)
    expect(result.status, result.message).not.toBe('failure')
    expect(result.checkpointIds?.length ?? 0).toBeLessThanOrEqual(1)
    return result
  }
  public repeat(count: number, velocity: Vector3 = ZERO, rate: Vector3 = ZERO): void {
    for (let i = 0; i < count; i += 1) this.safe(velocity, rate)
  }
  public turn(direction = 1, count = 40): void {
    this.repeat(count, this.velocity, { x: 0, y: direction * Math.PI / 2, z: 0 })
    this.safe(this.velocity)
  }
  public forward(speed = 4): Vector3 {
    const nose = rotateVectorByQuaternion(this.orientation, { x: 0, y: 0, z: -1 })
    const length = Math.hypot(nose.x, nose.z)
    return { x: nose.x / length * speed, y: 0, z: nose.z / length * speed }
  }

}
function atEntry(config = DEFAULT_DRONE_CONFIG, yawOffset = 0): Observer {
  const observer = new Observer(config, yawOffset)
  observer.safe()
  observer.repeat(40, { x: 0, y: 5, z: 0 })
  observer.safe()
  observer.repeat(8, observer.forward())
  expect(observer.evaluation?.metrics?.backwardPhase).toBe(3)
  expect(observer.evaluation?.metrics?.backwardEpisodeValid).toBe(1)
  return observer
}
function maintained(direction = 1, config = DEFAULT_DRONE_CONFIG, yawOffset = 0): Observer {
  const observer = atEntry(config, yawOffset)
  const velocity = observer.forward()
  observer.turn(direction)
  observer.repeat(15, velocity)
  expect(observer.evaluation?.metrics?.backwardPhase).toBe(6)
  expect(observer.evaluation?.metrics?.backwardMaintained).toBe(1)
  expect(observer.evaluation?.status).toBe('continue')
  return observer
}

describe('ground-start retained-momentum backward flight', () => {
  it('exposes independent seven Chinese steps and a genuine ground setup', () => {
    expect(BACKWARD_FLIGHT_LESSON).toMatchObject({ id: 'backward-flight', title: '後退飛行', available: true })
    expect(BACKWARD_FLIGHT_LEARNING_CONTENT).toMatchObject({ code: 'L17', title: '後退飛行' })
    expect(BACKWARD_FLIGHT_LESSON.checkpoints.map(({ id }) => id)).toEqual(BACKWARD_FLIGHT_PHASE_IDS)
    expect(BACKWARD_FLIGHT_LESSON.setup.sceneReferenceIds).toEqual(['training-launch', 'landing-surface', 'backward-zone'])
    expect(BACKWARD_FLIGHT_LESSON.setup.spawnPositionM).toBeUndefined()
    expect(BACKWARD_FLIGHT_REQUIRED_DISTANCE_M).toBe(3)
    expect(BACKWARD_FLIGHT_REQUIRED_HOLD_SECONDS).toBe(0.6)
    expect(BACKWARD_FLIGHT_RECOVERY_SECONDS).toBe(0.25)
  })
  it.each([1, -1])('accepts retained forward momentum and yaw direction %s followed by braking', (direction) => {
    const observer = maintained(direction)
    expect(observer.evaluation?.metrics?.backwardYawDegrees).toBeCloseTo(180)
    expect(observer.evaluation?.metrics?.backwardSpeedMps).toBeCloseTo(4)
    expect(observer.evaluation?.metrics?.backwardVelocityHeadingDegrees).toBeCloseTo(180)
    expect(observer.evaluation?.metrics?.backwardDistanceM).toBeGreaterThanOrEqual(3 - 1e-8)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ backwardPhase: 7, backwardRecoveryQualifying: 1 })
    expect(Object.keys(observer.checkpointStates)).toEqual(BACKWARD_FLIGHT_PHASE_IDS)
    expect(observer.trace.every(({ normalizedInput }) => normalizedInput?.yaw === 0)).toBe(true)
  })
  it('supports turning back toward actual travel instead of stopping', () => {
    const observer = maintained()
    const velocity = { x: 0, y: 0, z: -4 }
    observer.turn()
    observer.repeat(8, velocity)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.horizontalSpeedMps).toBeCloseTo(4)
    expect(observer.evaluation?.metrics?.backwardVelocityHeadingDegrees).toBeLessThan(1)
  })
  it('works with a shifted ground, launch position and arbitrary entry heading', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 8 }, spawnPositionM: { x: 6, y: 45, z: -3 } }
    const observer = maintained(-1, config, Math.PI / 2)
    observer.repeat(8)
    expect(observer.trace[0].groundContact?.touching).toBe(true)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeCloseTo(10.046)
    expect(observer.evaluation?.metrics?.backwardEntryDirectionX).toBeCloseTo(-1)
  })
  it('creates a complete independent actual session result', () => {
    const observer = maintained()
    observer.repeat(8)
    const session = new TrainingSession({ lessons: [BACKWARD_FLIGHT_LESSON], initialLessonId: 'backward-flight', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const sample of observer.trace) {
      session.consumeSample(sample)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ lessonId: 'backward-flight', outcome: 'SUCCESS', completedCheckpoints: 7, totalCheckpoints: 7 })
  })
  it('does not treat stationary yaw, straight flight, side flight or inverted flight as backward travel', () => {
    const stationary = new Observer()
    stationary.safe()
    stationary.repeat(40, { x: 0, y: 5, z: 0 })
    stationary.safe()
    stationary.turn()
    stationary.repeat(30)
    expect(stationary.evaluation?.metrics?.backwardPhase).toBe(2)
    expect(stationary.evaluation?.metrics?.backwardEpisodeValid).toBe(0)
    const straight = atEntry()
    straight.repeat(100, { x: 0, y: 0, z: -4 })
    expect(straight.evaluation?.metrics?.backwardPhase).toBe(3)
    expect(straight.evaluation?.metrics?.backwardDistanceM).toBe(0)
    const side = new Observer()
    side.safe()
    side.repeat(40, { x: 0, y: 5, z: 0 })
    side.safe()
    side.repeat(20, { x: 4, y: 0, z: 0 })
    expect(side.evaluation?.metrics?.backwardEpisodeValid).toBe(0)
    const inverted = atEntry()
    inverted.repeat(30, { x: 0, y: 0, z: -4 }, { x: 0, y: 0, z: Math.PI })
    expect(inverted.evaluations.some(({ metrics }) => metrics?.backwardInterruptionReason === 5)).toBe(true)
    expect(inverted.evaluation?.metrics?.backwardMaintained).toBe(0)
  })
  it('rejects stopping before the turn and then starting a new forward flight', () => {
    const observer = atEntry()
    observer.repeat(10)
    expect(observer.evaluation?.metrics).toMatchObject({ backwardEpisodeValid: 0, backwardInterrupted: 1, backwardInterruptionReason: 6 })
    observer.turn()
    observer.repeat(30, observer.forward())
    expect(observer.evaluation?.metrics?.backwardPhase).toBe(3)
    expect(observer.evaluation?.metrics?.backwardDistanceM).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('requires both real distance and valid backward time rather than a brief reversed snapshot', () => {
    const observer = atEntry()
    observer.turn(1, 32)
    expect(observer.evaluation?.metrics?.backwardDistanceM).toBeLessThan(3)
    expect(observer.evaluation?.status).toBe('continue')
    observer.repeat(10, { x: 0, y: 0, z: -1.1 })
    expect(observer.evaluation?.metrics?.backwardDistanceM).toBeLessThan(3)
    expect(observer.evaluation?.metrics?.backwardHoldSeconds).toBeGreaterThan(0.6)
    expect(observer.evaluation?.metrics?.backwardMaintained).toBe(0)
    observer.repeat(40, { x: 0, y: 0, z: -1.1 })
    expect(observer.evaluation?.metrics?.backwardPhase).toBe(6)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('does not complete with a reversed head but velocity that followed the new head', () => {
    const observer = atEntry()
    observer.turn()
    observer.repeat(20, observer.forward())
    expect(observer.evaluation?.metrics?.backwardMaintained).toBe(0)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluations.some(({ metrics }) => metrics?.backwardInterruptionReason === 6)).toBe(true)
  })
  it('requires actual recovery observations after the route and does not accept old milestone flags', () => {
    const observer = maintained()
    observer.repeat(2)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics?.backwardRecoveryDwellSeconds).toBeLessThan(0.25)
    const sample = observer.trace.at(-1)!
    const stale = backwardFlightEvaluator.evaluate({ ...sample, timestampSeconds: sample.timestampSeconds + STEP,
      state: { ...sample.state, timeSeconds: sample.state.timeSeconds + STEP, stepIndex: sample.state.stepIndex + 1 } },
    context({ checkpoints: checkpoints(7), previousFlightSample: sample }))
    expect(stale.status).toBe('failure')
    expect(stale.message).toContain('缺少同一段')
  })
  it('preserves the first interruption snapshot and requires a new whole route after local retry', () => {
    const observer = atEntry()
    observer.turn()
    observer.repeat(10)
    const snapshot = observer.evaluations.find(({ metrics }) => metrics?.backwardInterruptionReason === 6)!.metrics!
    expect(observer.evaluation?.metrics?.interruptionBackwardDistanceM).toBe(snapshot.interruptionBackwardDistanceM)
    observer.repeat(10)
    expect(observer.evaluation?.metrics?.interruptionBackwardSpeedMps).toBe(snapshot.interruptionBackwardSpeedMps)
    expect(observer.evaluation?.metrics?.backwardPhase).toBe(5)
    observer.repeat(8, observer.forward())
    expect(observer.evaluation?.metrics).toMatchObject({ backwardEpisodeValid: 1, backwardInterrupted: 0, backwardMaintained: 0, backwardDistanceM: 0 })
    observer.repeat(10)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics?.backwardMaintained).toBe(0)
    observer.repeat(8, observer.forward())
    const velocity = observer.forward()
    observer.turn(-1)
    observer.repeat(15, velocity)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('requires a measured slowdown after a slow backward route instead of passing on a steady coast', () => {
    const observer = atEntry()
    const slow = { x: 0, y: 0, z: -2 }
    observer.repeat(8, slow)
    observer.turn()
    observer.repeat(30, slow)
    expect(observer.evaluation?.metrics).toMatchObject({ backwardPhase: 6, backwardMaintained: 1,
      backwardCompletionSpeedMps: 2, backwardRecoverySpeedLimitMps: 1.5, backwardRecoveryQualifying: 0 })
    observer.repeat(20, slow)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics?.backwardRecoveryDwellSeconds).toBe(0)
    observer.repeat(8, { x: 0, y: 0, z: -1 })
    expect(observer.evaluation?.status).toBe('success')
  })
  it('cannot substitute a very short high-speed reversed interval for the backward holding time', () => {
    const observer = atEntry()
    observer.turn(1, 30)
    observer.repeat(3, { x: 0, y: 0, z: -20 })
    expect(observer.evaluation?.metrics?.backwardDistanceM).toBeGreaterThan(3)
    expect(observer.evaluation?.metrics?.backwardHoldSeconds).toBeLessThan(0.6)
    expect(observer.evaluation?.metrics?.backwardMaintained).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('subtracts reverse travel during brief height corrections so the same valid strip cannot be pumped', () => {
    const observer = atEntry()
    observer.repeat(60, { x: 0, y: -2, z: -4 })
    observer.safe({ x: 0, y: 0, z: -4 })
    expect(observer.evaluation?.metrics?.altitudeM).toBeGreaterThan(4)
    expect(observer.evaluation?.metrics?.altitudeM).toBeLessThan(4.2)
    observer.turn(1, 32)
    const before = observer.evaluation!.metrics!.backwardDistanceM
    for (let cycle = 0; cycle < 8; cycle += 1) {
      observer.safe({ x: 0, y: -4, z: -4 })
      expect(observer.evaluation?.metrics?.altitudeM).toBeLessThan(4)
      observer.safe({ x: 0, y: 0, z: 4 })
      observer.safe({ x: 0, y: 0, z: 4 })
      observer.safe({ x: 0, y: 4, z: -4 })
      observer.safe({ x: 0, y: 0, z: -4 })
      observer.safe({ x: 0, y: 0, z: -4 })
    }
    expect(observer.evaluation?.metrics?.backwardDistanceM).toBeLessThanOrEqual(before + 1e-8)
    expect(observer.evaluation?.metrics).toMatchObject({ backwardEpisodeValid: 1, backwardMaintained: 0 })
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('observes loss of original momentum even while outside the normal height band', () => {
    const observer = atEntry()
    observer.repeat(60, { x: 0, y: -2, z: -4 })
    observer.safe({ x: 0, y: 0, z: -4 })
    observer.turn(1, 32)
    observer.safe({ x: 0, y: -4, z: -4 })
    observer.repeat(6)
    expect(observer.evaluation?.metrics).toMatchObject({ backwardEpisodeValid: 0, backwardMaintained: 0,
      backwardInterruptionReason: 6, backwardInterrupted: 1 })
    expect(observer.evaluation?.metrics?.interruptionAltitudeM).toBeLessThan(4)
  })
  it('keeps distinct measured nose and velocity directions', () => {
    const front = measureBackwardFlightMotion({ orientation: quaternionFromRotationVector(ZERO), velocityMps: { x: 0, y: -2, z: -4 }, angularVelocityBodyRadPerSec: ZERO })
    const back = measureBackwardFlightMotion({ orientation: quaternionFromRotationVector({ x: 0, y: Math.PI, z: 0 }), velocityMps: { x: 0, y: -2, z: -4 }, angularVelocityBodyRadPerSec: ZERO })
    expect(front).toMatchObject({ backwardSpeedMps: -4, backwardVelocityHeadingDegrees: 0, verticalSpeedMps: -2 })
    expect(back.backwardSpeedMps).toBeCloseTo(4)
    expect(back.backwardVelocityHeadingDegrees).toBeCloseTo(180)
  })
  it('rejects invalid physical time, sample resets, teleportation and attitude changes inconsistent with the gyro', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    const next: TrainingSample = { ...sample, timestampSeconds: sample.timestampSeconds + STEP,
      state: { ...sample.state, timeSeconds: sample.state.timeSeconds + STEP, stepIndex: sample.state.stepIndex + 1,
        positionM: { ...sample.state.positionM, z: sample.state.positionM.z - 4 * STEP } } }
    const ctx = context({ checkpoints: observer.checkpointStates, previousFlightSample: sample, previousEvaluation: observer.evaluation })
    const invalidSamples = [
      { ...next, timestampSeconds: sample.timestampSeconds },
      { ...next, state: { ...next.state, timeSeconds: sample.state.timeSeconds } },
      { ...next, state: { ...next.state, stepIndex: sample.state.stepIndex } },
      { ...next, state: { ...next.state, positionM: { ...next.state.positionM, x: 20 } } },
      { ...next, state: { ...next.state, orientation: quaternionFromRotationVector({ x: 0, y: Math.PI / 2, z: 0 }) } },
      { ...next, state: { ...next.state, velocityMps: { x: NaN, y: 0, z: 0 } } },
    ]
    for (const invalid of invalidSamples) expect(backwardFlightEvaluator.evaluate(invalid, ctx).status).toBe('failure')
    expect(backwardFlightEvaluator.evaluate(next, ctx).status).toBe('continue')
    expect(backwardFlightEvaluator.evaluate(next, { ...ctx, previousFlightSample: undefined }).status).toBe('failure')
  })
  it('accepts quaternion sign equivalence and does not use the RC command as success evidence', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    const next: TrainingSample = { ...sample, timestampSeconds: sample.timestampSeconds + STEP, normalizedInput: { roll: 1, pitch: 1, yaw: 1, throttle: 1 },
      state: { ...sample.state, timeSeconds: sample.state.timeSeconds + STEP, stepIndex: sample.state.stepIndex + 1,
        positionM: { ...sample.state.positionM, z: sample.state.positionM.z - 4 * STEP },
        orientation: { x: -sample.state.orientation.x, y: -sample.state.orientation.y, z: -sample.state.orientation.z, w: -sample.state.orientation.w } } }
    expect(backwardFlightEvaluator.evaluate(next, context({ checkpoints: observer.checkpointStates, previousFlightSample: sample, previousEvaluation: observer.evaluation })).status).toBe('continue')
  })
  it('requires real ground evidence, finite references, explicit arm and valid contact', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    expect(backwardFlightEvaluator.evaluate(sample, context()).checkpointIds).toBeUndefined()
    expect(backwardFlightEvaluator.evaluate({ ...sample, armed: undefined }, context()).status).toBe('continue')
    expect(backwardFlightEvaluator.evaluate({ ...sample, armed: false }, context()).status).toBe('failure')
    expect(backwardFlightEvaluator.evaluate({ ...sample, groundContact: undefined }, context()).status).toBe('failure')
    expect(backwardFlightEvaluator.evaluate({ ...sample, groundContact: { ...sample.groundContact!, touching: true } }, context()).status).toBe('failure')
    expect(backwardFlightEvaluator.evaluate(sample, context({ sceneReferences: [] })).status).toBe('failure')
    expect(backwardFlightEvaluator.evaluate({ ...sample, state: { ...sample.state, crashed: true } }, context()).status).toBe('failure')
  })
  it('allows unlimited practice but retains a challenge time limit', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    const ctx = context({ elapsedSeconds: 10000, checkpoints: observer.checkpointStates })
    expect(backwardFlightEvaluator.evaluate(sample, ctx).status).toBe('continue')
    expect(backwardFlightEvaluator.evaluate(sample, { ...ctx, mode: 'challenge' }).message).toContain('逾時')
  })
})
