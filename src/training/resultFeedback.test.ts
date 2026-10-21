import { describe, expect, it } from 'vitest'
import { summarizeTrainingResult } from './resultFeedback'
import type { TrainingResult } from './types'

const result: TrainingResult = {
  lessonId: 'hover', sessionId: 'feedback', outcome: 'FAILED', score: 0,
  elapsedSeconds: 4, sampleCount: 960, completedCheckpoints: 1, totalCheckpoints: 3,
  startedAtSeconds: 0, completedAtSeconds: 4, metrics: {}, message: 'Stopped', hint: null,
}

describe('observed result coaching', () => {
  it('reports the largest measured final deviation with one concrete action', () => {
    const feedback = summarizeTrainingResult({ ...result, metrics: { altitudeErrorM: 1.3, horizontalSpeedMps: 0.2 } })
    expect(feedback.observedStrength).toContain('水平速度 0.20 m/s')
    expect(feedback.observedGap).toContain('結束時高度偏差為 1.30 m')
    expect(feedback.nextPractice).toContain('小量油門')
    expect(feedback.observedGap).not.toContain('因為')
  })

  it('does not infer flight skill from an aborted attempt or missing metrics', () => {
    const empty = summarizeTrainingResult({ ...result, sampleCount: 0, completedCheckpoints: 0 })
    expect(empty.observedStrength).toBeNull()
    expect(empty.observedGap).toContain('沒有有效')
    const missing = summarizeTrainingResult({ ...result, completedCheckpoints: 0, metrics: { altitudeErrorM: Number.NaN } })
    expect(missing.observedStrength).toBeNull()
    expect(missing.observedGap).toContain('3 個步驟未完成')
  })

  it('does not treat the initial zero touchdown speed as a completed landing observation', () => {
    const feedback = summarizeTrainingResult({ ...result, lessonId: 'landing', completedCheckpoints: 0,
      metrics: { touchdownDescentSpeedMps: 0, groundTouching: 0, contiguousDwellSeconds: 0 } })
    expect(feedback.observedStrength).toBeNull()
    expect(feedback.observedGap).toContain('接地後連續穩定時間')
  })

  it('keeps completion and mastery distinct even with all checkpoints completed', () => {
    const feedback = summarizeTrainingResult({ ...result, outcome: 'SUCCESS', completedCheckpoints: 3 })
    expect(feedback.observedStrength).toContain('3 / 3')
    expect(feedback.observedGap).toBeNull()
    expect(feedback.nextPractice).toContain('相同條件再練一次')
  })
})
