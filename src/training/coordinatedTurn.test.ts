import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig } from '../drone'
import { IDENTITY_QUATERNION, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { trainingRulesVersionForLesson } from './attempt'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import {
  beginnerCoordinatedTurnEvaluator, COORDINATED_TURN_LESSON, COORDINATED_TURN_TARGET_IDS,
  createCoordinatedTurnTargets,
} from './coordinatedTurn'
import type { TrainingCheckpointState, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'

const RIGHT_HEADING = quaternionFromRotationVector({ x: 0, y: -Math.PI / 2, z: 0 })
const DIAGONAL_HEADING = quaternionFromRotationVector({ x: 0, y: -Math.PI / 4, z: 0 })
const GROUND_COM = droneGroundSupport(DEFAULT_DRONE_CONFIG, IDENTITY_QUATERNION).supportOffsetM + DRONE_GROUND_CLEARANCE_M

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

function completed(id: string, metrics: Readonly<Record<string, number>> = {}): TrainingCheckpointState {
  return { id, completed: true, completedAtSeconds: 0.1, metrics }
}

function checkpoints(targetCount = 0): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(['turn-ground', 'turn-liftoff', ...COORDINATED_TURN_TARGET_IDS.slice(0, targetCount)].map((id) => [id,
    completed(id, id === 'turn-right-entry' ? { turnEntryHeadingX: 0, turnEntryHeadingZ: -1 }
      : id === 'turn-left-entry' ? { turnEntryHeadingX: 1, turnEntryHeadingZ: 0 } : {}),
  ]))
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: COORDINATED_TURN_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: checkpoints(), sceneReferences: references(), ...overrides }
}

/** Analytic continuous geometry tests observer rules; demonstration tests use real physics. */
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
  const orientations = [IDENTITY_QUATERNION, DIAGONAL_HEADING, RIGHT_HEADING, RIGHT_HEADING, DIAGONAL_HEADING, IDENTITY_QUATERNION]
  const targets = createCoordinatedTurnTargets(position, config.ground.heightM)
  targets.forEach((target, index) => move(target.positionM, orientations[index]))
  return trace
}

function run(trace: readonly TrainingSample[], mode: 'practice' | 'challenge' = 'practice', config = DEFAULT_DRONE_CONFIG) {
  const session = new TrainingSession({
    lessons: [COORDINATED_TURN_LESSON], initialLessonId: 'coordinated-turn', countdownDurationSeconds: 0,
    sceneReferences: references(config),
    attemptContext: { rulesVersion: trainingRulesVersionForLesson('coordinated-turn'), physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}', inputSource: 'keyboard', mode, assistance: 'none' },
  })
  session.start(0)
  session.tick(0)
  for (const current of trace) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

describe('ground-start right and left coordinated turn lesson', () => {
  it.each(['practice', 'challenge'] as const)('completes the actual ordered %s route without speed or dwell goals', (mode) => {
    const state = run(completeTrace(), mode)
    expect(state.phase, JSON.stringify(state.lastEvaluation)).toBe('SUCCESS')
    expect(state.result?.completedCheckpoints).toBe(8)
    expect(state.result?.metrics.turnTargetsCompleted).toBe(6)
    expect(state.result?.metrics.turnPhase).toBe(8)
    expect(state.result?.score).toBe(100)
    expect(state.result?.metrics.rightTurnChangeDegrees).toBeGreaterThan(25)
    expect(state.result?.metrics.leftTurnChangeDegrees).toBeGreaterThan(25)
    expect(state.checkpoints['turn-right-entry']?.metrics.turnEntryHeadingZ).toBeCloseTo(-1)
    expect(state.checkpoints['turn-left-entry']?.metrics.turnEntryHeadingX).toBeCloseTo(1)
  })

  it('observes supported ground and real liftoff independently of stick commands', () => {
    const ground = run(Array.from({ length: 30 }, (_, index) => ({ ...sample(index, { x: 0, y: GROUND_COM, z: 0 }),
      normalizedInput: { roll: 1, pitch: -1, yaw: 1, throttle: 1 } })))
    expect(ground.phase).toBe('ACTIVE')
    expect(ground.checkpoints['turn-ground']?.completed).toBe(true)
    expect(ground.checkpoints['turn-liftoff']?.completed).toBe(false)
    const air = run([sample(0, { x: 0, y: 3, z: 0 })])
    expect(air.checkpoints['turn-ground']?.completed).toBe(false)
    expect(air.lastEvaluation?.hint).toContain('實際接地')
  })

  it('requires measurable movement at each entry and never substitutes yaw commands', () => {
    const stationary = { ...sample(0, { x: 0, y: 3, z: -6 }), normalizedInput: { roll: 0, pitch: 0, yaw: 1, throttle: 0.4 } }
    const waiting = beginnerCoordinatedTurnEvaluator.evaluate(stationary, context())
    expect(waiting.checkpointIds).toEqual([])
    expect(waiting.metrics?.turnMotionReady).toBe(0)
    expect(waiting.hint).toContain('原地轉頭不算入彎')
    const moving = beginnerCoordinatedTurnEvaluator.evaluate(sample(1, stationary.state.positionM, { x: 0, y: 0, z: -0.06 }), context())
    expect(moving.checkpointIds).toEqual(['turn-right-entry'])
    expect(moving.metrics?.turnEntryRecorded).toBe(1)
  })

  it('uses measurable displacement for a very slow entry without requiring a minimum speed', () => {
    const previous = sample(0, { x: 0, y: 3, z: -5.99 })
    const current = sample(1, { x: 0, y: 3, z: -6 })
    const evaluation = beginnerCoordinatedTurnEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.checkpointIds).toEqual(['turn-right-entry'])
    expect(evaluation.metrics?.turnEntryHeadingZ).toBeCloseTo(-1)
  })

  it('does not advance out of order and allows a missed target to be retried without clearing progress', () => {
    const wrong = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, { x: 6, y: 3, z: -12 }, { x: 1, y: 0, z: 0 }, RIGHT_HEADING), context())
    expect(wrong.checkpointIds).toEqual([])
    expect(wrong.metrics?.turnTargetIndex).toBe(0)
    const missed = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, { x: 2, y: 6, z: -10 }, undefined, DIAGONAL_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(missed.recovery).toBeUndefined()
    expect(missed.metrics?.turnTargetsCompleted).toBe(1)
    const retry = beginnerCoordinatedTurnEvaluator.evaluate(sample(1, { x: 2, y: 3, z: -10 }, undefined, DIAGONAL_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(retry.checkpointIds).toEqual(['turn-right-apex'])
    expect(retry.metrics?.turnTargetsCompleted).toBe(2)
  })

  it('observes a continuous fast segment across a target even when both endpoints are outside', () => {
    const previous = sample(0, { x: 0, y: 3, z: -2 }, { x: 0, y: 0, z: -40 })
    const current = sample(2, { x: 0, y: 3, z: -10 }, { x: 0, y: 0, z: -40 })
    const evaluation = beginnerCoordinatedTurnEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).toEqual(['turn-right-entry'])
    expect(evaluation.metrics?.velocityConsistencyErrorM).toBeCloseTo(0)
  })

  it.each([
    { direction: 'right', count: 2, position: { x: 6, y: 3, z: -12 }, orientation: RIGHT_HEADING, entry: { x: 0, y: 0, z: -1 }, correct: { x: 1, y: 0, z: 0 }, wrong: { x: -1, y: 0, z: 0 } },
    { direction: 'left', count: 5, position: { x: 16, y: 3, z: -18 }, orientation: IDENTITY_QUATERNION, entry: { x: 1, y: 0, z: 0 }, correct: { x: 0, y: 0, z: -1 }, wrong: { x: 0, y: 0, z: 1 } },
  ])('requires actual intended $direction trajectory change, rather than a turned nose or wrong turn', ({ direction, count, position, orientation, entry, correct, wrong }) => {
    const scoped = context({ checkpoints: checkpoints(count) })
    const straight = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, position, entry, orientation), scoped)
    expect(straight.checkpointIds).toEqual([])
    expect(straight.metrics?.turnChangeDegrees).toBeCloseTo(0)
    expect(straight.hint).toContain('只轉機頭不算')
    const opposite = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, position, wrong, orientation), scoped)
    expect(opposite.checkpointIds).toEqual([])
    expect(opposite.metrics?.turnChangeDegrees).toBeCloseTo(-90)
    const actual = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, position, correct, orientation), scoped)
    expect(actual.checkpointIds).toEqual([`turn-${direction}-exit`])
    expect(actual.metrics?.[direction === 'right' ? 'rightTurnChangeDegrees' : 'leftTurnChangeDegrees']).toBeCloseTo(90)
  })

  it('keeps a previously measured airborne course when the learner stops inside the exit', () => {
    const evaluation = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, { x: 6, y: 3, z: -12 }, undefined, RIGHT_HEADING), context({
      checkpoints: checkpoints(2), previousEvaluation: { status: 'continue', metrics: { turnLastMotionX: 1, turnLastMotionZ: 0 } },
    }))
    expect(evaluation.checkpointIds).toEqual(['turn-right-exit'])
  })

  it('requires a roughly aligned nose and a recorded entry, with distinct corrective facts', () => {
    const reversed = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, { x: 0, y: 3, z: -6 }, { x: 0, y: 0, z: -1 }, RIGHT_HEADING), context())
    expect(reversed.checkpointIds).toEqual([])
    expect(reversed.metrics?.headingErrorDegrees).toBeCloseTo(90)
    expect(reversed.hint).toContain('70°')
    const missing = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, { x: 6, y: 3, z: -12 }, { x: 1, y: 0, z: 0 }, RIGHT_HEADING), context({
      checkpoints: { ...checkpoints(2), 'turn-right-entry': completed('turn-right-entry') },
    }))
    expect(missing.checkpointIds).toEqual([])
    expect(missing.metrics?.turnEntryRecorded).toBe(0)
    expect(missing.hint).toContain('尚缺此彎入口')
  })

  it('retains completed goals on a non-crash ground return and does not count ground sliding', () => {
    const evaluation = beginnerCoordinatedTurnEvaluator.evaluate(sample(0, { x: 2, y: GROUND_COM, z: -10 }, { x: 1, y: 0, z: -1 }, DIAGONAL_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(evaluation.checkpointIds).toEqual([])
    expect(evaluation.metrics?.turnTargetsCompleted).toBe(1)
    expect(evaluation.recovery).toBeUndefined()
    expect(evaluation.hint).toContain('就地再次起飛')
    const lifted = beginnerCoordinatedTurnEvaluator.evaluate(sample(1, { x: 2, y: 3, z: -10 }, undefined, DIAGONAL_HEADING), context({ checkpoints: checkpoints(1) }))
    expect(lifted.checkpointIds).toEqual(['turn-right-apex'])
  })

  it('shares immutable target geometry relative to supported launch and raised ground', () => {
    const config: DroneConfig = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 10 }, spawnPositionM: { x: 5, y: 25, z: -3 } }
    const launch = references(config)[0].positionM
    const original = JSON.stringify({ config, launch })
    const targets = createCoordinatedTurnTargets(launch, 10)
    expect(targets[0].positionM).toEqual({ x: 5, y: 13, z: -9 })
    expect(targets.at(-1)?.positionM).toEqual({ x: 21, y: 13, z: -21 })
    expect(targets.map(({ id }) => id)).toEqual(COORDINATED_TURN_TARGET_IDS)
    expect(Object.isFrozen(targets)).toBe(true)
    expect(targets.every((target) => Object.isFrozen(target) && Object.isFrozen(target.positionM))).toBe(true)
    expect(JSON.stringify({ config, launch })).toBe(original)
    expect(run(completeTrace(config), 'practice', config).phase).toBe('SUCCESS')
  })

  it('keeps crashes, disarm, invalid ground data, missing anchors and non-finite samples terminal', () => {
    const valid = sample(0, { x: 0, y: 3, z: -6 })
    const invalid: TrainingSample[] = [
      { ...valid, state: { ...valid.state, crashed: true } },
      { ...valid, armed: false },
      { ...valid, timestampSeconds: Number.NaN },
      { ...valid, groundContact: undefined },
      { ...valid, groundContact: { ...valid.groundContact!, heightM: 5 } },
      { ...valid, groundContact: { ...valid.groundContact!, touching: true } },
      { ...valid, state: { ...valid.state, positionM: { x: Number.NaN, y: 3, z: 0 } } },
    ]
    for (const current of invalid) {
      const evaluation = beginnerCoordinatedTurnEvaluator.evaluate(current, context({ mode: 'practice' }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
    expect(beginnerCoordinatedTurnEvaluator.evaluate(valid, context({ sceneReferences: [] })).status).toBe('failure')
    expect(beginnerCoordinatedTurnEvaluator.evaluate({ ...valid, armed: undefined }, context()).status).toBe('continue')
  })

  it('rejects disconnected, reset or implausibly teleported fixed-step paths even in practice', () => {
    const previous = sample(0, { x: 0, y: 3, z: 0 })
    const current = sample(1, { x: 0, y: 3, z: 0 })
    const invalid = [
      { ...current, timestampSeconds: previous.timestampSeconds },
      { ...current, timestampSeconds: 1, state: { ...current.state, timeSeconds: 1 } },
      { ...current, state: { ...current.state, timeSeconds: previous.state.timeSeconds } },
      { ...current, state: { ...current.state, stepIndex: previous.state.stepIndex } },
      { ...current, state: { ...current.state, positionM: { x: 20, y: 3, z: 0 } } },
    ]
    for (const pose of invalid) {
      const evaluation = beginnerCoordinatedTurnEvaluator.evaluate(pose, context({ mode: 'practice', previousFlightSample: previous }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
  })

  it('keeps practice unlimited but expires a challenge after 180 seconds', () => {
    const pose = sample(0, { x: 0, y: 3, z: 0 })
    expect(beginnerCoordinatedTurnEvaluator.evaluate(pose, context({ mode: 'practice', elapsedSeconds: 181 })).status).toBe('continue')
    const challenge = beginnerCoordinatedTurnEvaluator.evaluate(pose, context({ mode: 'challenge', elapsedSeconds: 181 }))
    expect(challenge.status).toBe('failure')
    expect(challenge.message).toContain('逾時')
  })
})
