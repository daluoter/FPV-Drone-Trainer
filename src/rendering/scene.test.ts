import { describe, expect, it } from 'vitest'

import { createFlightScene } from './scene'

describe('flight scene reference contract', () => {
  it('exposes stable lesson reference IDs without coupling evaluators to Three.js names', () => {
    const scene = createFlightScene()
    try {
      expect(scene.sceneReferences.map((reference) => reference.id)).toEqual([
        'takeoff-pad',
        'marker-0',
        'marker-1',
        'marker-2',
        'marker-3',
        'gate',
      ])
      expect(scene.getReference('gate')?.kind).toBe('gate')
      expect(scene.getReference('gate')?.positionM).toEqual({ x: 0, y: 0.9, z: -5 })
      expect(scene.getReference('gate')?.sizeM).toEqual({ x: 5.12, y: 1.8, z: 0.12 })
      expect(scene.getReference('unknown')).toBeNull()
    } finally {
      scene.dispose()
    }
  })
})
