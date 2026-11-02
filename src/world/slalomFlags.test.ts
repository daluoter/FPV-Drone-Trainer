import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, droneGroundContactRadius } from '../drone'
import { findSweptObstacleHit, validateStaticObstacles } from '../simulation/obstacles'
import { createSlalomFlags, slalomFlagCrossing, SLALOM_FLAG_IDS } from './slalomFlags'

const launch = { x: 0, y: 0.05, z: 0 }

describe('shared forward-only slalom flag row', () => {
  it('places six immutable solid banners on a forward row with alternating pass sides', () => {
    const flags = createSlalomFlags(launch, 0)
    expect(flags.map(({ id }) => id)).toEqual(SLALOM_FLAG_IDS)
    expect(flags.map(({ positionM }) => positionM.z)).toEqual([-16, -28, -40, -52, -64, -76])
    expect(flags.map(({ side }) => side)).toEqual(['left', 'right', 'left', 'right', 'left', 'right'])
    expect(flags.map(({ passPointM }) => passPointM.x)).toEqual([-4, 4, -4, 4, -4, 4])
    expect(flags.every((flag) => flag.positionM.y === 4 && flag.positionM.x === 0 && flag.passPointM.y === 4)).toBe(true)
    expect(validateStaticObstacles(flags.flatMap(({ colliders }) => colliders))).toBe(true)
    expect(Object.isFrozen(flags)).toBe(true)
    for (const flag of flags) {
      expect(flag.colliders).toHaveLength(1)
      expect(flag.colliders[0]).toMatchObject({ centerM: flag.positionM, halfExtentsM: { x: 0.3, y: 4, z: 0.12 } })
      expect([flag, flag.positionM, flag.passPointM, flag.colliders, flag.colliders[0], flag.colliders[0].halfExtentsM].every(Object.isFrozen)).toBe(true)
    }
  })

  it('translates the row, passage geometry and physical bounds with launch and raised ground', () => {
    const flags = createSlalomFlags({ x: 6, y: 5.05, z: -3 }, 5)
    expect(flags[0].positionM).toEqual({ x: 6, y: 9, z: -19 })
    expect(flags[0].passPointM).toEqual({ x: 2, y: 9, z: -19 })
    expect(flags.at(-1)?.passPointM).toEqual({ x: 10, y: 9, z: -79 })
    const point = flags[0].passPointM
    expect(slalomFlagCrossing({ ...point, z: point.z + 1 }, { ...point, z: point.z - 1 }, flags[0]))
      .toMatchObject({ fraction: 0.5, positionM: point, altitudeM: 4, sideOffsetM: 4, insidePassage: true })
  })

  it.each([0, 1, 2, 3, 4, 5])('measures a continuous forward crossing on the alternating side of flag %i', (index) => {
    const flag = createSlalomFlags(launch, 0)[index]
    const before = { ...flag.passPointM, x: flag.passPointM.x - 0.1, z: flag.positionM.z + 1 }
    const after = { ...flag.passPointM, x: flag.passPointM.x + 0.1, z: flag.positionM.z - 1 }
    expect(slalomFlagCrossing(before, after, flag)).toMatchObject({ fraction: 0.5,
      positionM: flag.passPointM, correctSide: true, heightValid: true, insidePassage: true })
    expect(slalomFlagCrossing(after, before, flag)).toBeNull()
    expect(slalomFlagCrossing(before, { ...before, z: before.z - 0.2 }, flag)).toBeNull()
  })

  it('rejects the wrong side, a distant bypass and crossing above or below the flag exercise', () => {
    const flag = createSlalomFlags(launch, 0)[0]
    for (const x of [4, 0, -0.5, -9]) {
      const point = { ...flag.passPointM, x }
      expect(slalomFlagCrossing({ ...point, z: point.z + 1 }, { ...point, z: point.z - 1 }, flag))
        .toMatchObject({ correctSide: false, insidePassage: false })
    }
    for (const y of [0.9, 7.1, 10]) {
      const point = { ...flag.passPointM, y }
      expect(slalomFlagCrossing({ ...point, z: point.z + 1 }, { ...point, z: point.z - 1 }, flag))
        .toMatchObject({ correctSide: true, heightValid: false, insidePassage: false })
    }
  })

  it('keeps all desired passing points clear of the full aircraft envelope while the banner is solid', () => {
    const flags = createSlalomFlags(launch, 0)
    const boxes = flags.flatMap(({ colliders }) => colliders)
    const radius = droneGroundContactRadius(DEFAULT_DRONE_CONFIG)
    for (const flag of flags) {
      const before = { ...flag.passPointM, z: flag.positionM.z + 2 }
      const after = { ...flag.passPointM, z: flag.positionM.z - 2 }
      expect(findSweptObstacleHit(before, after, radius, boxes)).toBeNull()
      expect(findSweptObstacleHit({ ...flag.positionM, z: before.z }, { ...flag.positionM, z: after.z }, radius, boxes)?.colliderId)
        .toBe(`${flag.id}-banner`)
    }
  })

  it('rejects nonfinite anchors and never produces a crossing from invalid endpoints', () => {
    expect(() => createSlalomFlags({ ...launch, x: Number.NaN }, 0)).toThrow(RangeError)
    expect(() => createSlalomFlags(launch, Number.POSITIVE_INFINITY)).toThrow(RangeError)
    const flag = createSlalomFlags(launch, 0)[0]
    expect(slalomFlagCrossing({ ...flag.passPointM, z: Number.NaN }, flag.passPointM, flag)).toBeNull()
  })
})
