import { describe, expect, it, vi } from 'vitest'

import { ReplayPlayback } from '../replay'
import { createTuningPreset } from '../tuning/presets'
import { createTeachingDemonstration } from './demonstrations'
import { createDemonstrationProgress, demonstrationProgressAt } from './demonstrationProgress'
import { lessonById } from './lessons'

const COURSE_KINDS = ['takeoff', 'straight-line', 'landing', 'direction-control', 'coordinated-turn', 'square-route', 'figure-eight', 'wide-gate', 'basic-recovery', 'full-roll'] as const

describe('independent teaching demonstration progress', () => {
  it.each(COURSE_KINDS)('observes all %s checkpoints from the actual recording and exposes chapter seeks', (kind) => {
    const settings = createTuningPreset('beginner')
    const demonstration = createTeachingDemonstration(settings, kind)
    const before = JSON.stringify(demonstration)
    const timeline = createDemonstrationProgress(demonstration, settings)
    const lesson = lessonById(kind)!
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
    expect(timeline.frames.length).toBeLessThanOrEqual(kind === 'full-roll' ? demonstration.recording.samples.length + 1 : lesson.checkpoints.length + 2)
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

  it('follows the same paused, slowed and seeked playback clock without storage or live-session writes', () => {
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, 'basic-recovery')
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

  it.each(['takeoff', 'landing', 'wide-gate', 'basic-recovery', 'full-roll'] as const)('uses recorded raised-ground anchors for %s and rejects a different settings snapshot', (kind) => {
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
