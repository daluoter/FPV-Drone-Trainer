import * as THREE from 'three'

import { DEFAULT_DRONE_CONFIG, type DroneState } from '../drone'
import type { ReplayGhostState } from '../replay'
import {
  activeCamera,
  createCameraRig,
  resizeCameraRig,
  updateCameraRig,
  updateCameraRigOptions,
  type CameraMode,
  type CameraRigOptions,
  type FlightCameraRig,
} from './camera'
import { createFlightScene, type FlightScene } from './scene'

export interface FlightRendererOptions extends CameraRigOptions {
  readonly pixelRatio?: number
  readonly scene?: FlightScene
}

/** Three.js presentation owner for the Free Flight viewport. */
export class FlightRenderer {
  public readonly canvas: HTMLCanvasElement
  public readonly flightScene: FlightScene
  public readonly cameraRig: FlightCameraRig
  public readonly renderer: THREE.WebGLRenderer | null
  private disposed = false

  public constructor(canvas: HTMLCanvasElement, options: FlightRendererOptions = {}) {
    this.canvas = canvas
    this.flightScene = options.scene ?? createFlightScene(DEFAULT_DRONE_CONFIG)
    this.cameraRig = createCameraRig(options)
    this.renderer = this.createWebGlRenderer(options.pixelRatio)
    this.resize()
  }

  public get scene(): THREE.Scene {
    return this.flightScene.scene
  }

  public get camera(): THREE.PerspectiveCamera {
    return activeCamera(this.cameraRig)
  }

  public setCameraMode(mode: CameraMode): void {
    this.cameraRig.mode = mode
  }

  /** Apply camera presentation settings only when the owning runtime is reset. */
  public setCameraOptions(options: Pick<CameraRigOptions, 'fpvFovDegrees' | 'fpvMountAngleDegrees'>): void {
    updateCameraRigOptions(this.cameraRig, options)
  }

  public resize(width = this.canvas.clientWidth, height = this.canvas.clientHeight): void {
    const safeWidth = Number.isFinite(width) && width > 0 ? width : 1
    const safeHeight = Number.isFinite(height) && height > 0 ? height : 1
    resizeCameraRig(this.cameraRig, safeWidth / safeHeight)
    if (!this.renderer) return
    const pixelRatio = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? Math.min(window.devicePixelRatio, 2)
      : 1
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(safeWidth, safeHeight, false)
  }

  public render(state: DroneState): void {
    if (this.disposed) return
    this.flightScene.setReplayVisible(false)
    this.flightScene.applyState(state)
    updateCameraRig(this.cameraRig, state, this.cameraRig.mode)
    this.renderer?.render(this.flightScene.scene, this.camera)
  }

  /** Render only the independent replay ghost and never apply a live DroneState. */
  public renderGhost(
    state: Pick<ReplayGhostState, 'positionM' | 'orientation'>,
    trajectory: readonly { readonly x: number; readonly y: number; readonly z: number }[] = [],
  ): void {
    if (this.disposed) return
    this.flightScene.applyGhost(state)
    this.flightScene.setReplayVisible(true)
    if (trajectory.length > 0) this.flightScene.setReplayPath(trajectory)
    updateCameraRig(this.cameraRig, state, this.cameraRig.mode)
    this.renderer?.render(this.flightScene.scene, this.camera)
  }

  public clearReplay(): void {
    if (this.disposed) return
    this.flightScene.setReplayVisible(false)
    this.flightScene.setReplayPath([])
  }

  public setReplayPath(path: readonly { readonly x: number; readonly y: number; readonly z: number }[]): void {
    if (this.disposed) return
    this.flightScene.setReplayPath(path)
  }

  public setTrainingPath(path: readonly { readonly x: number; readonly y: number; readonly z: number }[]): void {
    if (this.disposed) return
    this.flightScene.setTrainingPath(path)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.flightScene.dispose()
    this.renderer?.dispose()
    this.renderer?.forceContextLoss?.()
  }

  private createWebGlRenderer(pixelRatio: number | undefined): THREE.WebGLRenderer | null {
    if (
      typeof window !== 'undefined' &&
      typeof WebGLRenderingContext === 'undefined' &&
      typeof WebGL2RenderingContext === 'undefined'
    ) return null
    try {
      const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false })
      const safePixelRatio = Number.isFinite(pixelRatio) && (pixelRatio ?? 0) > 0
        ? Math.min(pixelRatio as number, 2)
        : typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
          ? Math.min(window.devicePixelRatio, 2)
          : 1
      renderer.setPixelRatio(safePixelRatio)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.shadowMap.enabled = true
      return renderer
    } catch {
      // jsdom and browsers without WebGL still get the simulation/HUD. A
      // renderer is optional at this boundary; it must never block safe input.
      return null
    }
  }
}

export function createFlightRenderer(
  canvas: HTMLCanvasElement,
  options: FlightRendererOptions = {},
): FlightRenderer {
  return new FlightRenderer(canvas, options)
}
