import { describe, expect, it } from 'vitest'

import { DroneSimulation } from './simulation'

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
