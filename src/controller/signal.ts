import type {
  ChannelCalibration,
  ControlChannel,
  ControllerProfile,
  ProcessedChannels,
  ProcessedControllerState,
  RawGamepadSnapshot,
} from './types'

export const DEFAULT_STICK_DEADBAND = 0.03
export const MAX_STICK_DEADBAND = 0.2
export const DEFAULT_FILTER_TIME_CONSTANT_SECONDS = 0.015

const INVALID_VALUE = Number.NaN

export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value)
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

/**
 * Remaps the usable stick range after deadband removal. A deadband of 0.03
 * therefore suppresses only the inner 3% and does not reduce full-stick output.
 */
export function applyRemappedDeadband(value: number, deadband: number): number {
  if (!isFiniteNumber(value) || !isFiniteNumber(deadband) || deadband < 0 || deadband >= 1) {
    return INVALID_VALUE
  }

  const magnitude = Math.abs(value)
  if (magnitude <= deadband) return 0

  return Math.sign(value) * ((magnitude - deadband) / (1 - deadband))
}

export function normalizeCentered(raw: number, calibration: ChannelCalibration): number {
  if (!isFiniteNumber(raw) || !isFiniteNumber(calibration.center)) return INVALID_VALUE
  if (
    !isFiniteNumber(calibration.minimum) ||
    !isFiniteNumber(calibration.maximum) ||
    calibration.minimum >= calibration.center ||
    calibration.maximum <= calibration.center
  ) {
    return INVALID_VALUE
  }

  const normalized = raw >= calibration.center
    ? (raw - calibration.center) / (calibration.maximum - calibration.center)
    : (raw - calibration.center) / (calibration.center - calibration.minimum)
  const clamped = clamp(normalized, -1, 1)
  return calibration.invert ? -clamped : clamped
}

/** Throttle is deliberately non-centering: calibrated minimum is zero output. */
export function normalizeThrottle(raw: number, calibration: ChannelCalibration): number {
  if (
    !isFiniteNumber(raw) ||
    !isFiniteNumber(calibration.minimum) ||
    !isFiniteNumber(calibration.maximum) ||
    calibration.minimum >= calibration.maximum
  ) {
    return INVALID_VALUE
  }

  const normalized = clamp(
    (raw - calibration.minimum) / (calibration.maximum - calibration.minimum),
    0,
    1,
  )
  return calibration.invert ? 1 - normalized : normalized
}

export function filterSignal(
  input: number,
  previous: number | undefined,
  deltaSeconds: number,
  timeConstantSeconds = DEFAULT_FILTER_TIME_CONSTANT_SECONDS,
): number {
  if (!isFiniteNumber(input)) return INVALID_VALUE
  if (previous === undefined || !isFiniteNumber(previous)) return input
  if (!isFiniteNumber(deltaSeconds) || deltaSeconds <= 0) return input
  if (!isFiniteNumber(timeConstantSeconds) || timeConstantSeconds <= 0) return input

  const alpha = clamp(deltaSeconds / (timeConstantSeconds + deltaSeconds), 0, 1)
  return previous + alpha * (input - previous)
}

function isCalibrationUsable(channel: ControlChannel, calibration: ChannelCalibration): boolean {
  if (!Number.isInteger(calibration.axis) || calibration.axis < 0) return false
  if (
    !isFiniteNumber(calibration.center) ||
    !isFiniteNumber(calibration.minimum) ||
    !isFiniteNumber(calibration.maximum)
  ) {
    return false
  }
  if (!isFiniteNumber(calibration.deadband) || calibration.deadband < 0 || calibration.deadband > MAX_STICK_DEADBAND) {
    return false
  }

  if (channel === 'throttle') {
    return calibration.minimum < calibration.maximum
  }
  return calibration.minimum < calibration.center && calibration.center < calibration.maximum
}

function invalidPipeline(raw: number): {
  raw: number
  calibrated: number
  normalized: number
  deadband: number
  filtered: number
  final: number
  valid: false
} {
  return {
    raw,
    calibrated: INVALID_VALUE,
    normalized: INVALID_VALUE,
    deadband: INVALID_VALUE,
    filtered: INVALID_VALUE,
    final: INVALID_VALUE,
    valid: false,
  }
}

export function processChannel(
  channel: ControlChannel,
  raw: number,
  calibration: ChannelCalibration,
  previousFiltered: number | undefined,
  deltaSeconds: number,
): {
  raw: number
  calibrated: number
  normalized: number
  deadband: number
  filtered: number
  final: number
  valid: boolean
} {
  if (!isCalibrationUsable(channel, calibration) || !isFiniteNumber(raw)) {
    return invalidPipeline(raw)
  }

  const calibrated = channel === 'throttle' ? raw - calibration.minimum : raw - calibration.center
  const normalized = channel === 'throttle'
    ? normalizeThrottle(raw, calibration)
    : normalizeCentered(raw, calibration)
  if (!isFiniteNumber(normalized)) return invalidPipeline(raw)

  const deadband = applyRemappedDeadband(normalized, calibration.deadband)
  if (!isFiniteNumber(deadband)) return invalidPipeline(raw)

  const filtered = filterSignal(deadband, previousFiltered, deltaSeconds)
  if (!isFiniteNumber(filtered)) return invalidPipeline(raw)

  return {
    raw,
    calibrated,
    normalized,
    deadband,
    filtered,
    final: filtered,
    valid: true,
  }
}

export type PreviousFilteredValues = Partial<Record<ControlChannel, number>>

export function processControllerSnapshot(
  snapshot: RawGamepadSnapshot,
  profile: ControllerProfile,
  previousFiltered: PreviousFilteredValues = {},
  deltaSeconds = 1 / 60,
): ProcessedControllerState {
  const channels = {} as Record<ControlChannel, ReturnType<typeof processChannel>>
  const invalidChannels: ControlChannel[] = []

  for (const channel of ['roll', 'pitch', 'yaw', 'throttle'] as const) {
    const calibration = profile.channels[channel]
    const raw = snapshot.axes[calibration.axis] ?? INVALID_VALUE
    const processed = processChannel(
      channel,
      raw,
      calibration,
      previousFiltered[channel],
      deltaSeconds,
    )
    channels[channel] = processed
    if (!processed.valid) invalidChannels.push(channel)
  }

  return {
    deviceIndex: snapshot.index,
    timestamp: snapshot.timestamp,
    channels: channels as ProcessedChannels,
    valid: invalidChannels.length === 0 && snapshot.invalidAxisIndices.length === 0,
    invalidChannels,
  }
}
