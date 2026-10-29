import { describe, expect, it, vi } from 'vitest'
import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { calculateFpvCameraTransform } from '../rendering/camera'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createTeachingDemonstration, teachingReverseOrbitPhaseAt } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { createReverseOrbitTarget, REVERSE_ORBIT_LESSON, REVERSE_ORBIT_PHASE_IDS, REVERSE_ORBIT_REQUIRED_LAPS, reverseOrbitEvaluator } from './reverseOrbit'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

function evaluateRecording(settings: TuningSettings, demo: ReturnType<typeof createTeachingDemonstration>) {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'reverse-orbit-zone', kind: 'zone', positionM: createReverseOrbitTarget(launch, settings.drone.ground.heightM) }]
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  const observations: TrainingEvaluation[] = []
  for (const [index, pose] of demo.recording.samples.entries()) {
    const supportOffsetM = droneGroundSupport(settings.drone, pose.orientation).supportOffsetM
    const sample: TrainingSample = { timestampSeconds: pose.timestampSeconds, armed: true, normalizedInput: pose.normalizedInput,
      fpvCamera: settings.camera,
      groundContact: { heightM: settings.drone.ground.heightM, supportOffsetM,
        touching: pose.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 },
      state: { ...createInitialDroneState(settings.drone), positionM: pose.positionM, orientation: pose.orientation,
        velocityMps: pose.velocityMps, angularVelocityBodyRadPerSec: pose.angularVelocityBodyRadPerSec,
        timeSeconds: pose.timestampSeconds, stepIndex: index } }
    evaluation = reverseOrbitEvaluator.evaluate(sample, { lesson: REVERSE_ORBIT_LESSON, mode: 'practice', elapsedSeconds: pose.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    expect(evaluation.status, JSON.stringify({ t: pose.timestampSeconds, evaluation })).not.toBe('failure')
    expect(evaluation.metrics?.reverseOrbitInterrupted).toBe(0)
    expect(teachingReverseOrbitPhaseAt(demo, pose.timestampSeconds)).toBe(evaluation.metrics?.reverseOrbitPhase)
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    observations.push(evaluation)
    previous = sample
  }
  return { checkpoints, evaluation, observations }
}

describe('actual upward-looking three-circle teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('flies three circles with a genuinely upward camera, then actually departs with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'reverse-orbit')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    const target = createReverseOrbitTarget(launch, settings.drone.ground.heightM)
    const halfCraneHeightM = (target.y - settings.drone.ground.heightM) / 2
    expect(demo).toMatchObject({ lessonId: 'reverse-orbit', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L16 倒刷鍋')
    expect(demo.recording.samples[0].positionM).toEqual(launch)
    expect(demo.recording).toMatchObject({ capacity: 8_000, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(120)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const times = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => times.has(cue.timeSeconds) && cue.targetReferenceId === 'reverse-orbit-zone')).toBe(true)
    expect(demo.cues.at(-1)).toMatchObject({ timeSeconds: demo.recording.durationSeconds, reverseOrbitPhase: 7 })
    const { evaluation, checkpoints, observations } = evaluateRecording(settings, demo)
    expect(evaluation?.status).toBe('success')
    expect(REVERSE_ORBIT_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    expect(evaluation?.metrics?.reverseOrbitProgressDegrees).toBeGreaterThanOrEqual(1080)
    expect(evaluation?.metrics?.reverseOrbitCompletedLaps).toBe(REVERSE_ORBIT_REQUIRED_LAPS)
    const startAt = demo.cues.find(({ reverseOrbitPhase }) => reverseOrbitPhase === 3)!.timeSeconds
    const exitAt = demo.cues.find(({ reverseOrbitPhase }) => reverseOrbitPhase === 6)!.timeSeconds
    const quadrants = new Set<string>()
    let genuineUpwardObservations = 0
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => value >= 0 && value <= 1)).toBe(true)
      if (pose.timestampSeconds > startAt + 1 && pose.timestampSeconds < exitAt) {
        expect(pose.positionM.y - settings.drone.ground.heightM).toBeGreaterThan(halfCraneHeightM - 0.5)
        expect(pose.positionM.y - settings.drone.ground.heightM).toBeLessThan(halfCraneHeightM + 0.5)
        const camera = calculateFpvCameraTransform(pose, settings.camera)
        const view = rotateVectorByQuaternion(camera.orientation, { x: 0, y: 0, z: -1 })
        const toTarget = { x: target.x - camera.position.x, y: target.y - camera.position.y, z: target.z - camera.position.z }
        const targetLength = Math.hypot(toTarget.x, toTarget.y, toTarget.z)
        const dot = (view.x * toTarget.x + view.y * toTarget.y + view.z * toTarget.z) / targetLength
        expect(view.y).toBeGreaterThan(Math.sin(35 * Math.PI / 180))
        expect(dot).toBeGreaterThan(Math.cos(settings.camera.fpvFovDegrees / 2 * Math.PI / 180))
        expect(rotateVectorByQuaternion(pose.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(0.087)
        expect(Math.hypot(toTarget.x, toTarget.z)).toBeGreaterThan(8)
        expect(Math.hypot(toTarget.x, toTarget.z)).toBeLessThan(12)
        quadrants.add(`${Math.sign(toTarget.x)},${Math.sign(toTarget.z)}`)
        genuineUpwardObservations += 1
      }
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
    expect(genuineUpwardObservations).toBeGreaterThan(500)
    expect(quadrants.size).toBe(4)
    for (let lap = 1; lap <= 3; lap += 1) {
      const observed = observations.find(({ metrics }) => metrics?.reverseOrbitCompletedLaps === lap)!
      expect(observed.metrics?.reverseOrbitProgressDegrees).toBeGreaterThanOrEqual(lap * 360)
      expect(observed.metrics?.reverseOrbitProgressDegrees).toBeLessThan(lap * 360 + 3)
      expect(observed.metrics?.reverseOrbitTargetViewErrorDegrees).toBeLessThan(settings.camera.fpvFovDegrees / 2 - 3)
      expect(observed.status).toBe('continue')
    }
    const end = demo.recording.samples.at(-1)!
    expect(Math.hypot(end.positionM.x - target.x, end.positionM.z - target.z)).toBeGreaterThan(17)
    expect(evaluation?.metrics?.reverseOrbitExitDistanceM).toBeGreaterThanOrEqual(3)
    expect(end.positionM.y - settings.drone.ground.heightM).toBeCloseTo(halfCraneHeightM, 0)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(5 * Math.PI / 180))
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('uses one grounded reset and fixed-step RC input instead of replacing the recorded position or attitude', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'reverse-orbit')
      expect(reset).toHaveBeenCalledTimes(1)
      expect(step.mock.calls.length).toBeGreaterThan(demo.recording.samples.length)
      expect(step.mock.calls.every(([input, dt]) => input !== null && dt === 1 / 240
        && input.roll >= -1 && input.roll <= 1 && input.pitch >= -1 && input.pitch <= 1
        && input.yaw >= -1 && input.yaw <= 1 && input.throttle >= 0 && input.throttle <= 1)).toBe(true)
    } finally { reset.mockRestore(); step.mockRestore() }
  })

  it('rejects insufficient angular rate rather than modifying the pose or camera to simulate the move', () => {
    const base = createTuningPreset('beginner')
    const settings = { ...base, controller: { ...base.controller,
      rateLimitsDegPerSec: { ...base.controller.rateLimitsDegPerSec, yaw: 20 } } }
    expect(() => createTeachingDemonstration(settings, 'reverse-orbit')).toThrow(/角速度|推力/)
  })
})
