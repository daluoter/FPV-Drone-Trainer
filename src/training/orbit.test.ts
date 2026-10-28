import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { integrateBodyAngularVelocity, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import { createOrbitTarget, ORBIT_COMPLETION_DEGREES, ORBIT_EXIT_DISTANCE_M, ORBIT_EXIT_MIN_SPEED_MPS, ORBIT_LEARNING_CONTENT, ORBIT_LESSON, ORBIT_PHASE_IDS, ORBIT_REQUIRED_LAPS, orbitLearningEvaluator } from './orbit'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG) {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing }]
}
function checkpoints(phase = 0): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(ORBIT_PHASE_IDS.slice(0, phase).map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
}
function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: ORBIT_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: {}, sceneReferences: references(), ...overrides }
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
  private circleAngle = 0
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
    const result = orbitLearningEvaluator.evaluate(sample, context({ elapsedSeconds: timestampSeconds,
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
  public circle(degrees: number, direction = 1, omegaMagnitude = 0.3): void {
    const omega = direction * omegaMagnitude
    const count = Math.ceil(Math.abs(degrees * Math.PI / 180 / omega / STEP))
    for (let i = 0; i < count; i += 1) {
      this.circleAngle += omega * STEP
      this.safe({ x: 15 * omega * Math.cos(this.circleAngle), y: 0, z: -15 * omega * Math.sin(this.circleAngle) }, { x: 0, y: omega, z: 0 })
    }
  }
  public depart(distance = 5, speed = 2): void {
    const target = createOrbitTarget(createTrainingFieldAnchors(this.config).launch, this.config.ground.heightM)
    const x = this.position.x - target.x
    const z = this.position.z - target.z
    const radius = Math.hypot(x, z)
    this.repeat(Math.ceil(distance / speed / STEP), { x: x / radius * speed, y: 0, z: z / radius * speed })
  }
}
function atEntry(config = DEFAULT_DRONE_CONFIG, yawOffset = 0): Observer {
  const observer = new Observer(config, yawOffset)
  observer.safe()
  observer.repeat(40, { x: 0, y: 5, z: 0 })
  observer.safe()
  observer.repeat(60, { x: 0, y: 0, z: -5 })
  observer.safe()
  expect(observer.evaluation?.metrics?.orbitPhase).toBe(2)
  return observer
}

describe('ground-start inward-facing directed orbit', () => {
  it('exposes the stable lesson ID and nine Chinese ground-start steps', () => {
    expect(ORBIT_LESSON).toMatchObject({ id: 'orbit', priority: 4, title: '正刷鍋' })
    expect(ORBIT_LEARNING_CONTENT).toMatchObject({ code: 'L15', title: '正刷鍋' })
    expect(ORBIT_LESSON.checkpoints.map(({ id }) => id)).toEqual(ORBIT_PHASE_IDS)
    expect(ORBIT_LESSON.setup.sceneReferenceIds).toEqual(['training-launch', 'landing-surface', 'orbit-zone'])
    expect(ORBIT_LESSON.setup.spawnPositionM).toBeUndefined()
    expect(ORBIT_REQUIRED_LAPS).toBe(5)
    expect(ORBIT_COMPLETION_DEGREES).toBe(1800)
    expect(ORBIT_EXIT_DISTANCE_M).toBe(3)
    expect(ORBIT_EXIT_MIN_SPEED_MPS).toBe(0.5)
    expect(createOrbitTarget({ x: 6, y: 5.05, z: -3 }, 5)).toEqual({ x: 6, y: 15, z: -33 })
  })
  it.each([1, -1])('accepts five true inward-facing circles in direction %s and a controlled outward departure', (direction) => {
    const observer = atEntry()
    observer.circle(1815, direction)
    expect(observer.evaluation?.metrics).toMatchObject({ orbitPhase: 8, orbitCompleted: 1, orbitEpisodeValid: 1, orbitDirection: -direction })
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics?.orbitProgressDegrees).toBeGreaterThanOrEqual(ORBIT_COMPLETION_DEGREES)
    expect(observer.evaluation?.metrics?.orbitCompletedLaps).toBe(5)
    expect(observer.evaluation?.metrics?.orbitHeadingErrorDegrees).toBeLessThan(2)
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics?.orbitExitQualifying).toBe(0)
    observer.depart()
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ orbitPhase: 9, orbitExitQualifying: 1 })
    expect(Object.keys(observer.checkpointStates)).toEqual(ORBIT_PHASE_IDS)
    expect(observer.trace.every(({ normalizedInput }) => normalizedInput?.yaw === 0 && normalizedInput?.roll === 0)).toBe(true)
  })
  it('requires full 360° circles and cannot complete after only one, two, three or four', () => {
    const observer = atEntry()
    observer.circle(350)
    expect(observer.evaluation?.metrics?.orbitCompletedLaps).toBe(0)
    expect(observer.checkpointStates['orbit-lap-1']).toBeUndefined()
    observer.circle(25)
    for (let lap = 1; lap <= 4; lap += 1) {
      if (lap > 1) observer.circle(360)
      expect(observer.evaluation?.metrics?.orbitCompletedLaps).toBe(lap)
      expect(observer.evaluation?.metrics?.orbitCompleted).toBe(0)
      expect(observer.evaluation?.status).toBe('continue')
      expect(observer.evaluation?.metrics?.orbitPhase).toBe(3 + lap)
    }
    observer.repeat(8)
    expect(observer.evaluation?.status).not.toBe('success')
    observer.depart()
    expect(observer.evaluation?.status).not.toBe('success')
  })
  it('requires both three metres of outward growth and current outward speed after the fifth complete circle', () => {
    const observer = atEntry()
    observer.circle(1815)
    observer.depart(2)
    expect(observer.evaluation?.metrics?.orbitExitDistanceM).toBeLessThan(3)
    expect(observer.evaluation?.status).toBe('continue')
    observer.depart(2.5, 0.25)
    expect(observer.evaluation?.metrics?.orbitExitDistanceM).toBeGreaterThan(3)
    expect(observer.evaluation?.metrics?.orbitRadialSpeedMps).toBeLessThan(0.5)
    expect(observer.evaluation?.metrics?.orbitRecoveryDwellSeconds).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
    observer.depart(1.5)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('does not treat continued circles or a slower orbit as actual departure', () => {
    const observer = atEntry()
    observer.circle(1845)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics).toMatchObject({ orbitPhase: 8, orbitRecoveryDwellSeconds: 0 })
    const frozen = observer.evaluation!.metrics!.orbitProgressDegrees
    observer.circle(20, 1, 0.1)
    expect(observer.evaluation?.status).toBe('continue')
    observer.depart()
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.orbitProgressDegrees).toBe(frozen)
  })
  it('uses configured ground and launch coordinates rather than an elevated free-flight spawn', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 8 }, spawnPositionM: { x: 6, y: 45, z: -3 } }
    const observer = atEntry(config)
    observer.circle(1815, -1)
    observer.depart()
    expect(observer.trace[0].groundContact?.touching).toBe(true)
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeCloseTo(10.046)
  })
  it('creates an independent nine-step actual session result', () => {
    const observer = atEntry()
    observer.circle(1815)
    observer.depart()
    const session = new TrainingSession({ lessons: [ORBIT_LESSON], initialLessonId: 'orbit', countdownDurationSeconds: 0, sceneReferences: references() })
    session.start(0)
    session.tick(0)
    for (const sample of observer.trace) {
      session.consumeSample(sample)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ lessonId: 'orbit', outcome: 'SUCCESS', completedCheckpoints: 9, totalCheckpoints: 9 })
  })
  it('does not count yaw in place, a straight pass or a forward-facing tangent circle', () => {
    const stationary = atEntry()
    stationary.repeat(200, ZERO, { x: 0, y: 0.3, z: 0 })
    expect(stationary.evaluation?.metrics?.orbitProgressDegrees).toBe(0)
    expect(stationary.checkpointStates['orbit-entry']).toBeUndefined()
    const pass = atEntry()
    pass.repeat(160, { x: 4, y: 0, z: 0 })
    expect(pass.evaluation?.status).not.toBe('success')
    expect(pass.checkpointStates['orbit-lap-1']).toBeUndefined()
    const tangent = atEntry(DEFAULT_DRONE_CONFIG, Math.PI / 2)
    tangent.circle(400)
    expect(tangent.evaluation?.status).not.toBe('success')
    expect(tangent.checkpointStates['orbit-entry']).toBeUndefined()
  })
  it('handles the atan2 branch cut while refusing oscillatory partial-arc pumping', () => {
    const observer = atEntry()
    observer.circle(150)
    expect(observer.evaluation?.metrics?.orbitProgressDegrees).toBeGreaterThan(140)
    observer.circle(100, -1)
    expect(observer.evaluations.some(({ metrics }) => metrics?.orbitInterruptionReason === 8 && metrics.orbitEpisodeValid === 0)).toBe(true)
    for (let i = 0; i < 4; i += 1) { observer.circle(100); observer.circle(100, -1) }
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.checkpointStates['orbit-lap-1']).toBeUndefined()
  })
  it('allows a brief stop without counting unobserved movement across the invalid interval', () => {
    const observer = atEntry()
    observer.circle(120)
    const before = observer.evaluation!.metrics!.orbitProgressDegrees
    observer.repeat(4)
    expect(observer.evaluation?.metrics?.orbitProgressDegrees).toBe(before)
    observer.circle(5)
    expect(observer.evaluation?.metrics?.orbitProgressDegrees).toBeGreaterThan(before)
    expect(observer.evaluation?.metrics?.orbitProgressDegrees).toBeLessThan(before + 6)
    expect(observer.evaluation?.metrics?.orbitEpisodeValid).toBe(1)
  })
  it('subtracts reverse movement through a short invalid-heading gap instead of pumping the same arc', () => {
    const observer = atEntry(DEFAULT_DRONE_CONFIG, 79 * Math.PI / 180)
    observer.circle(30)
    const before = observer.evaluation!.metrics!.orbitProgressDegrees
    let angle = Math.atan2(observer.position.x, observer.position.z + 30)
    const advance = (count: number, orbitRate: number, yawRate: number): void => {
      for (let i = 0; i < count; i += 1) {
        angle += orbitRate * STEP
        observer.safe({ x: 15 * orbitRate * Math.cos(angle), y: 0, z: -15 * orbitRate * Math.sin(angle) }, { x: 0, y: yawRate, z: 0 })
      }
    }
    // Cross the 80° heading boundary briefly, travel backwards, then restore
    // the inward view before the 0.75 s allowance expires.
    advance(2, 0.3, 1.3)
    advance(7, -0.3, -0.3)
    advance(3, -0.3, -1.3)
    expect(observer.evaluation?.metrics?.orbitEpisodeValid).toBe(1)
    expect(observer.evaluation?.metrics?.orbitHeadingErrorDegrees).toBeLessThan(80)
    expect(observer.evaluation?.metrics?.orbitProgressDegrees).toBeLessThan(before - 5)
  })
  it('requires five fresh consecutive circles instead of stitching laps across an interruption', () => {
    const observer = atEntry()
    observer.circle(800)
    observer.repeat(20)
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 0, orbitInterrupted: 1, orbitInterruptionReason: 7, orbitProgressDegrees: 0 })
    const snapshot = observer.evaluation!.metrics!.interruptionOrbitProgressDegrees
    expect(snapshot).toBeGreaterThan(790)
    expect(observer.checkpointStates['orbit-lap-2']?.completed).toBe(true)
    observer.circle(1000)
    expect(observer.evaluation?.status).not.toBe('success')
    expect(observer.evaluation?.metrics?.interruptionOrbitProgressDegrees).toBe(snapshot)
    observer.circle(900)
    observer.depart()
    expect(observer.evaluation?.status).toBe('success')
  })
  it('keeps the first low-altitude snapshot during continued descent, then records a fresh failure after re-preparation', () => {
    const observer = atEntry()
    observer.circle(120)
    let angle = Math.atan2(observer.position.x, observer.position.z + 30)
    const move = (verticalSpeed: number, count = 1): void => {
      for (let i = 0; i < count; i += 1) {
        angle += 0.3 * STEP
        observer.safe({ x: 4.5 * Math.cos(angle), y: verticalSpeed, z: -4.5 * Math.sin(angle) }, { x: 0, y: 0.3, z: 0 })
      }
    }
    for (const verticalSpeed of [-2, -4, -6, -8]) move(verticalSpeed)
    move(-8, 16)
    for (const verticalSpeed of [-6, -4, -2]) move(verticalSpeed)
    // A continuous gentle descent crosses 1.5 m and keeps descending: the
    // original observation must not become the altitude of each new frame.
    while (observer.position.y >= 1.5) move(-2)
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 0, orbitInterruptionReason: 2 })
    const firstAltitude = observer.evaluation!.metrics!.interruptionAltitudeM
    const firstProgress = observer.evaluation!.metrics!.interruptionOrbitProgressDegrees
    expect(firstAltitude).toBeLessThan(1.5)
    move(-2, 3)
    expect(observer.evaluation?.metrics?.altitudeM).toBeLessThan(firstAltitude)
    expect(observer.evaluation?.metrics?.interruptionAltitudeM).toBe(firstAltitude)
    expect(observer.evaluation?.metrics?.interruptionOrbitProgressDegrees).toBe(firstProgress)
    move(0)
    move(2, 90)
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 1, orbitInterrupted: 0 })
    expect(observer.evaluation?.metrics?.interruptionAltitudeM).toBe(firstAltitude)
    observer.repeat(20)
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 0, orbitInterruptionReason: 7 })
    expect(observer.evaluation?.metrics?.interruptionAltitudeM).toBeGreaterThan(8)
    expect(observer.evaluation?.metrics?.interruptionAltitudeM).not.toBe(firstAltitude)
  })
  it('does not reuse an old lap or final checkpoint when current episode proof has been cleared', () => {
    const observer = atEntry()
    observer.circle(1815)
    observer.checkpointStates = checkpoints(8)
    observer.evaluation = { status: 'continue', metrics: { orbitEpisodeValid: 0, orbitCompleted: 0, orbitInterrupted: 1, orbitInterruptionReason: 3 } }
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
    observer.circle(100)
    observer.repeat(8)
    expect(observer.evaluation?.status).not.toBe('success')
    const stale = orbitLearningEvaluator.evaluate(observer.trace.at(-1)!, context({ checkpoints: checkpoints(9), previousEvaluation: { status: 'continue', metrics: { orbitEpisodeValid: 0, orbitCompleted: 1 } } }))
    expect(stale.status).toBe('failure')
    expect(stale.message).toContain('實際飛行證據')
  })
  it('cannot promote nine latched checkpoints with lap-only proof or incomplete recovery evidence', () => {
    const observer = atEntry()
    observer.circle(1815)
    observer.checkpointStates = checkpoints(9)
    const premature = observer.tick()
    expect(premature.status).toBe('failure')
    expect(premature.message).toContain('實際飛行證據')

    const complete = atEntry()
    complete.circle(1815)
    complete.depart()
    complete.repeat(2)
    const previous = complete.trace.at(-1)!
    const sample = { ...previous, timestampSeconds: previous.timestampSeconds + STEP, state: { ...previous.state,
      timeSeconds: previous.state.timeSeconds + STEP, stepIndex: previous.state.stepIndex + 1 } }
    const incompleteMetrics: readonly Readonly<Record<string, number>>[] = [
      { orbitExitQualifying: 0, orbitRecoveryQualifying: 1, orbitRecoveryDwellSeconds: 0.2 },
      { orbitExitQualifying: 1, orbitRecoveryQualifying: 0, orbitRecoveryDwellSeconds: 0.2 },
      { orbitExitQualifying: 1, orbitRecoveryQualifying: 1, orbitRecoveryDwellSeconds: 0.1 },
      { orbitExitQualifying: 1, orbitRecoveryQualifying: 1, orbitRecoveryDwellSeconds: 0.2, orbitCompletionRadiusM: complete.evaluation!.metrics!.orbitRadiusM },
    ]
    for (const incomplete of incompleteMetrics) {
      const result = orbitLearningEvaluator.evaluate(sample, context({ checkpoints: checkpoints(9), previousFlightSample: previous,
        previousEvaluation: { status: 'continue', metrics: { ...complete.evaluation!.metrics, ...incomplete } } }))
      expect(result.status).toBe('failure')
      expect(result.message).toContain('實際飛行證據')
    }
    expect(orbitLearningEvaluator.evaluate(sample, context({ checkpoints: checkpoints(9), previousEvaluation: complete.evaluation })).message).toContain('資料中斷')
  })
  it('rejects position/pose injection and timestamp or continuity resets', () => {
    const observer = atEntry()
    observer.circle(30)
    const previous = observer.trace.at(-1)!
    const current = { ...previous, timestampSeconds: previous.timestampSeconds + STEP, state: { ...previous.state,
      timeSeconds: previous.state.timeSeconds + STEP, stepIndex: previous.state.stepIndex + 1,
      positionM: { x: previous.state.positionM.x + previous.state.velocityMps.x * STEP,
        y: previous.state.positionM.y + previous.state.velocityMps.y * STEP,
        z: previous.state.positionM.z + previous.state.velocityMps.z * STEP } } }
    const observe = (sample: TrainingSample, extras: Partial<TrainingEvaluationContext> = {}) => orbitLearningEvaluator.evaluate(sample, context({ checkpoints: observer.checkpointStates,
      previousEvaluation: observer.evaluation, previousFlightSample: previous, ...extras }))
    expect(observe({ ...current, state: { ...current.state, positionM: { ...current.state.positionM, x: 20 } } }).message).toContain('位置跳躍')
    expect(observe({ ...current, state: { ...current.state, orientation: quaternionFromRotationVector({ x: 0, y: Math.PI, z: 0 }) } }).message).toContain('姿態變化')
    expect(observe({ ...current, timestampSeconds: previous.timestampSeconds }).message).toContain('資料中斷')
    expect(observe(current, { previousFlightSample: null }).message).toContain('資料中斷')
  })
  it('treats equivalent quaternion signs as the same observed pose', () => {
    const observer = atEntry()
    const q = observer.trace.at(-1)!.state.orientation
    const before = JSON.stringify(observer.evaluation)
    expect(observer.safe(ZERO, ZERO, { x: -q.x, y: -q.y, z: -q.z, w: -q.w }).status).toBe('continue')
    expect(before).toContain('orbitPhase')
    expect(observer.evaluation?.metrics?.angularConsistencyErrorDegrees).toBe(0)
  })
  it('preserves the actual radius snapshot after a sustained wide-radius interruption', () => {
    const observer = atEntry()
    observer.circle(90)
    const target = createOrbitTarget(references()[0].positionM, 0)
    for (let i = 0; i < 100; i += 1) {
      const x = observer.position.x - target.x
      const z = observer.position.z - target.z
      const radius = Math.hypot(x, z)
      observer.safe({ x: (x * 5 + z * 4.5) / radius, y: 0, z: (z * 5 - x * 4.5) / radius }, { x: 0, y: 4.5 / radius, z: 0 })
    }
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 0, orbitInterruptionReason: 4, orbitProgressDegrees: 0 })
    const interruptedRadius = observer.evaluation!.metrics!.interruptionOrbitRadiusM
    expect(interruptedRadius).toBeGreaterThan(30)
    expect(interruptedRadius).toBeLessThan(36)
    observer.repeat(10)
    expect(observer.evaluation?.metrics?.interruptionOrbitRadiusM).toBe(interruptedRadius)
  })
  it('reports height rather than tangent loss when the orbit climbs above the broad altitude band', () => {
    const observer = atEntry()
    observer.circle(90)
    // Keep moving around the target while climbing; a vertical stop would
    // instead truthfully report lost lateral movement before reaching 20 m.
    let angle = Math.atan2(observer.position.x, observer.position.z + 30)
    for (let i = 0; i < 70; i += 1) {
      angle += 0.3 * STEP
      observer.safe({ x: 4.5 * Math.cos(angle), y: 5, z: -4.5 * Math.sin(angle) }, { x: 0, y: 0.3, z: 0 })
    }
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 0, orbitInterruptionReason: 5 })
    expect(observer.evaluation?.metrics?.interruptionAltitudeM).toBeGreaterThan(20)
  })
  it('records an inward-heading failure without treating real orbital travel as valid proof', () => {
    const observer = atEntry()
    observer.circle(30)
    let angle = Math.atan2(observer.position.x, observer.position.z + 30)
    for (let i = 0; i < 85; i += 1) {
      angle += 0.3 * STEP
      observer.safe({ x: 4.5 * Math.cos(angle), y: 0, z: -4.5 * Math.sin(angle) }, { x: 0, y: 0.8, z: 0 })
    }
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 0, orbitInterruptionReason: 6, orbitProgressDegrees: 0 })
    expect(observer.evaluation?.metrics?.interruptionOrbitHeadingErrorDegrees).toBeGreaterThan(80)
  })
  it('records the actual excessive tilt before clearing current lap proof', () => {
    const observer = atEntry()
    observer.circle(30)
    let angle = Math.atan2(observer.position.x, observer.position.z + 30)
    for (let i = 0; i < 60; i += 1) {
      angle += 0.3 * STEP
      observer.safe({ x: 4.5 * Math.cos(angle), y: 0, z: -4.5 * Math.sin(angle) }, { x: 0, y: 0, z: 0.7 })
    }
    expect(observer.evaluation?.metrics).toMatchObject({ orbitEpisodeValid: 0, orbitInterruptionReason: 9, orbitProgressDegrees: 0 })
    expect(observer.evaluation?.metrics?.interruptionTiltDegrees).toBeGreaterThan(80)
  })
  it('requires real ground telemetry and explicit arm; practice remains untimed', () => {
    const current = atEntry().trace.at(-1)!
    expect(orbitLearningEvaluator.evaluate(current, context()).checkpointIds).toBeUndefined()
    expect(orbitLearningEvaluator.evaluate({ ...current, groundContact: undefined }, context()).status).toBe('failure')
    expect(orbitLearningEvaluator.evaluate({ ...current, armed: false }, context()).status).toBe('failure')
    expect(orbitLearningEvaluator.evaluate({ ...current, armed: undefined }, context()).status).toBe('continue')
    expect(orbitLearningEvaluator.evaluate(current, context({ mode: 'practice', elapsedSeconds: 301 })).status).toBe('continue')
    expect(orbitLearningEvaluator.evaluate(current, context({ mode: 'challenge', elapsedSeconds: 301 })).message).toContain('逾時')
  })
})
