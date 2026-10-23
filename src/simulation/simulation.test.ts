import { describe, expect, it } from 'vitest'

import { DroneSimulation } from './simulation'
import { OBSTACLE_CRASH_WARNING_PREFIX, type StaticBoxCollider } from './obstacles'

describe('explicit lesson preparation clock', () => {
  it('advances authoritative time and steps while preserving prepared physical state', () => {
    const simulation = new DroneSimulation()
    const prepared = simulation.resetAt({ x: 2, y: 3, z: -1 }, { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 })
    for (let index = 0; index < 2_400; index += 1) simulation.stepHeld()

    const held = simulation.getState()
    expect(held.positionM).toEqual(prepared.positionM)
    expect(held.velocityMps).toEqual(prepared.velocityMps)
    expect(held.orientation).toEqual(prepared.orientation)
    expect(held.angularVelocityBodyRadPerSec).toEqual(prepared.angularVelocityBodyRadPerSec)
    expect(held.motors).toEqual(prepared.motors)
    expect(held.timeSeconds).toBeCloseTo(10, 8)
    expect(held.stepIndex).toBe(2_400)
  })

  it('continues normal gravity integration when the held-step API is not requested', () => {
    const simulation = new DroneSimulation()
    simulation.resetAt({ x: 0, y: 3, z: 0 })
    const state = simulation.step([0, 0, 0, 0]).state
    expect(state.positionM.y).toBeLessThan(3)
    expect(state.velocityMps.y).toBeLessThan(0)
  })

  it('keeps the normal safe-reset behavior for an invalid held timestep', () => {
    const simulation = new DroneSimulation()
    simulation.resetAt({ x: 0, y: 3, z: 0 })
    const result = simulation.stepHeld(Number.NaN)
    expect(result.reset).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/invalid integration timestep/i)
    expect(Number.isFinite(result.state.timeSeconds)).toBe(true)
  })
})

describe('simulation static obstacle lifecycle', () => {
  const box: StaticBoxCollider = {
    id: 'test-frame', centerM: { x: 1, y: 3, z: -2 }, halfExtentsM: { x: 0.1, y: 1, z: 0.1 },
  }
  const warning = `${OBSTACLE_CRASH_WARNING_PREFIX}${box.id}; reset required.`

  it('applies an immutable field without changing pose or authoritative time', () => {
    const simulation = new DroneSimulation()
    simulation.resetAt({ x: 0, y: 3, z: 0 })
    simulation.stepHeld()
    const prepared = simulation.getState()
    const callerBoxes = [{ id: box.id, centerM: { ...box.centerM }, halfExtentsM: { ...box.halfExtentsM } }]
    simulation.setStaticObstacles(callerBoxes)
    callerBoxes[0].centerM.x = 0
    callerBoxes[0].halfExtentsM.y = 99
    callerBoxes.length = 0
    expect(simulation.getState()).toBe(prepared)
    expect(simulation.getStaticObstacles()).toEqual([box])
    const snapshot = simulation.getStaticObstacles()
    expect([snapshot, snapshot[0], snapshot[0].centerM, snapshot[0].halfExtentsM].every(Object.isFrozen)).toBe(true)
    expect(simulation.step([0, 0, 0, 0]).state.crashed).toBe(false)
  })

  it('rejects invalid changes atomically and keeps the previous physical field', () => {
    const simulation = new DroneSimulation()
    simulation.setStaticObstacles([box])
    const snapshot = simulation.getStaticObstacles()
    expect(() => simulation.setStaticObstacles([box, box])).toThrow(RangeError)
    expect(simulation.getStaticObstacles()).toBe(snapshot)
  })

  it('keeps contact and its warning latched after disarm, re-arming commands, and zero-step advances', () => {
    const simulation = new DroneSimulation()
    simulation.resetAt(box.centerM)
    simulation.setStaticObstacles([box])
    const collision = simulation.step([0.5, 0.5, 0.5, 0.5])
    expect(collision.reset).toBe(false)
    expect(collision.state.crashed).toBe(true)
    expect(collision.warnings).toEqual([warning])
    expect(simulation.disarm().warnings).toEqual([warning])
    const idle = simulation.advance(0, [1, 1, 1, 1])
    expect(idle.steps).toBe(0)
    expect(idle.state.warnings).toEqual([warning])
    expect(idle.warnings).toContain(warning)
    const invalidFrame = simulation.advance(NaN, [1, 1, 1, 1])
    expect(invalidFrame.state.warnings).toContain(warning)
    expect(invalidFrame.warnings).toContain(warning)
    const attemptedRearm = simulation.step([1, 1, 1, 1])
    expect(attemptedRearm.state.crashed).toBe(true)
    expect(attemptedRearm.state.positionM).toEqual(collision.state.positionM)
    expect(attemptedRearm.state.motors.every((motor) => motor.command === 0 && motor.actualThrustN === 0)).toBe(true)
    expect(attemptedRearm.warnings).toEqual([warning])
  })

  it('clears the crash and all old geometry at either explicit reset boundary', () => {
    const simulation = new DroneSimulation()
    for (const explicitPosition of [true, false]) {
      simulation.resetAt(box.centerM)
      simulation.setStaticObstacles([box])
      expect(simulation.step([0, 0, 0, 0]).state.crashed).toBe(true)
      const reset = explicitPosition ? simulation.resetAt(box.centerM) : simulation.reset()
      expect(reset.crashed).toBe(false)
      expect(reset.timeSeconds).toBe(0)
      expect(reset.stepIndex).toBe(0)
      expect(simulation.getStaticObstacles()).toEqual([])
      expect(simulation.step([0, 0, 0, 0]).state.crashed).toBe(false)
    }
  })

  it('holds a prepared pose until normal integration is explicitly resumed', () => {
    const simulation = new DroneSimulation()
    const prepared = simulation.resetAt(box.centerM)
    simulation.setStaticObstacles([box])
    simulation.stepHeld()
    expect(simulation.getState().positionM).toEqual(prepared.positionM)
    expect(simulation.getState().crashed).toBe(false)
    expect(simulation.getStaticObstacles()).toEqual([box])
    expect(simulation.step([0, 0, 0, 0]).state.crashed).toBe(true)
  })
})
