import { describe, expect, it } from 'vitest'

import { DEFAULT_LESSONS } from './lessons'
import { lessonLearningContent } from './catalog'


describe('lesson catalog', () => {
  it('keeps existing lesson IDs stable and adds L10 after the approved beginner lessons', () => {
    expect(DEFAULT_LESSONS).toHaveLength(12)
    expect(DEFAULT_LESSONS.map((lesson) => lesson.id)).toEqual([
      'hover',
      'coordinated-turn',
      'split-s',
      'orbit',
      'takeoff',
      'landing',
      'straight-line',
      'direction-control',
      'square-route',
      'figure-eight',
      'wide-gate',
      'basic-recovery',
    ])
    expect(DEFAULT_LESSONS.map((lesson) => lesson.title)).toEqual([
      'Hover',
      '協調轉彎',
      'Split-S',
      'Orbit / 刷鍋',
      '穩定起飛',
      '起飛、前往降落區與降落',
      'Straight Line Through Rings',
      '側移與方向感',
      '方形航線',
      '八字航線',
      '寬門穿越',
      '基礎失誤恢復',
    ])
    expect(DEFAULT_LESSONS.every((lesson) => lesson.available && lesson.availability === 'available' && lesson.evaluator)).toBe(true)
    expect(DEFAULT_LESSONS.map((lesson) => lesson.setup.sceneReferenceIds)).toEqual([
      ['takeoff-pad', 'hover-zone'],
      ['training-launch', 'landing-surface'],
      ['split-s-reference'],
      ['takeoff-pad', 'orbit-poi'],
      ['takeoff-pad'],
      ['training-launch', 'landing-surface'],
      ['takeoff-pad', 'training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
    ])
  })

  it('offers learning content in prerequisite order without requiring completion to select a lesson', () => {
    const ordered = [...DEFAULT_LESSONS].sort((left, right) => left.priority - right.priority)
    expect(ordered.map((lesson) => lessonLearningContent(lesson.id)?.code)).toEqual(['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10', 'L13', 'L14'])
    expect(lessonLearningContent('takeoff')?.prerequisiteIds).toEqual(['intro'])
    expect(lessonLearningContent('hover')?.prerequisiteIds).toEqual(['takeoff'])
    expect(lessonLearningContent('direction-control')?.prerequisiteIds).toEqual(['landing'])
    expect(lessonLearningContent('coordinated-turn')?.prerequisiteIds).toEqual(['direction-control'])
    expect(lessonLearningContent('square-route')?.prerequisiteIds).toEqual(['coordinated-turn'])
    expect(lessonLearningContent('figure-eight')?.prerequisiteIds).toEqual(['square-route'])
    expect(lessonLearningContent('wide-gate')?.prerequisiteIds).toEqual(['figure-eight'])
    expect(lessonLearningContent('basic-recovery')?.prerequisiteIds).toEqual(['wide-gate'])
    expect(lessonLearningContent('unknown')).toBeNull()
    expect(DEFAULT_LESSONS.every((lesson) => {
      const content = lessonLearningContent(lesson.id)
      return content && content.steps.length > 0 && content.commonMistakes.length > 0
    })).toBe(true)
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
