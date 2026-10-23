import { isFiniteVector3, type Vector3 } from '../math/vector'

export interface StaticBoxCollider {
  readonly id: string
  readonly centerM: Vector3
  readonly halfExtentsM: Vector3
}

export interface SweptObstacleHit {
  readonly colliderId: string
  readonly fraction: number
  readonly positionM: Vector3
}

export const MAX_STATIC_OBSTACLES = 64
export const OBSTACLE_CRASH_WARNING_PREFIX = 'Obstacle collision: '

const AXES = ['x', 'y', 'z'] as const

function finiteVector(value: unknown): value is Vector3 {
  return typeof value === 'object' && value !== null && isFiniteVector3(value as Vector3)
}

/** Validate a bounded physical field before it reaches the fixed-step loop. */
export function validateStaticObstacles(boxes: readonly StaticBoxCollider[]): boolean {
  if (!Array.isArray(boxes) || boxes.length > MAX_STATIC_OBSTACLES) return false
  const ids = new Set<string>()
  for (const box of boxes) {
    if (typeof box !== 'object' || box === null || typeof box.id !== 'string'
      || box.id.trim().length === 0 || box.id.length > 160 || ids.has(box.id)
      || !finiteVector(box.centerM) || !finiteVector(box.halfExtentsM)) return false
    if (!AXES.every((axis) => box.halfExtentsM[axis] > 0
      && Number.isFinite(box.centerM[axis] - box.halfExtentsM[axis])
      && Number.isFinite(box.centerM[axis] + box.halfExtentsM[axis]))) return false
    ids.add(box.id)
  }
  return true
}

/** Snapshot caller-owned geometry so a later mutation cannot alter a flight. */
export function copyStaticObstacles(boxes: readonly StaticBoxCollider[]): readonly StaticBoxCollider[] {
  if (!validateStaticObstacles(boxes)) throw new RangeError('Static obstacle geometry is invalid.')
  return Object.freeze(boxes.map((box) => Object.freeze({
    id: box.id,
    centerM: Object.freeze({ ...box.centerM }),
    halfExtentsM: Object.freeze({ ...box.halfExtentsM }),
  })))
}

/**
 * Sweep a conservative all-orientation drone envelope through static boxes.
 * Expanding each box by the radius uses the envelope's enclosing AABB; corners
 * are deliberately conservative rather than exact sphere/box intersections.
 * Touching counts as contact, including parallel motion or starting overlap.
 */
export function findSweptObstacleHit(
  start: Vector3,
  end: Vector3,
  radiusM: number,
  boxes: readonly StaticBoxCollider[],
): SweptObstacleHit | null {
  if (!finiteVector(start) || !finiteVector(end) || !Number.isFinite(radiusM) || radiusM < 0
    || !validateStaticObstacles(boxes)) return null
  const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z }
  if (!finiteVector(delta)) return null
  let earliest: SweptObstacleHit | null = null
  for (const box of boxes) {
    let enter = 0
    let exit = 1
    let intersects = true
    for (const axis of AXES) {
      const extent = box.halfExtentsM[axis] + radiusM
      const minimum = box.centerM[axis] - extent
      const maximum = box.centerM[axis] + extent
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null
      if (delta[axis] === 0) {
        if (start[axis] < minimum || start[axis] > maximum) intersects = false
      } else {
        const near = (minimum - start[axis]) / delta[axis]
        const far = (maximum - start[axis]) / delta[axis]
        enter = Math.max(enter, Math.min(near, far))
        exit = Math.min(exit, Math.max(near, far))
        if (enter > exit) intersects = false
      }
      if (!intersects) break
    }
    if (!intersects || enter < 0 || enter > 1 || (earliest && enter >= earliest.fraction)) continue
    earliest = {
      colliderId: box.id,
      fraction: enter,
      positionM: {
        x: start.x + delta.x * enter,
        y: start.y + delta.y * enter,
        z: start.z + delta.z * enter,
      },
    }
  }
  return earliest
}
