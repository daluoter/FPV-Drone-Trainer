export const RATE_AXES = ['roll', 'pitch', 'yaw'] as const
export type RateAxis = (typeof RATE_AXES)[number]

/** Canonical Betaflight Actual Rates values are represented here in deg/s. */
export interface ActualRatesConfig {
  readonly centerRateDegPerSec: number
  readonly maxRateDegPerSec: number
  /** Expo as a fraction: 0 is linear and 1 is full fifth-power expo. */
  readonly expo: number
}

export type AxisRatesConfig = Readonly<Record<RateAxis, ActualRatesConfig>>

export interface RatesConfig {
  readonly axes: AxisRatesConfig
}

/** A null limit means that no separate configured rate limit is enabled. */
export type RateLimitDegPerSec = number | null
export type AxisRateLimits = Readonly<Record<RateAxis, RateLimitDegPerSec>>

export interface RatesValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

/** Betaflight's Actual Rates profile limits, converted from its 0..200 UI units. */
export const MAX_ACTUAL_RATE_DEG_PER_SEC = 2_000
export const MAX_RATE_LIMIT_DEG_PER_SEC = 2_000
export const MIN_NORMALIZED_STICK = -1
export const MAX_NORMALIZED_STICK = 1

const INVALID_RATE = Number.NaN

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateRateValue(
  value: unknown,
  label: string,
  maximum: number,
  errors: string[],
): void {
  if (!isFiniteNumber(value) || value < 0 || value > maximum) {
    errors.push(`${label} must be finite and in [0, ${maximum}].`)
  }
}

/** Validate one axis before using it in the canonical formula. */
export function validateActualRatesConfig(config: unknown): RatesValidationResult {
  const errors: string[] = []
  if (!isRecord(config)) return { valid: false, errors: ['Actual Rates configuration is missing.'] }

  validateRateValue(
    config.centerRateDegPerSec,
    'Center rate',
    MAX_ACTUAL_RATE_DEG_PER_SEC,
    errors,
  )
  validateRateValue(
    config.maxRateDegPerSec,
    'Maximum rate',
    MAX_ACTUAL_RATE_DEG_PER_SEC,
    errors,
  )
  if (!isFiniteNumber(config.expo) || config.expo < 0 || config.expo > 1) {
    errors.push('Expo must be finite and in [0, 1].')
  }

  return { valid: errors.length === 0, errors }
}

/** Validate all independent roll, pitch and yaw Actual Rates settings. */
export function validateRatesConfig(config: unknown): RatesValidationResult {
  const errors: string[] = []
  if (!isRecord(config) || !isRecord(config.axes)) {
    return { valid: false, errors: ['Rates configuration must contain an axes object.'] }
  }

  for (const axis of RATE_AXES) {
    const axisValidation = validateActualRatesConfig(config.axes[axis])
    if (!axisValidation.valid) {
      errors.push(...axisValidation.errors.map((error) => `${axis}: ${error}`))
    }
  }

  return { valid: errors.length === 0, errors }
}

/** Validate a separate per-axis symmetric rate-limit configuration. */
export function validateRateLimits(limits: unknown): RatesValidationResult {
  const errors: string[] = []
  if (!isRecord(limits)) return { valid: false, errors: ['Rate limits configuration is missing.'] }

  for (const axis of RATE_AXES) {
    const limit = limits[axis]
    if (limit !== null) {
      validateRateValue(limit, `${axis} rate limit`, MAX_RATE_LIMIT_DEG_PER_SEC, errors)
    }
  }

  return { valid: errors.length === 0, errors }
}

export function isValidNormalizedStick(value: unknown): value is number {
  return isFiniteNumber(value) && value >= MIN_NORMALIZED_STICK && value <= MAX_NORMALIZED_STICK
}

export function isRateAxis(value: unknown): value is RateAxis {
  return typeof value === 'string' && RATE_AXES.includes(value as RateAxis)
}

/**
 * Apply Betaflight 4.5.2 Actual Rates to one normalized stick sample.
 *
 * The result is a physical angular rate in degrees per second. Invalid input
 * or configuration returns NaN rather than silently clamping a control input.
 */
export function applyActualRates(normalizedStick: number, config: ActualRatesConfig): number {
  if (!isValidNormalizedStick(normalizedStick) || !validateActualRatesConfig(config).valid) {
    return INVALID_RATE
  }

  const expo = config.expo
  const centerRate = config.centerRateDegPerSec
  // This max(0, ...) is intentional: when centerRate > maxRate, canonical
  // Actual Rates keeps the center-rate endpoint instead of reducing it.
  const stickMovement = Math.max(0, config.maxRateDegPerSec - centerRate)
  const nonlinearStick = Math.abs(normalizedStick) * (
    expo * normalizedStick ** 5 + (1 - expo) * normalizedStick
  )
  const rate = centerRate * normalizedStick + stickMovement * nonlinearStick

  return Number.isFinite(rate) ? rate : INVALID_RATE
}

/** Apply an axis selected from an independent multi-axis rates profile. */
export function applyActualRatesForAxis(
  normalizedStick: number,
  config: RatesConfig,
  axis: RateAxis,
): number {
  if (!isRateAxis(axis) || !validateRatesConfig(config).valid) return INVALID_RATE
  return applyActualRates(normalizedStick, config.axes[axis])
}

/**
 * Apply the separate caller-level rate limit. This is deliberately not part
 * of applyActualRates; Betaflight clamps the resulting setpoint afterward.
 */
export function applyConfiguredRateLimit(
  rateDegPerSec: number,
  limitDegPerSec: RateLimitDegPerSec,
): number {
  if (!isFiniteNumber(rateDegPerSec)) return INVALID_RATE
  if (limitDegPerSec === null) return rateDegPerSec
  if (!validateRateLimits({ roll: limitDegPerSec, pitch: limitDegPerSec, yaw: limitDegPerSec }).valid) {
    return INVALID_RATE
  }

  return Math.min(Math.max(rateDegPerSec, -limitDegPerSec), limitDegPerSec)
}

/** Apply a selected limit from an independent per-axis limit configuration. */
export function applyConfiguredRateLimitForAxis(
  rateDegPerSec: number,
  limits: AxisRateLimits,
  axis: RateAxis,
): number {
  if (!isRateAxis(axis) || !validateRateLimits(limits).valid) return INVALID_RATE
  return applyConfiguredRateLimit(rateDegPerSec, limits[axis])
}

/** Convert a finite physical angular rate from degrees/s to radians/s. */
export function degreesPerSecondToRadiansPerSecond(degreesPerSecond: number): number {
  if (!isFiniteNumber(degreesPerSecond)) return INVALID_RATE
  const radiansPerSecond = degreesPerSecond * Math.PI / 180
  return Number.isFinite(radiansPerSecond) ? radiansPerSecond : INVALID_RATE
}

/** Convert a finite physical angular rate from radians/s to degrees/s. */
export function radiansPerSecondToDegreesPerSecond(radiansPerSecond: number): number {
  if (!isFiniteNumber(radiansPerSecond)) return INVALID_RATE
  const degreesPerSecond = radiansPerSecond * 180 / Math.PI
  return Number.isFinite(degreesPerSecond) ? degreesPerSecond : INVALID_RATE
}

export function applyActualRatesRadPerSec(
  normalizedStick: number,
  config: ActualRatesConfig,
): number {
  return degreesPerSecondToRadiansPerSecond(applyActualRates(normalizedStick, config))
}

export function applyConfiguredRateLimitRadPerSec(
  rateRadPerSec: number,
  limitRadPerSec: number | null,
): number {
  if (!isFiniteNumber(rateRadPerSec)) return INVALID_RATE
  if (limitRadPerSec === null) return rateRadPerSec
  const rateDegPerSec = radiansPerSecondToDegreesPerSecond(rateRadPerSec)
  const limitDegPerSec = radiansPerSecondToDegreesPerSecond(limitRadPerSec)
  if (!isFiniteNumber(rateDegPerSec) || !isFiniteNumber(limitDegPerSec)) return INVALID_RATE
  return degreesPerSecondToRadiansPerSecond(
    applyConfiguredRateLimit(rateDegPerSec, limitDegPerSec),
  )
}

function defaultAxisRates(): ActualRatesConfig {
  return {
    centerRateDegPerSec: 70,
    maxRateDegPerSec: 670,
    expo: 0,
  }
}

/**
 * Independent starting values for a freestyle trainer. They are transparent
 * tuning assumptions, not measurements or a claim of airframe realism.
 */
export function createDefaultRatesConfig(): RatesConfig {
  return {
    axes: {
      roll: defaultAxisRates(),
      pitch: defaultAxisRates(),
      yaw: defaultAxisRates(),
    },
  }
}

export const DEFAULT_RATES_CONFIG = createDefaultRatesConfig()

/** No caller-level limit is enabled by default; the clamp remains explicit. */
export const DEFAULT_RATE_LIMITS_DEG_PER_SEC: AxisRateLimits = {
  roll: null,
  pitch: null,
  yaw: null,
}
