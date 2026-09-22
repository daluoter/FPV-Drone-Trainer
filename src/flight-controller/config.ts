import {
  DEFAULT_RATE_LIMITS_DEG_PER_SEC,
  DEFAULT_RATES_CONFIG,
  RATE_AXES,
  validateRateLimits,
  validateRatesConfig,
  type AxisRateLimits,
  type RatesConfig,
} from '../rates'
import { DEFAULT_DRONE_CONFIG, validateDroneConfig, type DroneConfig } from '../drone'
import {
  validateRatePidAxisConfig,
} from './pid'
import type {
  FlightControllerConfig,
  FlightControllerConfigValidationResult,
  PilotRatePidConfig,
  RatePidAxisConfig,
} from './types'

const DEFAULT_ROLL_PITCH_PID: RatePidAxisConfig = {
  // SI starting assumptions for the simplified dynamics, not hardware tuning.
  kp: 0.035,
  ki: 0.12,
  kd: 0.0008,
  integralLimit: 0.5,
  outputLimitNm: 0.25,
  derivativeOnMeasurement: true,
  derivativeFilterTimeConstantSeconds: 0.01,
}

const DEFAULT_YAW_PID: RatePidAxisConfig = {
  kp: 0.018,
  ki: 0.06,
  kd: 0.0004,
  integralLimit: 0.5,
  outputLimitNm: 0.06,
  derivativeOnMeasurement: true,
  derivativeFilterTimeConstantSeconds: 0.01,
}

export function createDefaultPilotRatePidConfig(): PilotRatePidConfig {
  return {
    roll: { ...DEFAULT_ROLL_PITCH_PID },
    pitch: { ...DEFAULT_ROLL_PITCH_PID },
    yaw: { ...DEFAULT_YAW_PID },
  }
}

export function createDefaultFlightControllerConfig(): FlightControllerConfig {
  return {
    rates: {
      axes: {
        roll: { ...DEFAULT_RATES_CONFIG.axes.roll },
        pitch: { ...DEFAULT_RATES_CONFIG.axes.pitch },
        yaw: { ...DEFAULT_RATES_CONFIG.axes.yaw },
      },
    },
    rateLimitsDegPerSec: { ...DEFAULT_RATE_LIMITS_DEG_PER_SEC },
    pid: createDefaultPilotRatePidConfig(),
  }
}

export const DEFAULT_FLIGHT_CONTROLLER_CONFIG = createDefaultFlightControllerConfig()

export interface ResolvedFlightControllerConfig {
  readonly controller: FlightControllerConfig
  readonly drone: DroneConfig
  readonly warnings: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function axisPidRecord(value: unknown): value is Record<'roll' | 'pitch' | 'yaw', unknown> {
  return isRecord(value) && 'roll' in value && 'pitch' in value && 'yaw' in value
}

/** Validate the complete flight-controller shape without throwing. */
export function validateFlightControllerConfig(config: unknown): FlightControllerConfigValidationResult {
  const errors: string[] = []
  if (!isRecord(config)) return { valid: false, errors: ['Flight-controller configuration is missing.'] }

  const ratesValidation = validateRatesConfig(config.rates)
  if (!ratesValidation.valid) errors.push(...ratesValidation.errors.map((error) => `rates: ${error}`))

  const limitsValidation = validateRateLimits(config.rateLimitsDegPerSec)
  if (!limitsValidation.valid) errors.push(...limitsValidation.errors.map((error) => `rate limits: ${error}`))

  if (!axisPidRecord(config.pid)) {
    errors.push('pid: configuration must contain roll, pitch and yaw axes.')
  } else {
    for (const axis of RATE_AXES) {
      const validation = validateRatePidAxisConfig(config.pid[axis])
      if (!validation.valid) errors.push(...validation.errors.map((error) => `pid ${axis}: ${error}`))
    }
  }

  return { valid: errors.length === 0, errors }
}

/** Resolve malformed runtime input to safe defaults rather than throwing. */
export function resolveFlightControllerConfig(
  controller: unknown,
  drone: unknown = DEFAULT_DRONE_CONFIG,
): ResolvedFlightControllerConfig {
  const warnings: string[] = []
  const controllerValidation = validateFlightControllerConfig(controller)
  const resolvedController = controllerValidation.valid
    ? controller as FlightControllerConfig
    : DEFAULT_FLIGHT_CONTROLLER_CONFIG
  if (!controllerValidation.valid) {
    warnings.push(`Invalid flight-controller configuration; defaults were used: ${controllerValidation.errors.join(' ')}`)
  }

  const droneValidation = validateDroneConfig(drone)
  const resolvedDrone = droneValidation.valid ? drone as DroneConfig : DEFAULT_DRONE_CONFIG
  if (!droneValidation.valid) {
    warnings.push(`Invalid drone configuration; defaults were used: ${droneValidation.errors.join(' ')}`)
  }

  return { controller: resolvedController, drone: resolvedDrone, warnings }
}

export function isFinitePilotRatePidConfig(config: unknown): config is PilotRatePidConfig {
  return validateFlightControllerConfig({
    rates: DEFAULT_FLIGHT_CONTROLLER_CONFIG.rates,
    rateLimitsDegPerSec: DEFAULT_FLIGHT_CONTROLLER_CONFIG.rateLimitsDegPerSec,
    pid: config,
  }).valid
}

export type { AxisRateLimits, RatesConfig }
