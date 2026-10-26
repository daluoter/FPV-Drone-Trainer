import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { IDENTITY_QUATERNION, integrateBodyAngularVelocity, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'
import { POWER_LOOP_LEARNING_CONTENT, POWER_LOOP_LESSON, POWER_LOOP_PHASE_IDS, powerLoopEvaluator, measurePowerLoopMotion } from './powerLoop'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG): readonly TrainingSceneReference[] {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing }]
}
function checkpoints(phase: number): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(POWER_LOOP_PHASE_IDS.slice(0, phase).map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
}
function context(phase = 0, overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: POWER_LOOP_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: checkpoints(phase), sceneReferences: references(), ...overrides }
}
/** Analytic observer fixture: coherent telemetry, not a physics/control demo. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public readonly trace: TrainingSample[] = []
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
    this.evaluation = powerLoopEvaluator.evaluate(current, context(0, { elapsedSeconds: timestampSeconds,
      sceneReferences: references(this.config), checkpoints: this.checkpointStates, previousSample: previous,
      previousFlightSample: previous, previousEvaluation: this.evaluation }))
    this.trace.push(current)
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
  public loop(direction = 1): void {
    const omega = 2 * Math.PI / (100 * STEP)
    for (let i = 1; i <= 100; i += 1) {
      const angle = direction * (i - 0.5) * omega * STEP
      this.safe(this.velocityInPlane(8 * Math.cos(angle), 8 * Math.sin(angle)), { x: direction * omega, y: 0, z: 0 })
    }
    this.safe(this.velocityInPlane(8))
  }
}
function prepared(config = DEFAULT_DRONE_CONFIG, heading = 0): Observer {
  const observer = new Observer(config, heading)
  observer.safe()
  observer.repeat(40, 0, 5)
  observer.repeat(3)
  observer.repeat(10, 8)
  expect(observer.evaluation?.metrics).toMatchObject({ loopPhase: 3, loopEpisodeValid: 1 })
  return observer
}

describe('ground-start spatial power loop', () => {
  it('defines a separate Chinese L13 identity and eight actual-flight stages', () => {
    expect(POWER_LOOP_LESSON).toMatchObject({ id: 'power-loop', priority: 2.98, title: '大迴旋' })
    expect(POWER_LOOP_LEARNING_CONTENT).toMatchObject({ code: 'L13', title: '大迴旋', prerequisiteIds: ['back-flip'] })
    expect(POWER_LOOP_LESSON.checkpoints.map(({ id }) => id)).toEqual(POWER_LOOP_PHASE_IDS)
  })
  it.each([0, 1.2, -2])('accepts a real continuous vertical loop at heading %s with independent spatial evidence', (heading) => {
    const observer = prepared(DEFAULT_DRONE_CONFIG, heading)
    observer.loop()
    observer.repeat(8, 8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ loopPhase: 8, loopClimbed: 1, loopInverted: 1, loopDescended: 1, loopCompleted: 1 })
    expect(observer.evaluation?.metrics?.loopHeightGainM).toBeGreaterThan(9)
    expect(observer.evaluation?.metrics?.loopForwardSpanM).toBeGreaterThan(9)
    expect(observer.evaluation?.metrics?.loopPathTurnDegrees).toBeGreaterThan(325)
    expect(observer.evaluation?.metrics?.loopReverseTravelM).toBeGreaterThan(10)
    expect(observer.evaluation?.metrics?.loopSignedDegrees).toBeGreaterThanOrEqual(325)
    expect(observer.evaluation?.metrics?.loopSignedDegrees).toBeLessThanOrEqual(360.001)
    expect(Object.keys(observer.checkpointStates)).toEqual(POWER_LOOP_PHASE_IDS)
    expect(observer.trace.every(({ normalizedInput }) => normalizedInput?.pitch === 0)).toBe(true)
  })
  it('uses configured ground height and remains independent of configured high free-flight spawn', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 7 }, spawnPositionM: { x: 2, y: 40, z: -3 } }
    const observer = prepared(config)
    observer.loop()
    observer.repeat(8, 8)
    expect(observer.trace[0].groundContact?.touching).toBe(true)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeGreaterThan(9)
    expect(observer.evaluation?.metrics?.altitudeM).toBeLessThan(11)
  })
  it('produces an independently scored eight-checkpoint session result', () => {
    const observer = prepared()
    observer.loop()
    observer.repeat(8, 8)
    const session = new TrainingSession({ lessons: [POWER_LOOP_LESSON], initialLessonId: 'power-loop', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const current of observer.trace) {
      session.consumeSample(current)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ lessonId: 'power-loop', outcome: 'SUCCESS', completedCheckpoints: 8, totalCheckpoints: 8 })
  })
  it('does not accept an in-place full body flip after forward entry', () => {
    const observer = prepared()
    const omega = 2 * Math.PI / (100 * STEP)
    observer.repeat(100, 0, 0, { x: omega, y: 0, z: 0 })
    observer.repeat(8)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.checkpointStates['loop-exit']).toBeUndefined()
    expect(observer.evaluation?.metrics?.loopCompleted).toBe(0)
  })
  it('rejects a geometric vertical circle with no actual pitch turn', () => {
    const observer = prepared()
    for (let i = 0; i < 100; i += 1) {
      const angle = 2 * Math.PI * i / 100
      observer.safe(observer.velocityInPlane(8 * Math.cos(angle), 8 * Math.sin(angle)))
    }
    observer.repeat(8, 8)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.loopInverted).toBe(0)
  })
  it('rejects a reversed full turn without borrowing its upward entry', () => {
    const observer = prepared()
    // Keep physical observer above ground while turning the wrong direction.
    observer.repeat(40, 8, 4)
    observer.repeat(20, 8, 0, { x: -1, y: 0, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ loopEpisodeValid: 0, loopInterrupted: 1, loopInterruptionReason: 6, loopCompleted: 0 })
  })
  it('invalidates inversion proof when the pilot reverses substantially after the crest', () => {
    const observer = prepared()
    const omega = Math.PI / (50 * STEP)
    for (let i = 1; i <= 50; i += 1) {
      const angle = (i - 0.5) * omega * STEP
      observer.safe(observer.velocityInPlane(8 * Math.cos(angle), 8 * Math.sin(angle)), { x: omega, y: 0, z: 0 })
    }
    expect(observer.evaluation?.metrics?.loopInverted).toBe(1)
    observer.repeat(30, -8, 0, { x: -omega, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.loopInterruptionReason).toBe(6)
    expect(observer.evaluation?.metrics?.loopInverted).toBe(0)
    expect(observer.evaluation?.metrics?.loopEpisodeValid).toBe(0)
    expect(observer.evaluation?.metrics?.loopCompleted).toBe(0)
  })
  it('does not join a stopped climb, in-place body flip and separate translations into a loop', () => {
    const observer = prepared()
    observer.repeat(20, 8, 4, { x: 0.4, y: 0, z: 0 })
    observer.repeat(18, 0, 0)
    observer.repeat(100, 0, 0, { x: 2 * Math.PI / (100 * STEP), y: 0, z: 0 })
    observer.repeat(20, -8, -3)
    observer.repeat(20, 8, 0)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.loopCompleted).toBe(0)
    expect(observer.checkpointStates['loop-exit']).toBeUndefined()
  })
  it('allows a brief slow crest while omitting unobserved tangent turn across the gap', () => {
    const observer = prepared()
    const omega = 2 * Math.PI / (100 * STEP)
    for (let i = 1; i <= 100; i += 1) {
      const angle = (i - 0.5) * omega * STEP
      const speed = i >= 49 && i <= 52 ? 0.5 : 8
      observer.safe(observer.velocityInPlane(speed * Math.cos(angle), speed * Math.sin(angle)), { x: omega, y: 0, z: 0 })
    }
    observer.safe(observer.velocityInPlane(8))
    observer.repeat(8, 8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.loopPathTurnDegrees).toBeGreaterThan(300)
    expect(observer.evaluation?.metrics?.loopPathTurnDegrees).toBeLessThan(325)
  })
  it('does not borrow a long straight run-up or exit to widen a narrow loop', () => {
    const observer = prepared()
    observer.repeat(100, 8)
    expect(observer.evaluation?.metrics).toMatchObject({ loopHeightGainM: 0, loopForwardSpanM: 0 })
    const omega = 2 * Math.PI / (100 * STEP)
    const speed = 2 * omega // a two-metre-radius loop has only four metres of span
    for (let i = 1; i <= 100; i += 1) {
      const angle = (i - 0.5) * omega * STEP
      observer.safe(observer.velocityInPlane(speed * Math.cos(angle), speed * Math.sin(angle)), { x: omega, y: 0, z: 0 })
    }
    observer.safe(observer.velocityInPlane(speed))
    observer.repeat(60, speed)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.interruptionHeightGainM).toBeGreaterThan(3)
    expect(observer.evaluation?.metrics?.interruptionForwardSpanM).toBeLessThan(4.1)
    expect(observer.evaluation?.metrics).toMatchObject({ loopInterruptionReason: 9, loopEpisodeValid: 0, loopCompleted: 0 })
    expect(observer.checkpointStates['loop-exit']).toBeUndefined()
    expect(observer.evaluation?.hint).toContain('跨度不足')
    // Reprepare in the air and complete a fresh wide loop, without requiring
    // a crash, overspin, or clearing the retained teaching checkpoints.
    observer.repeat(10, 8)
    expect(observer.evaluation?.metrics?.loopEpisodeValid).toBe(1)
    observer.loop()
    observer.repeat(8, 8)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('does not trust stale completed checkpoints after an interrupted episode', () => {
    const observer = prepared()
    observer.loop()
    observer.repeat(8, 8)
    const current = observer.trace.at(-1)!
    const result = powerLoopEvaluator.evaluate(current, context(8, { previousEvaluation: { status: 'continue', metrics: { loopEpisodeValid: 0,
      loopClimbed: 1, loopInverted: 1, loopDescended: 1, loopCompleted: 0 } } }))
    expect(result.status).toBe('failure')
    expect(result.message).toContain('實際飛行證據')
  })
  it('rejects pose-only turns and impossible position jumps', () => {
    const observer = prepared()
    const previous = observer.trace.at(-1)!
    const current = { ...previous, timestampSeconds: previous.timestampSeconds + STEP, state: { ...previous.state,
      timeSeconds: previous.state.timeSeconds + STEP, stepIndex: previous.state.stepIndex + 1,
      positionM: { ...previous.state.positionM, z: previous.state.positionM.z - 0.4 },
      orientation: quaternionFromRotationVector({ x: Math.PI / 2, y: 0, z: 0 }) } }
    const result = powerLoopEvaluator.evaluate(current, context(3, { previousFlightSample: previous, previousEvaluation: observer.evaluation }))
    expect(result.status).toBe('failure')
    expect(result.message).toContain('姿態變化')
    const jump = { ...current, state: { ...current.state, orientation: previous.state.orientation,
      positionM: { ...current.state.positionM, x: 20 } } }
    expect(powerLoopEvaluator.evaluate(jump, context(3, { previousFlightSample: previous })).message).toContain('位置跳躍')
  })
  it('accepts equivalent quaternion signs and reports measured nose-up rate', () => {
    const observer = prepared()
    const last = observer.trace.at(-1)!.state.orientation
    const result = observer.safe(observer.velocityInPlane(8), ZERO, { x: -last.x, y: -last.y, z: -last.z, w: -last.w })
    expect(result.status).toBe('continue')
    expect(measurePowerLoopMotion({ orientation: IDENTITY_QUATERNION, velocityMps: { x: 3, y: -2, z: 4 }, angularVelocityBodyRadPerSec: { x: Math.PI, y: 0, z: 0 } }))
      .toMatchObject({ tiltDegrees: 0, horizontalSpeedMps: 5, verticalSpeedMps: -2, loopRateDegreesPerSecond: 180 })
  })
  it('requires actual ground start, telemetry and explicit arm', () => {
    const observer = prepared()
    const current = observer.trace.at(-1)!
    expect(powerLoopEvaluator.evaluate(current, context()).checkpointIds).toBeUndefined()
    expect(powerLoopEvaluator.evaluate({ ...current, groundContact: undefined }, context()).status).toBe('failure')
    expect(powerLoopEvaluator.evaluate({ ...current, armed: false }, context()).status).toBe('failure')
    expect(powerLoopEvaluator.evaluate({ ...current, armed: undefined }, context()).status).toBe('continue')
  })
  it('keeps practice untimed while enforcing the challenge time budget', () => {
    const observer = prepared()
    const current = observer.trace.at(-1)!
    expect(powerLoopEvaluator.evaluate(current, context(3, { mode: 'practice', elapsedSeconds: 301 })).status).toBe('continue')
    expect(powerLoopEvaluator.evaluate(current, context(3, { mode: 'challenge', elapsedSeconds: 301 })).message).toContain('逾時')
  })
})
