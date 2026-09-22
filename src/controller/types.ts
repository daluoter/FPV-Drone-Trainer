export const CONTROLLER_PROFILE_VERSION = 1 as const

export type ControllerProfileVersion = typeof CONTROLLER_PROFILE_VERSION

export const CONTROL_CHANNELS = ['roll', 'pitch', 'yaw', 'throttle'] as const
export const STICK_CHANNELS = ['roll', 'pitch', 'yaw'] as const

export type ControlChannel = (typeof CONTROL_CHANNELS)[number]
export type StickChannel = (typeof STICK_CHANNELS)[number]

export interface ControllerDevice {
  readonly id: string
  readonly index: number
  readonly mapping: string
  readonly axisCount: number
  readonly buttonCount: number
  readonly connected: boolean
  /** Runtime-only identity for this physical connection; never used for profile compatibility. */
  readonly connectionSession?: string
}

export interface GamepadButtonLike {
  readonly pressed: boolean
  readonly touched?: boolean
  readonly value: number
}

export interface GamepadLike {
  readonly id: string
  readonly index: number
  readonly connected: boolean
  readonly mapping: string
  readonly axes: readonly number[]
  readonly buttons: readonly GamepadButtonLike[]
  readonly timestamp: number
}

export type GamepadProvider = () => readonly (GamepadLike | null)[]

export interface RawButtonState {
  readonly pressed: boolean
  readonly touched: boolean
  readonly value: number
}

export interface RawGamepadSnapshot extends ControllerDevice {
  readonly axes: readonly number[]
  readonly buttons: readonly RawButtonState[]
  readonly timestamp: number
  readonly invalidAxisIndices: readonly number[]
  readonly invalidButtonIndices: readonly number[]
}

export interface ChannelCalibration {
  readonly axis: number
  readonly invert: boolean
  /** Center is used for self-centering roll, pitch and yaw channels. */
  readonly center: number
  readonly minimum: number
  readonly maximum: number
  /** Deadband is expressed in normalized output units and is only non-zero for sticks. */
  readonly deadband: number
}

export interface NeutralStabilityReport {
  readonly sampleCount: number
  readonly durationMs: number
  readonly threshold: number
  readonly maxAbsolute: Readonly<Record<StickChannel, number>>
  readonly mean: Readonly<Record<StickChannel, number>>
  readonly standardDeviation: Readonly<Record<StickChannel, number>>
  readonly stable: boolean
  readonly reason?: string
}

export interface ControllerProfile {
  readonly schemaVersion: ControllerProfileVersion
  readonly deviceId: string
  readonly deviceMapping: string
  readonly axisCount: number
  readonly buttonCount: number
  readonly channels: Readonly<Record<ControlChannel, ChannelCalibration>>
  readonly throttleMode: 'single-ended'
  readonly calibrationTimestamp: string
  readonly directionVerifiedAt: string | null
  readonly neutralVerifiedAt: string | null
  readonly neutralStability: NeutralStabilityReport | null
  /** Runtime connection binding persisted only as stale evidence, never as a portable approval. */
  readonly neutralVerificationSession?: string | null
}

export interface ChannelPipelineValues {
  readonly raw: number
  /** Endpoint-corrected value before normalization, in the Gamepad axis domain. */
  readonly calibrated: number
  readonly normalized: number
  readonly deadband: number
  readonly filtered: number
  readonly final: number
  readonly valid: boolean
}

export type ProcessedChannels = Readonly<Record<ControlChannel, ChannelPipelineValues>>

export interface ProcessedControllerState {
  readonly deviceIndex: number
  readonly timestamp: number
  readonly channels: ProcessedChannels
  readonly valid: boolean
  readonly invalidChannels: readonly ControlChannel[]
}

export interface PollerState {
  readonly supported: boolean
  readonly devices: readonly ControllerDevice[]
  readonly snapshots: readonly RawGamepadSnapshot[]
  readonly selectedDeviceIndex: number | null
}
