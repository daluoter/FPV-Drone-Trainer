import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig } from '../drone'
import { IDENTITY_QUATERNION, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import { createSquareRouteTargets, SQUARE_ROUTE_LESSON, SQUARE_ROUTE_TARGET_IDS, squareRouteEvaluator } from './squareRoute'
import type { TrainingCheckpointState, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'

const GROUND_COM = droneGroundSupport(DEFAULT_DRONE_CONFIG, IDENTITY_QUATERNION).supportOffsetM + DRONE_GROUND_CLEARANCE_M
const RIGHT_HEADING = quaternionFromRotationVector({ x: 0, y: -Math.PI / 2, z: 0 })
const LEFT_HEADING = quaternionFromRotationVector({ x: 0, y: Math.PI / 2, z: 0 })

function references(config = DEFAULT_DRONE_CONFIG): readonly TrainingSceneReference[] {
  const { launch, landing } = createTrainingFieldAnchors(config)
  return [
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
  ]
}

function sample(index: number, positionM: Vector3, velocityMps: Vector3 = { x: 0, y: 0, z: 0 }, orientation: Quaternion = IDENTITY_QUATERNION, config = DEFAULT_DRONE_CONFIG): TrainingSample {
  const timestampSeconds = (index + 1) * 0.1
  const supportOffsetM = droneGroundSupport(config, orientation).supportOffsetM
  return {
    timestampSeconds, armed: true,
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
    groundContact: { heightM: config.ground.heightM, supportOffsetM,
      touching: positionM.y <= config.ground.heightM + supportOffsetM + DRONE_GROUND_CLEARANCE_M + 1e-8 },
    state: { ...createInitialDroneState(config, positionM), velocityMps, orientation, timeSeconds: timestampSeconds, stepIndex: index + 1 },
  }
}

function checkpoints(targetCount = 0): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(['square-ground', 'square-liftoff', ...SQUARE_ROUTE_TARGET_IDS.slice(0, targetCount)].map((id) => [id,
    { id, completed: true, completedAtSeconds: 0.1, metrics: {} },
  ]))
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: SQUARE_ROUTE_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: checkpoints(), sceneReferences: references(), ...overrides }
}

/** Analytic observer fixture; separate demo tests use real RC/physical integration. */
function completeTrace(config = DEFAULT_DRONE_CONFIG): readonly TrainingSample[] {
  let position = { ...references(config)[0].positionM }
  const trace: TrainingSample[] = [sample(0, position, undefined, undefined, config)]
  const move = (end: Vector3, orientation: Quaternion, duration = 4): void => {
    const start = position
    const count = Math.round(duration * 10)
    for (let index = 1; index <= count; index += 1) {
      const fraction = index / count
      const curve = fraction * fraction * (3 - 2 * fraction)
      const rate = 6 * fraction * (1 - fraction) / duration
      trace.push(sample(trace.length, {
        x: start.x + (end.x - start.x) * curve,
        y: start.y + (end.y - start.y) * curve,
        z: start.z + (end.z - start.z) * curve,
      }, { x: (end.x - start.x) * rate, y: (end.y - start.y) * rate, z: (end.z - start.z) * rate }, orientation, config))
    }
    position = end
  }
  move({ ...position, y: config.ground.heightM + 3 }, IDENTITY_QUATERNION, 5)
  for (const target of createSquareRouteTargets(position, config.ground.heightM)) {
    const forward = target.headingForward
    move(target.positionM, quaternionFromRotationVector({ x: 0, y: Math.atan2(-forward.x, -forward.z), z: 0 }))
  }
  return trace
}

function run(trace: readonly TrainingSample[], mode: 'practice' | 'challenge' = 'practice', config = DEFAULT_DRONE_CONFIG) {
  const session = new TrainingSession({
    lessons: [SQUARE_ROUTE_LESSON], initialLessonId: 'square-route', countdownDurationSeconds: 0, sceneReferences: references(config),
    attemptContext: { rulesVersion: 5, physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}', inputSource: 'keyboard', mode, assistance: 'none' },
  })
  session.start(0)
  session.tick(0)
  for (const current of trace) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

describe('ground-start four-leg square route lesson', () => {
  it.each(['practice', 'challenge'] as const)('completes all ten ordered %s steps and closes the four-leg route without landing', (mode) => {
    const state = run(completeTrace(), mode)
    expect(state.phase, JSON.stringify(state.lastEvaluation)).toBe('SUCCESS')
    expect(state.result?.completedCheckpoints).toBe(10)
    expect(state.result?.score).toBe(100)
    expect(state.result?.metrics.squarePhase).toBe(10)
    expect(state.result?.metrics.squareTargetsCompleted).toBe(8)
    expect(state.result?.metrics.squareLegsCompleted).toBe(4)
    expect(state.result?.metrics.groundTouching).toBe(0)
    expect(Object.values(state.checkpoints).every(({ completed }) => completed)).toBe(true)
    const final = state.previousSample!.state.positionM
    expect(Math.hypot(final.x, final.z)).toBeLessThan(1.9)
    expect(final.y).toBeCloseTo(3)
  })

  it('requires actual ground preparation and liftoff rather than stick activity or an airborne start', () => {
    const ground = run(Array.from({ length: 30 }, (_, index) => ({ ...sample(index, { x: 0, y: GROUND_COM, z: 0 }),
      normalizedInput: { roll: 1, pitch: -1, yaw: 1, throttle: 1 } })))
    expect(ground.phase).toBe('ACTIVE')
    expect(ground.checkpoints['square-ground']?.completed).toBe(true)
    expect(ground.checkpoints['square-liftoff']?.completed).toBe(false)
    const air = run([sample(0, { x: 0, y: 3, z: 0 })])
    expect(air.checkpoints['square-ground']?.completed).toBe(false)
    expect(air.lastEvaluation?.hint).toContain('實際接地')
  })

  it('cannot finish by taking off above the final zone or yawing in place', () => {
    const lift = completeTrace().slice(0, 51)
    const yaw = Array.from({ length: 80 }, (_, index) => sample(lift.length + index, { x: 0, y: 3, z: 0 }, undefined,
      quaternionFromRotationVector({ x: 0, y: index * 0.1, z: 0 })))
    const state = run([...lift, ...yaw])
    expect(state.phase).toBe('ACTIVE')
    expect(state.checkpoints['square-liftoff']?.completed).toBe(true)
    expect(state.lastEvaluation?.metrics?.squareTargetsCompleted).toBe(0)
    expect(state.checkpoints['square-finish']?.completed).toBe(false)
  })

  it('does not accept a straight out-and-back shortcut when the other legs are missing', () => {
    const straight = completeTrace().map((pose) => ({ ...pose, state: { ...pose.state,
      positionM: { ...pose.state.positionM, x: 0 }, velocityMps: { ...pose.state.velocityMps, x: 0 } } }))
    const state = run(straight)
    expect(state.phase).toBe('ACTIVE')
    expect(state.lastEvaluation?.metrics?.squareTargetsCompleted).toBe(2)
    expect(state.lastEvaluation?.metrics?.squareLegsCompleted).toBe(1)
    expect(state.checkpoints['square-finish']?.completed).toBe(false)
  })

  it('waits for the next ordered goal and allows a missed corner to be retried without restarting', () => {
    const wrong = squareRouteEvaluator.evaluate(sample(0, { x: 0, y: 3, z: 0 }, undefined, LEFT_HEADING), context())
    expect(wrong.checkpointIds).toEqual([])
    expect(wrong.metrics?.squareTargetIndex).toBe(0)
    const corner = createSquareRouteTargets({ x: 0, y: 0, z: 0 }, 0)[1]
    const diagonal = quaternionFromRotationVector({ x: 0, y: -Math.PI / 4, z: 0 })
    const missed = squareRouteEvaluator.evaluate(sample(0, { ...corner.positionM, y: 6 }, undefined, diagonal), context({ checkpoints: checkpoints(1) }))
    expect(missed.recovery).toBeUndefined()
    expect(missed.metrics?.squareTargetsCompleted).toBe(1)
    const retry = squareRouteEvaluator.evaluate(sample(1, corner.positionM, undefined, diagonal), context({ checkpoints: checkpoints(1) }))
    expect(retry.checkpointIds).toEqual(['square-corner-1'])
    expect(retry.metrics?.squareLeg).toBe(2)
    expect(retry.metrics?.squareLegsCompleted).toBe(1)
    expect(retry.metrics?.squarePhase).toBe(4)
    expect(retry.metrics?.squareTargetIndex).toBe(2)
  })

  it('counts a fast physical segment through the current sphere with both endpoints outside', () => {
    const previous = sample(0, { x: 0, y: 3, z: -2 }, { x: 0, y: 0, z: -40 })
    const current = sample(2, { x: 0, y: 3, z: -10 }, { x: 0, y: 0, z: -40 })
    const evaluation = squareRouteEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).toEqual(['square-leg-1'])
    expect(evaluation.metrics?.velocityConsistencyErrorM).toBeCloseTo(0)
  })

  it('shows body-relative next-goal offsets separately from fixed field axes and blocks an incorrect heading', () => {
    const bodyForward = squareRouteEvaluator.evaluate(sample(0, { x: 0, y: 3, z: -12 }, undefined, RIGHT_HEADING), context({ checkpoints: checkpoints(2) }))
    expect(bodyForward.metrics?.targetForwardM).toBeCloseTo(6)
    expect(bodyForward.metrics?.targetRightM).toBeCloseTo(0)
    const sideways = squareRouteEvaluator.evaluate(sample(0, { x: 0, y: 3, z: -6 }, undefined, RIGHT_HEADING), context())
    expect(sideways.checkpointIds).toEqual([])
    expect(sideways.metrics?.headingErrorDegrees).toBeCloseTo(90)
    expect(sideways.hint).toContain('70°')
  })

  it('retains completed targets on non-crash ground contact, excludes ground sliding and permits local takeoff', () => {
    const diagonal = quaternionFromRotationVector({ x: 0, y: -Math.PI / 4, z: 0 })
    const contact = squareRouteEvaluator.evaluate(sample(0, { x: 0, y: GROUND_COM, z: -12 }, undefined, diagonal), context({ checkpoints: checkpoints(1) }))
    expect(contact.checkpointIds).toEqual([])
    expect(contact.metrics?.squareTargetsCompleted).toBe(1)
    expect(contact.recovery).toBeUndefined()
    expect(contact.hint).toContain('就地再次起飛')
    const lifted = squareRouteEvaluator.evaluate(sample(1, { x: 0, y: 3, z: -12 }, undefined, diagonal), context({ checkpoints: checkpoints(1) }))
    expect(lifted.checkpointIds).toEqual(['square-corner-1'])
  })

  it('shares immutable target positions on raised ground independently of high free-flight spawn', () => {
    const config: DroneConfig = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 10 }, spawnPositionM: { x: 5, y: 25, z: -3 } }
    const launch = references(config)[0].positionM
    const before = JSON.stringify({ config, launch })
    const targets = createSquareRouteTargets(launch, 10)
    expect(targets[0].positionM).toEqual({ x: 5, y: 13, z: -9 })
    expect(targets[3].positionM).toEqual({ x: 17, y: 13, z: -15 })
    expect(targets.at(-1)?.positionM).toEqual({ x: 5, y: 13, z: -3 })
    expect(targets.map(({ id }) => id)).toEqual(SQUARE_ROUTE_TARGET_IDS)
    expect(Object.isFrozen(targets)).toBe(true)
    expect(targets.every((target) => Object.isFrozen(target) && Object.isFrozen(target.positionM) && Object.isFrozen(target.headingForward))).toBe(true)
    expect(JSON.stringify({ config, launch })).toBe(before)
    expect(run(completeTrace(config), 'practice', config).phase).toBe('SUCCESS')
  })

  it('keeps crashes, disarm, invalid ground/reference data and non-finite states terminal', () => {
    const valid = sample(0, { x: 0, y: 3, z: -6 })
    for (const pose of [
      { ...valid, state: { ...valid.state, crashed: true } },
      { ...valid, armed: false },
      { ...valid, timestampSeconds: Number.NaN },
      { ...valid, groundContact: undefined },
      { ...valid, groundContact: { ...valid.groundContact!, heightM: 5 } },
      { ...valid, groundContact: { ...valid.groundContact!, touching: true } },
      { ...valid, state: { ...valid.state, positionM: { x: Number.NaN, y: 3, z: 0 } } },
    ]) {
      const evaluation = squareRouteEvaluator.evaluate(pose, context({ mode: 'practice' }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
    expect(squareRouteEvaluator.evaluate(valid, context({ sceneReferences: [] })).status).toBe('failure')
    expect(squareRouteEvaluator.evaluate(valid, context({ elapsedSeconds: Number.NaN })).status).toBe('failure')
    expect(squareRouteEvaluator.evaluate({ ...valid, armed: undefined }, context()).status).toBe('continue')
  })

  it('rejects telemetry gaps, reset clocks, duplicate physics steps and impossible position changes in practice', () => {
    const previous = sample(0, { x: 0, y: 3, z: 0 })
    const current = sample(1, { x: 0, y: 3, z: 0 })
    for (const pose of [
      { ...current, timestampSeconds: previous.timestampSeconds },
      { ...current, timestampSeconds: 1, state: { ...current.state, timeSeconds: 1 } },
      { ...current, state: { ...current.state, timeSeconds: previous.state.timeSeconds } },
      { ...current, state: { ...current.state, stepIndex: previous.state.stepIndex } },
      { ...current, state: { ...current.state, positionM: { x: 20, y: 3, z: 0 } } },
    ]) {
      const evaluation = squareRouteEvaluator.evaluate(pose, context({ mode: 'practice', previousFlightSample: previous }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
  })

  it('has unlimited practice and a 240-second challenge without speed or dwell goals', () => {
    const pose = sample(0, { x: 0, y: 3, z: 0 })
    expect(squareRouteEvaluator.evaluate(pose, context({ mode: 'practice', elapsedSeconds: 241 })).status).toBe('continue')
    const challenge = squareRouteEvaluator.evaluate(pose, context({ mode: 'challenge', elapsedSeconds: 241 }))
    expect(challenge.status).toBe('failure')
    expect(challenge.message).toContain('逾時')
    expect(SQUARE_ROUTE_LESSON.scoring.minimumActiveSeconds).toBe(0)
  })
})
