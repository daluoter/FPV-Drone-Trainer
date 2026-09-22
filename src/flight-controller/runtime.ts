import {
  DEFAULT_DRONE_CONFIG,
  type DroneConfig,
  type DroneState,
} from '../drone'
import { IDENTITY_QUATERNION, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import {
  DEFAULT_FIXED_STEP_SECONDS,
  DroneSimulation,
  FixedTimestepAccumulator,
} from '../simulation'
import type { ProcessedControllerState } from '../controller'
import { AngularRateController } from './controller'
import { isFiniteNormalizedRcInput, zeroNormalizedRcInput } from './axes'
import { DEFAULT_FLIGHT_CONTROLLER_CONFIG, resolveFlightControllerConfig } from './config'
import type {
  FlightAdvanceResult,
  FlightControllerOutput,
  FlightSimulationConfig,
  FlightStepResult,
  FlightTelemetry,
  MotorTelemetry,
  NormalizedRcInput,
} from './types'

function safeRuntimeInput(value: unknown): value is NormalizedRcInput {
  return isFiniteNormalizedRcInput(value)
}

/** Convert the controller domain's final normalized channels to flight input. */
export function processedControllerStateToNormalizedRc(
  processed: ProcessedControllerState | null | undefined,
): NormalizedRcInput | null {
  if (typeof processed !== 'object' || processed === null || !processed.valid) return null
  const channels = processed.channels
  if (typeof channels !== 'object' || channels === null) return null
  const input = {
    roll: channels.roll?.final,
    pitch: channels.pitch?.final,
    yaw: channels.yaw?.final,
    throttle: channels.throttle?.final,
  }
  return isFiniteNormalizedRcInput(input) ? input : null
}

/** Alias emphasizing that this is the post-calibration RC handoff. */
export const processedChannelsToNormalizedRc = processedControllerStateToNormalizedRc

/**
 * Fixed-step owner for the complete non-UI flight path. It samples normalized
 * RC input, calculates rates and PID torque once per simulation step, then
 * passes only bounded motor commands into the existing rigid-body runtime.
 */
export class FlightSimulation {
  public readonly config: FlightSimulationConfig
  public readonly droneConfig: DroneConfig
  public readonly controller: AngularRateController
  private readonly simulation: DroneSimulation
  private readonly accumulator: FixedTimestepAccumulator
  private readonly configurationWarnings: readonly string[]
  private state: DroneState
  private telemetry: FlightTelemetry
  private armed: boolean

  public constructor(config: FlightSimulationConfig = {}) {
    const runtimeConfig = typeof config === 'object' && config !== null ? config : {}
    const resolved = resolveFlightControllerConfig(
      runtimeConfig.controller ?? DEFAULT_FLIGHT_CONTROLLER_CONFIG,
      runtimeConfig.drone ?? DEFAULT_DRONE_CONFIG,
    )
    this.config = runtimeConfig
    this.droneConfig = resolved.drone
    this.controller = new AngularRateController(resolved.controller, resolved.drone)
    this.configurationWarnings = [...resolved.warnings, ...this.controller.configurationWarnings]
    this.simulation = new DroneSimulation(this.droneConfig)
    const fixedStep = typeof runtimeConfig.fixedStep === 'object' && runtimeConfig.fixedStep !== null
      ? runtimeConfig.fixedStep
      : {}
    this.accumulator = new FixedTimestepAccumulator(fixedStep)
    this.state = this.simulation.getState()
    this.armed = runtimeConfig.armed === true && this.configurationWarnings.length === 0
    this.telemetry = this.makeTelemetry(this.controller.safeOutput(this.configurationWarnings), this.state, [
      ...this.configurationWarnings,
      ...(this.armed ? [] : ['Flight runtime starts disarmed.']),
    ])
  }

  public getState(): DroneState {
    return this.state
  }

  public getTelemetry(): FlightTelemetry {
    return this.telemetry
  }

  public get fixedStepSeconds(): number {
    return this.accumulator.stepSeconds
  }

  public isArmed(): boolean {
    return this.armed
  }

  /** Explicit handoff for a later application arm gate. */
  public arm(): void {
    if (this.configurationWarnings.length > 0) {
      this.disarm('Flight runtime cannot arm with an invalid configuration.')
      return
    }
    this.controller.arm()
    this.armed = true
    this.telemetry = this.makeTelemetry(this.controller.safeOutput(), this.state, [])
  }

  /** Disarm immediately clears PID state and emits zero motor commands. */
  public disarm(reason = 'Flight runtime was disarmed.'): void {
    this.controller.disarm()
    this.state = this.simulation.disarm()
    this.armed = false
    const output = this.controller.safeOutput([reason])
    this.telemetry = this.makeTelemetry(output, this.state, [reason])
  }

  /** Reset simulation time, accumulator, controller memory and commands. */
  public reset(): DroneState {
    return this.resetAt(this.droneConfig.spawnPositionM, IDENTITY_QUATERNION, 'Flight runtime was reset and disarmed.')
  }

  /** Explicit disarmed reset boundary used by training setup requests. */
  public resetAt(
    positionM: Vector3 = this.droneConfig.spawnPositionM,
    orientation: Quaternion = IDENTITY_QUATERNION,
    reason = 'Flight runtime was reset and disarmed.',
  ): DroneState {
    this.controller.reset()
    this.accumulator.reset()
    this.state = this.simulation.resetAt(positionM, orientation)
    this.armed = false
    this.telemetry = this.makeTelemetry(
      this.controller.safeOutput([reason]),
      this.state,
      [reason],
    )
    return this.state
  }

  /** Advance one already-sized simulation step without using a render accumulator. */
  public step(input: NormalizedRcInput | null, deltaSeconds = DEFAULT_FIXED_STEP_SECONDS): FlightStepResult {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      const warning = 'Invalid flight timestep; stale motor commands were discarded.'
      this.disarm(warning)
      return {
        state: this.state,
        telemetry: this.telemetry,
        warnings: [warning],
        reset: false,
      }
    }

    const inputValid = safeRuntimeInput(input)
    const warning = inputValid ? null : 'Invalid normalized RC input; stale motor commands were discarded.'
    if (warning) this.disarm(warning)
    const commandInput = inputValid ? input : zeroNormalizedRcInput()
    return this.stepInternal(commandInput, deltaSeconds, warning ? [warning] : [])
  }

  /**
   * Consume a render-frame delta. The callback computes fresh PID output for
   * every fixed step, so render FPS cannot change controller or motor dynamics.
   */
  public advance(
    frameDeltaSeconds: number,
    input: NormalizedRcInput | null,
    onFixedStep?: (result: FlightStepResult) => void,
  ): FlightAdvanceResult {
    const inputValid = safeRuntimeInput(input)
    const inputWarning = inputValid ? null : 'Invalid normalized RC input; stale motor commands were discarded.'
    if (inputWarning) this.disarm(inputWarning)
    const frameWarning = !Number.isFinite(frameDeltaSeconds) || frameDeltaSeconds < 0
      ? 'Invalid render delta; stale motor commands were discarded.'
      : null
    if (frameWarning) this.disarm(frameWarning)
    const commandInput = inputValid ? input : zeroNormalizedRcInput()
    const immediateWarnings = [
      ...(inputWarning ? [inputWarning] : []),
      ...(frameWarning ? [frameWarning] : []),
    ]
    const warnings: string[] = [...this.configurationWarnings, ...immediateWarnings]
    let lastWarnings: readonly string[] = []
    const fixed = this.accumulator.advance(frameDeltaSeconds, (deltaSeconds) => {
      const result = this.stepInternal(commandInput, deltaSeconds, immediateWarnings)
      lastWarnings = result.warnings
      if (onFixedStep) {
        try {
          onFixedStep(result)
        } catch {
          // Observers cannot be allowed to break the authoritative fixed-step
          // loop. The observer is presentation/training integration only.
          lastWarnings = [...lastWarnings, 'A fixed-step observer failed; flight simulation continued.']
        }
      }
    })
    warnings.push(...lastWarnings, ...fixed.warnings)
    this.telemetry = {
      ...this.telemetry,
      warnings: warnings.length > 0 ? warnings : this.telemetry.warnings,
    }
    return {
      ...fixed,
      state: this.state,
      telemetry: this.telemetry,
      warnings,
    }
  }

  public advanceProcessed(
    frameDeltaSeconds: number,
    processed: ProcessedControllerState | null | undefined,
  ): FlightAdvanceResult {
    return this.advance(frameDeltaSeconds, processedControllerStateToNormalizedRc(processed))
  }

  private stepInternal(
    input: NormalizedRcInput,
    deltaSeconds: number,
    preWarnings: readonly string[] = [],
  ): FlightStepResult {
    let output: FlightControllerOutput
    if (!this.armed) {
      this.controller.reset()
      output = this.controller.safeOutput(preWarnings)
    } else {
      output = this.controller.calculate(input, this.state.angularVelocityBodyRadPerSec, deltaSeconds)
      if (!output.valid) {
        this.armed = false
        this.controller.reset()
        output = this.controller.safeOutput([
          ...output.warnings,
          'Invalid controller output; runtime was disarmed and motor commands were zeroed.',
        ])
      }
    }

    const simulationResult = this.simulation.step(output.motorCommands, deltaSeconds)
    this.state = simulationResult.state
    const warnings = [...output.warnings, ...simulationResult.warnings]
    if (simulationResult.reset) {
      this.armed = false
      this.controller.reset()
      warnings.push('Simulation reset; flight runtime was disarmed.')
    }
    this.telemetry = this.makeTelemetry(output, this.state, warnings)
    return {
      state: this.state,
      telemetry: this.telemetry,
      warnings,
      reset: simulationResult.reset,
    }
  }

  private makeTelemetry(
    output: FlightControllerOutput,
    state: DroneState,
    warnings: readonly string[],
  ): FlightTelemetry {
    const motors = state.motors.map((motor, index) => ({
      id: this.droneConfig.motors[index].id,
      command: motor.command,
      targetThrustN: motor.targetThrustN,
      actualThrustN: motor.actualThrustN,
    })) as [MotorTelemetry, MotorTelemetry, MotorTelemetry, MotorTelemetry]
    return {
      timeSeconds: state.timeSeconds,
      stepIndex: state.stepIndex,
      armed: this.armed,
      targetPilotRateRadPerSec: output.targetPilotRateRadPerSec,
      targetBodyRateRadPerSec: output.targetBodyRateRadPerSec,
      measuredBodyRateRadPerSec: state.angularVelocityBodyRadPerSec,
      errorBodyRateRadPerSec: output.errorBodyRateRadPerSec,
      pidIntegral: output.pidIntegral,
      pidOutputTorqueBodyNm: output.pidOutputTorqueBodyNm,
      pilotCorrections: output.pilotCorrections,
      pid: output.pid,
      mixer: output.mixer,
      mixerSaturated: output.mixer.saturated,
      motors,
      warnings: [...warnings],
    }
  }
}

/** Naming alias for callers that use "runtime" for the fixed-step owner. */
export class FlightControllerRuntime extends FlightSimulation {}
