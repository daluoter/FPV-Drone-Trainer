import { describe, expect, it } from 'vitest'

import { createDefaultDroneConfig } from '../drone'

import { createFlightScene } from './scene'

describe('flight scene reference contract', () => {
  it('shows the takeoff height guide instead of the separate hover target without changing evaluator anchors', () => {
    const scene = createFlightScene()
    try {
      const target = scene.scene.getObjectByName('takeoff-height-target')
      const hover = scene.getReference('hover-zone')
      const anchors = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
      const dronePosition = scene.drone.position.toArray()
      expect(target).toBeDefined()
      expect(target?.position.toArray()).toEqual([0, 2.5, 0])
      expect(target?.visible).toBe(false)
      expect(hover?.object.visible).toBe(true)

      scene.setLessonTarget('takeoff')
      expect(target?.visible).toBe(true)
      expect(hover?.object.visible).toBe(false)
      expect(scene.scene.getObjectByName('takeoff-height-ring')).toBeDefined()
      expect(scene.scene.getObjectByName('takeoff-height-band')).toBeDefined()
      expect(scene.getReference('takeoff-height-target')).toBeNull()
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(anchors)
      expect(scene.drone.position.toArray()).toEqual(dronePosition)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(true)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)

      scene.setLessonTarget('hover')
      expect(target?.visible).toBe(false)
      expect(hover?.object.visible).toBe(true)
      scene.setLessonTarget('takeoff')
      scene.setLessonTarget(null)
      expect(target?.visible).toBe(false)
      expect(hover?.object.visible).toBe(true)
    } finally {
      scene.dispose()
    }
  })

  it('positions the takeoff guide relative to a configured pad while leaving the config untouched', () => {
    const config = { ...createDefaultDroneConfig(), spawnPositionM: { x: 6, y: 1, z: -3 } }
    const scene = createFlightScene(config)
    try {
      scene.setLessonTarget('takeoff')
      expect(scene.scene.getObjectByName('takeoff-height-target')?.position.toArray()).toEqual([6, 3, -3])
      expect(scene.getReference('takeoff-pad')?.positionM).toEqual({ x: 6, y: 1, z: -3 })
      expect(config.spawnPositionM).toEqual({ x: 6, y: 1, z: -3 })
    } finally {
      scene.dispose()
    }
  })

  it('exposes stable lesson reference IDs without coupling evaluators to Three.js names', () => {
    const scene = createFlightScene()
    try {
      expect(scene.sceneReferences.map((reference) => reference.id)).toEqual([
        'takeoff-pad',
        'hover-zone',
        'turn-entry',
        'turn-apex',
        'turn-exit',
        'orbit-poi',
        'split-s-reference',
      ])
      expect(scene.getReference('hover-zone')?.kind).toBe('zone')
      expect(scene.getReference('hover-zone')?.positionM).toEqual({ x: 0, y: 3, z: 0 })
      expect(scene.getReference('orbit-poi')?.kind).toBe('poi')
      expect(scene.getReference('split-s-reference')?.kind).toBe('gate')
      expect(scene.getReference('split-s-reference')?.positionM).toEqual({ x: 0, y: 0.9, z: -5 })
      expect(scene.getReference('split-s-reference')?.sizeM).toEqual({ x: 5.12, y: 1.8, z: 0.12 })
      expect(scene.getReference('unknown')).toBeNull()
      scene.setTrainingPath([
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
      ])
      expect(scene.scene.getObjectByName('training-path')?.visible).toBe(true)
      scene.setTrainingPath([])
      expect(scene.scene.getObjectByName('training-path')?.visible).toBe(false)
      scene.applyGhost({
        positionM: { x: 2, y: 3, z: 4 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      })
      scene.setReplayPath([
        { x: 0, y: 1, z: 0 },
        { x: 2, y: 3, z: 4 },
      ])
      scene.setReplayVisible(true)
      expect(scene.ghost.position.toArray()).toEqual([2, 3, 4])
      expect(scene.ghost.visible).toBe(true)
      expect(scene.scene.getObjectByName('replay-path')?.visible).toBe(true)
      scene.setReplayVisible(false)
      expect(scene.ghost.visible).toBe(false)
      expect(scene.scene.getObjectByName('replay-path')?.visible).toBe(false)
    } finally {
      scene.dispose()
    }
  })
})
