import { DEFAULT_DRONE_CONFIG, mixQuadX } from '../drone'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import { DEFAULT_FLIGHT_CONTROLLER_CONFIG, resolveFlightControllerConfig } from './config'
import {
  bodyAngularRateToPilotAxes,
  isFiniteNormalizedRcInput,
  pilotTorqueToBodyTorque,
} from './axes'
import { RatePidAxisController, type RatePidUpdateResult } from './pid'
import { normalizedRcToTargetRates } from './target'
import type {
  FlightControllerConfig,
  FlightControllerOutput,
  NormalizedRcAxes,
  PilotPidTelemetry,
  PilotRateAxis,
  PilotRateIntegral,
  PilotTorqueNm,
  NormalizedRcInput,
  PidAxisTelemetry,
} from './types'
import type { DroneConfig } from '../drone'

const PILOT_AXES: readonly PilotRateAxis[] = ['roll', 'pitch', 'yaw']

function zeroPidTelemetry(warnings: readonly string[] = []): PidAxisTelemetry {
  return {
    errorRadPerSec: 0,
    integral: 0,
    integralTermNm: 0,
    proportionalTermNm: 0,
    derivativeTermNm: 0,
    derivativeRadPerSec2: 0,
    outputNm: 0,
    saturated: false,
    valid: false,
    warnings: [...warnings],
  }
}

function zeroPilotPidTelemetry(warnings: readonly string[] = []): PilotPidTelemetry {
  return { roll: zeroPidTelemetry(warnings), pitch: zeroPidTelemetry(warnings), yaw: zeroPidTelemetry(warnings) }
}

function zeroPilotIntegral(): PilotRateIntegral {
  return { roll: 0, pitch: 0, yaw: 0 }
}

function zeroCorrections(): NormalizedRcAxes {
  return { roll: 0, pitch: 0, yaw: 0 }
}

function validBodyRate(value: unknown): value is Vector3 {
  return typeof value === 'object' && value !== null && isFiniteVector3(value as Vector3)
}

function validDelta(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function makeSafeMixer(droneConfig: DroneConfig) {
  return mixQuadX({ throttle: 0, roll: 0, pitch: 0, yaw: 0 }, droneConfig)
}

/**
 * A modular pilot-positive angular-rate loop. It owns only PID state and emits
 * normalized mixer corrections; the simulation remains the owner of motors,
 * forces, attitude and time.
 */
export class AngularRateController {
  public readonly config: FlightControllerConfig
  public readonly droneConfig: DroneConfig
  public readonly configurationWarnings: readonly string[]
  private readonly pid: Readonly<Record<PilotRateAxis, RatePidAxisController>>
  private previousMixerSaturated = false

  public constructor(
    config: FlightControllerConfig = DEFAULT_FLIGHT_CONTROLLER_CONFIG,
    droneConfig: DroneConfig = DEFAULT_DRONE_CONFIG,
  ) {
    const resolved = resolveFlightControllerConfig(config, droneConfig)
    this.config = resolved.controller
    this.droneConfig = resolved.drone
    this.configurationWarnings = resolved.warnings
    this.pid = {
      roll: new RatePidAxisController(this.config.pid.roll),
      pitch: new RatePidAxisController(this.config.pid.pitch),
      yaw: new RatePidAxisController(this.config.pid.yaw),
    }
  }

  public reset(): void {
    for (const axis of PILOT_AXES) this.pid[axis].reset()
    this.previousMixerSaturated = false
  }

  /** Alias used by the later arm gate to clear all dynamic controller state. */
  public disarm(): void {
    this.reset()
  }

  /** Arm does not bypass any future application gate; it only clears stale PID history. */
  public arm(): void {
    this.reset()
  }

  public getIntegral(axis: PilotRateAxis): number {
    return this.pid[axis].integralState
  }

  public calculate(
    input: NormalizedRcInput,
    measuredBodyRateRadPerSec: Vector3,
    deltaSeconds: number,
  ): FlightControllerOutput {
    const safeWarnings = [...this.configurationWarnings]
    if (!isFiniteNormalizedRcInput(input)) {
      this.reset()
      safeWarnings.push('Normalized RC input was invalid; controller was reset and motor commands were zeroed.')
      return this.safeOutput(safeWarnings)
    }
    if (!validBodyRate(measuredBodyRateRadPerSec)) {
      this.reset()
      safeWarnings.push('Measured body angular rate was invalid; controller was reset and motor commands were zeroed.')
      return this.safeOutput(safeWarnings)
    }
    if (!validDelta(deltaSeconds)) {
      this.reset()
      safeWarnings.push('Controller timestep was invalid; controller was reset and motor commands were zeroed.')
      return this.safeOutput(safeWarnings)
    }

    const target = normalizedRcToTargetRates(input, this.config)
    if (!target.valid) {
      this.reset()
      safeWarnings.push(...target.warnings)
      safeWarnings.push('Target-rate calculation was invalid; motor commands were zeroed.')
      return this.safeOutput(safeWarnings)
    }

    const measuredPilot = bodyAngularRateToPilotAxes(measuredBodyRateRadPerSec)
    const pidResults = {} as Record<PilotRateAxis, RatePidUpdateResult>
    for (const axis of PILOT_AXES) {
      pidResults[axis] = this.pid[axis].update(
        target.targetPilotRateRadPerSec[axis],
        measuredPilot[axis],
        deltaSeconds,
        this.previousMixerSaturated,
      )
    }
    const invalidPid = PILOT_AXES.some((axis) => !pidResults[axis].valid || !Number.isFinite(pidResults[axis].outputNm))
    if (invalidPid) {
      this.reset()
      safeWarnings.push('Rate PID produced invalid output; controller was reset and motor commands were zeroed.')
      return this.safeOutput(safeWarnings)
    }

    const pilotTorque: PilotTorqueNm = {
      roll: pidResults.roll.outputNm,
      pitch: pidResults.pitch.outputNm,
      yaw: pidResults.yaw.outputNm,
    }
    const bodyTorque = pilotTorqueToBodyTorque(pilotTorque)
    const pilotCorrections: NormalizedRcAxes = {
      roll: pilotTorque.roll / this.config.pid.roll.outputLimitNm,
      pitch: pilotTorque.pitch / this.config.pid.pitch.outputLimitNm,
      yaw: pilotTorque.yaw / this.config.pid.yaw.outputLimitNm,
    }
    const mixer = mixQuadX({ throttle: target.throttle, ...pilotCorrections }, this.droneConfig)
    this.previousMixerSaturated = mixer.saturated
    const warnings = [...this.configurationWarnings, ...target.warnings, ...mixer.warnings]
    const pid: PilotPidTelemetry = {
      roll: pidResults.roll,
      pitch: pidResults.pitch,
      yaw: pidResults.yaw,
    }
    const pidIntegral: PilotRateIntegral = {
      roll: pidResults.roll.integral,
      pitch: pidResults.pitch.integral,
      yaw: pidResults.yaw.integral,
    }
    const errorBodyRate = {
      x: target.targetBodyRateRadPerSec.x - measuredBodyRateRadPerSec.x,
      y: target.targetBodyRateRadPerSec.y - measuredBodyRateRadPerSec.y,
      z: target.targetBodyRateRadPerSec.z - measuredBodyRateRadPerSec.z,
    }

    return {
      targetPilotRateRadPerSec: target.targetPilotRateRadPerSec,
      targetBodyRateRadPerSec: target.targetBodyRateRadPerSec,
      measuredPilotRateRadPerSec: measuredPilot,
      measuredBodyRateRadPerSec,
      errorBodyRateRadPerSec: errorBodyRate,
      pidIntegral,
      pidOutputTorqueBodyNm: bodyTorque,
      pilotCorrections,
      mixer,
      motorCommands: mixer.commands,
      pid,
      throttle: target.throttle,
      valid: true,
      warnings,
    }
  }

  public safeOutput(warnings: readonly string[] = []): FlightControllerOutput {
    const mixer = makeSafeMixer(this.droneConfig)
    return {
      targetPilotRateRadPerSec: { roll: 0, pitch: 0, yaw: 0 },
      targetBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
      measuredPilotRateRadPerSec: { roll: 0, pitch: 0, yaw: 0 },
      measuredBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
      errorBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
      pidIntegral: zeroPilotIntegral(),
      pidOutputTorqueBodyNm: { x: 0, y: 0, z: 0 },
      pilotCorrections: zeroCorrections(),
      mixer,
      motorCommands: [0, 0, 0, 0],
      pid: zeroPilotPidTelemetry(warnings),
      throttle: 0,
      valid: false,
      warnings: [...warnings],
    }
  }
}

/** Conventional alias for callers that describe this as the flight controller. */
export class FlightController extends AngularRateController {}
