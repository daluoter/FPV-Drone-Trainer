import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig } from '../drone'
import { IDENTITY_QUATERNION, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { CURRENT_TRAINING_RULES_VERSION } from './attempt'
import { TrainingSession } from './machine'
import {
  createDirectionControlTargets, DIRECTION_CONTROL_LESSON, DIRECTION_CONTROL_TARGET_IDS,
  directionControlEvaluator,
} from './directionControl'
import type { TrainingCheckpointState, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'

const RIGHT_HEADING = quaternionFromRotationVector({ x: 0, y: -Math.PI / 2, z: 0 })
const SUPPORT = droneGroundSupport(DEFAULT_DRONE_CONFIG, IDENTITY_QUATERNION).supportOffsetM
const GROUND_COM = SUPPORT + DRONE_GROUND_CLEARANCE_M

function references(config = DEFAULT_DRONE_CONFIG): readonly TrainingSceneReference[] {
  const launch = { ...config.spawnPositionM, y: config.ground.heightM + SUPPORT + DRONE_GROUND_CLEARANCE_M }
  return [
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'zone', positionM: { ...launch, y: config.ground.heightM, z: launch.z - 8 } },
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
  return Object.fromEntries(['direction-ground', 'direction-liftoff', ...DIRECTION_CONTROL_TARGET_IDS.slice(0, targetCount)]
    .map((id) => [id, completed(id, id === 'direction-back' ? { yawEntryForwardX: 0, yawEntryForwardZ: -1 } : {})]))
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: DIRECTION_CONTROL_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: checkpoints(), sceneReferences: references(), ...overrides }
}

/** Analytic continuous poses test observer rules; the independent demo uses real physics. */
function completeTrace(config = DEFAULT_DRONE_CONFIG): readonly TrainingSample[] {
  const ref = references(config)[0].positionM
  const trace: TrainingSample[] = [sample(0, ref, undefined, undefined, config)]
  let position = { ...ref }
  const move = (end: Vector3, duration: number, orientation = IDENTITY_QUATERNION): void => {
    const start = position
    const count = Math.round(duration * 10)
    for (let index = 1; index <= count; index++) {
      const t = index / count
      const curve = t * t * (3 - 2 * t)
      const rate = 6 * t * (1 - t) / duration
      trace.push(sample(trace.length, {
        x: start.x + (end.x - start.x) * curve,
        y: start.y + (end.y - start.y) * curve,
        z: start.z + (end.z - start.z) * curve,
      }, { x: (end.x - start.x) * rate, y: (end.y - start.y) * rate, z: (end.z - start.z) * rate }, orientation, config))
    }
    position = end
  }
  move({ ...position, y: config.ground.heightM + 3 }, 5)
  const targets = createDirectionControlTargets(ref, config.ground.heightM)
  for (const target of targets.slice(0, 4)) move(target.positionM, target.id === 'direction-left' ? 6 : 4)
  for (let index = 1; index <= 20; index++) trace.push(sample(trace.length, position, undefined,
    quaternionFromRotationVector({ x: 0, y: -(Math.PI / 2) * index / 20, z: 0 }), config))
  move(targets[5].positionM, 4, RIGHT_HEADING)
  move(targets[6].positionM, 4, RIGHT_HEADING)
  return trace
}

function run(trace: readonly TrainingSample[], mode: 'practice' | 'challenge' = 'practice', config = DEFAULT_DRONE_CONFIG) {
  const session = new TrainingSession({
    lessons: [DIRECTION_CONTROL_LESSON], initialLessonId: 'direction-control', countdownDurationSeconds: 0,
    sceneReferences: references(config),
    attemptContext: { rulesVersion: CURRENT_TRAINING_RULES_VERSION, physicsVersion: 1, presetId: 'beginner', settingsFingerprint: 'settings.v1:{}', inputSource: 'keyboard', mode, assistance: 'none' },
  })
  session.start(0)
  session.tick(0)
  for (const current of trace) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

describe('ground-start lateral movement and heading lesson', () => {
  it.each(['practice', 'challenge'] as const)('completes the ordered %s sequence without a speed limit or dwell', (mode) => {
    const state = run(completeTrace(), mode)
    expect(state.phase, JSON.stringify(state.lastEvaluation)).toBe('SUCCESS')
    expect(state.result?.completedCheckpoints).toBe(9)
    expect(state.result?.metrics.directionTargetsCompleted).toBe(7)
    expect(state.result?.metrics.directionPhase).toBe(9)
    expect(state.result?.score).toBe(100)
    expect(state.checkpoints['direction-back']?.metrics.yawEntryForwardZ).toBeCloseTo(-1)
    expect(state.checkpoints['direction-back']?.metrics.yawEntryRecorded).toBe(1)
  })

  it('keeps ground preparation and actual liftoff separate from stationary stick commands', () => {
    const ground = run(Array.from({ length: 30 }, (_, index) => ({ ...sample(index, { x: 0, y: GROUND_COM, z: 0 }),
      normalizedInput: { roll: 1, pitch: -1, yaw: 1, throttle: 1 } })))
    expect(ground.phase).toBe('ACTIVE')
    expect(ground.checkpoints['direction-ground']?.completed).toBe(true)
    expect(ground.checkpoints['direction-liftoff']?.completed).toBe(false)
    const airStart = run([sample(0, { x: 0, y: 3, z: 0 })])
    expect(airStart.checkpoints['direction-ground']?.completed).toBe(false)
    expect(airStart.lastEvaluation?.hint).toContain('實際接地')
  })

  it('does not count an out-of-order or missed target and keeps earlier progress for a local retry', () => {
    const wrong = directionControlEvaluator.evaluate(sample(0, { x: -4, y: 3, z: 0 }), context())
    expect(wrong.checkpointIds).toEqual([])
    expect(wrong.metrics?.directionTargetIndex).toBe(0)
    const missed = directionControlEvaluator.evaluate(sample(0, { x: -4, y: 5, z: 0 }), context({ checkpoints: checkpoints(1) }))
    expect(missed.recovery).toBeUndefined()
    expect(missed.metrics?.directionTargetsCompleted).toBe(1)
    const retry = directionControlEvaluator.evaluate(sample(0, { x: -4, y: 3, z: 0 }), context({ checkpoints: checkpoints(1) }))
    expect(retry.checkpointIds).toEqual(['direction-left'])
    expect(retry.metrics?.directionTargetsCompleted).toBe(2)
  })

  it('observes a fast segment through the visible sphere instead of requiring a sampled endpoint inside it', () => {
    const before = sample(0, { x: 0, y: 3, z: 0 }, { x: 40, y: 0, z: 0 })
    const after = sample(2, { x: 8, y: 3, z: 0 }, { x: 40, y: 0, z: 0 })
    const evaluation = directionControlEvaluator.evaluate(after, context({ previousSample: before }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).toEqual(['direction-right'])
    expect(evaluation.metrics?.velocityConsistencyErrorM).toBeCloseTo(0)
  })

  it('requires a roughly preserved heading for sideways movement, with a specific corrective hint', () => {
    const yawed = directionControlEvaluator.evaluate(sample(0, { x: 4, y: 3, z: 0 }, undefined, RIGHT_HEADING), context())
    expect(yawed.checkpointIds).toEqual([])
    expect(yawed.metrics?.headingErrorDegrees).toBeCloseTo(90)
    expect(yawed.hint).toContain('60°')
    expect(yawed.hint).toContain('轉回原來的前方')
    const corrected = directionControlEvaluator.evaluate(sample(1, { x: 4, y: 3, z: 0 }), context())
    expect(corrected.checkpointIds).toEqual(['direction-right'])
  })

  it('does not substitute yaw stick input, a pre-yawed pose or remote yawing for actual on-target heading change', () => {
    const yawContext = context({ checkpoints: checkpoints(4) })
    const stationary = { ...sample(0, { x: -4, y: 3, z: 0 }), normalizedInput: { roll: 0, pitch: 0, yaw: 1, throttle: 0.4 } }
    expect(directionControlEvaluator.evaluate(stationary, yawContext).checkpointIds).toEqual([])
    const turned = sample(0, { x: -4, y: 3, z: 0 }, undefined, RIGHT_HEADING)
    const preYawed = { ...checkpoints(4), 'direction-back': completed('direction-back', { yawEntryForwardX: 1, yawEntryForwardZ: 0 }) }
    const unchanged = directionControlEvaluator.evaluate(turned, context({ checkpoints: preYawed }))
    expect(unchanged.checkpointIds).toEqual([])
    expect(unchanged.hint).toContain('實際轉向 0°')
    expect(directionControlEvaluator.evaluate(sample(0, { x: 5, y: 3, z: 0 }, undefined, RIGHT_HEADING), yawContext).checkpointIds).toEqual([])
    const actual = directionControlEvaluator.evaluate(turned, yawContext)
    expect(actual.checkpointIds).toEqual(['direction-yaw'])
    expect(actual.metrics?.headingChangeDegrees).toBeCloseTo(90)
    expect(actual.metrics?.yawEntryRecorded).toBe(1)
    const missingEntry = directionControlEvaluator.evaluate(turned, context({ checkpoints: {
      ...checkpoints(4), 'direction-back': completed('direction-back'),
    } }))
    expect(missingEntry.checkpointIds).toEqual([])
    expect(missingEntry.metrics?.yawEntryRecorded).toBe(0)
    expect(missingEntry.hint).toContain('尚缺換向前的朝向紀錄')
  })

  it('describes the new body-relative forward and right after yaw without treating rotation alone as translation', () => {
    const atYaw = directionControlEvaluator.evaluate(sample(0, { x: -4, y: 3, z: 0 }, undefined, RIGHT_HEADING), context({ checkpoints: checkpoints(5) }))
    expect(atYaw.checkpointIds).toEqual([])
    expect(atYaw.metrics?.targetForwardM).toBeCloseTo(4)
    expect(atYaw.metrics?.targetRightM).toBeCloseTo(0)
    const atForward = directionControlEvaluator.evaluate(sample(0, { x: 0, y: 3, z: 0 }, undefined, RIGHT_HEADING), context({ checkpoints: checkpoints(6) }))
    expect(atForward.metrics?.targetRightM).toBeCloseTo(4)
    expect(atForward.metrics?.targetForwardM).toBeCloseTo(0)
  })

  it('prevents ground sliding into a target and permits another liftoff without clearing completed movement', () => {
    const grounded = directionControlEvaluator.evaluate(sample(0, { x: -4, y: GROUND_COM, z: 0 }), context({ checkpoints: checkpoints(1) }))
    expect(grounded.checkpointIds).toEqual([])
    expect(grounded.metrics?.directionTargetsCompleted).toBe(1)
    expect(grounded.hint).toContain('就地再次起飛')
    expect(grounded.recovery).toBeUndefined()
  })

  it('uses configured high ground and an offset launch without changing or retaining the inputs', () => {
    const config: DroneConfig = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 10 }, spawnPositionM: { x: 5, y: 20, z: -3 } }
    const launch = references(config)[0].positionM
    const original = JSON.stringify({ config, launch })
    const targets = createDirectionControlTargets(launch, 10)
    expect(targets[0].positionM).toEqual({ x: 9, y: 13, z: -3 })
    expect(targets.at(-1)?.positionM).toEqual({ x: 5, y: 13, z: 1 })
    expect(targets.map(({ id }) => id)).toEqual(DIRECTION_CONTROL_TARGET_IDS)
    expect(Object.isFrozen(targets)).toBe(true)
    expect(targets.every((target) => Object.isFrozen(target) && Object.isFrozen(target.positionM))).toBe(true)
    expect(run(completeTrace(config), 'practice', config).phase).toBe('SUCCESS')
    expect(JSON.stringify({ config, launch })).toBe(original)
  })

  it('ends on crash, Disarm, invalid values and fabricated ground contact before granting a target', () => {
    const current = sample(0, { x: 4, y: 3, z: 0 })
    const invalid = [
      { ...current, state: { ...current.state, crashed: true } },
      { ...current, armed: false },
      { ...current, state: { ...current.state, velocityMps: { x: Number.NaN, y: 0, z: 0 } } },
      { ...current, groundContact: { ...current.groundContact!, touching: true } },
      { ...current, groundContact: { ...current.groundContact!, heightM: 2 } },
    ]
    for (const altered of invalid) {
      const evaluation = directionControlEvaluator.evaluate(altered, context())
      expect(evaluation.status).toBe('failure')
      expect(evaluation.checkpointIds).toBeUndefined()
    }
  })

  it('rejects frozen, reset, gapped and teleported observations without erasing valid progress', () => {
    const previous = sample(0, { x: 0, y: 3, z: 0 })
    const next = sample(1, { x: 0, y: 3, z: 0 })
    for (const current of [
      { ...next, state: { ...next.state, stepIndex: previous.state.stepIndex, timeSeconds: previous.state.timeSeconds } },
      { ...next, state: { ...next.state, stepIndex: 0, timeSeconds: 0 } },
      sample(10, { x: 0, y: 3, z: 0 }),
      sample(1, { x: 4, y: 3, z: 0 }),
    ]) {
      const evaluation = directionControlEvaluator.evaluate(current, context({ checkpoints: checkpoints(1), previousSample: previous }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.metrics?.directionTargetsCompleted).toBe(1)
    }
  })

  it('keeps practice untimed while the challenge has a generous explicit limit', () => {
    const current = sample(0, { x: 0, y: 3, z: 0 })
    expect(directionControlEvaluator.evaluate(current, context({ mode: 'practice', elapsedSeconds: 181 })).status).toBe('continue')
    expect(directionControlEvaluator.evaluate(current, context({ mode: 'challenge', elapsedSeconds: 181 })).message).toContain('逾時')
  })
})
