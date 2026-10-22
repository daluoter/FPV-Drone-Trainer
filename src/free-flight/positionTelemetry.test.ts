import { describe, expect, it } from 'vitest'
import { createDefaultDroneConfig, createInitialDroneState, DRONE_GROUND_CLEARANCE_M, droneGroundSupport } from '../drone'
import { IDENTITY_QUATERNION, quaternionFromRotationVector } from '../math/quaternion'
import { createTrainingFieldAnchors } from '../training/field'
import { makePositionReadout } from './positionTelemetry'

describe('FPV position readout', () => {
  it('distinguishes body altitude from physical ground gap and uses a supported ground launch origin', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 10 }, spawnPositionM: { x: 4, y: 20, z: -7 } }
    const launch = createTrainingFieldAnchors(config).launch
    const grounded = makePositionReadout({ positionM: launch, orientation: IDENTITY_QUATERNION }, config)
    expect(grounded.altitudeAboveGroundM).toBeCloseTo(launch.y - 10)
    expect(grounded.altitudeAboveGroundM).toBeGreaterThan(0)
    expect(grounded.verticalClearanceM).toBeCloseTo(0, 12)
    expect(grounded.rightM).toBe(0)
    expect(grounded.forwardM).toBe(0)
    expect(grounded.upM).toBe(0)
    expect(grounded.zM).toBe(0)

    const airborne = makePositionReadout({ positionM: { x: 6, y: 13, z: -12 }, orientation: IDENTITY_QUATERNION }, config)
    expect(airborne.altitudeAboveGroundM).toBe(3)
    expect(airborne.rightM).toBe(2)
    expect(airborne.forwardM).toBe(5)
    expect(airborne.zM).toBe(-5)
    expect(airborne.upM).toBeCloseTo(13 - launch.y)
  })

  it('uses the rotated geometry for clearance while world coordinates stay independent of heading', () => {
    const config = createDefaultDroneConfig()
    const upright = { positionM: { x: -2, y: 3, z: 4 }, orientation: IDENTITY_QUATERNION }
    const orientation = quaternionFromRotationVector({ x: 0, y: Math.PI, z: Math.PI / 4 })
    const tilted = { ...upright, orientation }
    const a = makePositionReadout(upright, config)
    const b = makePositionReadout(tilted, config)
    expect(b.rightM).toBe(-2)
    expect(b.forwardM).toBe(-4)
    expect(b.zM).toBe(4)
    expect(b.upM).toBe(a.upM)
    expect(b.altitudeAboveGroundM).toBe(a.altitudeAboveGroundM)
    expect(b.verticalClearanceM).toBeCloseTo(3 - droneGroundSupport(config, orientation).supportOffsetM - DRONE_GROUND_CLEARANCE_M)
    expect(b.verticalClearanceM).not.toBeCloseTo(a.verticalClearanceM!, 4)
  })

  it('reads the selected pose and optional origin without retaining or mutating either', () => {
    const config = createDefaultDroneConfig()
    const state = createInitialDroneState(config, { x: 8, y: 6, z: -9 })
    const origin = { x: 3, y: 2, z: -4 }
    const before = JSON.stringify({ config, state, origin })
    const readout = makePositionReadout(state, config, origin)
    expect(readout).toMatchObject({ altitudeAboveGroundM: 6, rightM: 5, forwardM: 5, upM: 4, zM: -5 })
    expect(JSON.stringify({ config, state, origin })).toBe(before)
    expect(Object.isFrozen(readout)).toBe(true)
    const otherPose = { ...state, positionM: { x: 3, y: 2, z: -4 } }
    expect(makePositionReadout(otherPose, config, origin)).toMatchObject({ rightM: 0, forwardM: 0, upM: 0, zM: 0 })
    expect(readout.rightM).toBe(5)
  })

  it('reports unavailable values for invalid telemetry instead of showing a false zero height', () => {
    const config = createDefaultDroneConfig()
    const state = createInitialDroneState(config)
    for (const invalid of [
      null,
      { ...state, positionM: { x: Infinity, y: 3, z: 0 } },
      { ...state, orientation: { x: Number.NaN, y: 0, z: 0, w: 1 } },
      { ...state, orientation: { x: 0, y: 0, z: 0, w: 0 } },
    ]) expect(Object.values(makePositionReadout(invalid, config)).every((value) => value === null)).toBe(true)
    expect(makePositionReadout(state, config, { x: 0, y: Number.NaN, z: 0 }).altitudeAboveGroundM).toBeNull()
    expect(makePositionReadout(state, { ...config, ground: { ...config.ground, heightM: Number.NaN } }).altitudeAboveGroundM).toBeNull()
  })

  it('keeps below-ground altitude signed while clamping the physical gap at zero', () => {
    const config = createDefaultDroneConfig()
    const readout = makePositionReadout({ positionM: { x: 0, y: -1, z: 0 }, orientation: IDENTITY_QUATERNION }, config)
    expect(readout.altitudeAboveGroundM).toBe(-1)
    expect(readout.upM).toBeLessThan(-1)
    expect(readout.verticalClearanceM).toBe(0)
  })
})
