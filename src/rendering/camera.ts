import * as THREE from 'three'

import {
  multiplyQuaternions,
  normalizeQuaternion,
  rotateVectorByQuaternion,
  quaternionFromRotationVector,
  type Quaternion,
} from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import type { DroneState } from '../drone'

export type CameraMode = 'fpv' | 'chase' | 'free'

export const DEFAULT_FPV_FOV_DEGREES = 90
export const DEFAULT_FPV_MOUNT_ANGLE_DEGREES = 20
export const DEFAULT_FPV_MOUNT_POSITION_M: Vector3 = Object.freeze({ x: 0, y: 0.08, z: -0.11 })
export const DEFAULT_CHASE_OFFSET_M: Vector3 = Object.freeze({ x: 0, y: 1.8, z: 4.2 })
export const DEFAULT_CHASE_LOOK_AT_OFFSET_M: Vector3 = Object.freeze({ x: 0, y: 0.25, z: 0 })

export interface CameraRigOptions {
  readonly fpvFovDegrees?: number
  readonly fpvMountAngleDegrees?: number
  readonly fpvMountPositionM?: Vector3
  readonly chaseOffsetM?: Vector3
  readonly chaseLookAtOffsetM?: Vector3
  readonly aspect?: number
  readonly near?: number
  readonly far?: number
}

export interface CameraTransform {
  readonly position: Vector3
  readonly orientation: Quaternion
}

export interface FlightCameraRig {
  readonly fpv: THREE.PerspectiveCamera
  readonly chase: THREE.PerspectiveCamera
  readonly free: THREE.PerspectiveCamera
  readonly cameras: readonly [THREE.PerspectiveCamera, THREE.PerspectiveCamera, THREE.PerspectiveCamera]
  readonly options: Required<Pick<CameraRigOptions, 'fpvFovDegrees' | 'fpvMountAngleDegrees' | 'fpvMountPositionM' | 'chaseOffsetM' | 'chaseLookAtOffsetM'>>
  mode: CameraMode
  freeInitialized: boolean
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function vectorOr(value: Vector3 | undefined, fallback: Vector3): Vector3 {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    return fallback
  }
  return { x: value.x, y: value.y, z: value.z }
}

function cameraQuaternionFromCore(value: Quaternion): THREE.Quaternion {
  return new THREE.Quaternion(value.x, value.y, value.z, value.w).normalize()
}

function coreQuaternionFromThree(value: THREE.Quaternion): Quaternion {
  return normalizeQuaternion({ x: value.x, y: value.y, z: value.z, w: value.w })
}

function positionFromThree(value: THREE.Vector3): Vector3 {
  return { x: value.x, y: value.y, z: value.z }
}

/**
 * Compute the rigid FPV transform without involving a Three.js object. The
 * mount is expressed in body coordinates, so the camera follows both the
 * drone translation and its authoritative body-to-world quaternion.
 */
export function calculateFpvCameraTransform(
  state: Pick<DroneState, 'positionM' | 'orientation'>,
  options: Pick<CameraRigOptions, 'fpvMountAngleDegrees' | 'fpvMountPositionM'> = {},
): CameraTransform {
  const mountPosition = vectorOr(options.fpvMountPositionM, DEFAULT_FPV_MOUNT_POSITION_M)
  const mountAngle = finiteOr(options.fpvMountAngleDegrees, DEFAULT_FPV_MOUNT_ANGLE_DEGREES) * Math.PI / 180
  const mountOrientation = quaternionFromRotationVector({ x: mountAngle, y: 0, z: 0 })
  const positionOffset = rotateVectorByQuaternion(state.orientation, mountPosition)
  return {
    position: {
      x: state.positionM.x + positionOffset.x,
      y: state.positionM.y + positionOffset.y,
      z: state.positionM.z + positionOffset.z,
    },
    orientation: multiplyQuaternions(normalizeQuaternion(state.orientation), mountOrientation),
  }
}

export const getFpvCameraTransform = calculateFpvCameraTransform

/** Build the three independent cameras used by the Free Flight screen. */
export function createCameraRig(options: CameraRigOptions = {}): FlightCameraRig {
  const fpvFovDegrees = finiteOr(options.fpvFovDegrees, DEFAULT_FPV_FOV_DEGREES)
  const fpvMountAngleDegrees = finiteOr(options.fpvMountAngleDegrees, DEFAULT_FPV_MOUNT_ANGLE_DEGREES)
  const fpvMountPositionM = vectorOr(options.fpvMountPositionM, DEFAULT_FPV_MOUNT_POSITION_M)
  const chaseOffsetM = vectorOr(options.chaseOffsetM, DEFAULT_CHASE_OFFSET_M)
  const chaseLookAtOffsetM = vectorOr(options.chaseLookAtOffsetM, DEFAULT_CHASE_LOOK_AT_OFFSET_M)
  const aspect = finiteOr(options.aspect, 16 / 9)
  const near = finiteOr(options.near, 0.01)
  const far = finiteOr(options.far, 10_000)
  const fpv = new THREE.PerspectiveCamera(fpvFovDegrees, aspect, near, far)
  const chase = new THREE.PerspectiveCamera(60, aspect, near, far)
  const free = new THREE.PerspectiveCamera(60, aspect, near, far)
  free.position.set(4, 3, 6)
  free.lookAt(0, 0.5, 0)
  return {
    fpv,
    chase,
    free,
    cameras: [fpv, chase, free],
    options: {
      fpvFovDegrees,
      fpvMountAngleDegrees,
      fpvMountPositionM,
      chaseOffsetM,
      chaseLookAtOffsetM,
    },
    mode: 'fpv',
    freeInitialized: false,
  }
}

function applyFpvCamera(
  camera: THREE.PerspectiveCamera,
  state: Pick<DroneState, 'positionM' | 'orientation'>,
  rig: FlightCameraRig,
): void {
  const transform = calculateFpvCameraTransform(state, rig.options)
  camera.position.set(transform.position.x, transform.position.y, transform.position.z)
  camera.quaternion.copy(cameraQuaternionFromCore(transform.orientation))
  camera.fov = rig.options.fpvFovDegrees
  camera.updateProjectionMatrix()
}

function applyChaseCamera(
  camera: THREE.PerspectiveCamera,
  state: Pick<DroneState, 'positionM' | 'orientation'>,
  rig: FlightCameraRig,
): void {
  const chaseOffset = rotateVectorByQuaternion(state.orientation, rig.options.chaseOffsetM)
  camera.position.set(
    state.positionM.x + chaseOffset.x,
    state.positionM.y + chaseOffset.y,
    state.positionM.z + chaseOffset.z,
  )
  const target = new THREE.Vector3(
    state.positionM.x + rig.options.chaseLookAtOffsetM.x,
    state.positionM.y + rig.options.chaseLookAtOffsetM.y,
    state.positionM.z + rig.options.chaseLookAtOffsetM.z,
  )
  camera.lookAt(target)
}

function initializeFreeCamera(camera: THREE.PerspectiveCamera, state: Pick<DroneState, 'positionM'>): void {
  camera.position.set(state.positionM.x + 4, state.positionM.y + 3, state.positionM.z + 6)
  camera.lookAt(state.positionM.x, state.positionM.y, state.positionM.z)
}

/** Update all camera transforms from the immutable simulation state. */
export function updateCameraRig(
  rig: FlightCameraRig,
  state: Pick<DroneState, 'positionM' | 'orientation'>,
  mode: CameraMode = rig.mode,
): THREE.PerspectiveCamera {
  rig.mode = mode
  applyFpvCamera(rig.fpv, state, rig)
  applyChaseCamera(rig.chase, state, rig)
  if (!rig.freeInitialized) {
    initializeFreeCamera(rig.free, state)
    rig.freeInitialized = true
  }
  return mode === 'fpv' ? rig.fpv : mode === 'chase' ? rig.chase : rig.free
}

export function setFreeCameraTransform(
  rig: FlightCameraRig,
  position: Vector3,
  target: Vector3,
): void {
  rig.free.position.set(position.x, position.y, position.z)
  rig.free.lookAt(target.x, target.y, target.z)
  rig.freeInitialized = true
}

export function activeCamera(rig: FlightCameraRig): THREE.PerspectiveCamera {
  return rig.mode === 'fpv' ? rig.fpv : rig.mode === 'chase' ? rig.chase : rig.free
}

/** Useful for camera contract tests and renderer consumers that need a plain quaternion. */
export function getActiveCameraTransform(rig: FlightCameraRig): CameraTransform {
  const camera = activeCamera(rig)
  return {
    position: positionFromThree(camera.position),
    orientation: coreQuaternionFromThree(camera.quaternion),
  }
}

export function resizeCameraRig(rig: FlightCameraRig, aspect: number): void {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  for (const camera of rig.cameras) {
    camera.aspect = safeAspect
    camera.updateProjectionMatrix()
  }
}