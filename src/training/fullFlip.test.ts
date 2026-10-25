import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig } from '../drone'
import { IDENTITY_QUATERNION, integrateBodyAngularVelocity, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import type { LessonDefinition, TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'
import {
  BACK_FLIP_LEARNING_CONTENT, BACK_FLIP_LESSON, FRONT_FLIP_LEARNING_CONTENT, FRONT_FLIP_LESSON,
  FULL_FLIP_COMPLETION_DEGREES, FULL_FLIP_HOLD_SECONDS, FULL_FLIP_LEARNING_CONTENT, FULL_FLIP_LESSON,
  FULL_FLIP_MIN_HEIGHT_M, FULL_FLIP_PHASE_IDS, FULL_FLIP_PREPARATION_SECONDS, FULL_FLIP_TARGET_HEIGHT_M,
  FULL_FLIP_TIME_LIMIT_SECONDS, fullFlipEvaluator, fullFlipRequiredDirection, measureFullFlipMotion,
} from './fullFlip'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 } as const
const radians = Math.PI / 180

function references(config = DEFAULT_DRONE_CONFIG): readonly TrainingSceneReference[] {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing }]
}

function checkpoints(phase: number): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(FULL_FLIP_PHASE_IDS.slice(0, phase).map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
}

function sample(index: number, options: { position?: Vector3; velocity?: Vector3; orientation?: Quaternion; rate?: Vector3; config?: DroneConfig } = {}): TrainingSample {
  const config = options.config ?? DEFAULT_DRONE_CONFIG
  const state = createInitialDroneState(config, options.position ?? { x: 0, y: FULL_FLIP_TARGET_HEIGHT_M + config.ground.heightM, z: 0 }, options.orientation ?? IDENTITY_QUATERNION)
  const supportOffsetM = droneGroundSupport(config, state.orientation).supportOffsetM
  const timestampSeconds = (index + 1) * STEP
  return {
    timestampSeconds, armed: true, normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
    groundContact: { heightM: config.ground.heightM, supportOffsetM,
      touching: state.positionM.y - supportOffsetM <= config.ground.heightM + DRONE_GROUND_CLEARANCE_M + 1e-8 },
    state: { ...state, velocityMps: options.velocity ?? ZERO, angularVelocityBodyRadPerSec: options.rate ?? ZERO,
      timeSeconds: timestampSeconds, stepIndex: index + 1 },
  }
}

function context(phase = 0, overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: FULL_FLIP_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: checkpoints(phase), sceneReferences: references(), ...overrides }
}

/** Measured-state observer fixture, not a simulated RC flight or human-pilot claim. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public readonly trace: TrainingSample[] = []
  public checkpointStates: Readonly<Record<string, TrainingCheckpointState>>
  private position: Vector3
  private velocity: Vector3 = ZERO
  private orientation: Quaternion = IDENTITY_QUATERNION
  private rate: Vector3 = ZERO

  public constructor(public readonly config = DEFAULT_DRONE_CONFIG, phase = 0, position?: Vector3, orientation = IDENTITY_QUATERNION,
    private readonly lesson: LessonDefinition = FULL_FLIP_LESSON) {
    this.position = position ?? createTrainingFieldAnchors(config).launch
    this.orientation = orientation
    this.checkpointStates = checkpoints(phase)
  }

  public tick(options: { velocity?: Vector3; rate?: Vector3; orientation?: Quaternion } = {}, override: Partial<TrainingEvaluationContext> = {}): TrainingEvaluation {
    const velocity = options.velocity ?? ZERO
    const rate = options.rate ?? ZERO
    this.position = {
      x: this.position.x + (this.velocity.x + velocity.x) * STEP / 2,
      y: this.position.y + (this.velocity.y + velocity.y) * STEP / 2,
      z: this.position.z + (this.velocity.z + velocity.z) * STEP / 2,
    }
    this.orientation = options.orientation ?? integrateBodyAngularVelocity(this.orientation, {
      x: (this.rate.x + rate.x) / 2, y: (this.rate.y + rate.y) / 2, z: (this.rate.z + rate.z) / 2,
    }, STEP)
    this.velocity = velocity
    this.rate = rate
    const current = sample(this.trace.length, { position: this.position, velocity, rate, orientation: this.orientation, config: this.config })
    this.position = current.state.positionM
    const previous = this.trace.at(-1)
    this.evaluation = fullFlipEvaluator.evaluate(current, context(0, {
      lesson: this.lesson,
      elapsedSeconds: current.timestampSeconds, checkpoints: this.checkpointStates, sceneReferences: references(this.config),
      previousSample: previous, previousFlightSample: previous, previousEvaluation: this.evaluation, ...override,
    }))
    this.trace.push(current)
    for (const id of this.evaluation.checkpointIds ?? []) this.checkpointStates = {
      ...this.checkpointStates, [id]: { id, completed: true, completedAtSeconds: current.timestampSeconds, metrics: this.evaluation.metrics ?? {} },
    }
    return this.evaluation
  }

  public safe(options: Parameters<Observer['tick']>[0] = {}): TrainingEvaluation {
    const result = this.tick(options)
    expect(result.status, result.message).not.toBe('failure')
    expect(result.checkpointIds?.length ?? 0).toBeLessThanOrEqual(1)
    return result
  }

  public repeat(count: number, options: Parameters<Observer['tick']>[0] = {}): void {
    for (let index = 0; index < count; index += 1) this.safe(options)
  }

  public turn(degrees: number, axis: 'x' | 'y' | 'z' = 'x'): void {
    const rate = { ...ZERO, [axis]: -degrees * radians / (30 * STEP) }
    this.repeat(30, { rate })
    this.safe()
  }
}

function prepared(config = DEFAULT_DRONE_CONFIG, headingRadians = 0, lesson = FULL_FLIP_LESSON): Observer {
  const observer = new Observer(config, 0, undefined, quaternionFromRotationVector({ x: 0, y: headingRadians, z: 0 }), lesson)
  observer.safe()
  observer.repeat(40, { velocity: { x: 0, y: 5, z: 0 } })
  observer.repeat(5)
  expect(observer.evaluation?.metrics?.flipPhase).toBe(3)
  expect(observer.evaluation?.metrics?.flipEpisodeValid).toBe(1)
  return observer
}

function directOptions(phase: number, current: TrainingSample, previous: TrainingSample | null = null, previousEvaluation: TrainingEvaluation | null = null): TrainingEvaluationContext {
  return context(phase, { elapsedSeconds: current.timestampSeconds, previousSample: previous, previousFlightSample: previous, previousEvaluation })
}

describe('ground-start complete front/back flip lesson', () => {
  const directionalLessons = [
    { lesson: FRONT_FLIP_LESSON, direction: 1, title: '前翻' },
    { lesson: BACK_FLIP_LESSON, direction: -1, title: '後翻' },
  ] as const

  it.each(directionalLessons)('completes only the measured $title direction in its separate lesson', ({ lesson, direction }) => {
    const observer = prepared(DEFAULT_DRONE_CONFIG, 1.2, lesson)
    observer.turn(direction * 360)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ flipPhase: 6, flipRequiredDirection: direction, flipDirection: direction })
    expect(observer.evaluation?.metrics?.flipSignedDegrees).toBeCloseTo(direction * 360, 8)
    expect(observer.trace.every(({ normalizedInput }) => normalizedInput?.pitch === 0)).toBe(true)
  })

  it.each(directionalLessons)('rejects a complete opposite turn for $title and retains the observed wrong direction', ({ lesson, direction, title }) => {
    const observer = prepared(DEFAULT_DRONE_CONFIG, 0, lesson)
    observer.turn(-direction * 360)
    expect(observer.evaluation?.metrics).toMatchObject({ flipRequiredDirection: direction, flipInterruptionReason: 8,
      interruptionFlipDirection: -direction, flipEpisodeValid: 0, flipCompleted: 0, flipInverted: 0 })
    expect(observer.evaluation?.hint).toContain(`本課指定${title}`)
    expect(observer.checkpointStates['flip-inverted']).toBeUndefined()
    expect(observer.checkpointStates['flip-upright']).toBeUndefined()
    observer.repeat(8)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.flipCompleted).toBe(0)
  })

  it.each(directionalLessons)('allows a fresh $title after wrong-direction interruption and preparation', ({ lesson, direction }) => {
    const observer = prepared(DEFAULT_DRONE_CONFIG, 0, lesson)
    observer.turn(-direction * 360)
    expect(observer.evaluation?.metrics?.flipInterruptionReason).toBe(8)
    observer.repeat(8)
    expect(observer.evaluation?.metrics).toMatchObject({ flipEpisodeValid: 1, flipInterruptionReason: 0 })
    observer.turn(direction * 360)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.flipSignedDegrees).toBeCloseTo(direction * 360, 8)
  })

  it.each(directionalLessons)('records $title through the real session under its own lesson ID', ({ lesson, direction }) => {
    const observer = prepared(DEFAULT_DRONE_CONFIG, 0, lesson)
    observer.turn(direction * 360)
    observer.repeat(8)
    const session = new TrainingSession({ lessons: [lesson], initialLessonId: lesson.id, countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const current of observer.trace) {
      session.consumeSample(current)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ lessonId: lesson.id, outcome: 'SUCCESS', completedCheckpoints: 6, totalCheckpoints: 6 })
    expect(session.getState().result?.metrics.flipDirection).toBe(direction)
  })

  it.each(directionalLessons)('does not trust old combined checkpoints or a saved required-direction value for $title', ({ lesson, direction }) => {
    const current = sample(0)
    const old: TrainingEvaluation = { status: 'success', metrics: {
      flipRequiredDirection: -direction, flipDirection: -direction, flipEpisodeValid: 1, flipCompleted: 1, flipInverted: 1,
      flipSignedDegrees: -direction * 360, flipProgressDegrees: 360,
    } }
    const result = fullFlipEvaluator.evaluate(current, context(6, { lesson, previousEvaluation: old }))
    expect(result.status).toBe('failure')
    expect(result.metrics?.flipRequiredDirection).toBe(direction)
    expect(result.message).toContain('指定方向')
  })

  it('keeps the old combined definition and the two new directional identities distinct', () => {
    expect(FULL_FLIP_LESSON.id).toBe('full-flip')
    expect(FRONT_FLIP_LESSON).toMatchObject({ id: 'front-flip', title: '前翻', priority: 2.9 })
    expect(BACK_FLIP_LESSON).toMatchObject({ id: 'back-flip', title: '後翻', priority: 2.95 })
    expect(FRONT_FLIP_LEARNING_CONTENT).toMatchObject({ code: 'L11', title: '前翻', prerequisiteIds: ['full-roll'] })
    expect(BACK_FLIP_LEARNING_CONTENT).toMatchObject({ code: 'L12', title: '後翻', prerequisiteIds: ['front-flip'] })
    expect(FRONT_FLIP_LESSON.checkpoints.map(({ id }) => id)).toEqual(FULL_FLIP_PHASE_IDS)
    expect(BACK_FLIP_LESSON.checkpoints.map(({ id }) => id)).toEqual(FULL_FLIP_PHASE_IDS)
    expect(fullFlipRequiredDirection('front-flip')).toBe(1)
    expect(fullFlipRequiredDirection('back-flip')).toBe(-1)
    expect(fullFlipRequiredDirection('full-flip')).toBe(0)
  })

  it.each([-1, 1])('observes a real complete signed turn and airborne recovery in direction %s', (direction) => {
    const observer = prepared()
    observer.turn(direction * 360)
    expect(observer.evaluation?.metrics?.flipInverted).toBe(1)
    expect(observer.evaluation?.metrics?.flipCompleted).toBe(1)
    expect(observer.evaluation?.metrics?.flipSignedDegrees).toBeCloseTo(direction * 360, 8)
    expect(observer.evaluation?.metrics?.flipProgressDegrees).toBeCloseTo(360, 8)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.flipPhase).toBe(6)
    expect(observer.evaluation?.metrics?.recoveryDwellSeconds).toBeCloseTo(FULL_FLIP_HOLD_SECONDS, 9)
    expect(Object.keys(observer.checkpointStates)).toEqual([...FULL_FLIP_PHASE_IDS])
    // Input carries no pitch command: only measured state proves the maneuver.
    expect(observer.trace.every(({ normalizedInput }) => normalizedInput?.pitch === 0)).toBe(true)
  })

  it('starts on elevated actual ground even if a configured free-flight spawn is high', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 7, y: 35, z: -9 } }
    const observer = prepared(config)
    expect(observer.trace[0].groundContact?.touching).toBe(true)
    expect(observer.trace[0].state.positionM.y).toBeLessThan(6)
    observer.turn(360)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeCloseTo(createTrainingFieldAnchors(config).launch.y - config.ground.heightM + 10, 6)
  })

  it.each([-1, 1])('uses local pitch at a different heading for direction %s', (direction) => {
    const observer = prepared(DEFAULT_DRONE_CONFIG, Math.PI * 0.73)
    observer.turn(direction * 360)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.flipDirection).toBe(direction)
    expect(observer.evaluation?.metrics?.flipSignedDegrees).toBeCloseTo(direction * 360, 8)
    expect(observer.evaluation?.metrics?.flipOffAxisDegrees).toBeLessThan(1e-8)
  })

  it('passes the actual session and preserves the ordered six checkpoint metrics', () => {
    const observer = prepared()
    observer.turn(-360)
    observer.repeat(8)
    const session = new TrainingSession({ lessons: [FULL_FLIP_LESSON], initialLessonId: 'full-flip', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const current of observer.trace) {
      session.consumeSample(current)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().phase).toBe('SUCCESS')
    expect(session.getState().result).toMatchObject({ lessonId: 'full-flip', completedCheckpoints: 6, totalCheckpoints: 6, score: 100 })
    expect(session.getState().result?.metrics.flipProgressDegrees).toBeCloseTo(360, 8)
  })

  it('observes the same complete turn when successive samples choose alternating quaternion signs', () => {
    const observer = prepared()
    observer.turn(360)
    observer.repeat(8)
    const session = new TrainingSession({ lessons: [FULL_FLIP_LESSON], initialLessonId: 'full-flip', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const [index, current] of observer.trace.entries()) {
      const q = current.state.orientation
      session.consumeSample({ ...current, state: { ...current.state, orientation: index % 2 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : q } })
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().phase).toBe('SUCCESS')
    expect(session.getState().result?.metrics.flipSignedDegrees).toBeCloseTo(360, 8)
    expect(session.getState().result?.completedCheckpoints).toBe(6)
  })

  it('does not pass an airborne start or a grounded stick ritual', () => {
    const airborne = sample(0)
    expect(fullFlipEvaluator.evaluate(airborne, directOptions(0, airborne)).checkpointIds).toBeUndefined()
    const observer = new Observer()
    observer.repeat(120)
    expect(observer.evaluation?.metrics?.flipPhase).toBe(1)
    expect(observer.checkpointStates['flip-inverted']).toBeUndefined()
  })

  it('does not pass stationary upright poses, including alternating quaternion signs', () => {
    const observer = prepared()
    for (let index = 0; index < 120; index += 1) observer.safe({ orientation: index % 2 ? { x: 0, y: 0, z: 0, w: -1 } : IDENTITY_QUATERNION })
    expect(observer.evaluation?.metrics?.flipProgressDegrees).toBe(0)
    expect(observer.evaluation?.metrics?.flipPhase).toBe(3)
  })

  it.each(['y', 'z'] as const)('rejects a physical full turn about the %s axis as flip credit', (axis) => {
    const observer = prepared()
    observer.turn(360, axis)
    observer.repeat(12)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.checkpointStates['flip-upright']).toBeUndefined()
    expect(observer.evaluation?.metrics?.flipCompleted).toBe(0)
  })

  it('does not sum absolute rotation from repeated half-flip-and-return rocking', () => {
    const observer = prepared()
    for (let index = 0; index < 3; index += 1) {
      observer.turn(180)
      observer.turn(-180)
    }
    observer.repeat(10)
    expect(observer.evaluation?.metrics?.flipProgressDegrees).toBeCloseTo(0, 8)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.checkpointStates['flip-inverted']?.completed).toBe(true)
    expect(observer.checkpointStates['flip-upright']).toBeUndefined()
  })

  it('requires the full angular tolerance rather than merely returning near upright at 330 degrees', () => {
    const observer = prepared()
    observer.turn(330)
    observer.repeat(10)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.flipProgressDegrees).toBeCloseTo(330, 8)
    expect(observer.evaluation?.metrics?.flipCompleted).toBe(0)
    expect(FULL_FLIP_COMPLETION_DEGREES).toBe(340)
  })

  it('allows the twenty-degree completion margin and requires a separate recovery hold', () => {
    const observer = prepared()
    observer.turn(342)
    expect(observer.checkpointStates['flip-upright']?.completed).toBe(true)
    expect(observer.evaluation?.status).not.toBe('success')
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })

  it('does not convert two fast complete turns into an already-held single turn', () => {
    const observer = prepared()
    observer.turn(360)
    observer.turn(360)
    observer.repeat(10)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.flipCompleted).toBe(0)
    expect(observer.evaluation?.metrics?.flipProgressDegrees).toBeCloseTo(0, 8)
  })

  it('keeps preparation short but does not count it before height, attitude and velocity qualify', () => {
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 2, { x: 0, y: 7.9, z: 0 })
    observer.repeat(10)
    expect(observer.evaluation?.metrics?.flipEpisodeValid).toBe(0)
    const current = sample(0, { velocity: { x: 0, y: 3.6, z: 0 } })
    expect(fullFlipEvaluator.evaluate(current, directOptions(2, current)).metrics?.preparationQualifying).toBe(0)
    expect(FULL_FLIP_PREPARATION_SECONDS).toBe(0.1)
  })

  it('keeps a prepared upward blip valid before rotation starts', () => {
    const observer = prepared()
    observer.repeat(8, { velocity: { x: 0, y: 5, z: 0 } })
    expect(observer.evaluation?.metrics?.flipEpisodeValid).toBe(1)
    observer.turn(360)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })

  it.each([
    { x: 0, y: -2.6, z: 0 },
    { x: 0, y: 4.1, z: 0 },
    { x: 8.1, y: 0, z: 0 },
  ])('requires moderate velocity throughout recovery: %o', (velocity) => {
    const observer = prepared()
    observer.turn(360)
    observer.repeat(12, { velocity })
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.recoveryDwellSeconds).toBe(0)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('success')
  })

  it('invalidates old complete-turn proof on ground or below the recovery floor', () => {
    for (const altitude of [0, FULL_FLIP_MIN_HEIGHT_M - 0.01]) {
      const current = sample(0, { position: { x: 0, y: altitude, z: 0 } })
      const prior: TrainingEvaluation = { status: 'continue', metrics: { flipEpisodeState: 3, flipEpisodeValid: 1, flipInverted: 1, flipCompleted: 1, flipSignedDegrees: 360, flipProgressDegrees: 360, flipDirection: 1 } }
      const interrupted = fullFlipEvaluator.evaluate(current, directOptions(5, current, null, prior))
      expect(interrupted.metrics).toMatchObject({ flipInterrupted: 1, flipEpisodeValid: 0, flipCompleted: 0, flipProgressDegrees: 0 })
      const standing = new Observer(DEFAULT_DRONE_CONFIG, 5, { x: 0, y: 10, z: 0 })
      standing.evaluation = interrupted
      standing.repeat(30)
      expect(standing.evaluation?.status).not.toBe('success')
      expect(standing.evaluation?.metrics?.flipCompleted).toBe(0)
      standing.turn(360)
      standing.repeat(8)
      expect(standing.evaluation?.status).toBe('success')
    }
  })

  it('invalidates a departed exercise area and needs a new full flip after returning', () => {
    const current = sample(0, { position: { x: 81, y: 10, z: 0 } })
    const prior: TrainingEvaluation = { status: 'continue', metrics: { flipEpisodeState: 3, flipEpisodeValid: 1, flipInverted: 1, flipCompleted: 1, flipSignedDegrees: 360, flipProgressDegrees: 360, flipDirection: 1 } }
    expect(fullFlipEvaluator.evaluate(current, directOptions(5, current, null, prior)).metrics).toMatchObject({ insideFlipArea: 0, flipInterrupted: 1, flipCompleted: 0 })
  })

  it('does not restore an entire maneuver solely from historical checkpoints', () => {
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 5, { x: 0, y: 10, z: 0 })
    observer.repeat(60)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.flipCompleted).toBe(0)
  })

  it('rejects pose changes without matching measured angular velocity', () => {
    const observer = prepared()
    const result = observer.tick({ orientation: quaternionFromRotationVector({ x: -20 * radians, y: 0, z: 0 }) })
    expect(result.status).toBe('failure')
    expect(result.message).toContain('旋轉速度不一致')
  })

  it('rejects a rate-only rotation claim while the orientation stays still', () => {
    const observer = prepared()
    const result = observer.tick({ orientation: IDENTITY_QUATERNION, rate: { x: -300 * radians, y: 0, z: 0 } })
    expect(result.status).toBe('failure')
    expect(result.message).toContain('旋轉速度不一致')
  })

  it.each(['pose-only', 'rate-only'] as const)('rejects many tiny %s changes whose per-sample errors fit the angular tolerance', (kind) => {
    const observer = prepared()
    let previous = observer.trace.at(-1)!
    let evaluation = observer.evaluation!
    const startingTime = previous.timestampSeconds
    for (let index = 1; index <= 360; index += 1) {
      const time = startingTime + index / 240
      const base = sample(previous.state.stepIndex + 1, {
        position: previous.state.positionM,
        orientation: kind === 'pose-only' ? quaternionFromRotationVector({ x: -index * radians, y: 0, z: 0 }) : IDENTITY_QUATERNION,
        rate: kind === 'rate-only' ? { x: -240 * radians, y: 0, z: 0 } : ZERO,
      })
      const current = { ...base, timestampSeconds: time, state: { ...base.state, timeSeconds: time } }
      evaluation = fullFlipEvaluator.evaluate(current, context(3, {
        elapsedSeconds: time, previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation,
      }))
      if (evaluation.status === 'failure') break
      previous = current
    }
    expect(evaluation.status).toBe('failure')
    expect(evaluation.message).toContain('累積姿態變化')
    expect(evaluation.metrics?.angularConsistencyErrorDegrees).toBeLessThan(evaluation.metrics?.angularToleranceDegrees ?? 0)
    expect(evaluation.metrics?.flipRateConsistencyErrorDegrees).toBeGreaterThan(12)
  })

  it('retains the actual interruption reason and values while returning to preparation', () => {
    const departed = sample(0, { position: { x: 81, y: 10, z: 0 } })
    const interrupted = fullFlipEvaluator.evaluate(departed, directOptions(4, departed))
    expect(interrupted.metrics).toMatchObject({ flipInterruptionReason: 3, interruptionLaunchDistanceM: 81 })
    const current = sample(1, { position: { x: 0, y: 7, z: 0 } })
    const returned = fullFlipEvaluator.evaluate(current, directOptions(4, current, null, interrupted))
    expect(returned.metrics).toMatchObject({ flipInterruptionReason: 3, interruptionLaunchDistanceM: 81, altitudeM: 7, flipEpisodeValid: 0 })
  })

  it('rejects ambiguous retained jumps rather than guessing a winding count', () => {
    const before = sample(0, { rate: { x: -2_400 * radians, y: 0, z: 0 } })
    const after = sample(1, { rate: before.state.angularVelocityBodyRadPerSec, orientation: quaternionFromRotationVector({ x: -120 * radians, y: 0, z: 0 }) })
    expect(fullFlipEvaluator.evaluate(after, directOptions(3, after, before)).status).toBe('failure')
  })

  it.each(['crash', 'disarm', 'gap', 'reset', 'teleport', 'nonfinite', 'ground-missing', 'ground-forged'] as const)('terminates invalid %s evidence rather than completing from checkpoint history', (kind) => {
    const before = sample(0)
    let current = sample(1)
    if (kind === 'crash') current = { ...current, state: { ...current.state, crashed: true } }
    if (kind === 'disarm') current = { ...current, armed: false }
    if (kind === 'gap') current = { ...current, timestampSeconds: 1, state: { ...current.state, timeSeconds: 1 } }
    if (kind === 'reset') current = { ...current, state: { ...current.state, timeSeconds: 0, stepIndex: 0 } }
    if (kind === 'teleport') current = { ...current, state: { ...current.state, positionM: { x: 10, y: 10, z: 0 } } }
    if (kind === 'nonfinite') current = { ...current, state: { ...current.state, velocityMps: { x: Number.NaN, y: 0, z: 0 } } }
    if (kind === 'ground-missing') current = { ...current, groundContact: undefined }
    if (kind === 'ground-forged') current = { ...current, groundContact: { ...current.groundContact!, touching: true } }
    const result = fullFlipEvaluator.evaluate(current, directOptions(5, current, before))
    expect(result.status).toBe('failure')
  })

  it('keeps explicit practice unlimited while the timed challenge expires', () => {
    const current = sample(0, { position: createTrainingFieldAnchors(DEFAULT_DRONE_CONFIG).launch })
    expect(fullFlipEvaluator.evaluate(current, context(0, { elapsedSeconds: FULL_FLIP_TIME_LIMIT_SECONDS + 1, mode: 'practice' })).status).toBe('continue')
    const timeout = fullFlipEvaluator.evaluate(current, context(0, { elapsedSeconds: FULL_FLIP_TIME_LIMIT_SECONDS + 1, mode: 'challenge' }))
    expect(timeout.status).toBe('failure')
    expect(timeout.message).toContain('逾時')
    expect(FULL_FLIP_LEARNING_CONTENT).toMatchObject({ code: 'L11', prerequisiteIds: ['full-roll'] })
    expect(FULL_FLIP_LESSON.scoring.minimumActiveSeconds).toBe(0)
  })

  it('measures front-positive flip rate with the canonical body-X sign and ignores heading for upright tilt', () => {
    const state = sample(0, { orientation: quaternionFromRotationVector({ x: 0, y: 2.2, z: 0 }), rate: { x: -radians * 50, y: 0, z: 0 } }).state
    expect(measureFullFlipMotion(state)).toMatchObject({ tiltDegrees: 0, flipRateDegreesPerSecond: 50, verticalSpeedMps: 0, horizontalSpeedMps: 0 })
  })
})
