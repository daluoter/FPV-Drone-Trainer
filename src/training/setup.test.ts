import { describe, expect, it } from 'vitest'
import { DEFAULT_LESSONS } from './lessons'
import { prepareTrainingSetup } from './setup'
import type { TrainingSetupRequest } from './types'

function requestFor(lessonId: string): TrainingSetupRequest {
  return { lessonId, sessionId: 'setup-test', setup: DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId)!.setup }
}

describe('reference-relative training setup', () => {
  it('starts ground-based lessons on supported ground independently of the elevated teaching pad', () => {
    const references = [
      { id: 'takeoff-pad', kind: 'pad', positionM: { x: 6, y: 5.5, z: -3 } },
      { id: 'training-launch', kind: 'pad', positionM: { x: 6, y: 5.05, z: -3 } },
    ]
    for (const lessonId of ['landing', 'straight-line', 'direction-control', 'coordinated-turn', 'square-route']) {
      const original = requestFor(lessonId)
      const before = JSON.stringify(original)
      expect(prepareTrainingSetup(original, references)?.setup.spawnPositionM).toEqual({ x: 6, y: 5.05, z: -3 })
      expect(JSON.stringify(original)).toBe(before)
    }
  })

  it('preserves Split-S recovery clearance above a raised configured ground', () => {
    expect(prepareTrainingSetup(requestFor('split-s'), [
      { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: 30, z: 0 } },
    ])?.setup.spawnPositionM).toEqual({ x: 0, y: 55, z: 0 })
  })

  it('leaves default reset requests alone and waits for missing references', () => {
    const hover = requestFor('hover')
    expect(prepareTrainingSetup(hover, [])).toBe(hover)
    const landing = requestFor('landing')
    expect(prepareTrainingSetup(landing, [])).toBe(landing)
    expect(prepareTrainingSetup(null, [])).toBeNull()
  })
})
