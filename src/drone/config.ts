import { isFiniteVector3, vector3, type Vector3 } from '../math/vector'
import type {
  DroneConfig,
  GroundConfig,
  MixerConfig,
  MotorConfig,
  QuadMotorConfig,
  SafetyConfig,
} from './types'

const DIAGONAL_ARM_FACTOR = 1 / Math.sqrt(2)
const DEFAULT_ARM_LENGTH_M = 0.17

function motor(
  id: MotorConfig['id'],
  xSign: -1 | 1,
  zSign: -1 | 1,
  spinDirection: MotorConfig['spinDirection'],
  armLengthM: number,
): MotorConfig {
  return {
    id,
    positionM: vector3(xSign * armLengthM * DIAGONAL_ARM_FACTOR, 0, zSign * armLengthM * DIAGONAL_ARM_FACTOR),
    spinDirection,
    maxThrustN: 5,
    responseTimeConstantSeconds: 0.03,
    yawReactionCoefficientM: 0.02,
  }
}

const DEFAULT_GROUND: GroundConfig = {
  heightM: 0,
  restitution: 0.05,
  tangentialVelocityRetention: 0.9,
}

const DEFAULT_SAFETY: SafetyConfig = {
  maxLinearSpeedMps: 200,
  maxAngularSpeedRadPerSec: 100,
  maxDistanceFromOriginM: 10_000,
}

const DEFAULT_MIXER: MixerConfig = {
  rollWeight: 1,
  pitchWeight: 1,
  yawWeight: 1,
}

/**
 * A deliberately simplified but coherent 5-inch freestyle quad configuration.
 * Values are SI quantities; they are starting assumptions for tuning, not
 * claims about a particular airframe or laboratory-validated aerodynamics.
 */
export function createDefaultDroneConfig(): DroneConfig {
  const motors: QuadMotorConfig = [
    motor('front-left', -1, -1, 'ccw', DEFAULT_ARM_LENGTH_M),
    motor('front-right', 1, -1, 'cw', DEFAULT_ARM_LENGTH_M),
    motor('rear-left', -1, 1, 'cw', DEFAULT_ARM_LENGTH_M),
    motor('rear-right', 1, 1, 'ccw', DEFAULT_ARM_LENGTH_M),
  ]
  return {
    name: '5-inch freestyle quad (simplified)',
    massKg: 0.65,
    armLengthM: DEFAULT_ARM_LENGTH_M,
    inertiaKgM2: vector3(0.0025, 0.0045, 0.0025),
    gravityMps2: 9.80665,
    spawnPositionM: vector3(0, 0.5, 0),
    motors,
    linearDragCoefficientNPerMps: vector3(0.08, 0.1, 0.08),
    angularDragCoefficientNmPerRadPerSec: vector3(0.0008, 0.001, 0.0008),
    ground: DEFAULT_GROUND,
    safety: DEFAULT_SAFETY,
    mixer: DEFAULT_MIXER,
  }
}

export const DEFAULT_DRONE_CONFIG = createDefaultDroneConfig()

export interface ConfigValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

function validateNonNegativeVector(value: Vector3, label: string, errors: string[]): void {
  if (!isFiniteVector3(value)) {
    errors.push(`${label} must contain finite values.`)
    return
  }
  if (value.x < 0 || value.y < 0 || value.z < 0) errors.push(`${label} cannot contain negative values.`)
}

function validateRange(value: number, minimum: number, maximum: number, label: string, errors: string[]): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be finite and in [${minimum}, ${maximum}].`)
  }
}

export function validateDroneConfig(config: DroneConfig): ConfigValidationResult {
  const errors: string[] = []
  if (!config || typeof config !== 'object') return { valid: false, errors: ['Drone configuration is missing.'] }
  if (!config.name) errors.push('Drone configuration name is empty.')
  if (!Number.isFinite(config.massKg) || config.massKg <= 0) errors.push('Mass must be finite and greater than zero.')
  if (!Number.isFinite(config.armLengthM) || config.armLengthM <= 0) errors.push('Arm length must be finite and greater than zero.')
  if (!Number.isFinite(config.gravityMps2) || config.gravityMps2 <= 0) errors.push('Gravity must be finite and greater than zero.')
  if (!isFiniteVector3(config.inertiaKgM2) || config.inertiaKgM2.x <= 0 || config.inertiaKgM2.y <= 0 || config.inertiaKgM2.z <= 0) {
    errors.push('Diagonal inertia must contain finite positive values.')
  }
  if (!isFiniteVector3(config.spawnPositionM)) errors.push('Spawn position must contain finite values.')
  validateNonNegativeVector(config.linearDragCoefficientNPerMps, 'Linear drag coefficient', errors)
  validateNonNegativeVector(config.angularDragCoefficientNmPerRadPerSec, 'Angular drag coefficient', errors)

  if (!Array.isArray(config.motors) || config.motors.length !== 4) {
    errors.push('Quad configuration must contain exactly four motors.')
  } else {
    const ids = new Set<string>()
    for (const motorConfig of config.motors) {
      if (ids.has(motorConfig.id)) errors.push(`Motor ID ${motorConfig.id} is duplicated.`)
      ids.add(motorConfig.id)
      if (!isFiniteVector3(motorConfig.positionM)) errors.push(`${motorConfig.id} position must contain finite values.`)
      if (!Number.isFinite(motorConfig.maxThrustN) || motorConfig.maxThrustN <= 0) {
        errors.push(`${motorConfig.id} maximum thrust must be greater than zero.`)
      }
      if (!Number.isFinite(motorConfig.responseTimeConstantSeconds) || motorConfig.responseTimeConstantSeconds <= 0) {
        errors.push(`${motorConfig.id} response time constant must be greater than zero.`)
      }
      if (!Number.isFinite(motorConfig.yawReactionCoefficientM) || motorConfig.yawReactionCoefficientM < 0) {
        errors.push(`${motorConfig.id} yaw reaction coefficient must be non-negative.`)
      }
      if (motorConfig.spinDirection !== 'cw' && motorConfig.spinDirection !== 'ccw') {
        errors.push(`${motorConfig.id} spin direction is invalid.`)
      }
    }
  }

  validateRange(config.ground.heightM, -1_000, 1_000, 'Ground height', errors)
  validateRange(config.ground.restitution, 0, 1, 'Ground restitution', errors)
  validateRange(config.ground.tangentialVelocityRetention, 0, 1, 'Ground tangential velocity retention', errors)
  if (!Number.isFinite(config.safety.maxLinearSpeedMps) || config.safety.maxLinearSpeedMps <= 0) {
    errors.push('Maximum linear speed must be greater than zero.')
  }
  if (!Number.isFinite(config.safety.maxAngularSpeedRadPerSec) || config.safety.maxAngularSpeedRadPerSec <= 0) {
    errors.push('Maximum angular speed must be greater than zero.')
  }
  if (!Number.isFinite(config.safety.maxDistanceFromOriginM) || config.safety.maxDistanceFromOriginM <= 0) {
    errors.push('Maximum distance must be greater than zero.')
  }
  if (!Number.isFinite(config.mixer.rollWeight) || config.mixer.rollWeight < 0) errors.push('Roll mixer weight is invalid.')
  if (!Number.isFinite(config.mixer.pitchWeight) || config.mixer.pitchWeight < 0) errors.push('Pitch mixer weight is invalid.')
  if (!Number.isFinite(config.mixer.yawWeight) || config.mixer.yawWeight < 0) errors.push('Yaw mixer weight is invalid.')

  return { valid: errors.length === 0, errors }
}

export function hoverThrottle(config: DroneConfig = DEFAULT_DRONE_CONFIG): number {
  const totalMaximumThrust = config.motors.reduce((sum, motorConfig) => sum + motorConfig.maxThrustN, 0)
  if (!Number.isFinite(totalMaximumThrust) || totalMaximumThrust <= 0) return Number.NaN
  return (config.massKg * config.gravityMps2) / totalMaximumThrust
}
