import { IDENTITY_QUATERNION, isFiniteQuaternion, normalizeQuaternion, quaternionNorm, type Quaternion } from '../math/quaternion'
import { isFiniteVector3, vector3, type Vector3 } from '../math/vector'
import { createMotorState } from './motor'
import type { DroneConfig, DroneState, QuadMotorState } from './types'

export function createInitialMotorStates(): QuadMotorState {
  return [createMotorState(), createMotorState(), createMotorState(), createMotorState()]
}

export function createInitialDroneState(
  config: DroneConfig,
  positionM: Vector3 = config.spawnPositionM,
  orientation: Quaternion = IDENTITY_QUATERNION,
): DroneState {
  return {
    positionM: { ...positionM },
    velocityMps: vector3(),
    orientation: normalizeQuaternion(orientation),
    angularVelocityBodyRadPerSec: vector3(),
    motors: createInitialMotorStates(),
    timeSeconds: 0,
    stepIndex: 0,
    warnings: [],
  }
}

export function isFiniteDroneState(state: DroneState): boolean {
  if (
    !isFiniteVector3(state.positionM) ||
    !isFiniteVector3(state.velocityMps) ||
    !isFiniteQuaternion(state.orientation) ||
    !isFiniteVector3(state.angularVelocityBodyRadPerSec) ||
    !Number.isFinite(state.timeSeconds) ||
    state.timeSeconds < 0 ||
    !Number.isInteger(state.stepIndex) ||
    state.stepIndex < 0
  ) return false
  const orientationNorm = quaternionNorm(state.orientation)
  if (!Number.isFinite(orientationNorm) || orientationNorm <= 1e-8) return false
  return state.motors.length === 4 && state.motors.every((motor) => (
    Number.isFinite(motor.command) && motor.command >= 0 && motor.command <= 1 &&
    Number.isFinite(motor.targetThrustN) && motor.targetThrustN >= 0 &&
    Number.isFinite(motor.actualThrustN) && motor.actualThrustN >= 0
  ))
}

export function resetDroneState(
  config: DroneConfig,
  previous: DroneState,
  warnings: readonly string[],
): DroneState {
  const reset = createInitialDroneState(config)
  return {
    ...reset,
    timeSeconds: Number.isFinite(previous.timeSeconds) && previous.timeSeconds >= 0 ? previous.timeSeconds : 0,
    stepIndex: Number.isInteger(previous.stepIndex) && previous.stepIndex >= 0 ? previous.stepIndex : 0,
    warnings: [...warnings],
  }
}
