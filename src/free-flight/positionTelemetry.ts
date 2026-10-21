import { DRONE_GROUND_CLEARANCE_M, droneGroundSupport, type DroneConfig, type DroneState } from '../drone'
import { isFiniteQuaternion, quaternionNorm } from '../math/quaternion'
import { isFiniteVector3, type Vector3 } from '../math/vector'
import { createTrainingFieldAnchors } from '../training/field'

export interface PositionReadout {
  /** Signed centre-of-mass height above configured ground, matching route altitude. */
  readonly altitudeAboveGroundM: number | null
  /** Gap beneath the lowest model contact feature, excluding solver clearance. */
  readonly verticalClearanceM: number | null
  /** World +X from the launch reference; does not rotate with the drone heading. */
  readonly rightM: number | null
  /** World -Z from the launch reference; does not rotate with the drone heading. */
  readonly forwardM: number | null
  /** Signed world +Y from the supported launch centre of mass. */
  readonly upM: number | null
}

const UNAVAILABLE: PositionReadout = Object.freeze({
  altitudeAboveGroundM: null, verticalClearanceM: null,
  rightM: null, forwardM: null, upM: null,
})

/**
 * Read the supplied pose only: callers can pass either live state or replay ghost
 * geometry without mixing the two. All coordinates are metres in world axes.
 */
export function makePositionReadout(
  state: Pick<DroneState, 'positionM' | 'orientation'> | null,
  droneConfig: DroneConfig,
  origin?: Vector3,
): PositionReadout {
  if (!state || !isFiniteVector3(state.positionM) || !isFiniteQuaternion(state.orientation)
    || !Number.isFinite(quaternionNorm(state.orientation)) || quaternionNorm(state.orientation) <= 1e-8
    || !Number.isFinite(droneConfig.ground.heightM) || !isFiniteVector3(droneConfig.spawnPositionM)
    || (origin !== undefined && !isFiniteVector3(origin))) return UNAVAILABLE

  const supportOffsetM = droneGroundSupport(droneConfig, state.orientation).supportOffsetM
  if (!Number.isFinite(supportOffsetM)) return UNAVAILABLE
  const launch = origin ?? createTrainingFieldAnchors(droneConfig).launch
  const altitudeAboveGroundM = state.positionM.y - droneConfig.ground.heightM
  const readout: PositionReadout = {
    // Keep signed AGL/relative heights: a below-ground state must not look like
    // normal ground contact. The geometric gap alone is bounded at zero.
    altitudeAboveGroundM,
    verticalClearanceM: Math.max(0, altitudeAboveGroundM - supportOffsetM - DRONE_GROUND_CLEARANCE_M),
    rightM: state.positionM.x - launch.x,
    forwardM: launch.z - state.positionM.z,
    upM: state.positionM.y - launch.y,
  }
  return Object.values(readout).every(Number.isFinite) ? Object.freeze(readout) : UNAVAILABLE
}
