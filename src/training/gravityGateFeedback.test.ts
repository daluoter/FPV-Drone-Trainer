import { describe, expect, it } from 'vitest'
import { fingerprintTrainingSettings } from './attempt'
import { formatTrainingMetrics, trainingHint, trainingObjective, trainingRouteGuide } from './feedback'
import { gravityGateCollisionCause, gravityGateInterruptionReason } from './gravityGateFeedback'
import { summarizeTrainingResult } from './resultFeedback'
import type { TrainingResult } from './types'

const scope = { rulesVersion: 7, physicsVersion: 1, presetId: 'beginner', inputSource: 'controller',
  mode: 'practice', assistance: 'none', settingsFingerprint: fingerprintTrainingSettings({ preset: 'beginner' }) } as const
function result(overrides: Partial<TrainingResult> = {}): TrainingResult {
  return { lessonId: 'gravity-gate', sessionId: 'gravity:feedback', outcome: 'FAILED', score: 0,
    elapsedSeconds: 20, sampleCount: 4800, completedCheckpoints: 5, totalCheckpoints: 8,
    startedAtSeconds: 0, completedAtSeconds: 20, attemptContext: scope,
    metrics: { gravityGatePhase: 5, gravityGateEpisodeValid: 1 }, message: '', hint: null, ...overrides }
}
const proof = { gravityGatePhase: 8, gravityGateEpisodeValid: 1, gravityGateForwardEstablished: 1,
  gravityGateTossed: 1, gravityGateAdjusted: 1, gravityGateEntered: 1, gravityGateLowerReached: 1,
  gravityGateReturnReady: 1, gravityGateReturned: 1, gravityGateReturnDistanceM: 0.3, gravityGateExited: 1,
  gravityGateRecovered: 1, gravityGateRecoveryQualifying: 1, gravityGateRecoveryDwellSeconds: 0.2 }

describe('L19 gravity gate guidance and result evidence', () => {
  it('explains the genuine top entrance, marked side exit, collisions and broad initial version', () => {
    const guide = trainingRouteGuide('gravity-gate')!
    expect(guide).toMatch(/地面自行起飛.*8 m.*右側.*前速.*上拋.*收油.*頂口.*低層.*折返.*恢復/)
    expect(guide).toContain('寬 8 m、深 8 m')
    expect(guide).toContain('8.86 m')
    expect(guide).toContain('實際碰撞')
    expect(guide).toContain('不要求固定翻轉圈數')
    expect(guide).toContain('引導練習不限時')
    expect(trainingObjective('gravity-gate', null)?.title).toContain('地面準備')
  })
  it('keeps the first missed aperture measurements distinct from the recovered live position', () => {
    const metrics = { gravityGatePhase: 5, gravityGateEpisodeValid: 0, gravityGateInterrupted: 1,
      gravityGateInterruptionReason: 4, interruptionGravityGateEntryHorizontalErrorM: 9,
      interruptionGravityGateEntryForwardErrorM: -8, gravityGateEntryHorizontalErrorM: 0, gravityGateEntryForwardErrorM: 0 }
    const objective = trainingObjective('gravity-gate', { metrics })!
    expect(objective.title).toContain('本段已中斷')
    expect(objective.detail).toContain('9.0 m')
    expect(objective.detail).toContain('-8.0 m')
    expect(objective.detail).toContain('先前步驟保留')
    expect(trainingHint('gravity-gate', { status: 'continue', metrics })).toContain('9.0 m')
  })
  it('uses consistent signed top-height, left-right and front-back metrics', () => {
    const metrics = { gravityGatePhase: 5, gravityGateTopHeightDifferenceM: 3.2,
      gravityGateEntryHorizontalErrorM: -1.1, gravityGateEntryForwardErrorM: 2.6 }
    const displays = formatTrainingMetrics(metrics, 'gravity-gate')
    expect(displays.map(({ key }) => key)).toEqual(['gravityGateTopHeightDifferenceM', 'gravityGateEntryHorizontalErrorM', 'gravityGateEntryForwardErrorM'])
    expect(displays.map(({ label }) => label).join(' ')).toContain('右＋')
    expect(displays.map(({ label }) => label).join(' ')).toContain('後＋')
    const objective = trainingObjective('gravity-gate', { metrics: { ...metrics, gravityGateEpisodeValid: 1,
      gravityGateTossed: 1, gravityGateAdjusted: 1 } })!
    expect(objective.detail).toContain('3.2 m')
    expect(objective.detail).toContain('-1.1 m')
    expect(objective.detail).toContain('2.6 m')
  })
  it('chooses next instruction from fresh episode facts rather than historic checkmarks', () => {
    expect(trainingObjective('gravity-gate', { metrics: { gravityGatePhase: 7, gravityGateEpisodeValid: 0 } })?.title).toContain('建立前進速度')
    expect(trainingObjective('gravity-gate', { metrics: { gravityGatePhase: 7, gravityGateEpisodeValid: 1 } })?.title).toContain('帶速向上拋')
    expect(trainingObjective('gravity-gate', { metrics: { gravityGatePhase: 7, gravityGateEpisodeValid: 1, gravityGateTossed: 1 } })?.title).toContain('收油')
    for (let phase = 0; phase <= 8; phase += 1) {
      const objective = trainingObjective('gravity-gate', { metrics: { gravityGatePhase: phase } })!
      expect(objective.detail).not.toMatch(/NaN|Infinity/)
      expect(objective.title).not.toContain('恢復完成')
    }
  })
  it('requires each fresh same-episode proof before calling a stored outcome successful', () => {
    const passed = result({ outcome: 'SUCCESS', completedCheckpoints: 8, metrics: proof })
    expect(summarizeTrainingResult(passed).observedGap).toBeNull()
    expect(trainingObjective('gravity-gate', { metrics: proof })?.title).toContain('恢復完成')
    for (const key of Object.keys(proof)) {
      const missing = Object.fromEntries(Object.entries(proof).filter(([name]) => name !== key))
      expect(summarizeTrainingResult({ ...passed, metrics: missing }).observedGap, key).toContain('證據')
    }
    const incompleteCases: Readonly<Record<string, number>>[] = [{ gravityGateInterrupted: 1 }, { gravityGateRecoveryDwellSeconds: 0.1 }]
    for (const patch of incompleteCases) {
      expect(summarizeTrainingResult({ ...passed, metrics: { ...proof, ...patch } }).observedGap).toContain('證據')
    }
    expect(summarizeTrainingResult({ ...passed, sampleCount: 0 }).observedStrength).toBeNull()
  })
  it.each([
    ['gravity-gate-left-near-post', '左近側立柱'], ['gravity-gate-right-far-post', '右遠側立柱'],
    ['gravity-gate-top-near-bar', '頂部近側橫樑'], ['gravity-gate-bottom-left-bar', '底部左橫樑'],
    ['gravity-gate-middle-right-bar', '中層右橫樑'],
  ])('names the real collider %s in Chinese', (id, expected) => {
    const message = `重力門停止：機體已碰撞實體門框。Obstacle collision: ${id}`
    expect(gravityGateCollisionCause(message)).toBe(expected)
    expect(trainingHint('gravity-gate', { status: 'failure', message })).toContain(expected)
    expect(summarizeTrainingResult(result({ message })).observedGap).toContain(expected)
  })
  it('does not mislabel an unrelated obstacle as a gravity gate beam', () => {
    expect(gravityGateCollisionCause('Obstacle collision: wide-gate-1-left-post')).toBeNull()
    expect(gravityGateCollisionCause('gravity-gate-top-near-bar')).toBeNull()
  })
  it('distinguishes collision, disarm, invalid data and timeout from piloting observations', () => {
    for (const [message, expected] of [['重力門停止：機體已墜毀。', '墜毀'],
      ['重力門停止：已上鎖或失去焦點。', '失去焦點'],
      ['重力門停止：位置跳躍與實際速度不一致。', '資料無效'],
      ['重力門挑戰逾時。', '逾時']] as const) {
      const feedback = summarizeTrainingResult(result({ message }))
      expect(feedback.observedStrength).toBeNull()
      expect(feedback.observedGap).toContain(expected)
    }
  })
  it('explains lost approach momentum instead of silently restarting the task', () => {
    const metrics = { gravityGateInterrupted: 1, gravityGateInterruptionReason: 10 }
    expect(gravityGateInterruptionReason(metrics)).toContain('不能先停住後直上直下')
  })
  it('explains each low-level substage and the near-stop witness instead of hiding a condition', () => {
    const entered = { gravityGatePhase: 6, gravityGateEpisodeValid: 1, gravityGateTossed: 1,
      gravityGateAdjusted: 1, gravityGateEntered: 1, gravityGateLowerHeightDifferenceM: 3.5 }
    expect(trainingObjective('gravity-gate', { metrics: entered })?.detail).toContain('3.5 m')
    const low = { ...entered, gravityGateLowerReached: 1 }
    expect(trainingObjective('gravity-gate', { metrics: low })?.detail).toContain('近乎停住')
    const ready = { ...low, gravityGateReturnReady: 1, gravityGateReturnSpeedMps: 0.1, gravityGateReturnDistanceM: 0.05 }
    expect(trainingObjective('gravity-gate', { metrics: ready })?.detail).toContain('至少 0.5 m/s')
    expect(trainingObjective('gravity-gate', { metrics: ready })?.detail).toContain('至少 0.3 m')
    const returned = { ...ready, gravityGateReturned: 1 }
    expect(trainingObjective('gravity-gate', { metrics: returned })?.title).toContain('來向那側')
  })
  it('formats actual lower-level return measurements with a clear signed direction', () => {
    const displays = formatTrainingMetrics({ gravityGatePhase: 6, gravityGateLowerReached: 1,
      gravityGateReturnSpeedMps: -0.7, gravityGateReturnDistanceM: 0.15, gravityGateExitDistanceM: 2.8 }, 'gravity-gate')
    expect(displays.map(({ key }) => key)).toEqual(['gravityGateReturnSpeedMps', 'gravityGateReturnDistanceM', 'gravityGateExitDistanceM'])
    expect(displays[0]).toMatchObject({ label: '回程速度（朝來向＋）', value: '-0.70 m/s' })
  })
  it('retains old rule-6 outcomes without crediting the corrected return route', () => {
    const legacy = result({ attemptContext: { ...scope, rulesVersion: 6 }, outcome: 'SUCCESS', completedCheckpoints: 8,
      metrics: { gravityGatePhase: 8, gravityGateEntered: 1, gravityGateExited: 1 } })
    const before = JSON.stringify(legacy)
    const summary = summarizeTrainingResult(legacy)
    expect(summary.observedStrength).toBeNull()
    expect(summary.observedGap).toContain('舊版')
    expect(summary.observedGap).toContain('不轉算')
    expect(JSON.stringify(legacy)).toBe(before)
  })
  it('keeps the original upper-exit height distinct from later low-level recovery', () => {
    const metrics = { gravityGatePhase: 6, gravityGateInterrupted: 1, gravityGateInterruptionReason: 11,
      interruptionAltitudeM: 12.1, interruptionGravityGateLowerHeightDifferenceM: 3.24,
      altitudeM: 6, gravityGateLowerHeightDifferenceM: -2.86 }
    expect(gravityGateInterruptionReason(metrics)).toContain('12.1 m')
    expect(gravityGateInterruptionReason(metrics)).toContain('3.2 m')
    expect(trainingHint('gravity-gate', { status: 'continue', metrics })).toContain('先穿過中環下降')
  })

})
