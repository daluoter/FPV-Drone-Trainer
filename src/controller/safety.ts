import { isProfileCompatible, validateControllerProfile } from './profile'
import type {
  ControllerDevice,
  ControllerProfile,
  ProcessedControllerState,
} from './types'

export interface FlightEligibility {
  readonly eligible: boolean
  readonly reasons: readonly string[]
}

export function evaluateFlightEligibility(
  device: ControllerDevice | null,
  profile: ControllerProfile | null,
  processed: ProcessedControllerState | null,
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
    }
  }
  if (!processed) {
    reasons.push('No processed controller sample is available.')
  } else if (!processed.valid || processed.invalidChannels.length > 0) {
    reasons.push('The latest controller sample contains invalid input.')
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  }
}
