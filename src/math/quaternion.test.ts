import { describe, expect, it } from 'vitest'
import {
  IDENTITY_QUATERNION,
  integrateBodyAngularVelocity,
  normalizeQuaternion,
  quaternionFromRotationVector,
  quaternionNorm,
  quaternionNearlyEqual,
  rotateVectorByQuaternion,
} from './quaternion'
import { vector3 } from './vector'

function closeVector(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }, tolerance = 1e-10): void {
  expect(actual.x).toBeCloseTo(expected.x, Math.log10(1 / tolerance))
  expect(actual.y).toBeCloseTo(expected.y, Math.log10(1 / tolerance))
  expect(actual.z).toBeCloseTo(expected.z, Math.log10(1 / tolerance))
}

describe('quaternion math', () => {
  it('normalizes and rotates vectors with the documented right-handed convention', () => {
    const quarterTurnAboutY = quaternionFromRotationVector(vector3(0, Math.PI / 2, 0))
    closeVector(rotateVectorByQuaternion(quarterTurnAboutY, vector3(0, 0, -1)), vector3(-1, 0, 0))
    expect(quaternionNorm(normalizeQuaternion({ x: 1, y: 2, z: 3, w: 4 }))).toBeCloseTo(1)
  })

  it('keeps the authoritative orientation normalized during body-rate integration', () => {
    const orientation = integrateBodyAngularVelocity(IDENTITY_QUATERNION, vector3(2, -1, 0.5), 1 / 240)
    expect(quaternionNorm(orientation)).toBeCloseTo(1, 12)
    expect(quaternionNearlyEqual(orientation, normalizeQuaternion(orientation))).toBe(true)
  })

  it('integrates a positive body rate with the documented quaternion sign', () => {
    const orientation = integrateBodyAngularVelocity(IDENTITY_QUATERNION, vector3(Math.PI / 2, 0, 0), 1)
    const rotatedBodyZ = rotateVectorByQuaternion(orientation, vector3(0, 0, 1))

    expect(orientation.x).toBeGreaterThan(0)
    expect(rotatedBodyZ.x).toBeCloseTo(0, 12)
    expect(rotatedBodyZ.y).toBeCloseTo(-1, 12)
    expect(rotatedBodyZ.z).toBeCloseTo(0, 12)
  })

  it('does not move orientation for zero body angular velocity', () => {
    const orientation = integrateBodyAngularVelocity(IDENTITY_QUATERNION, vector3(), 1 / 240)
    expect(quaternionNearlyEqual(orientation, IDENTITY_QUATERNION)).toBe(true)
  })
})
