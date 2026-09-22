import { describe, expect, it } from 'vitest'

import { multiplyQuaternions, quaternionFromRotationVector, quaternionNearlyEqual } from '../math'
import {
  DEFAULT_FPV_MOUNT_ANGLE_DEGREES,
  DEFAULT_FPV_MOUNT_POSITION_M,
  calculateFpvCameraTransform,
  createCameraRig,
  updateCameraRig,
} from './camera'

describe('Free Flight camera contracts', () => {
  it('keeps the FPV mount rigid in body coordinates and applies the configured angle', () => {
    const orientation = quaternionFromRotationVector({ x: 0, y: Math.PI / 2, z: 0 })
    const transform = calculateFpvCameraTransform({
      positionM: { x: 2, y: 1, z: -3 },
      orientation,
    })

    expect(transform.position.x).toBeCloseTo(2 + DEFAULT_FPV_MOUNT_POSITION_M.z, 10)
    expect(transform.position.y).toBeCloseTo(1 + DEFAULT_FPV_MOUNT_POSITION_M.y, 10)
    expect(transform.position.z).toBeCloseTo(-3, 10)
    expect(quaternionNearlyEqual(
      transform.orientation,
      // Body attitude followed by the fixed camera pitch, never an Euler pose edit.
      multiplyQuaternions(
        orientation,
        quaternionFromRotationVector({ x: DEFAULT_FPV_MOUNT_ANGLE_DEGREES * Math.PI / 180, y: 0, z: 0 }),
      ),
      1e-10,
    )).toBe(true)
    expect(DEFAULT_FPV_MOUNT_ANGLE_DEGREES).toBe(20)
  })

  it('updates FPV, chase, and free/debug cameras from one simulation state', () => {
    const rig = createCameraRig({ aspect: 2 })
    const state = {
      positionM: { x: 1, y: 2, z: 3 },
      orientation: quaternionFromRotationVector({ x: 0, y: 0.2, z: 0 }),
    }
    const active = updateCameraRig(rig, state, 'fpv')
    expect(active).toBe(rig.fpv)
    expect(rig.fpv.aspect).toBe(2)
    expect(rig.fpv.fov).toBe(90)
    expect(rig.chase.position.distanceTo(rig.fpv.position)).toBeGreaterThan(1)

    expect(updateCameraRig(rig, state, 'chase')).toBe(rig.chase)
    expect(updateCameraRig(rig, state, 'free')).toBe(rig.free)
    const freePosition = rig.free.position.clone()
    updateCameraRig(rig, { ...state, positionM: { x: 20, y: 20, z: 20 } }, 'free')
    expect(rig.free.position.equals(freePosition)).toBe(true)
  })
})
