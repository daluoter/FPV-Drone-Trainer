import {
  CONTROL_CHANNELS,
  type ChannelCalibration,
  type ControlChannel,
  type ControllerProfile,
  type ProcessedChannels,
  type ProcessedControllerState,
  type RawGamepadSnapshot,
} from './types'

/** Keep the neutral deadband below the 0.02 approval threshold. */
export const DEFAULT_STICK_DEADBAND = 0.01
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
  // Measured endpoints are safety/calibration evidence, not values to attenuate
  // into a permanently smaller command. The transient between them is filtered.
  if (Math.abs(input) >= 1) return input
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

  for (const channel of CONTROL_CHANNELS) {
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
    valid:
      invalidChannels.length === 0 &&
      snapshot.invalidAxisIndices.length === 0 &&
      snapshot.invalidButtonIndices.length === 0,
    invalidChannels,
  }
}

function profileFilterKey(profile: ControllerProfile): string {
  return JSON.stringify([
    profile.deviceId,
    profile.deviceMapping,
    profile.axisCount,
    profile.buttonCount,
    CONTROL_CHANNELS.map((channel) => {
      const calibration = profile.channels[channel]
      return [
        channel,
        calibration.axis,
        calibration.center,
        calibration.minimum,
        calibration.maximum,
        calibration.invert,
        calibration.deadband,
      ]
    }),
  ])
}

/**
 * Owns the high-frequency filter tail outside React. A source/profile change,
 * timestamp rewind, or invalid sample starts a fresh tail rather than allowing
 * old neutral data to leak into a new capture or device connection.
 */
export class ControllerSignalHistory {
  private sourceKey: string | null = null
  private previousFiltered: PreviousFilteredValues = {}
  private lastTimestamp: number | null = null

  public reset(): void {
    this.sourceKey = null
    this.previousFiltered = {}
    this.lastTimestamp = null
  }

  public process(snapshot: RawGamepadSnapshot, profile: ControllerProfile): ProcessedControllerState {
    const nextSourceKey = JSON.stringify([
      snapshot.id,
      snapshot.index,
      snapshot.mapping,
      snapshot.axisCount,
      snapshot.buttonCount,
      snapshot.connectionSession ?? null,
      profileFilterKey(profile),
    ])
    if (nextSourceKey !== this.sourceKey) {
      this.reset()
      this.sourceKey = nextSourceKey
    }

    let deltaSeconds = 1 / 60
    const timestamp = snapshot.timestamp
    if (Number.isFinite(timestamp) && this.lastTimestamp !== null) {
      if (timestamp <= this.lastTimestamp) {
        this.previousFiltered = {}
        deltaSeconds = 1 / 60
      } else {
        deltaSeconds = (timestamp - this.lastTimestamp) / 1_000
      }
    }
    this.lastTimestamp = Number.isFinite(timestamp) ? timestamp : null

    const state = processControllerSnapshot(snapshot, profile, this.previousFiltered, deltaSeconds)
    if (!state.valid) {
      this.previousFiltered = {}
      return state
    }

    this.previousFiltered = Object.fromEntries(
      CONTROL_CHANNELS.map((channel) => [channel, state.channels[channel].final]),
    ) as PreviousFilteredValues
    return state
  }
}
