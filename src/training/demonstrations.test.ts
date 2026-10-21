import { describe, expect, it } from 'vitest'

import { createInitialDroneState, droneGroundSupport } from '../drone'
import { quaternionNorm } from '../math/quaternion'
import { ReplayPlayback, type ReplaySample } from '../replay'
import { createDefaultTuningSettings, type TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createTeachingDemonstration, teachingCueAt } from './demonstrations'
import { DEFAULT_LESSONS } from './lessons'
import { LANDING_LESSON, landingEvaluator } from './landing'
import { STRAIGHT_LINE_LESSON, straightLineEvaluator } from './straightLine'
import { takeoffEvaluator } from './takeoff'
import { TrainingSession } from './machine'
import { CURRENT_TRAINING_RULES_VERSION } from './attempt'
import { createTrainingFieldAnchors } from './field'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample, TrainingSceneReference } from './types'

function at(samples: readonly ReplaySample[], timeSeconds: number): ReplaySample {
  const sample = samples.reduce((closest, candidate) => (
    Math.abs(candidate.timestampSeconds - timeSeconds) < Math.abs(closest.timestampSeconds - timeSeconds) ? candidate : closest
  ))
  return sample
}

function orientationAngleDegrees(sample: ReplaySample): number {
  return 2 * Math.acos(Math.min(1, Math.abs(sample.orientation.w))) * 180 / Math.PI
}

function geometricSample(settings: TuningSettings, pose: ReplaySample): TrainingSample {
  const supportOffsetM = droneGroundSupport(settings.drone, pose.orientation).supportOffsetM
  return {
    timestampSeconds: pose.timestampSeconds,
    armed: true,
    normalizedInput: pose.normalizedInput,
    groundContact: {
      heightM: settings.drone.ground.heightM,
      supportOffsetM,
      touching: pose.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5,
    },
    state: {
      ...createInitialDroneState(settings.drone),
      ...pose,
      timeSeconds: pose.timestampSeconds,
      stepIndex: Math.round(pose.timestampSeconds * 240),
    },
  }
}


function referencesFor(settings: TuningSettings): readonly TrainingSceneReference[] {
  const { pad, launch, landing } = createTrainingFieldAnchors(settings.drone)
  return [
    { id: 'takeoff-pad', kind: 'pad', positionM: pad },
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
  ]
}

describe('bounded simulation teaching recordings', () => {
  it('records finite synchronized poses and normalized input without mutating tuning', () => {
    const settings = createTuningPreset('beginner')
    const before = JSON.stringify(settings)
    for (const kind of ['takeoff', 'roll', 'pitch', 'yaw'] as const) {
      const demo = createTeachingDemonstration(settings, kind)
      expect(demo.source).toBe('simulated')
      expect(demo.description).toContain('尚待真人飛手驗證')
      expect(demo.recording.samples.length).toBeGreaterThan(300)
      expect(demo.recording.samples.length).toBeLessThanOrEqual(800)
      expect(demo.recording.droppedSamples).toBe(0)
      expect(demo.recording.durationSeconds).toBeLessThanOrEqual(10.01)
      expect(Object.isFrozen(demo.recording.samples)).toBe(true)
      for (let index = 1; index < demo.recording.samples.length; index += 1) {
        const sample = demo.recording.samples[index]
        const previous = demo.recording.samples[index - 1]
        const dt = sample.timestampSeconds - previous.timestampSeconds
        expect(dt).toBeGreaterThan(0)
        expect(dt).toBeLessThan(0.02)
        expect(quaternionNorm(sample.orientation)).toBeCloseTo(1, 8)
        expect(Object.values(sample.positionM).every(Number.isFinite)).toBe(true)
        expect(sample.normalizedInput).not.toBeNull()
        expect(sample.normalizedInput?.throttle).toBeGreaterThan(0)
        expect(sample.normalizedInput?.throttle).toBeLessThanOrEqual(0.85)
        // A recorder sample must follow continuous integrated motion, not jump between authored poses.
        const integrationError = Math.hypot(
          sample.positionM.x - previous.positionM.x - (sample.velocityMps.x + previous.velocityMps.x) * 0.5 * dt,
          sample.positionM.y - previous.positionM.y - (sample.velocityMps.y + previous.velocityMps.y) * 0.5 * dt,
          sample.positionM.z - previous.positionM.z - (sample.velocityMps.z + previous.velocityMps.z) * 0.5 * dt,
        )
        expect(integrationError).toBeLessThan(0.003)
      }
    }
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('records versioned immutable metadata and retains complete landing/straight examples within a fixed bound', () => {
    const settings = createTuningPreset('beginner')
    for (const kind of ['landing', 'straight-line'] as const) {
      const demo = createTeachingDemonstration(settings, kind)
      expect(demo).toMatchObject({ schemaVersion: 1, rulesVersion: CURRENT_TRAINING_RULES_VERSION, physicsVersion: 1, presetId: 'beginner' })
      expect(demo.settingsFingerprint).toContain('settings.v1:')
      expect(Object.isFrozen(demo)).toBe(true)
      expect(Object.isFrozen(demo.cues)).toBe(true)
      expect(demo.cues.every(Object.isFrozen)).toBe(true)
      expect(demo.recording.durationSeconds).toBeGreaterThanOrEqual(26.9)
      expect(demo.recording.durationSeconds).toBeLessThanOrEqual(32.01)
      expect(demo.recording.samples.length).toBeLessThanOrEqual(2_100)
      expect(demo.recording.droppedSamples).toBe(0)
      expect(Object.isFrozen(demo.recording.samples)).toBe(true)
    }
  })

  it.each([
    ['landing', LANDING_LESSON, landingEvaluator],
    ['straight-line', STRAIGHT_LINE_LESSON, straightLineEvaluator],
  ] as const)('flies a continuous real %s recording which passes its evaluator', (kind, lesson, evaluator) => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, kind)
    const first = geometricSample(settings, demo.recording.samples[0]!)
    expect(first.groundContact?.touching).toBe(true)
    expect(at(demo.recording.samples, 3).positionM.y).toBeGreaterThan(first.state.positionM.y + 0.8)
    expect(at(demo.recording.samples, 3).positionM.z).toBeCloseTo(settings.drone.spawnPositionM.z, 3)
    const checkpoints: Record<string, TrainingCheckpointState> = Object.fromEntries(lesson.checkpoints.map((checkpoint) => [
      checkpoint.id, { id: checkpoint.id, completed: false, completedAtSeconds: null, metrics: {} },
    ]))
    let previousSample: TrainingSample | null = null
    let previousEvaluation: TrainingEvaluation | null = null
    let success = false
    for (const pose of demo.recording.samples) {
      const sample = geometricSample(settings, pose)
      const evaluation = evaluator.evaluate(sample, {
        lesson,
        elapsedSeconds: pose.timestampSeconds,
        trajectory: [],
        checkpoints,
        sceneReferences: referencesFor(settings),
        previousSample,
        previousFlightSample: previousSample,
        previousEvaluation,
        mode: 'challenge',
      })
      expect(evaluation.status, JSON.stringify({ time: pose.timestampSeconds, message: evaluation.message, metrics: evaluation.metrics, contact: sample.groundContact, previousContact: previousSample?.groundContact, velocity: pose.velocityMps, previousVelocity: previousSample?.state.velocityMps })).not.toBe('failure')
      for (const id of evaluation.checkpointIds ?? []) {
        checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: evaluation.metrics ?? {} }
      }
      if (evaluation.status === 'success') {
        success = true
        break
      }
      previousSample = sample
      previousEvaluation = evaluation
    }
    expect(success, JSON.stringify(previousEvaluation)).toBe(true)
    expect(Object.values(checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
    if (kind === 'landing') {
      const final = geometricSample(settings, demo.recording.samples[demo.recording.samples.length - 1])
      expect(final.groundContact?.touching).toBe(true)
      expect(Math.abs(final.state.velocityMps.y)).toBeLessThan(0.2)
    }
  })

  it('shows that centered Acro sticks stop rotation without automatically restoring attitude', () => {
    for (const kind of ['roll', 'pitch', 'yaw'] as const) {
      const { recording } = createTeachingDemonstration(createDefaultTuningSettings(), kind)
      const rotating = at(recording.samples, 1.7)
      const centered = at(recording.samples, 3)
      const restored = at(recording.samples, 6)
      expect(rotating.normalizedInput?.[kind]).toBeGreaterThan(0)
      expect(centered.normalizedInput?.[kind]).toBe(0)
      expect(Math.hypot(...Object.values(centered.angularVelocityBodyRadPerSec))).toBeLessThan(0.2)
      expect(orientationAngleDegrees(centered)).toBeGreaterThan(5)
      expect(orientationAngleDegrees(restored)).toBeLessThan(orientationAngleDegrees(centered) * 0.4)
    }
  })

  it.each([[5, 0], [0, 10]])('keeps ground-start demonstrations independent of free-flight spawn (ground %s, spawn %s)', (groundHeight, spawnHeight) => {
    const defaults = createTuningPreset('beginner')
    const settings = { ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: groundHeight }, spawnPositionM: { x: 6, y: spawnHeight, z: -3 } } }
    const { pad, launch } = createTrainingFieldAnchors(settings.drone)
    for (const kind of ['takeoff', 'landing', 'straight-line'] as const) {
      const demo = createTeachingDemonstration(settings, kind)
      expect(demo.recording.samples[0]!.positionM).toEqual(kind === 'takeoff' ? pad : launch)
      const session = new TrainingSession({
        initialLessonId: kind, countdownDurationSeconds: 0,
        sceneReferences: referencesFor(settings),
      })
      session.start(0)
      session.tick(0)
      for (const pose of demo.recording.samples) {
        session.consumeSample(geometricSample(settings, pose))
        if (['SUCCESS', 'FAILED'].includes(session.getState().phase)) break
      }
      expect(session.getState().phase, `${kind}: ${session.getState().result?.message}`).toBe('SUCCESS')
    }
    expect(settings.drone.spawnPositionM.y).toBe(spawnHeight)
  })

  it('flies an actual generated takeoff whose recorded geometry passes the takeoff checkpoints', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'takeoff')
    const lesson = DEFAULT_LESSONS.find((candidate) => candidate.id === 'takeoff')
    if (!lesson) throw new Error('takeoff lesson missing')
    const checkpoints: Record<string, TrainingCheckpointState> = Object.fromEntries(lesson.checkpoints.map((checkpoint) => [
      checkpoint.id, { id: checkpoint.id, completed: false, completedAtSeconds: null, metrics: {} },
    ]))
    let previousSample: TrainingSample | null = null
    let previousEvaluation: TrainingEvaluation | null = null
    let success = false
    for (const pose of demo.recording.samples) {
      // Replay retains geometry/input, not motors or PID state; only project the measured fields for this evaluator check.
      const sample: TrainingSample = {
        timestampSeconds: pose.timestampSeconds,
        armed: true,
        normalizedInput: pose.normalizedInput,
        state: {
          ...createInitialDroneState(settings.drone),
          ...pose,
          timeSeconds: pose.timestampSeconds,
          stepIndex: Math.round(pose.timestampSeconds * 240),
        },
      }
      const evaluation = takeoffEvaluator.evaluate(sample, {
        lesson,
        elapsedSeconds: pose.timestampSeconds,
        trajectory: [],
        checkpoints,
        sceneReferences: [{ id: 'takeoff-pad', kind: 'pad', positionM: settings.drone.spawnPositionM }],
        previousSample,
        previousEvaluation,
      })
      expect(evaluation.status, evaluation.message).not.toBe('failure')
      for (const id of evaluation.checkpointIds ?? []) {
        checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: evaluation.metrics ?? {} }
      }
      if (evaluation.status === 'success') {
        success = true
        break
      }
      previousSample = sample
      previousEvaluation = evaluation
    }
    expect(success).toBe(true)
    expect(Object.values(checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
  })

  it('uses the same relative playback clock for pose, input and captions after pause, speed and seek', () => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'roll')
    const player = new ReplayPlayback(demo.recording)
    player.setSpeed(0.5)
    player.play()
    player.advance(3)
    expect(player.currentTime).toBeCloseTo(1.5)
    expect(player.getGhostState()?.normalizedInput?.roll).toBeGreaterThan(0)
    expect(teachingCueAt(demo, player.currentTime)).toContain('小量推動')
    player.pause()
    player.advance(10)
    expect(player.currentTime).toBeCloseTo(1.5)
    player.seek(3)
    expect(player.getGhostState()?.normalizedInput?.roll).toBe(0)
    expect(teachingCueAt(demo, player.currentTime)).toContain('Acro 不會自動回到原來姿態')
    player.seek(4)
    expect(player.getGhostState()?.normalizedInput?.roll).toBeLessThan(0)
    expect(teachingCueAt(demo, player.currentTime)).toContain('反向小量修正')
  })

  it('fails explicitly for unusable thrust or disabled angular rates instead of fabricating a successful flight', () => {
    const settings = createDefaultTuningSettings()
    expect(() => createTeachingDemonstration({ ...settings, drone: { ...settings.drone, massKg: 5 } }, 'takeoff'))
      .toThrow(/推力不足/)
    expect(() => createTeachingDemonstration({
      ...settings,
      controller: { ...settings.controller, rateLimitsDegPerSec: { ...settings.controller.rateLimitsDegPerSec, roll: 0 } },
    }, 'roll')).toThrow(/角速度限制不足/)
  })
})
