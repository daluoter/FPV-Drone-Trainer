import { describe, expect, it } from 'vitest'
import { droneGroundContactRadius, DEFAULT_DRONE_CONFIG } from '../drone'
import {
  copyStaticObstacles,
  findSweptObstacleHit,
  MAX_STATIC_OBSTACLES,
  validateStaticObstacles,
  type StaticBoxCollider,
} from './obstacles'

const UNIT_BOX: StaticBoxCollider = {
  id: 'frame', centerM: { x: 0, y: 0, z: 0 }, halfExtentsM: { x: 1, y: 1, z: 1 },
}

const GATE: readonly StaticBoxCollider[] = [
  { id: 'left', centerM: { x: -2.11, y: 3, z: -8 }, halfExtentsM: { x: 0.11, y: 2.22, z: 0.175 } },
  { id: 'right', centerM: { x: 2.11, y: 3, z: -8 }, halfExtentsM: { x: 0.11, y: 2.22, z: 0.175 } },
  { id: 'top', centerM: { x: 0, y: 5.11, z: -8 }, halfExtentsM: { x: 2, y: 0.11, z: 0.175 } },
  { id: 'bottom', centerM: { x: 0, y: 0.89, z: -8 }, halfExtentsM: { x: 2, y: 0.11, z: 0.175 } },
]

describe('static obstacle validation', () => {
  it('accepts empty and bounded finite fields, including the maximum number of boxes', () => {
    expect(validateStaticObstacles([])).toBe(true)
    expect(validateStaticObstacles(GATE)).toBe(true)
    expect(validateStaticObstacles(Array.from({ length: MAX_STATIC_OBSTACLES }, (_, index) => ({ ...UNIT_BOX, id: String(index) })))).toBe(true)
  })

  it.each([
    null,
    {},
    [null],
    new Array(1),
    [{ ...UNIT_BOX, id: ' ' }],
    [UNIT_BOX, UNIT_BOX],
    [{ ...UNIT_BOX, centerM: null }],
    [{ ...UNIT_BOX, centerM: { x: 0, y: Infinity, z: 0 } }],
    [{ ...UNIT_BOX, halfExtentsM: { x: 0, y: 1, z: 1 } }],
    [{ ...UNIT_BOX, halfExtentsM: { x: 1, y: -1, z: 1 } }],
    [{ ...UNIT_BOX, halfExtentsM: { x: 1, y: 1, z: NaN } }],
    [{ ...UNIT_BOX, centerM: { x: Number.MAX_VALUE, y: 0, z: 0 }, halfExtentsM: { x: Number.MAX_VALUE, y: 1, z: 1 } }],
    Array.from({ length: MAX_STATIC_OBSTACLES + 1 }, (_, index) => ({ ...UNIT_BOX, id: String(index) })),
  ].map((invalid) => ({ invalid })))('rejects malformed or unbounded geometry %#', ({ invalid }) => {
    expect(validateStaticObstacles(invalid as unknown as readonly StaticBoxCollider[])).toBe(false)
    expect(() => copyStaticObstacles(invalid as unknown as readonly StaticBoxCollider[])).toThrow(RangeError)
  })

  it('makes a deep immutable snapshot of caller-owned geometry', () => {
    const original = [{ id: 'frame', centerM: { x: 1, y: 2, z: 3 }, halfExtentsM: { x: 1, y: 1, z: 1 } }]
    const snapshot = copyStaticObstacles(original)
    original[0].centerM.x = 99
    original[0].halfExtentsM.y = 99
    original.push({ ...original[0], id: 'extra' })
    expect(snapshot).toEqual([{ id: 'frame', centerM: { x: 1, y: 2, z: 3 }, halfExtentsM: { x: 1, y: 1, z: 1 } }])
    expect([snapshot, snapshot[0], snapshot[0].centerM, snapshot[0].halfExtentsM].every(Object.isFrozen)).toBe(true)
  })
})

describe('continuous conservative obstacle sweep', () => {
  const radius = droneGroundContactRadius(DEFAULT_DRONE_CONFIG)

  it('keeps an assembled four-box gate opening clear', () => {
    expect(findSweptObstacleHit({ x: 0, y: 3, z: 0 }, { x: 0, y: 3, z: -16 }, radius, GATE)).toBeNull()
  })

  it.each(GATE)('detects the $id frame even when both endpoints are outside the thin gate', (box) => {
    const hit = findSweptObstacleHit({ ...box.centerM, z: 0 }, { ...box.centerM, z: -16 }, radius, GATE)
    expect(hit?.colliderId).toBe(box.id)
    expect(hit?.fraction).toBeCloseTo((8 - 0.175 - radius) / 16, 12)
    expect(hit?.positionM.z).toBeCloseTo(-8 + 0.175 + radius, 12)
  })

  it('detects crossing in reverse as well as forward', () => {
    const left = GATE[0]
    const hit = findSweptObstacleHit({ ...left.centerM, z: -16 }, { ...left.centerM, z: 0 }, radius, GATE)
    expect(hit?.colliderId).toBe('left')
    expect(hit?.fraction).toBeCloseTo((8 - 0.175 - radius) / 16, 12)
    expect(hit?.positionM.z).toBeCloseTo(-8 - 0.175 - radius, 12)
  })

  it('returns the earliest collider rather than the first collider in the array', () => {
    const far = { ...UNIT_BOX, id: 'far', centerM: { x: 0, y: 0, z: -8 } }
    const near = { ...UNIT_BOX, id: 'near', centerM: { x: 0, y: 0, z: -4 } }
    expect(findSweptObstacleHit({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -12 }, 0, [far, near])).toEqual({
      colliderId: 'near', fraction: 0.25, positionM: { x: 0, y: 0, z: -3 },
    })
    expect(findSweptObstacleHit({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -12 }, 0, [near, { ...near, id: 'tie' }])?.colliderId).toBe('near')
  })

  it('counts endpoint contact, parallel edge contact, and tangent corner contact', () => {
    expect(findSweptObstacleHit({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 1 }, 0, [UNIT_BOX])?.fraction).toBe(1)
    expect(findSweptObstacleHit({ x: 1, y: 0, z: 3 }, { x: 1, y: 0, z: -3 }, 0, [UNIT_BOX])?.fraction).toBeCloseTo(1 / 3)
    expect(findSweptObstacleHit({ x: 2, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, 0, [UNIT_BOX])?.fraction).toBe(0.5)
    expect(findSweptObstacleHit({ x: 1.001, y: 0, z: 3 }, { x: 1.001, y: 0, z: -3 }, 0, [UNIT_BOX])).toBeNull()
  })

  it('handles initial overlap and stationary queries without dividing by zero', () => {
    expect(findSweptObstacleHit({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 0, [UNIT_BOX])?.fraction).toBe(0)
    expect(findSweptObstacleHit({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, 0, [UNIT_BOX])?.fraction).toBe(0)
    expect(findSweptObstacleHit({ x: 2, y: 2, z: 2 }, { x: 2, y: 2, z: 2 }, 0, [UNIT_BOX])).toBeNull()
  })

  it('uses conservative expanded corners for the all-orientation envelope', () => {
    // The enclosing AABB deliberately includes a corner beyond an exact sphere.
    const point = { x: 1.4, y: 1.4, z: 1.4 }
    expect(findSweptObstacleHit(point, point, 0, [UNIT_BOX])).toBeNull()
    expect(findSweptObstacleHit(point, point, 0.5, [UNIT_BOX])?.fraction).toBe(0)
  })

  it('rejects invalid queries without inventing a collision', () => {
    const point = { x: 0, y: 0, z: 0 }
    for (const invalidRadius of [-1, NaN, Infinity]) {
      expect(findSweptObstacleHit(point, point, invalidRadius, [UNIT_BOX])).toBeNull()
    }
    expect(findSweptObstacleHit({ ...point, x: NaN }, point, 0, [UNIT_BOX])).toBeNull()
    expect(findSweptObstacleHit(point, { ...point, z: Infinity }, 0, [UNIT_BOX])).toBeNull()
    expect(findSweptObstacleHit(point, point, 0, [UNIT_BOX, UNIT_BOX])).toBeNull()
    expect(findSweptObstacleHit(point, point, 0, [])).toBeNull()
    expect(findSweptObstacleHit({ ...point, x: -Number.MAX_VALUE }, { ...point, x: Number.MAX_VALUE }, 0, [UNIT_BOX])).toBeNull()
  })
})
