import { describe, expect, it } from 'vitest'
import { fingerprintTrainingSettings } from './attempt'
import { formatTrainingMetrics, trainingHint, trainingObjective, trainingRouteGuide } from './feedback'
import { summarizeTrainingResult } from './resultFeedback'
import type { TrainingResult } from './types'

const scope = { rulesVersion: 6, physicsVersion: 1, presetId: 'beginner', inputSource: 'controller',
  mode: 'practice', assistance: 'none', settingsFingerprint: fingerprintTrainingSettings({ preset: 'beginner' }) } as const
function result(overrides: Partial<TrainingResult> = {}): TrainingResult {
  return { lessonId: 'backward-flight', sessionId: 'backward:feedback', outcome: 'FAILED', score: 0,
    elapsedSeconds: 20, sampleCount: 4800, completedCheckpoints: 5, totalCheckpoints: 7,
    startedAtSeconds: 0, completedAtSeconds: 20, attemptContext: scope,
    metrics: { backwardPhase: 5, backwardEpisodeValid: 1, backwardDistanceM: 1 }, message: '', hint: null, ...overrides }
}
const proof = { backwardPhase: 7, backwardEpisodeValid: 1, backwardForwardEstablished: 1, backwardTurned: 1,
  backwardMoving: 1, backwardMaintained: 1, backwardDistanceM: 4, backwardHoldSeconds: 0.8,
  backwardRecoveryQualifying: 1, backwardRecoveryDwellSeconds: 0.25 }

describe('L17 backward flight guidance and result evidence', () => {
  it('explains original momentum, upright yaw, actual backward distance and optional recovery paths', () => {
    const guide = trainingRouteGuide('backward-flight')!
    expect(guide).toMatch(/地面自行起飛.*10 m.*180°.*機腹朝地.*原本移動方向/)
    expect(guide).toMatch(/3 m.*0.6 秒/)
    expect(guide).toContain('平穩減速或轉回')
    expect(guide).toContain('原地轉頭')
    expect(guide).toContain('引導練習不限時')
    expect(trainingObjective('backward-flight', null)?.title).toContain('地面準備')
    const objective = trainingObjective('backward-flight', { metrics: { backwardPhase: 3,
      backwardEpisodeValid: 1, backwardYawDegrees: 95, backwardForwardSpeedMps: 3 } })!
    expect(objective.detail).toContain('95.0 °')
    expect(objective.detail).toContain('3.0 m/s')
    expect(objective.detail).toContain('不要先煞停')
  })

  it('keeps the first interruption facts visible after current flight values recover', () => {
    const metrics = { backwardPhase: 5, backwardEpisodeValid: 0, backwardInterrupted: 1,
      backwardInterruptionReason: 6, interruptionBackwardForwardSpeedMps: -0.4,
      backwardForwardSpeedMps: 4, backwardDistanceM: 0 }
    const objective = trainingObjective('backward-flight', { metrics })!
    expect(objective.title).toContain('本段已中斷')
    expect(objective.detail).toContain('-0.4 m/s')
    expect(objective.detail).toContain('失去前飛動量')
    expect(objective.detail).toContain('先前步驟保留')
    expect(trainingHint('backward-flight', { status: 'continue', metrics })).toContain('-0.4 m/s')
    const heading = { ...metrics, backwardInterruptionReason: 7, interruptionBackwardHeadingErrorDegrees: 89 }
    expect(trainingObjective('backward-flight', { metrics: heading })!.detail).toContain('89.0 °')
  })

  it('shows measured backward speed, distance and time with clear units', () => {
    const metrics = { backwardPhase: 5, backwardEpisodeValid: 1, backwardSpeedMps: 2.2,
      backwardDistanceM: 1.6, backwardHoldSeconds: 0.4 }
    expect(formatTrainingMetrics(metrics, 'backward-flight').map(({ key }) => key))
      .toEqual(['backwardSpeedMps', 'backwardDistanceM', 'backwardHoldSeconds'])
    const objective = trainingObjective('backward-flight', { metrics })!
    expect(objective.detail).toContain('1.6 m')
    expect(objective.detail).toContain('0.4 s')
    expect(objective.detail).toContain('至少 3 m')
    expect(objective.detail).toContain('至少 0.6 秒')
    for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const missing = trainingObjective('backward-flight', { metrics: { backwardPhase: phase, backwardEpisodeValid: 1 } })!
      expect(missing.detail).not.toMatch(/NaN|Infinity/)
      expect(missing.title).not.toContain('恢復完成')
    }
  })

  it('requires the whole same-episode flight evidence before reporting success', () => {
    const passed = result({ outcome: 'SUCCESS', completedCheckpoints: 7, metrics: proof })
    expect(summarizeTrainingResult(passed).observedGap).toBeNull()
    expect(trainingObjective('backward-flight', { metrics: proof })?.title).toContain('恢復完成')
    for (const key of Object.keys(proof)) {
      const missing = Object.fromEntries(Object.entries(proof).filter(([name]) => name !== key))
      const feedback = summarizeTrainingResult({ ...passed, metrics: missing })
      expect(feedback.observedGap, key).toContain('證據')
    }
    const invalidProofs: Readonly<Record<string, number>>[] = [{ backwardDistanceM: 2.9 }, { backwardHoldSeconds: 0.5 },
      { backwardRecoveryDwellSeconds: 0.2 }, { backwardInterrupted: 1 }]
    for (const patch of invalidProofs) {
      expect(summarizeTrainingResult({ ...passed, metrics: { ...proof, ...patch } }).observedGap).toContain('證據')
    }
    expect(summarizeTrainingResult({ ...passed, sampleCount: 0 }).observedStrength).toBeNull()
  })

  it('distinguishes a crash, loss of focus and invalid data from flight performance', () => {
    for (const [message, expected] of [['後退飛行停止：機體已墜毀。', '墜毀'],
      ['後退飛行停止：已上鎖或失去焦點。', '失去焦點'],
      ['後退飛行停止：位置跳躍與實際速度不一致。', '資料無效']] as const) {
      const feedback = summarizeTrainingResult(result({ message }))
      expect(feedback.observedStrength).toBeNull()
      expect(feedback.observedGap).toContain(expected)
    }
  })
})
