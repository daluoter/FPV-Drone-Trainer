import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, droneGroundContactRadius } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { findSweptObstacleHit, validateStaticObstacles } from '../simulation/obstacles'
import { createGravityGate, gravityGateExitCrossing, gravityGateLowerCrossing, gravityGateTopCrossing, GRAVITY_GATE_FRAME_THICKNESS_M } from './gravityGate'

const launch = { x: 0, y: 0.05, z: 0 }

describe('shared gravity gate field', () => {
  it('provides one immutable, two-level 16-beam field with a horizontal top and a low return-side opening', () => {
    const gate = createGravityGate(launch, 0)
    expect(gate.centerM).toEqual({ x: 0, y: 9, z: -28 })
    expect(gate.topEntryCenterM).toEqual({ x: 0, y: 14, z: -28 })
    expect(gate.sideExitCenterM).toEqual({ x: 4, y: 6.43, z: -28 })
    expect([gate.minX, gate.maxX, gate.minZ, gate.maxZ, gate.bottomY, gate.middleY, gate.topY]).toEqual([-4, 4, -32, -24, 4, 9, 14])
    expect([gate.lowerExitMinY, gate.lowerExitMaxY]).toEqual([4, 8.86])
    expect(gate.approachPointM).toEqual({ x: 14, y: 8, z: -28 })
    expect(gate.approachDirection).toEqual({ x: -1, y: 0, z: 0 })
    expect(gate.exitDirection).toEqual({ x: 1, y: 0, z: 0 })
    expect(gate.exitX).toBe(gate.maxX)
    expect(gate.colliders).toHaveLength(16)
    expect(validateStaticObstacles(gate.colliders)).toBe(true)
    expect([gate, gate.centerM, gate.topEntryCenterM, gate.sideExitCenterM, gate.approachPointM, gate.approachDirection, gate.exitDirection, gate.colliders,
      ...gate.colliders.flatMap((box) => [box, box.centerM, box.halfExtentsM])].every(Object.isFrozen)).toBe(true)
    for (const box of gate.colliders) {
      const bounds = { x: [gate.minX, gate.maxX], y: [gate.bottomY, gate.topY], z: [gate.minZ, gate.maxZ] }
      const interiorOverlap = (['x', 'y', 'z'] as const).map((axis) => Math.min(box.centerM[axis] + box.halfExtentsM[axis], bounds[axis][1])
        - Math.max(box.centerM[axis] - box.halfExtentsM[axis], bounds[axis][0]))
      // The middle ring is solid only at the perimeter, leaving both interior levels open.
      expect(interiorOverlap.some((overlap) => overlap < 1e-9)).toBe(true)
      if (box.id.endsWith('-post')) expect(box.centerM.y - box.halfExtentsM.y).toBeCloseTo(0)
      expect(Object.values(box.halfExtentsM).filter((extent) => Math.abs(extent * 2 - GRAVITY_GATE_FRAME_THICKNESS_M) < 1e-9).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('translates every physical and scoring anchor with the supported launch and ground height', () => {
    const original = createGravityGate(launch, 0)
    const shifted = createGravityGate({ x: 6, y: 5.05, z: -3 }, 5)
    expect(shifted.centerM).toEqual({ x: 6, y: 14, z: -31 })
    expect(shifted.topEntryCenterM).toEqual({ x: 6, y: 19, z: -31 })
    expect(shifted.sideExitCenterM).toEqual({ x: 10, y: 11.43, z: -31 })
    expect(shifted.approachPointM).toEqual({ x: 20, y: 13, z: -31 })
    expect(shifted.lowerExitMaxY).toBeCloseTo(original.lowerExitMaxY + 5)
    for (const [index, box] of shifted.colliders.entries()) {
      const before = original.colliders[index]
      expect(box.id).toBe(before.id)
      expect(box.halfExtentsM).toEqual(before.halfExtentsM)
      expect(box.centerM.x).toBeCloseTo(before.centerM.x + 6)
      expect(box.centerM.y).toBeCloseTo(before.centerM.y + 5)
      expect(box.centerM.z).toBeCloseTo(before.centerM.z - 3)
    }
    expect(launch).toEqual({ x: 0, y: 0.05, z: 0 })
  })

  it('keeps the intended top entry and side exit open for the actual all-attitude body envelope', () => {
    const gate = createGravityGate(launch, 0)
    const radius = droneGroundContactRadius(DEFAULT_DRONE_CONFIG)
    const above = { ...gate.topEntryCenterM, y: gate.topY + 4 }
    const inside = { ...gate.sideExitCenterM, x: gate.centerM.x }
    const outside = { ...gate.sideExitCenterM, x: gate.exitX + 4 }
    expect(findSweptObstacleHit(above, inside, radius, gate.colliders)).toBeNull()
    expect(findSweptObstacleHit(inside, outside, radius, gate.colliders)).toBeNull()
    expect(gravityGateTopCrossing(above, inside, gate, radius)?.insideOpening).toBe(true)
    expect(gravityGateLowerCrossing(above, inside, gate, radius)?.insideOpening).toBe(true)
    expect(gravityGateExitCrossing(inside, outside, gate, radius)?.insideOpening).toBe(true)
  })

  it('detects crossing each thin physical beam even with both sampled endpoints outside it', () => {
    const gate = createGravityGate(launch, 0)
    const radius = droneGroundContactRadius(DEFAULT_DRONE_CONFIG)
    for (const box of gate.colliders) {
      const axis = (['x', 'y', 'z'] as const).find((candidate) => Math.abs(box.halfExtentsM[candidate] * 2 - GRAVITY_GATE_FRAME_THICKNESS_M) < 1e-9)!
      const before = { ...box.centerM, [axis]: box.centerM[axis] - 2 }
      const after = { ...box.centerM, [axis]: box.centerM[axis] + 2 }
      const hit = findSweptObstacleHit(before, after, radius, gate.colliders)
      expect(hit?.colliderId).toBe(box.id)
      expect(hit?.fraction).toBeGreaterThan(0)
      expect(hit?.fraction).toBeLessThan(1)
    }
  })

  it('uses the real controller and solver to admit a central fall but latch a top-beam collision until reset', () => {
    const gate = createGravityGate(launch, 0)
    const input = { roll: 0, pitch: 0, yaw: 0, throttle: 0 }
    const simulation = new FlightSimulation()
    simulation.resetForTraining({ ...gate.topEntryCenterM, y: gate.topY + 4 }, undefined, gate.colliders)
    simulation.arm()
    for (let step = 0; step < 720 && simulation.getState().positionM.y > gate.lowerExitMaxY - 2 && !simulation.getState().crashed; step += 1) simulation.step(input)
    expect(simulation.getState().positionM.y).toBeLessThan(gate.lowerExitMaxY)
    expect(simulation.getState().crashed).toBe(false)
    const beam = gate.colliders.find((box) => box.id === 'gravity-gate-top-near-bar')!
    simulation.resetForTraining({ ...beam.centerM, y: gate.topY + 4 }, undefined, gate.colliders)
    simulation.arm()
    for (let step = 0; step < 720 && !simulation.getState().crashed; step += 1) simulation.step(input)
    expect(simulation.getState().crashed).toBe(true)
    expect(simulation.isArmed()).toBe(false)
    expect(simulation.getState().warnings).toContain('Obstacle collision: gravity-gate-top-near-bar; reset required.')
    expect(simulation.getState().positionM.y).toBeGreaterThan(gate.topY)
    simulation.arm()
    expect(simulation.isArmed()).toBe(false)
    simulation.reset()
    expect(simulation.getStaticObstacles()).toEqual([])
    expect(simulation.getState().crashed).toBe(false)
  })

  it('keeps the middle perimeter physically solid while its central descent stays open', () => {
    const gate = createGravityGate(launch, 0)
    const beam = gate.colliders.find((box) => box.id === 'gravity-gate-middle-right-bar')!
    const simulation = new FlightSimulation()
    simulation.resetForTraining({ ...beam.centerM, y: gate.middleY + 3 }, undefined, gate.colliders)
    simulation.arm()
    for (let step = 0; step < 720 && !simulation.getState().crashed; step += 1) {
      simulation.step({ roll: 0, pitch: 0, yaw: 0, throttle: 0 })
    }
    expect(simulation.getState().crashed).toBe(true)
    expect(simulation.isArmed()).toBe(false)
    expect(simulation.getState().warnings).toContain('Obstacle collision: gravity-gate-middle-right-bar; reset required.')
    expect(simulation.getState().positionM.y).toBeGreaterThan(gate.middleY)
  })

  it('refuses non-finite anchors rather than installing an invalid physics field', () => {
    expect(() => createGravityGate({ ...launch, x: NaN }, 0)).toThrow(RangeError)
    expect(() => createGravityGate(launch, Infinity)).toThrow(RangeError)
  })
})

describe('gravity gate continuous opening crossings', () => {
  const gate = createGravityGate(launch, 0)

  it('interpolates the horizontal top passage while rejecting ascending or merely nearby samples', () => {
    const passage = gravityGateTopCrossing({ x: -2, y: 16, z: -26 }, { x: 2, y: 12, z: -30 }, gate, 0.25)
    expect(passage).toEqual({ fraction: 0.5, positionM: { x: 0, y: 14, z: -28 }, insideOpening: true })
    expect(gravityGateTopCrossing({ x: 0, y: 13, z: -28 }, { x: 0, y: 15, z: -28 }, gate)).toBeNull()
    expect(gravityGateTopCrossing({ x: 0, y: 15, z: -28 }, { x: 0, y: 14.1, z: -28 }, gate)).toBeNull()
    expect(gravityGateTopCrossing({ x: 0, y: 14, z: -28 }, { x: 1, y: 14, z: -28 }, gate)).toBeNull()
  })

  it('observes real downward entry into the lower level through the open middle ring', () => {
    const before = { x: -2, y: gate.lowerExitMaxY + 2, z: -26 }
    const current = { x: 2, y: gate.lowerExitMaxY - 2, z: -30 }
    expect(gravityGateLowerCrossing(before, current, gate, 0.25)).toEqual({ fraction: 0.5,
      positionM: { x: 0, y: gate.lowerExitMaxY, z: -28 }, insideOpening: true })
    expect(gravityGateLowerCrossing(current, before, gate)).toBeNull()
    expect(gravityGateLowerCrossing({ ...before, x: gate.maxX - 0.1 }, { ...current, x: gate.maxX - 0.1 }, gate, 0.25)?.insideOpening).toBe(false)
    expect(gravityGateLowerCrossing(before, { ...current, y: gate.lowerExitMaxY + 0.1 }, gate)).toBeNull()
  })

  it('requires outward positive-X travel through the low approach-side opening', () => {
    expect(gravityGateExitCrossing({ x: 2, y: 7, z: -26 }, { x: 6, y: 5, z: -30 }, gate, 0.25))
      .toEqual({ fraction: 0.5, positionM: { x: 4, y: 6, z: -28 }, insideOpening: true })
    expect(gravityGateExitCrossing({ x: 6, y: 6, z: -28 }, { x: 2, y: 6, z: -28 }, gate)).toBeNull()
    expect(gravityGateExitCrossing({ x: 2, y: 6, z: -28 }, { x: 3.9, y: 6, z: -28 }, gate)).toBeNull()
    expect(gravityGateExitCrossing({ x: 0, y: 6, z: -30 }, { x: 0, y: 6, z: -34 }, gate)).toBeNull()
    // The upper side remains visibly and physically open, but is not the low return exit.
    expect(gravityGateExitCrossing({ x: 2, y: 12, z: -28 }, { x: 6, y: 12, z: -28 }, gate)?.insideOpening).toBe(false)
    expect(findSweptObstacleHit({ x: 2, y: 12, z: -28 }, { x: 6, y: 12, z: -28 }, 0.25, gate.colliders)).toBeNull()
  })

  it('keeps the conservative body clear of top, middle and lower perimeter beams', () => {
    for (const x of [gate.minX - 0.1, gate.minX + 0.1, gate.maxX - 0.1, gate.maxX + 0.1]) {
      const before = { x, y: 16, z: -28 }
      const current = { x, y: 12, z: -28 }
      expect(gravityGateTopCrossing(before, current, gate, 0.25)?.insideOpening).toBe(false)
      expect(findSweptObstacleHit(before, current, 0.25, gate.colliders)).not.toBeNull()
    }
    for (const y of [gate.lowerExitMinY + 0.1, gate.lowerExitMaxY - 0.1]) {
      const before = { x: 2, y, z: -28 }
      const current = { x: 6, y, z: -28 }
      expect(gravityGateExitCrossing(before, current, gate, 0.25)?.insideOpening).toBe(false)
      expect(findSweptObstacleHit(before, current, 0.25, gate.colliders)).not.toBeNull()
    }
    const closeToMiddle = { x: gate.maxX - 0.1, y: 11, z: gate.centerM.z }
    const belowMiddle = { ...closeToMiddle, y: 7 }
    expect(findSweptObstacleHit(closeToMiddle, belowMiddle, 0.25, gate.colliders)).not.toBeNull()
    expect(gravityGateTopCrossing({ x: -3.6, y: 16, z: -28 }, { x: -3.6, y: 12, z: -28 }, gate, 0.25)?.insideOpening).toBe(true)
  })

  it('rejects non-finite segments or invalid body radii without inventing a passage', () => {
    const above = { x: 0, y: 16, z: -28 }
    const below = { x: 0, y: 6, z: -28 }
    for (const radius of [-1, Infinity, NaN]) {
      expect(gravityGateTopCrossing(above, below, gate, radius)).toBeNull()
      expect(gravityGateLowerCrossing(above, below, gate, radius)).toBeNull()
      expect(gravityGateExitCrossing({ x: 2, y: 6, z: -28 }, { x: 6, y: 6, z: -28 }, gate, radius)).toBeNull()
    }
    expect(gravityGateTopCrossing({ ...above, x: NaN }, below, gate)).toBeNull()
    expect(gravityGateLowerCrossing({ ...above, z: NaN }, below, gate)).toBeNull()
    expect(gravityGateExitCrossing({ x: 2, y: 6, z: -28 }, { x: Infinity, y: 6, z: -28 }, gate)).toBeNull()
  })
})
