import { describe, expect, it } from 'vitest'
import { fingerprintTrainingSettings } from './attempt'
import { trainingHint, formatTrainingMetrics, trainingObjective, trainingRouteGuide } from './feedback'
import { orbitInterruptionReason } from './orbitFeedback'
import { summarizeTrainingResult } from './resultFeedback'
import type { TrainingResult } from './types'

const scope = { rulesVersion: 6, physicsVersion: 1, presetId: 'beginner', inputSource: 'controller',
  mode: 'practice', assistance: 'none', settingsFingerprint: fingerprintTrainingSettings({ preset: 'beginner' }) } as const
function result(overrides: Partial<TrainingResult> = {}): TrainingResult {
  return { lessonId: 'orbit', sessionId: 'orbit:feedback', outcome: 'FAILED', score: 0, elapsedSeconds: 30,
    sampleCount: 7200, completedCheckpoints: 4, totalCheckpoints: 9, startedAtSeconds: 0, completedAtSeconds: 30,
    attemptContext: scope, metrics: { orbitPhase: 4, orbitProgressDegrees: 110, orbitEpisodeValid: 1 },
    message: '', hint: null, ...overrides }
}

describe('ground-start orbit feedback', () => {
  it('explains ground takeoff, generous limits, actual target-facing motion and controlled exit', () => {
    expect(trainingObjective('orbit', null)?.title).toContain('地面準備')
    const guide = trainingRouteGuide('orbit')!
    expect(guide).toMatch(/地面自行起飛.*10 m.*30 m.*15 m.*機頭朝塔/)
    expect(guide).toMatch(/6～30 m.*4～20 m.*80°/)
    expect(guide).toContain('原地偏航')
    expect(guide).toContain('引導練習不限時')
    expect(guide).toMatch(/連續完成第 1～5 圈.*1800°/)
    expect(guide).toContain('每圈完整 360°')
    const metrics = formatTrainingMetrics({ orbitPhase: 4, orbitProgressDegrees: 120, orbitCompletedLaps: 0, orbitRadiusM: 16, orbitHeadingErrorDegrees: 20 }, 'orbit')
    expect(metrics.map(({ key }) => key)).toEqual(['orbitCompletedLaps', 'orbitRadiusM', 'orbitHeadingErrorDegrees'])
  })

  it('keeps original interruption measurements after the pilot returns inside the valid region', () => {
    const metrics = { orbitPhase: 5, orbitEpisodeValid: 0, orbitInterrupted: 1, orbitInterruptionReason: 4,
      interruptionOrbitRadiusM: 41.2, orbitRadiusM: 15, orbitProgressDegrees: 0 }
    const objective = trainingObjective('orbit', { metrics })!
    expect(objective.title).toContain('本組已中斷')
    expect(objective.detail).toContain('41.2 m')
    expect(objective.detail).toContain('先前里程碑保留')
    expect(objective.detail).toContain('本組圈數已清空')
    expect(trainingHint('orbit', { status: 'continue', metrics })).toContain('41.2 m')
    const heading = { ...metrics, orbitInterruptionReason: 6, interruptionOrbitHeadingErrorDegrees: 121, orbitHeadingErrorDegrees: 5 }
    expect(orbitInterruptionReason(heading)).toContain('121.0 °')
    expect(orbitInterruptionReason(heading)).toContain('80°')
    expect(summarizeTrainingResult(result({ metrics: heading })).observedStrength).toBeNull()
  })

  it('names a current radius, height, heading or motion problem without treating it as success', () => {
    for (const [correction, expected] of [
      [{ orbitRadiusM: 35 }, '35.0 m'], [{ altitudeM: 22 }, '22.0 m'],
      [{ orbitHeadingErrorDegrees: 90 }, '90.0 °'], [{ orbitTangentialSpeedMps: 0 }, '0.0 m/s'],
    ] as const) {
      const baseline = { orbitPhase: 4, orbitEpisodeValid: 1, orbitProgressDegrees: 110,
        orbitRadiusM: 15, altitudeM: 10, orbitHeadingErrorDegrees: 5, orbitTangentialSpeedMps: 4 }
      const detail = trainingObjective('orbit', { metrics: { ...baseline, ...correction } })!.detail
      expect(detail).toContain(expected)
      expect(detail).not.toMatch(/NaN|Infinity/)
    }
  })

  it('shows actual outward distance and speed needed after all five circles', () => {
    const metrics = { orbitPhase: 8, orbitEpisodeValid: 1, orbitCompleted: 1, orbitProgressDegrees: 1805,
      orbitCompletedLaps: 5, orbitExitDistanceM: 1.2, orbitRadialSpeedMps: 0 }
    const detail = trainingObjective('orbit', { metrics })!.detail
    expect(detail).toContain('5／5 圈')
    expect(detail).toContain('1.2 m')
    expect(detail).toContain('至少 3 m')
    expect(detail).toContain('0.5 m/s')
    expect(detail).toContain('原地懸停')
    expect(trainingObjective('orbit', { metrics: { orbitPhase: 8, orbitEpisodeValid: 1, orbitCompleted: 1,
      orbitCompletedLaps: 5, orbitProgressDegrees: 1805 } })!.detail).not.toMatch(/NaN|Infinity/)
  })

  it('requires actual lap and exit evidence before praising a complete result', () => {
    const proven = { orbitPhase: 9, orbitEpisodeValid: 1, orbitCompleted: 1, orbitProgressDegrees: 1805, orbitCompletedLaps: 5,
      orbitExitDistanceM: 3.5, orbitRadialSpeedMps: 1, orbitExitQualifying: 1, orbitRecoveryQualifying: 1, orbitRecoveryDwellSeconds: 0.2 }
    expect(summarizeTrainingResult(result({ outcome: 'SUCCESS', completedCheckpoints: 9, metrics: proven })).observedGap).toBeNull()
    for (const patch of [{ orbitProgressDegrees: 110 }, { orbitCompletedLaps: 4 }, { orbitExitQualifying: 0 }, { orbitEpisodeValid: 0 }, { orbitRecoveryQualifying: 0 }, { orbitExitDistanceM: 2 }, { orbitRadialSpeedMps: 0 }, { orbitRecoveryDwellSeconds: 0 }]) {
      const feedback = summarizeTrainingResult(result({ outcome: 'SUCCESS', completedCheckpoints: 9, metrics: { ...proven, ...patch } }))
      expect(feedback.observedGap).toContain('證據')
    }
    expect(trainingObjective('orbit', { metrics: { orbitPhase: 9, orbitEpisodeValid: 1 } })!.title).not.toContain('恢復控制完成')
    const missingRecovery = Object.fromEntries(Object.entries(proven).filter(([key]) => key !== 'orbitRecoveryQualifying'))
    expect(summarizeTrainingResult(result({ outcome: 'SUCCESS', completedCheckpoints: 9, metrics: missingRecovery })).observedGap).toContain('證據')
    expect(trainingObjective('orbit', { metrics: missingRecovery })!.title).not.toContain('飛離完成')
    expect(summarizeTrainingResult(result({ metrics: proven, sampleCount: 0 })).observedStrength).toBeNull()
  })

  it('distinguishes a crash, disarm and invalid data, while retaining historical three-step meaning', () => {
    for (const [message, expected] of [['正刷鍋停止：機體已墜毀。', '墜毀'], ['正刷鍋停止：已上鎖。', '上鎖'],
      ['正刷鍋停止：位置跳躍與速度不一致。', '資料無效']] as const) {
      const feedback = summarizeTrainingResult(result({ message }))
      expect(feedback.observedStrength).toBeNull()
      expect(feedback.observedGap).toContain(expected)
    }
    const historical = summarizeTrainingResult(result({ attemptContext: { ...scope, rulesVersion: 4 }, outcome: 'SUCCESS',
      completedCheckpoints: 3, totalCheckpoints: 3, metrics: { orbitProgress: Math.PI * 2 } }))
    expect(historical.observedStrength).not.toContain('地面自行起飛')
    expect(historical.observedStrength).toContain('3 / 3')
  })
})
