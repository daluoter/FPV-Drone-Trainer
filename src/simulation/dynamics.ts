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
  droneGroundContactRadius,
  droneGroundSupport,
  DRONE_GROUND_CLEARANCE_M,
  type DroneConfig,
  type DroneState,
  type DroneStepResult,
} from '../drone'

export const MAX_INTEGRATION_DT_SECONDS = 0.1
export const GROUND_CONTACT_SLOP_M = 0.002
export const GROUND_HARD_IMPACT_SPEED_MPS = 4
export const GROUND_TIP_OVER_ANGLE_DEGREES = 50
export const GROUND_CONTACT_ANGULAR_DAMPING_PER_SECOND = 8
export const GROUND_SETTLE_SPEED_MPS = 0.5
export const GROUND_CRASH_WARNING = 'Ground impact or tip-over latched a crash; reset is required before re-arming.'

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

function stoppedMotors(): DroneState['motors'] {
  const stopped = { command: 0, targetThrustN: 0, actualThrustN: 0 }
  return [stopped, stopped, stopped, stopped] as DroneState['motors']
}

function contactResponse(
  positionM: Vector3,
  velocityMps: Vector3,
  orientation: DroneState['orientation'],
  angularVelocityBodyRadPerSec: Vector3,
  config: DroneConfig,
  deltaSeconds: number,
): {
  readonly positionM: Vector3
  readonly velocityMps: Vector3
  readonly angularVelocityBodyRadPerSec: Vector3
  readonly crashed: boolean
} {
  if (positionM.y > config.ground.heightM + droneGroundContactRadius(config) + GROUND_CONTACT_SLOP_M) {
    return { positionM, velocityMps, angularVelocityBodyRadPerSec, crashed: false }
  }
  const support = droneGroundSupport(config, orientation)
  const groundBottomY = positionM.y - support.supportOffsetM
  if (groundBottomY > config.ground.heightM + GROUND_CONTACT_SLOP_M) {
    return { positionM, velocityMps, angularVelocityBodyRadPerSec, crashed: false }
  }

  const angularVelocityWorld = rotateVectorByQuaternion(orientation, angularVelocityBodyRadPerSec)
  const contactVelocityY = velocityMps.y + crossVector3(
    angularVelocityWorld,
    support.lowestPointOffsetWorldM,
  ).y
  const bodyUpWorld = rotateVectorByQuaternion(orientation, vector3(0, 1, 0))
  const tiltDegrees = Math.acos(Math.max(-1, Math.min(1, bodyUpWorld.y))) * 180 / Math.PI
  const impact = contactVelocityY <= -GROUND_HARD_IMPACT_SPEED_MPS
  const tipped = tiltDegrees >= GROUND_TIP_OVER_ANGLE_DEGREES
  const supportedPositionM = {
    ...positionM,
    y: Math.max(positionM.y, config.ground.heightM + support.supportOffsetM + DRONE_GROUND_CLEARANCE_M),
  }
  if (impact || tipped) {
    return {
      positionM: supportedPositionM,
      velocityMps: vector3(),
      angularVelocityBodyRadPerSec: vector3(),
      crashed: true,
    }
  }

  const descending = contactVelocityY < GROUND_SETTLE_SPEED_MPS
  const normalVelocity = descending && velocityMps.y < 0
    ? -velocityMps.y * config.ground.restitution
    : velocityMps.y
  return {
    positionM: supportedPositionM,
    velocityMps: {
      x: velocityMps.x * config.ground.tangentialVelocityRetention,
      y: velocityMps.y < 0 && Math.abs(normalVelocity) < GROUND_SETTLE_SPEED_MPS ? 0 : normalVelocity,
      z: velocityMps.z * config.ground.tangentialVelocityRetention,
    },
    angularVelocityBodyRadPerSec: descending
      ? scaleVector3(angularVelocityBodyRadPerSec, Math.exp(-GROUND_CONTACT_ANGULAR_DAMPING_PER_SECOND * deltaSeconds))
      : angularVelocityBodyRadPerSec,
    crashed: false,
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
  if (state.crashed && isFiniteDroneState(state)) {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || deltaSeconds > MAX_INTEGRATION_DT_SECONDS) {
      const warning = `Invalid integration timestep ${String(deltaSeconds)} seconds; crashed state remains latched.`
      const latchedState = { ...state, warnings: [GROUND_CRASH_WARNING, warning] }
      return { state: latchedState, warnings: [GROUND_CRASH_WARNING, warning], reset: false }
    }
    const crashedState: DroneState = {
      ...state,
      velocityMps: vector3(),
      angularVelocityBodyRadPerSec: vector3(),
      motors: stoppedMotors(),
      timeSeconds: state.timeSeconds + deltaSeconds,
      stepIndex: state.stepIndex + 1,
      warnings: [GROUND_CRASH_WARNING],
    }
    return { state: crashedState, warnings: [GROUND_CRASH_WARNING], reset: false }
  }
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
  const groundResolved = contactResponse(
    unconstrainedPositionM,
    velocityMps,
    nextOrientation,
    angularVelocityBodyRadPerSec,
    config,
    deltaSeconds,
  )
  const crashWarnings = groundResolved.crashed ? [GROUND_CRASH_WARNING] : []

  const nextState: DroneState = {
    positionM: groundResolved.positionM,
    velocityMps: groundResolved.velocityMps,
    orientation: nextOrientation,
    angularVelocityBodyRadPerSec: groundResolved.angularVelocityBodyRadPerSec,
    motors: groundResolved.crashed ? stoppedMotors() : motors,
    timeSeconds: state.timeSeconds + deltaSeconds,
    stepIndex: state.stepIndex + 1,
    crashed: groundResolved.crashed,
    warnings: crashWarnings,
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

  return { state: nextState, warnings: crashWarnings, reset: false }
}

export function createSafeInitialState(config: DroneConfig = DEFAULT_DRONE_CONFIG): DroneState {
  const validation = validateDroneConfig(config)
  if (validation.valid) return createInitialDroneState(config)
  return {
    ...createInitialDroneState(DEFAULT_DRONE_CONFIG),
    warnings: [`Invalid drone configuration; defaults were used: ${validation.errors.join(' ')}`],
  }
}
