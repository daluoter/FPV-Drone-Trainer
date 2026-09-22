export interface Vector3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export const ZERO_VECTOR3: Vector3 = Object.freeze({ x: 0, y: 0, z: 0 })

export function vector3(x = 0, y = 0, z = 0): Vector3 {
  return { x, y, z }
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export function addVector3(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }
}

export function subtractVector3(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }
}

export function scaleVector3(value: Vector3, scalar: number): Vector3 {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar }
}

export function multiplyVector3(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x * right.x, y: left.y * right.y, z: left.z * right.z }
}

export function divideVector3(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x / right.x, y: left.y / right.y, z: left.z / right.z }
}

export function dotVector3(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

export function crossVector3(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  }
}

export function magnitudeSquaredVector3(value: Vector3): number {
  return dotVector3(value, value)
}

export function magnitudeVector3(value: Vector3): number {
  return Math.sqrt(magnitudeSquaredVector3(value))
}

export function normalizeVector3(value: Vector3, fallback: Vector3 = ZERO_VECTOR3): Vector3 {
  const magnitude = magnitudeVector3(value)
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) return fallback
  return scaleVector3(value, 1 / magnitude)
}

export function isFiniteVector3(value: Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

export function clampVector3(value: Vector3, minimum: number, maximum: number): Vector3 {
  return {
    x: Math.min(Math.max(value.x, minimum), maximum),
    y: Math.min(Math.max(value.y, minimum), maximum),
    z: Math.min(Math.max(value.z, minimum), maximum),
  }
}
