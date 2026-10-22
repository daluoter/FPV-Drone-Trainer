import { describe, expect, it } from 'vitest'
import type * as THREE from 'three'

import { createDefaultDroneConfig, createInitialDroneState } from '../drone'

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
      expect(scene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(false)

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

  it('normalizes teaching spawn against raised ground and shifts visual and evaluator anchors together', () => {
    const defaults = createDefaultDroneConfig()
    const config = {
      ...defaults,
      ground: { ...defaults.ground, heightM: 5 },
      spawnPositionM: { x: 6, y: 0, z: -3 },
    }
    const initialSpawn = createInitialDroneState(config).positionM
    const scene = createFlightScene(config)
    try {
      expect(scene.getReference('takeoff-pad')?.positionM).toEqual(initialSpawn)
      expect(initialSpawn.y).toBeGreaterThan(5)
      expect(scene.scene.getObjectByName('takeoff-height-target')?.position.toArray()).toEqual([6, initialSpawn.y + 2, -3])
      expect(scene.scene.getObjectByName('straight-line-targets')?.children.map((ring) => ring.position.y))
        .toEqual([8, 8, 8, 8])
      expect(scene.getReference('hover-zone')?.positionM).toEqual({ x: 6, y: 8, z: -3 })
      expect(scene.getReference('hover-zone')?.object.position.y).toBe(8)
      for (const id of ['turn-entry', 'turn-apex', 'turn-exit']) {
        expect(scene.getReference(id)?.positionM.y).toBeCloseTo(5.45)
        expect(scene.getReference(id)?.object.position.y).toBeCloseTo(5.45)
      }
      expect(scene.getReference('orbit-poi')?.positionM.y).toBe(7.5)
      expect(scene.getReference('orbit-poi')?.object.position.y).toBe(7.5)
      const orbitCircle = scene.scene.getObjectByName('reference-orbit-circle')
      expect((orbitCircle?.parent?.position.y ?? 0) + (orbitCircle?.position.y ?? 0)).toBeCloseTo(5.02)
      expect(scene.getReference('split-s-reference')?.positionM.y).toBe(5.9)
      expect(scene.getReference('split-s-reference')?.object.position.y).toBe(5)
      expect(scene.getReference('landing-surface')?.positionM).toEqual({ x: 6, y: 5, z: -11 })
      expect(scene.getReference('training-launch')?.positionM).toEqual(createInitialDroneState(config, { x: 6, y: 5, z: -3 }).positionM)
      expect(scene.ground.position.y).toBe(5)
      expect(config.spawnPositionM).toEqual({ x: 6, y: 0, z: -3 })
      expect(config.ground.heightM).toBe(5)
    } finally {
      scene.dispose()
    }
  })

  it('shows only the selected beginner guide and restores advanced references on exit', () => {
    const scene = createFlightScene()
    const takeoff = scene.scene.getObjectByName('takeoff-height-target')
    const landing = scene.scene.getObjectByName('landing-target')
    const straight = scene.scene.getObjectByName('straight-line-targets')
    const anchors = scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM: { ...positionM } }))
    try {
      scene.setLessonTarget('landing')
      expect(landing?.visible).toBe(true)
      expect(landing?.position.toArray()).toEqual([0, 0, -8])
      expect(landing?.getObjectByName('landing-beacon')).toBeDefined()
      expect(scene.getReference('training-launch')?.positionM.z).toBe(0)
      expect(takeoff?.visible).toBe(false)
      expect(straight?.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(false)
      expect(scene.getReference('split-s-reference')?.object.visible).toBe(false)

      scene.setLessonTarget('straight-line')
      expect(straight?.visible).toBe(true)
      expect(straight?.children).toHaveLength(4)
      expect(scene.getReference('straight-stop')?.positionM).toEqual({ x: 0, y: 3, z: -8 })
      expect(scene.getReference('straight-stop')?.sizeM).toEqual({ x: 3, y: 3, z: 0.08 })
      // The displayed opening must match the passage evaluator, including a
      // vertical green finish ring instead of the former horizontal stop disk.
      for (const id of ['straight-transit', 'straight-brake', 'straight-stop']) {
        const ring = scene.scene.getObjectByName(`${id}-ring`) as THREE.Mesh<THREE.RingGeometry>
        expect(ring.geometry.parameters.innerRadius).toBe(1.5)
        expect(ring.rotation.x).toBe(0)
        expect(ring.scale.toArray()).toEqual([1, 1, 1])
      }
      const landingPaint = landing?.getObjectByName('landing-zone-paint') as THREE.Mesh<THREE.RingGeometry>
      expect(landingPaint.geometry.parameters.outerRadius).toBe(1.5)
      expect(scene.getReference('landing-surface')?.sizeM).toEqual({ x: 3, y: 0, z: 3 })
      expect(landing?.visible).toBe(false)
      expect(takeoff?.visible).toBe(false)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(false)

      scene.setLessonTarget('takeoff')
      expect(takeoff?.visible).toBe(true)
      expect(landing?.visible).toBe(false)
      expect(straight?.visible).toBe(false)

      scene.setLessonTarget(null)
      expect(takeoff?.visible).toBe(false)
      expect(landing?.visible).toBe(false)
      expect(straight?.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(true)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(true)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)
      expect(scene.getReference('split-s-reference')?.object.visible).toBe(true)
      expect(scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM }))).toEqual(anchors)
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
        'landing-surface',
        'training-launch',
        'straight-start',
        'straight-transit',
        'straight-brake',
        'straight-stop',
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
