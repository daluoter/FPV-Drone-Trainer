import {
  crossVector3,
  dotVector3,
  isFiniteVector3,
  scaleVector3,
  type Vector3,
} from './vector'

export interface Quaternion {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

export const IDENTITY_QUATERNION: Quaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })

export function quaternion(x = 0, y = 0, z = 0, w = 1): Quaternion {
  return { x, y, z, w }
}

export function isFiniteQuaternion(value: Quaternion): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isFinite(value.w)
}

export function quaternionNormSquared(value: Quaternion): number {
  return value.x ** 2 + value.y ** 2 + value.z ** 2 + value.w ** 2
}

export function quaternionNorm(value: Quaternion): number {
  return Math.sqrt(quaternionNormSquared(value))
}

export function normalizeQuaternion(value: Quaternion, fallback: Quaternion = IDENTITY_QUATERNION): Quaternion {
  const norm = quaternionNorm(value)
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) return fallback
  return {
    x: value.x / norm,
    y: value.y / norm,
    z: value.z / norm,
    w: value.w / norm,
  }
}

export function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  }
}

export function conjugateQuaternion(value: Quaternion): Quaternion {
  return { x: -value.x, y: -value.y, z: -value.z, w: value.w }
}

/** Build a unit quaternion from an axis-angle rotation vector in radians. */
export function quaternionFromRotationVector(rotationVectorRad: Vector3): Quaternion {
  if (!isFiniteVector3(rotationVectorRad)) return IDENTITY_QUATERNION
  const angle = Math.sqrt(dotVector3(rotationVectorRad, rotationVectorRad))
  if (angle <= 1e-12) {
    // sin(angle / 2) / angle approaches 1 / 2 at the origin.
    return normalizeQuaternion({
      x: rotationVectorRad.x * 0.5,
      y: rotationVectorRad.y * 0.5,
      z: rotationVectorRad.z * 0.5,
      w: 1,
    })
  }
  const halfAngle = angle * 0.5
  const scale = Math.sin(halfAngle) / angle
  return {
    x: rotationVectorRad.x * scale,
    y: rotationVectorRad.y * scale,
    z: rotationVectorRad.z * scale,
    w: Math.cos(halfAngle),
  }
}

/** Rotate a vector from body coordinates into world coordinates. */
export function rotateVectorByQuaternion(rotation: Quaternion, value: Vector3): Vector3 {
  const unit = normalizeQuaternion(rotation)
  const qVector = { x: unit.x, y: unit.y, z: unit.z }
  const uv = crossVector3(qVector, value)
  const uuv = crossVector3(qVector, uv)
  return {
    x: value.x + 2 * (unit.w * uv.x + uuv.x),
    y: value.y + 2 * (unit.w * uv.y + uuv.y),
    z: value.z + 2 * (unit.w * uv.z + uuv.z),
  }
}

/** Rotate a vector from world coordinates into body coordinates. */
export function inverseRotateVectorByQuaternion(rotation: Quaternion, value: Vector3): Vector3 {
  return rotateVectorByQuaternion(conjugateQuaternion(normalizeQuaternion(rotation)), value)
}

/** Integrate body angular velocity exactly over one constant-timestep interval. */
export function integrateBodyAngularVelocity(
  orientationBodyToWorld: Quaternion,
  angularVelocityBodyRadPerSec: Vector3,
  deltaSeconds: number,
): Quaternion {
  if (!isFiniteVector3(angularVelocityBodyRadPerSec) || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    return normalizeQuaternion(orientationBodyToWorld)
  }
  const deltaRotation = quaternionFromRotationVector(scaleVector3(angularVelocityBodyRadPerSec, deltaSeconds))
  return normalizeQuaternion(multiplyQuaternions(orientationBodyToWorld, deltaRotation))
}

export function quaternionNearlyEqual(left: Quaternion, right: Quaternion, tolerance = 1e-9): boolean {
  // q and -q represent the same orientation, so compare the closer sign.
  const direct = Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.z - right.z) + Math.abs(left.w - right.w)
  const negated = Math.abs(left.x + right.x) + Math.abs(left.y + right.y) + Math.abs(left.z + right.z) + Math.abs(left.w + right.w)
  return Math.min(direct, negated) <= tolerance
}
