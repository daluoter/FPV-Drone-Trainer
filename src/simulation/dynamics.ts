import {
  addVector3,
  crossVector3,
  divideVector3,
  inverseRotateVectorByQuaternion,
  integrateBodyAngularVelocity,
  isFiniteVector3,
  multiplyVector3,
  normalizeQuaternion,
  rotateVectorByQuaternion,
  scaleVector3,
  subtractVector3,
  vector3,
  type Vector3,
} from '../math'
import {
  DEFAULT_DRONE_CONFIG,
  validateDroneConfig,
  calculateMotorForces,
  advanceMotorState,
  createInitialDroneState,
  isFiniteDroneState,
  resetDroneState,
  type DroneConfig,
  type DroneState,
  type DroneStepResult,
} from '../drone'

export const MAX_INTEGRATION_DT_SECONDS = 0.1

function safeStepFailure(
  state: DroneState,
  config: DroneConfig,
  warning: string,
): DroneStepResult {
  const safeConfig = validateDroneConfig(config).valid ? config : DEFAULT_DRONE_CONFIG
  const resetState = resetDroneState(safeConfig, state, [warning])
  return { state: resetState, warnings: [warning], reset: true }
}

function finiteStateVector(value: Vector3, label: string): string | null {
  return isFiniteVector3(value) ? null : `${label} became non-finite.`
}

function resolveGroundCollision(
  positionM: Vector3,
  velocityMps: Vector3,
  config: DroneConfig,
): { readonly positionM: Vector3; readonly velocityMps: Vector3 } {
  if (positionM.y >= config.ground.heightM) return { positionM, velocityMps }
  const normalVelocity = velocityMps.y < 0 ? -velocityMps.y * config.ground.restitution : velocityMps.y
  return {
    positionM: { x: positionM.x, y: config.ground.heightM, z: positionM.z },
    velocityMps: {
      x: velocityMps.x * config.ground.tangentialVelocityRetention,
      y: normalVelocity,
      z: velocityMps.z * config.ground.tangentialVelocityRetention,
    },
  }
}

function validateCommands(commands: readonly number[]): boolean {
  return commands.length === 4 && commands.every((command) => Number.isFinite(command))
}

/**
 * Advance one deterministic fixed simulation step. The state orientation is
 * body-to-world and angular velocity is body-frame; all forces and torques are
 * integrated explicitly here rather than delegated to a rendering engine.
 */
export function stepDroneState(
  state: DroneState,
  motorCommands: readonly number[],
  config: DroneConfig = DEFAULT_DRONE_CONFIG,
  deltaSeconds = 1 / 240,
): DroneStepResult {
  const configValidation = validateDroneConfig(config)
  if (!configValidation.valid) {
    return safeStepFailure(state, DEFAULT_DRONE_CONFIG, `Invalid drone configuration: ${configValidation.errors.join(' ')}`)
  }
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || deltaSeconds > MAX_INTEGRATION_DT_SECONDS) {
    return safeStepFailure(state, config, `Invalid integration timestep ${String(deltaSeconds)} seconds.`)
  }
  if (!isFiniteDroneState(state)) return safeStepFailure(state, config, 'Drone state was invalid before integration.')
  if (!validateCommands(motorCommands)) return safeStepFailure(state, config, 'Motor commands were invalid before integration.')

  const orientation = normalizeQuaternion(state.orientation)
  const motors = state.motors.map((motorState, index) => (
    advanceMotorState(motorState, motorCommands[index], config.motors[index], deltaSeconds)
  )) as unknown as DroneState['motors']
  const motorForces = calculateMotorForces(motors, config)

  const bodyVelocityMps = inverseRotateVectorByQuaternion(orientation, state.velocityMps)
  const linearDragBodyN = scaleVector3(
    multiplyVector3(config.linearDragCoefficientNPerMps, bodyVelocityMps),
    -1,
  )
  const totalForceWorldN = addVector3(
    rotateVectorByQuaternion(orientation, addVector3(motorForces.totalForceBodyN, linearDragBodyN)),
    vector3(0, -config.massKg * config.gravityMps2, 0),
  )
  const linearAccelerationMps2 = scaleVector3(totalForceWorldN, 1 / config.massKg)
  const velocityMps = addVector3(state.velocityMps, scaleVector3(linearAccelerationMps2, deltaSeconds))
  const unconstrainedPositionM = addVector3(state.positionM, scaleVector3(velocityMps, deltaSeconds))
  const groundResolved = resolveGroundCollision(unconstrainedPositionM, velocityMps, config)

  const angularVelocity = state.angularVelocityBodyRadPerSec
  const angularMomentum = multiplyVector3(config.inertiaKgM2, angularVelocity)
  const gyroscopicTerm = crossVector3(angularVelocity, angularMomentum)
  const angularDragBodyNm = scaleVector3(
    multiplyVector3(config.angularDragCoefficientNmPerRadPerSec, angularVelocity),
    -1,
  )
  const totalTorqueBodyNm = addVector3(motorForces.torqueBodyNm, angularDragBodyNm)
  const angularAccelerationBodyRadPerSec2 = divideVector3(
    subtractVector3(totalTorqueBodyNm, gyroscopicTerm),
    config.inertiaKgM2,
  )
  const angularVelocityBodyRadPerSec = addVector3(
    angularVelocity,
    scaleVector3(angularAccelerationBodyRadPerSec2, deltaSeconds),
  )
  const nextOrientation = integrateBodyAngularVelocity(
    orientation,
    angularVelocityBodyRadPerSec,
    deltaSeconds,
  )

  const nextState: DroneState = {
    positionM: groundResolved.positionM,
    velocityMps: groundResolved.velocityMps,
    orientation: nextOrientation,
    angularVelocityBodyRadPerSec,
    motors,
    timeSeconds: state.timeSeconds + deltaSeconds,
    stepIndex: state.stepIndex + 1,
    warnings: [],
  }
  const finiteWarning = [
    finiteStateVector(nextState.positionM, 'Position'),
    finiteStateVector(nextState.velocityMps, 'Velocity'),
    finiteStateVector(nextState.angularVelocityBodyRadPerSec, 'Angular velocity'),
  ].find((warning): warning is string => warning !== null)
  const exploded =
    Math.sqrt(nextState.positionM.x ** 2 + nextState.positionM.y ** 2 + nextState.positionM.z ** 2) > config.safety.maxDistanceFromOriginM ||
    Math.sqrt(nextState.velocityMps.x ** 2 + nextState.velocityMps.y ** 2 + nextState.velocityMps.z ** 2) > config.safety.maxLinearSpeedMps ||
    Math.sqrt(nextState.angularVelocityBodyRadPerSec.x ** 2 + nextState.angularVelocityBodyRadPerSec.y ** 2 + nextState.angularVelocityBodyRadPerSec.z ** 2) > config.safety.maxAngularSpeedRadPerSec

  if (finiteWarning) return safeStepFailure(state, config, finiteWarning)
  if (!isFiniteDroneState(nextState)) return safeStepFailure(state, config, 'Drone state became invalid during integration.')
  if (exploded) return safeStepFailure(state, config, 'Drone state exceeded a configured safety limit and was reset.')

  return { state: nextState, warnings: [], reset: false }
}

export function createSafeInitialState(config: DroneConfig = DEFAULT_DRONE_CONFIG): DroneState {
  const validation = validateDroneConfig(config)
  if (validation.valid) return createInitialDroneState(config)
  return {
    ...createInitialDroneState(DEFAULT_DRONE_CONFIG),
    warnings: [`Invalid drone configuration; defaults were used: ${validation.errors.join(' ')}`],
  }
}
