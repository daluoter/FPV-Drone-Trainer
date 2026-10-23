import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig } from '../drone'
import { IDENTITY_QUATERNION, multiplyQuaternions, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'
import {
  BASIC_RECOVERY_AREA_RADIUS_M, BASIC_RECOVERY_HOLD_SECONDS, BASIC_RECOVERY_LEARNING_CONTENT, BASIC_RECOVERY_LESSON,
  BASIC_RECOVERY_PREPARATION_SECONDS, BASIC_RECOVERY_TARGET_HEIGHT_M,
  BASIC_RECOVERY_PHASE_IDS, BASIC_RECOVERY_TIME_LIMIT_SECONDS, basicRecoveryEvaluator, measureBasicRecoveryMotion,
} from './basicRecovery'

const STEP = 0.1
const ZERO = { x: 0, y: 0, z: 0 } as const
const tilt = (degrees: number): Quaternion => quaternionFromRotationVector({ x: 0, y: 0, z: -degrees * Math.PI / 180 })

function references(config = DEFAULT_DRONE_CONFIG): readonly TrainingSceneReference[] {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
  ]
}

function checkpoints(phase: number): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(BASIC_RECOVERY_PHASE_IDS.slice(0, phase).map((id) => [id,
    { id, completed: true, completedAtSeconds: 0.1, metrics: {} },
  ]))
}

function sample(index = 0, options: {
  altitude?: number; velocity?: Vector3; orientation?: Quaternion; angularVelocity?: Vector3; position?: Vector3; config?: DroneConfig
} = {}): TrainingSample {
  const config = options.config ?? DEFAULT_DRONE_CONFIG
  const position = options.position ?? { x: config.spawnPositionM.x, y: config.ground.heightM + (options.altitude ?? 6), z: config.spawnPositionM.z }
  const state = createInitialDroneState(config, position, options.orientation ?? IDENTITY_QUATERNION)
  const supportOffsetM = droneGroundSupport(config, state.orientation).supportOffsetM
  const timestampSeconds = (index + 1) * STEP
  return {
    timestampSeconds, armed: true, normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
    groundContact: { heightM: config.ground.heightM, supportOffsetM,
      touching: state.positionM.y <= config.ground.heightM + supportOffsetM + DRONE_GROUND_CLEARANCE_M + 1e-8 },
    state: { ...state, velocityMps: options.velocity ?? ZERO, angularVelocityBodyRadPerSec: options.angularVelocity ?? ZERO,
      timeSeconds: timestampSeconds, stepIndex: index + 1 },
  }
}

function context(phase = 2, overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: BASIC_RECOVERY_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: checkpoints(phase), sceneReferences: references(), mode: 'practice', ...overrides }
}

/** Velocity-consistent observer fixture; the separate demo tests exercise actual RC physics. */
class Observer {
  public evaluation: TrainingEvaluation | null = null
  public readonly trace: TrainingSample[] = []
  public checkpointStates: Readonly<Record<string, TrainingCheckpointState>>
  private position: Vector3
  private velocity: Vector3 = ZERO

  public constructor(public readonly config = DEFAULT_DRONE_CONFIG, phase = 0, position?: Vector3) {
    this.position = position ?? createTrainingFieldAnchors(config).launch
    this.checkpointStates = checkpoints(phase)
  }

  public tick(options: { velocity?: Vector3; orientation?: Quaternion; angularVelocity?: Vector3 } = {}): TrainingEvaluation {
    const velocity = options.velocity ?? ZERO
    this.position = {
      x: this.position.x + (this.velocity.x + velocity.x) * STEP / 2,
      y: this.position.y + (this.velocity.y + velocity.y) * STEP / 2,
      z: this.position.z + (this.velocity.z + velocity.z) * STEP / 2,
    }
    this.velocity = velocity
    const current = sample(this.trace.length, { ...options, velocity, position: this.position, config: this.config })
    this.position = current.state.positionM
    const previous = this.trace.at(-1)
    this.evaluation = basicRecoveryEvaluator.evaluate(current, context(0, {
      checkpoints: this.checkpointStates, sceneReferences: references(this.config), previousSample: previous,
      previousFlightSample: previous, previousEvaluation: this.evaluation,
    }))
    expect(this.evaluation.status, this.evaluation.message).not.toBe('failure')
    expect(this.evaluation.checkpointIds?.length ?? 0).toBeLessThanOrEqual(1)
    this.trace.push(current)
    for (const id of this.evaluation.checkpointIds ?? []) this.checkpointStates = {
      ...this.checkpointStates, [id]: { id, completed: true, completedAtSeconds: current.timestampSeconds, metrics: this.evaluation.metrics ?? {} },
    }
    return this.evaluation
  }

  public repeat(count: number, options: Parameters<Observer['tick']>[0] = {}): void {
    for (let index = 0; index < count; index += 1) this.tick(options)
  }
}

function prepared(phase: number, altitude = BASIC_RECOVERY_TARGET_HEIGHT_M): Observer {
  const observer = new Observer(DEFAULT_DRONE_CONFIG, phase, { x: 0, y: altitude, z: 0 })
  observer.repeat(4)
  expect(observer.evaluation?.metrics?.exerciseReady).toBe(1)
  return observer
}

function completeTrace(config = DEFAULT_DRONE_CONFIG): readonly TrainingSample[] {
  const observer = new Observer(config)
  observer.tick()
  observer.repeat(40, { velocity: { x: 0, y: 1.5, z: 0 } })
  observer.repeat(8)
  observer.tick({ orientation: tilt(20) })
  observer.repeat(7)
  observer.repeat(6)
  observer.tick({ velocity: { x: 0, y: -1, z: 0 } })
  observer.repeat(7)
  observer.repeat(6)
  observer.tick({ velocity: { x: 2, y: 0, z: 0 } })
  observer.repeat(7)
  expect(observer.evaluation?.status).toBe('success')
  return observer.trace
}

function sessionRun(trace: readonly TrainingSample[], mode: 'practice' | 'challenge', config = DEFAULT_DRONE_CONFIG) {
  const session = new TrainingSession({
    lessons: [BASIC_RECOVERY_LESSON], initialLessonId: 'basic-recovery', countdownDurationSeconds: 0, sceneReferences: references(config),
    attemptContext: { rulesVersion: 6, physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}', inputSource: 'keyboard', mode, assistance: 'none' },
  })
  session.start(0)
  session.tick(0)
  for (const current of trace) session.consumeSample(current)
  return session.getState()
}

describe('basic recovery motion observations', () => {
  it('measures actual tilt, signed pilot axes, body rotation and horizontal/vertical velocity independently of yaw', () => {
    const yaw = quaternionFromRotationVector({ x: 0, y: -Math.PI / 2, z: 0 })
    const motion = measureBasicRecoveryMotion({ orientation: multiplyQuaternions(yaw, tilt(20)), velocityMps: { x: 3, y: -0.9, z: 4 }, angularVelocityBodyRadPerSec: { x: 0, y: Math.PI / 6, z: 0 } })
    expect(motion.tiltDegrees).toBeCloseTo(20)
    expect(motion.rollDegrees).toBeCloseTo(20)
    expect(motion.pitchDegrees).toBeCloseTo(0)
    expect(motion.verticalSpeedMps).toBe(-0.9)
    expect(motion.horizontalSpeedMps).toBe(5)
    expect(motion.bodyRateDegreesPerSecond).toBeCloseTo(30)
    expect(measureBasicRecoveryMotion({ orientation: quaternionFromRotationVector({ x: 0.2, y: 0, z: 0 }), velocityMps: ZERO, angularVelocityBodyRadPerSec: ZERO }).pitchDegrees).toBeCloseTo(0.2 * 180 / Math.PI)
  })
})

describe('guided manual basic recovery', () => {
  it.each(['practice', 'challenge'] as const)('completes exactly eight ordered %s checkpoints after actual ground, onsets and recoveries', (mode) => {
    const result = sessionRun(completeTrace(), mode)
    expect(result.phase).toBe('SUCCESS')
    expect(result.result).toMatchObject({ outcome: 'SUCCESS', score: 100, completedCheckpoints: 8, totalCheckpoints: 8 })
    expect(result.result?.metrics).toMatchObject({ recoveryPhase: 8, exercisesCompleted: 3, groundTouching: 0 })
    const times = BASIC_RECOVERY_PHASE_IDS.map((id) => result.checkpoints[id].completedAtSeconds!)
    expect(times.every((time, index) => index === 0 || time > times[index - 1])).toBe(true)
    expect(BASIC_RECOVERY_LEARNING_CONTENT.prerequisiteIds).toEqual(['wide-gate'])
  })

  it('requires the real launch ground and three metres of actual self-takeoff before any recovery exercise', () => {
    expect(basicRecoveryEvaluator.evaluate(sample(), context(0)).checkpointIds).toBeUndefined()
    const ground = basicRecoveryEvaluator.evaluate(sample(0, { altitude: 0 }), context(0))
    expect(ground.checkpointIds).toEqual(['recovery-ground'])
    expect(ground.metrics?.recoveryPhase).toBe(1)
    expect(basicRecoveryEvaluator.evaluate(sample(0, { altitude: 2.9 }), context(1)).checkpointIds).toBeUndefined()
    expect(basicRecoveryEvaluator.evaluate(sample(0, { altitude: 3 }), context(1)).checkpointIds).toEqual(['recovery-liftoff'])
    expect(basicRecoveryEvaluator.evaluate(sample(0, { position: { x: 3, y: 0, z: 0 } }), context(0)).checkpointIds).toBeUndefined()
  })

  it('does not pass from centered motion, stick gestures, or a tilt made before readiness', () => {
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 2, { x: 0, y: 6, z: 0 })
    observer.repeat(6, { orientation: tilt(20) })
    expect(observer.evaluation?.metrics?.exerciseReady).toBe(0)
    expect(observer.checkpointStates['recovery-tilt-onset']).toBeUndefined()
    observer.repeat(20)
    expect(observer.evaluation?.metrics?.exerciseReady).toBe(1)
    expect(observer.checkpointStates['recovery-tilt-onset']).toBeUndefined()
    const centered = sample(0)
    const gesture = { ...centered, normalizedInput: { roll: 1, pitch: 1, yaw: 1, throttle: 0 } }
    const evaluation = basicRecoveryEvaluator.evaluate(gesture, context(2))
    expect(evaluation.checkpointIds).toBeUndefined()
    observer.tick({ orientation: tilt(-20) })
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-tilt-onset'])
    expect(observer.evaluation?.metrics).toMatchObject({ recoveryPhase: 3, currentEpisodeValid: 1, recoveryDwellSeconds: 0 })
  })

  it('requires fresh onset when an historical onset checkpoint has no valid current episode', () => {
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 3, { x: 0, y: 6, z: 0 })
    observer.repeat(20)
    expect(observer.evaluation?.metrics).toMatchObject({ recoveryPhase: 3, exerciseReady: 1, currentEpisodeValid: 0 })
    expect(observer.checkpointStates['recovery-tilt-level']).toBeUndefined()
    observer.tick({ orientation: tilt(20) })
    observer.repeat(4)
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-tilt-level'])
  })

  it('cannot prepare while already sinking at the onset threshold or while moving too fast', () => {
    const sink = new Observer(DEFAULT_DRONE_CONFIG, 4, { x: 0, y: 7, z: 0 })
    sink.repeat(8, { velocity: { x: 0, y: -0.8, z: 0 } })
    expect(sink.evaluation?.metrics?.exerciseReady).toBe(0)
    expect(sink.checkpointStates['recovery-sink-onset']).toBeUndefined()
    const drift = new Observer(DEFAULT_DRONE_CONFIG, 6, { x: 0, y: 6, z: 0 })
    drift.repeat(8, { velocity: { x: 1.5, y: 0, z: 0 } })
    expect(drift.evaluation?.metrics?.exerciseReady).toBe(0)
    expect(drift.checkpointStates['recovery-drift-onset']).toBeUndefined()
  })

  it('prepares at three metres without forcing horizontal hover before the tilt exercise', () => {
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 2, { x: 0, y: 3, z: 0 })
    const moving = { velocity: { x: 2.5, y: 1.2, z: 0 }, orientation: tilt(10), angularVelocity: { x: 1, y: 0, z: 0 } }
    observer.repeat(2, moving)
    expect(observer.evaluation?.metrics).toMatchObject({ exerciseReady: 1, preparationDwellSeconds: 0.1 })
    expect(observer.checkpointStates['recovery-tilt-onset']).toBeUndefined()
    observer.tick({ ...moving, orientation: tilt(16) })
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-tilt-onset'])
    observer.repeat(4, { ...moving, orientation: tilt(11) })
    expect(observer.checkpointStates['recovery-tilt-level']?.completed).toBe(true)
    expect(BASIC_RECOVERY_PREPARATION_SECONDS).toBe(0.1)
    expect(BASIC_RECOVERY_TARGET_HEIGHT_M).toBe(4)
  })

  it('allows modest drift and a moderate upward correction when stopping an actual descent', () => {
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 4, { x: 0, y: 3, z: 0 })
    observer.repeat(2, { velocity: { x: 2.5, y: 0.8, z: 0 }, orientation: tilt(22) })
    expect(observer.evaluation?.metrics?.exerciseReady).toBe(1)
    observer.tick({ velocity: { x: 2.5, y: -0.55, z: 0 }, orientation: tilt(22) })
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-sink-onset'])
    observer.repeat(4, { velocity: { x: 2.5, y: 1.8, z: 0 }, orientation: tilt(24), angularVelocity: { x: 1.4, y: 0, z: 0 } })
    expect(observer.checkpointStates['recovery-sink-stop']?.completed).toBe(true)
    expect(observer.evaluation?.metrics?.recoveryPhase).toBe(6)
  })

  it('accepts a gentle remaining drift and ordinary height corrections after slowing down', () => {
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 6, { x: 0, y: 3, z: 0 })
    observer.repeat(2, { velocity: { x: 0.7, y: 1.2, z: 0 }, orientation: tilt(18) })
    expect(observer.evaluation?.metrics?.exerciseReady).toBe(1)
    observer.tick({ velocity: { x: 1.3, y: 1.2, z: 0 }, orientation: tilt(18) })
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-drift-onset'])
    observer.repeat(4, { velocity: { x: 0.9, y: 1.8, z: 0 }, orientation: tilt(18), angularVelocity: { x: 1.4, y: 0, z: 0 } })
    expect(observer.evaluation?.status).toBe('success')
  })

  it('retains distinct preparation and onset ranges after easing the thresholds', () => {
    const sink = new Observer(DEFAULT_DRONE_CONFIG, 4, { x: 0, y: 4, z: 0 })
    sink.repeat(4, { velocity: { x: 0, y: -0.5, z: 0 } })
    expect(sink.evaluation?.metrics?.exerciseReady).toBe(0)
    expect(sink.checkpointStates['recovery-sink-onset']).toBeUndefined()
    const drift = new Observer(DEFAULT_DRONE_CONFIG, 6, { x: 0, y: 4, z: 0 })
    drift.repeat(4, { velocity: { x: 1.2, y: 0, z: 0 } })
    expect(drift.evaluation?.metrics?.exerciseReady).toBe(0)
    expect(drift.checkpointStates['recovery-drift-onset']).toBeUndefined()
    const tiltObserver = prepared(2)
    tiltObserver.tick({ orientation: tilt(15) })
    tiltObserver.repeat(5, { orientation: tilt(15) })
    expect(tiltObserver.checkpointStates['recovery-tilt-level']).toBeUndefined()
  })

  it('still requires descent to slow and cannot substitute a continuing sink for recovery', () => {
    const observer = prepared(4)
    observer.tick({ velocity: { x: 0, y: -0.5, z: 0 } })
    observer.repeat(5, { velocity: { x: 0, y: -0.3, z: 0 } })
    expect(observer.checkpointStates['recovery-sink-stop']).toBeUndefined()
    observer.repeat(4, { velocity: { x: 0, y: -0.2, z: 0 } })
    expect(observer.checkpointStates['recovery-sink-stop']?.completed).toBe(true)
  })

  it('requires a continuous quarter-second near-level hold with low rotation after an actual tilt', () => {
    const observer = prepared(2)
    observer.tick({ orientation: tilt(20) })
    observer.repeat(3)
    expect(observer.evaluation?.metrics?.recoveryDwellSeconds).toBeCloseTo(0.2)
    observer.tick({ orientation: tilt(13) })
    expect(observer.evaluation?.metrics?.recoveryDwellSeconds).toBe(0)
    observer.repeat(3, { angularVelocity: { x: 0, y: Math.PI, z: 0 } })
    expect(observer.checkpointStates['recovery-tilt-level']).toBeUndefined()
    observer.repeat(4)
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-tilt-level'])
    expect(observer.evaluation?.metrics).toMatchObject({ recoveryPhase: 4, exerciseReady: 0, recoveryDwellSeconds: 0 })
    expect(BASIC_RECOVERY_HOLD_SECONDS).toBe(0.25)
  })

  it('accepts a real pitch tilt and an arbitrary heading instead of requiring one stick direction', () => {
    const observer = prepared(2)
    observer.tick({ orientation: quaternionFromRotationVector({ x: -0.3, y: 0, z: 0 }) })
    const yaw = quaternionFromRotationVector({ x: 0, y: 1.8, z: 0 })
    observer.repeat(4, { orientation: yaw })
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-tilt-level'])
  })

  it('requires new preparation between exercises and accepts moderate climb but refuses a fast rebound', () => {
    const observer = prepared(4)
    observer.tick({ velocity: { x: 0, y: -1, z: 0 } })
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-sink-onset'])
    observer.repeat(7, { velocity: { x: 0, y: 3, z: 0 } })
    expect(observer.checkpointStates['recovery-sink-stop']).toBeUndefined()
    observer.repeat(4, { velocity: { x: 0, y: 1.5, z: 0 } })
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-sink-stop'])
    observer.tick({ velocity: { x: 2, y: 0, z: 0 } })
    expect(observer.checkpointStates['recovery-drift-onset']).toBeUndefined()
    expect(observer.evaluation?.metrics?.exerciseReady).toBe(0)
  })

  it('cannot pass drift recovery while still tilted, rotating, or descending quickly', () => {
    const observer = prepared(6)
    observer.tick({ velocity: { x: 2, y: 0, z: 0 } })
    observer.repeat(6, { orientation: tilt(25) })
    expect(observer.checkpointStates['recovery-drift-stop']).toBeUndefined()
    observer.repeat(6, { velocity: { x: 0, y: -2.2, z: 0 } })
    expect(observer.checkpointStates['recovery-drift-stop']).toBeUndefined()
    observer.repeat(6, { angularVelocity: { x: 2, y: 0, z: 0 } })
    expect(observer.checkpointStates['recovery-drift-stop']).toBeUndefined()
    observer.repeat(6)
    expect(observer.evaluation?.status).toBe('success')
  })

  it.each([0, 0.9])('invalidates the current episode at altitude %s and requires fresh preparation and onset', (altitude) => {
    const previous = { status: 'continue', metrics: { recoveryPhase: 5, currentEpisodeValid: 1, recoveryDwellSeconds: 0.4, recoveryQualifying: 1 } } as const
    const interrupted = basicRecoveryEvaluator.evaluate(sample(0, { altitude }), context(5, { previousEvaluation: previous }))
    expect(interrupted.status).toBe('continue')
    expect(interrupted.checkpointIds).toBeUndefined()
    expect(interrupted.metrics).toMatchObject({ recoveryPhase: 5, currentEpisodeValid: 0, episodeInterrupted: 1, recoveryDwellSeconds: 0 })
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 5, { x: 0, y: 6, z: 0 })
    observer.evaluation = interrupted
    observer.repeat(8)
    expect(observer.evaluation?.metrics?.exerciseReady).toBe(1)
    expect(observer.checkpointStates['recovery-sink-stop']).toBeUndefined()
    observer.tick({ velocity: { x: 0, y: -1, z: 0 } })
    expect(observer.evaluation?.metrics).toMatchObject({ currentEpisodeValid: 1, episodeInterrupted: 0 })
    expect(observer.evaluation?.checkpointIds).toBeUndefined()
    observer.repeat(4)
    expect(observer.evaluation?.checkpointIds).toEqual(['recovery-sink-stop'])
    expect(observer.checkpointStates['recovery-tilt-level']?.completed).toBe(true)
  })

  it('pauses the hold outside the broad field but keeps the existing valid recovery episode', () => {
    const outside = sample(0, { position: { x: BASIC_RECOVERY_AREA_RADIUS_M + 1, y: 6, z: 0 } })
    const previous = { status: 'continue', metrics: { recoveryPhase: 7, currentEpisodeValid: 1, recoveryDwellSeconds: 0.4, recoveryQualifying: 1, exerciseReady: 1 } } as const
    const paused = basicRecoveryEvaluator.evaluate(outside, context(7, { previousEvaluation: previous }))
    expect(paused.metrics).toMatchObject({ currentEpisodeValid: 1, recoveryDwellSeconds: 0, exerciseReady: 0, insideRecoveryArea: 0 })
    const observer = new Observer(DEFAULT_DRONE_CONFIG, 7, { x: BASIC_RECOVERY_AREA_RADIUS_M - 1, y: 6, z: 0 })
    observer.evaluation = paused
    observer.repeat(6)
    expect(observer.evaluation?.status).toBe('success')
  })

  it('does not prepare or detect a new onset outside the field and cannot start sink onset without altitude margin', () => {
    const ready = { status: 'continue', metrics: { recoveryPhase: 2, exerciseReady: 1 } } as const
    const outside = basicRecoveryEvaluator.evaluate(sample(0, { position: { x: BASIC_RECOVERY_AREA_RADIUS_M + 1, y: 6, z: 0 }, orientation: tilt(20) }), context(2, { previousEvaluation: ready }))
    expect(outside.metrics?.exerciseReady).toBe(0)
    expect(outside.checkpointIds).toBeUndefined()
    const low = basicRecoveryEvaluator.evaluate(sample(0, { altitude: 2.4, velocity: { x: 0, y: -1, z: 0 } }), context(4, {
      previousEvaluation: { status: 'continue', metrics: { recoveryPhase: 4, exerciseReady: 1 } },
    }))
    expect(low.checkpointIds).toBeUndefined()
    expect(low.metrics?.exerciseReady).toBe(0)
  })

  it('uses configured ground and supported launch even when the free-flight spawn is elevated', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 20 }, spawnPositionM: { x: 8, y: 50, z: -7 } }
    const result = sessionRun(completeTrace(config), 'practice', config)
    expect(result.phase).toBe('SUCCESS')
    expect(result.result?.metrics.altitudeM).toBeGreaterThan(5)
    expect(result.previousSample?.state.positionM.y).toBeGreaterThan(25)
    expect(result.checkpoints['recovery-ground']?.completed).toBe(true)
  })

  it('keeps practice unlimited and applies the declared challenge limit', () => {
    const current = sample()
    expect(BASIC_RECOVERY_TIME_LIMIT_SECONDS).toBe(300)
    expect(basicRecoveryEvaluator.evaluate(current, context(2, { mode: 'practice', elapsedSeconds: 10_000 })).status).toBe('continue')
    expect(basicRecoveryEvaluator.evaluate(current, context(2, { mode: 'challenge', elapsedSeconds: 300 })).status).toBe('continue')
    expect(basicRecoveryEvaluator.evaluate(current, context(2, { mode: 'challenge', elapsedSeconds: 300.1 })).message).toContain('逾時')
  })

  it('keeps samples, context, checkpoints and physical state observationally unchanged', () => {
    const current = sample(0, { orientation: tilt(20) })
    const ctx = context(2, { previousEvaluation: { status: 'continue', metrics: { recoveryPhase: 2, exerciseReady: 1 } } })
    const before = JSON.stringify({ current, ctx })
    expect(basicRecoveryEvaluator.evaluate(current, ctx).checkpointIds).toEqual(['recovery-tilt-onset'])
    expect(JSON.stringify({ current, ctx })).toBe(before)
  })
})

describe('basic recovery data and safety boundaries', () => {
  it('stops on crash or disarm and waits when armed telemetry is absent', () => {
    const current = sample()
    expect(basicRecoveryEvaluator.evaluate({ ...current, state: { ...current.state, crashed: true } }, context()).message).toContain('墜毀')
    expect(basicRecoveryEvaluator.evaluate({ ...current, armed: false }, context()).message).toContain('解除解鎖')
    expect(basicRecoveryEvaluator.evaluate({ ...current, armed: undefined }, context()).checkpointIds).toBeUndefined()
  })

  it('rejects missing or contradictory geometry/contact and non-finite state', () => {
    const current = sample()
    expect(basicRecoveryEvaluator.evaluate(current, context(2, { sceneReferences: [] })).status).toBe('failure')
    expect(basicRecoveryEvaluator.evaluate({ ...current, groundContact: undefined }, context()).status).toBe('failure')
    expect(basicRecoveryEvaluator.evaluate({ ...current, groundContact: { ...current.groundContact!, touching: true } }, context()).status).toBe('failure')
    expect(basicRecoveryEvaluator.evaluate({ ...current, groundContact: { ...current.groundContact!, heightM: 1 } }, context()).status).toBe('failure')
    expect(basicRecoveryEvaluator.evaluate({ ...current, state: { ...current.state, velocityMps: { x: NaN, y: 0, z: 0 } } }, context()).status).toBe('failure')
  })

  it('rejects telemetry gaps, rewinds, and position jumps inconsistent with velocity', () => {
    const previous = sample(0)
    expect(basicRecoveryEvaluator.evaluate(sample(5), context(2, { previousFlightSample: previous })).message).toContain('資料中斷')
    expect(basicRecoveryEvaluator.evaluate({ ...sample(1), state: { ...sample(1).state, timeSeconds: 0 } }, context(2, { previousFlightSample: previous })).message).toContain('時間倒退')
    expect(basicRecoveryEvaluator.evaluate(sample(1, { position: { x: 10, y: 6, z: 0 } }), context(2, { previousFlightSample: previous })).message).toContain('位置跳躍')
    expect(basicRecoveryEvaluator.evaluate({ ...sample(1), state: { ...sample(1).state, stepIndex: 1 } }, context(2, { previousFlightSample: previous })).status).toBe('failure')
  })
})
