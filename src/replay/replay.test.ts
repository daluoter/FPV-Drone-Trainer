import { describe, expect, it } from 'vitest'

import { FlightSimulation } from '../flight-controller'
import type { ReplayFixedStepSample, ReplaySample } from './types'
import { FlightReplayRecorder } from './recorder'
import { interpolateReplaySamples, slerpQuaternionShortestPath } from './interpolation'
import { ReplayPlayback } from './playback'

function sourceSample(simulation: FlightSimulation): ReplayFixedStepSample {
  const result = simulation.step({ roll: 0, pitch: 0, yaw: 0, throttle: 0 }, simulation.fixedStepSeconds)
  return {
    timestampSeconds: result.state.timeSeconds,
    state: result.state,
    normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0 },
    armed: true,
    telemetry: result.telemetry,
  }
}

function flightSamples(count: number): ReplayFixedStepSample[] {
  const simulation = new FlightSimulation()
  simulation.arm()
  const samples: ReplayFixedStepSample[] = []
  for (let index = 0; index < count; index += 1) samples.push(sourceSample(simulation))
  return samples
}

function sampleWithPose(
  timestampSeconds: number,
  positionM: { x: number; y: number; z: number },
  orientation = { x: 0, y: 0, z: 0, w: 1 },
): ReplaySample {
  const source = flightSamples(1)[0]
  return {
    timestampSeconds,
    positionM,
    orientation,
    velocityMps: { x: 0, y: 0, z: 0 },
    angularVelocityBodyRadPerSec: { x: 0, y: 0, z: 0 },
    normalizedInput: source.normalizedInput,
    controllerOutput: {
      targetPilotRateRadPerSec: { roll: 0, pitch: 0, yaw: 0 },
      targetBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
      pidOutputTorqueBodyNm: { x: 0, y: 0, z: 0 },
      pilotCorrections: { roll: 0, pitch: 0, yaw: 0 },
      motorCommands: [0, 0, 0, 0],
      mixerSaturated: false,
    },
  }
}

describe('bounded replay recorder', () => {
  it('decimates actual fixed-step samples and retains only the bounded newest ring', () => {
    const recorder = new FlightReplayRecorder({ capacity: 2, decimation: 2 })
    for (const sample of flightSamples(6)) recorder.record(sample)

    const recording = recorder.getRecording()
    expect(recording?.samples).toHaveLength(2)
    expect(recording?.totalSourceSamples).toBe(6)
    expect(recording?.droppedSamples).toBe(1)
    expect(recording?.samples[0].timestampSeconds).toBeLessThan(recording?.samples[1].timestampSeconds ?? Number.POSITIVE_INFINITY)
    expect(recorder.getSummary().sampleCount).toBe(2)
  })

  it('copies compact immutable values instead of retaining mutable runtime objects', () => {
    const recorder = new FlightReplayRecorder({ decimation: 1 })
    const source = flightSamples(1)[0]
    recorder.record(source)
    const first = recorder.snapshot()
    const originalPosition = first.samples[0].positionM.x

    ;(source.state.positionM as { x: number }).x = 99
    expect(first.samples[0].positionM.x).toBe(originalPosition)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.samples)).toBe(true)
    expect(Object.isFrozen(first.samples[0].positionM)).toBe(true)
    expect(Object.isFrozen(first.samples[0].controllerOutput.motorCommands)).toBe(true)
  })

  it('rejects invalid or non-monotonic timestamps without poisoning the next valid sample', () => {
    const recorder = new FlightReplayRecorder({ decimation: 1 })
    const source = flightSamples(2)
    expect(recorder.record({ ...source[0], timestampSeconds: Number.NaN })).toBe(false)
    expect(recorder.record(source[0])).toBe(true)
    expect(recorder.record({ ...source[1], timestampSeconds: source[0].timestampSeconds })).toBe(false)
    expect(recorder.snapshot().samples).toHaveLength(1)
  })
})

describe('replay interpolation and playback', () => {
  it('takes the shortest path when quaternion endpoints are antipodal representations', () => {
    const left = sampleWithPose(0, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 })
    const right = sampleWithPose(1, { x: 2, y: 1, z: 0 }, { x: -0, y: -0, z: -0, w: -1 })
    const interpolated = interpolateReplaySamples([left, right], 0.5)
    expect(interpolated?.positionM.x).toBeCloseTo(1)
    expect(interpolated?.orientation.w).toBeCloseTo(1)
    expect(slerpQuaternionShortestPath(left.orientation, right.orientation, 0.5).w).toBeCloseTo(1)
  })

  it('interpolates poses and enforces the four supported playback speeds', () => {
    const recording = {
      schemaVersion: 1 as const,
      samples: [sampleWithPose(10, { x: 0, y: 1, z: 0 }), sampleWithPose(11, { x: 4, y: 1, z: 0 })],
      capacity: 2,
      decimation: 1,
      totalSourceSamples: 2,
      droppedSamples: 0,
      durationSeconds: 1,
    }
    const playback = new ReplayPlayback(recording)
    expect(playback.setSpeed(0.5)).toBe(true)
    expect(playback.setSpeed(0.75)).toBe(false)
    expect(playback.seek(0.5)).toBe(true)
    expect(playback.getGhostState()?.positionM.x).toBeCloseTo(2)
    playback.play()
    playback.advance(1)
    expect(playback.isPlaying()).toBe(false)
    expect(playback.getState().currentTimeSeconds).toBe(1)
  })
})

