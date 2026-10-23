import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, droneGroundContactRadius, droneGroundSupport, hoverThrottle, isFiniteDroneState, type DroneConfig } from '../drone'
import { quaternionFromRotationVector, quaternionNorm, rotateVectorByQuaternion, type Quaternion } from '../math'
import { calculateFpvCameraTransform, DEFAULT_FPV_MOUNT_POSITION_M } from '../rendering/camera'
import {
  GROUND_CRASH_WARNING,
  stepDroneState,
} from './dynamics'
import { findSweptObstacleHit, OBSTACLE_CRASH_WARNING_PREFIX, type StaticBoxCollider } from './obstacles'

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

describe('static obstacle rigid-body contact', () => {
  const config: DroneConfig = {
    ...DEFAULT_DRONE_CONFIG,
    linearDragCoefficientNPerMps: { x: 0, y: 0, z: 0 },
  }
  const gate: readonly StaticBoxCollider[] = [
    { id: 'left', centerM: { x: -2.11, y: 3, z: -8 }, halfExtentsM: { x: 0.11, y: 2.22, z: 0.175 } },
    { id: 'right', centerM: { x: 2.11, y: 3, z: -8 }, halfExtentsM: { x: 0.11, y: 2.22, z: 0.175 } },
    { id: 'top', centerM: { x: 0, y: 5.11, z: -8 }, halfExtentsM: { x: 2, y: 0.11, z: 0.175 } },
    { id: 'bottom', centerM: { x: 0, y: 0.89, z: -8 }, halfExtentsM: { x: 2, y: 0.11, z: 0.175 } },
  ]

  it('crosses the clear opening without a collision at the largest allowed timestep', () => {
    const initial = createInitialDroneState(config, { x: 0, y: 3, z: 0 })
    const state = { ...initial, velocityMps: { x: 0, y: 0, z: -160 } }
    const result = stepDroneState(state, [0, 0, 0, 0], config, 0.1, gate)
    expect(result.reset).toBe(false)
    expect(result.state.crashed).toBe(false)
    expect(result.state.positionM.z).toBe(-16)
    expect(result.warnings).toEqual([])
  })

  it.each(gate)('stops at the first $id contact without tunneling through a complete frame in one step', (box) => {
    const initial = createInitialDroneState(config, { ...box.centerM, z: 0 })
    const state = { ...initial, velocityMps: { x: 0, y: 0, z: -160 } }
    const result = stepDroneState(state, [0.4, 0.4, 0.4, 0.4], config, 0.1, gate)
    const radius = droneGroundContactRadius(config)
    expect(result.reset).toBe(false)
    expect(result.state.crashed).toBe(true)
    expect(result.state.positionM.z).toBeCloseTo(-8 + 0.175 + radius, 12)
    expect(result.state.positionM.z).toBeGreaterThan(-8)
    expect(result.state.velocityMps).toEqual({ x: 0, y: 0, z: 0 })
    expect(result.state.angularVelocityBodyRadPerSec).toEqual({ x: 0, y: 0, z: 0 })
    expect(result.state.motors.every((motor) => motor.command === 0 && motor.targetThrustN === 0 && motor.actualThrustN === 0)).toBe(true)
    expect(result.state.timeSeconds).toBe(0.1)
    expect(result.state.stepIndex).toBe(1)
    expect(result.state.warnings).toEqual([`${OBSTACLE_CRASH_WARNING_PREFIX}${box.id}; reset required.`])
    expect(result.warnings).toEqual(result.state.warnings)
    expect(isFiniteDroneState(result.state)).toBe(true)
  })

  it('uses first contact in reverse motion rather than the final penetrated pose', () => {
    const initial = createInitialDroneState(config, { ...gate[0].centerM, z: -16 })
    const result = stepDroneState({ ...initial, velocityMps: { x: 0, y: 0, z: 160 } }, [0, 0, 0, 0], config, 0.1, gate)
    expect(result.state.crashed).toBe(true)
    expect(result.state.positionM.z).toBeCloseTo(-8 - 0.175 - droneGroundContactRadius(config), 12)
    expect(result.warnings[0]).toContain('left')
  })

  it('contains propeller, camera, and configured motor geometry in every orientation', () => {
    const wideConfig: DroneConfig = {
      ...config,
      motors: config.motors.map((motor) => ({ ...motor, positionM: { x: motor.positionM.x * 4, y: 0, z: motor.positionM.z * 4 } })) as unknown as DroneConfig['motors'],
    }
    const start = { x: 1.5, y: 3, z: 0 }
    const end = { ...start, z: -16 }
    expect(findSweptObstacleHit(start, end, 0, gate)).toBeNull()
    expect(findSweptObstacleHit(start, end, droneGroundContactRadius(config), gate)).toBeNull()
    expect(droneGroundContactRadius(wideConfig)).toBeGreaterThan(0.5)
    for (const orientation of [
      { x: 0, y: 0, z: 0, w: 1 },
      quaternionFromRotationVector({ x: 0, y: Math.PI / 2, z: 0 }),
      quaternionFromRotationVector({ x: Math.PI / 3, y: 0, z: Math.PI / 4 }),
    ]) {
      const initial = createInitialDroneState(wideConfig, start, orientation)
      const result = stepDroneState({ ...initial, velocityMps: { x: 0, y: 0, z: -160 } }, [0, 0, 0, 0], wideConfig, 0.1, gate)
      expect(result.state.crashed).toBe(true)
      expect(result.warnings).toEqual([`${OBSTACLE_CRASH_WARNING_PREFIX}right; reset required.`])
    }
    const nearProp = { x: 1.8, y: 3, z: 0 }
    expect(findSweptObstacleHit(nearProp, { ...nearProp, z: -16 }, 0, gate)).toBeNull()
    expect(findSweptObstacleHit(nearProp, { ...nearProp, z: -16 }, droneGroundContactRadius(config), gate)?.colliderId).toBe('right')
  })

  it('latches an initial overlap and retains its cause through motor commands and invalid timesteps', () => {
    const initial = createInitialDroneState(config, gate[0].centerM)
    const spinning = { ...initial, angularVelocityBodyRadPerSec: { x: 0, y: 5, z: 0 } }
    const collision = stepDroneState(spinning, [0, 0, 0, 0], config, DT, gate)
    expect(collision.state.crashed).toBe(true)
    expect(collision.state.positionM).toEqual(initial.positionM)
    expect(collision.state.orientation).toEqual(initial.orientation)
    const invalidStep = stepDroneState(collision.state, [NaN, 1, 1, 1], config, NaN, [])
    expect(invalidStep.reset).toBe(false)
    expect(invalidStep.warnings[0]).toBe(`${OBSTACLE_CRASH_WARNING_PREFIX}left; reset required.`)
    let latched = invalidStep.state
    for (let index = 0; index < 24; index += 1) latched = stepDroneState(latched, [1, 1, 1, 1], config, DT, []).state
    expect(latched.positionM).toEqual(collision.state.positionM)
    expect(latched.orientation).toEqual(collision.state.orientation)
    expect(latched.crashed).toBe(true)
    expect(latched.timeSeconds).toBeCloseTo(collision.state.timeSeconds + 24 * DT)
    expect(latched.warnings).toEqual(collision.warnings)
    expect(latched.motors.every((motor) => motor.actualThrustN === 0)).toBe(true)
  })

  it('lets the ground stop a fall before an obstacle buried below the ground', () => {
    const initial = createInitialDroneState(config, { x: 0, y: 0.5, z: 0 })
    const buried: StaticBoxCollider = { id: 'buried', centerM: { x: 0, y: -2, z: 0 }, halfExtentsM: { x: 1, y: 0.1, z: 1 } }
    const result = stepDroneState({ ...initial, velocityMps: { x: 0, y: -100, z: 0 } }, [0, 0, 0, 0], config, 0.1, [buried])
    expect(result.reset).toBe(false)
    expect(result.state.crashed).toBe(true)
    expect(result.warnings).toEqual([GROUND_CRASH_WARNING])
    expect(result.state.positionM.y).toBeGreaterThan(config.ground.heightM)
  })

  it.each([0, 3.25])('cannot slide a grounded quad through a post at the largest timestep, ground height %s', (groundHeightM) => {
    const groundConfig = { ...config, ground: { ...config.ground, heightM: groundHeightM } }
    const initial = createInitialDroneState(groundConfig, { x: 0, y: groundHeightM, z: 0 })
    const post: StaticBoxCollider = { id: 'grounded-post', centerM: { x: 1.5, y: groundHeightM + 1, z: 0 }, halfExtentsM: { x: 0.1, y: 1, z: 0.1 } }
    const result = stepDroneState({ ...initial, velocityMps: { x: 30, y: 0, z: 0 } }, [0, 0, 0, 0], groundConfig, 0.1, [post])
    expect(result.reset).toBe(false)
    expect(result.state.crashed).toBe(true)
    expect(result.warnings).toEqual([`${OBSTACLE_CRASH_WARNING_PREFIX}${post.id}; reset required.`])
    expect(result.state.positionM.x).toBeCloseTo(post.centerM.x - post.halfExtentsM.x - droneGroundContactRadius(config), 12)
    expect(result.state.positionM.y).toBeCloseTo(initial.positionM.y, 12)
    expect(result.state.velocityMps).toEqual({ x: 0, y: 0, z: 0 })
  })

  it.each([
    { groundHeightM: 0, buriedTopM: -0.05 },
    { groundHeightM: 0, buriedTopM: 0 },
    { groundHeightM: 3.25, buriedTopM: 3.2 },
  ])('ignores a shallow buried box before a real post, ground=$groundHeightM top=$buriedTopM', ({ groundHeightM, buriedTopM }) => {
    const groundConfig = { ...config, ground: { ...config.ground, heightM: groundHeightM } }
    const initial = createInitialDroneState(groundConfig, { x: 0, y: groundHeightM, z: 0 })
    const buried: StaticBoxCollider = { id: 'shallow-buried', centerM: { x: 0, y: buriedTopM - 0.05, z: 0 }, halfExtentsM: { x: 0.3, y: 0.05, z: 0.3 } }
    const post: StaticBoxCollider = { id: 'real-post', centerM: { x: 1.5, y: groundHeightM + 1, z: 0 }, halfExtentsM: { x: 0.1, y: 1, z: 0.1 } }
    // A raw conservative envelope overlaps the buried box at the initial pose.
    expect(findSweptObstacleHit(initial.positionM, initial.positionM, droneGroundContactRadius(groundConfig), [buried])?.fraction).toBe(0)
    const result = stepDroneState({ ...initial, velocityMps: { x: 30, y: 0, z: 0 } }, [0, 0, 0, 0], groundConfig, 0.1, [buried, post])
    expect(result.reset).toBe(false)
    expect(result.state.crashed).toBe(true)
    expect(result.warnings).toEqual([`${OBSTACLE_CRASH_WARNING_PREFIX}${post.id}; reset required.`])
    expect(result.state.positionM.x).toBeCloseTo(post.centerM.x - post.halfExtentsM.x - droneGroundContactRadius(groundConfig), 12)
  })

  it('detects a post reached during a gentle landing followed by a ground slide', () => {
    const initial = createInitialDroneState(config, { x: 0, y: 0.2, z: 0 })
    const post: StaticBoxCollider = { id: 'after-landing', centerM: { x: 2.8, y: 1, z: 0 }, halfExtentsM: { x: 0.1, y: 1, z: 0.1 } }
    const state = { ...initial, velocityMps: { x: 30, y: -1, z: 0 } }
    const result = stepDroneState(state, [0, 0, 0, 0], config, 0.1, [post])
    const grounded = createInitialDroneState(config, { x: 0, y: 0, z: 0 })
    expect(result.reset).toBe(false)
    expect(result.state.crashed).toBe(true)
    expect(result.warnings).toEqual([`${OBSTACLE_CRASH_WARNING_PREFIX}${post.id}; reset required.`])
    expect(result.state.positionM.x).toBeCloseTo(post.centerM.x - post.halfExtentsM.x - droneGroundContactRadius(config), 12)
    expect(result.state.positionM.y).toBeCloseTo(grounded.positionM.y, 12)
  })

  it.each([
    { postX: 2, expectedWarning: `${OBSTACLE_CRASH_WARNING_PREFIX}ordered-post; reset required.` },
    { postX: 8, expectedWarning: GROUND_CRASH_WARNING },
  ])('honors first contact between a hard ground impact and a post at x=$postX', ({ postX, expectedWarning }) => {
    const initial = createInitialDroneState(config, { x: 0, y: 1, z: 0 })
    const post: StaticBoxCollider = { id: 'ordered-post', centerM: { x: postX, y: 1, z: 0 }, halfExtentsM: { x: 0.1, y: 1, z: 0.1 } }
    const result = stepDroneState({ ...initial, velocityMps: { x: 100, y: -20, z: 0 } }, [0, 0, 0, 0], config, 0.1, [post])
    expect(result.reset).toBe(false)
    expect(result.state.crashed).toBe(true)
    expect(result.warnings).toEqual([expectedWarning])
  })

  it('resets safely on invalid geometry rather than manufacturing a collision', () => {
    const invalid = { ...gate[0], halfExtentsM: { x: 0, y: 1, z: 1 } }
    const result = stepDroneState(stateAt(), [0, 0, 0, 0], config, DT, [invalid])
    expect(result.reset).toBe(true)
    expect(result.state.crashed).toBe(false)
    expect(isFiniteDroneState(result.state)).toBe(true)
    expect(result.warnings[0]).toContain('Static obstacle geometry was invalid')
  })

  it('preserves the previous empty-field trajectory and ground crash behavior exactly', () => {
    let legacy = { ...stateAt(), velocityMps: { x: 1, y: -5, z: -2 } }
    let explicitEmpty = legacy
    for (let index = 0; index < 240; index += 1) {
      const commands = index > 120 ? [1, 1, 1, 1] : [0, 0, 0, 0]
      const legacyResult = stepDroneState(legacy, commands, config, DT)
      const emptyResult = stepDroneState(explicitEmpty, commands, config, DT, [])
      expect(emptyResult).toEqual(legacyResult)
      legacy = legacyResult.state
      explicitEmpty = emptyResult.state
    }
    expect(legacy.crashed).toBe(true)
    expect(legacy.warnings).toEqual([GROUND_CRASH_WARNING])
  })
})
