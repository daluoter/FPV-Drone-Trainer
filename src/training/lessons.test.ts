import { describe, expect, it } from 'vitest'

import { DEFAULT_LESSONS, LEARNING_LESSONS, TRAINING_LESSONS, lessonById } from './lessons'
import { lessonLearningContent } from './catalog'


describe('lesson catalog', () => {
  it('keeps existing lesson IDs and the historical hover definition stable', () => {
    expect(DEFAULT_LESSONS).toHaveLength(17)
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
      'full-roll',
      'full-flip',
      'front-flip',
      'back-flip',
      'power-loop',
    ])
    expect(DEFAULT_LESSONS.map((lesson) => lesson.title)).toEqual([
      '定點懸停',
      '協調轉彎',
      '破S',
      '正刷鍋',
      '起飛與定點懸停',
      '起飛、前往降落區與降落',
      '起飛與直線穿圈',
      '側移與方向感',
      '方形航線',
      '八字航線',
      '寬門穿越',
      '基礎失誤恢復',
      '完整橫滾',
      '前後翻轉',
      '前翻',
      '後翻',
      '大迴旋',
    ])
    expect(DEFAULT_LESSONS.every((lesson) => lesson.available && lesson.availability === 'available' && lesson.evaluator)).toBe(true)
    expect(DEFAULT_LESSONS.map((lesson) => lesson.setup.sceneReferenceIds)).toEqual([
      ['takeoff-pad', 'hover-zone'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface', 'split-zone'],
      ['takeoff-pad', 'orbit-poi'],
      ['takeoff-pad'],
      ['training-launch', 'landing-surface'],
      ['takeoff-pad', 'training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface'],
      ['training-launch', 'landing-surface', 'loop-zone'],
    ])
  })

  it('offers learning content in prerequisite order without requiring completion to select a lesson', () => {
    const ordered = [...LEARNING_LESSONS].sort((left, right) => left.priority - right.priority)
    expect(ordered.map((lesson) => lessonLearningContent(lesson.id)?.code)).toEqual(['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10', 'L11', 'L12', 'L13', 'L14', 'L15'])
    expect(lessonLearningContent('takeoff')?.prerequisiteIds).toEqual(['intro'])
    expect(lessonLearningContent('hover')?.prerequisiteIds).toEqual(['takeoff'])
    expect(lessonLearningContent('direction-control')?.prerequisiteIds).toEqual(['landing'])
    expect(lessonLearningContent('coordinated-turn')?.prerequisiteIds).toEqual(['direction-control'])
    expect(lessonLearningContent('square-route')?.prerequisiteIds).toEqual(['coordinated-turn'])
    expect(lessonLearningContent('figure-eight')?.prerequisiteIds).toEqual(['square-route'])
    expect(lessonLearningContent('wide-gate')?.prerequisiteIds).toEqual(['figure-eight'])
    expect(lessonLearningContent('basic-recovery')?.prerequisiteIds).toEqual(['wide-gate'])
    expect(lessonLearningContent('full-roll')?.prerequisiteIds).toEqual(['basic-recovery'])
    expect(lessonLearningContent('full-flip')?.prerequisiteIds).toEqual(['full-roll'])
    expect(lessonLearningContent('front-flip')?.prerequisiteIds).toEqual(['full-roll'])
    expect(lessonLearningContent('back-flip')?.prerequisiteIds).toEqual(['front-flip'])
    expect(lessonLearningContent('power-loop')?.prerequisiteIds).toEqual(['back-flip'])
    expect(lessonLearningContent('unknown')).toBeNull()
    expect(DEFAULT_LESSONS.every((lesson) => {
      const content = lessonLearningContent(lesson.id)
      return content && content.steps.length > 0 && content.commonMistakes.length > 0
    })).toBe(true)
  })

  it('merges hover into L01 navigation without changing stable lesson identities or takeoff criteria', () => {
    const ordered = [...LEARNING_LESSONS].sort((left, right) => left.priority - right.priority)
    expect(ordered.map((lesson) => lesson.id)).toEqual([
      'takeoff', 'straight-line', 'landing', 'direction-control', 'coordinated-turn',
      'square-route', 'figure-eight', 'wide-gate', 'basic-recovery', 'full-roll', 'front-flip', 'back-flip', 'power-loop', 'split-s', 'orbit',
    ])
    expect(TRAINING_LESSONS).toBe(LEARNING_LESSONS)
    expect(LEARNING_LESSONS.every((lesson) => lessonById(lesson.id) === lesson)).toBe(true)
    expect(lessonById('hover')).toBe(DEFAULT_LESSONS.find((lesson) => lesson.id === 'hover'))
    expect(LEARNING_LESSONS.some((lesson) => lesson.id === 'hover')).toBe(false)
    expect(LEARNING_LESSONS.some((lesson) => lesson.id === 'full-flip')).toBe(false)
    expect(lessonById('full-flip')).toBe(DEFAULT_LESSONS.find((lesson) => lesson.id === 'full-flip'))
    const takeoff = lessonById('takeoff')!
    expect(takeoff.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(['takeoff-ready', 'takeoff-liftoff', 'takeoff-settle'])
    expect(takeoff.checkpoints[2]?.title).toBe('定點懸停 1.5 秒')
    expect(takeoff.scoring.minimumActiveSeconds).toBe(3)
    expect(takeoff.scoring.minimumPassingScore).toBe(70)
  })

  it('starts L14 on real ground with eight stages and keeps every setup disarmed/reset-only', () => {
    const splitS = lessonById('split-s')!
    expect(splitS.setup.spawnPositionM).toBeUndefined()
    expect(splitS.setup.spawnOrientation).toEqual({ x: 0, y: 0, z: 0, w: 1 })
    expect(splitS.checkpoints.map(({ id }) => id)).toEqual([
      'split-ground', 'split-liftoff', 'split-entry', 'split-inverted', 'split-descent', 'split-reversed', 'split-upright', 'split-recovered',
    ])
    expect(DEFAULT_LESSONS.every((lesson) => lesson.setup.requiresDisarmed && lesson.setup.resetSimulation)).toBe(true)
  })
})
