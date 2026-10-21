import { RATE_AXES } from '../rates'
import {
  copyTuningSettings,
  createDefaultTuningSettings,
  validateTuningSettings,
  type TuningSettings,
} from './config'

export type TuningPresetId = 'beginner' | 'standard'
export type TuningPresetSelection = TuningPresetId | 'custom'

export const TUNING_PRESETS: readonly {
  readonly id: TuningPresetId
  readonly label: string
  readonly description: string
}[] = [
  {
    id: 'beginner',
    label: '新手靈敏度',
    description: '較低轉動速度、10° 鏡頭；維持 Acro 與原有物理。原型設定待真人試飛調整。',
  },
  {
    id: 'standard',
    label: '一般靈敏度',
    description: '恢復預設轉動速度與 20° 鏡頭；保留目前機體、PID 與獨立角速度限制。',
  },
]

/** Presets change only rates and camera, never the caller's airframe or PID. */
export function createTuningPreset(
  id: TuningPresetId,
  baseSettings: TuningSettings = createDefaultTuningSettings(),
): TuningSettings {
  const validation = validateTuningSettings(baseSettings)
  if (!validation.valid) throw new RangeError('無法套用預設：目前設定未通過驗證。')

  const next = copyTuningSettings(baseSettings)
  const defaults = createDefaultTuningSettings()
  const rates = id === 'beginner'
    ? {
        axes: {
          roll: { centerRateDegPerSec: 45, maxRateDegPerSec: 300, expo: 0.35 },
          pitch: { centerRateDegPerSec: 45, maxRateDegPerSec: 300, expo: 0.35 },
          yaw: { centerRateDegPerSec: 45, maxRateDegPerSec: 250, expo: 0.35 },
        },
      }
    : defaults.controller.rates
  const settings: TuningSettings = {
    ...next,
    controller: { ...next.controller, rates },
    camera: id === 'beginner'
      ? { fpvMountAngleDegrees: 10, fpvFovDegrees: 90 }
      : { ...defaults.camera },
  }
  // Keep the same validation boundary as custom UI/persistence settings.
  if (!validateTuningSettings(settings).valid) throw new RangeError('預設設定未通過驗證。')
  return settings
}

/** The label describes the rates/camera preset, not an unchanged airframe. */
export function identifyTuningPreset(settings: TuningSettings): TuningPresetSelection {
  if (!validateTuningSettings(settings).valid) return 'custom'
  for (const preset of TUNING_PRESETS) {
    const expected = createTuningPreset(preset.id)
    const ratesMatch = RATE_AXES.every((axis) => {
      const actual = settings.controller.rates.axes[axis]
      const reference = expected.controller.rates.axes[axis]
      return actual.centerRateDegPerSec === reference.centerRateDegPerSec
        && actual.maxRateDegPerSec === reference.maxRateDegPerSec
        && actual.expo === reference.expo
    })
    if (ratesMatch
      && settings.camera.fpvMountAngleDegrees === expected.camera.fpvMountAngleDegrees
      && settings.camera.fpvFovDegrees === expected.camera.fpvFovDegrees) return preset.id
  }
  return 'custom'
}
