import {
  createDefaultFlightControllerConfig,
  validateFlightControllerConfig,
} from '../flight-controller'
import type { FlightControllerConfig, RatePidAxisConfig } from '../flight-controller'
import {
  createDefaultDroneConfig,
  validateDroneConfig,
} from '../drone'
import type { DroneConfig } from '../drone'
import { RATE_AXES, validateActualRatesConfig } from '../rates'
import type { RateAxis } from '../rates'
import type { Vector3 } from '../math/vector'

export const TUNING_SCHEMA_VERSION = 1 as const
export const TUNING_STORAGE_KEY = 'fpv-drone-trainer.tuning.v1'

/** Camera mount choices are intentionally discrete to keep the camera contract bounded. */
export const CAMERA_MOUNT_ANGLE_OPTIONS = [0, 10, 20, 30, 40, 50] as const
export type CameraMountAngleDegrees = (typeof CAMERA_MOUNT_ANGLE_OPTIONS)[number]

export const MIN_CAMERA_FOV_DEGREES = 45
export const MAX_CAMERA_FOV_DEGREES = 120

/** Bounds for the deliberately simplified trainer configuration UI. */
export const TUNING_LIMITS = {
  massKg: { min: 0.1, max: 5 },
  maxMotorThrustN: { min: 0.1, max: 20 },
  motorResponseTimeConstantSeconds: { min: 0.005, max: 1 },
  linearDragCoefficientNPerMps: { min: 0, max: 5 },
  angularDragCoefficientNmPerRadPerSec: { min: 0, max: 0.1 },
  pidKp: { min: 0, max: 5 },
  pidKi: { min: 0, max: 5 },
  pidKd: { min: 0, max: 1 },
} as const

export interface CameraTuningConfig {
  readonly fpvMountAngleDegrees: CameraMountAngleDegrees
  readonly fpvFovDegrees: number
}

export interface TuningSettings {
  readonly schemaVersion: typeof TUNING_SCHEMA_VERSION
  readonly controller: FlightControllerConfig
  readonly drone: DroneConfig
  readonly camera: CameraTuningConfig
}

export interface TuningValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

export interface TuningLoadResult {
  readonly settings: TuningSettings
  readonly loaded: boolean
  readonly errors: readonly string[]
}

export interface TuningPersistenceResult {
  readonly saved: boolean
  readonly errors: readonly string[]
}

export interface TuningStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateBoundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  errors: string[],
): void {
  if (!isFiniteNumber(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be finite and in [${minimum}, ${maximum}].`)
  }
}

function validateTunedDroneConfig(config: unknown): TuningValidationResult {
  const errors: string[] = []
  const validation = validateDroneConfig(config)
  if (!validation.valid) errors.push(...validation.errors)
  if (!isRecord(config)) return { valid: false, errors }

  validateBoundedNumber(
    config.massKg,
    'Mass',
    TUNING_LIMITS.massKg.min,
    TUNING_LIMITS.massKg.max,
    errors,
  )
  if (Array.isArray(config.motors)) {
    for (const [index, motor] of config.motors.entries()) {
      if (!isRecord(motor)) continue
      validateBoundedNumber(
        motor.maxThrustN,
        `Motor ${index} maximum thrust`,
        TUNING_LIMITS.maxMotorThrustN.min,
        TUNING_LIMITS.maxMotorThrustN.max,
        errors,
      )
      validateBoundedNumber(
        motor.responseTimeConstantSeconds,
        `Motor ${index} response time constant`,
        TUNING_LIMITS.motorResponseTimeConstantSeconds.min,
        TUNING_LIMITS.motorResponseTimeConstantSeconds.max,
        errors,
      )
    }
  }

  const linearDrag = config.linearDragCoefficientNPerMps
  if (isRecord(linearDrag)) {
    for (const axis of ['x', 'y', 'z'] as const) {
      validateBoundedNumber(
        linearDrag[axis],
        `Linear drag ${axis}`,
        TUNING_LIMITS.linearDragCoefficientNPerMps.min,
        TUNING_LIMITS.linearDragCoefficientNPerMps.max,
        errors,
      )
    }
  }
  const angularDrag = config.angularDragCoefficientNmPerRadPerSec
  if (isRecord(angularDrag)) {
    for (const axis of ['x', 'y', 'z'] as const) {
      validateBoundedNumber(
        angularDrag[axis],
        `Angular drag ${axis}`,
        TUNING_LIMITS.angularDragCoefficientNmPerRadPerSec.min,
        TUNING_LIMITS.angularDragCoefficientNmPerRadPerSec.max,
        errors,
      )
    }
  }

  return { valid: errors.length === 0, errors }
}

function validateTunedPid(config: unknown): TuningValidationResult {
  const errors: string[] = []
  if (!isRecord(config)) return { valid: false, errors: ['PID configuration is missing.'] }
  for (const axis of RATE_AXES) {
    const pid = config[axis]
    if (!isRecord(pid)) {
      errors.push(`PID ${axis} configuration is missing.`)
      continue
    }
    validateBoundedNumber(pid.kp, `PID ${axis} kp`, TUNING_LIMITS.pidKp.min, TUNING_LIMITS.pidKp.max, errors)
    validateBoundedNumber(pid.ki, `PID ${axis} ki`, TUNING_LIMITS.pidKi.min, TUNING_LIMITS.pidKi.max, errors)
    validateBoundedNumber(pid.kd, `PID ${axis} kd`, TUNING_LIMITS.pidKd.min, TUNING_LIMITS.pidKd.max, errors)
  }
  return { valid: errors.length === 0, errors }
}

export function validateCameraTuningConfig(config: unknown): TuningValidationResult {
  const errors: string[] = []
  if (!isRecord(config)) return { valid: false, errors: ['Camera tuning configuration is missing.'] }
  if (!CAMERA_MOUNT_ANGLE_OPTIONS.includes(config.fpvMountAngleDegrees as CameraMountAngleDegrees)) {
    errors.push(`FPV mount angle must be one of ${CAMERA_MOUNT_ANGLE_OPTIONS.join(', ')} degrees.`)
  }
  validateBoundedNumber(
    config.fpvFovDegrees,
    'FPV field of view',
    MIN_CAMERA_FOV_DEGREES,
    MAX_CAMERA_FOV_DEGREES,
    errors,
  )
  return { valid: errors.length === 0, errors }
}

/** Validate the complete persisted tuning shape before it reaches a runtime. */
export function validateTuningSettings(settings: unknown): TuningValidationResult {
  const errors: string[] = []
  if (!isRecord(settings)) return { valid: false, errors: ['Tuning settings are missing.'] }
  if (settings.schemaVersion !== TUNING_SCHEMA_VERSION) {
    errors.push(`Tuning settings schema version ${String(settings.schemaVersion)} is unsupported.`)
  }

  const controllerValidation = validateFlightControllerConfig(settings.controller)
  if (!controllerValidation.valid) {
    errors.push(...controllerValidation.errors.map((error) => `controller: ${error}`))
  }
  const pidValidation = isRecord(settings.controller)
    ? validateTunedPid(settings.controller.pid)
    : { valid: false, errors: ['PID configuration is missing.'] }
  if (!pidValidation.valid) errors.push(...pidValidation.errors.map((error) => `controller: ${error}`))

  const droneValidation = validateTunedDroneConfig(settings.drone)
  if (!droneValidation.valid) errors.push(...droneValidation.errors.map((error) => `drone: ${error}`))

  const cameraValidation = validateCameraTuningConfig(settings.camera)
  if (!cameraValidation.valid) errors.push(...cameraValidation.errors.map((error) => `camera: ${error}`))

  return { valid: errors.length === 0, errors }
}

function copyVector(vector: Vector3): Vector3 {
  return { x: vector.x, y: vector.y, z: vector.z }
}

function copyPid(pid: RatePidAxisConfig): RatePidAxisConfig {
  return { ...pid }
}

function copyControllerConfig(config: FlightControllerConfig): FlightControllerConfig {
  return {
    rates: {
      axes: {
        roll: { ...config.rates.axes.roll },
        pitch: { ...config.rates.axes.pitch },
        yaw: { ...config.rates.axes.yaw },
      },
    },
    rateLimitsDegPerSec: { ...config.rateLimitsDegPerSec },
    pid: {
      roll: copyPid(config.pid.roll),
      pitch: copyPid(config.pid.pitch),
      yaw: copyPid(config.pid.yaw),
    },
  }
}

function copyDroneConfig(config: DroneConfig): DroneConfig {
  return {
    ...config,
    spawnPositionM: copyVector(config.spawnPositionM),
    inertiaKgM2: copyVector(config.inertiaKgM2),
    motors: config.motors.map((motor) => ({ ...motor, positionM: copyVector(motor.positionM) })) as unknown as DroneConfig['motors'],
    linearDragCoefficientNPerMps: copyVector(config.linearDragCoefficientNPerMps),
    angularDragCoefficientNmPerRadPerSec: copyVector(config.angularDragCoefficientNmPerRadPerSec),
    ground: { ...config.ground },
    safety: { ...config.safety },
    mixer: { ...config.mixer },
  }
}

/** Copy settings at UI/persistence boundaries so edits cannot mutate runtime config. */
export function copyTuningSettings(settings: TuningSettings): TuningSettings {
  return {
    schemaVersion: TUNING_SCHEMA_VERSION,
    controller: copyControllerConfig(settings.controller),
    drone: copyDroneConfig(settings.drone),
    camera: { ...settings.camera },
  }
}

export function createDefaultTuningSettings(): TuningSettings {
  return {
    schemaVersion: TUNING_SCHEMA_VERSION,
    controller: createDefaultFlightControllerConfig(),
    drone: createDefaultDroneConfig(),
    camera: {
      fpvMountAngleDegrees: 20,
      fpvFovDegrees: 90,
    },
  }
}

export const DEFAULT_TUNING_SETTINGS = createDefaultTuningSettings()

export function updateRateAxis(
  settings: TuningSettings,
  axis: RateAxis,
  patch: Partial<TuningSettings['controller']['rates']['axes'][RateAxis]>,
): TuningSettings {
  const next = copyTuningSettings(settings)
  return {
    ...next,
    controller: {
      ...next.controller,
      rates: {
        ...next.controller.rates,
        axes: {
          ...next.controller.rates.axes,
          [axis]: { ...next.controller.rates.axes[axis], ...patch },
        },
      },
    },
  }
}

export function updatePidAxis(
  settings: TuningSettings,
  axis: RateAxis,
  patch: Partial<RatePidAxisConfig>,
): TuningSettings {
  const next = copyTuningSettings(settings)
  return {
    ...next,
    controller: {
      ...next.controller,
      pid: {
        ...next.controller.pid,
        [axis]: { ...next.controller.pid[axis], ...patch },
      },
    },
  }
}

export function updateDroneTuning(
  settings: TuningSettings,
  patch: {
    massKg?: number
    maxMotorThrustN?: number
    motorResponseTimeConstantSeconds?: number
    linearDragCoefficientNPerMps?: Partial<Vector3>
    angularDragCoefficientNmPerRadPerSec?: Partial<Vector3>
  },
): TuningSettings {
  const next = copyTuningSettings(settings)
  const motors = next.drone.motors.map((motor) => ({
    ...motor,
    ...(patch.maxMotorThrustN === undefined ? {} : { maxThrustN: patch.maxMotorThrustN }),
    ...(patch.motorResponseTimeConstantSeconds === undefined
      ? {}
      : { responseTimeConstantSeconds: patch.motorResponseTimeConstantSeconds }),
  })) as unknown as DroneConfig['motors']
  return {
    ...next,
    drone: {
      ...next.drone,
      ...(patch.massKg === undefined ? {} : { massKg: patch.massKg }),
      motors,
      linearDragCoefficientNPerMps: patch.linearDragCoefficientNPerMps
        ? { ...next.drone.linearDragCoefficientNPerMps, ...patch.linearDragCoefficientNPerMps }
        : next.drone.linearDragCoefficientNPerMps,
      angularDragCoefficientNmPerRadPerSec: patch.angularDragCoefficientNmPerRadPerSec
        ? { ...next.drone.angularDragCoefficientNmPerRadPerSec, ...patch.angularDragCoefficientNmPerRadPerSec }
        : next.drone.angularDragCoefficientNmPerRadPerSec,
    },
  }
}

export function updateCameraTuning(
  settings: TuningSettings,
  patch: Partial<CameraTuningConfig>,
): TuningSettings {
  const next = copyTuningSettings(settings)
  return { ...next, camera: { ...next.camera, ...patch } }
}

function defaultStorage(): TuningStorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export class TuningSettingsStore {
  private readonly storage: TuningStorageLike | null

  public constructor(storage: TuningStorageLike | null = defaultStorage()) {
    this.storage = storage
  }

  public save(settings: TuningSettings): TuningPersistenceResult {
    const validation = validateTuningSettings(settings)
    if (!validation.valid || !this.storage) {
      return {
        saved: false,
        errors: validation.valid ? ['Browser storage is unavailable.'] : validation.errors,
      }
    }
    try {
      this.storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(settings))
      return { saved: true, errors: [] }
    } catch {
      return { saved: false, errors: ['Browser storage rejected the tuning settings.'] }
    }
  }

  public load(): TuningLoadResult {
    const defaults = createDefaultTuningSettings()
    if (!this.storage) return { settings: defaults, loaded: false, errors: ['Browser storage is unavailable.'] }

    let encoded: string | null
    try {
      encoded = this.storage.getItem(TUNING_STORAGE_KEY)
    } catch {
      return { settings: defaults, loaded: false, errors: ['Browser storage could not be read.'] }
    }
    if (!encoded) return { settings: defaults, loaded: false, errors: [] }

    try {
      const parsed: unknown = JSON.parse(encoded)
      const validation = validateTuningSettings(parsed)
      if (!validation.valid) {
        return {
          settings: defaults,
          loaded: false,
          errors: ['Saved tuning settings were rejected.', ...validation.errors],
        }
      }
      return { settings: copyTuningSettings(parsed as TuningSettings), loaded: true, errors: [] }
    } catch {
      return { settings: defaults, loaded: false, errors: ['Saved tuning settings were corrupt and were rejected.'] }
    }
  }

  public reset(): TuningPersistenceResult {
    if (!this.storage) return { saved: false, errors: ['Browser storage is unavailable.'] }
    try {
      this.storage.removeItem(TUNING_STORAGE_KEY)
      return { saved: true, errors: [] }
    } catch {
      return { saved: false, errors: ['Browser storage rejected the tuning reset.'] }
    }
  }
}

export function flightSimulationConfigFromTuning(settings: TuningSettings): {
  readonly controller: FlightControllerConfig
  readonly drone: DroneConfig
} {
  return {
    controller: copyControllerConfig(settings.controller),
    drone: copyDroneConfig(settings.drone),
  }
}

export function actualRateCurve(
  settings: TuningSettings,
  axis: RateAxis,
  samples = 51,
): readonly { x: number; y: number }[] {
  const count = Number.isInteger(samples) && samples >= 2 ? samples : 2
  const config = settings.controller.rates.axes[axis]
  const values: { x: number; y: number }[] = []
  for (let index = 0; index < count; index += 1) {
    const x = -1 + (2 * index) / (count - 1)
    const validation = validateActualRatesConfig(config)
    if (!validation.valid) return []
    const movement = Math.max(0, config.maxRateDegPerSec - config.centerRateDegPerSec)
    const absolute = Math.abs(x)
    const nonlinear = absolute * (config.expo * x ** 5 + (1 - config.expo) * x)
    values.push({ x, y: config.centerRateDegPerSec * x + movement * nonlinear })
  }
  return values
}
