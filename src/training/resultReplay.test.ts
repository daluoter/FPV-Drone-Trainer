import { describe, expect, it } from 'vitest'
import { FlightSimulation } from '../flight-controller'
import { FlightReplayRecorder } from '../replay'
import { createTrainingMachineState } from './machine'
import { createResultReplaySnapshot } from './resultReplay'
import type { TrainingMachineState, TrainingResult } from './types'

function recordingAt(times: readonly number[], capacity = 10) {
  const simulation = new FlightSimulation()
  const recorder = new FlightReplayRecorder({ capacity, decimation: 1 })
  recorder.beginFlight()
  for (const [index, timestampSeconds] of times.entries()) recorder.record({
    timestampSeconds, armed: true, state: { ...simulation.getState(), timeSeconds: timestampSeconds, stepIndex: index + 1 },
    normalizedInput: null, telemetry: simulation.getTelemetry(),
  })
  return recorder.endFlight()
}

function resultState(finish = 11): TrainingMachineState {
  const result: TrainingResult = {
    lessonId: 'hover', sessionId: 'hover:test', outcome: 'FAILED', score: 0,
    startedAtSeconds: 10, completedAtSeconds: finish, elapsedSeconds: finish - 10,
    sampleCount: 240, completedCheckpoints: 2, totalCheckpoints: 3, metrics: {}, message: 'Stopped', hint: null,
  }
  return { ...createTrainingMachineState({ initialLessonId: 'hover' }), phase: 'RESULT', sessionId: result.sessionId, result,
    checkpoints: {
      'enter-hover-zone': { id: 'enter-hover-zone', completed: true, completedAtSeconds: 10.1, metrics: {} },
      'hold-hover': { id: 'hold-hover', completed: true, completedAtSeconds: 10.5, metrics: {} },
    },
  }
}

describe('session-bound result replay markers', () => {
  it('projects absolute checkpoint times relative to the first retained result frame and trims later flight', () => {
    const source = recordingAt([9.5, 10, 10.1, 10.5, 11, 11.5])
    const snapshot = createResultReplaySnapshot(resultState(), source)!
    expect(snapshot.recording?.samples.map((sample) => sample.timestampSeconds)).toEqual([10, 10.1, 10.5, 11])
    expect(snapshot.markers.map((marker) => marker.id)).toEqual(['checkpoint:enter-hover-zone', 'checkpoint:hold-hover', 'finish'])
    expect(snapshot.markers[0]!.timeSeconds).toBeCloseTo(0.1)
    expect(snapshot.markers[1]!.timeSeconds).toBeCloseTo(0.5)
    expect(snapshot.markers[2]!.timeSeconds).toBe(1)
    expect(source.samples).toHaveLength(6)
  })

  it('disables overwritten events instead of seeking the first frame as though it were the event', () => {
    const snapshot = createResultReplaySnapshot(resultState(), recordingAt([10, 10.4, 10.8, 11], 2))!
    expect(snapshot.recording?.samples[0]!.timestampSeconds).toBe(10.8)
    expect(snapshot.markers[0]!.availability).toBe('before-window')
    expect(snapshot.markers[0]!.timeSeconds).toBeNull()
    expect(snapshot.markers.at(-1)!.timeSeconds).toBeCloseTo(0.2)
    expect(snapshot.notice).toContain('容量上限')
  })

  it('labels a nearby last frame honestly and disables an event far past the last recorded frame', () => {
    const source = recordingAt([10, 10.5, 10.97])
    const near = createResultReplaySnapshot(resultState(), source)!.markers.at(-1)!
    expect(near.availability).toBe('nearest-end')
    expect(near.label).toContain('早 0.030 秒')
    expect(near.timeSeconds).toBeCloseTo(0.97)
    const missing = createResultReplaySnapshot(resultState(11.2), source)!.markers.at(-1)!
    expect(missing.availability).toBe('after-window')
    expect(missing.timeSeconds).toBeNull()
  })

  it('never substitutes an unrelated flight, missing recording or mismatched session for a result', () => {
    for (const recording of [null, recordingAt([20, 20.5, 21]), recordingAt([1, 2])]) {
      const snapshot = createResultReplaySnapshot(resultState(), recording)!
      expect(snapshot.recording).toBeNull()
      expect(snapshot.markers.every((marker) => marker.timeSeconds === null)).toBe(true)
      expect(snapshot.notice).toContain('不會改用其他飛行錄影')
    }
    expect(createResultReplaySnapshot({ ...resultState(), sessionId: 'other' }, recordingAt([10, 11]))?.recording).toBeNull()
    expect(createResultReplaySnapshot(createTrainingMachineState(), recordingAt([10, 11]))).toBeNull()
  })

  it('retains an immutable copy independent of source samples and future checkpoint edits', () => {
    const state = resultState()
    const recording = recordingAt([10, 10.5, 11])
    const snapshot = createResultReplaySnapshot(state, recording)!
    expect(snapshot.recording?.samples[0]).not.toBe(recording.samples[0])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.markers)).toBe(true)
    expect(Object.isFrozen(snapshot.recording?.samples[0]?.controllerOutput.motorCommands)).toBe(true)
    const changed = { ...state, checkpoints: {} }
    expect(changed.checkpoints).toEqual({})
    expect(snapshot.markers[0]!.eventTimeSeconds).toBe(10.1)
  })
})
