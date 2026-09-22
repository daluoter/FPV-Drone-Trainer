import type { RatesConfig, AxisRateLimits } from '../rates'
import type { DroneConfig, QuadXMixResult, DroneState, MotorState } from '../drone'
import type { Vector3 } from '../math/vector'

export const PILOT_RATE_AXES = ['roll', 'pitch', 'yaw'] as const
export type PilotRateAxis = (typeof PILOT_RATE_AXES)[number]

/** Normalized controller channels at the flight-control boundary. */
export interface NormalizedRcInput {
  /** Pilot-positive: right wing down. */
  readonly roll: number
  /** Pilot-positive: nose up. */
  readonly pitch: number
  /** Pilot-positive: nose turns right. */
  readonly yaw: number
  /** Single-ended motor collective command. */
  readonly throttle: number
}

/** Angular velocity in body axes, always radians per second. */
export type BodyAngularRateRadPerSec = Vector3

/** Pilot-positive angular rates, always radians per second. */
export type PilotAngularRateRadPerSec = Readonly<Record<PilotRateAxis, number>>

/** Pilot-positive torque/correction axis values in SI Newton-metres. */
export type PilotTorqueNm = Readonly<Record<PilotRateAxis, number>>
/** Stored rate-error integrals, with units (rad/s) seconds. */
export type PilotRateIntegral = Readonly<Record<PilotRateAxis, number>>

/**
 * One rate-loop PID configuration. Gains use SI quantities:
 * kp [N m / (rad/s)], ki [N m / rad], kd [N m / (rad/s²)].
 */
export interface RatePidAxisConfig {
  readonly kp: number
  readonly ki: number
  readonly kd: number
  /** Bound on the stored error integral, in (rad/s) seconds. */
  readonly integralLimit: number
  /** Symmetric torque output bound, in N m. */
  readonly outputLimitNm: number
  /** Use derivative of measured rate, avoiding setpoint derivative kick. */
  readonly derivativeOnMeasurement?: boolean
  /** Optional first-order derivative smoothing time constant in seconds. */
  readonly derivativeFilterTimeConstantSeconds?: number
}

export interface PilotRatePidConfig {
  readonly roll: RatePidAxisConfig
  readonly pitch: RatePidAxisConfig
  readonly yaw: RatePidAxisConfig
}

export interface FlightControllerConfig {
  readonly rates: RatesConfig
  readonly rateLimitsDegPerSec: AxisRateLimits
  readonly pid: PilotRatePidConfig
}

export interface FlightControllerConfigValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

export interface PidAxisTelemetry {
  readonly errorRadPerSec: number
  /** Stored error integral, in (rad/s) seconds. */
  readonly integral: number
  /** Integral contribution to torque, in N m. */
  readonly integralTermNm: number
  readonly proportionalTermNm: number
  readonly derivativeTermNm: number
  readonly derivativeRadPerSec2: number
  readonly outputNm: number
  readonly saturated: boolean
  readonly valid: boolean
  readonly warnings: readonly string[]
}

export type PilotPidTelemetry = Readonly<Record<PilotRateAxis, PidAxisTelemetry>>

export interface TargetRateResult {
  readonly targetPilotRateRadPerSec: PilotAngularRateRadPerSec
  readonly targetBodyRateRadPerSec: BodyAngularRateRadPerSec
  readonly throttle: number
  readonly valid: boolean
  readonly warnings: readonly string[]
}

export interface FlightControllerOutput {
  readonly targetPilotRateRadPerSec: PilotAngularRateRadPerSec
  readonly targetBodyRateRadPerSec: BodyAngularRateRadPerSec
  readonly measuredPilotRateRadPerSec: PilotAngularRateRadPerSec
  readonly measuredBodyRateRadPerSec: BodyAngularRateRadPerSec
  readonly errorBodyRateRadPerSec: BodyAngularRateRadPerSec
  readonly pidIntegral: PilotRateIntegral
  readonly pidOutputTorqueBodyNm: Vector3
  readonly pilotCorrections: NormalizedRcAxes
  readonly mixer: QuadXMixResult
  readonly motorCommands: readonly [number, number, number, number]
  readonly pid: PilotPidTelemetry
  readonly throttle: number
  readonly valid: boolean
  readonly warnings: readonly string[]
}

/** Pilot axes without the collective channel, used for mixer corrections. */
export interface NormalizedRcAxes {
  readonly roll: number
  readonly pitch: number
  readonly yaw: number
}

export interface MotorTelemetry extends MotorState {
  readonly id: string
}

export interface FlightTelemetry {
  readonly timeSeconds: number
  readonly stepIndex: number
  readonly armed: boolean
  readonly targetPilotRateRadPerSec: PilotAngularRateRadPerSec
  readonly targetBodyRateRadPerSec: BodyAngularRateRadPerSec
  readonly measuredBodyRateRadPerSec: BodyAngularRateRadPerSec
  readonly errorBodyRateRadPerSec: BodyAngularRateRadPerSec
  readonly pidIntegral: PilotRateIntegral
  readonly pidOutputTorqueBodyNm: Vector3
  readonly pilotCorrections: NormalizedRcAxes
  readonly pid: PilotPidTelemetry
  readonly mixer: QuadXMixResult
  readonly mixerSaturated: boolean
  readonly motors: readonly [MotorTelemetry, MotorTelemetry, MotorTelemetry, MotorTelemetry]
  readonly warnings: readonly string[]
}

export interface FlightStepResult {
  readonly state: DroneState
  readonly telemetry: FlightTelemetry
  readonly warnings: readonly string[]
  readonly reset: boolean
}

export interface FlightAdvanceResult {
  readonly state: DroneState
  readonly telemetry: FlightTelemetry
  readonly steps: number
  readonly simulatedSeconds: number
  readonly droppedSteps: number
  readonly droppedSeconds: number
  readonly accumulatorSeconds: number
  readonly interpolationAlpha: number
  readonly warnings: readonly string[]
}

export interface FlightSimulationConfig {
  readonly drone?: DroneConfig
  readonly controller?: FlightControllerConfig
  readonly fixedStep?: {
    readonly stepSeconds?: number
    readonly maxCatchUpSteps?: number
    readonly maxFrameDeltaSeconds?: number
  }
  /** Runtime starts disarmed unless explicitly enabled. */
  readonly armed?: boolean
}
