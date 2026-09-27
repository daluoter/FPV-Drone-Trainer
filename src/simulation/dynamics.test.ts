import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, droneGroundSupport, hoverThrottle, isFiniteDroneState } from '../drone'
import { quaternionFromRotationVector, quaternionNorm, rotateVectorByQuaternion, type Quaternion } from '../math'
import { calculateFpvCameraTransform, DEFAULT_FPV_MOUNT_POSITION_M } from '../rendering/camera'
import {
  GROUND_CRASH_WARNING,
  stepDroneState,
} from './dynamics'

const DT = 1 / 240

function stateAt(positionY = 2, orientation?: Quaternion) {
  const position = { x: 0, y: positionY, z: 0 }
  return orientation
    ? createInitialDroneState(DEFAULT_DRONE_CONFIG, position, orientation)
    : createInitialDroneState(DEFAULT_DRONE_CONFIG, position)
}

describe('rigid-body dynamics', () => {
  it('applies gravity in world -Y with semi-implicit integration', () => {
    const state = stateAt()
    const result = stepDroneState(state, [0, 0, 0, 0], DEFAULT_DRONE_CONFIG, DT)
    expect(result.reset).toBe(false)
    expect(result.state.velocityMps.y).toBeCloseTo(-DEFAULT_DRONE_CONFIG.gravityMps2 * DT, 12)
    expect(result.state.positionM.y).toBeCloseTo(2 - DEFAULT_DRONE_CONFIG.gravityMps2 * DT * DT, 12)
  })

  it('makes hover thrust physically possible once motor thrust is settled', () => {
    const command = hoverThrottle()
    const initial = stateAt()
    const settledMotors = initial.motors.map((motor, index) => ({
      ...motor,
      command,
      targetThrustN: command * DEFAULT_DRONE_CONFIG.motors[index].maxThrustN,
      actualThrustN: command * DEFAULT_DRONE_CONFIG.motors[index].maxThrustN,
    })) as unknown as typeof initial.motors
    const state = { ...initial, motors: settledMotors }
    const result = stepDroneState(state, [command, command, command, command], DEFAULT_DRONE_CONFIG, DT)
    expect(result.state.motors[0].actualThrustN).toBeCloseTo(
      command * DEFAULT_DRONE_CONFIG.motors[0].maxThrustN,
      12,
    )
    expect(Math.abs(result.state.velocityMps.y)).toBeLessThan(1e-9)
    expect(result.state.positionM.y).toBeCloseTo(state.positionM.y, 12)
  })

  it('transforms body thrust through attitude without a fake forward force', () => {
    const pitchedOrientation = quaternionFromRotationVector({ x: Math.PI / 2, y: 0, z: 0 })
    const result = stepDroneState(stateAt(2, pitchedOrientation), [1, 1, 1, 1], DEFAULT_DRONE_CONFIG, DT)
    expect(result.state.velocityMps.z).toBeGreaterThan(0)
    expect(Math.abs(result.state.velocityMps.x)).toBeLessThan(1e-12)

    const invertedOrientation = quaternionFromRotationVector({ x: Math.PI, y: 0, z: 0 })
    const inverted = stepDroneState(stateAt(2, invertedOrientation), [1, 1, 1, 1], DEFAULT_DRONE_CONFIG, DT)
    expect(inverted.state.velocityMps.y).toBeLessThan(-DEFAULT_DRONE_CONFIG.gravityMps2 * DT)
    expect(inverted.state.crashed).toBe(false)
  })

  it('keeps quaternion norm stable and does not self-level', () => {
    let state = stateAt()
    for (let index = 0; index < 1_000; index += 1) {
      state = stepDroneState(state, [0.2, 0.2, 0.2, 0.2], DEFAULT_DRONE_CONFIG, DT).state
    }
    expect(quaternionNorm(state.orientation)).toBeCloseTo(1, 12)
    expect(state.orientation.x).toBeCloseTo(0, 12)
    expect(state.orientation.y).toBeCloseTo(0, 12)
    expect(state.orientation.z).toBeCloseTo(0, 12)
  })

  it('does not invent angular motion from centered zero torque', () => {
    const state = stateAt()
    const result = stepDroneState(state, [0, 0, 0, 0], DEFAULT_DRONE_CONFIG, DT)
    expect(result.state.angularVelocityBodyRadPerSec).toEqual({ x: 0, y: 0, z: 0 })
    expect(result.state.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 })
  })

  it('leaves inverted airborne attitude unconstrained by the ground support model', () => {
    const orientation = quaternionFromRotationVector({ x: Math.PI, y: 0, z: 0 })
    let state = stateAt(10, orientation)
    for (let index = 0; index < 120; index += 1) {
      state = stepDroneState(state, [hoverThrottle(), hoverThrottle(), hoverThrottle(), hoverThrottle()], DEFAULT_DRONE_CONFIG, DT).state
      expect(state.crashed).toBe(false)
    }
    expect(state.orientation).toEqual(stateAt(10, orientation).orientation)
    expect(state.positionM.y).toBeGreaterThan(DEFAULT_DRONE_CONFIG.ground.heightM + 1)
  })

  it('applies the Euler gyroscopic term with the documented sign', () => {
    const config = {
      ...DEFAULT_DRONE_CONFIG,
      inertiaKgM2: { x: 2, y: 3, z: 5 },
      angularDragCoefficientNmPerRadPerSec: { x: 0, y: 0, z: 0 },
    }
    const initial = createInitialDroneState(config, { x: 0, y: 2, z: 0 })
    const state = { ...initial, angularVelocityBodyRadPerSec: { x: 1, y: 2, z: 3 } }
    const deltaSeconds = 0.001
    const result = stepDroneState(state, [0, 0, 0, 0], config, deltaSeconds)

    expect(result.reset).toBe(false)
    expect(result.state.angularVelocityBodyRadPerSec.x).toBeCloseTo(1 - 6 * deltaSeconds, 12)
    expect(result.state.angularVelocityBodyRadPerSec.y).toBeCloseTo(2 + 3 * deltaSeconds, 12)
    expect(result.state.angularVelocityBodyRadPerSec.z).toBeCloseTo(3 - 0.4 * deltaSeconds, 12)
  })

  it('supports neutral ground rest without rotating or sinking over a long timeline', () => {
    const groundHeightM = DEFAULT_DRONE_CONFIG.ground.heightM
    let state = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: 0, y: groundHeightM, z: 0 })
    const support = droneGroundSupport(DEFAULT_DRONE_CONFIG, state.orientation)

    for (let index = 0; index < 2_400; index += 1) {
      const result = stepDroneState(state, [0, 0, 0, 0], DEFAULT_DRONE_CONFIG, DT)
      expect(result.state.crashed).toBe(false)
      state = result.state
    }

    expect(state.positionM.y).toBeCloseTo(groundHeightM + support.supportOffsetM + 0.001, 9)
    expect(state.velocityMps).toEqual({ x: 0, y: 0, z: 0 })
    expect(state.angularVelocityBodyRadPerSec).toEqual({ x: 0, y: 0, z: 0 })
    expect(state.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 })
  })

  it('contains the FPV near plane and prop/body contact envelope during a grounded pitch-roll tip-over', () => {
    const groundHeightM = DEFAULT_DRONE_CONFIG.ground.heightM
    const initial = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: 0, y: groundHeightM, z: 0 })
    let state = initial
    const pitchAndRollCommands = [
      [0.15, 0.15, 0, 0],
      [0.15, 0, 0.15, 0],
    ] as const

    for (const commands of pitchAndRollCommands) {
      let attempt = initial
      for (let index = 0; index < 10_000 && !attempt.crashed; index += 1) {
        attempt = stepDroneState(attempt, commands, DEFAULT_DRONE_CONFIG, DT).state
        const support = droneGroundSupport(DEFAULT_DRONE_CONFIG, attempt.orientation)
        expect(attempt.positionM.y - support.supportOffsetM).toBeGreaterThanOrEqual(groundHeightM - 1e-10)
        const camera = calculateFpvCameraTransform(attempt, {
          fpvMountPositionM: DEFAULT_FPV_MOUNT_POSITION_M,
          fpvMountAngleDegrees: 50,
        })
        const nearPlaneHalfHeight = 0.01 * Math.tan(Math.PI / 3)
        const nearPlaneHalfWidth = nearPlaneHalfHeight * 4
        for (const xSign of [-1, 1]) {
          for (const ySign of [-1, 1]) {
            const nearPlaneOffset = rotateVectorByQuaternion(camera.orientation, {
              x: xSign * nearPlaneHalfWidth,
              y: ySign * nearPlaneHalfHeight,
              z: -0.01,
            })
            expect(camera.position.y + nearPlaneOffset.y).toBeGreaterThanOrEqual(groundHeightM - 1e-10)
          }
        }
      }
      expect(attempt.crashed).toBe(true)
      expect(attempt.warnings).toContain(GROUND_CRASH_WARNING)
      state = attempt
    }
    expect(state.motors.every((motor) => motor.command === 0 && motor.targetThrustN === 0 && motor.actualThrustN === 0)).toBe(true)
    expect(state.angularVelocityBodyRadPerSec).toEqual({ x: 0, y: 0, z: 0 })
    const crashedPose = { positionM: state.positionM, orientation: state.orientation }
    const invalidCrashedStep = stepDroneState(state, [Number.NaN, 0, 0, 0], DEFAULT_DRONE_CONFIG, Number.NaN)
    expect(invalidCrashedStep.reset).toBe(false)
    expect(invalidCrashedStep.state.crashed).toBe(true)
    expect(invalidCrashedStep.state.positionM).toEqual(crashedPose.positionM)
    state = invalidCrashedStep.state
    for (let index = 0; index < 1_000; index += 1) {
      state = stepDroneState(state, [1, 1, 1, 1], DEFAULT_DRONE_CONFIG, DT).state
    }
    expect(state.crashed).toBe(true)
    expect(state.positionM).toEqual(crashedPose.positionM)
    expect(state.orientation).toEqual(crashedPose.orientation)
    expect(state.motors.every((motor) => motor.command === 0 && motor.targetThrustN === 0 && motor.actualThrustN === 0)).toBe(true)
  })

  it('supports thrust takeoff and a gentle upright landing without a crash latch', () => {
    const config = DEFAULT_DRONE_CONFIG
    const support = droneGroundSupport(config, { x: 0, y: 0, z: 0, w: 1 })
    const hover = hoverThrottle(config)
    const initial = createInitialDroneState(config, { x: 0, y: config.ground.heightM, z: 0 })
    const settled = {
      ...initial,
      motors: initial.motors.map((motor, index) => ({
        ...motor,
        command: hover,
        targetThrustN: config.motors[index].maxThrustN * hover,
        actualThrustN: config.motors[index].maxThrustN * hover,
      })) as unknown as typeof initial.motors,
    }
    const resting = stepDroneState(settled, [hover, hover, hover, hover], config, DT).state
    expect(resting.positionM.y).toBeCloseTo(config.ground.heightM + support.supportOffsetM + 0.001, 9)

    let takeoff = resting
    for (let index = 0; index < 240; index += 1) {
      takeoff = stepDroneState(takeoff, [1, 1, 1, 1], config, DT).state
    }
    expect(takeoff.positionM.y).toBeGreaterThan(resting.positionM.y + 0.5)
    expect(takeoff.crashed).toBe(false)

    const landingStart = createInitialDroneState(config, {
      x: 0,
      y: config.ground.heightM + support.supportOffsetM + 0.5,
      z: 0,
    })
    let landing = { ...landingStart, velocityMps: { x: 0, y: -1, z: 0 } }
    for (let index = 0; index < 300; index += 1) {
      landing = stepDroneState(landing, [0, 0, 0, 0], config, DT).state
    }
    expect(landing.crashed).toBe(false)
    expect(landing.positionM.y - droneGroundSupport(config, landing.orientation).supportOffsetM)
      .toBeGreaterThanOrEqual(config.ground.heightM - 1e-10)
  })

  it('latches tilted, inverted, and hard ground impacts at a supported pose', () => {
    const config = DEFAULT_DRONE_CONFIG
    const orientations = [
      quaternionFromRotationVector({ x: Math.PI / 3, y: 0, z: 0 }),
      quaternionFromRotationVector({ x: Math.PI, y: 0, z: 0 }),
    ]
    for (const orientation of orientations) {
      const support = droneGroundSupport(config, orientation)
      let state = createInitialDroneState(config, {
        x: 0,
        y: config.ground.heightM + support.supportOffsetM + 0.2,
        z: 0,
      }, orientation)
      state = { ...state, velocityMps: { x: 0, y: -1, z: 0 } }
      for (let index = 0; index < 500 && !state.crashed; index += 1) {
        state = stepDroneState(state, [0, 0, 0, 0], config, DT).state
      }
      expect(state.crashed).toBe(true)
      expect(state.positionM.y - droneGroundSupport(config, state.orientation).supportOffsetM)
        .toBeGreaterThanOrEqual(config.ground.heightM - 1e-10)
    }

    const upright = createInitialDroneState(config, { x: 0, y: config.ground.heightM, z: 0 })
    const support = droneGroundSupport(config, upright.orientation)
    const hardImpact = {
      ...upright,
      positionM: { ...upright.positionM, y: config.ground.heightM + support.supportOffsetM + 0.01 },
      velocityMps: { x: 0, y: -10, z: 0 },
    }
    const crash = stepDroneState(hardImpact, [1, 1, 1, 1], config, DT)
    expect(crash.state.crashed).toBe(true)
    expect(crash.warnings).toContain(GROUND_CRASH_WARNING)
    expect(crash.state.velocityMps).toEqual({ x: 0, y: 0, z: 0 })
    expect(crash.state.motors.every((motor) => motor.actualThrustN === 0)).toBe(true)
  })

  it('keeps initial spawn support above a configured nonzero ground plane', () => {
    const config = {
      ...DEFAULT_DRONE_CONFIG,
      ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 3.25 },
      spawnPositionM: { x: 1, y: 0.5, z: -2 },
    }
    const state = createInitialDroneState(config)
    const support = droneGroundSupport(config, state.orientation)
    expect(state.positionM.y).toBeGreaterThan(config.ground.heightM)
    expect(state.positionM.y - support.supportOffsetM).toBeGreaterThanOrEqual(config.ground.heightM)
    const after = stepDroneState(state, [0, 0, 0, 0], config, DT).state
    expect(after.positionM.y - support.supportOffsetM).toBeGreaterThanOrEqual(config.ground.heightM - 1e-10)
  })

  it('resets safely and reports invalid timesteps, state time and motor state', () => {
    const invalidStep = stepDroneState(stateAt(), [0, 0, 0, 0], DEFAULT_DRONE_CONFIG, Number.NaN)
    expect(invalidStep.reset).toBe(true)
    expect(invalidStep.state.warnings[0]).toContain('Invalid integration timestep')
    expect(invalidStep.state.positionM).toEqual(DEFAULT_DRONE_CONFIG.spawnPositionM)

    const base = stateAt()
    const invalidMotorState = {
      ...base,
      motors: base.motors.map((motor, index) => index === 0 ? { ...motor, actualThrustN: -1 } : motor) as unknown as typeof base.motors,
    }
    const invalidMotor = stepDroneState(invalidMotorState, [0, 0, 0, 0], DEFAULT_DRONE_CONFIG, DT)
    expect(invalidMotor.reset).toBe(true)
    expect(invalidMotor.state.warnings[0]).toContain('Drone state was invalid')

    const negativeTimeState = { ...base, timeSeconds: -1 }
    expect(isFiniteDroneState(negativeTimeState)).toBe(false)
    const negativeTime = stepDroneState(negativeTimeState, [0, 0, 0, 0], DEFAULT_DRONE_CONFIG, DT)
    expect(negativeTime.reset).toBe(true)
    expect(negativeTime.state.timeSeconds).toBe(0)
  })
})
