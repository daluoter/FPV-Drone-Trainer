import { describe, expect, it } from 'vitest'
import { wallRideCollisionCause, wallRideInterruptionReason, wallRideObjective, wallRideResultFeedback, wallRideRouteGuide, wallRideTrainingHint } from './wallRideFeedback'
import type { TrainingResult } from './types'

const proof = { wallRidePhase: 8, wallRideEpisodeValid: 1, wallRideApproached: 1, wallRideForwardEntered: 1,
  wallRideBellyFaced: 1, wallRideRideComplete: 1, wallRideLeft: 1, wallRideRecovered: 1,
  wallRideDistanceM: 6.5, wallRideSeconds: 0.7, wallRideRecoveryQualifying: 1, wallRideRecoveryDwellSeconds: 0.2 }
const scope = '本次為新手預設、USB 遙控器與引導練習的獨立紀錄。'
function result(overrides: Partial<TrainingResult> = {}): TrainingResult {
  return { lessonId: 'wall-ride', sessionId: 'wall-ride:feedback', outcome: 'FAILED', score: 0,
    elapsedSeconds: 20, sampleCount: 4800, completedCheckpoints: 4, totalCheckpoints: 8,
    startedAtSeconds: 0, completedAtSeconds: 20, metrics: {}, message: '', hint: null, ...overrides }
}

describe('L20 non-contact wall ride guidance', () => {
  it('describes a visible non-contact route, actual along-wall travel and permissive recovery', () => {
    const guide = wallRideRouteGuide()
    expect(guide).toMatch(/地面自行起飛至約 14 m.*機腹朝向牆面.*至少 6 m.*0.3 秒.*離牆/)
    expect(guide).toContain('0.8～5 m、離地 3～24 m')
    expect(guide).toContain('牆體有實際碰撞，應保留間隙')
    expect(guide).toContain('不要求固定側立 90°、精準速度、停住或降落')
    expect(guide).toContain('引導練習不限時')
    expect(guide).toContain('向外增加間隙')
  })

  it('shows the frozen first cause instead of a subsequently corrected gap or posture', () => {
    const close = wallRideObjective({ wallRidePhase: 4, wallRideInterrupted: 1, wallRideInterruptionReason: 5,
      interruptionWallRideGapM: 0.4, wallRideGapM: 4.2 })
    expect(close.title).toContain('本段已中斷')
    expect(close.detail).toContain('當時距牆 0.4 m')
    expect(close.detail).not.toContain('4.2 m')
    expect(close.detail).toContain('新的連續一段')
    const posture = wallRideInterruptionReason({ wallRideInterrupted: 1, wallRideInterruptionReason: 8,
      interruptionWallRideBellyAngleDegrees: 72, interruptionWallRideDistanceM: 3.4,
      interruptionWallRideSeconds: 0.5, wallRideBellyAngleDegrees: 12 })!
    expect(posture).toContain('72.0°')
    expect(posture).toContain('3.4 m')
    expect(posture).toContain('0.5 s')
    expect(posture).not.toContain('12.0°')
  })

  it('requires real fresh route, distance, duration, departure and recovery evidence before reporting success', () => {
    const success = result({ outcome: 'SUCCESS', score: 100, completedCheckpoints: 8, metrics: proof })
    expect(wallRideResultFeedback(success, scope)).toMatchObject({ observedGap: null, scopeNote: scope })
    expect(wallRideObjective(proof).title).toContain('恢復完成')
    const incomplete: Readonly<Record<string, number>>[] = [
      { wallRideEpisodeValid: 0 }, { wallRideInterrupted: 1 }, { wallRideDistanceM: 5.9 },
      { wallRideSeconds: 0.2 }, { wallRideLeft: 0 }, { wallRideRecoveryDwellSeconds: 0.1 },
      { wallRideDistanceM: Number.POSITIVE_INFINITY },
    ]
    for (const patch of incomplete) {
      const feedback = wallRideResultFeedback({ ...success, metrics: { ...proof, ...patch } }, scope)!
      expect(feedback.observedStrength).toBeNull()
      expect(feedback.observedGap).toContain('證據')
      expect(feedback.scopeNote).toBe(scope)
    }
    expect(wallRideResultFeedback({ ...success, completedCheckpoints: 7 }, scope)?.observedGap).not.toBeNull()
    expect(wallRideResultFeedback({ ...success, sampleCount: 0 }, scope)?.observedStrength).toBeNull()
  })

  it('identifies the physical wall collision without mistaking other colliders for it', () => {
    const message = '騎牆停止：已碰撞。Obstacle collision: wall-ride-wall; reset required.'
    expect(wallRideCollisionCause(message)).toBe('騎牆練習牆面')
    expect(wallRideCollisionCause('Obstacle collision: wall-ride-wall-decoration')).toBeNull()
    expect(wallRideCollisionCause('Obstacle collision: slalom-flag-1-banner')).toBeNull()
    const hint = wallRideTrainingHint({ status: 'failure', message })
    expect(hint).toContain('碰到騎牆練習牆面')
    expect(hint).toContain('碰牆不能算完成')
    expect(hint).toContain('從地面自行起飛')
    expect(wallRideResultFeedback(result({ message }), scope)?.observedGap).toContain('碰到騎牆練習牆面')
  })

  it('distinguishes along-wall progress, outward departure and recovery without a stop requirement', () => {
    const riding = wallRideObjective({ wallRidePhase: 5, wallRideDistanceM: 4.7, wallRideSeconds: 0.8, wallRideGapM: 2.4 })
    expect(riding.detail).toContain('4.7 m／6 m')
    expect(riding.detail).toContain('0.8 s／0.3 s')
    expect(riding.detail).toContain('2.4 m')
    expect(wallRideObjective({ wallRidePhase: 6, wallRideGapM: 4.8 }).title).toContain('向外離牆')
    const recovery = wallRideObjective({ wallRidePhase: 7 })
    expect(recovery.title).toContain('恢復正飛')
    expect(recovery.detail).toContain('不要求懸停或降落')
    expect(wallRideObjective({ wallRidePhase: 8 }).title).toContain('證據不足')
  })

  it('preserves result scope and explains unavailable observations and terminal boundaries honestly', () => {
    expect(wallRideResultFeedback(result({ lessonId: 'slalom' }), scope)).toBeNull()
    expect(wallRideObjective({ wallRidePhase: 4 }).detail).toContain('尚無有效量測')
    expect(wallRideObjective({ wallRidePhase: 4 }).detail).not.toMatch(/NaN|Infinity/)
    expect(wallRideTrainingHint({ status: 'failure', message: '騎牆停止：已上鎖或失去焦點。' })).toContain('失去焦點')
    expect(wallRideTrainingHint({ status: 'failure', message: '騎牆挑戰逾時。' })).toContain('能力挑戰逾時')
    expect(wallRideTrainingHint({ status: 'failure', message: '時間倒退，飛行資料中斷。' })).toContain('資料無效')
    expect(wallRideInterruptionReason({ wallRideInterrupted: 0, wallRideInterruptionReason: 5 })).toBeNull()
  })
})
