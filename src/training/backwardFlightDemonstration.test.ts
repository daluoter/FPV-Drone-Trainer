import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { BACKWARD_FLIGHT_LESSON, BACKWARD_FLIGHT_PHASE_IDS, backwardFlightEvaluator } from './backwardFlight'
import { createTeachingDemonstration, teachingBackwardFlightPhaseAt } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
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
    evaluation = backwardFlightEvaluator.evaluate(sample, { lesson: BACKWARD_FLIGHT_LESSON, mode: 'practice', elapsedSeconds: pose.timestampSeconds,
      sceneReferences: references, checkpoints, trajectory: [], previousSample: previous, previousFlightSample: previous, previousEvaluation: evaluation })
    expect(evaluation.status, JSON.stringify({ t: pose.timestampSeconds, evaluation })).not.toBe('failure')
    expect(evaluation.metrics?.backwardInterrupted).toBe(0)
    expect(teachingBackwardFlightPhaseAt(demo, pose.timestampSeconds)).toBe(evaluation.metrics?.backwardPhase)
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    observations.push(evaluation)
    previous = sample
  }
  return { checkpoints, evaluation, observations }
}

describe('actual upright backward-flight teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('builds forward momentum, yaws, actually flies backward and brakes with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'backward-flight')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    expect(demo).toMatchObject({ lessonId: 'backward-flight', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L17 後退飛行')
    expect(demo.recording.samples[0].positionM).toEqual(launch)
    expect(demo.recording).toMatchObject({ capacity: 3_000, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeGreaterThan(8)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(45)
    expect(demo.recording.samples.length).toBeLessThan(3_000)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const times = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => times.has(cue.timeSeconds) && cue.targetReferenceId === 'backward-zone')).toBe(true)
    expect(demo.cues.at(-1)).toMatchObject({ timeSeconds: demo.recording.durationSeconds, backwardPhase: 7 })
    expect(demo.cues.at(-1)?.text).toContain('後退飛行七步已完成')
    let sawForward = false
    let backwardSpanM = 0
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => value >= 0 && value <= 1)).toBe(true)
      const up = rotateVectorByQuaternion(pose.orientation, { x: 0, y: 1, z: 0 })
      const forward = rotateVectorByQuaternion(pose.orientation, { x: 0, y: 0, z: -1 })
      expect(up.y).toBeGreaterThan(Math.cos(40 * Math.PI / 180))
      if (forward.z < -0.9 && pose.velocityMps.z < -1.5) sawForward = true
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
      if (forward.z > 0.5 && pose.velocityMps.z < -0.75) backwardSpanM += Math.max(0, previous.positionM.z - pose.positionM.z)
    }
    expect(sawForward).toBe(true)
    expect(backwardSpanM).toBeGreaterThanOrEqual(3)
    const { evaluation, checkpoints, observations } = evaluateRecording(settings, demo)
    expect(evaluation?.status).toBe('success')
    expect(BACKWARD_FLIGHT_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    expect(evaluation?.metrics?.backwardDistanceM).toBeGreaterThanOrEqual(3)
    expect(evaluation?.metrics?.backwardHoldSeconds).toBeGreaterThanOrEqual(0.6)
    expect(observations.some((entry) => (entry.metrics?.backwardSpeedMps ?? 0) > 3)).toBe(true)
    const end = demo.recording.samples.at(-1)!
    expect(Math.hypot(end.velocityMps.x, end.velocityMps.z)).toBeLessThan(1)
    expect(end.positionM.y - settings.drone.ground.heightM).toBeCloseTo(10, 0)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(20 * Math.PI / 180))
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('uses one grounded reset then only fixed-step normalized RC commands', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const resetAt = vi.spyOn(FlightSimulation.prototype, 'resetAt')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'backward-flight')
      expect(reset).toHaveBeenCalledTimes(1)
      expect(resetAt).toHaveBeenCalledTimes(1)
      expect(step.mock.calls.length).toBeGreaterThan(demo.recording.samples.length)
      expect(step.mock.calls.every(([input, dt]) => input !== null && dt === 1 / 240
        && input.roll >= -1 && input.roll <= 1 && input.pitch >= -1 && input.pitch <= 1
        && input.yaw >= -1 && input.yaw <= 1 && input.throttle >= 0 && input.throttle <= 1)).toBe(true)
    } finally { reset.mockRestore(); resetAt.mockRestore(); step.mockRestore() }
  })

  it('rejects insufficient yaw rate rather than fabricating a recorded turn', () => {
    const base = createTuningPreset('beginner')
    const settings = { ...base, controller: { ...base.controller,
      rateLimitsDegPerSec: { ...base.controller.rateLimitsDegPerSec, yaw: 20 } } }
    expect(() => createTeachingDemonstration(settings, 'backward-flight')).toThrow(/角速度|推力/)
  })
})
