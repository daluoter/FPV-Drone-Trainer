import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { StaticBoxCollider } from '../simulation/obstacles'

export const WALL_RIDE_TARGET_HEIGHT_M = 14
export const WALL_RIDE_WALL_HEIGHT_M = 28
export const WALL_RIDE_WALL_LENGTH_M = 40
export const WALL_RIDE_WALL_THICKNESS_M = 1
export const WALL_RIDE_FACE_OFFSET_M = 10
export const WALL_RIDE_NEAR_DISTANCE_M = 12
export const WALL_RIDE_MIN_GAP_M = 0.8
export const WALL_RIDE_MAX_GAP_M = 5
export const WALL_RIDE_MIN_HEIGHT_M = 3
export const WALL_RIDE_MAX_HEIGHT_M = 24
export const WALL_RIDE_MAX_BELLY_ANGLE_DEGREES = 45
export const WALL_RIDE_DISTANCE_M = 6
export const WALL_RIDE_SECONDS = 0.3
export const WALL_RIDE_COLLIDER_ID = 'wall-ride-wall'
export const WALL_RIDE_REFERENCE_IDS = Object.freeze(['wall-ride-entry', 'wall-ride-start', 'wall-ride-end', 'wall-ride-exit'] as const)

export interface WallRide {
  readonly centerM: Vector3
  /** Visible learner-side wall face; the solid box occupies larger X. */
  readonly faceXM: number
  readonly nearZM: number
  readonly farZM: number
  readonly heightM: number
  readonly lengthM: number
  readonly thicknessM: number
  readonly groundHeightM: number
  readonly entryM: Vector3
  readonly rideStartM: Vector3
  readonly rideEndM: Vector3
  readonly exitM: Vector3
  readonly colliders: readonly StaticBoxCollider[]
}

/** One shared solid wall. Guidance never changes this collision geometry. */
export function createWallRide(launch: Vector3, groundHeightM: number): WallRide {
  if (!isFiniteVector3(launch) || !Number.isFinite(groundHeightM)) throw new RangeError('Wall ride anchors must be finite.')
  const faceXM = launch.x + WALL_RIDE_FACE_OFFSET_M
  const nearZM = launch.z - WALL_RIDE_NEAR_DISTANCE_M
  const farZM = nearZM - WALL_RIDE_WALL_LENGTH_M
  const centerM = Object.freeze({ x: faceXM + WALL_RIDE_WALL_THICKNESS_M / 2, y: groundHeightM + WALL_RIDE_WALL_HEIGHT_M / 2, z: (nearZM + farZM) / 2 })
  return Object.freeze({ centerM, faceXM, nearZM, farZM, heightM: WALL_RIDE_WALL_HEIGHT_M,
    lengthM: WALL_RIDE_WALL_LENGTH_M, thicknessM: WALL_RIDE_WALL_THICKNESS_M, groundHeightM,
    entryM: Object.freeze({ x: faceXM - 4, y: groundHeightM + WALL_RIDE_TARGET_HEIGHT_M, z: nearZM + 3 }),
    rideStartM: Object.freeze({ x: faceXM - 3, y: groundHeightM + WALL_RIDE_TARGET_HEIGHT_M, z: nearZM - 6 }),
    rideEndM: Object.freeze({ x: faceXM - 3, y: groundHeightM + WALL_RIDE_TARGET_HEIGHT_M - 3, z: nearZM - 18 }),
    exitM: Object.freeze({ x: faceXM - 8, y: groundHeightM + WALL_RIDE_TARGET_HEIGHT_M - 4, z: nearZM - 26 }),
    colliders: Object.freeze([Object.freeze({ id: WALL_RIDE_COLLIDER_ID, centerM,
      halfExtentsM: Object.freeze({ x: WALL_RIDE_WALL_THICKNESS_M / 2, y: WALL_RIDE_WALL_HEIGHT_M / 2, z: WALL_RIDE_WALL_LENGTH_M / 2 }) })]),
  })
}
