import { describe, expect, it } from 'vitest'

import {
  actualRateCurve,
  CAMERA_MOUNT_ANGLE_OPTIONS,
  createDefaultTuningSettings,
  TUNING_LIMITS,
  TUNING_SCHEMA_VERSION,
  TUNING_STORAGE_KEY,
  TuningSettingsStore,
  updateDroneTuning,
  validateTuningSettings,
  type TuningStorageLike,
} from './config'

class MemoryStorage implements TuningStorageLike {
  private readonly values = new Map<string, string>()

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  public removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('bounded Phase 5 tuning configuration', () => {
  it('validates defaults and exposes a symmetric Actual Rates curve', () => {
    const settings = createDefaultTuningSettings()
    expect(validateTuningSettings(settings).valid).toBe(true)
    expect(settings.camera.fpvMountAngleDegrees).toBe(20)
    expect(CAMERA_MOUNT_ANGLE_OPTIONS).toEqual([0, 10, 20, 30, 40, 50])

    const curve = actualRateCurve(settings, 'roll', 5)
    expect(curve).toHaveLength(5)
    expect(curve[0]?.x).toBe(-1)
    expect(curve[0]?.y).toBeCloseTo(-670)
    expect(curve[2]?.y).toBeCloseTo(0)
    expect(curve[4]?.y).toBeCloseTo(670)
  })

  it('rejects out-of-range tuning values even when the base config is structurally valid', () => {
    const settings = createDefaultTuningSettings()
    const invalidMass = {
      ...settings,
      drone: { ...settings.drone, massKg: TUNING_LIMITS.massKg.max + 0.01 },
    }
    const invalidFov = {
      ...settings,
      camera: { ...settings.camera, fpvFovDegrees: 121 },
    }
    const invalidAngle = {
      ...settings,
      camera: { ...settings.camera, fpvMountAngleDegrees: 15 as unknown as 20 },
    }
    const invalidPid = {
      ...settings,
      controller: {
        ...settings.controller,
        pid: { ...settings.controller.pid, roll: { ...settings.controller.pid.roll, kp: 5.01 } },
      },
    }

    expect(validateTuningSettings(invalidMass).valid).toBe(false)
    expect(validateTuningSettings(invalidFov).valid).toBe(false)
    expect(validateTuningSettings(invalidAngle).valid).toBe(false)
    expect(validateTuningSettings(invalidPid).valid).toBe(false)
  })

  it('round-trips compatible settings and rejects corrupt or incompatible storage', () => {
    const storage = new MemoryStorage()
    const store = new TuningSettingsStore(storage)
    const settings = updateDroneTuning(createDefaultTuningSettings(), { massKg: 0.8, maxMotorThrustN: 6 })

    expect(store.save(settings)).toEqual({ saved: true, errors: [] })
    const loaded = store.load()
    expect(loaded.loaded).toBe(true)
    expect(loaded.settings.drone.massKg).toBe(0.8)
    expect(loaded.settings.drone.motors.every((motor) => motor.maxThrustN === 6)).toBe(true)

    storage.setItem(TUNING_STORAGE_KEY, '{not-json')
    expect(store.load().loaded).toBe(false)
    expect(store.load().settings.schemaVersion).toBe(TUNING_SCHEMA_VERSION)

    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify({ ...settings, schemaVersion: 999 }))
    const incompatible = store.load()
    expect(incompatible.loaded).toBe(false)
    expect(incompatible.errors.join(' ')).toMatch(/unsupported/i)

    expect(store.reset().saved).toBe(true)
    expect(store.load().loaded).toBe(false)
  })

  it('does not persist a structurally invalid setting', () => {
    const storage = new MemoryStorage()
    const store = new TuningSettingsStore(storage)
    const settings = createDefaultTuningSettings()
    const invalid = {
      ...settings,
      drone: {
        ...settings.drone,
        motors: settings.drone.motors.map((motor) => ({ ...motor, responseTimeConstantSeconds: 0 })) as unknown as typeof settings.drone.motors,
      },
    }

    expect(store.save(invalid).saved).toBe(false)
    expect(storage.getItem(TUNING_STORAGE_KEY)).toBeNull()
  })
})
