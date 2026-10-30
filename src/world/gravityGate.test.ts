import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, droneGroundContactRadius } from '../drone'
import { FlightSimulation } from '../flight-controller'
import { findSweptObstacleHit, validateStaticObstacles } from '../simulation/obstacles'
import { createGravityGate, gravityGateExitCrossing, gravityGateTopCrossing, GRAVITY_GATE_FRAME_THICKNESS_M } from './gravityGate'

const launch = { x: 0, y: 0.05, z: 0 }

describe('shared gravity gate field', () => {
  it('provides one immutable, truly open, supported 12-beam field with explicit top and far-side openings', () => {
    const gate = createGravityGate(launch, 0)
    expect(gate.centerM).toEqual({ x: 0, y: 17, z: -40 })
    expect(gate.topEntryCenterM).toEqual({ x: 0, y: 24, z: -40 })
    expect(gate.sideExitCenterM).toEqual({ x: 0, y: 17, z: -47 })
    expect([gate.minX, gate.maxX, gate.minZ, gate.maxZ, gate.bottomY, gate.topY]).toEqual([-7, 7, -47, -33, 10, 24])
    expect(gate.exitZ).toBe(gate.minZ)
    expect(gate.colliders).toHaveLength(12)
    expect(validateStaticObstacles(gate.colliders)).toBe(true)
    expect([gate, gate.centerM, gate.topEntryCenterM, gate.sideExitCenterM, gate.colliders,
      ...gate.colliders.flatMap((box) => [box, box.centerM, box.halfExtentsM])].every(Object.isFrozen)).toBe(true)
    for (const box of gate.colliders) {
      const bounds = { x: [gate.minX, gate.maxX], y: [gate.bottomY, gate.topY], z: [gate.minZ, gate.maxZ] }
      const interiorOverlap = (['x', 'y', 'z'] as const).map((axis) => Math.min(box.centerM[axis] + box.halfExtentsM[axis], bounds[axis][1])
        - Math.max(box.centerM[axis] - box.halfExtentsM[axis], bounds[axis][0]))
      // No physical beam intrudes into the stated clear volume, including its top and side openings.
      expect(interiorOverlap.some((overlap) => overlap < 1e-9)).toBe(true)
      if (box.id.endsWith('-post')) expect(box.centerM.y - box.halfExtentsM.y).toBeCloseTo(0)
      expect(Object.values(box.halfExtentsM).filter((extent) => Math.abs(extent * 2 - GRAVITY_GATE_FRAME_THICKNESS_M) < 1e-9).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('translates every physical and scoring anchor with the supported launch and ground height', () => {
    const original = createGravityGate(launch, 0)
    const shifted = createGravityGate({ x: 6, y: 5.05, z: -3 }, 5)
    expect(shifted.centerM).toEqual({ x: 6, y: 22, z: -43 })
    expect(shifted.topEntryCenterM).toEqual({ x: 6, y: 29, z: -43 })
    expect(shifted.sideExitCenterM).toEqual({ x: 6, y: 22, z: -50 })
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
    const inside = { ...gate.centerM }
    const outside = { ...gate.sideExitCenterM, z: gate.exitZ - 4 }
    expect(findSweptObstacleHit(above, inside, radius, gate.colliders)).toBeNull()
    expect(findSweptObstacleHit(inside, outside, radius, gate.colliders)).toBeNull()
    expect(gravityGateTopCrossing(above, inside, gate, radius)?.insideOpening).toBe(true)
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
    for (let step = 0; step < 720 && simulation.getState().positionM.y > gate.topY - 3 && !simulation.getState().crashed; step += 1) simulation.step(input)
    expect(simulation.getState().positionM.y).toBeLessThan(gate.topY)
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

  it('refuses non-finite anchors rather than installing an invalid physics field', () => {
    expect(() => createGravityGate({ ...launch, x: NaN }, 0)).toThrow(RangeError)
    expect(() => createGravityGate(launch, Infinity)).toThrow(RangeError)
  })
})

describe('gravity gate continuous opening crossings', () => {
  const gate = createGravityGate(launch, 0)

  it('interpolates the exact downward top passage rather than accepting endpoint proximity', () => {
    const passage = gravityGateTopCrossing({ x: -2, y: 26, z: -38 }, { x: 2, y: 22, z: -42 }, gate, 0.25)
    expect(passage).toEqual({ fraction: 0.5, positionM: { x: 0, y: 24, z: -40 }, insideOpening: true })
    expect(gravityGateTopCrossing({ x: 0, y: 23, z: -40 }, { x: 0, y: 25, z: -40 }, gate)).toBeNull()
    expect(gravityGateTopCrossing({ x: 0, y: 25, z: -40 }, { x: 0, y: 24.1, z: -40 }, gate)).toBeNull()
    expect(gravityGateTopCrossing({ x: 0, y: 24, z: -40 }, { x: 1, y: 24, z: -40 }, gate)).toBeNull()
  })

  it('interpolates the marked outward side passage and rejects entering that side in reverse', () => {
    expect(gravityGateExitCrossing({ x: -2, y: 19, z: -45 }, { x: 2, y: 15, z: -49 }, gate, 0.25))
      .toEqual({ fraction: 0.5, positionM: { x: 0, y: 17, z: -47 }, insideOpening: true })
    expect(gravityGateExitCrossing({ x: 0, y: 17, z: -49 }, { x: 0, y: 17, z: -45 }, gate)).toBeNull()
    expect(gravityGateExitCrossing({ x: 0, y: 17, z: -45 }, { x: 0, y: 17, z: -46.9 }, gate)).toBeNull()
  })

  it('never expands the inner opening across beams, including a body whose centre clears an edge but propellers do not', () => {
    for (const x of [gate.minX - 0.1, gate.minX + 0.1, gate.maxX - 0.1, gate.maxX + 0.1]) {
      const before = { x, y: 26, z: -40 }
      const current = { x, y: 22, z: -40 }
      expect(gravityGateTopCrossing(before, current, gate, 0.25)?.insideOpening).toBe(false)
      expect(findSweptObstacleHit(before, current, 0.25, gate.colliders)).not.toBeNull()
    }
    for (const y of [gate.bottomY + 0.1, gate.topY - 0.1]) {
      const before = { x: 0, y, z: -45 }
      const current = { x: 0, y, z: -49 }
      expect(gravityGateExitCrossing(before, current, gate, 0.25)?.insideOpening).toBe(false)
      expect(findSweptObstacleHit(before, current, 0.25, gate.colliders)).not.toBeNull()
    }
    expect(gravityGateTopCrossing({ x: -6.6, y: 26, z: -40 }, { x: -6.6, y: 22, z: -40 }, gate, 0.25)?.insideOpening).toBe(true)
  })

  it('rejects non-finite segments or invalid body radii without inventing a passage', () => {
    const above = { x: 0, y: 26, z: -40 }
    const below = { x: 0, y: 22, z: -40 }
    for (const radius of [-1, Infinity, NaN]) {
      expect(gravityGateTopCrossing(above, below, gate, radius)).toBeNull()
      expect(gravityGateExitCrossing({ x: 0, y: 17, z: -45 }, { x: 0, y: 17, z: -49 }, gate, radius)).toBeNull()
    }
    expect(gravityGateTopCrossing({ ...above, x: NaN }, below, gate)).toBeNull()
    expect(gravityGateExitCrossing({ x: 0, y: 17, z: -45 }, { x: Infinity, y: 17, z: -49 }, gate)).toBeNull()
  })
})
