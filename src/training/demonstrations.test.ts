import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, droneGroundContactRadius, droneGroundSupport } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { quaternionNorm, rotateVectorByQuaternion } from '../math/quaternion'
import { ReplayPlayback, type ReplaySample } from '../replay'
import { createDefaultTuningSettings, type TuningSettings } from '../tuning/config'
import { createTuningPreset } from '../tuning/presets'
import { createTeachingDemonstration, teachingCueAt, teachingRecoveryPhaseAt, teachingTargetAt } from './demonstrations'
import { DEFAULT_LESSONS } from './lessons'
import { LANDING_LESSON, landingEvaluator } from './landing'
import { STRAIGHT_LINE_LESSON, straightLineEvaluator } from './straightLine'
import { takeoffEvaluator } from './takeoff'
import { TrainingSession } from './machine'
import { CURRENT_TRAINING_RULES_VERSION } from './attempt'

import { createTrainingFieldAnchors } from './field'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import { DIRECTION_CONTROL_LESSON } from './directionControl'
import { COORDINATED_TURN_LESSON } from './coordinatedTurn'
import { SQUARE_ROUTE_LESSON } from './squareRoute'
import { FIGURE_EIGHT_LESSON } from './figureEight'
import { WIDE_GATE_LESSON } from './wideGate'
import {
  BASIC_RECOVERY_DRIFT_ONSET_MPS, BASIC_RECOVERY_DRIFT_STOP_MPS, BASIC_RECOVERY_HOLD_SECONDS,
  BASIC_RECOVERY_LESSON, BASIC_RECOVERY_LEVEL_DEGREES, BASIC_RECOVERY_MAX_BODY_RATE_DEGREES,
  BASIC_RECOVERY_MIN_HEIGHT_M, BASIC_RECOVERY_SINK_CLIMB_MPS, BASIC_RECOVERY_SINK_ONSET_MPS,
  BASIC_RECOVERY_SINK_STOP_MPS, BASIC_RECOVERY_TILT_ONSET_DEGREES, measureBasicRecoveryMotion,
} from './basicRecovery'
import { createWideGates } from '../world/wideGates'
import { findSweptObstacleHit, OBSTACLE_CRASH_WARNING_PREFIX } from '../simulation/obstacles'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample, TrainingSceneReference } from './types'


describe('Chinese-only axis demonstration names', () => {
  it.each([['roll', '橫滾'], ['pitch', '俯仰'], ['yaw', '偏航']] as const)('names the %s introduction without an English course suffix', (kind, title) => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), kind)
    expect(demo).toMatchObject({ kind, lessonId: 'intro' })
    expect(demo.title).toBe(`${title}：推桿、回中與反向修正`)
    expect(demo.cues[0].text).toContain(`先看${title}`)
  })
})

describe('separate front and back flip demonstrations', () => {
  it.each([
    ['front-flip', 'L11 前翻'], ['back-flip', 'L12 後翻'], ['power-loop', 'L13 大迴旋'], ['split-s', 'L14 破S'], ['orbit', 'L15 正刷鍋'], ['backward-flight', 'L17 後退飛行'],
  ] as const)('binds %s to its own lesson and Chinese title', (kind, title) => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), kind)
    expect(demo).toMatchObject({ kind, lessonId: kind, rulesVersion: 6 })
    expect(demo.title).toContain(title)
  })
})

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
  it.each(['beginner', 'standard', 'raised-field'] as const)('records actual L09 onset and recovery in all eight stages with %s settings', (preset) => {
    const defaults = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? {
      ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 25, z: -3 } },
    } : defaults
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'basic-recovery')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    expect(demo).toMatchObject({ lessonId: 'basic-recovery', source: 'simulated', rulesVersion: 6, physicsVersion: 1 })
    expect(demo.recording.samples[0]!.positionM).toEqual(launch)
    expect(demo.recording.durationSeconds).toBeGreaterThan(15)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(120)
    expect(demo.recording).toMatchObject({ capacity: 7_500, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.samples.length).toBeLessThanOrEqual(7_500)
    expect(Object.isFrozen(demo)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    expect(demo.cues.every(Object.isFrozen)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds))).toBe(true)
    expect(demo.cues.every((cue) => cue.targetReferenceId === 'recovery-zone')).toBe(true)
    expect(demo.cues.at(-1)!.timeSeconds).toBe(demo.recording.durationSeconds)
    expect(teachingRecoveryPhaseAt(demo, demo.recording.durationSeconds)).toBe(8)
    expect(teachingCueAt(demo, demo.recording.durationSeconds)).toContain('已完成傾斜、下沉與漂移恢復')
    const session = new TrainingSession({
      lessons: [BASIC_RECOVERY_LESSON], initialLessonId: 'basic-recovery', countdownDurationSeconds: 0,
      sceneReferences: referencesFor(settings),
    })
    session.start(0)
    session.tick(0)
    for (let index = 0; index < demo.recording.samples.length; index += 1) {
      const pose = demo.recording.samples[index]
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      if (index > 0) {
        const previous = demo.recording.samples[index - 1]
        const dt = pose.timestampSeconds - previous.timestampSeconds
        expect(dt).toBeGreaterThan(0)
        expect(dt).toBeLessThan(0.02)
        expect(Math.hypot(
          pose.positionM.x - previous.positionM.x - (pose.velocityMps.x + previous.velocityMps.x) * 0.5 * dt,
          pose.positionM.y - previous.positionM.y - (pose.velocityMps.y + previous.velocityMps.y) * 0.5 * dt,
          pose.positionM.z - previous.positionM.z - (pose.velocityMps.z + previous.velocityMps.z) * 0.5 * dt,
        )).toBeLessThan(0.003)
      }
      const state = session.consumeSample(geometricSample(settings, pose))
      expect(state.phase, JSON.stringify({ time: pose.timestampSeconds, result: state.result, evaluation: state.lastEvaluation })).not.toBe('FAILED')
      // Every stage cue is tied to the retained sample that actually completes
      // its preceding checkpoint; seeking cannot display future recovery early.
      expect(teachingRecoveryPhaseAt(demo, pose.timestampSeconds)).toBe(state.lastEvaluation?.metrics?.recoveryPhase)
    }
    const state = session.getState()
    expect(state.phase, JSON.stringify(state.lastEvaluation)).toBe('SUCCESS')
    expect(state.result?.completedCheckpoints).toBe(8)
    expect(Object.values(state.checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
    const observedAt = (id: string): ReplaySample => at(demo.recording.samples, state.checkpoints[id]!.completedAtSeconds!)
    const tiltOnset = observedAt('recovery-tilt-onset')
    const tiltRecovered = observedAt('recovery-tilt-level')
    const sinkOnset = observedAt('recovery-sink-onset')
    const sinkRecovered = observedAt('recovery-sink-stop')
    const driftOnset = observedAt('recovery-drift-onset')
    const driftRecovered = observedAt('recovery-drift-stop')
    expect(measureBasicRecoveryMotion(tiltOnset).tiltDegrees).toBeGreaterThanOrEqual(BASIC_RECOVERY_TILT_ONSET_DEGREES)
    expect(measureBasicRecoveryMotion(tiltRecovered).tiltDegrees).toBeLessThanOrEqual(BASIC_RECOVERY_LEVEL_DEGREES)
    expect(measureBasicRecoveryMotion(sinkOnset).verticalSpeedMps).toBeLessThanOrEqual(-BASIC_RECOVERY_SINK_ONSET_MPS)
    expect(measureBasicRecoveryMotion(sinkRecovered).verticalSpeedMps).toBeGreaterThanOrEqual(-BASIC_RECOVERY_SINK_STOP_MPS)
    expect(measureBasicRecoveryMotion(sinkRecovered).verticalSpeedMps).toBeLessThanOrEqual(BASIC_RECOVERY_SINK_CLIMB_MPS)
    expect(measureBasicRecoveryMotion(driftOnset).horizontalSpeedMps).toBeGreaterThanOrEqual(BASIC_RECOVERY_DRIFT_ONSET_MPS)
    expect(measureBasicRecoveryMotion(driftRecovered).horizontalSpeedMps).toBeLessThanOrEqual(BASIC_RECOVERY_DRIFT_STOP_MPS)
    expect(tiltOnset.normalizedInput!.roll).toBeGreaterThan(0)
    expect(sinkOnset.normalizedInput!.throttle).toBeLessThan(sinkRecovered.normalizedInput!.throttle)
    expect(driftOnset.normalizedInput!.pitch).toBeLessThan(0)
    for (const [onset, recovered] of [[tiltOnset, tiltRecovered], [sinkOnset, sinkRecovered], [driftOnset, driftRecovered]]) {
      expect(recovered.timestampSeconds - onset.timestampSeconds).toBeGreaterThanOrEqual(0.75 + BASIC_RECOVERY_HOLD_SECONDS)
      expect(recovered.positionM.y - settings.drone.ground.heightM).toBeGreaterThanOrEqual(BASIC_RECOVERY_MIN_HEIGHT_M)
      expect(measureBasicRecoveryMotion(recovered).bodyRateDegreesPerSecond).toBeLessThanOrEqual(BASIC_RECOVERY_MAX_BODY_RATE_DEGREES)
    }
    for (const phase of [2, 4, 6]) {
      const prepared = demo.cues.find((cue) => cue.recoveryPhase === phase && cue.text.startsWith('準備完成；'))!
      const induced = demo.cues.find((cue) => cue.recoveryPhase === phase && cue.text.includes('現在開始：'))!
      expect(prepared).toBeDefined()
      expect(induced.timeSeconds - prepared.timeSeconds).toBeGreaterThanOrEqual(2)
    }
    for (const phase of [3, 5, 7]) {
      const observed = demo.cues.find((cue) => cue.recoveryPhase === phase)!
      const corrected = demo.cues.find((cue) => cue.recoveryPhase === phase && cue.text.includes('現在修正：'))!
      expect(corrected.timeSeconds - observed.timeSeconds).toBeGreaterThanOrEqual(0.75)
    }
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('keeps L09 recovery stages and measured ghost data synchronized while paused, slowed and seeked', () => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'basic-recovery')
    const player = new ReplayPlayback(demo.recording)
    expect(teachingTargetAt(demo, 0)).toBe('recovery-zone')
    expect(teachingCueAt(demo, 0)).toContain('地面自行起飛')
    expect(teachingRecoveryPhaseAt(createTeachingDemonstration(createTuningPreset('beginner'), 'wide-gate'), 0)).toBeNull()
    const onset = demo.cues.find((cue) => cue.recoveryPhase === 3)!
    player.seek(onset.timeSeconds)
    expect(teachingRecoveryPhaseAt(demo, player.currentTime)).toBe(3)
    expect(teachingCueAt(demo, player.currentTime)).toContain('已偵測傾斜')
    expect(measureBasicRecoveryMotion(player.getGhostState()!).tiltDegrees).toBeGreaterThanOrEqual(15)
    const frozen = player.getGhostState()
    player.pause()
    player.advance(20)
    expect(player.getGhostState()).toEqual(frozen)
    const sink = demo.cues.find((cue) => cue.recoveryPhase === 5)!
    player.seek(sink.timeSeconds)
    expect(teachingRecoveryPhaseAt(demo, player.currentTime)).toBe(5)
    expect(teachingCueAt(demo, player.currentTime)).toContain('已偵測下沉')
    player.setSpeed(0.5)
    player.play()
    player.advance(0.4)
    expect(player.currentTime).toBeCloseTo(sink.timeSeconds + 0.2)
    player.seek(demo.recording.durationSeconds)
    expect(teachingRecoveryPhaseAt(demo, player.currentTime)).toBe(8)
    expect(teachingCueAt(demo, player.currentTime - 5e-10)).toContain('已完成傾斜、下沉與漂移恢復')
    expect(teachingCueAt(demo, player.currentTime - 0.001)).not.toContain('已完成傾斜、下沉與漂移恢復')
    player.seek(0)
    expect(player.getGhostState()?.positionM).toEqual(demo.recording.samples[0]!.positionM)
    expect(teachingRecoveryPhaseAt(demo, player.currentTime)).toBe(1)
  })


  it.each(['beginner', 'standard', 'raised-field'] as const)('flies through all three solid L08 openings with %s settings', (preset) => {
    const defaults = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? {
      ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 25, z: -3 } },
    } : defaults
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'wide-gate')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    const gates = createWideGates(launch, settings.drone.ground.heightM)
    const boxes = gates.flatMap((gate) => gate.colliders)
    const radiusM = droneGroundContactRadius(settings.drone)
    expect(demo).toMatchObject({ lessonId: 'wide-gate', source: 'simulated', rulesVersion: 5, physicsVersion: 1 })
    expect(demo.recording.samples[0]!.positionM).toEqual(launch)
    expect(demo.recording.durationSeconds).toBeGreaterThan(20)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(95)
    expect(demo.recording).toMatchObject({ capacity: 6_000, decimation: 4, droppedSamples: 0 })
    expect(demo.recording.samples.length).toBeLessThanOrEqual(6_000)
    expect(Object.isFrozen(demo)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    expect(demo.cues.every(Object.isFrozen)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds))).toBe(true)
    expect(demo.cues.at(-1)!.timeSeconds).toBe(demo.recording.durationSeconds)
    expect(teachingCueAt(demo, demo.recording.durationSeconds)).toContain('已依序穿過三道寬門且未碰撞門框')
    const session = new TrainingSession({
      lessons: [WIDE_GATE_LESSON], initialLessonId: 'wide-gate', countdownDurationSeconds: 0,
      sceneReferences: referencesFor(settings),
    })
    session.start(0)
    session.tick(0)
    for (let index = 0; index < demo.recording.samples.length; index += 1) {
      const pose = demo.recording.samples[index]
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.positionM).every(Number.isFinite)).toBe(true)
      expect(Object.values(pose.velocityMps).every(Number.isFinite)).toBe(true)
      expect(pose.controllerOutput.motorCommands.every(Number.isFinite)).toBe(true)
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      if (index > 0) {
        const previous = demo.recording.samples[index - 1]
        const dt = pose.timestampSeconds - previous.timestampSeconds
        expect(dt).toBeGreaterThan(0)
        expect(dt).toBeLessThan(0.02)
        expect(Math.hypot(
          pose.positionM.x - previous.positionM.x - (pose.velocityMps.x + previous.velocityMps.x) * 0.5 * dt,
          pose.positionM.y - previous.positionM.y - (pose.velocityMps.y + previous.velocityMps.y) * 0.5 * dt,
          pose.positionM.z - previous.positionM.z - (pose.velocityMps.z + previous.velocityMps.z) * 0.5 * dt,
        )).toBeLessThan(0.003)
        // Check every retained segment against the complete conservative drone
        // envelope; endpoint clearance alone could miss tunnelling through a bar.
        expect(findSweptObstacleHit(previous.positionM, pose.positionM, radiusM, boxes)).toBeNull()
      }
      if (session.getState().phase !== 'SUCCESS') {
        const state = session.consumeSample(geometricSample(settings, pose))
        expect(state.phase, JSON.stringify({ time: pose.timestampSeconds, result: state.result, evaluation: state.lastEvaluation })).not.toBe('FAILED')
      }
    }
    expect(session.getState().phase, JSON.stringify(session.getState().lastEvaluation)).toBe('SUCCESS')
    expect(session.getState().result?.completedCheckpoints).toBe(5)
    expect(Object.values(session.getState().checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
    for (let gateIndex = 0; gateIndex < gates.length; gateIndex += 1) {
      const gate = gates[gateIndex]
      const crossingIndex = demo.recording.samples.findIndex((pose, index, samples) => index > 0
        && samples[index - 1].positionM.z >= gate.positionM.z && pose.positionM.z < gate.positionM.z)
      expect(crossingIndex).toBeGreaterThan(0)
      const previous = demo.recording.samples[crossingIndex - 1]
      const crossed = demo.recording.samples[crossingIndex]
      const fraction = (gate.positionM.z - previous.positionM.z) / (crossed.positionM.z - previous.positionM.z)
      const crossingX = previous.positionM.x + (crossed.positionM.x - previous.positionM.x) * fraction
      const crossingY = previous.positionM.y + (crossed.positionM.y - previous.positionM.y) * fraction
      expect(Math.abs(crossingX - gate.positionM.x) + radiusM).toBeLessThan(gate.openingWidthM / 2)
      expect(Math.abs(crossingY - gate.positionM.y) + radiusM).toBeLessThan(gate.openingHeightM / 2)
      // A cue may advance only on the retained actual frame crossing its gate.
      expect(teachingTargetAt(demo, previous.timestampSeconds)).toBe(gate.id)
      expect(teachingTargetAt(demo, crossed.timestampSeconds)).toBe(gates[Math.min(gateIndex + 1, gates.length - 1)].id)
    }
    const finish = demo.recording.samples.at(-1)!
    expect(finish.positionM.z).toBeLessThanOrEqual(gates.at(-1)!.positionM.z - 1)
    expect(finish.positionM.y - settings.drone.ground.heightM).toBeCloseTo(3, 1)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('installs all twelve L08 frame colliders and rejects an actual blocked opening', () => {
    const settings = createTuningPreset('beginner')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    const gates = createWideGates(launch, settings.drone.ground.heightM)
    const original = FlightSimulation.prototype.resetForTraining
    const setup = vi.spyOn(FlightSimulation.prototype, 'resetForTraining')
    const steps = vi.spyOn(FlightSimulation.prototype, 'step')
    try {
      createTeachingDemonstration(settings, 'wide-gate')
      expect(setup).toHaveBeenCalledExactlyOnceWith(launch, { x: 0, y: 0, z: 0, w: 1 }, gates.flatMap((gate) => gate.colliders))
      expect(steps.mock.results.every((result) => result.type === 'return' && !result.value.state.crashed
        && !result.value.warnings.some((warning: string) => warning.startsWith(OBSTACLE_CRASH_WARNING_PREFIX)))).toBe(true)
      setup.mockRestore()
      // Add a real bar across the opening without changing recorded poses or
      // collision flags: the same RC controller must now physically hit it.
      const blocked = vi.spyOn(FlightSimulation.prototype, 'resetForTraining').mockImplementation(function (this: FlightSimulation, position, orientation, colliders = []) {
        return original.call(this, position, orientation, [...colliders, {
          id: 'test-blocked-opening', centerM: gates[0].positionM, halfExtentsM: { x: 2, y: 2, z: 0.2 },
        }])
      })
      try {
        expect(() => createTeachingDemonstration(settings, 'wide-gate')).toThrow(/Obstacle collision: test-blocked-opening/)
      } finally {
        blocked.mockRestore()
      }
    } finally {
      setup.mockRestore()
      steps.mockRestore()
    }
  })

  it('keeps L08 cues on the paused or seeked retained playback timeline', () => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'wide-gate')
    const player = new ReplayPlayback(demo.recording)
    expect(teachingTargetAt(demo, 0)).toBe('wide-gate-1')
    expect(teachingCueAt(demo, 0)).toContain('從地面自行起飛')
    const secondGate = demo.cues.find((cue) => cue.targetReferenceId === 'wide-gate-2')!
    player.seek(secondGate.timeSeconds)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('wide-gate-2')
    expect(teachingCueAt(demo, player.currentTime)).toContain('已穿過第 1 道門')
    const frozen = player.getGhostState()
    player.pause()
    player.advance(20)
    expect(player.getGhostState()).toEqual(frozen)
    player.setSpeed(0.5)
    player.play()
    player.advance(0.4)
    expect(player.currentTime).toBeCloseTo(secondGate.timeSeconds + 0.2)
    player.seek(demo.recording.durationSeconds)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('wide-gate-3')
    expect(teachingCueAt(demo, player.currentTime - 5e-10)).toContain('已依序穿過三道寬門且未碰撞門框')
    expect(teachingCueAt(demo, player.currentTime - 0.001)).not.toContain('已依序穿過三道寬門且未碰撞門框')
    player.seek(0)
    expect(player.getGhostState()?.positionM).toEqual(demo.recording.samples[0]!.positionM)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('wide-gate-1')
  })

  it.each(['beginner', 'standard', 'raised-field'] as const)('flies both opposite L07 loops with %s settings', (preset) => {
    const defaults = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? {
      ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 25, z: -3 } },
    } : defaults
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'figure-eight')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    expect(demo).toMatchObject({ lessonId: 'figure-eight', source: 'simulated', rulesVersion: 5, physicsVersion: 1 })
    expect(demo.recording.samples[0]!.positionM).toEqual(launch)
    expect(demo.recording.durationSeconds).toBeGreaterThan(45)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(120)
    expect(demo.recording.samples.length).toBeLessThanOrEqual(7_500)
    expect(demo.recording.droppedSamples).toBe(0)
    expect(Object.isFrozen(demo)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    expect(demo.cues.every(Object.isFrozen)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds))).toBe(true)
    expect(demo.cues.at(-1)!.timeSeconds).toBe(demo.recording.durationSeconds)
    expect(teachingCueAt(demo, demo.recording.durationSeconds)).toContain('已完成左右八字航線並回到中央終點')
    const session = new TrainingSession({
      lessons: [FIGURE_EIGHT_LESSON], initialLessonId: 'figure-eight', countdownDurationSeconds: 0,
      sceneReferences: referencesFor(settings),
    })
    session.start(0)
    session.tick(0)
    for (let index = 0; index < demo.recording.samples.length; index += 1) {
      const pose = demo.recording.samples[index]
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      if (index > 0) {
        const previous = demo.recording.samples[index - 1]
        const dt = pose.timestampSeconds - previous.timestampSeconds
        expect(dt).toBeGreaterThan(0)
        expect(dt).toBeLessThan(0.02)
        expect(Math.hypot(
          pose.positionM.x - previous.positionM.x - (pose.velocityMps.x + previous.velocityMps.x) * 0.5 * dt,
          pose.positionM.y - previous.positionM.y - (pose.velocityMps.y + previous.velocityMps.y) * 0.5 * dt,
          pose.positionM.z - previous.positionM.z - (pose.velocityMps.z + previous.velocityMps.z) * 0.5 * dt,
        )).toBeLessThan(0.003)
      }
      if (session.getState().phase !== 'SUCCESS') {
        const state = session.consumeSample(geometricSample(settings, pose))
        expect(state.phase, JSON.stringify({ time: pose.timestampSeconds, result: state.result, evaluation: state.lastEvaluation })).not.toBe('FAILED')
      }
    }
    expect(session.getState().phase, JSON.stringify(session.getState().lastEvaluation)).toBe('SUCCESS')
    expect(session.getState().result?.completedCheckpoints).toBe(11)
    expect(Object.values(session.getState().checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
    const leftStart = demo.cues.find((cue) => cue.targetReferenceId === 'eight-left-top')!.timeSeconds
    const rightStart = demo.cues.find((cue) => cue.targetReferenceId === 'eight-right-top')!.timeSeconds
    const signedLoop = (centerX: number, from: number, to: number): number => {
      let previousAngle: number | null = null
      let rotation = 0
      for (const pose of demo.recording.samples) {
        if (pose.timestampSeconds < from || pose.timestampSeconds > to) continue
        const angle = Math.atan2(pose.positionM.z - launch.z + 6, pose.positionM.x - centerX)
        if (previousAngle !== null) rotation += Math.atan2(Math.sin(angle - previousAngle), Math.cos(angle - previousAngle))
        previousAngle = angle
      }
      return rotation
    }
    // The positions wrap around two distinct centres in opposite directions;
    // yaw-in-place cannot produce either measured geometric revolution.
    expect(signedLoop(launch.x - 6, leftStart, rightStart)).toBeLessThan(-5.5)
    expect(signedLoop(launch.x + 6, rightStart, demo.recording.durationSeconds)).toBeGreaterThan(5.5)
    expect(Math.min(...demo.recording.samples.map((pose) => pose.positionM.x)) - launch.x).toBeLessThan(-11.5)
    expect(Math.max(...demo.recording.samples.map((pose) => pose.positionM.x)) - launch.x).toBeGreaterThan(11.5)
    const leftTop = at(demo.recording.samples, demo.cues.find((cue) => cue.targetReferenceId === 'eight-left-outer')!.timeSeconds)
    const rightTop = at(demo.recording.samples, demo.cues.find((cue) => cue.targetReferenceId === 'eight-right-outer')!.timeSeconds)
    expect(rotateVectorByQuaternion(leftTop.orientation, { x: 0, y: 0, z: -1 }).x).toBeLessThan(-0.95)
    expect(rotateVectorByQuaternion(rightTop.orientation, { x: 0, y: 0, z: -1 }).x).toBeGreaterThan(0.95)
    expect(leftTop.velocityMps.x).toBeLessThan(-0.1)
    expect(rightTop.velocityMps.x).toBeGreaterThan(0.1)
    const finish = demo.recording.samples.at(-1)!
    expect(Math.hypot(finish.positionM.x - launch.x, finish.positionM.z - launch.z + 6)).toBeLessThan(0.4)
    expect(finish.positionM.y - settings.drone.ground.heightM).toBeCloseTo(3, 1)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('keeps all three L07 central visits distinct on a paused or seeked playback clock', () => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'figure-eight')
    const player = new ReplayPlayback(demo.recording)
    expect(teachingTargetAt(demo, 0)).toBe('eight-entry')
    expect(teachingCueAt(demo, 0)).toContain('從地面自行起飛')
    const crossingCue = demo.cues.find((cue) => cue.targetReferenceId === 'eight-crossing')!
    player.seek(crossingCue.timeSeconds + 0.1)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('eight-crossing')
    expect(teachingCueAt(demo, player.currentTime)).toContain('中央換向點')
    const frozen = player.getGhostState()
    player.pause()
    player.advance(20)
    expect(player.getGhostState()).toEqual(frozen)
    const rightCue = demo.cues.find((cue) => cue.targetReferenceId === 'eight-right-top')!
    player.seek(rightCue.timeSeconds + 0.1)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('eight-right-top')
    expect(teachingCueAt(demo, player.currentTime)).toContain('右傾')
    player.setSpeed(0.5)
    player.play()
    player.advance(0.4)
    expect(player.currentTime).toBeCloseTo(rightCue.timeSeconds + 0.3)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('eight-right-top')
    player.seek(demo.recording.durationSeconds)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('eight-finish')
    expect(teachingCueAt(demo, player.currentTime - 5e-10)).toContain('已完成左右八字航線並回到中央終點')
    expect(teachingCueAt(demo, player.currentTime - 0.001)).not.toContain('已完成左右八字航線並回到中央終點')
    player.seek(0)
    expect(player.getGhostState()?.positionM).toEqual(demo.recording.samples[0]!.positionM)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('eight-entry')
  })

  it.each(['beginner', 'standard', 'raised-field'] as const)('flies all four L06 physical route legs with %s settings', (preset) => {
    const defaults = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? {
      ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 25, z: -3 } },
    } : defaults
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'square-route')
    const { launch } = createTrainingFieldAnchors(settings.drone)
    expect(demo).toMatchObject({ lessonId: 'square-route', source: 'simulated', rulesVersion: 5, physicsVersion: 1 })
    expect(demo.recording.samples[0]!.positionM).toEqual(launch)
    expect(demo.recording.durationSeconds).toBeGreaterThan(35)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(95)
    expect(demo.recording.samples.length).toBeLessThanOrEqual(6_000)
    expect(demo.recording.droppedSamples).toBe(0)
    expect(Object.isFrozen(demo)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    expect(demo.cues.every(Object.isFrozen)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds))).toBe(true)
    expect(demo.cues.at(-1)!.timeSeconds).toBe(demo.recording.durationSeconds)
    expect(teachingCueAt(demo, demo.recording.durationSeconds)).toContain('已完成四段方形航線並回到起點上方')
    const session = new TrainingSession({
      lessons: [SQUARE_ROUTE_LESSON], initialLessonId: 'square-route', countdownDurationSeconds: 0,
      sceneReferences: referencesFor(settings),
    })
    session.start(0)
    session.tick(0)
    for (let index = 0; index < demo.recording.samples.length; index += 1) {
      const pose = demo.recording.samples[index]
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      if (index > 0) {
        const previous = demo.recording.samples[index - 1]
        const dt = pose.timestampSeconds - previous.timestampSeconds
        expect(dt).toBeGreaterThan(0)
        expect(dt).toBeLessThan(0.02)
        expect(Math.hypot(
          pose.positionM.x - previous.positionM.x - (pose.velocityMps.x + previous.velocityMps.x) * 0.5 * dt,
          pose.positionM.y - previous.positionM.y - (pose.velocityMps.y + previous.velocityMps.y) * 0.5 * dt,
          pose.positionM.z - previous.positionM.z - (pose.velocityMps.z + previous.velocityMps.z) * 0.5 * dt,
        )).toBeLessThan(0.003)
      }
      if (session.getState().phase !== 'SUCCESS') {
        const state = session.consumeSample(geometricSample(settings, pose))
        expect(state.phase, JSON.stringify({ time: pose.timestampSeconds, result: state.result, evaluation: state.lastEvaluation })).not.toBe('FAILED')
      }
    }
    expect(session.getState().phase, JSON.stringify(session.getState().lastEvaluation)).toBe('SUCCESS')
    expect(session.getState().result?.completedCheckpoints).toBe(10)
    expect(Object.values(session.getState().checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
    const nearEndOfLeg = (nextTarget: string): ReplaySample => at(demo.recording.samples, demo.cues.find((cue) => cue.targetReferenceId === nextTarget)!.timeSeconds)
    const leg1 = nearEndOfLeg('square-corner-1')
    const leg2 = nearEndOfLeg('square-corner-2')
    const leg3 = nearEndOfLeg('square-corner-3')
    const leg4 = nearEndOfLeg('square-finish')
    expect(leg1.velocityMps.z).toBeLessThan(-0.1)
    expect(leg2.velocityMps.x).toBeGreaterThan(0.1)
    expect(leg3.velocityMps.z).toBeGreaterThan(0.1)
    expect(leg4.velocityMps.x).toBeLessThan(-0.1)
    expect(rotateVectorByQuaternion(leg1.orientation, { x: 0, y: 0, z: -1 }).z).toBeLessThan(-0.95)
    expect(rotateVectorByQuaternion(leg2.orientation, { x: 0, y: 0, z: -1 }).x).toBeGreaterThan(0.95)
    expect(rotateVectorByQuaternion(leg3.orientation, { x: 0, y: 0, z: -1 }).z).toBeGreaterThan(0.95)
    expect(rotateVectorByQuaternion(leg4.orientation, { x: 0, y: 0, z: -1 }).x).toBeLessThan(-0.95)
    expect(Math.max(...demo.recording.samples.map((pose) => pose.positionM.x)) - launch.x).toBeGreaterThan(11.5)
    expect(Math.min(...demo.recording.samples.map((pose) => pose.positionM.z)) - launch.z).toBeLessThan(-11.5)
    const finish = demo.recording.samples.at(-1)!
    expect(Math.hypot(finish.positionM.x - launch.x, finish.positionM.z - launch.z)).toBeLessThan(0.4)
    expect(finish.positionM.y - settings.drone.ground.heightM).toBeCloseTo(3, 1)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('keeps L06 leg goals and captions synchronized through paused seeking and return to start', () => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'square-route')
    const player = new ReplayPlayback(demo.recording)
    expect(teachingTargetAt(demo, 0)).toBe('square-leg-1')
    expect(teachingCueAt(demo, 0)).toContain('從地面自行起飛')
    const thirdLegCue = demo.cues.find((cue) => cue.targetReferenceId === 'square-leg-3')!
    player.seek(thirdLegCue.timeSeconds + 0.1)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('square-leg-3')
    expect(teachingCueAt(demo, player.currentTime)).toContain('第三段')
    const frozen = player.getGhostState()
    player.pause()
    player.advance(20)
    expect(player.getGhostState()).toEqual(frozen)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('square-leg-3')
    player.setSpeed(0.5)
    player.play()
    player.advance(0.4)
    expect(player.currentTime).toBeCloseTo(thirdLegCue.timeSeconds + 0.3)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('square-leg-3')
    player.seek(demo.recording.durationSeconds)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('square-finish')
    expect(teachingCueAt(demo, player.currentTime - 5e-10)).toContain('已完成四段方形航線並回到起點上方')
    expect(teachingCueAt(demo, player.currentTime - 0.001)).not.toContain('已完成四段方形航線並回到起點上方')
    player.seek(0)
    expect(player.getGhostState()?.positionM).toEqual(demo.recording.samples[0]!.positionM)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('square-leg-1')
  })

  it.each(['beginner', 'standard', 'raised-field'] as const)('flies both complete L05 physical turns with %s settings', (preset) => {
    const defaults = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? {
      ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 25, z: -3 } },
    } : defaults
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'coordinated-turn')
    expect(demo).toMatchObject({ lessonId: 'coordinated-turn', source: 'simulated', rulesVersion: 5, physicsVersion: 1 })
    expect(demo.recording.samples[0]!.positionM).toEqual(createTrainingFieldAnchors(settings.drone).launch)
    expect(demo.recording.durationSeconds).toBeGreaterThan(20)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(95)
    expect(demo.recording.samples.length).toBeLessThanOrEqual(6_000)
    expect(demo.recording.droppedSamples).toBe(0)
    expect(Object.isFrozen(demo)).toBe(true)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    expect(demo.cues.every(Object.isFrozen)).toBe(true)
    const retainedTimes = new Set(demo.recording.samples.map((pose) => pose.timestampSeconds))
    expect(demo.cues.every((cue) => retainedTimes.has(cue.timeSeconds))).toBe(true)
    expect(demo.cues.at(-1)!.timeSeconds).toBe(demo.recording.durationSeconds)
    expect(teachingCueAt(demo, demo.recording.durationSeconds)).toContain('已完成右轉與左轉協調航線')
    const session = new TrainingSession({
      lessons: [COORDINATED_TURN_LESSON], initialLessonId: 'coordinated-turn', countdownDurationSeconds: 0,
      sceneReferences: referencesFor(settings),
    })
    session.start(0)
    session.tick(0)
    for (let index = 0; index < demo.recording.samples.length; index += 1) {
      const pose = demo.recording.samples[index]
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      expect(quaternionNorm(pose.orientation)).toBeCloseTo(1, 8)
      if (index > 0) {
        const previous = demo.recording.samples[index - 1]
        const dt = pose.timestampSeconds - previous.timestampSeconds
        expect(dt).toBeGreaterThan(0)
        expect(dt).toBeLessThan(0.02)
        expect(Math.hypot(
          pose.positionM.x - previous.positionM.x - (pose.velocityMps.x + previous.velocityMps.x) * 0.5 * dt,
          pose.positionM.y - previous.positionM.y - (pose.velocityMps.y + previous.velocityMps.y) * 0.5 * dt,
          pose.positionM.z - previous.positionM.z - (pose.velocityMps.z + previous.velocityMps.z) * 0.5 * dt,
        )).toBeLessThan(0.003)
      }
      if (session.getState().phase !== 'SUCCESS') {
        const state = session.consumeSample(geometricSample(settings, pose))
        expect(state.phase, JSON.stringify({ time: pose.timestampSeconds, result: state.result, evaluation: state.lastEvaluation })).not.toBe('FAILED')
      }
    }
    expect(session.getState().phase, JSON.stringify(session.getState().lastEvaluation)).toBe('SUCCESS')
    expect(session.getState().result?.completedCheckpoints).toBe(8)
    expect(Object.values(session.getState().checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
    const rightEntry = at(demo.recording.samples, demo.cues.find((cue) => cue.targetReferenceId === 'turn-right-apex')!.timeSeconds)
    const rightExit = at(demo.recording.samples, demo.cues.find((cue) => cue.targetReferenceId === 'turn-left-entry')!.timeSeconds)
    const leftEntry = at(demo.recording.samples, demo.cues.find((cue) => cue.targetReferenceId === 'turn-left-apex')!.timeSeconds)
    const leftExit = demo.recording.samples.at(-1)!
    const signedMotionChange = (before: ReplaySample, after: ReplaySample): number => Math.atan2(
      before.velocityMps.x * after.velocityMps.z - before.velocityMps.z * after.velocityMps.x,
      before.velocityMps.x * after.velocityMps.x + before.velocityMps.z * after.velocityMps.z,
    ) * 180 / Math.PI
    expect(signedMotionChange(rightEntry, rightExit)).toBeGreaterThan(25)
    expect(signedMotionChange(leftEntry, leftExit)).toBeLessThan(-25)
    expect(rotateVectorByQuaternion(rightExit.orientation, { x: 0, y: 0, z: -1 }).x).toBeGreaterThan(0.95)
    expect(rotateVectorByQuaternion(leftExit.orientation, { x: 0, y: 0, z: -1 }).z).toBeLessThan(-0.95)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('keeps L05 right/left goals, captions and recorded poses on one paused or seeked clock', () => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'coordinated-turn')
    const player = new ReplayPlayback(demo.recording)
    expect(teachingTargetAt(demo, 0)).toBe('turn-right-entry')
    expect(teachingCueAt(demo, 0)).toContain('從地面自行起飛')
    const leftCue = demo.cues.find((cue) => cue.targetReferenceId === 'turn-left-apex')!
    player.seek(leftCue.timeSeconds + 0.1)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('turn-left-apex')
    expect(teachingCueAt(demo, player.currentTime)).toContain('左傾')
    const frozen = player.getGhostState()
    player.pause()
    player.advance(20)
    expect(player.getGhostState()).toEqual(frozen)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('turn-left-apex')
    player.setSpeed(0.5)
    player.play()
    player.advance(0.4)
    expect(player.currentTime).toBeCloseTo(leftCue.timeSeconds + 0.3)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('turn-left-apex')
    player.seek(demo.recording.durationSeconds)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('turn-left-exit')
    expect(teachingCueAt(demo, player.currentTime - 5e-10)).toContain('已完成右轉與左轉協調航線')
    expect(teachingCueAt(demo, player.currentTime - 0.001)).not.toContain('已完成右轉與左轉協調航線')
    player.seek(0)
    expect(player.getGhostState()?.positionM).toEqual(demo.recording.samples[0]!.positionM)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('turn-right-entry')
  })

  it.each(['beginner', 'standard', 'raised-field'] as const)('flies the complete L04 physical example with %s settings', (preset) => {
    const defaults = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? {
      ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 25, z: -3 } },
    } : defaults
    const before = JSON.stringify(settings)
    const demo = createTeachingDemonstration(settings, 'direction-control')
    expect(demo.lessonId).toBe('direction-control')
    expect(demo.recording.samples[0]!.positionM).toEqual(createTrainingFieldAnchors(settings.drone).launch)
    expect(demo.recording.durationSeconds).toBeGreaterThan(30)
    expect(demo.recording.durationSeconds).toBeLessThanOrEqual(95)
    expect(demo.recording.samples.length).toBeLessThanOrEqual(6_000)
    expect(demo.recording.droppedSamples).toBe(0)
    expect(Object.isFrozen(demo.cues)).toBe(true)
    expect(teachingCueAt(demo, demo.recording.durationSeconds)).toContain('已完成側移、前後移動與換向後方向感')
    expect(demo.cues.at(-1)!.timeSeconds).toBeCloseTo(demo.recording.durationSeconds, 10)
    expect(demo.cues.every((cue) => cue.timeSeconds <= demo.recording.durationSeconds)).toBe(true)
    const session = new TrainingSession({
      lessons: [DIRECTION_CONTROL_LESSON], initialLessonId: 'direction-control', countdownDurationSeconds: 0,
      sceneReferences: referencesFor(settings),
    })
    session.start(0)
    session.tick(0)
    for (const pose of demo.recording.samples) {
      expect(Object.values(pose.normalizedInput!).every(Number.isFinite)).toBe(true)
      const state = session.consumeSample(geometricSample(settings, pose))
      expect(state.phase, JSON.stringify({ time: pose.timestampSeconds, result: state.result, evaluation: state.lastEvaluation })).not.toBe('FAILED')
      if (state.phase === 'SUCCESS') break
    }
    expect(session.getState().phase, JSON.stringify(session.getState().lastEvaluation)).toBe('SUCCESS')
    expect(session.getState().result?.completedCheckpoints).toBe(9)
    expect(Object.values(session.getState().checkpoints).every((checkpoint) => checkpoint.completed)).toBe(true)
    const yawCue = demo.cues.find((cue) => cue.targetReferenceId === 'direction-yaw')!
    const turnedCue = demo.cues.find((cue) => cue.targetReferenceId === 'direction-turned-forward')!
    const beforeTurn = rotateVectorByQuaternion(at(demo.recording.samples, yawCue.timeSeconds).orientation, { x: 0, y: 0, z: -1 })
    const afterTurn = rotateVectorByQuaternion(at(demo.recording.samples, turnedCue.timeSeconds).orientation, { x: 0, y: 0, z: -1 })
    expect(beforeTurn.z).toBeLessThan(-0.95)
    expect(afterTurn.x).toBeGreaterThan(0.95)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('keeps L04 active targets synchronized with captions, ghost seek, and paused clocks', () => {
    const demo = createTeachingDemonstration(createTuningPreset('beginner'), 'direction-control')
    const player = new ReplayPlayback(demo.recording)
    const yawCue = demo.cues.find((cue) => cue.targetReferenceId === 'direction-yaw')!
    const finalCue = demo.cues.find((cue) => cue.targetReferenceId === 'direction-turned-right')!
    expect(teachingTargetAt(demo, 0)).toBe('direction-right')
    // Chromium serializes a step="any" range's maximum with slightly less precision.
    expect(teachingCueAt(demo, demo.recording.durationSeconds - 5e-10)).toContain('已完成側移、前後移動與換向後方向感')
    expect(teachingCueAt(demo, demo.recording.durationSeconds - 0.001)).not.toContain('已完成側移、前後移動與換向後方向感')
    expect(teachingTargetAt(demo, yawCue.timeSeconds - 5e-10)).toBe('direction-yaw')
    expect(teachingTargetAt(demo, yawCue.timeSeconds - 0.001)).toBe('direction-back')
    player.seek(yawCue.timeSeconds + 0.1)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('direction-yaw')
    expect(teachingCueAt(demo, player.currentTime)).toContain('偏航')
    const before = player.getGhostState()
    player.pause()
    player.advance(10)
    expect(player.getGhostState()).toEqual(before)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('direction-yaw')
    player.seek(finalCue.timeSeconds + 0.1)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('direction-turned-right')
    expect(teachingCueAt(demo, player.currentTime)).toContain('右邊側移')
    player.setSpeed(0.5)
    player.play()
    player.advance(0.4)
    expect(teachingTargetAt(demo, player.currentTime)).toBe('direction-turned-right')
  })

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

  it.each(['beginner', 'standard', 'raised-field'] as const)('flies a complete L01 takeoff and sustained hover using actual recorded geometry with %s settings', (preset) => {
    const defaults = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? {
      ...defaults,
      drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 5, z: -3 } },
    } : defaults
    const demo = createTeachingDemonstration(settings, 'takeoff')
    expect(demo.title).toBe('L01 起飛與定點懸停：垂直離地、減速與連續懸停')
    expect(teachingCueAt(demo, 5)).toContain('定點懸停，連續穩住 1.5 秒')
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
        sceneReferences: referencesFor(settings),
        previousSample,
        previousEvaluation,
      })
      expect(evaluation.status, evaluation.message).not.toBe('failure')
      if ((evaluation.metrics?.contiguousDwellSeconds ?? 0) < 1.5) {
        expect(evaluation.checkpointIds).not.toContain('takeoff-settle')
        expect(evaluation.status).not.toBe('success')
      }
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
    expect(checkpoints['takeoff-settle']?.metrics?.contiguousDwellSeconds).toBeGreaterThanOrEqual(1.5)
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
