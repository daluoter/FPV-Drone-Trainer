import type {
  ChannelPipelineValues,
  ControlChannel,
  NeutralStabilityReport,
  ProcessedChannels,
  StickChannel,
} from './types'

export const MIN_CENTER_SAMPLES = 30
export const DEFAULT_CENTER_MAX_JITTER = 0.08
export const DEFAULT_CENTER_MAX_STANDARD_DEVIATION = 0.025
/**
 * Neutral is intentionally tighter than a useful rate command. A five percent
 * allowance can hide a meaningful input, so persisted evidence may not widen
 * this policy beyond the documented upper bound.
 */
export const DEFAULT_NEUTRAL_THRESHOLD = 0.02
export const MIN_NEUTRAL_THRESHOLD = 0.005
export const MAX_NEUTRAL_THRESHOLD = 0.02
export const DEFAULT_NEUTRAL_MAX_STANDARD_DEVIATION = 0.01
export const MAX_NEUTRAL_STANDARD_DEVIATION = 0.02
export const MIN_NEUTRAL_SAMPLES = 30
export const MIN_NEUTRAL_DURATION_MS = 2_000
export const MIN_AXIS_MOVEMENT = 0.25
export const MIN_ENDPOINT_SIDE_SPAN = 0.2
export const MIN_THROTTLE_ENDPOINT_SPAN = 0.4

export interface AxisStatistics {
  readonly count: number
  readonly center: number
  readonly minimum: number
  readonly maximum: number
  /** Peak-to-peak raw jitter observed while the stick was released. */
  readonly jitter: number
  readonly maxAbsoluteDeviation: number
  readonly standardDeviation: number
}

export interface CalibrationSampleSummary {
  readonly valid: boolean
  readonly sampleCount: number
  readonly axisCount: number
  readonly axes: readonly AxisStatistics[]
  readonly reason?: string
}

export interface CenterStabilityOptions {
  readonly minSamples?: number
  readonly maxJitter?: number
  readonly maxStandardDeviation?: number
}

export interface AxisMovementScore {
  readonly axis: number
  readonly peakExcursion: number
  readonly range: number
}

export interface AxisMovementResult {
  readonly status: 'identified' | 'ambiguous' | 'insufficient' | 'invalid'
  readonly axis: number | null
  readonly scores: readonly AxisMovementScore[]
  readonly reason: string
}

export interface AxisMovementOptions {
  readonly minExcursion?: number
  readonly minSeparation?: number
  readonly ambiguityRatio?: number
}

export interface EndpointCalibrationResult {
  readonly valid: boolean
  readonly minimum: number
  readonly maximum: number
  readonly center: number
  readonly reason?: string
}

export interface NeutralStabilityOptions {
  readonly threshold?: number
  readonly maxStandardDeviation?: number
  readonly minSamples?: number
  readonly minDurationMs?: number
}

const STICK_CHANNELS: readonly StickChannel[] = ['roll', 'pitch', 'yaw']

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function standardDeviation(values: readonly number[], average: number): number {
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function finiteMatrix(samples: readonly (readonly number[])[]): boolean {
  if (samples.length === 0 || samples[0].length === 0) return false
  const width = samples[0].length
  return samples.every((sample) => sample.length === width && sample.every(Number.isFinite))
}

export function calculateSampleStatistics(
  samples: readonly (readonly number[])[],
): CalibrationSampleSummary {
  if (!finiteMatrix(samples)) {
    return {
      valid: false,
      sampleCount: samples.length,
      axisCount: samples[0]?.length ?? 0,
      axes: [],
      reason: 'Center samples are empty, inconsistent, or contain a non-finite value.',
    }
  }

  const axisCount = samples[0].length
  const axes: AxisStatistics[] = []
  for (let axis = 0; axis < axisCount; axis += 1) {
    const values = samples.map((sample) => sample[axis])
    const center = mean(values)
    const minimum = Math.min(...values)
    const maximum = Math.max(...values)
    const deviations = values.map((value) => Math.abs(value - center))
    axes.push({
      count: values.length,
      center,
      minimum,
      maximum,
      jitter: maximum - minimum,
      maxAbsoluteDeviation: Math.max(...deviations),
      standardDeviation: standardDeviation(values, center),
    })
  }

  return {
    valid: true,
    sampleCount: samples.length,
    axisCount,
    axes,
  }
}

export function isCenterStable(
  statistics: AxisStatistics,
  options: CenterStabilityOptions = {},
): boolean {
  const minSamples = options.minSamples ?? MIN_CENTER_SAMPLES
  const maxJitter = options.maxJitter ?? DEFAULT_CENTER_MAX_JITTER
  const maxStandardDeviation = options.maxStandardDeviation ?? DEFAULT_CENTER_MAX_STANDARD_DEVIATION
  return (
    statistics.count >= minSamples &&
    Number.isFinite(statistics.center) &&
    statistics.jitter <= maxJitter &&
    statistics.standardDeviation <= maxStandardDeviation
  )
}

export function identifyAxisByMovement(
  baselineCenters: readonly number[],
  movementSamples: readonly (readonly number[])[],
  options: AxisMovementOptions = {},
): AxisMovementResult {
  if (
    baselineCenters.length === 0 ||
    !baselineCenters.every(Number.isFinite) ||
    !finiteMatrix(movementSamples) ||
    movementSamples[0].length !== baselineCenters.length
  ) {
    return {
      status: 'invalid',
      axis: null,
      scores: [],
      reason: 'Movement samples do not match the centered baseline or contain a non-finite value.',
    }
  }

  const scores = baselineCenters.map((baseline, axis) => {
    const values = movementSamples.map((sample) => sample[axis])
    return {
      axis,
      peakExcursion: Math.max(...values.map((value) => Math.abs(value - baseline))),
      range: Math.max(...values) - Math.min(...values),
    }
  }).sort((left, right) => right.peakExcursion - left.peakExcursion)

  const top = scores[0]
  const second = scores[1]
  const minExcursion = options.minExcursion ?? MIN_AXIS_MOVEMENT
  const minSeparation = options.minSeparation ?? 0.1
  const ambiguityRatio = options.ambiguityRatio ?? 0.8

  if (top.peakExcursion < minExcursion) {
    return {
      status: 'insufficient',
      axis: null,
      scores,
      reason: `No axis moved far enough (largest excursion ${top.peakExcursion.toFixed(3)}; need ${minExcursion.toFixed(3)}).`,
    }
  }

  if (
    second &&
    second.peakExcursion >= minExcursion &&
    (top.peakExcursion - second.peakExcursion < minSeparation ||
      second.peakExcursion / top.peakExcursion >= ambiguityRatio)
  ) {
    return {
      status: 'ambiguous',
      axis: null,
      scores,
      reason: `Multiple axes moved together (${top.axis} and ${second.axis}); move only the requested control.`,
    }
  }

  return {
    status: 'identified',
    axis: top.axis,
    scores,
    reason: `Axis ${top.axis} moved significantly and is distinct from the other axes.`,
  }
}

export function summarizeEndpointRange(
  values: readonly number[],
  mode: 'centered' | 'single-ended',
  center = 0,
): EndpointCalibrationResult {
  if (values.length === 0 || !values.every(Number.isFinite)) {
    return {
      valid: false,
      minimum: Number.NaN,
      maximum: Number.NaN,
      center,
      reason: 'Endpoint samples are empty or contain a non-finite value.',
    }
  }

  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  if (minimum >= maximum) {
    return {
      valid: false,
      minimum,
      maximum,
      center,
      reason: 'The recorded endpoint range is empty.',
    }
  }

  if (mode === 'single-ended') {
    if (maximum - minimum < MIN_THROTTLE_ENDPOINT_SPAN) {
      return {
        valid: false,
        minimum,
        maximum,
        center,
        reason: `Throttle range is too small; move from minimum to maximum (need ${MIN_THROTTLE_ENDPOINT_SPAN.toFixed(2)}).`,
      }
    }
    return { valid: true, minimum, maximum, center: minimum }
  }

  if (
    !Number.isFinite(center) ||
    center - minimum < MIN_ENDPOINT_SIDE_SPAN ||
    maximum - center < MIN_ENDPOINT_SIDE_SPAN
  ) {
    return {
      valid: false,
      minimum,
      maximum,
      center,
      reason: 'Both sides of the centered stick must reach a distinct endpoint.',
    }
  }

  return { valid: true, minimum, maximum, center }
}

function channelFinalValue(
  channels: ProcessedChannels,
  channel: ControlChannel,
): number {
  const value: ChannelPipelineValues = channels[channel]
  return value.final
}

function emptyStickRecord(): Record<StickChannel, number> {
  return { roll: 0, pitch: 0, yaw: 0 }
}

export interface NeutralReportValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

/**
 * Validates both the shape and the meaning of persisted neutral evidence.
 * Failed evidence may be retained for diagnostics, but a passing report must
 * satisfy the complete capture window and the same limits used by the gate.
 */
export function validateNeutralStabilityReport(
  report: NeutralStabilityReport,
): NeutralReportValidationResult {
  const errors: string[] = []
  if (!report || typeof report !== 'object') {
    return { valid: false, errors: ['Neutral stability report is missing.'] }
  }

  if (!Number.isFinite(report.sampleCount) || !Number.isInteger(report.sampleCount) || report.sampleCount < 0) {
    errors.push('Neutral sample count must be a finite non-negative integer.')
  }
  if (!Number.isFinite(report.durationMs) || report.durationMs < 0) {
    errors.push('Neutral capture duration must be a finite non-negative number.')
  }
  if (
    !Number.isFinite(report.threshold) ||
    report.threshold < MIN_NEUTRAL_THRESHOLD ||
    report.threshold > MAX_NEUTRAL_THRESHOLD
  ) {
    errors.push(`Neutral threshold must be between ${MIN_NEUTRAL_THRESHOLD} and ${MAX_NEUTRAL_THRESHOLD}.`)
  }

  for (const channel of STICK_CHANNELS) {
    const maxAbsolute = report.maxAbsolute?.[channel]
    const average = report.mean?.[channel]
    const deviation = report.standardDeviation?.[channel]
    if (!Number.isFinite(maxAbsolute) || maxAbsolute < 0) {
      errors.push(`${channel} maximum neutral output must be finite and non-negative.`)
    }
    if (!Number.isFinite(average)) {
      errors.push(`${channel} neutral mean must be finite.`)
    }
    if (!Number.isFinite(deviation) || deviation < 0) {
      errors.push(`${channel} neutral standard deviation must be finite and non-negative.`)
    }
    if (
      Number.isFinite(maxAbsolute) &&
      Number.isFinite(average) &&
      Math.abs(average) > maxAbsolute + Number.EPSILON
    ) {
      errors.push(`${channel} neutral mean exceeds its maximum absolute output.`)
    }
    if (
      Number.isFinite(maxAbsolute) &&
      Number.isFinite(deviation) &&
      deviation > maxAbsolute + Number.EPSILON
    ) {
      errors.push(`${channel} neutral deviation exceeds its maximum absolute output.`)
    }
  }

  if (errors.length > 0) return { valid: false, errors }

  const hasCaptureWindow =
    report.sampleCount >= MIN_NEUTRAL_SAMPLES &&
    report.durationMs >= MIN_NEUTRAL_DURATION_MS
  const metricsStable = STICK_CHANNELS.every((channel) =>
    report.maxAbsolute[channel] <= report.threshold &&
    report.standardDeviation[channel] <= DEFAULT_NEUTRAL_MAX_STANDARD_DEVIATION,
  )
  const expectedStable = hasCaptureWindow && metricsStable
  if (report.stable !== expectedStable) {
    errors.push(
      `Neutral stable status is inconsistent with its capture window and metrics (expected ${expectedStable}).`,
    )
  }

  return { valid: errors.length === 0, errors }
}

function neutralOptionFailures(
  threshold: number,
  maxStandardDeviation: number,
  minSamples: number,
  minDurationMs: number,
): string[] {
  const failures: string[] = []
  if (!Number.isFinite(threshold) || threshold < MIN_NEUTRAL_THRESHOLD || threshold > MAX_NEUTRAL_THRESHOLD) {
    failures.push(`threshold must be between ${MIN_NEUTRAL_THRESHOLD} and ${MAX_NEUTRAL_THRESHOLD}`)
  }
  if (
    !Number.isFinite(maxStandardDeviation) ||
    maxStandardDeviation < 0 ||
    maxStandardDeviation > MAX_NEUTRAL_STANDARD_DEVIATION
  ) {
    failures.push(`standard deviation limit must be between 0 and ${MAX_NEUTRAL_STANDARD_DEVIATION}`)
  }
  if (!Number.isFinite(minSamples) || !Number.isInteger(minSamples) || minSamples < MIN_NEUTRAL_SAMPLES) {
    failures.push(`sample count policy must be at least ${MIN_NEUTRAL_SAMPLES}`)
  }
  if (!Number.isFinite(minDurationMs) || minDurationMs < MIN_NEUTRAL_DURATION_MS) {
    failures.push(`duration policy must be at least ${MIN_NEUTRAL_DURATION_MS} ms`)
  }
  return failures
}

export function evaluateNeutralStability(
  samples: readonly ProcessedChannels[],
  durationMs: number,
  options: NeutralStabilityOptions = {},
): NeutralStabilityReport {
  const threshold = options.threshold ?? DEFAULT_NEUTRAL_THRESHOLD
  const maxStandardDeviation = options.maxStandardDeviation ?? DEFAULT_NEUTRAL_MAX_STANDARD_DEVIATION
  const minSamples = options.minSamples ?? MIN_NEUTRAL_SAMPLES
  const minDurationMs = options.minDurationMs ?? MIN_NEUTRAL_DURATION_MS
  const maxAbsolute = emptyStickRecord()
  const averages = emptyStickRecord()
  const standardDeviations = emptyStickRecord()
  const valuesByChannel: Record<StickChannel, number[]> = { roll: [], pitch: [], yaw: [] }
  const failures = neutralOptionFailures(threshold, maxStandardDeviation, minSamples, minDurationMs)

  for (const channels of samples) {
    for (const channel of STICK_CHANNELS) {
      const value = channelFinalValue(channels, channel)
      if (!Number.isFinite(value)) {
        failures.push(`${channel} contains a non-finite processed value`)
        continue
      }
      valuesByChannel[channel].push(value)
    }
  }

  for (const channel of STICK_CHANNELS) {
    const values = valuesByChannel[channel]
    if (values.length > 0) {
      const average = mean(values)
      averages[channel] = average
      standardDeviations[channel] = standardDeviation(values, average)
      maxAbsolute[channel] = Math.max(...values.map((value) => Math.abs(value)))
    }
  }

  if (samples.length < minSamples) failures.push(`only ${samples.length} samples; need ${minSamples}`)
  if (!Number.isFinite(durationMs)) {
    failures.push('capture duration is not finite')
  } else if (durationMs < minDurationMs) {
    failures.push(`only ${durationMs} ms; need ${minDurationMs} ms`)
  }
  for (const channel of STICK_CHANNELS) {
    if (maxAbsolute[channel] > threshold) {
      failures.push(`${channel} reached ${maxAbsolute[channel].toFixed(3)} (limit ${threshold.toFixed(3)})`)
    }
    if (standardDeviations[channel] > maxStandardDeviation) {
      failures.push(`${channel} jitter is ${standardDeviations[channel].toFixed(3)} (limit ${maxStandardDeviation.toFixed(3)})`)
    }
  }

  return {
    sampleCount: samples.length,
    durationMs,
    threshold,
    maxAbsolute,
    mean: averages,
    standardDeviation: standardDeviations,
    stable: failures.length === 0,
    reason: failures.length === 0 ? 'Neutral output stayed within the configured stability limits.' : failures.join('; '),
  }
}
