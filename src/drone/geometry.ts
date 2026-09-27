import { rotateVectorByQuaternion, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import type { DroneConfig } from './types'

/** Shared visual dimensions and conservative ground-contact features for the simplified quad. */
export const DRONE_GEOMETRY = {
  body: { sizeM: { x: 0.3, y: 0.09, z: 0.24 }, centerM: { x: 0, y: 0, z: 0 } },
  nose: { sizeM: { x: 0.11, y: 0.11, z: 0.16 }, centerM: { x: 0, y: 0.02, z: -0.17 } },
  arms: {
    sizeM: { x: 0.08, y: 0.045, z: 0.38 },
    placements: [
      { centerM: { x: -0.06, y: 0, z: -0.06 }, rotationYRad: -3 * Math.PI / 4 },
      { centerM: { x: 0.06, y: 0, z: -0.06 }, rotationYRad: -3 * Math.PI / 4 },
      { centerM: { x: -0.06, y: 0, z: 0.06 }, rotationYRad: -Math.PI / 4 },
      { centerM: { x: 0.06, y: 0, z: 0.06 }, rotationYRad: -Math.PI / 4 },
    ],
  },
  motors: {
    radiusM: 0.042,
    heightM: 0.045,
    positionsM: [
      { x: -0.12, y: 0.035, z: -0.12 },
      { x: 0.12, y: 0.035, z: -0.12 },
      { x: -0.12, y: 0.035, z: 0.12 },
      { x: 0.12, y: 0.035, z: 0.12 },
    ],
  },
  propellers: { sizeM: { x: 0.18, y: 0.008, z: 0.018 }, radiusM: 0.095, segments: 16, centerYFromMotorM: 0.03 },
  camera: {
    mountPositionM: { x: 0, y: 0.08, z: -0.11 },
    // The cube contains the complete near plane at the supported 120 degree
    // maximum FOV, 0.01 m near distance, and up to 4:1 viewport aspect.
    nearPlaneEnvelopeHalfExtentM: 0.08,
  },
} as const

export const DEFAULT_FPV_MOUNT_POSITION_M: Vector3 = Object.freeze({ ...DRONE_GEOMETRY.camera.mountPositionM })
export const DRONE_GROUND_CLEARANCE_M = 0.001

export interface DroneGroundSupport {
  /** COM height above the ground needed to keep every modeled contact feature clear. */
  readonly supportOffsetM: number
  /** World-oriented vector from the COM to the lowest contact feature. */
  readonly lowestPointOffsetWorldM: Vector3
  readonly lowestPointBodyM: Vector3
}

function boxCorners(
  centerM: Vector3,
  halfSizeM: Vector3,
  rotationYRad = 0,
): Vector3[] {
  const points: Vector3[] = []
  const cosine = Math.cos(rotationYRad)
  const sine = Math.sin(rotationYRad)
  for (const xSign of [-1, 1]) {
    for (const ySign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const x = xSign * halfSizeM.x
        const z = zSign * halfSizeM.z
        points.push({
          x: centerM.x + x * cosine + z * sine,
          y: centerM.y + ySign * halfSizeM.y,
          z: centerM.z - x * sine + z * cosine,
        })
      }
    }
  }
  return points
}

const contactPointCache = new WeakMap<DroneConfig, readonly Vector3[]>()
const contactRadiusCache = new WeakMap<DroneConfig, number>()

function contactPoints(config: DroneConfig): readonly Vector3[] {
  const cached = contactPointCache.get(config)
  if (cached) return cached
  const points = [
    ...boxCorners(DRONE_GEOMETRY.body.centerM, {
      x: DRONE_GEOMETRY.body.sizeM.x / 2,
      y: DRONE_GEOMETRY.body.sizeM.y / 2,
      z: DRONE_GEOMETRY.body.sizeM.z / 2,
    }),
    ...boxCorners(DRONE_GEOMETRY.nose.centerM, {
      x: DRONE_GEOMETRY.nose.sizeM.x / 2,
      y: DRONE_GEOMETRY.nose.sizeM.y / 2,
      z: DRONE_GEOMETRY.nose.sizeM.z / 2,
    }),
  ]

  for (const arm of DRONE_GEOMETRY.arms.placements) {
    points.push(...boxCorners(arm.centerM, {
      x: DRONE_GEOMETRY.arms.sizeM.x / 2,
      y: DRONE_GEOMETRY.arms.sizeM.y / 2,
      z: DRONE_GEOMETRY.arms.sizeM.z / 2,
    }, arm.rotationYRad))
  }

  const appendMotorAndPropeller = (motorPosition: Vector3, propellerCenterY: number): void => {
    points.push(...boxCorners({
      x: motorPosition.x,
      y: motorPosition.y,
      z: motorPosition.z,
    }, {
      x: DRONE_GEOMETRY.motors.radiusM,
      y: DRONE_GEOMETRY.motors.heightM / 2,
      z: DRONE_GEOMETRY.motors.radiusM,
    }))
    for (let index = 0; index < DRONE_GEOMETRY.propellers.segments; index += 1) {
      const angle = index * Math.PI * 2 / DRONE_GEOMETRY.propellers.segments
      const x = Math.cos(angle) * DRONE_GEOMETRY.propellers.radiusM
      const z = Math.sin(angle) * DRONE_GEOMETRY.propellers.radiusM
      points.push(
        { x: motorPosition.x + x, y: propellerCenterY - DRONE_GEOMETRY.propellers.sizeM.y / 2, z: motorPosition.z + z },
        { x: motorPosition.x + x, y: propellerCenterY + DRONE_GEOMETRY.propellers.sizeM.y / 2, z: motorPosition.z + z },
      )
    }
  }
  for (const motorPosition of DRONE_GEOMETRY.motors.positionsM) {
    appendMotorAndPropeller(motorPosition, motorPosition.y + DRONE_GEOMETRY.propellers.centerYFromMotorM)
  }
  for (const motor of config.motors) {
    appendMotorAndPropeller(motor.positionM, motor.positionM.y + 0.065)
  }

  const cameraCenter = DRONE_GEOMETRY.camera.mountPositionM
  const extent = DRONE_GEOMETRY.camera.nearPlaneEnvelopeHalfExtentM
  points.push(...boxCorners(cameraCenter, { x: extent, y: extent, z: extent }))
  const frozenPoints = Object.freeze(points.map((point) => Object.freeze(point)))
  contactPointCache.set(config, frozenPoints)
  return frozenPoints
}

/** Maximum contact-feature distance used to skip support queries while airborne. */
export function droneGroundContactRadius(config: DroneConfig): number {
  const cached = contactRadiusCache.get(config)
  if (cached !== undefined) return cached
  const radius = contactPoints(config).reduce((maximum, point) => (
    Math.max(maximum, Math.hypot(point.x, point.y, point.z))
  ), 0)
  contactRadiusCache.set(config, radius)
  return radius
}

/** Compute a deterministic support point for the configured quad pose. */
export function droneGroundSupport(config: DroneConfig, orientation: Quaternion): DroneGroundSupport {
  let lowestPointBodyM: Vector3 = { x: 0, y: 0, z: 0 }
  let lowestPointOffsetWorldM: Vector3 = { x: 0, y: 0, z: 0 }
  let lowestY = Number.POSITIVE_INFINITY
  for (const point of contactPoints(config)) {
    const worldOffset = rotateVectorByQuaternion(orientation, point)
    if (worldOffset.y < lowestY) {
      lowestY = worldOffset.y
      lowestPointBodyM = point
      lowestPointOffsetWorldM = worldOffset
    }
  }
  return {
    supportOffsetM: Math.max(0, -lowestY),
    lowestPointOffsetWorldM,
    lowestPointBodyM,
  }
}
