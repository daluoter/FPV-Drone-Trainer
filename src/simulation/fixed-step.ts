export const DEFAULT_SIMULATION_HZ = 240
export const DEFAULT_FIXED_STEP_SECONDS = 1 / DEFAULT_SIMULATION_HZ
export const DEFAULT_MAX_CATCH_UP_STEPS = 8
export const DEFAULT_MAX_FRAME_DELTA_SECONDS = 0.25

export interface FixedStepConfig {
  readonly stepSeconds?: number
  readonly maxCatchUpSteps?: number
  readonly maxFrameDeltaSeconds?: number
}

export interface FixedStepAdvanceResult {
  readonly steps: number
  readonly simulatedSeconds: number
  readonly droppedSteps: number
  readonly droppedSeconds: number
  readonly accumulatorSeconds: number
  readonly interpolationAlpha: number
  readonly warnings: readonly string[]
}

interface NormalizedFixedStepConfig {
  readonly values: Required<FixedStepConfig>
  readonly warnings: readonly string[]
}

function safeConfig(config: FixedStepConfig): NormalizedFixedStepConfig {
  const warnings: string[] = []
  const stepSeconds = config.stepSeconds ?? DEFAULT_FIXED_STEP_SECONDS
  const maxCatchUpSteps = config.maxCatchUpSteps ?? DEFAULT_MAX_CATCH_UP_STEPS
  const maxFrameDeltaSeconds = config.maxFrameDeltaSeconds ?? DEFAULT_MAX_FRAME_DELTA_SECONDS
  const validStep = Number.isFinite(stepSeconds) && stepSeconds > 0
  const validCatchUp = Number.isInteger(maxCatchUpSteps) && maxCatchUpSteps > 0
  const validFrameDelta = Number.isFinite(maxFrameDeltaSeconds) && maxFrameDeltaSeconds > 0
  if (!validStep) warnings.push('Invalid fixed timestep configuration; default timestep was used.')
  if (!validCatchUp) warnings.push('Invalid fixed catch-up configuration; default catch-up bound was used.')
  if (!validFrameDelta) warnings.push('Invalid frame-delta configuration; default frame bound was used.')
  return {
    values: {
      stepSeconds: validStep ? stepSeconds : DEFAULT_FIXED_STEP_SECONDS,
      maxCatchUpSteps: validCatchUp ? maxCatchUpSteps : DEFAULT_MAX_CATCH_UP_STEPS,
      maxFrameDeltaSeconds: validFrameDelta ? maxFrameDeltaSeconds : DEFAULT_MAX_FRAME_DELTA_SECONDS,
    },
    warnings,
  }
}

/**
 * Render-loop independent fixed timestep accumulator. Excess work is bounded;
 * dropped steps are counted and surfaced rather than silently running a spiral
 * of catch-up work.
 */
export class FixedTimestepAccumulator {
  private readonly configuration: Required<FixedStepConfig>
  private readonly configurationWarnings: readonly string[]
  private accumulatorSeconds = 0

  public constructor(config: FixedStepConfig = {}) {
    const normalized = safeConfig(config)
    this.configuration = normalized.values
    this.configurationWarnings = normalized.warnings
  }

  public get stepSeconds(): number {
    return this.configuration.stepSeconds
  }

  public get accumulatorSecondsRemaining(): number {
    return this.accumulatorSeconds
  }

  public reset(): void {
    this.accumulatorSeconds = 0
  }

  public advance(frameDeltaSeconds: number, step: (deltaSeconds: number) => void): FixedStepAdvanceResult {
    const warnings: string[] = [...this.configurationWarnings]
    if (!Number.isFinite(frameDeltaSeconds) || frameDeltaSeconds < 0) {
      this.accumulatorSeconds = 0
      return {
        steps: 0,
        simulatedSeconds: 0,
        droppedSteps: 0,
        droppedSeconds: 0,
        accumulatorSeconds: 0,
        interpolationAlpha: 0,
        warnings: [...warnings, 'Invalid render delta; fixed-step accumulator was reset.'],
      }
    }

    let usableFrameDelta = frameDeltaSeconds
    let droppedSeconds = 0
    if (usableFrameDelta > this.configuration.maxFrameDeltaSeconds) {
      droppedSeconds += usableFrameDelta - this.configuration.maxFrameDeltaSeconds
      usableFrameDelta = this.configuration.maxFrameDeltaSeconds
      warnings.push('Render delta exceeded the catch-up bound and was clamped.')
    }
    this.accumulatorSeconds += usableFrameDelta
    const epsilon = this.configuration.stepSeconds * 1e-9
    const availableSteps = Math.floor((this.accumulatorSeconds + epsilon) / this.configuration.stepSeconds)
    const steps = Math.min(availableSteps, this.configuration.maxCatchUpSteps)
    let completedSteps = 0
    let droppedSteps = 0
    let callbackFailed = false

    for (let index = 0; index < steps; index += 1) {
      try {
        step(this.configuration.stepSeconds)
        completedSteps += 1
        this.accumulatorSeconds -= this.configuration.stepSeconds
      } catch {
        warnings.push('A fixed-step callback failed; remaining catch-up work was dropped.')
        const remaining = availableSteps - completedSteps
        droppedSteps = remaining
        droppedSeconds += remaining * this.configuration.stepSeconds
        this.accumulatorSeconds %= this.configuration.stepSeconds
        callbackFailed = true
        break
      }
    }

    if (!callbackFailed && availableSteps > steps) {
      droppedSteps = availableSteps - steps
      droppedSeconds += droppedSteps * this.configuration.stepSeconds
      // Keep only the sub-step remainder after dropping old simulation time.
      this.accumulatorSeconds %= this.configuration.stepSeconds
      warnings.push(`Dropped ${droppedSteps} fixed simulation step(s) to stay within the catch-up bound.`)
    }

    if (this.accumulatorSeconds < 0 && this.accumulatorSeconds > -epsilon) this.accumulatorSeconds = 0
    return {
      steps: completedSteps,
      simulatedSeconds: completedSteps * this.configuration.stepSeconds,
      droppedSteps,
      droppedSeconds,
      accumulatorSeconds: this.accumulatorSeconds,
      interpolationAlpha: this.accumulatorSeconds / this.configuration.stepSeconds,
      warnings,
    }
  }
}
