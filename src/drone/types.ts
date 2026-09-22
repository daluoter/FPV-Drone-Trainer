import type { Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'

export type MotorId = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'
export type PropellerSpinDirection = 'cw' | 'ccw'

export interface MotorConfig {
  readonly id: MotorId
  /** Position relative to the centre of mass in body metres. */
  readonly positionM: Vector3
  /** Propeller rotation as viewed from above (+Y looking toward the ground). */
  readonly spinDirection: PropellerSpinDirection
  readonly maxThrustN: number
  readonly responseTimeConstantSeconds: number
  /** Reaction torque arm, expressed as torque/thrust in metres. */
  readonly yawReactionCoefficientM: number
}

export type QuadMotorConfig = readonly [MotorConfig, MotorConfig, MotorConfig, MotorConfig]

export type DiagonalInertiaKgM2 = Vector3

export interface GroundConfig {
  readonly heightM: number
  /** Normal velocity retained after impact, in [0, 1]. */
  readonly restitution: number
  /** Tangential velocity retained after contact, in [0, 1]. */
  readonly tangentialVelocityRetention: number
}

export interface SafetyConfig {
  readonly maxLinearSpeedMps: number
  readonly maxAngularSpeedRadPerSec: number
  readonly maxDistanceFromOriginM: number
}

export interface MixerConfig {
  /** Normalized differential authority for each pilot-positive axis. */
  readonly rollWeight: number
  readonly pitchWeight: number
  readonly yawWeight: number
}

export interface DroneConfig {
  readonly name: string
  readonly massKg: number
  /** Radial distance from centre of mass to each motor. */
  readonly armLengthM: number
  readonly inertiaKgM2: DiagonalInertiaKgM2
  readonly gravityMps2: number
  readonly spawnPositionM: Vector3
  readonly motors: QuadMotorConfig
  readonly linearDragCoefficientNPerMps: Vector3
  readonly angularDragCoefficientNmPerRadPerSec: Vector3
  readonly ground: GroundConfig
  readonly safety: SafetyConfig
  readonly mixer: MixerConfig
}

export interface MotorState {
  readonly command: number
  readonly targetThrustN: number
  readonly actualThrustN: number
}

export type QuadMotorState = readonly [MotorState, MotorState, MotorState, MotorState]

export interface MotorForceSummary {
  readonly totalForceBodyN: Vector3
  readonly torqueBodyNm: Vector3
  readonly totalThrustN: number
  readonly motorThrustsN: readonly [number, number, number, number]
}

export interface MixerCommand {
  /** Collective command in [0, 1]. */
  readonly throttle: number
  /** Pilot-positive roll: right wing down, about body -Z. */
  readonly roll: number
  /** Pilot-positive pitch: nose up, about body +X. */
  readonly pitch: number
  /** Pilot-positive yaw: nose right, about body -Y. */
  readonly yaw: number
}

export interface QuadXMixResult {
  readonly rawCommands: readonly [number, number, number, number]
  readonly commands: readonly [number, number, number, number]
  readonly saturated: boolean
  readonly warnings: readonly string[]
}

export interface DroneState {
  readonly positionM: Vector3
  readonly velocityMps: Vector3
  /** Authoritative body-to-world orientation. */
  readonly orientation: Quaternion
  /** Angular velocity expressed in body axes, radians per second. */
  readonly angularVelocityBodyRadPerSec: Vector3
  readonly motors: QuadMotorState
  readonly timeSeconds: number
  readonly stepIndex: number
  /** Warnings describe the most recent safe reset or numerical issue. */
  readonly warnings: readonly string[]
}

export interface DroneStepResult {
  readonly state: DroneState
  readonly warnings: readonly string[]
  readonly reset: boolean
}
