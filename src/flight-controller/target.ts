import {
  applyActualRatesForAxis,
  applyConfiguredRateLimitForAxis,
  degreesPerSecondToRadiansPerSecond,
} from '../rates'
import { pilotAxesToBodyAngularRate, isFiniteNormalizedRcInput } from './axes'
import { validateFlightControllerConfig } from './config'
import type {
  FlightControllerConfig,
  NormalizedRcInput,
  PilotAngularRateRadPerSec,
  TargetRateResult,
} from './types'

function zeroTarget(warnings: readonly string[]): TargetRateResult {
  return {
    targetPilotRateRadPerSec: { roll: 0, pitch: 0, yaw: 0 },
    targetBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
    throttle: 0,
    valid: false,
    warnings: [...warnings],
  }
}

/**
 * Convert normalized RC sticks through Actual Rates and explicit SI conversion.
 * The returned target is a body-frame angular-rate vector in rad/s; throttle
 * remains a bounded normalized collective command.
 */
export function normalizedRcToTargetRates(
  input: NormalizedRcInput,
  config: FlightControllerConfig,
): TargetRateResult {
  if (!isFiniteNormalizedRcInput(input)) {
    return zeroTarget(['Normalized RC input was invalid.'])
  }
  const validation = validateFlightControllerConfig(config)
  if (!validation.valid) {
    return zeroTarget(validation.errors.map((error) => `Flight-controller configuration: ${error}`))
  }

  const pilotRates = {} as Record<'roll' | 'pitch' | 'yaw', number>
  for (const axis of ['roll', 'pitch', 'yaw'] as const) {
    const actualRateDegPerSec = applyActualRatesForAxis(input[axis], config.rates, axis)
    const limitedRateDegPerSec = applyConfiguredRateLimitForAxis(
      actualRateDegPerSec,
      config.rateLimitsDegPerSec,
      axis,
    )
    const rateRadPerSec = degreesPerSecondToRadiansPerSecond(limitedRateDegPerSec)
    if (!Number.isFinite(rateRadPerSec)) {
      return zeroTarget([`${axis} Actual Rates calculation was non-finite.`])
    }
    pilotRates[axis] = rateRadPerSec
  }

  const targetPilotRateRadPerSec: PilotAngularRateRadPerSec = pilotRates
  const targetBodyRateRadPerSec = pilotAxesToBodyAngularRate({
    roll: pilotRates.roll,
    pitch: pilotRates.pitch,
    yaw: pilotRates.yaw,
  })
  if (
    !Number.isFinite(targetBodyRateRadPerSec.x) ||
    !Number.isFinite(targetBodyRateRadPerSec.y) ||
    !Number.isFinite(targetBodyRateRadPerSec.z)
  ) {
    return zeroTarget(['Body angular-rate target was non-finite.'])
  }

  return {
    targetPilotRateRadPerSec,
    targetBodyRateRadPerSec,
    throttle: input.throttle,
    valid: true,
    warnings: [],
  }
}
