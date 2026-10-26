import * as THREE from 'three'

import type { Vector3 } from '../math/vector'
import type { FlightCameraRig } from './camera'

export interface FreeCameraState {
  readonly positionM: Vector3
  readonly targetM: Vector3
  readonly distanceM: number
}

const CAMERA_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown', '+', '=', '-', '_', 'home'])
const MIN_DISTANCE_M = 0.5
const MAX_DISTANCE_M = 2_000
const WORLD_LIMIT_M = 1_000_000
const POLE_MARGIN_RAD = 0.01

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function cameraKey(key: string): string {
  const lower = key.toLowerCase()
  return lower === '=' ? '+' : lower === '_' ? '-' : lower
}

/** View-only input owner. It never receives a simulation, controller or flight-state writer. */
export class FreeCameraControls {
  private readonly target = new THREE.Vector3(0, 0.5, 0)
  private readonly spherical = new THREE.Spherical()
  private readonly pressed = new Set<string>()
  private readonly originalTouchAction: string
  private readonly originalCursor: string
  private readonly addedTabIndex: boolean
  private enabled = false
  private disposed = false
  private shifted = false
  private lastTimeMs: number | null = null
  private drag: { id: number; x: number; y: number; pan: boolean } | null = null

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly rig: FlightCameraRig,
    private readonly onFocus: () => void,
  ) {
    this.originalTouchAction = canvas.style.touchAction || ''
    this.originalCursor = canvas.style.cursor
    this.addedTabIndex = !canvas.hasAttribute('tabindex')
    if (this.addedTabIndex) canvas.tabIndex = 0
    this.spherical.setFromVector3(rig.free.position.clone().sub(this.target))
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerEnd)
    canvas.addEventListener('pointercancel', this.onPointerCancel)
    canvas.addEventListener('lostpointercapture', this.onPointerCancel)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
    canvas.addEventListener('keydown', this.onKeyDown)
    canvas.addEventListener('keyup', this.onKeyUp)
    canvas.addEventListener('blur', this.releaseInteraction)
    canvas.ownerDocument.defaultView?.addEventListener('blur', this.releaseInteraction)
    canvas.ownerDocument.addEventListener('visibilitychange', this.releaseInteraction)
    this.publishState()
  }

  public setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    this.releaseInteraction()
    this.canvas.style.touchAction = enabled ? 'none' : this.originalTouchAction
    this.canvas.style.cursor = enabled ? 'grab' : this.originalCursor
  }

  public focus(positionM: Vector3): void {
    if (this.disposed || ![positionM.x, positionM.y, positionM.z].every(Number.isFinite)) return
    this.releaseInteraction()
    this.target.set(positionM.x, positionM.y, positionM.z)
    this.spherical.setFromVector3(new THREE.Vector3(4, 3, 6))
    this.apply()
  }

  public getState(): FreeCameraState {
    const position = this.rig.free.position
    return { positionM: { x: position.x, y: position.y, z: position.z },
      targetM: { x: this.target.x, y: this.target.y, z: this.target.z }, distanceM: position.distanceTo(this.target) }
  }

  /** Called on ordinary live and replay render frames, including paused playback. */
  public update(timeMs = performance.now()): void {
    if (this.disposed || !this.enabled) return
    if (!Number.isFinite(timeMs)) return
    const delta = this.lastTimeMs === null ? 0 : bounded((timeMs - this.lastTimeMs) / 1_000, 0, 0.1)
    this.lastTimeMs = timeMs
    if (this.canvas.ownerDocument.activeElement !== this.canvas) {
      this.pressed.clear()
      return
    }
    this.applyKeyboard(delta)
  }

  public dispose(): void {
    if (this.disposed) return
    this.setEnabled(false)
    this.releaseInteraction()
    this.disposed = true
    const canvas = this.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerEnd)
    canvas.removeEventListener('pointercancel', this.onPointerCancel)
    canvas.removeEventListener('lostpointercapture', this.onPointerCancel)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('contextmenu', this.onContextMenu)
    canvas.removeEventListener('keydown', this.onKeyDown)
    canvas.removeEventListener('keyup', this.onKeyUp)
    canvas.removeEventListener('blur', this.releaseInteraction)
    canvas.ownerDocument.defaultView?.removeEventListener('blur', this.releaseInteraction)
    canvas.ownerDocument.removeEventListener('visibilitychange', this.releaseInteraction)
    if (this.addedTabIndex) canvas.removeAttribute('tabindex')
  }

  private readonly releaseInteraction = (): void => {
    const drag = this.drag
    this.drag = null
    if (drag) {
      try {
        if (!this.canvas.hasPointerCapture || this.canvas.hasPointerCapture(drag.id)) this.canvas.releasePointerCapture?.(drag.id)
      } catch { /* The browser may already have released a cancelled pointer. */ }
    }
    this.pressed.clear()
    this.shifted = false
    this.lastTimeMs = null
    if (this.enabled) this.canvas.style.cursor = 'grab'
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.disposed || this.drag || event.ctrlKey || event.metaKey || event.altKey
      || event.isPrimary === false || ![0, 1, 2].includes(event.button)
      || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    event.preventDefault()
    this.canvas.focus({ preventScroll: true })
    const id = Number.isFinite(event.pointerId) ? event.pointerId : 0
    this.drag = { id, x: event.clientX, y: event.clientY, pan: event.button !== 0 || event.shiftKey }
    this.canvas.style.cursor = 'grabbing'
    try { this.canvas.setPointerCapture?.(id) } catch { /* Synthetic pointer events may not be capturable. */ }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (!this.enabled || !drag || (Number.isFinite(event.pointerId) ? event.pointerId : 0) !== drag.id
      || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    event.preventDefault()
    const dx = bounded(event.clientX - drag.x, -2_000, 2_000)
    const dy = bounded(event.clientY - drag.y, -2_000, 2_000)
    drag.x = event.clientX
    drag.y = event.clientY
    if (drag.pan) {
      const height = Math.max(1, this.canvas.clientHeight || this.canvas.getBoundingClientRect().height || 400)
      const scale = 2 * this.spherical.radius * Math.tan(this.rig.free.fov * Math.PI / 360) / height
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.rig.free.quaternion)
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rig.free.quaternion)
      this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale)
    } else {
      this.spherical.theta -= dx * 0.005
      this.spherical.phi -= dy * 0.005
    }
    this.apply()
  }

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (this.drag && (Number.isFinite(event.pointerId) ? event.pointerId : 0) === this.drag.id) this.releaseInteraction()
  }

  private readonly onPointerCancel = (): void => { this.releaseInteraction() }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || this.disposed || event.ctrlKey || event.metaKey || event.altKey || !Number.isFinite(event.deltaY)) return
    event.preventDefault()
    const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
    this.spherical.radius *= Math.exp(bounded(event.deltaY * modeScale * 0.001, -2, 2))
    this.apply()
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.enabled && !this.disposed && !event.ctrlKey && !event.metaKey && !event.altKey) event.preventDefault()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || this.disposed || event.defaultPrevented || event.target !== this.canvas
      || this.canvas.ownerDocument.activeElement !== this.canvas) return
    if (event.ctrlKey || event.metaKey || event.altKey) {
      this.pressed.clear()
      return
    }
    this.shifted = event.shiftKey
    const key = cameraKey(event.key)
    if (!CAMERA_KEYS.has(key)) return
    event.preventDefault()
    if (key === 'home') {
      if (!event.repeat) this.onFocus()
      return
    }
    if (!this.pressed.has(key)) {
      this.pressed.add(key)
      this.lastTimeMs = performance.now()
      this.applyKeyboard(1 / 60)
    }
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const key = cameraKey(event.key)
    this.pressed.delete(key)
    if (key === 'shift') this.shifted = false
    else this.shifted = event.shiftKey
    if (this.enabled && CAMERA_KEYS.has(key) && event.target === this.canvas) event.preventDefault()
  }

  private applyKeyboard(delta: number): void {
    if (delta <= 0 || this.pressed.size === 0) return
    const axis = (positive: string, negative: string): number => Number(this.pressed.has(positive)) - Number(this.pressed.has(negative))
    const x = axis('arrowright', 'arrowleft')
    const forward = axis('arrowup', 'arrowdown')
    if (this.shifted) {
      this.spherical.theta -= x * delta * 1.5
      this.spherical.phi -= forward * delta * 1.5
    } else {
      const direction = new THREE.Vector3(-Math.sin(this.spherical.theta), 0, -Math.cos(this.spherical.theta))
      const right = new THREE.Vector3(-direction.z, 0, direction.x)
      const move = direction.multiplyScalar(forward).addScaledVector(right, x)
      move.y = axis('pageup', 'pagedown')
      if (move.lengthSq() > 1) move.normalize()
      this.target.addScaledVector(move, delta * bounded(this.spherical.radius * 0.75, 2, 80))
    }
    const zoom = Number(this.pressed.has('+') || this.pressed.has('=')) - Number(this.pressed.has('-') || this.pressed.has('_'))
    this.spherical.radius *= Math.exp(-zoom * delta * 1.8)
    this.apply()
  }

  private apply(): void {
    this.spherical.radius = bounded(this.spherical.radius, MIN_DISTANCE_M, MAX_DISTANCE_M)
    this.spherical.phi = bounded(this.spherical.phi, POLE_MARGIN_RAD, Math.PI - POLE_MARGIN_RAD)
    this.spherical.theta = Math.atan2(Math.sin(this.spherical.theta), Math.cos(this.spherical.theta))
    this.target.set(bounded(this.target.x, -WORLD_LIMIT_M, WORLD_LIMIT_M), bounded(this.target.y, -WORLD_LIMIT_M, WORLD_LIMIT_M), bounded(this.target.z, -WORLD_LIMIT_M, WORLD_LIMIT_M))
    this.rig.free.position.copy(this.target).add(new THREE.Vector3().setFromSpherical(this.spherical))
    this.rig.free.lookAt(this.target)
    this.rig.free.updateMatrixWorld()
    this.rig.freeInitialized = true
    this.publishState()
  }

  private publishState(): void {
    const state = this.getState()
    this.canvas.dataset.freeCameraPosition = JSON.stringify(state.positionM)
    this.canvas.dataset.freeCameraTarget = JSON.stringify(state.targetM)
    this.canvas.dataset.freeCameraDistance = String(state.distanceM)
  }
}
