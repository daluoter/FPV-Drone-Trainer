import { describe, expect, it, vi } from 'vitest'

import { TrainingSession } from '../training'
import { FlightRuntime } from './flightRuntime'

function nextFrameRunner() {
  let callback: ((time: number) => void) | null = null
  return {
    schedule: (next: (time: number) => void): number => {
      callback = next
      return 1
    },
    cancel: vi.fn(),
    run: (time: number): void => callback?.(time),
  }
}

describe('runtime replay isolation', () => {
  it('records fixed-step flight samples, blocks arm during playback, and resets live time on exit', () => {
    const frames = nextFrameRunner()
    let fixedStepCount = 0
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      onFixedStep: () => { fixedStepCount += 1 },
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    frames.run(100)

    const liveStepCount = fixedStepCount
    const recording = runtime.getReplayRecording()
    expect(recording?.samples.length).toBeGreaterThan(0)
    expect(runtime.enterReplay()).toBe(true)
    expect(runtime.isReplayActive()).toBe(true)
    expect(runtime.getTelemetry().replay.label).toBe('PLAYBACK')
    expect(runtime.arm()).toBe(false)

    runtime.playReplay()
    frames.run(200)
    expect(fixedStepCount).toBe(liveStepCount)
    expect(runtime.simulation.getState().stepIndex).toBeGreaterThan(0)
    expect(runtime.getTelemetry().replay.active).toBe(true)

    expect(runtime.exitReplay()).toBe(true)
    expect(runtime.isReplayActive()).toBe(false)
    expect(runtime.simulation.getState().stepIndex).toBe(0)
    expect(runtime.simulation.getState().timeSeconds).toBe(0)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })

  it('aborts an active training session at replay entry and never feeds ghost samples to it', () => {
    const frames = nextFrameRunner()
    const training = new TrainingSession({ initialLessonId: 'hover', countdownDurationSeconds: 0 })
    training.start(0)
    training.tick(0)
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      onFixedStep: (sample) => training.consumeSample({
        timestampSeconds: sample.timestampSeconds,
        state: sample.state,
        normalizedInput: sample.normalizedInput,
        armed: sample.armed,
      }),
      onTelemetry: (telemetry) => {
        if (telemetry.replay.active && training.getState().phase === 'ACTIVE') {
          training.abort('Replay boundary')
        }
      },
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    runtime.arm()
    frames.run(100)
    expect(training.getState().sampleCount).toBeGreaterThan(0)
    expect(runtime.enterReplay()).toBe(true)
    expect(training.getState().phase).toBe('FAILED')
    const sampleCountAtReplay = training.getState().sampleCount
    frames.run(500)
    expect(training.getState().sampleCount).toBe(sampleCountAtReplay)
    runtime.dispose()
  })

  it('does not call the fixed-step/training seam for ghost playback samples', () => {
    const frames = nextFrameRunner()
    const observedTimestamps: number[] = []
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      onFixedStep: (sample) => observedTimestamps.push(sample.timestampSeconds),
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    runtime.arm()
    frames.run(100)
    const beforeReplay = observedTimestamps.length
    expect(runtime.enterReplay()).toBe(true)
    frames.run(500)
    frames.run(1_000)
    expect(observedTimestamps).toHaveLength(beforeReplay)
    runtime.dispose()
  })
})
