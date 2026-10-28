import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createTeachingDemonstration, teachingOrbitPhaseAt } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { createOrbitTarget, ORBIT_LESSON, ORBIT_PHASE_IDS, ORBIT_REQUIRED_LAPS, ORBIT_COMPLETION_DEGREES, ORBIT_TARGET_HEIGHT_M, orbitLearningEvaluator } from './orbit'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

function evaluateRecording(settings: TuningSettings, demo: ReturnType<typeof createTeachingDemonstration>) {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const references = [{ id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
    { id: 'orbit-zone', kind: 'zone', positionM: createOrbitTarget(launch, settings.drone.ground.heightM) }]
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
    evaluation = orbitLearningEvaluator.evaluate(sample, { lesson: ORBIT_LESSON, mode: 'practice', elapsedSeconds: pose.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    expect(evaluation.status, JSON.stringify({ t: pose.timestampSeconds, evaluation })).not.toBe('failure')
    expect(evaluation.metrics?.orbitInterrupted).toBe(0)
    expect(teachingOrbitPhaseAt(demo, pose.timestampSeconds)).toBe(evaluation.metrics?.orbitPhase)
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    observations.push(evaluation)
    previous = sample
  }
  return { checkpoints, evaluation, observations }
}

describe('actual inward-facing orbit teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('flies five real circles facing the target, then slows and recovers with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'orbit')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    const target = createOrbitTarget(launch, settings.drone.ground.heightM)
    expect(demo).toMatchObject({ lessonId: 'orbit', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L15 正刷鍋')
    expect(demo.recording.samples[0].positionM).toEqual(launch)
    expect(demo.recording).toMatchObject({ capacity: 12_000, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeGreaterThan(20)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(180)
    expect(demo.recording.samples.length).toBeLessThan(12_000)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const times = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => times.has(cue.timeSeconds) && cue.targetReferenceId === 'orbit-zone')).toBe(true)
    expect(demo.cues.at(-1)).toMatchObject({ timeSeconds: demo.recording.durationSeconds, orbitPhase: 9 })
    expect(demo.cues.at(-1)?.text).toContain('正刷鍋九步已完成')
    const orbitStart = demo.cues.find(({ text }) => text.startsWith('現在開始側向環繞'))!.timeSeconds
    const exitStart = demo.cues.find(({ text }) => text.startsWith('現在開始減速改出'))!.timeSeconds
    const quadrants = new Set<string>()
    let signedTurn = 0
    let previousAngle = Math.atan2(launch.z - target.z, launch.x - target.x)
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => value >= 0 && value <= 1)).toBe(true)
      const angle = Math.atan2(pose.positionM.z - target.z, pose.positionM.x - target.x)
      signedTurn += Math.atan2(Math.sin(angle - previousAngle), Math.cos(angle - previousAngle))
      previousAngle = angle
      if (pose.timestampSeconds > orbitStart + 2 && pose.timestampSeconds < exitStart) {
        const dx = target.x - pose.positionM.x
        const dz = target.z - pose.positionM.z
        const radius = Math.hypot(dx, dz)
        const forward = rotateVectorByQuaternion(pose.orientation, { x: 0, y: 0, z: -1 })
        const facing = (forward.x * dx + forward.z * dz) / (Math.hypot(forward.x, forward.z) * radius)
        expect(radius).toBeGreaterThan(14)
        expect(radius).toBeLessThan(16)
        expect(facing).toBeGreaterThan(Math.cos(10 * Math.PI / 180))
        expect(pose.positionM.y - settings.drone.ground.heightM).toBeCloseTo(ORBIT_TARGET_HEIGHT_M, 0)
        quadrants.add(`${Math.sign(dx)},${Math.sign(dz)}`)
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
    expect(Math.abs(signedTurn)).toBeGreaterThan(ORBIT_REQUIRED_LAPS * 2 * Math.PI)
    expect(quadrants.size).toBe(4)
    const { evaluation, checkpoints } = evaluateRecording(settings, demo)
    expect(evaluation?.status).toBe('success')
    expect(ORBIT_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    expect(evaluation?.metrics?.orbitProgressDegrees).toBeGreaterThanOrEqual(ORBIT_COMPLETION_DEGREES)
    expect(evaluation?.metrics?.orbitCompletedLaps).toBe(ORBIT_REQUIRED_LAPS)
    const end = demo.recording.samples.at(-1)!
    const endRadius = Math.hypot(end.positionM.x - target.x, end.positionM.z - target.z)
    const endRadialSpeed = ((end.positionM.x - target.x) * end.velocityMps.x + (end.positionM.z - target.z) * end.velocityMps.z) / endRadius
    expect(endRadius).toBeGreaterThan(22)
    expect(endRadialSpeed).toBeGreaterThan(0.5)
    expect(evaluation?.metrics?.orbitExitDistanceM).toBeGreaterThanOrEqual(3)
    expect(end.positionM.y - settings.drone.ground.heightM).toBeCloseTo(ORBIT_TARGET_HEIGHT_M, 0)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(5 * Math.PI / 180))
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('uses one grounded reset then only fixed-step normalized RC commands', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'orbit')
      expect(reset).toHaveBeenCalledTimes(1)
      expect(step.mock.calls.length).toBeGreaterThan(demo.recording.samples.length)
      expect(step.mock.calls.every(([input, dt]) => input !== null && dt === 1 / 240
        && input.roll >= -1 && input.roll <= 1 && input.pitch >= -1 && input.pitch <= 1
        && input.yaw >= -1 && input.yaw <= 1 && input.throttle >= 0 && input.throttle <= 1)).toBe(true)
    } finally { reset.mockRestore(); step.mockRestore() }
  })

  it('rejects insufficient yaw rate instead of moving the recorded pose directly', () => {
    const base = createTuningPreset('beginner')
    const settings = { ...base, controller: { ...base.controller,
      rateLimitsDegPerSec: { ...base.controller.rateLimitsDegPerSec, yaw: 20 } } }
    expect(() => createTeachingDemonstration(settings, 'orbit')).toThrow(/角速度|推力/)
  })
})
