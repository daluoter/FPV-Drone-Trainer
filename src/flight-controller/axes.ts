import { isFiniteVector3, type Vector3 } from '../math/vector'
import type {
  BodyAngularRateRadPerSec,
  NormalizedRcAxes,
  NormalizedRcInput,
  PilotAngularRateRadPerSec,
  PilotRateAxis,
  PilotTorqueNm,
} from './types'

function isFinitePilotAxes(value: unknown): value is Readonly<Record<PilotRateAxis, number>> {
  if (typeof value !== 'object' || value === null) return false
  const axes = value as Record<PilotRateAxis, unknown>
  return Number.isFinite(axes.roll) && Number.isFinite(axes.pitch) && Number.isFinite(axes.yaw)
}

function isFiniteBodyVector(value: unknown): value is Vector3 {
  if (typeof value !== 'object' || value === null) return false
  const vector = value as Vector3
  return isFiniteVector3(vector)
}

/**
 * Convert pilot-positive axes to the documented body convention:
 * omegaBody = (pitch, -yaw, -roll). No attitude or Euler-angle leveling is
 * involved; this is only a sign/basis conversion at the flight boundary.
 */
export function pilotAxesToBodyAngularRate(
  axes: Pick<NormalizedRcAxes, 'roll' | 'pitch' | 'yaw'>,
): BodyAngularRateRadPerSec {
  if (!isFinitePilotAxes(axes)) return { x: Number.NaN, y: Number.NaN, z: Number.NaN }
  return { x: axes.pitch, y: -axes.yaw, z: -axes.roll }
}

/** Convert body angular rates back to pilot-positive roll/pitch/yaw rates. */
export function bodyAngularRateToPilotAxes(
  bodyRate: BodyAngularRateRadPerSec,
): PilotAngularRateRadPerSec {
  if (!isFiniteBodyVector(bodyRate)) return { roll: Number.NaN, pitch: Number.NaN, yaw: Number.NaN }
  return { roll: -bodyRate.z, pitch: bodyRate.x, yaw: -bodyRate.y }
}

/** The torque sign conversion is the same explicit basis as the rate conversion. */
export function pilotTorqueToBodyTorque(pilotTorque: PilotTorqueNm): Vector3 {
  if (!isFinitePilotAxes(pilotTorque)) return { x: Number.NaN, y: Number.NaN, z: Number.NaN }
  return { x: pilotTorque.pitch, y: -pilotTorque.yaw, z: -pilotTorque.roll }
}

/** Convert body torque to pilot-positive mixer correction signs. */
export function bodyTorqueToPilotTorque(bodyTorque: Vector3): PilotTorqueNm {
  if (!isFiniteBodyVector(bodyTorque)) return { roll: Number.NaN, pitch: Number.NaN, yaw: Number.NaN }
  return { roll: -bodyTorque.z, pitch: bodyTorque.x, yaw: -bodyTorque.y }
}

/** Keep the RC boundary explicit when a complete normalized sample is needed. */
export function isFiniteNormalizedRcInput(value: unknown): value is NormalizedRcInput {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return (
    typeof input.roll === 'number' && Number.isFinite(input.roll) && input.roll >= -1 && input.roll <= 1 &&
    typeof input.pitch === 'number' && Number.isFinite(input.pitch) && input.pitch >= -1 && input.pitch <= 1 &&
    typeof input.yaw === 'number' && Number.isFinite(input.yaw) && input.yaw >= -1 && input.yaw <= 1 &&
    typeof input.throttle === 'number' && Number.isFinite(input.throttle) && input.throttle >= 0 && input.throttle <= 1
  )
}

export function zeroNormalizedRcInput(): NormalizedRcInput {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0 }
}
