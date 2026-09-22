import { crossVector3, vector3 } from '../math/vector'
import type { DroneConfig, MotorForceSummary, QuadMotorState } from './types'

/**
 * Convert independent motor thrust states into body force and moments. Thrust
 * points along body +Y. The yaw term is propeller reaction torque, not a direct
 * orientation edit: viewed from above, CW props apply +body-Y reaction torque
 * and CCW props apply -body-Y reaction torque.
 */
export function calculateMotorForces(
  motors: QuadMotorState,
  config: DroneConfig,
): MotorForceSummary {
  let totalForceBodyN = vector3()
  let torqueBodyNm = vector3()
  const motorThrustsN = motors.map((motorState, index) => {
    const motorConfig = config.motors[index]
    const thrustN = motorState.actualThrustN
    const forceBodyN = vector3(0, thrustN, 0)
    totalForceBodyN = {
      x: totalForceBodyN.x + forceBodyN.x,
      y: totalForceBodyN.y + forceBodyN.y,
      z: totalForceBodyN.z + forceBodyN.z,
    }
    const armTorqueNm = crossVector3(motorConfig.positionM, forceBodyN)
    const reactionSign = motorConfig.spinDirection === 'cw' ? 1 : -1
    torqueBodyNm = {
      x: torqueBodyNm.x + armTorqueNm.x,
      y: torqueBodyNm.y + reactionSign * motorConfig.yawReactionCoefficientM * thrustN,
      z: torqueBodyNm.z + armTorqueNm.z,
    }
    return thrustN
  }) as [number, number, number, number]

  return {
    totalForceBodyN,
    torqueBodyNm,
    totalThrustN: totalForceBodyN.y,
    motorThrustsN,
  }
}
