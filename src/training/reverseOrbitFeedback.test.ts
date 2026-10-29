import { describe, expect, it } from 'vitest'
import { fingerprintTrainingSettings } from './attempt'
import { formatTrainingMetrics, trainingHint, trainingObjective, trainingRouteGuide } from './feedback'
import { summarizeTrainingResult } from './resultFeedback'
import type { TrainingResult } from './types'

const scope = { rulesVersion: 6, physicsVersion: 1, presetId: 'beginner', inputSource: 'controller',
  mode: 'practice', assistance: 'none', settingsFingerprint: fingerprintTrainingSettings({ preset: 'beginner' }) } as const
function result(overrides: Partial<TrainingResult> = {}): TrainingResult {
  return { lessonId: 'reverse-orbit', sessionId: 'reverse-orbit:feedback', outcome: 'FAILED', score: 0,
    elapsedSeconds: 30, sampleCount: 7200, completedCheckpoints: 4, totalCheckpoints: 7,
    startedAtSeconds: 0, completedAtSeconds: 30, attemptContext: scope,
    metrics: { reverseOrbitPhase: 4, reverseOrbitEpisodeValid: 1, reverseOrbitProgressDegrees: 400 },
    message: '', hint: null, ...overrides }
}
const proof = { reverseOrbitPhase: 7, reverseOrbitEpisodeValid: 1, reverseOrbitCompleted: 1,
  reverseOrbitCompletedLaps: 3, reverseOrbitProgressDegrees: 1081, reverseOrbitExitDistanceM: 4,
  reverseOrbitRadialSpeedMps: 1, reverseOrbitExitQualifying: 1, reverseOrbitRecoveryQualifying: 1,
  reverseOrbitRecoveryDwellSeconds: 0.2 }

describe('L16 crane upward-orbit feedback', () => {
  it('teaches actual upward sightline, three full circles and a real airborne departure', () => {
    const guide = trainingRouteGuide('reverse-orbit')!
    expect(guide).toMatch(/地面自行起飛.*22\.5 m.*塔式起重機.*45 m.*3 個完整 360°.*1080°/)
    expect(guide).toContain('鏡頭仰視至少 35°')
    expect(guide).toContain('實際鏡頭安裝角')
    expect(guide).toContain('仰視不等於機腹朝天')
    expect(guide).toContain('引導練習不限時')
    expect(trainingObjective('reverse-orbit', null)?.title).toContain('地面準備')
    expect(trainingObjective('reverse-orbit', { metrics: { reverseOrbitPhase: 2 } })?.title).toContain('仰視機臂')
  })

  it('shows the original upward-view failure after the camera returns to a valid angle', () => {
    const metrics = { reverseOrbitPhase: 4, reverseOrbitEpisodeValid: 0, reverseOrbitInterrupted: 1,
      reverseOrbitInterruptionReason: 10, interruptionReverseOrbitViewElevationDegrees: 24,
      reverseOrbitViewElevationDegrees: 70 }
    const objective = trainingObjective('reverse-orbit', { metrics })!
    expect(objective.title).toContain('本組已中斷')
    expect(objective.detail).toContain('24.0 °')
    expect(objective.detail).toContain('至少 35°')
    expect(objective.detail).toContain('本組圈數已清空')
    expect(trainingHint('reverse-orbit', { status: 'continue', metrics })).toContain('24.0 °')
    const target = { ...metrics, reverseOrbitInterruptionReason: 6,
      interruptionReverseOrbitTargetViewErrorDegrees: 30, interruptionReverseOrbitViewLimitDegrees: 22.5 }
    expect(trainingObjective('reverse-orbit', { metrics: target })?.detail).toContain('22.5 °')
  })

  it('uses actual field of view rather than a fixed 45-degree allowance', () => {
    const metrics = { reverseOrbitPhase: 3, reverseOrbitEpisodeValid: 1,
      reverseOrbitViewElevationDegrees: 70, reverseOrbitTargetViewErrorDegrees: 30, reverseOrbitViewLimitDegrees: 22.5,
      reverseOrbitCompletedLaps: 0, reverseOrbitProgressDegrees: 20 }
    const objective = trainingObjective('reverse-orbit', { metrics })!
    expect(objective.detail).toContain('30.0 °')
    expect(objective.detail).toContain('22.5 °')
    expect(objective.detail).toContain('機臂回到視野')
    expect(formatTrainingMetrics(metrics, 'reverse-orbit').map(({ key }) => key))
      .toEqual(['reverseOrbitCompletedLaps', 'reverseOrbitViewElevationDegrees', 'reverseOrbitTargetViewErrorDegrees'])
  })

  it('keeps three completed laps separate from the final actual exit', () => {
    const metrics = { ...proof, reverseOrbitPhase: 6, reverseOrbitExitDistanceM: 0.6, reverseOrbitRadialSpeedMps: 0 }
    const objective = trainingObjective('reverse-orbit', { metrics })!
    expect(objective.title).toContain('向外飛離並恢復控制')
    expect(objective.detail).toContain('0.6 m')
    expect(objective.detail).toContain('至少 3 m')
    expect(objective.detail).toContain('原地停住')
    expect(summarizeTrainingResult(result({ metrics })).observedGap).not.toBeNull()
  })

  it('requires every same-episode lap, departure and recovery fact before praising success', () => {
    const passed = result({ outcome: 'SUCCESS', completedCheckpoints: 7, metrics: proof })
    expect(summarizeTrainingResult(passed).observedGap).toBeNull()
    for (const key of Object.keys(proof)) {
      const missing = Object.fromEntries(Object.entries(proof).filter(([name]) => name !== key))
      expect(summarizeTrainingResult({ ...passed, metrics: missing }).observedGap, key).toContain('證據')
    }
    const invalidProofs: Readonly<Record<string, number>>[] = [{ reverseOrbitCompletedLaps: 2 },
      { reverseOrbitProgressDegrees: 1079 }, { reverseOrbitExitDistanceM: 2.9 },
      { reverseOrbitRadialSpeedMps: 0 }, { reverseOrbitRecoveryDwellSeconds: 0.1 }, { reverseOrbitInterrupted: 1 }]
    for (const patch of invalidProofs) expect(summarizeTrainingResult({ ...passed, metrics: { ...proof, ...patch } }).observedGap).toContain('證據')
    expect(summarizeTrainingResult({ ...passed, sampleCount: 0 }).observedStrength).toBeNull()
  })

  it('distinguishes crash, camera changes and invalid observations without inventing numbers', () => {
    for (const [message, expected] of [['倒刷鍋停止：機體已墜毀。', '墜毀'],
      ['倒刷鍋停止：本次練習的鏡頭設定已改變。', '鏡頭設定'],
      ['倒刷鍋停止：位置跳躍與速度不一致。', '資料無效']] as const) {
      const feedback = summarizeTrainingResult(result({ message }))
      expect(feedback.observedStrength).toBeNull()
      expect(feedback.observedGap).toContain(expected)
    }
    for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const objective = trainingObjective('reverse-orbit', { metrics: { reverseOrbitPhase: phase, reverseOrbitEpisodeValid: 1 } })!
      expect(objective.detail).not.toMatch(/NaN|Infinity/)
      expect(objective.title).not.toContain('飛離完成')
    }
  })
})
