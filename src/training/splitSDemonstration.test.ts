import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createTeachingDemonstration, teachingSplitSPhaseAt } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { SPLIT_S_LESSON, SPLIT_S_PHASE_IDS, splitSLearningEvaluator } from './splitS'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

function evaluateRecording(settings: TuningSettings, demo: ReturnType<typeof createTeachingDemonstration>) {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing }]
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  const observations: TrainingEvaluation[] = []
  for (const [index, pose] of demo.recording.samples.entries()) {
    const supportOffsetM = droneGroundSupport(settings.drone, pose.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: pose.timestampSeconds, armed: true, normalizedInput: pose.normalizedInput,
      groundContact: { heightM: settings.drone.ground.heightM, supportOffsetM,
        touching: pose.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 },
      state: { ...createInitialDroneState(settings.drone), positionM: pose.positionM, orientation: pose.orientation,
        velocityMps: pose.velocityMps, angularVelocityBodyRadPerSec: pose.angularVelocityBodyRadPerSec,
        timeSeconds: pose.timestampSeconds, stepIndex: index } }
    evaluation = splitSLearningEvaluator.evaluate(sample, { lesson: SPLIT_S_LESSON, mode: 'practice', elapsedSeconds: pose.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    expect(evaluation.status, JSON.stringify({ t: pose.timestampSeconds, evaluation })).not.toBe('failure')
    expect(evaluation.metrics?.splitInterruptionReason).toBe(0)
    expect(teachingSplitSPhaseAt(demo, pose.timestampSeconds)).toBe(evaluation.metrics?.splitPhase)
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    observations.push(evaluation)
    previous = sample
  }
  return { checkpoints, evaluation, observations }
}

describe('actual split-S teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('flies a half-roll followed by an actual descending half-loop from ground and recovers with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'split-s')
    expect(demo).toMatchObject({ lessonId: 'split-s', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L14 破S')
    expect(demo.recording.samples[0].positionM).toEqual(createTrainingFieldAnchors(settings.drone).launch)
    expect(demo.recording).toMatchObject({ capacity: 7_500, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeGreaterThan(12)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(120)
    expect(demo.recording.samples.length).toBeLessThan(7_500)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const times = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => times.has(cue.timeSeconds) && cue.targetReferenceId === 'split-zone')).toBe(true)
    expect(demo.cues.at(-1)).toMatchObject({ timeSeconds: demo.recording.durationSeconds, splitSPhase: 8 })
    expect(demo.cues.at(-1)?.text).toContain('破S八步已完成')
    let inverted = false
    let forward = false
    let rearward = false
    let climbing = false
    let descending = false
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => value >= 0 && value <= 1)).toBe(true)
      inverted ||= rotateVectorByQuaternion(pose.orientation, { x: 0, y: 1, z: 0 }).y < -0.9
      forward ||= pose.velocityMps.z < -8
      rearward ||= pose.velocityMps.z > 8
      climbing ||= pose.velocityMps.y > 2
      descending ||= pose.velocityMps.y < -8
      if (index === 0) continue
      const previous = demo.recording.samples[index - 1]
      const dt = pose.timestampSeconds - previous.timestampSeconds
      expect(dt).toBeGreaterThan(0)
      expect(dt).toBeLessThan(0.02)
      expect(Math.hypot(
        pose.positionM.x - previous.positionM.x - (pose.velocityMps.x + previous.velocityMps.x) * dt / 2,
        pose.positionM.y - previous.positionM.y - (pose.velocityMps.y + previous.velocityMps.y) * dt / 2,
        pose.positionM.z - previous.positionM.z - (pose.velocityMps.z + previous.velocityMps.z) * dt / 2,
      )).toBeLessThan(0.003)
    }
    expect([inverted, forward, rearward, climbing, descending]).toEqual([true, true, true, true, true])
    const { evaluation, checkpoints, observations } = evaluateRecording(settings, demo)
    const evidence = observations.find((value) => value.status === 'success')!
    expect(evaluation?.status).toBe('success')
    expect(SPLIT_S_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    expect(evidence.metrics?.splitPitchProgressDegrees).toBeGreaterThanOrEqual(145)
    expect(evidence.metrics?.splitPathTurnDegrees).toBeGreaterThanOrEqual(100)
    expect(evidence.metrics?.splitHeightLossM).toBeGreaterThan(10)
    expect(evidence.metrics?.splitHeadingChangeDegrees).toBeGreaterThan(140)
    expect(evidence.metrics?.splitReverseTravelM).toBeGreaterThan(3)
    const end = demo.recording.samples.at(-1)!
    expect(end.positionM.y - settings.drone.ground.heightM).toBeGreaterThan(5)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(35 * Math.PI / 180))
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('uses one grounded reset followed only by normal fixed-step RC input', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'split-s')
      expect(reset).toHaveBeenCalledTimes(1)
      expect(step.mock.calls.length).toBeGreaterThan(demo.recording.samples.length)
      expect(step.mock.calls.every(([input, dt]) => input !== null && dt === 1 / 240
        && input.roll >= -1 && input.roll <= 1 && input.pitch >= -1 && input.pitch <= 1
        && input.yaw >= -1 && input.yaw <= 1 && input.throttle >= 0 && input.throttle <= 1)).toBe(true)
    } finally {
      reset.mockRestore()
      step.mockRestore()
    }
  })

  it('rejects insufficient pitch rate instead of fabricating a completed path', () => {
    const base = createTuningPreset('beginner')
    const settings = { ...base, controller: { ...base.controller,
      rateLimitsDegPerSec: { ...base.controller.rateLimitsDegPerSec, pitch: 100 } } }
    expect(() => createTeachingDemonstration(settings, 'split-s')).toThrow(/角速度|推力/)
  })
})
