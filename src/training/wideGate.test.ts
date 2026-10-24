import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig } from '../drone'
import { IDENTITY_QUATERNION, quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import { OBSTACLE_CRASH_WARNING_PREFIX, validateStaticObstacles } from '../simulation/obstacles'
import { createWideGates, WIDE_GATE_FRAME_DEPTH_M, WIDE_GATE_FRAME_THICKNESS_M, WIDE_GATE_IDS, WIDE_GATE_OPENING_HEIGHT_M, WIDE_GATE_OPENING_WIDTH_M } from '../world/wideGates'
import { createTrainingFieldAnchors } from './field'
import { TrainingSession } from './machine'
import type { TrainingCheckpointState, TrainingEvaluationContext, TrainingSample, TrainingSceneReference } from './types'
import { WIDE_GATE_LEARNING_CONTENT, WIDE_GATE_LESSON, WIDE_GATE_TIME_LIMIT_SECONDS, wideGateEvaluator } from './wideGate'

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

function checkpoints(gateCount = 0): Readonly<Record<string, TrainingCheckpointState>> {
  return Object.fromEntries(['gate-ground', 'gate-liftoff', ...WIDE_GATE_IDS.slice(0, gateCount)].map((id) => [id,
    { id, completed: true, completedAtSeconds: 0.1, metrics: {} },
  ]))
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return { lesson: WIDE_GATE_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: checkpoints(), sceneReferences: references(), ...overrides }
}

/** Constant-velocity observer segment; runtime tests separately cover body/frame sweeps. */
function segment(start: Vector3, end: Vector3, ticks = 1, orientation = IDENTITY_QUATERNION) {
  const seconds = ticks * 0.1
  const velocity = { x: (end.x - start.x) / seconds, y: (end.y - start.y) / seconds, z: (end.z - start.z) / seconds }
  return { previous: sample(0, start, velocity, orientation), current: sample(ticks, end, velocity, orientation) }
}

/** Smooth, velocity-consistent observer fixture; this does not replace the physical demo. */
function completeTrace(config = DEFAULT_DRONE_CONFIG): readonly TrainingSample[] {
  let position = { ...references(config)[0].positionM }
  const trace: TrainingSample[] = [sample(0, position, undefined, undefined, config)]
  const move = (end: Vector3, duration: number): void => {
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
      }, { x: (end.x - start.x) * rate, y: (end.y - start.y) * rate, z: (end.z - start.z) * rate }, undefined, config))
    }
    position = end
  }
  move({ ...position, y: config.ground.heightM + 3 }, 4)
  move({ ...position, z: position.z - 26 }, 12)
  return trace
}

function run(trace: readonly TrainingSample[], mode: 'practice' | 'challenge' = 'practice', config = DEFAULT_DRONE_CONFIG) {
  const session = new TrainingSession({
    lessons: [WIDE_GATE_LESSON], initialLessonId: 'wide-gate', countdownDurationSeconds: 0, sceneReferences: references(config),
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

describe('shared physical wide-gate geometry', () => {
  it('defines three ordered openings with grounded posts and exact physical frame bounds', () => {
    const launch = { x: 5, y: 25, z: -3 }
    const original = { ...launch }
    const gates = createWideGates(launch, 10)
    expect(gates.map(({ id }) => id)).toEqual(WIDE_GATE_IDS)
    expect(gates.map(({ positionM }) => positionM)).toEqual([
      { x: 5, y: 13, z: -11 }, { x: 5, y: 13, z: -19 }, { x: 5, y: 13, z: -27 },
    ])
    expect(WIDE_GATE_OPENING_WIDTH_M).toBe(4)
    expect(WIDE_GATE_OPENING_HEIGHT_M).toBe(4)
    expect(WIDE_GATE_FRAME_THICKNESS_M).toBe(0.22)
    expect(WIDE_GATE_FRAME_DEPTH_M).toBe(0.35)
    const colliders = gates.flatMap(({ colliders: boxes }) => boxes)
    expect(colliders).toHaveLength(12)
    expect(validateStaticObstacles(colliders)).toBe(true)
    for (const gate of gates) {
      expect(gate.openingWidthM).toBe(4)
      expect(gate.openingHeightM).toBe(4)
      expect(gate.colliders.map(({ id }) => id)).toEqual(['left-post', 'right-post', 'top-bar', 'bottom-bar'].map((part) => `${gate.id}-${part}`))
      const [left, right, top, bottom] = gate.colliders
      expect(left.centerM.x).toBeCloseTo(gate.positionM.x - 2.11)
      expect(right.centerM.x).toBeCloseTo(gate.positionM.x + 2.11)
      for (const post of [left, right]) {
        expect(post.centerM.y - post.halfExtentsM.y).toBeCloseTo(10)
        expect(post.centerM.y + post.halfExtentsM.y).toBeCloseTo(15.22)
        expect(post.halfExtentsM).toEqual({ x: 0.11, y: 2.61, z: 0.175 })
      }
      expect(top.centerM.y - top.halfExtentsM.y).toBeCloseTo(15)
      expect(bottom.centerM.y + bottom.halfExtentsM.y).toBeCloseTo(11)
      expect(top.halfExtentsM).toEqual({ x: 2.22, y: 0.11, z: 0.175 })
      expect(bottom.halfExtentsM).toEqual(top.halfExtentsM)
    }
    expect(launch).toEqual(original)
    expect(Object.isFrozen(gates)).toBe(true)
    expect(gates.every((gate) => Object.isFrozen(gate) && Object.isFrozen(gate.positionM) && Object.isFrozen(gate.colliders))).toBe(true)
    expect(colliders.every((box) => Object.isFrozen(box) && Object.isFrozen(box.centerM) && Object.isFrozen(box.halfExtentsM))).toBe(true)
  })
})

describe('ground-start ordered wide-gate lesson', () => {
  it.each(['practice', 'challenge'] as const)('completes all five %s steps from actual ground and scores the third crossing immediately', (mode) => {
    const state = run(completeTrace(), mode)
    expect(state.phase, JSON.stringify(state.lastEvaluation)).toBe('SUCCESS')
    expect(state.result?.completedCheckpoints).toBe(5)
    expect(state.result?.score).toBe(100)
    expect(state.result?.metrics).toMatchObject({ gatePhase: 5, gateTargetIndex: 3, gatesPassed: 3, groundTouching: 0 })
    expect(Object.values(state.checkpoints).every(({ completed }) => completed)).toBe(true)
    expect(state.checkpoints['wide-gate-2']?.completedAtSeconds).toBeGreaterThan(state.checkpoints['wide-gate-1']!.completedAtSeconds!)
    expect(state.checkpoints['wide-gate-3']?.completedAtSeconds).toBeGreaterThan(state.checkpoints['wide-gate-2']!.completedAtSeconds!)
    expect(state.previousSample?.state.positionM.z).toBeLessThanOrEqual(-24)
    expect(state.previousSample?.state.velocityMps.z).toBeLessThan(-1)
    expect(state.previousSample?.state.positionM.y).toBeCloseTo(3)
  })

  it('requires ground preparation and actual liftoff instead of input gestures or an airborne start', () => {
    const ground = run(Array.from({ length: 20 }, (_, index) => ({ ...sample(index, { x: 0, y: GROUND_COM, z: 0 }),
      normalizedInput: { roll: 1, pitch: -1, yaw: 1, throttle: 1 } })))
    expect(ground.phase).toBe('ACTIVE')
    expect(ground.checkpoints['gate-ground']?.completed).toBe(true)
    expect(ground.checkpoints['gate-liftoff']?.completed).toBe(false)
    const air = run([sample(0, { x: 0, y: 3, z: 0 })])
    expect(air.checkpoints['gate-ground']?.completed).toBe(false)
    expect(air.lastEvaluation?.hint).toContain('實際接地')
    const offPad = wideGateEvaluator.evaluate(sample(0, { x: 3, y: GROUND_COM, z: 0 }), context({ checkpoints: {} }))
    expect(offPad.checkpointIds).toEqual([])
    const lift = wideGateEvaluator.evaluate(sample(0, { x: 0, y: GROUND_COM + 0.16, z: 0 }), context({ checkpoints: {
      'gate-ground': checkpoints()['gate-ground'],
    } }))
    expect(lift.checkpointIds).toEqual(['gate-liftoff'])
    expect(lift.metrics?.gatePhase).toBe(2)
  })

  it('measures the crossing plane between endpoints and updates the next target in the same frame', () => {
    const { previous, current } = segment({ x: 0, y: 3, z: -6 }, { x: 0, y: 3, z: -10 })
    const evaluation = wideGateEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.checkpointIds).toEqual(['wide-gate-1'])
    expect(evaluation.metrics).toMatchObject({ gatePhase: 3, gateTargetIndex: 1, gatesPassed: 1, nextGateDistanceM: 6, nextGateHorizontalErrorM: 0, nextGateVerticalErrorM: 0, targetForwardM: 6 })
    expect(evaluation.metrics?.velocityConsistencyErrorM).toBeCloseTo(0)
    const diagonal = segment({ x: 3, y: 3, z: -6 }, { x: -3, y: 3, z: -10 })
    expect(wideGateEvaluator.evaluate(diagonal.current, context({ previousSample: diagonal.previous })).checkpointIds).toEqual(['wide-gate-1'])
  })

  it.each([{ x: 2.3, y: 3 }, { x: 0, y: 5.3 }, { x: 0, y: 0.5 }])('retains a missed gate when the segment crosses outside its opening at $x / $y', ({ x, y }) => {
    const { previous, current } = segment({ x, y, z: -6 }, { x, y, z: -10 })
    const evaluation = wideGateEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.checkpointIds).toEqual([])
    expect(evaluation.metrics).toMatchObject({ gatesPassed: 0, gateTargetIndex: 0, nextGateDistanceM: -2 })
    expect(evaluation.recovery).toBeUndefined()
    expect(evaluation.hint).toContain('繞回')
  })

  it('does not skip the first missed gate when flying through a later opening', () => {
    const { previous, current } = segment({ x: 0, y: 3, z: -14 }, { x: 0, y: 3, z: -18 })
    const evaluation = wideGateEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.checkpointIds).toEqual([])
    expect(evaluation.metrics?.gatesPassed).toBe(0)
    expect(evaluation.hint).toContain('第 1 道寬門')
  })

  it('requires a new forward crossing after returning from the wrong side and retains earlier gates', () => {
    const reverse = segment({ x: 0, y: 3, z: -18 }, { x: 0, y: 3, z: -14 })
    const returning = wideGateEvaluator.evaluate(reverse.current, context({ checkpoints: checkpoints(1), previousSample: reverse.previous }))
    expect(returning.checkpointIds).toEqual([])
    expect(returning.metrics).toMatchObject({ gatesPassed: 1, gateTargetIndex: 1, nextGateDistanceM: 2 })
    const forward = segment({ x: 0, y: 3, z: -14 }, { x: 0, y: 3, z: -18 })
    const retried = wideGateEvaluator.evaluate(forward.current, context({ checkpoints: checkpoints(1), previousSample: forward.previous }))
    expect(retried.checkpointIds).toEqual(['wide-gate-2'])
    expect(retried.metrics).toMatchObject({ gatePhase: 4, gatesPassed: 2, nextGateDistanceM: 6 })
  })

  it('cannot count yaw, input gestures, endpoint proximity or ground sliding as a crossing', () => {
    const previous = sample(0, { x: 0, y: 3, z: -8 })
    const yawed = { ...sample(1, previous.state.positionM, undefined, quaternionFromRotationVector({ x: 0, y: Math.PI, z: 0 })),
      normalizedInput: { roll: 1, pitch: -1, yaw: 1, throttle: 1 } }
    expect(wideGateEvaluator.evaluate(yawed, context({ previousSample: previous })).checkpointIds).toEqual([])
    expect(wideGateEvaluator.evaluate(sample(0, { x: 0, y: 3, z: -8 }), context()).checkpointIds).toEqual([])
    const slide = segment({ x: 0, y: GROUND_COM, z: -6 }, { x: 0, y: GROUND_COM, z: -10 })
    const evaluation = wideGateEvaluator.evaluate(slide.current, context({ previousSample: slide.previous }))
    expect(evaluation.checkpointIds).toEqual([])
    expect(evaluation.metrics?.gatesPassed).toBe(0)
  })

  it('permits multiple ordered clear openings in one consistent segment without a speed or heading rule', () => {
    const { previous, current } = segment({ x: 0, y: 3, z: -6 }, { x: 0, y: 3, z: -26 }, 2,
      quaternionFromRotationVector({ x: 0, y: Math.PI, z: 0 }))
    const evaluation = wideGateEvaluator.evaluate(current, context({ previousSample: previous }))
    expect(evaluation.status).toBe('success')
    expect(evaluation.checkpointIds).toEqual(WIDE_GATE_IDS)
    expect(evaluation.metrics).toMatchObject({ gatePhase: 5, gatesPassed: 3, gateTargetIndex: 3 })
    expect(evaluation.score).toBe(100)
  })

  it('uses signed opening offsets and body-relative directions for coaching', () => {
    const rightFacing = quaternionFromRotationVector({ x: 0, y: -Math.PI / 2, z: 0 })
    const evaluation = wideGateEvaluator.evaluate(sample(0, { x: 1, y: 4, z: -6 }, undefined, rightFacing), context())
    expect(evaluation.metrics).toMatchObject({ nextGateDistanceM: 2, nextGateHorizontalErrorM: 1, nextGateVerticalErrorM: 1, altitudeM: 4 })
    expect(evaluation.metrics?.targetDistanceM).toBeCloseTo(Math.sqrt(6))
    expect(evaluation.metrics?.targetForwardM).toBeCloseTo(-1)
    expect(evaluation.metrics?.targetRightM).toBeCloseTo(-2)
    expect(evaluation.metrics?.targetUpM).toBeCloseTo(-1)
  })

  it('retains completed gates after non-crash ground contact and permits a local takeoff', () => {
    const evaluation = wideGateEvaluator.evaluate(sample(0, { x: 3, y: GROUND_COM, z: -12 }), context({ checkpoints: checkpoints(1) }))
    expect(evaluation.status).toBe('continue')
    expect(evaluation.metrics).toMatchObject({ gatesPassed: 1, gateTargetIndex: 1, groundTouching: 1 })
    expect(evaluation.recovery).toBeUndefined()
    expect(evaluation.hint).toContain('就地再次起飛')
    const forward = segment({ x: 0, y: 3, z: -14 }, { x: 0, y: 3, z: -18 })
    expect(wideGateEvaluator.evaluate(forward.current, context({ checkpoints: checkpoints(1), previousSample: forward.previous })).checkpointIds).toEqual(['wide-gate-2'])
  })

  it('preserves the explicit frame part from a physics crash before considering disarm or grades', () => {
    const { current } = segment({ x: 0, y: 3, z: -6 }, { x: 0, y: 3, z: -10 })
    const warning = `${OBSTACLE_CRASH_WARNING_PREFIX}wide-gate-1-right-post`
    const crashed = { ...current, armed: false, state: { ...current.state, crashed: true, warnings: ['generic warning', warning] } }
    const evaluation = wideGateEvaluator.evaluate(crashed, context())
    expect(evaluation.status).toBe('failure')
    expect(evaluation.message).toContain(warning)
    expect(evaluation.checkpointIds).toBeUndefined()
    expect(evaluation.recovery).toBeUndefined()
  })

  it('uses the actual raised support surface and shifted launch for the complete observer route', () => {
    const config: DroneConfig = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 10 }, spawnPositionM: { x: 5, y: 25, z: -3 } }
    const state = run(completeTrace(config), 'practice', config)
    expect(state.phase, JSON.stringify(state.lastEvaluation)).toBe('SUCCESS')
    expect(state.result?.metrics.altitudeM).toBeCloseTo(3)
    expect(state.previousSample?.state.positionM.x).toBe(5)
    expect(state.previousSample?.state.positionM.z).toBeLessThanOrEqual(-27)
  })

  it('keeps invalid data, lost arming, missing references and unsupported contact terminal', () => {
    const valid = sample(0, { x: 0, y: 3, z: -6 })
    for (const pose of [
      { ...valid, armed: false },
      { ...valid, timestampSeconds: Number.NaN },
      { ...valid, groundContact: undefined },
      { ...valid, groundContact: { ...valid.groundContact!, supportOffsetM: -1 } },
      { ...valid, groundContact: { ...valid.groundContact!, heightM: 5 } },
      { ...valid, groundContact: { ...valid.groundContact!, touching: true } },
      { ...valid, state: { ...valid.state, positionM: { x: Number.NaN, y: 3, z: -6 } } },
    ]) {
      const evaluation = wideGateEvaluator.evaluate(pose, context({ mode: 'practice' }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
    expect(wideGateEvaluator.evaluate(valid, context({ sceneReferences: [] })).status).toBe('failure')
    expect(wideGateEvaluator.evaluate(valid, context({ elapsedSeconds: Number.NaN })).status).toBe('failure')
    expect(wideGateEvaluator.evaluate({ ...valid, armed: undefined }, context()).status).toBe('continue')
  })

  it('rejects discontinuous clocks, duplicate physical steps and endpoint teleportation', () => {
    const previous = sample(0, { x: 0, y: 3, z: 0 })
    const current = sample(1, { x: 0, y: 3, z: 0 })
    for (const pose of [
      { ...current, timestampSeconds: previous.timestampSeconds },
      { ...current, timestampSeconds: 1, state: { ...current.state, timeSeconds: 1 } },
      { ...current, state: { ...current.state, timeSeconds: previous.state.timeSeconds } },
      { ...current, state: { ...current.state, stepIndex: previous.state.stepIndex } },
      { ...current, state: { ...current.state, positionM: { x: 0, y: 3, z: -26 } } },
    ]) {
      const evaluation = wideGateEvaluator.evaluate(pose, context({ mode: 'practice', previousFlightSample: previous }))
      expect(evaluation.status).toBe('failure')
      expect(evaluation.recovery).toBeUndefined()
    }
  })

  it('has unlimited practice and a 240-second challenge with no dwell, speed or landing score', () => {
    const pose = sample(0, { x: 0, y: 3, z: 0 })
    expect(WIDE_GATE_TIME_LIMIT_SECONDS).toBe(240)
    expect(wideGateEvaluator.evaluate(pose, context({ mode: 'practice', elapsedSeconds: 241 })).status).toBe('continue')
    expect(wideGateEvaluator.evaluate(pose, context({ mode: 'challenge', elapsedSeconds: 240 })).status).toBe('continue')
    const expired = wideGateEvaluator.evaluate(pose, context({ mode: 'challenge', elapsedSeconds: 241 }))
    expect(expired.status).toBe('failure')
    expect(expired.message).toContain('逾時')
    expect(WIDE_GATE_LESSON.scoring.minimumActiveSeconds).toBe(0)
    expect(WIDE_GATE_LEARNING_CONTENT).toMatchObject({ code: 'L08', prerequisiteIds: ['figure-eight'] })
  })
})
