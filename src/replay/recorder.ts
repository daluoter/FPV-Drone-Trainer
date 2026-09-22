import { isFiniteDroneState } from '../drone'
import { isFiniteNormalizedRcInput } from '../flight-controller'
import { normalizeQuaternion, quaternionNorm, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import type {
  ReplayControllerOutput,
  ReplayFixedStepSample,
  ReplayRecording,
  ReplayRecordingSummary,
  ReplaySample,
} from './types'

export const DEFAULT_REPLAY_CAPACITY = 2_400
export const DEFAULT_REPLAY_DECIMATION = 4
const MAX_REPLAY_CAPACITY = 12_000
const MAX_REPLAY_DECIMATION = 240

export interface ReplayRecorderOptions {
  /** Maximum number of compact samples retained in the ring. */
  readonly capacity?: number
  /** Keep one source sample every N fixed steps. */
  readonly decimation?: number
}

function safeBound(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback
}

function finiteVector(value: Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

function finiteQuaternion(value: Quaternion): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isFinite(value.w)
    && Number.isFinite(quaternionNorm(value)) && quaternionNorm(value) > 1e-8
}

function finiteAxes(value: { readonly roll: number; readonly pitch: number; readonly yaw: number }): boolean {
  return Number.isFinite(value.roll) && Number.isFinite(value.pitch) && Number.isFinite(value.yaw)
}

function freezeVector(value: Vector3): Vector3 {
  return Object.freeze({ x: value.x, y: value.y, z: value.z })
}

function freezeQuaternion(value: Quaternion): Quaternion {
  const normalized = normalizeQuaternion(value)
  return Object.freeze({
    x: normalized.x,
    y: normalized.y,
    z: normalized.z,
    w: normalized.w,
  })
}

function freezeInput(value: ReplayFixedStepSample['normalizedInput']): ReplayFixedStepSample['normalizedInput'] {
  return value
    ? Object.freeze({ roll: value.roll, pitch: value.pitch, yaw: value.yaw, throttle: value.throttle })
    : null
}

function validControllerOutput(value: ReplayFixedStepSample['telemetry']): boolean {
  const targetPilot = value.targetPilotRateRadPerSec
  const targetBody = value.targetBodyRateRadPerSec
  const torque = value.pidOutputTorqueBodyNm
  const corrections = value.pilotCorrections
  return finiteAxes(targetPilot)
    && finiteVector(targetBody)
    && finiteVector(torque)
    && Number.isFinite(corrections.roll)
    && Number.isFinite(corrections.pitch)
    && Number.isFinite(corrections.yaw)
    && value.motors.length === 4
    && value.motors.every((motor) => Number.isFinite(motor.command) && motor.command >= 0 && motor.command <= 1)
    && typeof value.mixerSaturated === 'boolean'
}

function copyControllerOutput(value: ReplayFixedStepSample['telemetry']): ReplayControllerOutput {
  const motorCommands = value.motors.map((motor) => motor.command) as [number, number, number, number]
  return Object.freeze({
    targetPilotRateRadPerSec: Object.freeze({
      roll: value.targetPilotRateRadPerSec.roll,
      pitch: value.targetPilotRateRadPerSec.pitch,
      yaw: value.targetPilotRateRadPerSec.yaw,
    }),
    targetBodyRateRadPerSec: freezeVector(value.targetBodyRateRadPerSec),
    pidOutputTorqueBodyNm: freezeVector(value.pidOutputTorqueBodyNm),
    pilotCorrections: Object.freeze({
      roll: value.pilotCorrections.roll,
      pitch: value.pilotCorrections.pitch,
      yaw: value.pilotCorrections.yaw,
    }),
    motorCommands: Object.freeze(motorCommands),
    mixerSaturated: value.mixerSaturated,
  })
}

function validReplaySource(source: ReplayFixedStepSample): boolean {
  return Number.isFinite(source.timestampSeconds)
    && source.timestampSeconds >= 0
    && isFiniteDroneState(source.state)
    && finiteQuaternion(source.state.orientation)
    && finiteVector(source.state.positionM)
    && finiteVector(source.state.velocityMps)
    && finiteVector(source.state.angularVelocityBodyRadPerSec)
    && (source.normalizedInput === null || isFiniteNormalizedRcInput(source.normalizedInput))
    && validControllerOutput(source.telemetry)
}

function copyReplaySample(source: ReplayFixedStepSample): ReplaySample | null {
  if (!validReplaySource(source)) return null

  return Object.freeze({
    timestampSeconds: source.timestampSeconds,
    positionM: freezeVector(source.state.positionM),
    orientation: freezeQuaternion(source.state.orientation),
    velocityMps: freezeVector(source.state.velocityMps),
    angularVelocityBodyRadPerSec: freezeVector(source.state.angularVelocityBodyRadPerSec),
    normalizedInput: freezeInput(source.normalizedInput),
    controllerOutput: copyControllerOutput(source.telemetry),
  })
}

function emptySummary(capacity: number, decimation: number): ReplayRecording {
  return Object.freeze({
    schemaVersion: 1,
    samples: Object.freeze([]),
    capacity,
    decimation,
    totalSourceSamples: 0,
    droppedSamples: 0,
    durationSeconds: 0,
  })
}

/**
 * Bounded fixed-step recorder. Only decimated compact fields are copied; the
 * full DroneState/telemetry object never enters the ring and no storage API is
 * used. `beginFlight` replaces the previous bounded flight intentionally.
 */
export class FlightReplayRecorder {
  public readonly capacity: number
  public readonly decimation: number
  private readonly ring: Array<ReplaySample | undefined>
  private writeIndex = 0
  private size = 0
  private sourceSampleCount = 0
  private droppedSampleCount = 0
  private lastTimestampSeconds: number | null = null
  private flightActive = false

  public constructor(options: ReplayRecorderOptions = {}) {
    this.capacity = safeBound(options.capacity, DEFAULT_REPLAY_CAPACITY, MAX_REPLAY_CAPACITY)
    this.decimation = safeBound(options.decimation, DEFAULT_REPLAY_DECIMATION, MAX_REPLAY_DECIMATION)
    this.ring = new Array<ReplaySample | undefined>(this.capacity)
  }

  public beginFlight(): void {
    this.clear()
    this.flightActive = true
  }

  public endFlight(): ReplayRecording {
    this.flightActive = false
    return this.snapshot()
  }

  public isFlightActive(): boolean {
    return this.flightActive
  }

  /** Remove the retained flight. This never affects simulation state. */
  public clear(): void {
    this.ring.fill(undefined)
    this.writeIndex = 0
    this.size = 0
    this.sourceSampleCount = 0
    this.droppedSampleCount = 0
    this.lastTimestampSeconds = null
    this.flightActive = false
  }

  /**
   * Record one actual fixed-step sample. Disarmed samples are ignored, invalid
   * timestamps are rejected without changing recorder state, and skipped
   * decimation samples still advance the monotonic source boundary.
   */
  public record(sample: ReplayFixedStepSample): boolean {
    if (sample.armed === false) return false
    if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0) return false
    if (this.lastTimestampSeconds !== null && sample.timestampSeconds <= this.lastTimestampSeconds) return false

    if (!validReplaySource(sample)) return false
    this.lastTimestampSeconds = sample.timestampSeconds
    const sourceIndex = this.sourceSampleCount
    this.sourceSampleCount += 1
    if (sourceIndex % this.decimation !== 0) return false
    const copied = copyReplaySample(sample)
    if (!copied) return false

    if (this.size === this.capacity) this.droppedSampleCount += 1
    else this.size += 1
    this.ring[this.writeIndex] = copied
    this.writeIndex = (this.writeIndex + 1) % this.capacity
    return true
  }

  public getSummary(): ReplayRecordingSummary {
    const first = this.size > 0 ? this.sampleAt(0) : null
    const last = this.size > 0 ? this.sampleAt(this.size - 1) : null
    return Object.freeze({
      available: this.size > 0,
      sampleCount: this.size,
      durationSeconds: first && last ? Math.max(0, last.timestampSeconds - first.timestampSeconds) : 0,
      droppedSamples: this.droppedSampleCount,
    })
  }

  /** Return a new immutable view; future ring writes cannot alter this array. */
  public snapshot(): ReplayRecording {
    const samples: ReplaySample[] = []
    for (let index = 0; index < this.size; index += 1) {
      const sample = this.sampleAt(index)
      if (sample) samples.push(sample)
    }
    const first = samples[0]
    const last = samples[samples.length - 1]
    return Object.freeze({
      schemaVersion: 1,
      samples: Object.freeze(samples),
      capacity: this.capacity,
      decimation: this.decimation,
      totalSourceSamples: this.sourceSampleCount,
      droppedSamples: this.droppedSampleCount,
      durationSeconds: first && last ? Math.max(0, last.timestampSeconds - first.timestampSeconds) : 0,
    })
  }

  public getRecording(): ReplayRecording | null {
    return this.size > 0 ? this.snapshot() : null
  }

  private sampleAt(chronologicalIndex: number): ReplaySample | null {
    if (chronologicalIndex < 0 || chronologicalIndex >= this.size) return null
    const firstIndex = this.size === this.capacity ? this.writeIndex : 0
    return this.ring[(firstIndex + chronologicalIndex) % this.capacity] ?? null
  }
}

/** Alias kept short for runtime/UI seams. */
export const ReplayRecorder = FlightReplayRecorder

/** Build an empty immutable recording for callers that need a stable shape. */
export function createEmptyReplayRecording(
  options: ReplayRecorderOptions = {},
): ReplayRecording {
  const capacity = safeBound(options.capacity, DEFAULT_REPLAY_CAPACITY, MAX_REPLAY_CAPACITY)
  const decimation = safeBound(options.decimation, DEFAULT_REPLAY_DECIMATION, MAX_REPLAY_DECIMATION)
  return emptySummary(capacity, decimation)
}
