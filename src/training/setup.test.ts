import { describe, expect, it } from 'vitest'
import { DEFAULT_LESSONS } from './lessons'
import { prepareTrainingSetup } from './setup'
import type { TrainingSetupRequest } from './types'

function requestFor(lessonId: string): TrainingSetupRequest {
  return { lessonId, sessionId: 'setup-test', setup: DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId)!.setup }
}

describe('reference-relative training setup', () => {
  it('uses the actual normalized pad for airborne landing and straight-line starts', () => {
    const references = [{ id: 'takeoff-pad', kind: 'pad', positionM: { x: 6, y: 5.05, z: -3 } }]
    for (const lessonId of ['landing', 'straight-line']) {
      const original = requestFor(lessonId)
      expect(prepareTrainingSetup(original, references)?.setup.spawnPositionM).toEqual({ x: 6, y: 7.55, z: -3 })
      expect(original.setup.spawnPositionM).toEqual({ x: 0, y: 3, z: 0 })
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
