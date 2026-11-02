import { describe, expect, it, vi } from 'vitest'
import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import { findSweptObstacleHit } from '../simulation/obstacles'
import type { TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createSlalomFlags, slalomFlagCrossing, SLALOM_EXIT_DISTANCE_M } from '../world/slalomFlags'
import { createDemonstrationProgress, demonstrationProgressAt } from './demonstrationProgress'
import { createTeachingDemonstration, teachingSlalomPhaseAt } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { SLALOM_LESSON, SLALOM_PHASE_IDS, slalomEvaluator } from './slalom'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

function evaluateRecording(settings: TuningSettings, demo: ReturnType<typeof createTeachingDemonstration>) {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const flags = createSlalomFlags(launch, settings.drone.ground.heightM)
  const last = flags.at(-1)!
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    ...flags.map((flag) => ({ id: flag.id, kind: 'flag', positionM: flag.positionM })),
    { id: 'slalom-exit', kind: 'marker', positionM: { ...last.passPointM, z: last.positionM.z - SLALOM_EXIT_DISTANCE_M } }]
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  for (const [index, pose] of demo.recording.samples.entries()) {
    const supportOffsetM = droneGroundSupport(settings.drone, pose.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: pose.timestampSeconds, armed: true, normalizedInput: pose.normalizedInput,
      groundContact: { heightM: settings.drone.ground.heightM, supportOffsetM,
        touching: pose.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 },
      state: { ...createInitialDroneState(settings.drone), positionM: pose.positionM, orientation: pose.orientation,
        velocityMps: pose.velocityMps, angularVelocityBodyRadPerSec: pose.angularVelocityBodyRadPerSec,
        timeSeconds: pose.timestampSeconds, stepIndex: index } }
    evaluation = slalomEvaluator.evaluate(sample, { lesson: SLALOM_LESSON, mode: 'practice', elapsedSeconds: pose.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous,
      previousFlightSample: previous, previousEvaluation: evaluation })
    expect(evaluation.status, JSON.stringify({ t: pose.timestampSeconds, evaluation })).not.toBe('failure')
    expect(evaluation.metrics?.slalomInterrupted, JSON.stringify({ t: pose.timestampSeconds, evaluation })).toBe(0)
    expect(teachingSlalomPhaseAt(demo, pose.timestampSeconds)).toBe(evaluation.metrics?.slalomPhase)
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true,
      completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    previous = sample
  }
  return { checkpoints, evaluation }
}

describe('actual forward alternating-flag teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('flies all six alternating sides continuously forward with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const beforeSettings = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'slalom')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    const flags = createSlalomFlags(launch, settings.drone.ground.heightM)
    const colliders = flags.flatMap((flag) => flag.colliders)
    expect(demo).toMatchObject({ kind: 'slalom', lessonId: 'slalom', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L18 刀旗 S 彎')
    expect(demo.recording.samples[0].positionM).toEqual(launch)
    expect(demo.recording).toMatchObject({ capacity: 4_000, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeGreaterThan(10)
    expect(demo.recording.durationSeconds).toBeLessThan(65)
    expect(demo.recording.samples.length).toBeLessThan(demo.recording.capacity)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds))).toBe(true)
    expect(demo.cues.at(-1)).toMatchObject({ timeSeconds: demo.recording.durationSeconds, slalomPhase: 10,
      targetReferenceId: 'slalom-exit' })
    let passed = 0
    let minimumBankUpX = 1
    let maximumBankUpX = -1
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => value >= 0 && value <= 1)).toBe(true)
      const up = rotateVectorByQuaternion(pose.orientation, { x: 0, y: 1, z: 0 })
      expect(up.y).toBeGreaterThan(0.3)
      minimumBankUpX = Math.min(minimumBankUpX, up.x)
      maximumBankUpX = Math.max(maximumBankUpX, up.x)
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
      expect(findSweptObstacleHit(previous.positionM, pose.positionM, 0.3, colliders)).toBeNull()
      if (previous.positionM.z <= flags[0].positionM.z + 3) {
        expect(pose.positionM.z).toBeLessThan(previous.positionM.z)
        expect(pose.velocityMps.z).toBeLessThan(-1)
      }
      if (passed >= flags.length) continue
      const crossing = slalomFlagCrossing(previous.positionM, pose.positionM, flags[passed])
      if (!crossing) continue
      expect(crossing.insidePassage).toBe(true)
      expect(crossing.sideOffsetM).toBeGreaterThanOrEqual(1)
      expect(crossing.sideOffsetM).toBeLessThanOrEqual(8)
      expect(Math.sign(crossing.positionM.x - launch.x)).toBe(passed % 2 === 0 ? -1 : 1)
      expect(crossing.altitudeM).toBeGreaterThan(1)
      expect(crossing.altitudeM).toBeLessThan(7)
      passed += 1
    }
    expect(passed).toBe(6)
    expect(minimumBankUpX).toBeLessThan(-0.2)
    expect(maximumBankUpX).toBeGreaterThan(0.2)
    const { evaluation, checkpoints } = evaluateRecording(settings, demo)
    expect(evaluation?.status).toBe('success')
    expect(evaluation?.metrics).toMatchObject({ slalomPhase: 10, slalomFlagsPassed: 6,
      slalomExited: 1, slalomRecovered: 1 })
    expect(SLALOM_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    const end = demo.recording.samples.at(-1)!
    expect(end.positionM.z).toBeLessThan(flags.at(-1)!.positionM.z - SLALOM_EXIT_DISTANCE_M)
    expect(end.velocityMps.z).toBeLessThan(-1)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(15 * Math.PI / 180))
    expect(JSON.stringify(settings)).toBe(beforeSettings)
  })

  it('uses one grounded reset with all six solid flags, then only fixed-step normalized RC input', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const resetAt = vi.spyOn(FlightSimulation.prototype, 'resetAt')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const settings = createTuningPreset('beginner')
      const demo = createTeachingDemonstration(settings, 'slalom')
      const { launch } = createTrainingFieldAnchors(settings.drone)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(reset).toHaveBeenCalledWith(launch, { x: 0, y: 0, z: 0, w: 1 },
        createSlalomFlags(launch, settings.drone.ground.heightM).flatMap((flag) => flag.colliders))
      expect(resetAt).toHaveBeenCalledTimes(1)
      expect(step.mock.calls.length).toBeGreaterThan(demo.recording.samples.length)
      expect(step.mock.calls.every(([input, dt]) => input !== null && dt === 1 / 240
        && input.roll >= -1 && input.roll <= 1 && input.pitch >= -1 && input.pitch <= 1
        && input.yaw >= -1 && input.yaw <= 1 && input.throttle >= 0 && input.throttle <= 1)).toBe(true)
    } finally { reset.mockRestore(); resetAt.mockRestore(); step.mockRestore() }
  })

  it('restores each actual flag count and measured motion when seeking backward', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'slalom')
    const timeline = createDemonstrationProgress(demo, settings)
    const end = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(end).toMatchObject({ complete: true, totalSteps: 10, completedSteps: 10,
      metrics: { slalomPhase: 10, slalomFlagsPassed: 6, slalomExited: 1, slalomRecovered: 1 } })
    expect(timeline.frames.length).toBe(demo.recording.samples.length + 1)
    for (let count = 1; count <= 6; count += 1) {
      const step = end.steps[count + 1]
      const time = step.completedAtSeconds!
      const passed = demonstrationProgressAt(timeline, time)
      expect(passed.completedSteps).toBe(count + 2)
      expect(passed.metrics?.slalomFlagsPassed).toBe(count)
      expect(passed.metrics?.slalomForwardSpeedMps).toBeGreaterThan(1)
      expect(demonstrationProgressAt(timeline, time - 0.001).metrics?.slalomFlagsPassed).toBe(count - 1)
      demonstrationProgressAt(timeline, timeline.durationSeconds)
      expect(demonstrationProgressAt(timeline, time)).toEqual(passed)
      const samples = demo.recording.samples.filter((pose) => pose.timestampSeconds < time)
      const truncated = { ...demo, recording: { ...demo.recording, samples,
        durationSeconds: samples.at(-1)!.timestampSeconds }, cues: [{ timeSeconds: 0, text: '十步完成', slalomPhase: 10 }] }
      const partial = createDemonstrationProgress(truncated, settings)
      const stop = demonstrationProgressAt(partial, partial.durationSeconds)
      expect(stop.complete).toBe(false)
      expect(stop.metrics?.slalomFlagsPassed).toBe(count - 1)
    }
    expect(demonstrationProgressAt(timeline, 0)).toMatchObject({ complete: false, completedSteps: 1,
      metrics: { slalomPhase: 1, slalomFlagsPassed: 0, slalomExited: 0, slalomRecovered: 0 } })
  })

  it('rejects insufficient turning authority without fabricating a route or changing the camera', () => {
    const base = createTuningPreset('beginner')
    const settings = { ...base, controller: { ...base.controller,
      rateLimitsDegPerSec: { ...base.controller.rateLimitsDegPerSec, roll: 20 } } }
    expect(() => createTeachingDemonstration(settings, 'slalom')).toThrow(/角速度|推力/)
  })
})
