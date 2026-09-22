import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG } from './config'
import { calculateMotorForces } from './forces'
import type { QuadMotorState } from './types'

function motorsWithThrust(thrusts: readonly number[]): QuadMotorState {
  return thrusts.map((actualThrustN) => ({
    command: actualThrustN / DEFAULT_DRONE_CONFIG.motors[0].maxThrustN,
    targetThrustN: actualThrustN,
    actualThrustN,
  })) as unknown as QuadMotorState
}

describe('motor force and torque derivation', () => {
  it('derives arm moments from r cross F', () => {
    const frontLeft = calculateMotorForces(motorsWithThrust([5, 0, 0, 0]), DEFAULT_DRONE_CONFIG)
    const frontRight = calculateMotorForces(motorsWithThrust([0, 5, 0, 0]), DEFAULT_DRONE_CONFIG)
    expect(frontLeft.totalForceBodyN.y).toBe(5)
    expect(frontLeft.torqueBodyNm.x).toBeGreaterThan(0)
    expect(frontLeft.torqueBodyNm.z).toBeLessThan(0)
    expect(frontRight.torqueBodyNm.z).toBeGreaterThan(0)
  })

  it('cancels reaction yaw torque at equal collective thrust', () => {
    const summary = calculateMotorForces(motorsWithThrust([2, 2, 2, 2]), DEFAULT_DRONE_CONFIG)
    expect(summary.torqueBodyNm.y).toBeCloseTo(0, 12)
    expect(summary.totalThrustN).toBe(8)
  })

  it('produces pilot-positive yaw direction from the CCW motor pair', () => {
    const ccwPair = calculateMotorForces(motorsWithThrust([5, 0, 0, 5]), DEFAULT_DRONE_CONFIG)
    const cwPair = calculateMotorForces(motorsWithThrust([0, 5, 5, 0]), DEFAULT_DRONE_CONFIG)
    expect(ccwPair.torqueBodyNm.y).toBeLessThan(0)
    expect(cwPair.torqueBodyNm.y).toBeGreaterThan(0)
  })
})
