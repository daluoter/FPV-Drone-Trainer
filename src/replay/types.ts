import type { DroneState } from '../drone'
import type { NormalizedRcAxes, NormalizedRcInput, PilotAngularRateRadPerSec, FlightTelemetry } from '../flight-controller'
import type { Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'

/**
 * The compact controller data kept beside a replay pose.  Full PID telemetry,
 * warnings, and motor state are intentionally not retained for every sample.
 */
export interface ReplayControllerOutput {
  readonly targetPilotRateRadPerSec: PilotAngularRateRadPerSec
  readonly targetBodyRateRadPerSec: Vector3
  readonly pidOutputTorqueBodyNm: Vector3
  readonly pilotCorrections: NormalizedRcAxes
  readonly motorCommands: readonly [number, number, number, number]
  readonly mixerSaturated: boolean
}

/** Structural input accepted by the recorder from a real fixed-step runtime. */
export interface ReplayFixedStepSample {
  readonly timestampSeconds: number
  readonly state: DroneState
  readonly normalizedInput: NormalizedRcInput | null
  readonly armed?: boolean
  readonly telemetry: FlightTelemetry
}

/** One immutable, decimated replay sample. It is not a DroneState. */
export interface ReplaySample {
  readonly timestampSeconds: number
  readonly positionM: Vector3
  readonly orientation: Quaternion
  readonly velocityMps: Vector3
  readonly angularVelocityBodyRadPerSec: Vector3
  readonly normalizedInput: NormalizedRcInput | null
  readonly controllerOutput: ReplayControllerOutput
}

/** Bounded recording metadata and its immutable chronological sample view. */
export interface ReplayRecording {
  readonly schemaVersion: 1
  readonly samples: readonly ReplaySample[]
  readonly capacity: number
  readonly decimation: number
  readonly totalSourceSamples: number
  readonly droppedSamples: number
  readonly durationSeconds: number
}

export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2] as const
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]

/** Presentation-only ghost state. It never enters FlightSimulation or training. */
export interface ReplayGhostState {
  readonly timestampSeconds: number
  readonly positionM: Vector3
  readonly orientation: Quaternion
  readonly velocityMps: Vector3
  readonly angularVelocityBodyRadPerSec: Vector3
  readonly normalizedInput: NormalizedRcInput | null
  readonly controllerOutput: ReplayControllerOutput
}

export interface ReplayPlaybackState {
  readonly playing: boolean
  /** Elapsed position relative to the first recording sample. */
  readonly currentTimeSeconds: number
  readonly durationSeconds: number
  readonly speed: ReplaySpeed
  readonly ghost: ReplayGhostState | null
}

/** Lightweight O(1) status for runtime telemetry/UI; no sample array copy. */
export interface ReplayRecordingSummary {
  readonly available: boolean
  readonly sampleCount: number
  readonly durationSeconds: number
  readonly droppedSamples: number
}

/** Used by renderer seams without making a ghost masquerade as live DroneState. */
export type ReplayPose = Pick<ReplayGhostState, 'positionM' | 'orientation'>

/** Keep the source contract explicit for type-only consumers. */
export type ReplayStateSource = Pick<DroneState, 'positionM' | 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>
export type ReplayTelemetrySource = Pick<FlightTelemetry, 'targetPilotRateRadPerSec' | 'targetBodyRateRadPerSec' | 'pidOutputTorqueBodyNm' | 'pilotCorrections' | 'mixerSaturated' | 'motors'>
