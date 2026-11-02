import { describe, expect, it } from 'vitest'
import { fingerprintTrainingSettings } from './attempt'
import { formatTrainingMetrics, trainingHint, trainingObjective, trainingRouteGuide } from './feedback'
import { slalomCollisionCause, slalomInterruptionReason } from './slalomFeedback'
import { summarizeTrainingResult } from './resultFeedback'
import type { TrainingResult } from './types'

const scope = { rulesVersion: 6, physicsVersion: 1, presetId: 'beginner', inputSource: 'controller',
  mode: 'practice', assistance: 'none', settingsFingerprint: fingerprintTrainingSettings({ preset: 'beginner' }) } as const
const proof = { slalomPhase: 10, slalomEpisodeValid: 1, slalomFlagsPassed: 6, slalomExited: 1,
  slalomRecovered: 1, slalomRecoveryQualifying: 1, slalomRecoveryDwellSeconds: 0.2 }
function result(overrides: Partial<TrainingResult> = {}): TrainingResult {
  return { lessonId: 'slalom', sessionId: 'slalom:feedback', outcome: 'FAILED', score: 0,
    elapsedSeconds: 25, sampleCount: 6000, completedCheckpoints: 4, totalCheckpoints: 10,
    startedAtSeconds: 0, completedAtSeconds: 25, attemptContext: scope,
    metrics: { slalomPhase: 4, slalomFlagsPassed: 2, slalomEpisodeValid: 1 },
    message: '', hint: null, ...overrides }
}

describe('L18 forward S-turn guidance and result evidence', () => {
  it('explains real forward alternating sides and the visible generous passing bounds', () => {
    const guide = trainingRouteGuide('slalom')!
    expect(guide).toMatch(/地面自行起飛.*4 m.*第一旗左側.*第二旗右側.*六旗.*向前離場/)
    expect(guide).toContain('間距 12 m')
    expect(guide).toContain('1～8 m、離地 1～7 m')
    expect(guide).toContain('刀旗有實際碰撞')
    expect(guide).toContain('不用貼線、固定側立 90°、精準速度、懸停或降落')
    expect(guide).toContain('引導練習不限時')
    expect(guide).toContain('能力挑戰 300 秒')
  })

  it('names the next physical flag and required side instead of a stick gesture', () => {
    for (let index = 0; index < 6; index += 1) {
      const objective = trainingObjective('slalom', { metrics: { slalomPhase: index + 2,
        slalomFlagsPassed: index, slalomTargetIndex: index, slalomNextFlagDistanceM: 5.5, slalomSideOffsetM: -2 } })!
      expect(objective.title).toContain(`第 ${index + 1} 旗：${index % 2 === 0 ? '左' : '右'}側`)
      expect(objective.detail).toContain('5.5 m')
      expect(objective.detail).toContain('-2.0 m')
    }
    expect(trainingObjective('slalom', null)?.title).toContain('地面準備')
    expect(trainingObjective('slalom', { metrics: { slalomPhase: 1 } })?.detail).toContain('不用先懸停')
  })

  it('keeps the first wrong-side cause and measured offset separate from the current corrected position', () => {
    const metrics = { slalomPhase: 2, slalomFlagsPassed: 0, slalomInterrupted: 1, slalomInterruptionReason: 4,
      interruptionSlalomFlagIndex: 1, interruptionSlalomSideOffsetM: -3.2,
      slalomTargetIndex: 0, slalomSideOffsetM: 4, altitudeM: 4 }
    const objective = trainingObjective('slalom', { metrics })!
    expect(objective.title).toContain('本段已中斷')
    expect(objective.detail).toContain('第 2 旗需要從右側通過')
    expect(objective.detail).toContain('-3.2 m')
    expect(objective.detail).toContain('先前勾選保留')
    expect(objective.detail).not.toContain('4.0 m')
    expect(trainingHint('slalom', { status: 'continue', metrics })).toContain('-3.2 m')
  })

  it.each([
    [1, '接地'], [2, '高度過低'], [3, '練習區'], [4, '另一側'], [5, '太貼近'],
    [6, '太遠'], [7, '旗頂'], [8, '漏過此旗'], [9, '向後退回'], [10, '離場位置'],
  ] as const)('explains interruption %s with a concrete cause', (reason, expected) => {
    const message = slalomInterruptionReason({ slalomInterrupted: 1, slalomInterruptionReason: reason,
      interruptionSlalomFlagIndex: 2, interruptionSlalomSideOffsetM: 9,
      interruptionSlalomAltitudeM: 8.5, interruptionSlalomBacktrackM: 4 })!
    expect(message).toContain(expected)
    expect(message).not.toMatch(/NaN|Infinity/)
  })

  it.each([1, 2, 3, 4, 5, 6])('identifies physical collision with flag %s', (flag) => {
    const message = `刀旗 S 彎停止：機體已碰撞。Obstacle collision: slalom-flag-${flag}-banner`
    expect(slalomCollisionCause(message)).toBe(`第 ${flag} 面刀旗`)
    expect(trainingHint('slalom', { status: 'failure', message })).toContain(`碰到第 ${flag} 面刀旗`)
    expect(summarizeTrainingResult(result({ message })).observedGap).toContain(`碰到第 ${flag} 面刀旗`)
    expect(slalomCollisionCause('Obstacle collision: wide-gate-1-left-post')).toBeNull()
  })

  it('requires each fresh six-flag, exit and recovery fact before reporting success', () => {
    const passed = result({ outcome: 'SUCCESS', completedCheckpoints: 10, metrics: proof })
    expect(summarizeTrainingResult(passed).observedGap).toBeNull()
    expect(trainingObjective('slalom', { metrics: proof })?.title).toContain('恢復完成')
    for (const key of Object.keys(proof)) {
      const incomplete = Object.fromEntries(Object.entries(proof).filter(([name]) => name !== key))
      expect(summarizeTrainingResult({ ...passed, metrics: incomplete }).observedGap, key).toContain('證據')
    }
    const invalidProofs: Readonly<Record<string, number>>[] = [{ slalomFlagsPassed: 5 }, { slalomInterrupted: 1 }, { slalomRecoveryDwellSeconds: 0.1 }]
    for (const patch of invalidProofs) {
      expect(summarizeTrainingResult({ ...passed, metrics: { ...proof, ...patch } }).observedGap).toContain('證據')
    }
    expect(summarizeTrainingResult({ ...passed, sampleCount: 0 }).observedStrength).toBeNull()
    expect(summarizeTrainingResult({ ...passed, completedCheckpoints: 9 }).observedGap).not.toBeNull()
  })

  it('distinguishes forward exit from recovering without requiring a stop', () => {
    const sixFlags = { slalomPhase: 8, slalomFlagsPassed: 6, slalomNextFlagDistanceM: 7.5 }
    expect(trainingObjective('slalom', { metrics: sixFlags })?.detail).toContain('7.5 m')
    const exiting = trainingObjective('slalom', { metrics: { ...sixFlags, slalomPhase: 9, slalomExited: 1 } })!
    expect(exiting.title).toContain('恢復正飛')
    expect(exiting.detail).toContain('不要求懸停或停止')
  })

  it('formats observed passing progress and signed side position without exposing accumulators', () => {
    const display = formatTrainingMetrics({ slalomPhase: 3, slalomFlagsPassed: 1,
      slalomNextFlagDistanceM: 7.1, slalomSideOffsetM: -2, slalomFurthestForwardM: 20 }, 'slalom')
    expect(display.map(({ key }) => key)).toEqual(['slalomFlagsPassed', 'slalomNextFlagDistanceM', 'slalomSideOffsetM'])
    expect(display[2]).toMatchObject({ label: '指定側偏移（正值為正確側）', value: '-2.0 m' })
  })
})
