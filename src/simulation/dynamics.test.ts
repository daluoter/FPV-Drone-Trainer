import { describe, expect, it } from 'vitest'
import { createInitialDroneState, DEFAULT_DRONE_CONFIG, hoverThrottle } from '../drone'
import { quaternionFromRotationVector, quaternionNorm, type Quaternion } from '../math'
import { stepDroneState } from './dynamics'

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

  it('resets safely and reports invalid timesteps and motor state', () => {
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
  })
})
