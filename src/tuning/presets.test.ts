import { describe, expect, it } from 'vitest'

import { applyActualRates } from '../rates'
import { createDefaultTuningSettings, updateDroneTuning, validateTuningSettings } from './config'
import { createTuningPreset, identifyTuningPreset } from './presets'

describe('rates and camera presets', () => {
  it('lowers both small-stick and full-stick rates without changing physics or PID', () => {
    const custom = updateDroneTuning(createDefaultTuningSettings(), { massKg: 0.8, maxMotorThrustN: 6 })
    const before = JSON.stringify(custom)
    const beginner = createTuningPreset('beginner', custom)

    expect(validateTuningSettings(beginner).valid).toBe(true)
    expect(beginner.drone).toEqual(custom.drone)
    expect(beginner.drone).not.toBe(custom.drone)
    expect(beginner.controller.pid).toEqual(custom.controller.pid)
    expect(beginner.controller.pid.roll).not.toBe(custom.controller.pid.roll)
    expect(beginner.controller.rateLimitsDegPerSec).toEqual(custom.controller.rateLimitsDegPerSec)
    for (const axis of ['roll', 'pitch', 'yaw'] as const) {
      expect(applyActualRates(0.2, beginner.controller.rates.axes[axis]))
        .toBeLessThan(applyActualRates(0.2, custom.controller.rates.axes[axis]))
      expect(applyActualRates(1, beginner.controller.rates.axes[axis]))
        .toBeLessThan(applyActualRates(1, custom.controller.rates.axes[axis]))
    }
    expect(beginner.camera.fpvMountAngleDegrees).toBe(10)
    expect(JSON.stringify(custom)).toBe(before)
  })

  it('restores standard rates/camera while retaining the supplied airframe and independent limit', () => {
    const custom = createDefaultTuningSettings()
    const source = {
      ...custom,
      controller: { ...custom.controller, rateLimitsDegPerSec: { roll: 150, pitch: null, yaw: 100 } },
    }
    const standard = createTuningPreset('standard', createTuningPreset('beginner', source))
    expect(standard.controller.rates).toEqual(custom.controller.rates)
    expect(standard.camera).toEqual(custom.camera)
    expect(standard.drone).toEqual(source.drone)
    expect(standard.controller.rateLimitsDegPerSec).toEqual(source.controller.rateLimitsDegPerSec)
  })

  it('identifies changed camera/rates as custom without conflating physics with sensitivity', () => {
    const beginner = createTuningPreset('beginner')
    expect(identifyTuningPreset(beginner)).toBe('beginner')
    expect(identifyTuningPreset(createDefaultTuningSettings())).toBe('standard')
    expect(identifyTuningPreset(updateDroneTuning(beginner, { massKg: 0.9 }))).toBe('beginner')
    expect(identifyTuningPreset({ ...beginner, camera: { ...beginner.camera, fpvFovDegrees: 91 } })).toBe('custom')
  })

  it('rejects invalid source settings rather than silently discarding custom configuration', () => {
    const original = createDefaultTuningSettings()
    const invalid = { ...original, drone: { ...original.drone, massKg: -1 } }
    expect(() => createTuningPreset('beginner', invalid)).toThrow(/未通過驗證/)
    expect(identifyTuningPreset(invalid)).toBe('custom')
  })
})
