import { describe, expect, it, vi } from 'vitest'
import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import { findSweptObstacleHit } from '../simulation/obstacles'
import type { TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createGravityGate, gravityGateExitCrossing, gravityGateTopCrossing } from '../world/gravityGate'
import { createDemonstrationProgress, demonstrationProgressAt } from './demonstrationProgress'
import { createTeachingDemonstration, teachingGravityGatePhaseAt } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { GRAVITY_GATE_LESSON, GRAVITY_GATE_PHASE_IDS, gravityGateEvaluator } from './gravityGate'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

function evaluateRecording(settings: TuningSettings, demo: ReturnType<typeof createTeachingDemonstration>) {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const gate = createGravityGate(launch, settings.drone.ground.heightM)
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: gate.id, kind: 'gate', positionM: gate.centerM }]
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
    evaluation = gravityGateEvaluator.evaluate(sample, { lesson: GRAVITY_GATE_LESSON, mode: 'practice', elapsedSeconds: pose.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    expect(evaluation.status, JSON.stringify({ t: pose.timestampSeconds, evaluation })).not.toBe('failure')
    expect(evaluation.metrics?.gravityGateInterrupted, JSON.stringify({ t: pose.timestampSeconds, evaluation })).toBe(0)
    expect(teachingGravityGatePhaseAt(demo, pose.timestampSeconds)).toBe(evaluation.metrics?.gravityGatePhase)
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    observations.push(evaluation)
    previous = sample
  }
  return { checkpoints, evaluation, observations }
}

describe('actual gravity-gate teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('throws upward, cuts throttle, drops through the top and escapes the side with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'gravity-gate')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    const gate = createGravityGate(launch, settings.drone.ground.heightM)
    expect(demo).toMatchObject({ lessonId: 'gravity-gate', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L19 重力門')
    expect(demo.recording.samples[0].positionM).toEqual(launch)
    expect(demo.recording).toMatchObject({ capacity: 5_000, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeGreaterThan(10)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(80)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const times = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => times.has(cue.timeSeconds) && cue.targetReferenceId === gate.id)).toBe(true)
    expect(demo.cues.at(-1)).toMatchObject({ timeSeconds: demo.recording.durationSeconds, gravityGatePhase: 8 })
    let topAt: number | null = null
    let exitAt: number | null = null
    let sawCutWhileRising = false
    let maxAltitude = 0
    let peakRiseSpeed = 0
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => value >= 0 && value <= 1)).toBe(true)
      maxAltitude = Math.max(maxAltitude, pose.positionM.y - settings.drone.ground.heightM)
      peakRiseSpeed = Math.max(peakRiseSpeed, pose.velocityMps.y)
      if (pose.normalizedInput!.throttle <= 0.05 && pose.velocityMps.y > 2) sawCutWhileRising = true
      if (index === 0) continue
      const previous = demo.recording.samples[index - 1]
      const dt = pose.timestampSeconds - previous.timestampSeconds
      expect(dt).toBeGreaterThan(0)
      expect(dt).toBeLessThan(0.02)
      expect(Math.hypot(
        pose.positionM.x - previous.positionM.x - (pose.velocityMps.x + previous.velocityMps.x) * dt / 2,
        pose.positionM.y - previous.positionM.y - (pose.velocityMps.y + previous.velocityMps.y) * dt / 2,
        pose.positionM.z - previous.positionM.z - (pose.velocityMps.z + previous.velocityMps.z) * dt / 2,
      )).toBeLessThan(0.006)
      expect(findSweptObstacleHit(previous.positionM, pose.positionM, 0.3, gate.colliders)).toBeNull()
      const top = gravityGateTopCrossing(previous.positionM, pose.positionM, gate, 0.3)
      if (top?.insideOpening) topAt ??= pose.timestampSeconds
      const exit = gravityGateExitCrossing(previous.positionM, pose.positionM, gate, 0.3)
      if (exit?.insideOpening && topAt !== null) exitAt ??= pose.timestampSeconds
    }
    expect(sawCutWhileRising).toBe(true)
    expect(peakRiseSpeed).toBeGreaterThan(8)
    expect(maxAltitude).toBeGreaterThan(26)
    expect(topAt).not.toBeNull()
    expect(exitAt).not.toBeNull()
    expect(exitAt!).toBeGreaterThan(topAt!)
    const { evaluation, checkpoints } = evaluateRecording(settings, demo)
    expect(evaluation?.status).toBe('success')
    expect(GRAVITY_GATE_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    const end = demo.recording.samples.at(-1)!
    expect(end.positionM.z).toBeLessThan(gate.exitZ)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(45 * Math.PI / 180))
    expect(Math.abs(end.velocityMps.y)).toBeLessThan(6)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('uses one grounded reset with the actual frame, then ordinary fixed-step RC input', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const resetAt = vi.spyOn(FlightSimulation.prototype, 'resetAt')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const settings = createTuningPreset('beginner')
      const demo = createTeachingDemonstration(settings, 'gravity-gate')
      const { launch } = createTrainingFieldAnchors(settings.drone)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(reset).toHaveBeenCalledWith(launch, { x: 0, y: 0, z: 0, w: 1 }, createGravityGate(launch, settings.drone.ground.heightM).colliders)
      expect(resetAt).toHaveBeenCalledTimes(1)
      expect(step.mock.calls.length).toBeGreaterThan(demo.recording.samples.length)
      expect(step.mock.calls.every(([input, dt]) => input !== null && dt === 1 / 240
        && input.roll >= -1 && input.roll <= 1 && input.pitch >= -1 && input.pitch <= 1
        && input.yaw >= -1 && input.yaw <= 1 && input.throttle >= 0 && input.throttle <= 1)).toBe(true)
    } finally { reset.mockRestore(); resetAt.mockRestore(); step.mockRestore() }
  })

  it('observes eight independent steps and restores pre-entry facts on backward seek', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'gravity-gate')
    const timeline = createDemonstrationProgress(demo, settings)
    expect(demonstrationProgressAt(timeline, demo.recording.durationSeconds)).toMatchObject({ complete: true, completedSteps: 8, totalSteps: 8 })
    const entry = timeline.steps.find((step) => step.id === 'gravity-entered')!
    expect(entry.startedAtSeconds).not.toBeNull()
    const beforeEntry = demonstrationProgressAt(timeline, Math.max(0, entry.startedAtSeconds! - 0.05))
    expect(beforeEntry.complete).toBe(false)
    expect(beforeEntry.completedSteps).toBeLessThan(6)
    expect(demonstrationProgressAt(timeline, 0).completedSteps).toBeLessThan(2)
    const truncated = { ...demo, recording: { ...demo.recording,
      samples: demo.recording.samples.filter((pose) => pose.timestampSeconds <= entry.startedAtSeconds!),
      durationSeconds: entry.startedAtSeconds! } }
    expect(demonstrationProgressAt(createDemonstrationProgress(truncated, settings), demo.recording.durationSeconds).complete).toBe(false)
  })

  it('rejects insufficient pitch rate instead of fabricating a flight', () => {
    const base = createTuningPreset('beginner')
    const settings = { ...base, controller: { ...base.controller,
      rateLimitsDegPerSec: { ...base.controller.rateLimitsDegPerSec, pitch: 20 } } }
    expect(() => createTeachingDemonstration(settings, 'gravity-gate')).toThrow(/角速度|推力/)
  })
})
