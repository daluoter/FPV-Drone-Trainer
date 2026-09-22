import { describe, expect, it } from 'vitest'

import { DEFAULT_LESSONS } from './lessons'


describe('Phase 7 lesson catalog', () => {
  it('exposes exactly the four geometric lessons and enables only their evaluators', () => {
    expect(DEFAULT_LESSONS).toHaveLength(4)
    expect(DEFAULT_LESSONS.map((lesson) => lesson.id)).toEqual([
      'hover',
      'coordinated-turn',
      'split-s',
      'orbit',
    ])
    expect(DEFAULT_LESSONS.map((lesson) => lesson.title)).toEqual([
      'Hover',
      'Coordinated Turn',
      'Split-S',
      'Orbit / 刷鍋',
    ])
    expect(DEFAULT_LESSONS.map((lesson) => lesson.priority)).toEqual([1, 2, 3, 4])
    expect(DEFAULT_LESSONS.every((lesson) => lesson.available && lesson.availability === 'available' && lesson.evaluator)).toBe(true)
    expect(DEFAULT_LESSONS.map((lesson) => lesson.setup.sceneReferenceIds)).toEqual([
      ['takeoff-pad', 'hover-zone'],
      ['takeoff-pad', 'turn-entry', 'turn-apex', 'turn-exit'],
      ['split-s-reference'],
      ['takeoff-pad', 'orbit-poi'],
    ])
  })

  it('keeps the Split-S request elevated and every setup disarmed/reset-only', () => {
    const splitS = DEFAULT_LESSONS.find((lesson) => lesson.id === 'split-s')
    expect(splitS?.setup.spawnPositionM).toEqual({ x: 0, y: 25, z: 0 })
    expect(splitS?.setup.spawnOrientation).toEqual({ x: 0, y: 0, z: 0, w: 1 })
    expect(splitS?.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      'entry',
      'inverted',
      'descent',
      'reversed',
      'recovered',
    ])
    expect(DEFAULT_LESSONS.every((lesson) => lesson.setup.requiresDisarmed && lesson.setup.resetSimulation)).toBe(true)
  })
})
