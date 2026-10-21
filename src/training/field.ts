import { createInitialDroneState, type DroneConfig } from '../drone'

export const LANDING_TARGET_DISTANCE_M = 8
export const TRAINING_ROUTE_ALTITUDE_AGL_M = 3

/** Shared physical anchors for presentation, preparation and recorded examples. */
export function createTrainingFieldAnchors(config: DroneConfig) {
  const pad = createInitialDroneState(config).positionM
  const launch = createInitialDroneState(config, { ...config.spawnPositionM, y: config.ground.heightM }).positionM
  return {
    pad,
    launch,
    routeAltitudeM: config.ground.heightM + TRAINING_ROUTE_ALTITUDE_AGL_M,
    landing: { x: launch.x, y: config.ground.heightM, z: launch.z - LANDING_TARGET_DISTANCE_M },
  }
}
