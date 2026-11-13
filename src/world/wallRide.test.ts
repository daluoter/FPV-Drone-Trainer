import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, droneGroundContactRadius } from '../drone'
import { findSweptObstacleHit, validateStaticObstacles } from '../simulation/obstacles'
import { createWallRide, WALL_RIDE_COLLIDER_ID, WALL_RIDE_REFERENCE_IDS } from './wallRide'

const launch = { x: 0, y: 0.05, z: 0 }

describe('shared non-contact wall-ride geometry', () => {
  it('defines one immutable solid wall and clearance-preserving reference points', () => {
    const wall = createWallRide(launch, 0)
    expect(wall).toMatchObject({ faceXM: 10, nearZM: -12, farZM: -52, heightM: 28,
      lengthM: 40, thicknessM: 1, groundHeightM: 0, centerM: { x: 10.5, y: 14, z: -32 } })
    expect(wall.colliders).toEqual([{ id: WALL_RIDE_COLLIDER_ID,
      centerM: wall.centerM, halfExtentsM: { x: 0.5, y: 14, z: 20 } }])
    expect(WALL_RIDE_REFERENCE_IDS).toEqual(['wall-ride-entry', 'wall-ride-start', 'wall-ride-end', 'wall-ride-exit'])
    expect(validateStaticObstacles(wall.colliders)).toBe(true)
    for (const value of [wall, wall.centerM, wall.entryM, wall.rideStartM, wall.rideEndM,
      wall.exitM, wall.colliders, wall.colliders[0], wall.colliders[0].halfExtentsM]) expect(Object.isFrozen(value)).toBe(true)
  })

  it('translates all geometry with the launch and uses relative ground height', () => {
    const anchor = { x: 5, y: 80, z: -3 }
    const original = JSON.stringify(anchor)
    const wall = createWallRide(anchor, 7)
    expect(wall).toMatchObject({ faceXM: 15, nearZM: -15, farZM: -55,
      centerM: { x: 15.5, y: 21, z: -35 }, entryM: { x: 11, y: 21, z: -12 } })
    expect(wall.rideStartM.y).toBe(21)
    expect(wall.rideEndM.y).toBe(18)
    expect(wall.exitM.y).toBe(17)
    expect(JSON.stringify(anchor)).toBe(original)
  })

  it('keeps the original reference route clear for a whole-airframe swept envelope', () => {
    const wall = createWallRide(launch, 0)
    const radius = droneGroundContactRadius(DEFAULT_DRONE_CONFIG)
    const route = [launch, { ...launch, y: 14 }, wall.entryM, wall.rideStartM, wall.rideEndM, wall.exitM]
    for (let i = 1; i < route.length; i += 1) expect(findSweptObstacleHit(route[i - 1], route[i], radius, wall.colliders)).toBeNull()
    expect(wall.faceXM - wall.rideStartM.x).toBeGreaterThan(radius)
    expect(wall.faceXM - wall.exitM.x).toBeGreaterThan(wall.faceXM - wall.rideEndM.x)
  })

  it('blocks actual wall crossings from either side while leaving the region above it clear', () => {
    const wall = createWallRide(launch, 0)
    const before = { x: 7, y: 14, z: -25 }, after = { x: 14, y: 14, z: -25 }
    expect(findSweptObstacleHit(before, after, 0.3, wall.colliders)?.colliderId).toBe(WALL_RIDE_COLLIDER_ID)
    expect(findSweptObstacleHit(after, before, 0.3, wall.colliders)?.colliderId).toBe(WALL_RIDE_COLLIDER_ID)
    expect(findSweptObstacleHit({ ...before, y: 29 }, { ...after, y: 29 }, 0.3, wall.colliders)).toBeNull()
  })

  it('rejects invalid anchors without mutating valid caller data', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => createWallRide({ ...launch, x: value }, 0)).toThrow(RangeError)
      expect(() => createWallRide(launch, value)).toThrow(RangeError)
    }
  })
})
