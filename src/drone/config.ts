import { vector3, type Vector3 } from '../math/vector'
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

type ConfigRecord = Record<string, unknown>

function isConfigRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isFiniteConfigVector3(value: unknown): value is Vector3 {
  return isConfigRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
}

function validateNonNegativeVector(value: unknown, label: string, errors: string[]): void {
  if (!isFiniteConfigVector3(value)) {
    errors.push(`${label} must contain finite values.`)
    return
  }
  if (value.x < 0 || value.y < 0 || value.z < 0) errors.push(`${label} cannot contain negative values.`)
}

function validateRange(value: unknown, minimum: number, maximum: number, label: string, errors: string[]): void {
  if (!isFiniteNumber(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be finite and in [${minimum}, ${maximum}].`)
  }
}

export function validateDroneConfig(config: unknown): ConfigValidationResult {
  const errors: string[] = []
  if (!isConfigRecord(config)) return { valid: false, errors: ['Drone configuration is missing.'] }

  if (typeof config.name !== 'string' || config.name.length === 0) errors.push('Drone configuration name is empty.')
  if (!isFiniteNumber(config.massKg) || config.massKg <= 0) errors.push('Mass must be finite and greater than zero.')
  if (!isFiniteNumber(config.armLengthM) || config.armLengthM <= 0) errors.push('Arm length must be finite and greater than zero.')
  if (!isFiniteNumber(config.gravityMps2) || config.gravityMps2 <= 0) errors.push('Gravity must be finite and greater than zero.')
  if (
    !isFiniteConfigVector3(config.inertiaKgM2) ||
    config.inertiaKgM2.x <= 0 ||
    config.inertiaKgM2.y <= 0 ||
    config.inertiaKgM2.z <= 0
  ) {
    errors.push('Diagonal inertia must contain finite positive values.')
  }
  if (!isFiniteConfigVector3(config.spawnPositionM)) errors.push('Spawn position must contain finite values.')
  validateNonNegativeVector(config.linearDragCoefficientNPerMps, 'Linear drag coefficient', errors)
  validateNonNegativeVector(config.angularDragCoefficientNmPerRadPerSec, 'Angular drag coefficient', errors)

  const motors = config.motors
  if (!Array.isArray(motors) || motors.length !== 4) {
    errors.push('Quad configuration must contain exactly four motors.')
  } else {
    const ids = new Set<string>()
    for (const [index, motorValue] of motors.entries()) {
      if (!isConfigRecord(motorValue)) {
        errors.push(`Motor ${index} configuration is missing.`)
        continue
      }
      const id = motorValue.id
      const label = typeof id === 'string' && id.length > 0 ? id : `Motor ${index}`
      if (typeof id !== 'string' || id.length === 0) {
        errors.push(`${label} ID is invalid.`)
      } else {
        if (ids.has(id)) errors.push(`Motor ID ${id} is duplicated.`)
        ids.add(id)
        if (id !== 'front-left' && id !== 'front-right' && id !== 'rear-left' && id !== 'rear-right') {
          errors.push(`${label} ID is invalid.`)
        }
      }
      if (!isFiniteConfigVector3(motorValue.positionM)) errors.push(`${label} position must contain finite values.`)
      if (!isFiniteNumber(motorValue.maxThrustN) || motorValue.maxThrustN <= 0) {
        errors.push(`${label} maximum thrust must be greater than zero.`)
      }
      if (!isFiniteNumber(motorValue.responseTimeConstantSeconds) || motorValue.responseTimeConstantSeconds <= 0) {
        errors.push(`${label} response time constant must be greater than zero.`)
      }
      if (!isFiniteNumber(motorValue.yawReactionCoefficientM) || motorValue.yawReactionCoefficientM < 0) {
        errors.push(`${label} yaw reaction coefficient must be non-negative.`)
      }
      if (motorValue.spinDirection !== 'cw' && motorValue.spinDirection !== 'ccw') {
        errors.push(`${label} spin direction is invalid.`)
      }
    }
  }

  const ground = config.ground
  if (!isConfigRecord(ground)) {
    errors.push('Ground configuration is missing.')
  } else {
    validateRange(ground.heightM, -1_000, 1_000, 'Ground height', errors)
    validateRange(ground.restitution, 0, 1, 'Ground restitution', errors)
    validateRange(ground.tangentialVelocityRetention, 0, 1, 'Ground tangential velocity retention', errors)
  }

  const safety = config.safety
  if (!isConfigRecord(safety)) {
    errors.push('Safety configuration is missing.')
  } else {
    if (!isFiniteNumber(safety.maxLinearSpeedMps) || safety.maxLinearSpeedMps <= 0) {
      errors.push('Maximum linear speed must be greater than zero.')
    }
    if (!isFiniteNumber(safety.maxAngularSpeedRadPerSec) || safety.maxAngularSpeedRadPerSec <= 0) {
      errors.push('Maximum angular speed must be greater than zero.')
    }
    if (!isFiniteNumber(safety.maxDistanceFromOriginM) || safety.maxDistanceFromOriginM <= 0) {
      errors.push('Maximum distance must be greater than zero.')
    }
  }

  const mixer = config.mixer
  if (!isConfigRecord(mixer)) {
    errors.push('Mixer configuration is missing.')
  } else {
    if (!isFiniteNumber(mixer.rollWeight) || mixer.rollWeight < 0) errors.push('Roll mixer weight is invalid.')
    if (!isFiniteNumber(mixer.pitchWeight) || mixer.pitchWeight < 0) errors.push('Pitch mixer weight is invalid.')
    if (!isFiniteNumber(mixer.yawWeight) || mixer.yawWeight < 0) errors.push('Yaw mixer weight is invalid.')
  }

  return { valid: errors.length === 0, errors }
}

export function hoverThrottle(config: DroneConfig = DEFAULT_DRONE_CONFIG): number {
  const totalMaximumThrust = config.motors.reduce((sum, motorConfig) => sum + motorConfig.maxThrustN, 0)
  if (!Number.isFinite(totalMaximumThrust) || totalMaximumThrust <= 0) return Number.NaN
  return (config.massKg * config.gravityMps2) / totalMaximumThrust
}
