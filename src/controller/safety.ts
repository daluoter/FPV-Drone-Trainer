import { DEFAULT_NEUTRAL_THRESHOLD } from './calibration'
import { isProfileCompatible, validateControllerProfile } from './profile'
import type {
  ControllerDevice,
  ControllerProfile,
  ProcessedControllerState,
  StickChannel,
} from './types'

const STICK_CHANNELS: readonly StickChannel[] = ['roll', 'pitch', 'yaw']

export const ARM_THROTTLE_MAX = 0.05

export interface FlightEligibilityOptions {
  /** Current connection identity; a persisted neutral report never supplies this. */
  readonly connectionSession?: string | null
  /** Only arm-time handoff checks current stick/throttle positions. */
  readonly requireArmNeutral?: boolean
}

export interface FlightEligibility {
  readonly eligible: boolean
  readonly reasons: readonly string[]
}

function appendArmPositionReasons(
  reasons: string[],
  processed: ProcessedControllerState | null,
): void {
  if (!processed || !processed.valid) return

  for (const channel of STICK_CHANNELS) {
    const value = processed.channels[channel].final
    if (!Number.isFinite(value) || Math.abs(value) > DEFAULT_NEUTRAL_THRESHOLD) {
      reasons.push(`${channel.toUpperCase()} must be neutral before arming.`)
    }
  }

  const throttle = processed.channels.throttle.final
  if (!Number.isFinite(throttle) || throttle > ARM_THROTTLE_MAX) {
    reasons.push(`Throttle must be at or below ${ARM_THROTTLE_MAX.toFixed(2)} before arming.`)
  }
}

/**
 * Evaluates the persistent controller contract. This is intentionally safe to
 * display continuously: moving a stick after this gate passes does not revoke
 * calibration or reject an intended future flight command.
 */
export function evaluateFlightEligibility(
  device: ControllerDevice | null,
  profile: ControllerProfile | null,
  processed: ProcessedControllerState | null,
  options: FlightEligibilityOptions = {},
): FlightEligibility {
  const reasons: string[] = []

  if (!device) reasons.push('Select a connected controller.')
  if (device && !device.connected) reasons.push('The selected controller is disconnected.')
  if (!profile) reasons.push('Complete controller calibration.')
  if (device && profile && !isProfileCompatible(profile, device)) {
    reasons.push('The saved profile does not match this device; recalibrate before flight.')
  }
  if (profile) {
    const validation = validateControllerProfile(profile, device ?? undefined)
    if (!validation.valid) reasons.push(...validation.errors)
    if (!profile.directionVerifiedAt) reasons.push('Verify each channel direction before flight.')
    if (!profile.neutralVerifiedAt || !profile.neutralStability?.stable) {
      reasons.push('Pass the hands-off neutral stability test before flight.')
    } else if (
      !options.connectionSession ||
      !profile.neutralVerificationSession ||
      profile.neutralVerificationSession !== options.connectionSession
    ) {
      reasons.push('Run a fresh timed neutral test for this controller connection before flight.')
    }
  }
  if (!processed) {
    reasons.push('No processed controller sample is available.')
  } else if (!processed.valid || processed.invalidChannels.length > 0) {
    reasons.push('The latest controller sample contains invalid input.')
  }

  if (options.requireArmNeutral) appendArmPositionReasons(reasons, processed)

  return {
    eligible: reasons.length === 0,
    reasons,
  }
}

/**
 * Arm-time handoff gate. Unlike evaluateFlightEligibility, this samples the
 * current rotational neutral and low-throttle condition only at arming; once a
 * future flight mode is armed, intended stick movement is not continuously
 * rejected by these handoff conditions.
 */
export function evaluateFlightArmEligibility(
  device: ControllerDevice | null,
  profile: ControllerProfile | null,
  processed: ProcessedControllerState | null,
  options: Omit<FlightEligibilityOptions, 'requireArmNeutral'> = {},
): FlightEligibility {
  return evaluateFlightEligibility(device, profile, processed, {
    ...options,
    requireArmNeutral: true,
  })
}
