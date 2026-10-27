import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { IDENTITY_QUATERNION, integrateBodyAngularVelocity, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'
import { SPLIT_S_LEARNING_CONTENT, SPLIT_S_LESSON, SPLIT_S_PHASE_IDS, splitSLearningEvaluator, measureSplitSMotion } from './splitS'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG): readonly TrainingSceneReference[] {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing }]
}
function checkpoints(phase: number): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(SPLIT_S_PHASE_IDS.slice(0, phase).map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
}
function context(phase = 0, overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: SPLIT_S_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: checkpoints(phase), sceneReferences: references(), ...overrides }
}
/** Analytic observer fixture: coherent telemetry, not a physics/control demo. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public readonly trace: TrainingSample[] = []
  public readonly evaluations: TrainingEvaluation[] = []
  public checkpointStates = checkpoints(0)
  public position: Vector3
  private velocity: Vector3 = ZERO
  private rate: Vector3 = ZERO
  private orientation: Quaternion
  public constructor(public readonly config = DEFAULT_DRONE_CONFIG, private readonly heading = 0) {
    this.position = createTrainingFieldAnchors(config).launch
    this.orientation = quaternionFromRotationVector({ x: 0, y: heading, z: 0 })
  }
  public velocityInPlane(forward: number, up = 0): Vector3 {
    return { x: -Math.sin(this.heading) * forward, y: up, z: -Math.cos(this.heading) * forward }
  }
  public tick(velocity: Vector3 = ZERO, rate: Vector3 = ZERO, orientation?: Quaternion): TrainingEvaluation {
    this.position = { x: this.position.x + (this.velocity.x + velocity.x) * STEP / 2,
      y: this.position.y + (this.velocity.y + velocity.y) * STEP / 2, z: this.position.z + (this.velocity.z + velocity.z) * STEP / 2 }
    this.orientation = orientation ?? integrateBodyAngularVelocity(this.orientation, { x: (this.rate.x + rate.x) / 2,
      y: (this.rate.y + rate.y) / 2, z: (this.rate.z + rate.z) / 2 }, STEP)
    this.velocity = velocity
    this.rate = rate
    const timestampSeconds = (this.trace.length + 1) * STEP
    const state = { ...createInitialDroneState(this.config, this.position, this.orientation), velocityMps: velocity,
      angularVelocityBodyRadPerSec: rate, timeSeconds: timestampSeconds, stepIndex: this.trace.length + 1 }
    const supportOffsetM = droneGroundSupport(this.config, this.orientation).supportOffsetM
    const current: TrainingSample = { timestampSeconds, state, armed: true, normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
      groundContact: { heightM: this.config.ground.heightM, supportOffsetM,
        touching: this.position.y - supportOffsetM <= this.config.ground.heightM + DRONE_GROUND_CLEARANCE_M + 1e-8 } }
    const previous = this.trace.at(-1)
    this.evaluation = splitSLearningEvaluator.evaluate(current, context(0, { elapsedSeconds: timestampSeconds,
      sceneReferences: references(this.config), checkpoints: this.checkpointStates, previousSample: previous,
      previousFlightSample: previous, previousEvaluation: this.evaluation }))
    this.trace.push(current)
    this.evaluations.push(this.evaluation)
    for (const id of this.evaluation.checkpointIds ?? []) this.checkpointStates = { ...this.checkpointStates,
      [id]: { id, completed: true, completedAtSeconds: timestampSeconds, metrics: this.evaluation.metrics ?? {} } }
    return this.evaluation
  }
  public safe(velocity: Vector3 = ZERO, rate: Vector3 = ZERO, orientation?: Quaternion): TrainingEvaluation {
    const result = this.tick(velocity, rate, orientation)
    expect(result.status, result.message).not.toBe('failure')
    expect(result.checkpointIds?.length ?? 0).toBeLessThanOrEqual(1)
    return result
  }
  public repeat(count: number, forward = 0, up = 0, rate: Vector3 = ZERO): void {
    for (let i = 0; i < count; i += 1) this.safe(this.velocityInPlane(forward, up), rate)
  }
  public halfRoll(direction = 1, forward = 8): void {
    const omega = Math.PI / (40 * STEP)
    this.repeat(40, forward, 0, { x: 0, y: 0, z: -direction * omega })
    this.repeat(1, forward)
  }
  public dive(direction = 1): void {
    const omega = Math.PI / (80 * STEP)
    for (let i = 1; i <= 80; i += 1) {
      const angle = (i - 0.5) * omega * STEP
      this.safe(this.velocityInPlane(direction * 6 * omega * Math.cos(angle), -6 * omega * Math.sin(angle)), { x: omega, y: 0, z: 0 })
    }
    this.safe(this.velocityInPlane(-direction * 6 * omega))
  }
}
function prepared(config = DEFAULT_DRONE_CONFIG, heading = 0): Observer {
  const observer = new Observer(config, heading)
  observer.safe()
  observer.repeat(80, 0, 5)
  observer.repeat(3)
  observer.repeat(10, 8)
  expect(observer.evaluation?.metrics).toMatchObject({ splitPhase: 3, splitEpisodeValid: 1 })
  return observer
}

describe('ground-start ordered descending half-loop', () => {
  it('keeps the stable split-s ID while exposing eight Chinese ground-start stages', () => {
    expect(SPLIT_S_LESSON).toMatchObject({ id: 'split-s', priority: 3, title: '破S' })
    expect(SPLIT_S_LEARNING_CONTENT).toMatchObject({ code: 'L14', title: '破S' })
    expect(SPLIT_S_LESSON.checkpoints.map(({ id }) => id)).toEqual(SPLIT_S_PHASE_IDS)
    expect(SPLIT_S_LESSON.setup.spawnPositionM).toBeUndefined()
  })
  it.each([[0, 1], [1.2, -1], [-2, 1]])('accepts actual half-roll then descending pitch at heading %s and roll sign %s', (heading, sign) => {
    const observer = prepared(DEFAULT_DRONE_CONFIG, heading)
    observer.halfRoll(sign)
    expect(observer.evaluation?.metrics).toMatchObject({ splitInverted: 1, splitPhase: 4 })
    observer.dive()
    observer.repeat(8, -4)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ splitPhase: 8, splitInverted: 1, splitDescended: 1, splitReversed: 1, splitCompleted: 1 })
    expect(observer.evaluation?.metrics?.splitRollProgressDegrees).toBeCloseTo(180, 6)
    expect(observer.evaluation?.metrics?.splitPitchProgressDegrees).toBeGreaterThanOrEqual(145)
    expect(observer.evaluation?.metrics?.splitHeightLossM).toBeGreaterThan(9)
    expect(observer.evaluation?.metrics?.splitPathTurnDegrees).toBeGreaterThan(100)
    expect(observer.evaluation?.metrics?.splitReverseTravelM).toBeGreaterThan(1.5)
    expect(Object.keys(observer.checkpointStates)).toEqual(SPLIT_S_PHASE_IDS)
    expect(observer.trace.every(({ normalizedInput }) => normalizedInput?.roll === 0 && normalizedInput?.pitch === 0)).toBe(true)
  })
  it('is relative to configured ground and ignores an elevated free-flight spawn', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 9 }, spawnPositionM: { x: 6, y: 45, z: -3 } }
    const observer = prepared(config)
    observer.halfRoll()
    observer.dive()
    observer.repeat(8, -4)
    expect(observer.trace[0].groundContact?.touching).toBe(true)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeGreaterThan(7)
    expect(observer.evaluation?.metrics?.altitudeM).toBeLessThan(10)
  })
  it('produces a new eight-step actual session result', () => {
    const observer = prepared()
    observer.halfRoll()
    observer.dive()
    observer.repeat(8, -4)
    const session = new TrainingSession({ lessons: [SPLIT_S_LESSON], initialLessonId: 'split-s', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const current of observer.trace) {
      session.consumeSample(current)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ lessonId: 'split-s', outcome: 'SUCCESS', completedCheckpoints: 8, totalCheckpoints: 8 })
  })
  it('cannot replace the half-roll with a pitch-only flip', () => {
    const observer = prepared()
    observer.repeat(80, 8, 0, { x: Math.PI / 4, y: 0, z: 0 })
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.splitInverted).toBe(0)
    expect(observer.checkpointStates['split-inverted']).toBeUndefined()
  })
  it('rejects a level yaw U-turn without inversion or descending half-loop', () => {
    const observer = prepared()
    observer.repeat(60, 8, 0, { x: 0, y: Math.PI / 3, z: 0 })
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.splitInverted).toBe(0)
    expect(observer.checkpointStates['split-descent']).toBeUndefined()
  })
  it('does not borrow the inversion from a complete roll followed by pitch', () => {
    const observer = prepared()
    observer.halfRoll()
    observer.repeat(40, 8, 0, { x: 0, y: 0, z: -Math.PI / 2 })
    expect(observer.evaluations.some(({ metrics }) => metrics?.splitInterruptionReason === 5 && metrics?.splitInverted === 0)).toBe(true)
    expect(observer.evaluation?.metrics?.splitInverted).toBe(0)
    expect(observer.evaluation?.metrics?.splitCompleted).toBe(0)
    expect(observer.checkpointStates['split-upright']).toBeUndefined()
  })
  it('does not count a body half-loop in place as a descending spatial path', () => {
    const observer = prepared()
    observer.halfRoll()
    observer.repeat(80, 0, 0, { x: Math.PI / 4, y: 0, z: 0 })
    observer.repeat(8)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.splitDescended).toBe(0)
    expect(observer.checkpointStates['split-reversed']).toBeUndefined()
  })
  it('clears the current inversion when pitch direction is reversed substantially', () => {
    const observer = prepared()
    observer.halfRoll()
    observer.repeat(30, 6, -2, { x: Math.PI / 4, y: 0, z: 0 })
    observer.repeat(30, 6, 0, { x: -Math.PI / 4, y: 0, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ splitEpisodeValid: 0, splitInverted: 0, splitCompleted: 0, splitInterruptionReason: 6 })
  })
  it('invalidates a grounded, low or out-of-area episode without reusing old inversion', () => {
    const observer = prepared()
    observer.halfRoll()
    const current = observer.trace.at(-1)!
    for (const [reason, positionM] of [[2, { ...current.state.positionM, y: 1 }], [3, { ...current.state.positionM, x: 200 }]] as const) {
      const result = splitSLearningEvaluator.evaluate({ ...current, state: { ...current.state, positionM } }, context(4, { previousEvaluation: observer.evaluation }))
      expect(result.metrics).toMatchObject({ splitInterruptionReason: reason, splitEpisodeValid: 0, splitInverted: 0, splitCompleted: 0 })
    }
  })
  it('does not borrow descent from before inversion to complete a shallow half-loop', () => {
    const observer = prepared()
    observer.repeat(40, 8, -3)
    observer.repeat(2, 8)
    observer.halfRoll()
    const omega = Math.PI / (40 * STEP)
    for (let i = 1; i <= 40; i += 1) {
      const angle = (i - 0.5) * omega * STEP
      observer.safe(observer.velocityInPlane(omega * Math.cos(angle), -omega * Math.sin(angle)), { x: omega, y: 0, z: 0 })
    }
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluations.some(({ metrics }) => metrics?.splitInterruptionReason === 8 && metrics.interruptionHeightLossM < 3)).toBe(true)
    expect(observer.checkpointStates['split-descent']).toBeUndefined()
  })
  it('does not paste separate translations onto an in-place body half-loop', () => {
    const observer = prepared()
    observer.halfRoll()
    observer.repeat(80, 0, 0, { x: Math.PI / 4, y: 0, z: 0 })
    observer.repeat(20, -4, -3)
    observer.repeat(20, -4)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.checkpointStates['split-upright']).toBeUndefined()
  })
  it('requires a fresh whole sequence when late checkpoints survive cleared episode evidence', () => {
    const observer = prepared()
    observer.halfRoll()
    observer.dive()
    observer.repeat(8, -4)
    observer.checkpointStates = checkpoints(7)
    observer.evaluation = { status: 'continue', metrics: { splitEpisodeValid: 0, splitInterrupted: 1, splitInterruptionReason: 3 } }
    observer.repeat(2, -4)
    expect(observer.evaluation.status).toBe('continue')
    expect(observer.evaluation.metrics?.splitCompleted).toBe(0)
    // The actual body points toward the old entry. Climb, prepare and fly a
    // complete new half-loop in that opposite entry plane; old steps alone fail.
    observer.repeat(80, -4, 3)
    observer.repeat(12, -4)
    expect(observer.evaluation.metrics?.splitEpisodeValid).toBe(1)
    observer.halfRoll(1, -8)
    observer.dive(-1)
    observer.repeat(8, 4)
    expect(observer.evaluation.status).toBe('success')
    expect(observer.evaluation.metrics).toMatchObject({ splitPhase: 8, splitInverted: 1, splitDescended: 1, splitReversed: 1, splitCompleted: 1 })
  })
  it('does not accept stale final checkpoints with cleared episode evidence', () => {
    const observer = prepared()
    const result = splitSLearningEvaluator.evaluate(observer.trace.at(-1)!, context(8, { previousEvaluation: { status: 'continue', metrics: {
      splitEpisodeValid: 0, splitInverted: 1, splitDescended: 1, splitReversed: 1, splitCompleted: 0,
    } } }))
    expect(result.status).toBe('failure')
    expect(result.message).toContain('實際飛行證據')
  })
  it('rejects a pose-only rotation and impossible position jump', () => {
    const observer = prepared()
    const previous = observer.trace.at(-1)!
    const current = { ...previous, timestampSeconds: previous.timestampSeconds + STEP, state: { ...previous.state,
      timeSeconds: previous.state.timeSeconds + STEP, stepIndex: previous.state.stepIndex + 1,
      positionM: { ...previous.state.positionM, z: previous.state.positionM.z - 0.4 }, orientation: quaternionFromRotationVector({ x: 0, y: 0, z: Math.PI / 2 }) } }
    expect(splitSLearningEvaluator.evaluate(current, context(3, { previousFlightSample: previous, previousEvaluation: observer.evaluation })).message).toContain('姿態變化')
    const jumped = { ...current, state: { ...current.state, orientation: previous.state.orientation, positionM: { ...current.state.positionM, x: 20 } } }
    expect(splitSLearningEvaluator.evaluate(jumped, context(3, { previousFlightSample: previous })).message).toContain('位置跳躍')
  })
  it('accepts equivalent quaternion signs and reports actual rates', () => {
    const observer = prepared()
    const q = observer.trace.at(-1)!.state.orientation
    expect(observer.safe(observer.velocityInPlane(8), ZERO, { x: -q.x, y: -q.y, z: -q.z, w: -q.w }).status).toBe('continue')
    expect(measureSplitSMotion({ orientation: IDENTITY_QUATERNION, velocityMps: { x: 3, y: -2, z: 4 }, angularVelocityBodyRadPerSec: { x: Math.PI, y: 0, z: -Math.PI / 2 } }))
      .toMatchObject({ tiltDegrees: 0, horizontalSpeedMps: 5, verticalSpeedMps: -2, pitchRateDegreesPerSecond: 180, rollRateDegreesPerSecond: 90 })
  })
  it('requires real grounded start, ground telemetry and explicit arm', () => {
    const observer = prepared()
    const current = observer.trace.at(-1)!
    expect(splitSLearningEvaluator.evaluate(current, context()).checkpointIds).toBeUndefined()
    expect(splitSLearningEvaluator.evaluate({ ...current, groundContact: undefined }, context()).status).toBe('failure')
    expect(splitSLearningEvaluator.evaluate({ ...current, armed: false }, context()).status).toBe('failure')
    expect(splitSLearningEvaluator.evaluate({ ...current, armed: undefined }, context()).status).toBe('continue')
  })
  it('keeps practice untimed and challenge bounded at 300 seconds', () => {
    const current = prepared().trace.at(-1)!
    expect(splitSLearningEvaluator.evaluate(current, context(3, { mode: 'practice', elapsedSeconds: 301 })).status).toBe('continue')
    expect(splitSLearningEvaluator.evaluate(current, context(3, { mode: 'challenge', elapsedSeconds: 301 })).message).toContain('逾時')
  })
})
