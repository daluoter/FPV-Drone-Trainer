import { describe, expect, it } from 'vitest'

import { createFlightScene } from './scene'

describe('flight scene reference contract', () => {
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
    } finally {
      scene.dispose()
    }
  })
})
