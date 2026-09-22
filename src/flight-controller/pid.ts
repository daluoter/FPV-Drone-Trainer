import type { PidAxisTelemetry, RatePidAxisConfig } from './types'

const INVALID_OUTPUT = 0

export interface RatePidUpdateResult extends PidAxisTelemetry {
  readonly reset: boolean
}

export interface RatePidValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Validate one SI rate PID configuration without throwing on malformed input. */
export function validateRatePidAxisConfig(config: unknown): RatePidValidationResult {
  const errors: string[] = []
  if (!isRecord(config)) return { valid: false, errors: ['Rate PID configuration is missing.'] }

  for (const name of ['kp', 'ki', 'kd'] as const) {
    if (!finiteNonNegative(config[name])) errors.push(`${name} must be finite and non-negative.`)
  }
  if (!finiteNonNegative(config.integralLimit) || config.integralLimit <= 0) {
    errors.push('Integral limit must be finite and greater than zero.')
  }
  if (!finiteNonNegative(config.outputLimitNm) || config.outputLimitNm <= 0) {
    errors.push('Output limit must be finite and greater than zero.')
  }
  if (
    config.derivativeOnMeasurement !== undefined &&
    typeof config.derivativeOnMeasurement !== 'boolean'
  ) {
    errors.push('Derivative-on-measurement option must be boolean.')
  }
  if (
    config.derivativeFilterTimeConstantSeconds !== undefined &&
    (!finiteNonNegative(config.derivativeFilterTimeConstantSeconds) || config.derivativeFilterTimeConstantSeconds <= 0)
  ) {
    errors.push('Derivative filter time constant must be finite and greater than zero.')
  }

  return { valid: errors.length === 0, errors }
}

function safeConfig(config: RatePidAxisConfig): RatePidAxisConfig {
  const validation = validateRatePidAxisConfig(config)
  if (validation.valid) {
    return {
      ...config,
      derivativeOnMeasurement: config.derivativeOnMeasurement ?? true,
    }
  }
  return {
    kp: 0,
    ki: 0,
    kd: 0,
    integralLimit: 1,
    outputLimitNm: 1,
    derivativeOnMeasurement: true,
  }
}

function signedClamp(value: number, limit: number): number {
  return Math.min(Math.max(value, -limit), limit)
}

function zeroTelemetry(warnings: readonly string[], reset = true): RatePidUpdateResult {
  return {
    errorRadPerSec: 0,
    integral: 0,
    integralTermNm: 0,
    proportionalTermNm: 0,
    derivativeTermNm: 0,
    derivativeRadPerSec2: 0,
    outputNm: INVALID_OUTPUT,
    saturated: false,
    valid: false,
    warnings: [...warnings],
    reset,
  }
}

/**
 * Stateful single-axis angular-rate PID. State is owned by the instance, never
 * by module globals. The derivative defaults to measurement differentiation so
 * a rate-setpoint step does not create a derivative kick.
 */
export class RatePidAxisController {
  public readonly config: RatePidAxisConfig
  private integral = 0
  private previousMeasurement: number | null = null
  private previousDerivative = 0

  public constructor(config: RatePidAxisConfig) {
    this.config = safeConfig(config)
  }

  public reset(): void {
    this.integral = 0
    this.previousMeasurement = null
    this.previousError = 0
    this.previousDerivative = 0
  }

  public get integralState(): number {
    return this.integral
  }

  /**
   * Update one axis using target and measurement in radians per second and
   * return a bounded torque in Newton-metres. Invalid data resets state and
   * returns zero rather than retaining a previous command.
   */
  public update(
    targetRadPerSec: number,
    measuredRadPerSec: number,
    deltaSeconds: number,
    externallySaturated = false,
  ): RatePidUpdateResult {
    const configValidation = validateRatePidAxisConfig(this.config)
    if (!configValidation.valid) {
      this.reset()
      return zeroTelemetry(configValidation.errors)
    }
    if (
      !Number.isFinite(targetRadPerSec) ||
      !Number.isFinite(measuredRadPerSec) ||
      !Number.isFinite(deltaSeconds) ||
      deltaSeconds <= 0
    ) {
      this.reset()
      return zeroTelemetry(['Rate PID target, measurement, or timestep was invalid.'])
    }

    const error = targetRadPerSec - measuredRadPerSec
    if (!Number.isFinite(error)) {
      this.reset()
      return zeroTelemetry(['Rate PID error became non-finite.'])
    }
    const rawMeasurementDerivative = this.previousMeasurement === null
      ? 0
      : (measuredRadPerSec - this.previousMeasurement) / deltaSeconds
    const rawErrorDerivative = this.previousMeasurement === null
      ? 0
      : (error - this.previousError) / deltaSeconds
    const derivativeInput = (this.config.derivativeOnMeasurement ?? true)
      ? -rawMeasurementDerivative
      : rawErrorDerivative
    const filterTimeConstant = this.config.derivativeFilterTimeConstantSeconds
    const derivative = (filterTimeConstant === undefined
      ? derivativeInput
      : this.previousMeasurement === null
        ? derivativeInput
        : this.previousDerivative + (
          deltaSeconds / (filterTimeConstant + deltaSeconds)
        ) * (derivativeInput - this.previousDerivative)) || 0

    const proportionalTermNm = this.config.kp * error
    const derivativeTermNm = this.config.kd * derivative
    if (!Number.isFinite(derivative) || !Number.isFinite(proportionalTermNm) || !Number.isFinite(derivativeTermNm)) {
      this.reset()
      return zeroTelemetry(['Rate PID term became non-finite.'])
    }
    const candidateIntegral = signedClamp(
      this.integral + error * deltaSeconds,
      this.config.integralLimit,
    )
    const candidateIntegralTermNm = this.config.ki * candidateIntegral
    const candidateUnboundedOutput = proportionalTermNm + candidateIntegralTermNm + derivativeTermNm
    const candidateSaturated = Math.abs(candidateUnboundedOutput) > this.config.outputLimitNm

    // Conditional integration is a conservative anti-windup rule: while the
    // output is pinned, an integral that pushes further into the pin is held;
    // an integral that helps leave it is still accepted. External mixer
    // saturation is conservative and holds accumulation until authority returns.
    const pushesIntoSaturation = candidateSaturated && Math.sign(candidateUnboundedOutput) === Math.sign(error)
    const externalPushesIntoSaturation = externallySaturated
    if (!pushesIntoSaturation && !externalPushesIntoSaturation) this.integral = candidateIntegral

    const integralTermNm = this.config.ki * this.integral
    const unboundedOutput = proportionalTermNm + integralTermNm + derivativeTermNm
    if (!Number.isFinite(integralTermNm) || !Number.isFinite(unboundedOutput)) {
      this.reset()
      return zeroTelemetry(['Rate PID output became non-finite.'])
    }
    const outputNm = signedClamp(unboundedOutput, this.config.outputLimitNm)
    const saturated = Math.abs(unboundedOutput) > this.config.outputLimitNm

    this.previousMeasurement = measuredRadPerSec
    this.previousError = error
    this.previousDerivative = derivative
    return {
      errorRadPerSec: error,
      integral: this.integral,
      integralTermNm,
      proportionalTermNm,
      derivativeTermNm,
      derivativeRadPerSec2: derivative,
      outputNm,
      saturated,
      valid: true,
      warnings: [],
      reset: false,
    }
  }

  private previousError = 0
}

/** Stateless convenience update for callers that own the PID instance. */
export function updateRatePid(
  controller: RatePidAxisController,
  targetRadPerSec: number,
  measuredRadPerSec: number,
  deltaSeconds: number,
): RatePidUpdateResult {
  return controller.update(targetRadPerSec, measuredRadPerSec, deltaSeconds)
}
