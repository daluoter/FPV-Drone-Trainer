import { describe, expect, it } from 'vitest'

import { DEFAULT_LESSONS } from './lessons'

describe('phase 6 lesson catalog', () => {
  it('keeps all four prioritized lessons visibly unavailable until evaluators land', () => {
    expect(DEFAULT_LESSONS).toHaveLength(4)
    expect(DEFAULT_LESSONS.map((lesson) => lesson.priority)).toEqual([1, 2, 3, 4])
    expect(DEFAULT_LESSONS.every((lesson) => lesson.available === false && lesson.evaluator === null)).toBe(true)
    expect(DEFAULT_LESSONS.every((lesson) => lesson.availability === 'coming-soon')).toBe(true)
  })
})
