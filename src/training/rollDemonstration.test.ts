import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { conjugateQuaternion, multiplyQuaternions, quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import { createTuningPreset } from '../tuning/presets'
import type { TuningSettings } from '../tuning/config'
import { createTeachingDemonstration } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { FULL_ROLL_LESSON, FULL_ROLL_PHASE_IDS, fullRollEvaluator } from './fullRoll'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

function evaluateRecording(settings: TuningSettings, recording: ReturnType<typeof createTeachingDemonstration>['recording']) {
  const { launch, landing } = createTrainingFieldAnchors(settings.drone)
  const references = [
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
  ]
  const checkpoints: Record<string, TrainingCheckpointState> = {}
  let previous: TrainingSample | null = null
  let evaluation: TrainingEvaluation | null = null
  for (const [index, pose] of recording.samples.entries()) {
    const supportOffsetM = droneGroundSupport(settings.drone, pose.orientation).supportOffsetM
    const sample: TrainingSample = {
      timestampSeconds: pose.timestampSeconds, armed: true, normalizedInput: pose.normalizedInput,
      groundContact: { heightM: settings.drone.ground.heightM, supportOffsetM,
        touching: pose.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 },
      state: { ...createInitialDroneState(settings.drone), positionM: pose.positionM, velocityMps: pose.velocityMps,
        orientation: pose.orientation, angularVelocityBodyRadPerSec: pose.angularVelocityBodyRadPerSec,
        stepIndex: index, timeSeconds: pose.timestampSeconds },
    }
    evaluation = fullRollEvaluator.evaluate(sample, {
      lesson: FULL_ROLL_LESSON, mode: 'practice', elapsedSeconds: sample.timestampSeconds,
      trajectory: [], checkpoints, sceneReferences: references, previousSample: previous,
      previousFlightSample: previous, previousEvaluation: evaluation,
    })
    expect(evaluation.status).not.toBe('failure')
    for (const id of evaluation.checkpointIds ?? []) checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
    previous = sample
  }
  return { evaluation, checkpoints }
}

describe('actual full-roll teaching recording', () => {
  it.each(['beginner', 'standard', 'raised-field'] as const)('flies from actual ground through a full roll and recovery with %s settings', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'full-roll')
    expect(demo).toMatchObject({ lessonId: 'full-roll', rulesVersion: 6, physicsVersion: 1, source: 'simulated' })
    expect(demo.title).toContain('L10')
    expect(demo.recording.samples[0].positionM).toEqual(createTrainingFieldAnchors(settings.drone).launch)
    expect(demo.recording).toMatchObject({ capacity: 7_500, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.durationSeconds).toBeGreaterThan(8)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(120)
    expect(demo.recording.samples.length).toBeLessThan(7_500)
    expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds) && cue.targetReferenceId === 'roll-zone')).toBe(true)
    expect(demo.cues.at(-1)?.timeSeconds).toBe(demo.recording.durationSeconds)
    expect(demo.cues.at(-1)?.fullRollPhase).toBe(6)
    expect(demo.cues.at(-1)?.text).toContain('完整橫滾與空中恢復')
    const ready = demo.cues.find((cue) => cue.fullRollPhase === 3)!
    const boost = demo.cues.find((cue) => cue.text.startsWith('先適量補油'))!
    expect(boost.timeSeconds - ready.timeSeconds).toBeGreaterThanOrEqual(2)

    let netRoll = 0
    let maximumRoll = 0
    let pitchMotion = 0
    let yawMotion = 0
    let observedInversion = false
    for (const [index, pose] of demo.recording.samples.entries()) {
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((command) => command >= 0 && command <= 1)).toBe(true)
      observedInversion ||= rotateVectorByQuaternion(pose.orientation, { x: 0, y: 1, z: 0 }).y < -0.9
      if (index === 0) continue
      const previous = demo.recording.samples[index - 1]
      const relative = multiplyQuaternions(conjugateQuaternion(previous.orientation), pose.orientation)
      const sign = relative.w < 0 ? -1 : 1
      netRoll += -2 * Math.atan2(relative.z * sign, relative.w * sign) * 180 / Math.PI
      maximumRoll = Math.max(maximumRoll, netRoll)
      const delta = pose.timestampSeconds - previous.timestampSeconds
      pitchMotion += Math.abs(pose.angularVelocityBodyRadPerSec.x) * delta * 180 / Math.PI
      yawMotion += Math.abs(pose.angularVelocityBodyRadPerSec.y) * delta * 180 / Math.PI
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBeLessThan(0.02)
    }
    // Actual quaternion winding and body-axis observations distinguish this
    // movie from a yaw turn, a pitch flip or a small bank-and-return example.
    expect(maximumRoll).toBeGreaterThanOrEqual(360)
    expect(maximumRoll).toBeLessThan(390)
    expect(observedInversion).toBe(true)
    expect(pitchMotion).toBeLessThan(35)
    expect(yawMotion).toBeLessThan(35)
    const { evaluation, checkpoints } = evaluateRecording(settings, demo.recording)
    expect(evaluation?.status).toBe('success')
    expect(FULL_ROLL_PHASE_IDS.every((id) => checkpoints[id]?.completed)).toBe(true)
    const end = demo.recording.samples.at(-1)!
    expect(end.positionM.y - settings.drone.ground.heightM).toBeGreaterThan(1.5)
    expect(rotateVectorByQuaternion(end.orientation, { x: 0, y: 1, z: 0 }).y).toBeGreaterThan(Math.cos(25 * Math.PI / 180))
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('uses the normal simulation reset and fixed-step RC path rather than changing an in-flight pose', () => {
    const reset = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const step = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'full-roll')
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

  it('rejects settings unable to finish a roll rather than manufacturing a completed movie', () => {
    const defaults = createTuningPreset('beginner')
    const slow = { ...defaults, controller: { ...defaults.controller,
      rateLimitsDegPerSec: { ...defaults.controller.rateLimitsDegPerSec, roll: 1 } } }
    expect(() => createTeachingDemonstration(slow, 'full-roll')).toThrow(/轉速|角速度|設定/)
  })
})
