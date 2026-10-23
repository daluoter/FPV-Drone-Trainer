import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig } from '../drone'
import { IDENTITY_QUATERNION, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from './field'
import { createFigureEightTargets, FIGURE_EIGHT_LESSON, FIGURE_EIGHT_TARGET_IDS, figureEightEvaluator } from './figureEight'
import { TrainingSession } from './machine'
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
  return Object.fromEntries(['eight-ground', 'eight-liftoff', ...FIGURE_EIGHT_TARGET_IDS.slice(0, targetCount)].map((id) => [id,
    { id, completed: true, completedAtSeconds: 0.1, metrics: {} },
  ]))
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: FIGURE_EIGHT_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: checkpoints(), sceneReferences: references(), ...overrides }
}

/** Analytic observer fixture; recording tests separately use actual RC dynamics. */
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
  for (const target of createFigureEightTargets(position, config.ground.heightM)) {
    const forward = target.headingForward
    move(target.positionM, quaternionFromRotationVector({ x: 0, y: Math.atan2(-forward.x, -forward.z), z: 0 }))
  }
  return trace
}

function run(trace: readonly TrainingSample[], mode: 'practice' | 'challenge' = 'practice', config = DEFAULT_DRONE_CONFIG) {
  const session = new TrainingSession({
    lessons: [FIGURE_EIGHT_LESSON], initialLessonId: 'figure-eight', countdownDurationSeconds: 0, sceneReferences: references(config),
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

describe('ground-start left/right figure-eight lesson', () => {
  it.each(['practice', 'challenge'] as const)('completes eleven ordered %s steps and both loops without landing', (mode) => {
    const state = run(completeTrace(), mode)
    expect(state.phase, JSON.stringify(state.lastEvaluation)).toBe('SUCCESS')
    expect(state.result?.completedCheckpoints).toBe(11)
    expect(state.result?.score).toBe(100)
    expect(state.result?.metrics).toMatchObject({ eightPhase: 11, eightTargetIndex: 9, eightTargetsCompleted: 9, eightLoop: 2, eightLoopsCompleted: 2, groundTouching: 0 })
    expect(Object.values(state.checkpoints).every(({ completed }) => completed)).toBe(true)
    expect(state.checkpoints['eight-crossing']?.completedAtSeconds).toBeGreaterThan(state.checkpoints['eight-left-bottom']!.completedAtSeconds!)
    expect(state.checkpoints['eight-finish']?.completedAtSeconds).toBeGreaterThan(state.checkpoints['eight-right-bottom']!.completedAtSeconds!)
    const final = state.previousSample!.state.positionM
    expect(Math.hypot(final.x, final.z + 6)).toBeLessThan(1.9)
    expect(final.y).toBeCloseTo(3)
  })

  it('requires actual ground preparation and liftoff instead of a stick ritual or airborne start', () => {
    const ground = run(Array.from({ length: 30 }, (_, index) => ({ ...sample(index, { x: 0, y: GROUND_COM, z: 0 }),
      normalizedInput: { roll: 1, pitch: -1, yaw: 1, throttle: 1 } })))
    expect(ground.phase).toBe('ACTIVE')
    expect(ground.checkpoints['eight-ground']?.completed).toBe(true)
    expect(ground.checkpoints['eight-liftoff']?.completed).toBe(false)
    const air = run([sample(0, { x: 0, y: 3, z: -6 })])
    expect(air.checkpoints['eight-ground']?.completed).toBe(false)
    expect(air.lastEvaluation?.hint).toContain('實際接地')
  })

  it('treats the repeated center as entry, crossing and finish only in their own order', () => {
    const center = sample(0, { x: 0, y: 3, z: -6 })
    const entry = figureEightEvaluator.evaluate(center, context())
    expect(entry.checkpointIds).toEqual(['eight-entry'])
    expect(entry.metrics).toMatchObject({ eightTargetIndex: 1, eightTargetsCompleted: 1, eightLoop: 1, eightLoopsCompleted: 0 })
    const premature = figureEightEvaluator.evaluate(center, context({ checkpoints: checkpoints(1) }))
    expect(premature.checkpointIds).toEqual([])
    const crossing = figureEightEvaluator.evaluate(center, context({ checkpoints: checkpoints(4) }))
    expect(crossing.checkpointIds).toEqual(['eight-crossing'])
    expect(crossing.metrics).toMatchObject({ eightPhase: 7, eightTargetIndex: 5, eightTargetsCompleted: 5, eightLoop: 2, eightLoopsCompleted: 1 })
    expect(crossing.metrics?.targetRightM).toBeCloseTo(6)
    expect(crossing.metrics?.targetForwardM).toBeCloseTo(6)
    const finish = figureEightEvaluator.evaluate(center, context({ checkpoints: checkpoints(8) }))
    expect(finish.status).toBe('success')
    expect(finish.checkpointIds).toEqual(['eight-finish'])
    expect(finish.metrics).toMatchObject({ eightPhase: 11, eightTargetsCompleted: 9, eightLoopsCompleted: 2 })
  })

  it('cannot complete the crossing or finish by yawing in the central zone', () => {
    const entry = completeTrace().slice(0, 91)
    const yaw = Array.from({ length: 80 }, (_, index) => sample(entry.length + index, { x: 0, y: 3, z: -6 }, undefined,
      quaternionFromRotationVector({ x: 0, y: index * 0.1, z: 0 })))
    const state = run([...entry, ...yaw])
    expect(state.phase).toBe('ACTIVE')
    expect(state.lastEvaluation?.metrics).toMatchObject({ eightTargetsCompleted: 1, eightLoopsCompleted: 0 })
    expect(state.checkpoints['eight-crossing']?.completed).toBe(false)
    expect(state.checkpoints['eight-finish']?.completed).toBe(false)
  })

  it('rejects a straight out-and-back shortcut that never visits either loop', () => {
    const straight = completeTrace().map((pose) => ({ ...pose, state: { ...pose.state,
      positionM: { ...pose.state.positionM, x: 0 }, velocityMps: { ...pose.state.velocityMps, x: 0 } } }))
    const state = run(straight)
    expect(state.phase).toBe('ACTIVE')
    expect(state.lastEvaluation?.metrics).toMatchObject({ eightTargetsCompleted: 1, eightLoopsCompleted: 0 })
    expect(state.checkpoints['eight-finish']?.completed).toBe(false)
  })

  it('keeps order and permits an off-target left arc to be retried without clearing progress', () => {
    const rightOuter = figureEightEvaluator.evaluate(sample(0, { x: 12, y: 3, z: -6 }), context())
    expect(rightOuter.checkpointIds).toEqual([])
    const leftTop = createFigureEightTargets({ x: 0, y: 0, z: 0 }, 0)[1]
    const missed = figureEightEvaluator.evaluate(sample(0, { ...leftTop.positionM, y: 6 }, undefined, LEFT_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(missed.recovery).toBeUndefined()
    expect(missed.metrics?.eightTargetsCompleted).toBe(1)
    const retry = figureEightEvaluator.evaluate(sample(1, leftTop.positionM, undefined, LEFT_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(retry.checkpointIds).toEqual(['eight-left-top'])
    expect(retry.metrics).toMatchObject({ eightTargetIndex: 2, eightPhase: 4, eightLoop: 1, eightLoopsCompleted: 0 })
  })

  it('counts an actual fast segment through the entry sphere with both endpoints outside', () => {
    const previous = sample(0, { x: 0, y: 3, z: -2 }, { x: 0, y: 0, z: -40 })
    const current = sample(2, { x: 0, y: 3, z: -10 }, { x: 0, y: 0, z: -40 })
    const evaluation = figureEightEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).toEqual(['eight-entry'])
    expect(evaluation.metrics?.velocityConsistencyErrorM).toBeCloseTo(0)
  })

  it('uses body-relative next-target offsets and blocks a clearly wrong nose direction', () => {
    const relative = figureEightEvaluator.evaluate(sample(0, { x: 0, y: 3, z: -6 }, undefined, LEFT_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(relative.metrics?.targetForwardM).toBeCloseTo(6)
    expect(relative.metrics?.targetRightM).toBeCloseTo(6)
    const wrong = figureEightEvaluator.evaluate(sample(0, { x: 0, y: 3, z: -6 }, undefined, RIGHT_HEADING), context())
    expect(wrong.checkpointIds).toEqual([])
    expect(wrong.metrics?.headingErrorDegrees).toBeCloseTo(90)
    expect(wrong.hint).toContain('70°')
  })

  it('preserves completed targets on non-crash ground contact and allows local takeoff', () => {
    const ground = figureEightEvaluator.evaluate(sample(0, { x: -6, y: GROUND_COM, z: -12 }, undefined, LEFT_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(ground.checkpointIds).toEqual([])
    expect(ground.metrics?.eightTargetsCompleted).toBe(1)
    expect(ground.recovery).toBeUndefined()
    expect(ground.hint).toContain('就地再次起飛')
    const lifted = figureEightEvaluator.evaluate(sample(1, { x: -6, y: 3, z: -12 }, undefined, LEFT_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(lifted.checkpointIds).toEqual(['eight-left-top'])
  })

  it('shares immutable raised-ground goals while keeping the three center identities distinct', () => {
    const config: DroneConfig = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 10 }, spawnPositionM: { x: 5, y: 25, z: -3 } }
    const launch = references(config)[0].positionM
    const before = JSON.stringify({ config, launch })
    const targets = createFigureEightTargets(launch, 10)
    expect(targets[0].positionM).toEqual({ x: 5, y: 13, z: -9 })
    expect(targets[2].positionM).toEqual({ x: -7, y: 13, z: -9 })
    expect(targets[0].positionM).toEqual(targets[4].positionM)
    expect(targets[4].positionM).toEqual(targets[8].positionM)
    expect(new Set(targets.map(({ id }) => id)).size).toBe(9)
    expect(targets.map(({ id }) => id)).toEqual(FIGURE_EIGHT_TARGET_IDS)
    expect(Object.isFrozen(targets)).toBe(true)
    expect(targets.every((target) => Object.isFrozen(target) && Object.isFrozen(target.positionM) && Object.isFrozen(target.headingForward))).toBe(true)
    expect(JSON.stringify({ config, launch })).toBe(before)
    expect(run(completeTrace(config), 'practice', config).phase).toBe('SUCCESS')
  })

  it('keeps crashes, disarm, invalid contacts/references and non-finite data terminal', () => {
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
      const evaluation = figureEightEvaluator.evaluate(pose, context({ mode: 'practice' }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
    expect(figureEightEvaluator.evaluate(valid, context({ sceneReferences: [] })).status).toBe('failure')
    expect(figureEightEvaluator.evaluate(valid, context({ elapsedSeconds: Number.NaN })).status).toBe('failure')
    expect(figureEightEvaluator.evaluate({ ...valid, armed: undefined }, context()).status).toBe('continue')
  })

  it('rejects gaps, reset clocks, duplicate physical steps and teleportation in practice', () => {
    const previous = sample(0, { x: 0, y: 3, z: 0 })
    const current = sample(1, { x: 0, y: 3, z: 0 })
    for (const pose of [
      { ...current, timestampSeconds: previous.timestampSeconds },
      { ...current, timestampSeconds: 1, state: { ...current.state, timeSeconds: 1 } },
      { ...current, state: { ...current.state, timeSeconds: previous.state.timeSeconds } },
      { ...current, state: { ...current.state, stepIndex: previous.state.stepIndex } },
      { ...current, state: { ...current.state, positionM: { x: 20, y: 3, z: 0 } } },
    ]) {
      const evaluation = figureEightEvaluator.evaluate(pose, context({ mode: 'practice', previousFlightSample: previous }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
  })

  it('has unlimited practice and a 300-second challenge without speed or dwell goals', () => {
    const pose = sample(0, { x: 0, y: 3, z: 0 })
    expect(figureEightEvaluator.evaluate(pose, context({ mode: 'practice', elapsedSeconds: 301 })).status).toBe('continue')
    const challenge = figureEightEvaluator.evaluate(pose, context({ mode: 'challenge', elapsedSeconds: 301 }))
    expect(challenge.status).toBe('failure')
    expect(challenge.message).toContain('逾時')
    expect(FIGURE_EIGHT_LESSON.scoring.minimumActiveSeconds).toBe(0)
  })
})
