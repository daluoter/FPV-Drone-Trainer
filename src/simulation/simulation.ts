import { DEFAULT_DRONE_CONFIG, validateDroneConfig } from '../drone'
import type { DroneConfig, DroneState, DroneStepResult } from '../drone'
import { createSafeInitialState, stepDroneState } from './dynamics'
import {
  DEFAULT_FIXED_STEP_SECONDS,
  FixedTimestepAccumulator,
  type FixedStepAdvanceResult,
  type FixedStepConfig,
} from './fixed-step'

export interface SimulationAdvanceResult extends FixedStepAdvanceResult {
  readonly state: DroneState
  readonly warnings: readonly string[]
}

/** Pure simulation owner with no React or renderer dependency. */
export class DroneSimulation {
  public readonly config: DroneConfig
  private readonly accumulator: FixedTimestepAccumulator
  private readonly configWarnings: readonly string[]
  private state: DroneState

  public constructor(
    config: DroneConfig = DEFAULT_DRONE_CONFIG,
    fixedStepConfig: FixedStepConfig = {},
  ) {
    const validation = validateDroneConfig(config)
    this.config = validation.valid ? config : DEFAULT_DRONE_CONFIG
    this.configWarnings = validation.valid
      ? []
      : [`Invalid drone configuration; defaults were used: ${validation.errors.join(' ')}`]
    this.accumulator = new FixedTimestepAccumulator(fixedStepConfig)
    this.state = createSafeInitialState(this.config)
    if (this.configWarnings.length > 0) {
      this.state = { ...this.state, warnings: this.configWarnings }
    }
  }

  public getState(): DroneState {
    return this.state
  }

  public get fixedStepSeconds(): number {
    return this.accumulator.stepSeconds
  }

  public reset(): DroneState {
    this.accumulator.reset()
    this.state = createSafeInitialState(this.config)
    return this.state
  }

  public step(motorCommands: readonly number[], deltaSeconds = DEFAULT_FIXED_STEP_SECONDS): DroneStepResult {
    const result = stepDroneState(this.state, motorCommands, this.config, deltaSeconds)
    this.state = result.state
    return result
  }

  /**
   * Consume a render-frame delta while stepping the authoritative state at a
   * fixed frequency. The latest motor command is held for each fixed step.
   */
  public advance(frameDeltaSeconds: number, motorCommands: readonly number[]): SimulationAdvanceResult {
    const warnings: string[] = [...this.configWarnings]
    let lastStepWarnings: readonly string[] = []
    const fixed = this.accumulator.advance(frameDeltaSeconds, (deltaSeconds) => {
      const result = this.step(motorCommands, deltaSeconds)
      lastStepWarnings = result.warnings
      if (result.warnings.length > 0) warnings.push(...result.warnings)
    })
    warnings.push(...fixed.warnings)
    if (lastStepWarnings.length > 0) this.state = { ...this.state, warnings: lastStepWarnings }
    else if (fixed.warnings.length > 0) this.state = { ...this.state, warnings: fixed.warnings }
    else this.state = { ...this.state, warnings: [] }
    return { ...fixed, state: this.state, warnings }
  }
}
