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

export type FlightRendererStatusKind = 'ready' | 'context-lost' | 'unavailable'

export interface FlightRendererStatus {
  readonly kind: FlightRendererStatusKind
  readonly message?: string
}

export type WebGLRendererFactory = (
  parameters: THREE.WebGLRendererParameters,
) => THREE.WebGLRenderer

export interface FlightRendererOptions extends CameraRigOptions {
  readonly pixelRatio?: number
  readonly scene?: FlightScene
  /** Called when the canvas stops being safe to use for visible flight. */
  readonly onStatusChange?: (status: FlightRendererStatus) => void
  /** Test seam for a renderer double; production uses Three.js directly. */
  readonly rendererFactory?: WebGLRendererFactory
}

function rendererErrorMessage(error: unknown): string {
  if (error instanceof Error && /error is not a function/i.test(error.message)) {
    return 'The browser could not create a WebGL2 rendering context. Check hardware acceleration and retry.'
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return 'The browser could not create a WebGL2 rendering context. Check hardware acceleration and retry.'
}

export class FlightRendererInitializationError extends Error {
  public readonly cause: unknown

  public constructor(cause: unknown) {
    super(`WebGL renderer initialization failed: ${rendererErrorMessage(cause)}`)
    this.name = 'FlightRendererInitializationError'
    this.cause = cause
  }
}

/** Three.js presentation owner for the Free Flight viewport. */
export class FlightRenderer {
  public readonly canvas: HTMLCanvasElement
  public readonly flightScene: FlightScene
  public readonly cameraRig: FlightCameraRig
  public readonly renderer: THREE.WebGLRenderer
  private readonly statusListener: ((status: FlightRendererStatus) => void) | null
  private status: FlightRendererStatus = { kind: 'ready' }
  private disposed = false
  private readonly onContextLostBound = (): void => {
    if (this.disposed) return
    this.setStatus({
      kind: 'context-lost',
      message: 'The WebGL context was lost. Flight has been disarmed; retry rendering to recover.',
    })
  }
  private readonly onContextRestoredBound = (): void => {
    if (this.disposed) return
    this.setStatus({ kind: 'ready' })
  }

  public constructor(canvas: HTMLCanvasElement, options: FlightRendererOptions = {}) {
    this.canvas = canvas
    this.flightScene = options.scene ?? createFlightScene(DEFAULT_DRONE_CONFIG)
    this.cameraRig = createCameraRig(options)
    this.statusListener = options.onStatusChange ?? null
    let renderer: THREE.WebGLRenderer | null = null
    try {
      renderer = this.createWebGlRenderer(options.pixelRatio, options.rendererFactory)
      this.renderer = renderer
      this.canvas.addEventListener('webglcontextlost', this.onContextLostBound)
      this.canvas.addEventListener('webglcontextrestored', this.onContextRestoredBound)
      this.resize()
    } catch (error) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLostBound)
      this.canvas.removeEventListener('webglcontextrestored', this.onContextRestoredBound)
      renderer?.dispose()
      this.flightScene.dispose()
      throw error instanceof FlightRendererInitializationError
        ? error
        : new FlightRendererInitializationError(error)
    }
    this.statusListener?.(this.status)
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
    if (this.status.kind !== 'ready') return
    const pixelRatio = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? Math.min(window.devicePixelRatio, 2)
      : 1
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(safeWidth, safeHeight, false)
  }

  public getStatus(): FlightRendererStatus {
    return this.status
  }

  public render(state: DroneState): void {
    if (this.disposed || this.status.kind !== 'ready') return
    try {
      this.flightScene.setReplayVisible(false)
      this.flightScene.applyState(state)
      updateCameraRig(this.cameraRig, state, this.cameraRig.mode)
      this.renderer.render(this.flightScene.scene, this.camera)
    } catch (error) {
      this.setStatus({
        kind: 'unavailable',
        message: `WebGL rendering failed: ${rendererErrorMessage(error)}`,
      })
    }
  }

  /** Render only the independent replay ghost and never apply a live DroneState. */
  public renderGhost(
    state: Pick<ReplayGhostState, 'positionM' | 'orientation'>,
    trajectory: readonly { readonly x: number; readonly y: number; readonly z: number }[] = [],
  ): void {
    if (this.disposed || this.status.kind !== 'ready') return
    try {
      this.flightScene.applyGhost(state)
      this.flightScene.setReplayVisible(true)
      if (trajectory.length > 0) this.flightScene.setReplayPath(trajectory)
      updateCameraRig(this.cameraRig, state, this.cameraRig.mode)
      this.renderer.render(this.flightScene.scene, this.camera)
    } catch (error) {
      this.setStatus({
        kind: 'unavailable',
        message: `WebGL rendering failed: ${rendererErrorMessage(error)}`,
      })
    }
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
    this.canvas.removeEventListener('webglcontextlost', this.onContextLostBound)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestoredBound)
    this.flightScene.dispose()
    // Do not force context loss here. React StrictMode intentionally mounts,
    // disposes, and remounts effects against the same canvas; a forced loss
    // leaves that canvas permanently unable to create the next WebGL2 context.
    this.renderer.dispose()
  }

  private setStatus(status: FlightRendererStatus): void {
    if (this.status.kind === status.kind && this.status.message === status.message) return
    this.status = status
    this.statusListener?.(status)
  }

  private createWebGlRenderer(
    pixelRatio: number | undefined,
    rendererFactory: WebGLRendererFactory | undefined,
  ): THREE.WebGLRenderer {
    try {
      const renderer = (rendererFactory ?? ((parameters) => new THREE.WebGLRenderer(parameters)))({
        canvas: this.canvas,
        antialias: true,
        alpha: false,
      })
      const safePixelRatio = Number.isFinite(pixelRatio) && (pixelRatio ?? 0) > 0
        ? Math.min(pixelRatio as number, 2)
        : typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
          ? Math.min(window.devicePixelRatio, 2)
          : 1
      renderer.setPixelRatio(safePixelRatio)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.shadowMap.enabled = true
      return renderer
    } catch (error) {
      throw new FlightRendererInitializationError(error)
    }
  }
}

export function createFlightRenderer(
  canvas: HTMLCanvasElement,
  options: FlightRendererOptions = {},
): FlightRenderer {
  return new FlightRenderer(canvas, options)
}
