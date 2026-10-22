import { describe, expect, it } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, droneGroundSupport, DRONE_GROUND_CLEARANCE_M } from '../drone'
import { quaternionFromRotationVector } from '../math/quaternion'
import { CURRENT_TRAINING_RULES_VERSION } from './attempt'
import { TRAINING_SCENE_REFERENCES } from './fixtures'
import { TrainingSession } from './machine'
import {
  STRAIGHT_LINE_GATE_RADIUS_M,
  STRAIGHT_LINE_GATE_TOLERANCE_M,
  STRAIGHT_LINE_TARGET_HEIGHT_AGL_M,
  STRAIGHT_LINE_LEARNING_CONTENT,
  STRAIGHT_LINE_LESSON,
  straightLineEvaluator,
} from './straightLine'
import type { TrainingCheckpointState, TrainingEvaluationContext, TrainingSample } from './types'

const PAD = TRAINING_SCENE_REFERENCES.find((reference) => reference.id === 'takeoff-pad')!.positionM
const ALTITUDE = DEFAULT_DRONE_CONFIG.ground.heightM + STRAIGHT_LINE_TARGET_HEIGHT_AGL_M
const SUPPORT = droneGroundSupport(DEFAULT_DRONE_CONFIG, { x: 0, y: 0, z: 0, w: 1 }).supportOffsetM
const GROUND_HEIGHT = DEFAULT_DRONE_CONFIG.ground.heightM
const GROUND_COM = GROUND_HEIGHT + SUPPORT + DRONE_GROUND_CLEARANCE_M
const REFERENCES = [...TRAINING_SCENE_REFERENCES, {
  id: 'training-launch', kind: 'spawn', positionM: { ...PAD, y: GROUND_COM },
}, {
  id: 'landing-surface', kind: 'zone', positionM: { ...PAD, y: GROUND_HEIGHT, z: PAD.z - 8 },
}]

function sample(index: number, distanceM: number, forwardSpeedMps = 0, heightM = ALTITUDE, verticalSpeedMps = 0, xOffsetM = 0): TrainingSample {
  const timestampSeconds = (index + 1) * 0.1
  return {
    timestampSeconds, armed: true,
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 },
    groundContact: { heightM: GROUND_HEIGHT, supportOffsetM: SUPPORT, touching: heightM <= GROUND_COM + 1e-8 },
    state: {
      ...createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: PAD.x + xOffsetM, y: heightM, z: PAD.z - distanceM }),
      velocityMps: { x: 0, y: verticalSpeedMps, z: -forwardSpeedMps },
      timeSeconds: timestampSeconds, stepIndex: index + 1,
    },
  }
}

/** Analytic evaluator fixtures, independent of human-flight or hardware evidence. */
function takeoffFixture(): readonly TrainingSample[] {
  return Array.from({ length: 45 }, (_, index) => {
    const fraction = Math.min(1, index * 0.1 / 4)
    const height = GROUND_COM + (ALTITUDE - GROUND_COM) * (3 * fraction ** 2 - 2 * fraction ** 3)
    const speed = (ALTITUDE - GROUND_COM) * (6 * fraction - 6 * fraction ** 2) / 4
    return sample(index, 0, 0, height, speed)
  })
}

function constantSpeedRoute(): readonly TrainingSample[] {
  return [...takeoffFixture(), ...Array.from({ length: 18 }, (_, index) => sample(index + 45, 0.25 + index * 0.5, 5))]
}

function checkpoint(id: string): TrainingCheckpointState {
  return { id, completed: true, completedAtSeconds: 0.1, metrics: {} }
}

function routeCheckpoints(passed = 0): Readonly<Record<string, TrainingCheckpointState>> {
  const ids = ['straight-ground', 'straight-start', ...['straight-transit', 'straight-brake', 'straight-stop'].slice(0, passed)]
  return Object.fromEntries(ids.map((id) => [id, checkpoint(id)]))
}

function context(overrides: Partial<TrainingEvaluationContext> = {}): TrainingEvaluationContext {
  return {
    lesson: STRAIGHT_LINE_LESSON, elapsedSeconds: 0.1, trajectory: [], checkpoints: {},
    sceneReferences: REFERENCES, ...overrides,
  }
}

function run(samples: readonly TrainingSample[], mode: 'practice' | 'challenge' = 'challenge') {
  const session = new TrainingSession({
    lessons: [STRAIGHT_LINE_LESSON], initialLessonId: STRAIGHT_LINE_LESSON.id,
    countdownDurationSeconds: 0, sceneReferences: REFERENCES,
    attemptContext: { rulesVersion: CURRENT_TRAINING_RULES_VERSION, physicsVersion: 1, presetId: 'beginner',
      settingsFingerprint: 'settings.v1:{}', inputSource: 'keyboard', mode, assistance: 'none' },
  })
  session.start(0)
  session.tick(0)
  for (const current of samples) {
    session.consumeSample(current)
    if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
  }
  return session.getState()
}

describe('ground-start straight-line ring passage', () => {
  it.each(['practice', 'challenge'] as const)('completes %s on the last ordered ring without braking or a settled stop', (mode) => {
    const result = run(constantSpeedRoute(), mode)
    expect(result.phase, result.result?.message).toBe('SUCCESS')
    expect(result.result?.completedCheckpoints).toBe(5)
    expect(result.result?.metrics.gatesPassed).toBe(3)
    expect(result.result?.metrics.horizontalSpeedMps).toBe(5)
    expect(result.result?.metrics.alongTrackM).toBeGreaterThan(8)
    expect(result.result?.score).toBe(100)
    expect(STRAIGHT_LINE_LEARNING_CONTENT.steps.join(' ')).toMatch(/綠色圈即完成/)
  })

  it('waits on actual ground, then marks takeoff without requiring a hover or small vertical speed', () => {
    const grounded = run(Array.from({ length: 20 }, (_, index) => sample(index, 0, 0, GROUND_COM)))
    expect(grounded.phase).toBe('ACTIVE')
    expect(grounded.checkpoints['straight-ground']?.completed).toBe(true)
    expect(grounded.checkpoints['straight-start']?.completed).toBe(false)
    const climb = takeoffFixture()
    const result = run(climb.slice(0, 21))
    expect(result.checkpoints['straight-start']?.completed).toBe(true)
    expect(result.lastEvaluation?.metrics?.verticalSpeedMps).toBeGreaterThan(0.5)
    expect(result.lastEvaluation?.hint).toContain('不要求減速或停穩')
  })

  it('accepts a continuous diagonal takeoff without first reaching target height over the launch area', () => {
    const climb = Array.from({ length: 45 }, (_, index) => {
      const fraction = Math.min(1, index * 0.1 / 4)
      const curve = 3 * fraction ** 2 - 2 * fraction ** 3
      const derivative = (6 * fraction - 6 * fraction ** 2) / 4
      return sample(index, 6 * curve, 6 * derivative, GROUND_COM + (ALTITUDE - GROUND_COM) * curve,
        (ALTITUDE - GROUND_COM) * derivative)
    })
    const result = run([...climb, ...Array.from({ length: 6 }, (_, index) => sample(index + 45, 6.25 + index * 0.5, 5))])
    expect(result.phase, result.result?.message).toBe('SUCCESS')
    expect(result.result?.completedCheckpoints).toBe(5)
  })

  it('does not skip ground preparation or infer ring passage from stationary stick movement', () => {
    const airborne = run([sample(0, 0), sample(1, 0)])
    expect(airborne.phase).toBe('ACTIVE')
    expect(airborne.checkpoints['straight-ground']?.completed).toBe(false)
    expect(airborne.lastEvaluation?.hint).toContain('實際接地')
    const stationary = run([...takeoffFixture(), ...Array.from({ length: 30 }, (_, index) => ({
      ...sample(index + 45, 0), normalizedInput: { roll: 0, pitch: index % 2 ? 1 : -1, yaw: 0, throttle: 0.4 },
    }))])
    expect(stationary.phase).toBe('ACTIVE')
    expect(stationary.checkpoints['straight-transit']?.completed).toBe(false)
  })

  it('uses a circular opening and interpolated crossing rather than requiring a sample inside the ring', () => {
    const radius = STRAIGHT_LINE_GATE_RADIUS_M + STRAIGHT_LINE_GATE_TOLERANCE_M
    for (const [offset, accepted] of [[radius - 0.01, true], [radius + 0.01, false]] as const) {
      const previous = sample(50, 2.5, 10, ALTITUDE, 0, offset)
      const evaluation = straightLineEvaluator.evaluate(sample(51, 3.5, 10, ALTITUDE, 0, offset), context({
        previousSample: previous, checkpoints: routeCheckpoints(),
      }))
      expect(evaluation.status).toBe('continue')
      expect(evaluation.checkpointIds?.includes('straight-transit')).toBe(accepted)
      expect(evaluation.metrics?.lastGateCrossingErrorM).toBeCloseTo(offset)
      if (!accepted) expect(evaluation.hint).toContain('回到這一圈前方')
    }
    const outsideCircle = straightLineEvaluator.evaluate(sample(51, 3.5, 10, ALTITUDE + 1.2, 0, 1.2), context({
      previousSample: sample(50, 2.5, 10, ALTITUDE + 1.2, 0, 1.2), checkpoints: routeCheckpoints(),
    }))
    expect(outsideCircle.checkpointIds).not.toContain('straight-transit')
  })

  it('requires a forward crossing, preserving progress on misses or reverse flight', () => {
    const missed = straightLineEvaluator.evaluate(sample(51, 5.5, 10, ALTITUDE, 0, 1.8), context({
      previousSample: sample(50, 4.5, 10, ALTITUDE, 0, 1.8), checkpoints: routeCheckpoints(1),
    }))
    expect(missed.status).toBe('continue')
    expect(missed.recovery).toBeUndefined()
    expect(missed.metrics?.gatesPassed).toBe(1)
    expect(missed.hint).toContain('不需回地面')
    const reverse = straightLineEvaluator.evaluate(sample(53, 4.5, -10), context({
      previousSample: sample(52, 5.5, -10), checkpoints: routeCheckpoints(1), previousEvaluation: missed,
    }))
    expect(reverse.checkpointIds).not.toContain('straight-brake')
    const recross = straightLineEvaluator.evaluate(sample(55, 5.5, 10), context({
      previousSample: sample(54, 4.5, 10), checkpoints: routeCheckpoints(1), previousEvaluation: reverse,
    }))
    expect(recross.checkpointIds).toContain('straight-brake')
    expect(recross.metrics?.gatesPassed).toBe(2)
    expect(recross.metrics?.missedGateErrorM).toBe(0)
  })

  it('does not count proximity, ground sliding or out-of-order arrival as ring passage', () => {
    const still = straightLineEvaluator.evaluate(sample(51, 3), context({ previousSample: sample(50, 3), checkpoints: routeCheckpoints() }))
    expect(still.checkpointIds).not.toContain('straight-transit')
    const outOfOrder = straightLineEvaluator.evaluate(sample(51, 8.5, 10), context({ previousSample: sample(50, 7.5, 10), checkpoints: routeCheckpoints() }))
    expect(outOfOrder.metrics?.gatesPassed).toBe(0)
    expect(outOfOrder.checkpointIds).toHaveLength(0)
    const sliding = straightLineEvaluator.evaluate(sample(51, 3.5, 10, GROUND_COM), context({
      previousSample: sample(50, 2.5, 10, GROUND_COM), checkpoints: routeCheckpoints(),
    }))
    expect(sliding.checkpointIds).not.toContain('straight-transit')
  })

  it('accepts several correctly ordered intersections in one continuous fast segment without tilt perfection', () => {
    const before = sample(50, 2, 7 / 0.3)
    const source = sample(53, 9, 7 / 0.3)
    const current = { ...source, state: { ...source.state, orientation: quaternionFromRotationVector({ x: 0, y: 0, z: Math.PI / 4 }) } }
    const evaluation = straightLineEvaluator.evaluate(current, context({ previousSample: before, checkpoints: routeCheckpoints() }))
    expect(evaluation.status).toBe('success')
    expect(evaluation.checkpointIds).toEqual(['straight-transit', 'straight-brake', 'straight-stop'])
  })

  it('keeps the ninety-second limit for challenges only', () => {
    const before = sample(50, 2.5, 10)
    const current = sample(51, 3.5, 10)
    expect(straightLineEvaluator.evaluate(current, context({ mode: 'practice', elapsedSeconds: 91, previousSample: before, checkpoints: routeCheckpoints() })).status).toBe('continue')
    expect(straightLineEvaluator.evaluate(current, context({ mode: 'challenge', elapsedSeconds: 91, previousSample: before, checkpoints: routeCheckpoints() })).status).toBe('failure')
  })

  it('rejects crashes, disarm, non-finite telemetry and fabricated elevated ground contact', () => {
    const source = sample(51, 3.5, 10)
    for (const bad of [
      { ...source, armed: false },
      { ...source, state: { ...source.state, crashed: true } },
      { ...source, state: { ...source.state, positionM: { ...source.state.positionM, x: Number.NaN } } },
      { ...source, groundContact: { heightM: ALTITUDE - SUPPORT - DRONE_GROUND_CLEARANCE_M, supportOffsetM: SUPPORT, touching: true } },
    ]) expect(straightLineEvaluator.evaluate(bad, context({ checkpoints: routeCheckpoints() })).status).toBe('failure')
  })

  it('rejects reset, frozen state, clock relabeling, time gaps and teleport even after a missed ring', () => {
    const before = sample(50, 2.5, 10)
    const current = sample(51, 3.5, 10)
    const variants: TrainingSample[] = [
      { ...current, state: { ...current.state, stepIndex: before.state.stepIndex } },
      { ...current, state: { ...current.state, timeSeconds: before.state.timeSeconds } },
      { ...current, state: { ...current.state, timeSeconds: current.state.timeSeconds + 1 } },
      { ...current, timestampSeconds: current.timestampSeconds + 1, state: { ...current.state, timeSeconds: current.state.timeSeconds + 1 } },
      { ...current, state: { ...current.state, positionM: { ...current.state.positionM, z: PAD.z - 8 } } },
    ]
    for (const bad of variants) expect(straightLineEvaluator.evaluate(bad, context({
      previousFlightSample: before, previousSample: null, checkpoints: routeCheckpoints(),
      previousEvaluation: { status: 'continue', metrics: { missedGateErrorM: 1.8 } },
    })).status).toBe('failure')
  })

  it('anchors the ring height and positions to a nonzero ground and launch field', () => {
    const shift = { x: 4, y: 10, z: 7 }
    const move = (source: TrainingSample): TrainingSample => ({ ...source,
      groundContact: { ...source.groundContact!, heightM: GROUND_HEIGHT + shift.y },
      state: { ...source.state, positionM: { x: source.state.positionM.x + shift.x, y: source.state.positionM.y + shift.y, z: source.state.positionM.z + shift.z } },
    })
    const evaluation = straightLineEvaluator.evaluate(move(sample(51, 8.5, 10)), context({
      previousSample: move(sample(50, 7.5, 10)), checkpoints: routeCheckpoints(2),
      sceneReferences: REFERENCES.map((reference) => ({ ...reference, positionM: { x: reference.positionM.x + shift.x, y: reference.positionM.y + shift.y, z: reference.positionM.z + shift.z } })),
    }))
    expect(evaluation.status).toBe('success')
    expect(evaluation.metrics?.altitudeM).toBe(3)
  })
})
