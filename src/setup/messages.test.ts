import { describe, expect, it } from 'vitest'
import { evaluateNeutralStability } from '../controller/calibration'
import type { ChannelPipelineValues, ProcessedChannels } from '../controller/types'
import { createDefaultTuningSettings, updateDroneTuning, updatePidAxis, updateRateAxis, validateTuningSettings } from '../tuning/config'
import { localizedSetupMessage } from './messages'

function sample(roll: number): ProcessedChannels {
  const pipeline = (value: number): ChannelPipelineValues => ({ raw: value, calibrated: value, normalized: value, deadband: value, filtered: value, final: value, valid: true })
  return { roll: pipeline(roll), pitch: pipeline(0), yaw: pipeline(0), throttle: pipeline(0) }
}

describe('setup diagnostic presentation', () => {
  it('reads a saved English neutral report without changing evidence or losing numeric causes', () => {
    const raw = JSON.stringify(evaluateNeutralStability(Array.from({ length: 10 }, (_, index) => sample(index % 2 ? 0.05 : -0.05)), 1000))
    const saved = JSON.parse(raw) as ReturnType<typeof evaluateNeutralStability>
    const displayed = localizedSetupMessage(saved.reason!)
    expect(displayed).toContain('只有 10 個樣本；需要 30 個')
    expect(displayed).toContain('只取樣 1000 ms；需要 2000 ms')
    expect(displayed).toContain('橫滾回中輸出達 0.050（上限 0.020）')
    expect(displayed).toContain('橫滾回中抖動標準差為 0.050（上限 0.010）')
    expect(JSON.stringify(saved)).toBe(raw)
    expect(saved.stable).toBe(false)
    expect(saved.reason).toContain('roll reached')
  })

  it('keeps real nested tuning validation fields and bounds legible without modifying settings or diagnostics', () => {
    const settings = updateDroneTuning(updatePidAxis(updateRateAxis(createDefaultTuningSettings(), 'roll', {
      centerRateDegPerSec: -1, expo: 2,
    }), 'pitch', { kp: 6 }), { motorResponseTimeConstantSeconds: 0.001 })
    const original = JSON.stringify(settings)
    const validation = validateTuningSettings(settings)
    const errorsBefore = [...validation.errors]
    const displayed = validation.errors.map(localizedSetupMessage).join('\n')
    expect(validation.valid).toBe(false)
    expect(displayed).toContain('飛控：角速度曲線：橫滾：中心靈敏度')
    expect(displayed).toContain('曲線彎曲程度（Expo）必須是 0 至 1 之間')
    expect(displayed).toContain('俯仰 比例增益 P必須是 0 至 5 之間')
    expect(displayed).toContain('馬達 0反應時間常數必須是 0.005 至 1 之間')
    expect(displayed).not.toMatch(/must be|configuration|controller:|rates:/u)
    expect(validation.errors).toEqual(errorsBefore)
    expect(JSON.stringify(settings)).toBe(original)
  })

  it('retains movement evidence and literal motor identifiers in detailed diagnostics', () => {
    expect(localizedSetupMessage('No axis moved far enough (largest excursion 0.125; need 0.250).')).toContain('最大偏移 0.125；需要 0.250')
    expect(localizedSetupMessage('Multiple axes moved together (3 and 1); move only the requested control.')).toContain('軸 3 與軸 1')
    expect(localizedSetupMessage('drone: front-left maximum thrust must be greater than zero.')).toBe('機體：front-left 的最大推力必須大於零。')
    expect(localizedSetupMessage('Motor ID User-Motor-7 is duplicated.')).toContain('User-Motor-7')
  })

  it('preserves existing Chinese and unfamiliar diagnostics rather than inventing a cause', () => {
    for (const message of ['請先完成遙控器校正。', 'Controller ZX-7 returned error E42', 'device: Custom controller; no data', 'constructor', '__proto__', 'roll toString']) {
      expect(localizedSetupMessage(message)).toBe(message)
    }
  })
})
