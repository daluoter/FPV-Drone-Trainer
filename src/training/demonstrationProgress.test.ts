import { describe, expect, it, vi } from 'vitest'

import { ReplayPlayback } from '../replay'
import { createTuningPreset } from '../tuning/presets'
import { createTeachingDemonstration } from './demonstrations'
import { createDemonstrationProgress, demonstrationProgressAt } from './demonstrationProgress'
import { lessonById } from './lessons'
import { ORBIT_COMPLETION_DEGREES, ORBIT_REQUIRED_LAPS } from './orbit'

const COURSE_KINDS = ['takeoff', 'straight-line', 'landing', 'direction-control', 'coordinated-turn', 'square-route', 'figure-eight', 'wide-gate', 'basic-recovery', 'full-roll', 'front-flip', 'back-flip', 'power-loop', 'split-s', 'orbit', 'backward-flight'] as const

describe('independent teaching demonstration progress', () => {
  it.each(COURSE_KINDS)('observes all %s checkpoints from the actual recording and exposes chapter seeks', (kind) => {
    const settings = createTuningPreset('beginner')
    const demonstration = createTeachingDemonstration(settings, kind)
    const before = JSON.stringify(demonstration)
    const timeline = createDemonstrationProgress(demonstration, settings)
    const lesson = lessonById(demonstration.lessonId)!
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(timeline.mode).toBe('lesson-checkpoints')
    expect(timeline.steps.map((step) => step.id)).toEqual(lesson.checkpoints.map((step) => step.id))
    expect(finish.complete, JSON.stringify({ kind, steps: finish.steps, notice: finish.notice })).toBe(true)
    expect(finish.completedSteps).toBe(lesson.checkpoints.length)
    expect(finish.totalSteps).toBe(lesson.checkpoints.length)
    expect(finish.currentStepIndex).toBeNull()
    expect(finish.steps.every((step) => step.status === 'completed' && step.completedAtSeconds !== null)).toBe(true)
    expect(finish.steps.every((step) => step.startedAtSeconds !== null && step.startedAtSeconds <= step.completedAtSeconds!)).toBe(true)
    const retained = new Set(demonstration.recording.samples.map((sample) => sample.timestampSeconds))
    expect(finish.steps.every((step) => retained.has(step.completedAtSeconds!))).toBe(true)
    expect(timeline.frames.length).toBeLessThanOrEqual(['full-roll', 'front-flip', 'back-flip', 'power-loop', 'split-s', 'orbit', 'backward-flight'].includes(kind) ? demonstration.recording.samples.length + 1 : lesson.checkpoints.length + 2)
    expect(timeline.title).toMatch(/^L\d\d /u)
    expect(Object.isFrozen(timeline)).toBe(true)
    expect(Object.isFrozen(timeline.steps)).toBe(true)
    expect(Object.isFrozen(timeline.frames)).toBe(true)
    expect(timeline.frames.every((frame) => Object.isFrozen(frame) && Object.isFrozen(frame.completedAtSeconds))).toBe(true)
    expect(JSON.stringify(demonstration)).toBe(before)
    const beginning = demonstrationProgressAt(timeline, 0)
    expect(beginning.complete).toBe(false)
    expect(beginning.completedSteps).toBeLessThan(lesson.checkpoints.length)
    expect(beginning.steps.filter((step) => step.status === 'current')).toHaveLength(1)
  })

  it('shows actual backward movement and braking on its own seven-step clock, including backward seeks', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'backward-flight')
    const timeline = createDemonstrationProgress(demo, settings)
    const end = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(end).toMatchObject({ kind: 'backward-flight', lessonId: 'backward-flight', complete: true, completedSteps: 7, totalSteps: 7 })
    expect(end.metrics?.backwardDistanceM).toBeGreaterThanOrEqual(3)
    expect(end.metrics?.backwardHoldSeconds).toBeGreaterThanOrEqual(0.6)
    const movement = demonstrationProgressAt(timeline, end.steps[4].completedAtSeconds!)
    expect(movement).toMatchObject({ complete: false, completedSteps: 5 })
    expect(movement.metrics?.backwardYawDegrees).toBeGreaterThanOrEqual(120)
    expect(movement.metrics?.backwardSpeedMps).toBeGreaterThanOrEqual(0.75)
    expect(movement.metrics?.backwardVelocityHeadingDegrees).toBeGreaterThanOrEqual(120)
    expect(demonstrationProgressAt(timeline, end.steps[4].completedAtSeconds! - 0.001).completedSteps).toBe(4)
    // The successful tail still projects speed from its own moving ghost.
    const firstSuccess = demonstrationProgressAt(timeline, end.steps[6].completedAtSeconds!)
    expect(end.metrics?.backwardSpeedMps).toBeLessThan(firstSuccess.metrics?.backwardSpeedMps ?? 0)
    const beginning = demonstrationProgressAt(timeline, 0)
    expect(beginning).toMatchObject({ complete: false, completedSteps: 1,
      metrics: { backwardPhase: 1, backwardYawDegrees: 0, backwardDistanceM: 0, backwardHoldSeconds: 0 } })
    expect(beginning.steps.slice(1).every((step) => step.completedAtSeconds === null)).toBe(true)
    expect(timeline.frames.every((frame) => !frame.metrics || Object.isFrozen(frame.metrics))).toBe(true)
    // Future captions cannot complete a movie stopped before maintenance/recovery.
    const stopAt = end.steps[4].completedAtSeconds!
    const samples = demo.recording.samples.filter((pose) => pose.timestampSeconds <= stopAt)
    const truncated = { ...demo, cues: [{ timeSeconds: 0, text: '七步已完成', backwardPhase: 7 }],
      recording: { ...demo.recording, samples, durationSeconds: samples.at(-1)!.timestampSeconds } }
    const partial = createDemonstrationProgress(truncated, settings)
    expect(demonstrationProgressAt(partial, partial.durationSeconds)).toMatchObject({ complete: false, completedSteps: 5 })
  })

  it('keeps measured spatial-loop progress independent and restores earlier geometry on backward seeks', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'power-loop')
    const before = JSON.stringify(demo)
    const timeline = createDemonstrationProgress(demo, settings)
    const end = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(end).toMatchObject({ kind: 'power-loop', lessonId: 'power-loop', complete: true, completedSteps: 8, totalSteps: 8 })
    expect(end.metrics?.loopProgressDegrees).toBeGreaterThanOrEqual(325)
    expect(end.metrics?.loopHeightGainM).toBeGreaterThanOrEqual(3)
    expect(end.metrics?.loopForwardSpanM).toBeGreaterThanOrEqual(6)
    const inversion = demonstrationProgressAt(timeline, end.steps[4].completedAtSeconds!)
    expect(inversion.completedSteps).toBe(5)
    expect(inversion.metrics?.loopProgressDegrees).toBeGreaterThanOrEqual(140)
    expect(inversion.metrics?.loopProgressDegrees).toBeLessThan(260)
    expect(inversion.metrics?.loopHeightGainM).toBeGreaterThanOrEqual(3)
    expect(demonstrationProgressAt(timeline, end.steps[4].completedAtSeconds! - 0.001).completedSteps).toBe(4)
    const beginning = demonstrationProgressAt(timeline, 0)
    expect(beginning).toMatchObject({ complete: false, completedSteps: 1, metrics: { loopPhase: 1, loopProgressDegrees: 0, loopHeightGainM: 0, loopForwardSpanM: 0 } })
    expect(timeline.frames.length).toBeLessThanOrEqual(demo.recording.samples.length + 1)
    expect(timeline.frames.every((frame) => !frame.metrics || Object.isFrozen(frame.metrics))).toBe(true)
    expect(JSON.stringify(demo)).toBe(before)
  })

  it('keeps five full orbit laps, inward heading and radius synchronized through backward seeks without credit from captions', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'orbit')
    const before = JSON.stringify(demo)
    const timeline = createDemonstrationProgress(demo, settings)
    const end = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(end).toMatchObject({ kind: 'orbit', lessonId: 'orbit', complete: true, completedSteps: 9, totalSteps: 9 })
    expect(end.metrics?.orbitProgressDegrees).toBeGreaterThanOrEqual(ORBIT_COMPLETION_DEGREES)
    expect(end.metrics?.orbitCompletedLaps).toBe(ORBIT_REQUIRED_LAPS)
    expect(Math.abs(end.metrics?.orbitDirection ?? 0)).toBe(1)
    for (let lap = 1; lap <= ORBIT_REQUIRED_LAPS; lap += 1) {
      const index = lap + 2
      const time = end.steps[index].completedAtSeconds!
      const observed = demonstrationProgressAt(timeline, time)
      expect(observed.completedSteps).toBe(index + 1)
      expect(observed.complete).toBe(false)
      expect(observed.metrics?.orbitCompletedLaps).toBe(lap)
      expect(observed.metrics?.orbitProgressDegrees).toBeGreaterThanOrEqual(lap * 360)
      expect(observed.metrics?.orbitProgressDegrees).toBeLessThan(lap * 360 + 2)
      expect(observed.metrics?.orbitRadiusM).toBeGreaterThan(6)
      expect(observed.metrics?.orbitRadiusM).toBeLessThan(30)
      expect(observed.metrics?.orbitHeadingErrorDegrees).toBeLessThan(80)
      expect(demonstrationProgressAt(timeline, time - 0.001).completedSteps).toBe(index)
    }
    expect(demonstrationProgressAt(timeline, 0)).toMatchObject({ complete: false, completedSteps: 1,
      metrics: { orbitPhase: 1, orbitProgressDegrees: 0, orbitCompletedLaps: 0, orbitRadiusM: 30, orbitDirection: 0 } })
    expect(timeline.frames.length).toBeLessThanOrEqual(demo.recording.samples.length + 1)
    expect(timeline.frames.every((frame) => !frame.metrics || Object.isFrozen(frame.metrics))).toBe(true)
    expect(JSON.stringify(demo)).toBe(before)
    // One complete circle and even four complete circles remain incomplete.
    // Five complete circles still require a separately observed controlled exit.
    for (const laps of [1, 4, 5]) {
      const cutTime = end.steps[laps + 2].completedAtSeconds!
      const samples = demo.recording.samples.filter((pose) => pose.timestampSeconds <= cutTime)
      const truncated = { ...demo, recording: { ...demo.recording, samples, durationSeconds: samples.at(-1)!.timestampSeconds },
        cues: [{ timeSeconds: 0, text: '九步已完成', orbitPhase: 9 }] }
      const partial = createDemonstrationProgress(truncated, settings)
      const finish = demonstrationProgressAt(partial, partial.durationSeconds)
      expect(finish).toMatchObject({ complete: false, completedSteps: laps + 3, metrics: { orbitCompletedLaps: laps } })
      expect(finish.steps.slice(laps + 3).every((step) => step.completedAtSeconds === null)).toBe(true)
    }
  })

  it('keeps actual half-roll, descending half-loop and reversal progress synchronized through backward seeks', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'split-s')
    const before = JSON.stringify(demo)
    const timeline = createDemonstrationProgress(demo, settings)
    const end = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(end).toMatchObject({ kind: 'split-s', lessonId: 'split-s', complete: true, completedSteps: 8, totalSteps: 8 })
    expect(end.metrics?.splitRollProgressDegrees).toBeGreaterThanOrEqual(145)
    expect(end.metrics?.splitPitchProgressDegrees).toBeGreaterThanOrEqual(145)
    expect(end.metrics?.splitHeightLossM).toBeGreaterThanOrEqual(3)
    expect(end.metrics?.splitHeadingChangeDegrees).toBeGreaterThanOrEqual(140)
    expect(end.metrics?.splitReverseTravelM).toBeGreaterThanOrEqual(1.5)
    const inversion = demonstrationProgressAt(timeline, end.steps[3].completedAtSeconds!)
    expect(inversion.completedSteps).toBe(4)
    expect(inversion.metrics?.splitRollProgressDegrees).toBeGreaterThanOrEqual(145)
    expect(inversion.metrics?.splitPitchProgressDegrees).toBeLessThan(10)
    expect(demonstrationProgressAt(timeline, end.steps[3].completedAtSeconds! - 0.001).completedSteps).toBe(3)
    const beginning = demonstrationProgressAt(timeline, 0)
    expect(beginning).toMatchObject({ complete: false, completedSteps: 1, metrics: {
      splitPhase: 1, splitRollProgressDegrees: 0, splitPitchProgressDegrees: 0, splitHeightLossM: 0, splitReverseTravelM: 0 } })
    expect(timeline.frames.length).toBeLessThanOrEqual(demo.recording.samples.length + 1)
    expect(timeline.frames.every((frame) => !frame.metrics || Object.isFrozen(frame.metrics))).toBe(true)
    expect(JSON.stringify(demo)).toBe(before)
    const truncated = { ...demo, recording: { ...demo.recording, samples: demo.recording.samples.slice(0, 20) },
      cues: [{ timeSeconds: 0, text: '八步已完成', splitSPhase: 8 }] }
    expect(demonstrationProgressAt(createDemonstrationProgress(truncated, settings), demo.recording.durationSeconds).complete).toBe(false)
  })

  it.each(['roll', 'pitch', 'yaw'] as const)('provides L00 %s action chapters without pretending they are flight checkpoints', (kind) => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, kind)
    const timeline = createDemonstrationProgress(demo, settings)
    expect(timeline).toMatchObject({ lessonId: 'intro', mode: 'teaching-steps', kind })
    const initial = demonstrationProgressAt(timeline, 0)
    expect(initial.completedSteps).toBe(0)
    expect(initial.currentStepTitle).toBe('觀察起始姿態')
    expect(initial.steps[1].startedAtSeconds).toBe(1)
    const held = demonstrationProgressAt(timeline, 2)
    expect(held.completedSteps).toBe(2)
    expect(held.currentStepTitle).toBe('回中，觀察旋轉停止')
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(finish.complete).toBe(true)
    expect(finish.totalSteps).toBe(5)
    expect(finish.completedSteps).toBe(5)
  })

  it('keeps actual full-roll degree observations bounded and synchronized with inversion, completion and backward seeking', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'full-roll')
    const timeline = createDemonstrationProgress(demo, settings)
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(finish).toMatchObject({ kind: 'full-roll', complete: true, completedSteps: 6 })
    expect(finish.metrics?.rollProgressDegrees).toBeGreaterThanOrEqual(340)
    const inversion = demonstrationProgressAt(timeline, finish.steps[3].completedAtSeconds!)
    expect(inversion.completedSteps).toBe(4)
    expect(inversion.metrics?.rollProgressDegrees).toBeGreaterThanOrEqual(140)
    expect(inversion.metrics?.rollProgressDegrees).toBeLessThan(240)
    expect(timeline.frames.length).toBeLessThanOrEqual(demo.recording.samples.length + 1)
    expect(timeline.frames.every((frame) => !frame.metrics || Object.isFrozen(frame.metrics))).toBe(true)
    const backward = demonstrationProgressAt(timeline, 0)
    expect(backward.complete).toBe(false)
    expect(backward.metrics?.rollProgressDegrees).toBe(0)
    expect(backward.steps.slice(1).every((step) => step.completedAtSeconds === null)).toBe(true)
  })

  it.each(['front-flip', 'back-flip'] as const)('keeps actual %s degrees and direction synchronized with its own progress and backward seek', (kind) => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, kind)
    const timeline = createDemonstrationProgress(demo, settings)
    const direction = kind === 'front-flip' ? 1 : -1
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(finish).toMatchObject({ kind, lessonId: kind, complete: true, completedSteps: 6 })
    expect(finish.metrics?.flipProgressDegrees).toBeGreaterThanOrEqual(340)
    expect(finish.metrics?.flipDirection).toBe(direction)
    expect(finish.metrics?.flipRequiredDirection).toBe(direction)
    expect((finish.metrics?.flipSignedDegrees ?? 0) * direction).toBeGreaterThanOrEqual(340)
    const inversionTime = finish.steps[3].completedAtSeconds!
    const inversion = demonstrationProgressAt(timeline, inversionTime)
    expect(inversion.completedSteps).toBe(4)
    expect(inversion.metrics?.flipProgressDegrees).toBeGreaterThanOrEqual(140)
    expect(inversion.metrics?.flipProgressDegrees).toBeLessThan(240)
    expect(demonstrationProgressAt(timeline, inversionTime - 0.001).completedSteps).toBe(3)
    expect(demonstrationProgressAt(timeline, inversionTime - 1e-11)).toEqual(inversion)
    const later = demonstrationProgressAt(timeline, inversionTime + 0.1)
    expect(later.metrics?.flipProgressDegrees).toBeGreaterThan(inversion.metrics?.flipProgressDegrees ?? 0)
    expect(timeline.frames.length).toBeLessThanOrEqual(demo.recording.samples.length + 1)
    expect(timeline.frames.every((frame) => !frame.metrics || Object.isFrozen(frame.metrics))).toBe(true)
    // A later observation must not mutate the earlier instrument snapshot.
    expect(inversion.metrics?.flipProgressDegrees).toBeLessThan(240)
    const backward = demonstrationProgressAt(timeline, 0)
    expect(backward.complete).toBe(false)
    expect(backward.metrics?.flipProgressDegrees).toBe(0)
    expect(backward.metrics?.flipDirection).toBe(0)
    expect(backward.steps.slice(1).every((step) => step.completedAtSeconds === null)).toBe(true)
  })

  it.each(['front-flip', 'back-flip'] as const)('keeps an interrupted %s recording incomplete despite a completed final caption', (kind) => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, kind)
    const timeline = createDemonstrationProgress(demo, settings)
    const inversion = demonstrationProgressAt(timeline, timeline.durationSeconds).steps[3].completedAtSeconds!
    const samples = demo.recording.samples.filter((pose) => pose.timestampSeconds <= inversion)
    const truncated = { ...demo, cues: [{ timeSeconds: 0, text: '已完成一圈與恢復', fullFlipPhase: 6 }],
      recording: { ...demo.recording, samples, durationSeconds: samples.at(-1)!.timestampSeconds } }
    const partial = createDemonstrationProgress(truncated, settings)
    const finish = demonstrationProgressAt(partial, partial.durationSeconds)
    expect(finish.complete).toBe(false)
    expect(finish.completedSteps).toBe(4)
    expect(finish.steps.slice(4).every((step) => step.completedAtSeconds === null)).toBe(true)
    expect(finish.notice).toContain('尚未完成全部課程步驟')
  })

  it.each(['front-flip', 'back-flip'] as const)('does not credit %s movie frames as the opposite lesson despite completed cues', (kind) => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, kind)
    const opposite = kind === 'front-flip' ? 'back-flip' : 'front-flip'
    const mismatched = { ...demo, kind: opposite, lessonId: opposite } as const
    const timeline = createDemonstrationProgress(mismatched, settings)
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(finish).toMatchObject({ lessonId: opposite, complete: false })
    expect(finish.completedSteps).toBeLessThanOrEqual(3)
    expect(finish.steps.slice(3).every((step) => step.completedAtSeconds === null)).toBe(true)
    expect(finish.notice).toContain('尚未完成全部課程步驟')
  })

  it('observes the legacy combined movie under its original lesson without inferring either new completion', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'full-flip')
    const timeline = createDemonstrationProgress(demo, settings)
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(finish).toMatchObject({ kind: 'full-flip', lessonId: 'full-flip', complete: true, completedSteps: 6 })
    expect(finish.metrics?.flipRequiredDirection).toBe(0)
    expect(demonstrationProgressAt(timeline, 0)).toMatchObject({ lessonId: 'full-flip', complete: false })
  })

  it('reveals actual L09 onset and recovery in order, including seeking backward from later exercises', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'basic-recovery')
    const timeline = createDemonstrationProgress(demo, settings)
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    const sinkStart = finish.steps[4].startedAtSeconds!
    const sinkObserved = finish.steps[4].completedAtSeconds!
    const sinkStopped = finish.steps[5].completedAtSeconds!
    const driftObserved = finish.steps[6].completedAtSeconds!
    expect(sinkStart).toBe(finish.steps[3].completedAtSeconds)
    expect(sinkObserved).toBeGreaterThan(sinkStart)
    expect(sinkStopped).toBeGreaterThan(sinkObserved)
    expect(driftObserved).toBeGreaterThan(sinkStopped)
    expect(demonstrationProgressAt(timeline, sinkStart)).toMatchObject({ completedSteps: 4, currentStepIndex: 4, currentStepTitle: '產生小幅下沉' })
    expect(demonstrationProgressAt(timeline, sinkObserved)).toMatchObject({ completedSteps: 5, currentStepIndex: 5, currentStepTitle: '止住下沉' })
    expect(demonstrationProgressAt(timeline, sinkStopped)).toMatchObject({ completedSteps: 6, currentStepIndex: 6, currentStepTitle: '建立前進或側移' })
    expect(demonstrationProgressAt(timeline, driftObserved)).toMatchObject({ completedSteps: 7, currentStepIndex: 7, currentStepTitle: '減速並恢復控制' })
    expect(demonstrationProgressAt(timeline, sinkObserved - 0.001).steps[4]).toMatchObject({ status: 'current', completedAtSeconds: null })
    const backward = demonstrationProgressAt(timeline, 0)
    expect(backward.completedSteps).toBe(1)
    expect(backward.steps.slice(1).every((step) => step.completedAtSeconds === null)).toBe(true)
  })

  it.each(['basic-recovery', 'front-flip', 'back-flip', 'orbit', 'backward-flight'] as const)('follows the paused, slowed and seeked %s playback clock without storage or live-session writes', (kind) => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, kind)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    try {
      const timeline = createDemonstrationProgress(demo, settings)
      const player = new ReplayPlayback(demo.recording)
      const target = timeline.steps[5].startedAtSeconds!
      player.seek(target)
      const paused = demonstrationProgressAt(timeline, player.currentTime)
      player.pause()
      player.advance(10)
      expect(demonstrationProgressAt(timeline, player.currentTime)).toEqual(paused)
      player.setSpeed(0.5)
      player.play()
      player.advance(0.4)
      expect(demonstrationProgressAt(timeline, player.currentTime)).toEqual(demonstrationProgressAt(timeline, target + 0.2))
      player.seek(player.durationSeconds)
      expect(demonstrationProgressAt(timeline, player.currentTime).complete).toBe(true)
      player.seek(0)
      expect(demonstrationProgressAt(timeline, player.currentTime).complete).toBe(false)
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  it.each(['takeoff', 'landing', 'wide-gate', 'basic-recovery', 'full-roll', 'front-flip', 'back-flip', 'backward-flight'] as const)('uses recorded raised-ground anchors for %s and rejects a different settings snapshot', (kind) => {
    const defaults = createTuningPreset('standard')
    const settings = { ...defaults, drone: { ...defaults.drone, ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 6, y: 25, z: -3 } } }
    const demo = createTeachingDemonstration(settings, kind)
    const timeline = createDemonstrationProgress(demo, settings)
    expect(demonstrationProgressAt(timeline, timeline.durationSeconds).complete).toBe(true)
    expect(() => createDemonstrationProgress(demo, defaults)).toThrow(/錄製當時的設定/u)
  })

  it('keeps an incomplete recording incomplete even when its caption claims completion', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'basic-recovery')
    const early = demo.recording.samples.filter((sample) => sample.timestampSeconds <= 0.5)
    const truncated = { ...demo, cues: [{ timeSeconds: 0, text: '已完成全部步驟', recoveryPhase: 8 }],
      recording: { ...demo.recording, samples: early, durationSeconds: early.at(-1)!.timestampSeconds } }
    const timeline = createDemonstrationProgress(truncated, settings)
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    expect(finish.complete).toBe(false)
    expect(finish.completedSteps).toBe(1)
    expect(finish.steps.slice(2).every((step) => step.startedAtSeconds === null)).toBe(true)
    expect(finish.notice).toContain('尚未完成全部課程步驟')
  })

  it('clamps invalid playback positions and preserves the native range end tolerance', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'takeoff')
    const timeline = createDemonstrationProgress(demo, settings)
    expect(demonstrationProgressAt(timeline, -10)).toEqual(demonstrationProgressAt(timeline, 0))
    expect(demonstrationProgressAt(timeline, Number.NaN)).toEqual(demonstrationProgressAt(timeline, 0))
    expect(demonstrationProgressAt(timeline, Number.POSITIVE_INFINITY)).toEqual(demonstrationProgressAt(timeline, 0))
    expect(demonstrationProgressAt(timeline, 1_000)).toEqual(demonstrationProgressAt(timeline, timeline.durationSeconds))
    const finish = demonstrationProgressAt(timeline, timeline.durationSeconds)
    const lastCheckpoint = finish.steps.at(-1)!.completedAtSeconds!
    expect(demonstrationProgressAt(timeline, lastCheckpoint - 5e-10).complete).toBe(true)
    expect(demonstrationProgressAt(timeline, lastCheckpoint - 0.001).complete).toBe(false)
    expect(Object.isFrozen(finish)).toBe(true)
    expect(Object.isFrozen(finish.steps)).toBe(true)
    expect(finish.steps.every(Object.isFrozen)).toBe(true)
  })
})
