import { MAX_STICK_DEADBAND } from './signal'
import {
  CONTROLLER_PROFILE_VERSION,
  CONTROL_CHANNELS,
  type ChannelCalibration,
  type ControlChannel,
  type ControllerDevice,
  type ControllerProfile,
  type NeutralStabilityReport,
} from './types'
import { DEFAULT_STICK_DEADBAND } from './signal'

export interface ProfileValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

export interface ProfilePersistenceResult {
  readonly saved: boolean
  readonly errors: readonly string[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type ChannelCalibrationInput = Readonly<{
  axis: number
  center: number
  minimum: number
  maximum: number
  invert?: boolean
  deadband?: number
}>

const PROFILE_KEY_PREFIX = 'fpv-drone-trainer.controller-profile.v1.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseChannelCalibration(value: unknown): ChannelCalibration | null {
  if (!isRecord(value)) return null
  if (
    typeof value.axis !== 'number' ||
    typeof value.invert !== 'boolean' ||
    typeof value.center !== 'number' ||
    typeof value.minimum !== 'number' ||
    typeof value.maximum !== 'number' ||
    typeof value.deadband !== 'number'
  ) {
    return null
  }
  return {
    axis: value.axis,
    invert: value.invert,
    center: value.center,
    minimum: value.minimum,
    maximum: value.maximum,
    deadband: value.deadband,
  }
}

function parseNumberRecord(value: unknown): { roll: number; pitch: number; yaw: number } | null {
  if (!isRecord(value)) return null
  const roll = value.roll
  const pitch = value.pitch
  const yaw = value.yaw
  if (
    typeof roll !== 'number' || !Number.isFinite(roll) ||
    typeof pitch !== 'number' || !Number.isFinite(pitch) ||
    typeof yaw !== 'number' || !Number.isFinite(yaw)
  ) {
    return null
  }
  return { roll, pitch, yaw }
}

function parseNeutralStability(value: unknown): NeutralStabilityReport | null {
  if (value === null) return null
  if (!isRecord(value)) return null
  if (
    typeof value.sampleCount !== 'number' ||
    typeof value.durationMs !== 'number' ||
    typeof value.threshold !== 'number' ||
    typeof value.stable !== 'boolean'
  ) {
    return null
  }
  const maxAbsolute = parseNumberRecord(value.maxAbsolute)
  const mean = parseNumberRecord(value.mean)
  const standardDeviation = parseNumberRecord(value.standardDeviation)
  if (!maxAbsolute || !mean || !standardDeviation) return null
  return {
    sampleCount: value.sampleCount,
    durationMs: value.durationMs,
    threshold: value.threshold,
    maxAbsolute,
    mean,
    standardDeviation,
    stable: value.stable,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
  }
}

/** Runtime schema guard for versioned local-storage data. */
export function parseControllerProfile(value: unknown): ControllerProfile | null {
  if (!isRecord(value)) return null
  if (
    value.schemaVersion !== CONTROLLER_PROFILE_VERSION ||
    typeof value.deviceId !== 'string' ||
    typeof value.deviceMapping !== 'string' ||
    typeof value.axisCount !== 'number' ||
    typeof value.buttonCount !== 'number' ||
    value.throttleMode !== 'single-ended' ||
    typeof value.calibrationTimestamp !== 'string' ||
    !isNullableString(value.directionVerifiedAt) ||
    !isNullableString(value.neutralVerifiedAt) ||
    !isRecord(value.channels)
  ) {
    return null
  }

  const channels = {} as Record<ControlChannel, ChannelCalibration>
  for (const channel of CONTROL_CHANNELS) {
    const parsed = parseChannelCalibration(value.channels[channel])
    if (!parsed) return null
    channels[channel] = parsed
  }

  const neutralStability = parseNeutralStability(value.neutralStability)
  if (value.neutralStability !== null && neutralStability === null) return null

  return {
    schemaVersion: CONTROLLER_PROFILE_VERSION,
    deviceId: value.deviceId,
    deviceMapping: value.deviceMapping,
    axisCount: value.axisCount,
    buttonCount: value.buttonCount,
    channels,
    throttleMode: 'single-ended',
    calibrationTimestamp: value.calibrationTimestamp,
    directionVerifiedAt: value.directionVerifiedAt,
    neutralVerifiedAt: value.neutralVerifiedAt,
    neutralStability,
  }
}

export function validateControllerProfile(
  profile: ControllerProfile,
  device?: ControllerDevice,
): ProfileValidationResult {
  const errors: string[] = []
  if (profile.schemaVersion !== CONTROLLER_PROFILE_VERSION) errors.push('Profile schema version is unsupported.')
  if (!profile.deviceId) errors.push('Profile device ID is empty.')
  if (!Number.isInteger(profile.axisCount) || profile.axisCount <= 0) errors.push('Profile axis count is invalid.')
  if (!Number.isInteger(profile.buttonCount) || profile.buttonCount < 0) errors.push('Profile button count is invalid.')
  if (profile.throttleMode !== 'single-ended') errors.push('Throttle mode is unsupported.')
  if (!profile.calibrationTimestamp) errors.push('Calibration timestamp is missing.')

  const usedAxes = new Set<number>()
  for (const channel of CONTROL_CHANNELS) {
    const calibration = profile.channels[channel]
    if (!calibration) {
      errors.push(`${channel} calibration is missing.`)
      continue
    }
    if (!Number.isInteger(calibration.axis) || calibration.axis < 0 || calibration.axis >= profile.axisCount) {
      errors.push(`${channel} axis index is outside the device range.`)
    }
    if (usedAxes.has(calibration.axis)) errors.push(`${channel} reuses an axis already assigned to another channel.`)
    usedAxes.add(calibration.axis)
    if (!Number.isFinite(calibration.center) || !Number.isFinite(calibration.minimum) || !Number.isFinite(calibration.maximum)) {
      errors.push(`${channel} contains a non-finite endpoint.`)
      continue
    }
    if (calibration.minimum >= calibration.maximum) errors.push(`${channel} endpoint order is invalid.`)
    if (channel !== 'throttle' && (calibration.minimum >= calibration.center || calibration.center >= calibration.maximum)) {
      errors.push(`${channel} center is not inside its calibrated endpoints.`)
    }
    if (
      !Number.isFinite(calibration.deadband) ||
      calibration.deadband < 0 ||
      calibration.deadband > MAX_STICK_DEADBAND ||
      (channel === 'throttle' && calibration.deadband !== 0)
    ) {
      errors.push(`${channel} deadband is outside the safe configurable range.`)
    }
  }

  if (device) {
    if (!device.connected) errors.push('The selected device is disconnected.')
    if (profile.deviceId !== device.id) errors.push('Profile device ID does not match the selected device.')
    if (profile.deviceMapping !== device.mapping) errors.push('Profile mapping does not match the selected device.')
    if (profile.axisCount !== device.axisCount) errors.push('Profile axis count does not match the selected device.')
    if (profile.buttonCount !== device.buttonCount) errors.push('Profile button count does not match the selected device.')
  }

  return { valid: errors.length === 0, errors }
}

export function isProfileCompatible(profile: ControllerProfile, device: ControllerDevice): boolean {
  return validateControllerProfile(profile, device).valid
}

export function createControllerProfile(
  device: ControllerDevice,
  channels: Readonly<Record<ControlChannel, ChannelCalibrationInput>>,
  timestamp = new Date().toISOString(),
): ControllerProfile {
  const calibratedChannels = {} as Record<ControlChannel, ChannelCalibration>
  for (const channel of CONTROL_CHANNELS) {
    const input = channels[channel]
    calibratedChannels[channel] = {
      axis: input.axis,
      center: input.center,
      minimum: input.minimum,
      maximum: input.maximum,
      invert: input.invert ?? false,
      deadband: input.deadband ?? (channel === 'throttle' ? 0 : DEFAULT_STICK_DEADBAND),
    }
  }

  return {
    schemaVersion: CONTROLLER_PROFILE_VERSION,
    deviceId: device.id,
    deviceMapping: device.mapping,
    axisCount: device.axisCount,
    buttonCount: device.buttonCount,
    channels: calibratedChannels,
    throttleMode: 'single-ended',
    calibrationTimestamp: timestamp,
    directionVerifiedAt: null,
    neutralVerifiedAt: null,
    neutralStability: null,
  }
}

export function invalidateProfileVerification(profile: ControllerProfile): ControllerProfile {
  return {
    ...profile,
    directionVerifiedAt: null,
    neutralVerifiedAt: null,
    neutralStability: null,
  }
}

export function updateChannelCalibration(
  profile: ControllerProfile,
  channel: ControlChannel,
  patch: Partial<ChannelCalibration>,
): ControllerProfile {
  const current = profile.channels[channel]
  const nextChannel: ChannelCalibration = {
    ...current,
    ...patch,
  }
  return invalidateProfileVerification({
    ...profile,
    channels: {
      ...profile.channels,
      [channel]: nextChannel,
    },
  })
}

export function markDirectionsVerified(
  profile: ControllerProfile,
  timestamp = new Date().toISOString(),
): ControllerProfile {
  return {
    ...profile,
    directionVerifiedAt: timestamp,
    neutralVerifiedAt: null,
    neutralStability: null,
  }
}

export function markNeutralVerified(
  profile: ControllerProfile,
  report: NeutralStabilityReport,
  timestamp = new Date().toISOString(),
): ControllerProfile {
  if (!report.stable || !profile.directionVerifiedAt || !validateControllerProfile(profile).valid) {
    return invalidateProfileVerification(profile)
  }
  return {
    ...profile,
    neutralVerifiedAt: timestamp,
    neutralStability: report,
  }
}

function profileStorageKey(deviceId: string): string {
  return `${PROFILE_KEY_PREFIX}${encodeURIComponent(deviceId)}`
}

function defaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export class ControllerProfileStore {
  private readonly storage: StorageLike | null

  public constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage
  }

  public save(profile: ControllerProfile): ProfilePersistenceResult {
    const validation = validateControllerProfile(profile)
    if (!validation.valid || !this.storage) {
      return { saved: false, errors: validation.valid ? ['Browser storage is unavailable.'] : validation.errors }
    }
    try {
      this.storage.setItem(profileStorageKey(profile.deviceId), JSON.stringify(profile))
      return { saved: true, errors: [] }
    } catch {
      return { saved: false, errors: ['Browser storage rejected the controller profile.'] }
    }
  }

  public loadCompatible(device: ControllerDevice): ControllerProfile | null {
    if (!this.storage) return null
    let encoded: string | null
    try {
      encoded = this.storage.getItem(profileStorageKey(device.id))
    } catch {
      return null
    }
    if (!encoded) return null

    try {
      const profile = parseControllerProfile(JSON.parse(encoded) as unknown)
      return profile && isProfileCompatible(profile, device) ? profile : null
    } catch {
      return null
    }
  }

  public reset(deviceId: string): void {
    if (!this.storage) return
    try {
      this.storage.removeItem(profileStorageKey(deviceId))
    } catch {
      // Storage failures are non-fatal; a fresh calibration can still run in memory.
    }
  }
}
