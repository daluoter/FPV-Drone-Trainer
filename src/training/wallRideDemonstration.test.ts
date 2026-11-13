import { describe, expect, it, vi } from 'vitest'
import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import { findSweptObstacleHit } from '../simulation/obstacles'
import type { TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createWallRide, WALL_RIDE_DISTANCE_M, WALL_RIDE_REFERENCE_IDS, WALL_RIDE_SECONDS } from '../world/wallRide'
import { createDemonstrationProgress, demonstrationProgressAt } from './demonstrationProgress'
import { createTeachingDemonstration, teachingWallRidePhaseAt } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { WALL_RIDE_LESSON, WALL_RIDE_PHASE_IDS, wallRideEvaluator } from './wallRide'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

function evaluateRecording(settings: TuningSettings, demo: ReturnType<typeof createTeachingDemonstration>) {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const wall = createWallRide(launch, settings.drone.ground.heightM)
  const points = [wall.entryM, wall.rideStartM, wall.rideEndM, wall.exitM]
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    ...WALL_RIDE_REFERENCE_IDS.map((id, index) => ({ id, kind: 'marker', positionM: points[index] }))]
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
    evaluation = wallRideEvaluator.evaluate(sample, { lesson: WALL_RIDE_LESSON, mode: 'practice', elapsedSeconds: pose.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous,
      previousFlightSample: previous, previousEvaluation: evaluation })
    expect(evaluation.status, JSON.stringify({ t: pose.timestampSeconds, evaluation })).not.toBe('failure')
    expect(evaluation.metrics?.wallRideInterrupted, JSON.stringify({ t: pose.timestampSeconds, evaluation })).toBe(0)
    expect(teachingWallRidePhaseAt(demo, pose.timestampSeconds)).toBe(evaluation.metrics?.wallRidePhase)
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true,
      completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    previous = sample
  }
  return { checkpoints, evaluation }
}

describe('actual non-contact wall-ride teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('takes off, banks belly toward the wall, travels beside it and recovers with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const beforeSettings = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'wall-ride')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    const wall = createWallRide(launch, settings.drone.ground.heightM)
    expect(demo).toMatchObject({ kind: 'wall-ride', lessonId: 'wall-ride', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L20 騎牆')
    expect(demo.recording.samples[0].positionM).toEqual(launch)
    expect(demo.recording).toMatchObject({ capacity: 4_000, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeGreaterThan(10)
    expect(demo.recording.durationSeconds).toBeLessThan(45)
    expect(demo.recording.samples.length).toBeLessThan(demo.recording.capacity)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds))).toBe(true)
    expect(demo.cues.at(-1)).toMatchObject({ timeSeconds: demo.recording.durationSeconds, wallRidePhase: 8,
      targetReferenceId: 'wall-ride-exit' })
    const banked = demo.recording.samples.filter((pose) => {
      const up = rotateVectorByQuaternion(pose.orientation, { x: 0, y: 1, z: 0 })
      return -up.x >= Math.cos(45 * Math.PI / 180) && pose.positionM.z <= wall.nearZM
    })
    expect(banked.length).toBeGreaterThan(20)
    expect(banked[0].positionM.z - banked.at(-1)!.positionM.z).toBeGreaterThanOrEqual(WALL_RIDE_DISTANCE_M)
    expect(banked.at(-1)!.timestampSeconds - banked[0].timestampSeconds).toBeGreaterThanOrEqual(WALL_RIDE_SECONDS)
    expect(banked[0].positionM.y - banked.at(-1)!.positionM.y).toBeGreaterThan(1)
    expect(Math.min(...banked.map((pose) => wall.faceXM - pose.positionM.x))).toBeGreaterThan(0.8)
    expect(Math.max(...banked.map((pose) => wall.faceXM - pose.positionM.x))).toBeLessThan(5)
    expect(banked.every((pose) => pose.velocityMps.z < -1)).toBe(true)
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => value >= 0 && value <= 1)).toBe(true)
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
      expect(findSweptObstacleHit(previous.positionM, pose.positionM, 0.3, wall.colliders)).toBeNull()
    }
    const { evaluation, checkpoints } = evaluateRecording(settings, demo)
    expect(evaluation?.status).toBe('success')
    expect(evaluation?.metrics).toMatchObject({ wallRidePhase: 8, wallRideInterrupted: 0 })
    expect(evaluation?.metrics?.wallRideDistanceM).toBeGreaterThanOrEqual(WALL_RIDE_DISTANCE_M)
    expect(WALL_RIDE_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    const end = demo.recording.samples.at(-1)!
    expect(wall.faceXM - end.positionM.x).toBeGreaterThan(5.5)
    expect(end.positionM.y).toBeGreaterThan(settings.drone.ground.heightM + 3)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(30 * Math.PI / 180))
    expect(JSON.stringify(settings)).toBe(beforeSettings)
  })

  it('uses one supported-ground reset with the solid wall, then only fixed-step normalized RC inputs', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const resetAt = vi.spyOn(FlightSimulation.prototype, 'resetAt')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const settings = createTuningPreset('beginner')
      const demo = createTeachingDemonstration(settings, 'wall-ride')
      const { launch } = createTrainingFieldAnchors(settings.drone)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(reset).toHaveBeenCalledWith(launch, { x: 0, y: 0, z: 0, w: 1 }, createWallRide(launch, settings.drone.ground.heightM).colliders)
      expect(resetAt).toHaveBeenCalledTimes(1)
      expect(step.mock.calls.length).toBeGreaterThan(demo.recording.samples.length)
      expect(step.mock.calls.every(([input, dt]) => input !== null && dt === 1 / 240
        && input.roll >= -1 && input.roll <= 1 && input.pitch >= -1 && input.pitch <= 1
        && input.yaw >= -1 && input.yaw <= 1 && input.throttle >= 0 && input.throttle <= 1)).toBe(true)
    } finally { reset.mockRestore(); resetAt.mockRestore(); step.mockRestore() }
  })

  it('seeks independent observed bank/travel/recovery progress without retaining later motion proof', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'wall-ride')
    const timeline = createDemonstrationProgress(demo, settings)
    const end = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(end).toMatchObject({ complete: true, totalSteps: 8, completedSteps: 8,
      metrics: { wallRidePhase: 8, wallRideInterrupted: 0 } })
    expect(timeline.frames.length).toBe(demo.recording.samples.length + 1)
    const bankAt = end.steps[4].completedAtSeconds!
    const traveledAt = end.steps[5].completedAtSeconds!
    const bank = demonstrationProgressAt(timeline, bankAt)
    expect(bank.completedSteps).toBe(5)
    expect(bank.metrics?.wallRideDistanceM).toBeLessThan(WALL_RIDE_DISTANCE_M)
    expect(demonstrationProgressAt(timeline, traveledAt).metrics?.wallRideDistanceM).toBeGreaterThanOrEqual(WALL_RIDE_DISTANCE_M)
    expect(demonstrationProgressAt(timeline, traveledAt - 0.001).complete).toBe(false)
    demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(demonstrationProgressAt(timeline, bankAt)).toEqual(bank)
    const samples = demo.recording.samples.filter((pose) => pose.timestampSeconds < traveledAt)
    const truncated = { ...demo, recording: { ...demo.recording, samples,
      durationSeconds: samples.at(-1)!.timestampSeconds }, cues: [{ timeSeconds: 0, text: '八步完成', wallRidePhase: 8 }] }
    const partial = createDemonstrationProgress(truncated, settings)
    expect(demonstrationProgressAt(partial, partial.durationSeconds)).toMatchObject({ complete: false, completedSteps: 5 })
    expect(demonstrationProgressAt(timeline, 0)).toMatchObject({ complete: false, completedSteps: 1,
      metrics: { wallRidePhase: 1, wallRideDistanceM: 0 } })
  })

  it('rejects insufficient rolling authority without fabricating position, support or contact', () => {
    const base = createTuningPreset('beginner')
    const settings = { ...base, controller: { ...base.controller,
      rateLimitsDegPerSec: { ...base.controller.rateLimitsDegPerSec, roll: 20 } } }
    expect(() => createTeachingDemonstration(settings, 'wall-ride')).toThrow(/角速度|推力/)
  })
})
