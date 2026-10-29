import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { integrateBodyAngularVelocity, quaternionFromRotationVector, rotateVectorByQuaternion, type Quaternion } from '../math/quaternion'
import { calculateFpvCameraTransform } from '../rendering/camera'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import { createReverseOrbitTarget, measureReverseOrbitView, REVERSE_ORBIT_COMPLETION_DEGREES, REVERSE_ORBIT_LEARNING_CONTENT, REVERSE_ORBIT_LESSON, REVERSE_ORBIT_PHASE_IDS, REVERSE_ORBIT_REQUIRED_LAPS, reverseOrbitEvaluator } from './reverseOrbit'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

const STEP = 0.05
const ZERO = { x: 0, y: 0, z: 0 }
function references(config = DEFAULT_DRONE_CONFIG) {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [{ id: 'training-launch', kind: 'spawn', positionM: launch }, { id: 'landing-surface', kind: 'ground', positionM: landing }]
}
function checkpoints(phase = 0): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(REVERSE_ORBIT_PHASE_IDS.slice(0, phase).map((id) => [id, { id, completed: true, completedAtSeconds: 0, metrics: {} }]))
}
function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: REVERSE_ORBIT_LESSON, mode: 'practice', elapsedSeconds: 0, trajectory: [], checkpoints: {}, sceneReferences: references(), ...overrides }
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
  public constructor(public readonly config = DEFAULT_DRONE_CONFIG, yawOffset = 0, public readonly camera = { fpvMountAngleDegrees: 10, fpvFovDegrees: 90 }) {
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
    const sample: TrainingSample = { timestampSeconds, armed: true, fpvCamera: { ...this.camera }, normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
      groundContact: { heightM: this.config.ground.heightM, supportOffsetM,
        touching: this.position.y - this.config.ground.heightM - supportOffsetM - DRONE_GROUND_CLEARANCE_M < 1e-8 },
      state: { ...createInitialDroneState(this.config, this.position, this.orientation), velocityMps: velocity,
        angularVelocityBodyRadPerSec: rate, timeSeconds: timestampSeconds, stepIndex: this.trace.length + 1 } }
    const previous = this.trace.at(-1)
    const result = reverseOrbitEvaluator.evaluate(sample, context({ elapsedSeconds: timestampSeconds,
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
  public circle(degrees: number, direction = 1, omegaMagnitude = 1.3): void {
    const omega = direction * omegaMagnitude
    const count = Math.ceil(Math.abs(degrees * Math.PI / 180 / omega / STEP))
    for (let i = 0; i < count; i += 1) {
      this.circleAngle += omega * STEP
      this.safe({ x: 10 * omega * Math.cos(this.circleAngle), y: 0, z: -10 * omega * Math.sin(this.circleAngle) }, { x: 0, y: omega * Math.cos(Math.PI / 3), z: -omega * Math.sin(Math.PI / 3) })
    }
  }
  public flatten(): void {
    this.safe()
    this.repeat(40, ZERO, { x: -Math.PI / 6, y: 0, z: 0 })
    this.safe()
  }
  public depart(distance = 5, speed = 2): void {
    const target = createReverseOrbitTarget(createTrainingFieldAnchors(this.config).launch, this.config.ground.heightM)
    const x = this.position.x - target.x
    const z = this.position.z - target.z
    const radius = Math.hypot(x, z)
    this.repeat(Math.ceil(distance / speed / STEP), { x: x / radius * speed, y: 0, z: z / radius * speed })
  }
}
function atEntry(config = DEFAULT_DRONE_CONFIG, yawOffset = 0, camera = { fpvMountAngleDegrees: 10, fpvFovDegrees: 90 }): Observer {
  const observer = new Observer(config, yawOffset, camera)
  observer.safe()
  observer.repeat(40, { x: 0, y: 5, z: 0 })
  observer.safe()
  observer.repeat(80, { x: 0, y: 0, z: -5 })
  observer.safe()
  expect(observer.evaluation?.metrics?.reverseOrbitPhase).toBe(2)
  observer.repeat(40, ZERO, { x: 0, y: Math.PI / 2, z: 0 })
  observer.safe()
  observer.repeat(40, ZERO, { x: Math.PI / 6, y: 0, z: 0 })
  observer.safe()
  return observer
}

describe('L16 upward-view three-circle crane orbit', () => {
  it('offers seven Chinese ground-start stages and a separate high crane reference', () => {
    expect(REVERSE_ORBIT_LESSON).toMatchObject({ id: 'reverse-orbit', title: '倒刷鍋', priority: 4.5 })
    expect(REVERSE_ORBIT_LEARNING_CONTENT).toMatchObject({ code: 'L16', prerequisiteIds: ['orbit'] })
    expect(REVERSE_ORBIT_LESSON.checkpoints.map(({ id }) => id)).toEqual(REVERSE_ORBIT_PHASE_IDS)
    expect(REVERSE_ORBIT_LESSON.setup.sceneReferenceIds).toEqual(['training-launch', 'landing-surface', 'reverse-orbit-zone'])
    expect(REVERSE_ORBIT_LESSON.setup.spawnPositionM).toBeUndefined()
    expect(REVERSE_ORBIT_REQUIRED_LAPS).toBe(3)
    expect(REVERSE_ORBIT_COMPLETION_DEGREES).toBe(1080)
    expect(createReverseOrbitTarget({ x: 6, y: 9.05, z: -3 }, 9)).toEqual({ x: 6, y: 54, z: -33 })
  })
  it.each([1, -1])('accepts three genuine upward-view circles in direction %s and an actual controlled exit', (direction) => {
    const observer = atEntry()
    observer.circle(1120, direction)
    expect(observer.evaluation?.metrics).toMatchObject({ reverseOrbitPhase: 6, reverseOrbitCompleted: 1,
      reverseOrbitCompletedLaps: 3, reverseOrbitEpisodeValid: 1, reverseOrbitDirection: -direction })
    expect(observer.evaluation?.metrics?.reverseOrbitViewElevationDegrees).toBeGreaterThan(65)
    expect(observer.evaluation?.metrics?.reverseOrbitTargetViewErrorDegrees).toBeLessThan(45)
    expect(observer.evaluation?.status).toBe('continue')
    observer.flatten()
    observer.repeat(8)
    expect(observer.evaluation?.status).toBe('continue')
    observer.depart()
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics).toMatchObject({ reverseOrbitPhase: 7, reverseOrbitExitQualifying: 1,
      reverseOrbitRecoveryQualifying: 1 })
    expect(Object.keys(observer.checkpointStates)).toEqual(REVERSE_ORBIT_PHASE_IDS)
  })
  it('requires full 360-degree laps and all three laps before any exit can finish', () => {
    const observer = atEntry()
    observer.circle(355)
    expect(observer.evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(0)
    expect(observer.checkpointStates['reverse-orbit-lap-1']).toBeUndefined()
    observer.circle(30)
    expect(observer.evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(1)
    observer.circle(360)
    expect(observer.evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(2)
    expect(observer.evaluation?.status).toBe('continue')
    observer.flatten()
    observer.depart()
    expect(observer.evaluation?.status).not.toBe('success')
  })
  it('does not treat flat normal-orbit flight, looking at unrelated sky or inverted attitude as upward crane orbit', () => {
    const base = atEntry().trace.at(-1)!
    const target = createReverseOrbitTarget({ x: 0, y: 0, z: 0 }, 0)
    const flat = measureReverseOrbitView({ positionM: base.state.positionM,
      orientation: quaternionFromRotationVector(ZERO) }, target, { fpvMountAngleDegrees: 10, fpvFovDegrees: 90 })
    expect(flat.reverseOrbitViewElevationDegrees).toBeCloseTo(10)
    const unrelated = measureReverseOrbitView({ positionM: base.state.positionM,
      orientation: quaternionFromRotationVector({ x: 0.9, y: 0, z: 0 }) },
    { x: 1000, y: 45, z: 0 }, { fpvMountAngleDegrees: 10, fpvFovDegrees: 90 })
    expect(unrelated.reverseOrbitViewElevationDegrees).toBeGreaterThan(35)
    expect(unrelated.reverseOrbitTargetViewErrorDegrees).toBeGreaterThan(45)
    const observer = atEntry()
    observer.repeat(40, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: Math.PI / 2 })
    observer.safe({ x: 1, y: 0, z: 0 })
    expect(observer.evaluation?.metrics?.reverseOrbitEpisodeValid).toBe(0)
    expect(observer.evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(0)
  })
  it('does not credit stationary upward yawing as a circle', () => {
    const observer = atEntry()
    observer.repeat(200, ZERO, { x: 0, y: 1, z: 0 })
    expect(observer.evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(0)
    expect(observer.evaluation?.status).toBe('continue')
  })
  it('measures the actual camera mount, optical offset and FOV rather than assuming the beginner setting', () => {
    const base = atEntry().trace.at(-1)!
    const target = createReverseOrbitTarget(references()[0].positionM, 0)
    const a = measureReverseOrbitView(base.state, target, { fpvMountAngleDegrees: 10, fpvFovDegrees: 90 })
    const b = measureReverseOrbitView(base.state, target, { fpvMountAngleDegrees: 20, fpvFovDegrees: 45 })
    expect(a.reverseOrbitViewElevationDegrees).toBeCloseTo(70, 5)
    expect(b.reverseOrbitViewElevationDegrees).toBeCloseTo(80, 5)
    expect(a.reverseOrbitViewLimitDegrees).toBe(45)
    expect(b.reverseOrbitViewLimitDegrees).toBe(22.5)
    expect(a.reverseOrbitTargetViewErrorDegrees - b.reverseOrbitTargetViewErrorDegrees).toBeCloseTo(10, 2)
    const rendered = calculateFpvCameraTransform(base.state, { fpvMountAngleDegrees: 20 })
    const renderedForward = rotateVectorByQuaternion(rendered.orientation, { x: 0, y: 0, z: -1 })
    const delta = { x: target.x - rendered.position.x, y: target.y - rendered.position.y, z: target.z - rendered.position.z }
    const renderedError = Math.acos((renderedForward.x * delta.x + renderedForward.y * delta.y + renderedForward.z * delta.z)
      / Math.hypot(delta.x, delta.y, delta.z)) * 180 / Math.PI
    expect(b.reverseOrbitTargetViewErrorDegrees).toBeCloseTo(renderedError, 10)
    const observer = atEntry(DEFAULT_DRONE_CONFIG, 0, { fpvMountAngleDegrees: 50, fpvFovDegrees: 45 })
    observer.circle(1120)
    expect(observer.evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(3)
  })
  it('requires real outward distance and current outward speed after all three laps', () => {
    const observer = atEntry()
    observer.circle(1120)
    observer.flatten()
    observer.depart(2)
    expect(observer.evaluation?.metrics?.reverseOrbitExitDistanceM).toBeLessThan(3)
    observer.depart(2, 0.25)
    expect(observer.evaluation?.metrics?.reverseOrbitExitDistanceM).toBeGreaterThan(3)
    expect(observer.evaluation?.metrics?.reverseOrbitRecoveryDwellSeconds).toBe(0)
    observer.depart(1, 2)
    expect(observer.evaluation?.status).toBe('success')
  })
  it('keeps historical milestone checks separate from the same-episode three-circle proof', () => {
    const observer = atEntry()
    observer.circle(400)
    const sample = observer.trace.at(-1)!
    const next = { ...sample, timestampSeconds: sample.timestampSeconds + STEP,
      state: { ...sample.state, timeSeconds: sample.state.timeSeconds + STEP, stepIndex: sample.state.stepIndex + 1,
        positionM: { x: sample.state.positionM.x + sample.state.velocityMps.x * STEP,
          y: sample.state.positionM.y, z: sample.state.positionM.z + sample.state.velocityMps.z * STEP },
        orientation: integrateBodyAngularVelocity(sample.state.orientation, sample.state.angularVelocityBodyRadPerSec, STEP) } }
    const evaluation = reverseOrbitEvaluator.evaluate(next, context({ checkpoints: checkpoints(7), previousFlightSample: sample,
      previousEvaluation: observer.evaluation }))
    expect(evaluation.status).toBe('failure')
    expect(evaluation.message).toContain('實際飛行證據')
  })
  it('freezes the first low-height interruption and demands a new complete group after recovery', () => {
    const observer = atEntry()
    observer.circle(400)
    observer.repeat(35, { x: 0, y: -5, z: 0 })
    expect(observer.evaluation?.metrics).toMatchObject({ reverseOrbitEpisodeValid: 0, reverseOrbitCompletedLaps: 0, reverseOrbitInterrupted: 1 })
    const snapshot = Object.fromEntries(Object.entries(observer.evaluation!.metrics!).filter(([key]) => key.startsWith('interruption')))
    observer.repeat(5)
    expect(Object.fromEntries(Object.entries(observer.evaluation!.metrics!).filter(([key]) => key.startsWith('interruption')))).toEqual(snapshot)
    expect(observer.checkpointStates['reverse-orbit-lap-1']?.completed).toBe(true)
    expect(observer.evaluation?.status).not.toBe('success')
  })
  it('subtracts reversal and cannot accumulate a circle by repeatedly scrubbing the same arc', () => {
    const observer = atEntry()
    for (let i = 0; i < 4; i += 1) {
      observer.circle(30)
      observer.circle(30, -1)
    }
    expect(observer.evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(0)
    expect(observer.evaluation?.metrics?.reverseOrbitProgressDegrees).toBeLessThan(70)
  })
  it('does not credit an unobserved arc across a brief stop', () => {
    const observer = atEntry()
    observer.circle(100)
    observer.repeat(5)
    const held = observer.evaluation!.metrics!.reverseOrbitProgressDegrees
    observer.circle(30)
    expect(observer.evaluation?.metrics?.reverseOrbitEpisodeValid).toBe(1)
    expect(observer.evaluation!.metrics!.reverseOrbitProgressDegrees - held).toBeLessThan(35)
    expect(observer.evaluation!.metrics!.reverseOrbitProgressDegrees - held).toBeGreaterThan(15)
  })
  it('requires three fresh circles after interruption instead of stitching old and new laps', () => {
    const observer = atEntry()
    observer.circle(400)
    observer.repeat(20)
    expect(observer.evaluation?.metrics).toMatchObject({ reverseOrbitEpisodeValid: 0, reverseOrbitInterrupted: 1,
      reverseOrbitCompletedLaps: 0, reverseOrbitProgressDegrees: 0 })
    expect(observer.checkpointStates['reverse-orbit-lap-1']?.completed).toBe(true)
    observer.circle(800)
    expect(observer.evaluation?.status).toBe('continue')
    expect(observer.evaluation?.metrics?.reverseOrbitCompleted).toBe(0)
    observer.circle(400)
    observer.flatten()
    observer.depart()
    expect(observer.evaluation?.status).toBe('success')
  })
  it('resolves raised ground and shifted launch separately from the crane height', () => {
    const config = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 8 },
      spawnPositionM: { x: 6, y: 40, z: -3 } }
    const observer = atEntry(config)
    observer.circle(1120)
    observer.flatten()
    observer.depart()
    expect(observer.evaluation?.status).toBe('success')
    expect(observer.evaluation?.metrics?.altitudeM).toBeCloseTo(10.05, 1)
  })
  it('feeds the real training session one stage at a time without RC commands acting as proof', () => {
    const observer = atEntry()
    observer.circle(1120)
    observer.flatten()
    observer.depart()
    const session = new TrainingSession({ lessons: [REVERSE_ORBIT_LESSON], initialLessonId: 'reverse-orbit', countdownDurationSeconds: 0, sceneReferences: references() })
    session.selectLesson('reverse-orbit')
    session.start(0)
    session.tick(0)
    for (const sample of observer.trace) {
      session.consumeSample(sample)
      if (session.getState().phase === 'SUCCESS') break
    }
    expect(session.getState().result).toMatchObject({ outcome: 'SUCCESS', completedCheckpoints: 7, totalCheckpoints: 7 })
    expect(observer.trace.every(({ normalizedInput }) => normalizedInput?.yaw === 0 && normalizedInput?.roll === 0)).toBe(true)
  })
  it('rejects missing, nonfinite, unsupported and changed camera metadata safely', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    for (const camera of [undefined, { fpvMountAngleDegrees: NaN, fpvFovDegrees: 90 },
      { fpvMountAngleDegrees: 10, fpvFovDegrees: 0 }, { fpvMountAngleDegrees: 100, fpvFovDegrees: 90 }]) {
      expect(reverseOrbitEvaluator.evaluate({ ...sample, fpvCamera: camera }, context()).status).toBe('failure')
    }
    const changed = { ...sample, timestampSeconds: sample.timestampSeconds + STEP,
      fpvCamera: { fpvMountAngleDegrees: 20, fpvFovDegrees: 90 },
      state: { ...sample.state, timeSeconds: sample.state.timeSeconds + STEP, stepIndex: sample.state.stepIndex + 1 } }
    expect(reverseOrbitEvaluator.evaluate(changed, context({ previousFlightSample: sample })).message).toContain('鏡頭設定已改變')
  })
  it('rejects broken clocks, teleportation, pose jumps, invalid contact and missing ground evidence', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    const next: TrainingSample = { ...sample, timestampSeconds: sample.timestampSeconds + STEP,
      state: { ...sample.state, timeSeconds: sample.state.timeSeconds + STEP, stepIndex: sample.state.stepIndex + 1 } }
    const ctx = context({ checkpoints: observer.checkpointStates, previousFlightSample: sample, previousEvaluation: observer.evaluation })
    for (const bad of [
      { ...next, timestampSeconds: sample.timestampSeconds },
      { ...next, state: { ...next.state, timeSeconds: sample.state.timeSeconds } },
      { ...next, state: { ...next.state, positionM: { ...next.state.positionM, x: 20 } } },
      { ...next, state: { ...next.state, orientation: quaternionFromRotationVector({ x: 0, y: 1, z: 0 }) } },
      { ...next, groundContact: { ...next.groundContact!, touching: true } },
    ]) expect(reverseOrbitEvaluator.evaluate(bad, ctx).status).toBe('failure')
    expect(reverseOrbitEvaluator.evaluate(sample, context()).checkpointIds).toBeUndefined()
    expect(reverseOrbitEvaluator.evaluate({ ...next, armed: false }, ctx).status).toBe('failure')
    expect(reverseOrbitEvaluator.evaluate({ ...next, state: { ...next.state, crashed: true } }, ctx).status).toBe('failure')
    expect(reverseOrbitEvaluator.evaluate({ ...next, armed: undefined }, ctx).status).toBe('continue')
  })
  it('accepts quaternion sign equivalence while ignoring unsupported stick claims', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    const next: TrainingSample = { ...sample, timestampSeconds: sample.timestampSeconds + STEP,
      normalizedInput: { roll: 1, pitch: 1, yaw: 1, throttle: 1 },
      state: { ...sample.state, timeSeconds: sample.state.timeSeconds + STEP, stepIndex: sample.state.stepIndex + 1,
        orientation: { x: -sample.state.orientation.x, y: -sample.state.orientation.y, z: -sample.state.orientation.z, w: -sample.state.orientation.w } } }
    expect(reverseOrbitEvaluator.evaluate(next, context({ checkpoints: observer.checkpointStates, previousFlightSample: sample,
      previousEvaluation: observer.evaluation })).status).toBe('continue')
  })
  it('has unlimited guided practice and a separate challenge time limit', () => {
    const observer = atEntry()
    const sample = observer.trace.at(-1)!
    const ctx = context({ elapsedSeconds: 10000, checkpoints: observer.checkpointStates })
    expect(reverseOrbitEvaluator.evaluate(sample, ctx).status).toBe('continue')
    expect(reverseOrbitEvaluator.evaluate(sample, { ...ctx, mode: 'challenge' }).message).toContain('逾時')
  })
})
