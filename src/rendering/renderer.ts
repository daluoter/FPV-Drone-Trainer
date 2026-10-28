import * as THREE from 'three'

import { DEFAULT_DRONE_CONFIG, type DroneConfig, type DroneState } from '../drone'
import type { ReplayGhostState } from '../replay'
import type { Vector3 } from '../math/vector'
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
import { FreeCameraControls, type FreeCameraState } from './freeCameraControls'

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
  readonly droneConfig?: DroneConfig
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
  private currentFlightScene: FlightScene
  private lessonTarget: string | null = null
  private directionTarget: string | null = null
  private turnTarget: string | null = null
  private squareTarget: string | null = null
  private figureEightTarget: string | null = null
  private wideGateTarget: string | null = null
  private recoveryStage: number | null = 0
  private fullRollStage: number | null = 0
  private fullFlipStage: number | null = 0
  private powerLoopStage: number | null = 0
  private splitSStage: number | null = 0
  private orbitStage: number | null = 0
  private backwardFlightStage: number | null = 0
  public get flightScene(): FlightScene { return this.currentFlightScene }
  public readonly cameraRig: FlightCameraRig
  public readonly renderer: THREE.WebGLRenderer
  private readonly statusListener: ((status: FlightRendererStatus) => void) | null
  private status: FlightRendererStatus = { kind: 'ready' }
  private disposed = false
  private readonly freeCameraControls: FreeCameraControls
  private freeCameraEntered = false
  private lastVisiblePositionM: Vector3 | null = null
  private readonly onContextLostBound = (event: Event): void => {
    if (this.disposed) return
    // Opt in to browser restoration; flight remains disarmed after recovery.
    event.preventDefault()
    this.freeCameraControls.setEnabled(false)
    this.setStatus({
      kind: 'context-lost',
      message: 'The WebGL context was lost. Flight has been disarmed; retry rendering to recover.',
    })
  }
  private readonly onContextRestoredBound = (): void => {
    if (this.disposed) return
    this.freeCameraControls.setEnabled(this.cameraRig.mode === 'free')
    this.setStatus({ kind: 'ready' })
  }

  public constructor(canvas: HTMLCanvasElement, options: FlightRendererOptions = {}) {
    this.canvas = canvas
    this.currentFlightScene = options.scene ?? createFlightScene(options.droneConfig ?? DEFAULT_DRONE_CONFIG)
    this.cameraRig = createCameraRig(options)
    this.statusListener = options.onStatusChange ?? null
    let renderer: THREE.WebGLRenderer | null = null
    let controls: FreeCameraControls | null = null
    try {
      renderer = this.createWebGlRenderer(options.pixelRatio, options.rendererFactory)
      this.renderer = renderer
      controls = new FreeCameraControls(canvas, this.cameraRig, () => this.focusFreeCamera())
      this.freeCameraControls = controls
      this.canvas.addEventListener('webglcontextlost', this.onContextLostBound)
      this.canvas.addEventListener('webglcontextrestored', this.onContextRestoredBound)
      this.resize()
    } catch (error) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLostBound)
      this.canvas.removeEventListener('webglcontextrestored', this.onContextRestoredBound)
      controls?.dispose()
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
    if (this.disposed) return
    this.cameraRig.mode = mode
    if (mode === 'free' && !this.freeCameraEntered && this.lastVisiblePositionM) {
      this.freeCameraControls.focus(this.lastVisiblePositionM)
      this.freeCameraEntered = true
    }
    this.freeCameraControls.setEnabled(mode === 'free' && this.status.kind === 'ready')
  }

  /** Reframe the visible live drone or replay ghost without changing flight or playback. */
  public focusFreeCamera(): void {
    if (this.disposed || this.cameraRig.mode !== 'free' || !this.lastVisiblePositionM) return
    this.freeCameraControls.focus(this.lastVisiblePositionM)
    this.freeCameraEntered = true
  }

  public getFreeCameraState(): FreeCameraState {
    return this.freeCameraControls.getState()
  }

  /** Move only the active Free view; live flight and replay state are untouched. */
  public moveFreeCameraVertically(deltaM: number): void {
    if (this.disposed || this.cameraRig.mode !== 'free' || this.status.kind !== 'ready') return
    this.freeCameraControls.moveVertically(deltaM)
  }

  public moveFreeCameraHorizontally(rightM: number, forwardM: number): void {
    if (this.disposed || this.cameraRig.mode !== 'free' || this.status.kind !== 'ready') return
    this.freeCameraControls.moveHorizontally(rightM, forwardM)
  }

  /** Update guidance without recreating the scene or changing simulation state. */
  public setLessonTarget(lessonId: string | null): void {
    if (this.disposed) return
    this.lessonTarget = lessonId
    this.flightScene.setLessonTarget(lessonId)
  }

  /** Advance a presentation-only L05 guide without altering live flight. */
  public setDirectionTarget(targetId: string | null): void {
    if (this.disposed) return
    this.directionTarget = targetId
    this.flightScene.setDirectionTarget(targetId)
  }

  /** Advance the presentation-only L06 route without altering live flight. */
  public setTurnTarget(targetId: string | null): void {
    if (this.disposed) return
    this.turnTarget = targetId
    this.flightScene.setTurnTarget(targetId)
  }

  /** Advance the presentation-only L07 square route without altering live flight. */
  public setSquareTarget(targetId: string | null): void {
    if (this.disposed) return
    this.squareTarget = targetId
    this.flightScene.setSquareTarget(targetId)
  }

  /** Advance the presentation-only L08 route without altering live flight. */
  public setFigureEightTarget(targetId: string | null): void {
    if (this.disposed) return
    this.figureEightTarget = targetId
    this.flightScene.setFigureEightTarget(targetId)
  }

  /** Advance L09 guidance while preserving every physical gate frame. */
  public setWideGateTarget(targetId: string | null): void {
    if (this.disposed) return
    this.wideGateTarget = targetId
    this.flightScene.setWideGateTarget(targetId)
  }

  /** Update the L10 visual stage without writing the live flight state. */
  public setRecoveryStage(stage: number | null): void {
    if (this.disposed) return
    this.recoveryStage = stage
    this.flightScene.setRecoveryStage(stage)
  }

  /** Update the full-roll visual stage without writing the live flight state. */
  public setFullRollStage(stage: number | null): void {
    if (this.disposed) return
    this.fullRollStage = stage
    this.flightScene.setFullRollStage(stage)
  }

  /** Update the full-flip visual stage without writing the live flight state. */
  public setFullFlipStage(stage: number | null): void {
    if (this.disposed) return
    this.fullFlipStage = stage
    this.flightScene.setFullFlipStage(stage)
  }

  /** Update illustrative loop guidance without writing the live flight state. */
  public setPowerLoopStage(stage: number | null): void {
    if (this.disposed) return
    this.powerLoopStage = stage
    this.flightScene.setPowerLoopStage(stage)
  }

  /** Update the descending half-loop guide without changing live flight. */
  public setSplitSStage(stage: number | null): void {
    if (this.disposed) return
    this.splitSStage = stage
    this.flightScene.setSplitSStage(stage)
  }

  /** Update the fixed orbit subject and entry accent without changing flight. */
  public setOrbitStage(stage: number | null): void {
    if (this.disposed) return
    this.orbitStage = stage
    this.flightScene.setOrbitStage(stage)
  }

  /** Show the retained-momentum exercise without changing the live aircraft. */
  public setBackwardFlightStage(stage: number | null): void {
    if (this.disposed) return
    this.backwardFlightStage = stage
    this.flightScene.setBackwardFlightStage(stage)
  }

  /** Rebuild anchors only after the owner has explicitly reset and disarmed. */
  public reconfigureScene(config: DroneConfig): void {
    if (this.disposed) return
    const previous = this.currentFlightScene
    this.currentFlightScene = createFlightScene(config)
    this.currentFlightScene.setLessonTarget(this.lessonTarget)
    this.currentFlightScene.setDirectionTarget(this.directionTarget)
    this.currentFlightScene.setTurnTarget(this.turnTarget)
    this.currentFlightScene.setSquareTarget(this.squareTarget)
    this.currentFlightScene.setFigureEightTarget(this.figureEightTarget)
    this.currentFlightScene.setWideGateTarget(this.wideGateTarget)
    this.currentFlightScene.setRecoveryStage(this.recoveryStage)
    this.currentFlightScene.setFullRollStage(this.fullRollStage)
    this.currentFlightScene.setFullFlipStage(this.fullFlipStage)
    this.currentFlightScene.setPowerLoopStage(this.powerLoopStage)
    this.currentFlightScene.setSplitSStage(this.splitSStage)
    this.currentFlightScene.setOrbitStage(this.orbitStage)
    this.currentFlightScene.setBackwardFlightStage(this.backwardFlightStage)
    previous.dispose()
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
      this.updateFreeCamera(state.positionM)
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
      this.updateFreeCamera(state.positionM)
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
    this.freeCameraControls.dispose()
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
    this.freeCameraControls.setEnabled(status.kind === 'ready' && this.cameraRig.mode === 'free')
    this.statusListener?.(status)
  }

  private updateFreeCamera(positionM: Vector3): void {
    this.lastVisiblePositionM = { ...positionM }
    if (this.cameraRig.mode !== 'free') return
    if (!this.freeCameraEntered) {
      this.freeCameraControls.focus(positionM)
      this.freeCameraEntered = true
    }
    this.freeCameraControls.update()
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
