import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCameraRig } from './camera'
import { FreeCameraControls } from './freeCameraControls'

const cleanups: (() => void)[] = []
function fixture() {
  const canvas = document.createElement('canvas')
  canvas.tabIndex = 0
  document.body.append(canvas)
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) })
  const captured = new Set<number>()
  canvas.setPointerCapture = vi.fn((id) => { captured.add(id) })
  canvas.releasePointerCapture = vi.fn((id) => { captured.delete(id) })
  canvas.hasPointerCapture = (id) => captured.has(id)
  const rig = createCameraRig()
  const onFocus = vi.fn()
  const controls = new FreeCameraControls(canvas, rig, onFocus)
  controls.focus({ x: 3, y: 12, z: -8 })
  cleanups.push(() => { controls.dispose(); canvas.remove() })
  return { canvas, rig, controls, captured, onFocus }
}
function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number, button = 0, shiftKey = false): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons: type === 'pointerup' ? 0 : button === 2 ? 2 : 1, shiftKey })
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' }, isPrimary: { value: true } })
  canvas.dispatchEvent(event)
  return event
}
function key(target: EventTarget, type: string, name: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, shiftKey })
  target.dispatchEvent(event)
  return event
}
function wheel(canvas: HTMLCanvasElement, deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
  canvas.dispatchEvent(event)
  return event
}
function motion(controls: FreeCameraControls) {
  controls.update(0)
  controls.update(100)
}
function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.restoreAllMocks() })

describe('interactive Free camera controls', () => {
  it('leaves page events and all cameras untouched when disabled', () => {
    const { canvas, controls, onFocus } = fixture()
    const before = controls.getState()
    canvas.focus()
    expect(pointer(canvas, 'pointerdown', 200, 200).defaultPrevented).toBe(false)
    pointer(canvas, 'pointermove', 300, 240)
    expect(wheel(canvas, -100).defaultPrevented).toBe(false)
    expect(key(canvas, 'keydown', 'ArrowUp').defaultPrevented).toBe(false)
    key(canvas, 'keydown', 'Home')
    motion(controls)
    expect(controls.getState()).toEqual(before)
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('orbits with left drag around the chosen point without moving that point or zooming', () => {
    const { canvas, controls, captured } = fixture()
    controls.setEnabled(true)
    const before = controls.getState()
    expect(pointer(canvas, 'pointerdown', 200, 200).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(canvas)
    pointer(canvas, 'pointermove', 300, 260)
    const moved = controls.getState()
    expect(distance(moved.positionM, before.positionM)).toBeGreaterThan(0.01)
    expect(moved.targetM).toEqual(before.targetM)
    expect(moved.distanceM).toBeCloseTo(before.distanceM)
    pointer(canvas, 'pointerup', 300, 260)
    expect(captured.size).toBe(0)
    const ended = controls.getState()
    pointer(canvas, 'pointermove', 400, 320)
    expect(controls.getState()).toEqual(ended)
  })

  it.each([{ button: 2, shift: false }, { button: 0, shift: true }])('pans with button $button and Shift=$shift while keeping the view distance', ({ button, shift }) => {
    const { canvas, rig, controls } = fixture()
    controls.setEnabled(true)
    const before = controls.getState()
    const orientation = rig.free.quaternion.clone()
    pointer(canvas, 'pointerdown', 200, 200, button, shift)
    pointer(canvas, 'pointermove', 270, 240, button, shift)
    const moved = controls.getState()
    expect(distance(moved.targetM, before.targetM)).toBeGreaterThan(0.01)
    expect(moved.distanceM).toBeCloseTo(before.distanceM)
    for (const axis of ['x', 'y', 'z'] as const) expect(moved.positionM[axis] - before.positionM[axis]).toBeCloseTo(moved.targetM[axis] - before.targetM[axis])
    expect(rig.free.quaternion.angleTo(orientation)).toBeLessThan(1e-6)
  })

  it('dollies with the wheel without changing the FPV FOV or the look-at point', () => {
    const { canvas, rig, controls } = fixture()
    controls.setEnabled(true)
    const before = controls.getState()
    expect(wheel(canvas, -200).defaultPrevented).toBe(true)
    const nearer = controls.getState()
    expect(nearer.distanceM).toBeLessThan(before.distanceM)
    expect(nearer.targetM).toEqual(before.targetM)
    wheel(canvas, 200)
    expect(controls.getState().distanceM).toBeGreaterThan(nearer.distanceM)
    expect(rig.fpv.fov).toBe(90)
    expect(rig.free.fov).toBe(60)
  })

  it('owns the right-button menu only while Free camera is active', () => {
    const { canvas, controls } = fixture()
    const inactive = new MouseEvent('contextmenu', { cancelable: true })
    canvas.dispatchEvent(inactive)
    expect(inactive.defaultPrevented).toBe(false)
    controls.setEnabled(true)
    const active = new MouseEvent('contextmenu', { cancelable: true })
    canvas.dispatchEvent(active)
    expect(active.defaultPrevented).toBe(true)
    controls.setEnabled(false)
    const ended = new MouseEvent('contextmenu', { cancelable: true })
    canvas.dispatchEvent(ended)
    expect(ended.defaultPrevented).toBe(false)
  })

  it('moves only for focused canvas keys and never consumes live flight letter keys', () => {
    const { canvas, controls } = fixture()
    controls.setEnabled(true)
    const before = controls.getState()
    const input = document.createElement('input')
    document.body.append(input)
    cleanups.push(() => input.remove())
    input.focus()
    expect(key(input, 'keydown', 'ArrowUp').defaultPrevented).toBe(false)
    motion(controls)
    expect(controls.getState()).toEqual(before)
    canvas.focus()
    for (const letter of ['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'x']) expect(key(canvas, 'keydown', letter).defaultPrevented).toBe(false)
    expect(key(canvas, 'keydown', 'ArrowUp').defaultPrevented).toBe(true)
    controls.update(200)
    controls.update(300)
    expect(distance(controls.getState().targetM, before.targetM)).toBeGreaterThan(0.01)
    key(canvas, 'keyup', 'ArrowUp')
    const released = controls.getState()
    controls.update(400)
    expect(controls.getState()).toEqual(released)
  })

  it('supports keyboard orbit, vertical movement, dolly and explicit focus without touching other cameras', () => {
    const { canvas, rig, controls, onFocus } = fixture()
    controls.setEnabled(true)
    canvas.focus()
    const fpv = rig.fpv.matrixWorld.clone()
    const chase = rig.chase.matrixWorld.clone()
    const before = controls.getState()
    key(canvas, 'keydown', 'ArrowRight', true)
    motion(controls)
    key(canvas, 'keyup', 'ArrowRight', true)
    const orbited = controls.getState()
    expect(distance(orbited.positionM, before.positionM)).toBeGreaterThan(0.01)
    expect(orbited.targetM).toEqual(before.targetM)
    key(canvas, 'keydown', 'PageUp')
    controls.update(200)
    key(canvas, 'keyup', 'PageUp')
    const elevated = controls.getState()
    expect(elevated.targetM.y).toBeGreaterThan(orbited.targetM.y)
    key(canvas, 'keydown', '+')
    controls.update(300)
    key(canvas, 'keyup', '+')
    expect(controls.getState().distanceM).toBeLessThan(elevated.distanceM)
    key(canvas, 'keydown', 'Home')
    expect(onFocus).toHaveBeenCalledOnce()
    expect(rig.fpv.matrixWorld.equals(fpv)).toBe(true)
    expect(rig.chase.matrixWorld.equals(chase)).toBe(true)
  })

  it('releases held zoom when Shift changes the plus or minus key alias', () => {
    const { canvas, controls } = fixture()
    controls.setEnabled(true)
    canvas.focus()
    for (const [pressed, released] of [['=', '+'], ['-', '_']]) {
      key(canvas, 'keydown', pressed)
      motion(controls)
      key(canvas, 'keyup', released, true)
      const stopped = controls.getState()
      controls.update(200)
      expect(controls.getState()).toEqual(stopped)
    }
  })

  it('preserves browser modifiers while still releasing a key whose modifier changed', () => {
    const { canvas, controls } = fixture()
    controls.setEnabled(true)
    canvas.focus()
    const before = controls.getState()
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      const shortcut = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true, [modifier]: true })
      canvas.dispatchEvent(shortcut)
      expect(shortcut.defaultPrevented).toBe(false)
      const zoom = new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true, [modifier]: true })
      canvas.dispatchEvent(zoom)
      expect(zoom.defaultPrevented).toBe(false)
      motion(controls)
      expect(controls.getState()).toEqual(before)
    }
    key(canvas, 'keydown', 'ArrowUp')
    motion(controls)
    expect(controls.getState()).not.toEqual(before)
    canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true, ctrlKey: true }))
    const stopped = controls.getState()
    controls.update(200)
    expect(controls.getState()).toEqual(stopped)
  })

  it.each(['canvas-blur', 'window-blur', 'visibility', 'disable', 'dispose', 'pointer-cancel'] as const)('releases active input on %s', (reason) => {
    const { canvas, controls, captured } = fixture()
    controls.setEnabled(true)
    canvas.focus()
    pointer(canvas, 'pointerdown', 200, 200)
    key(canvas, 'keydown', 'ArrowUp')
    motion(controls)
    if (reason === 'canvas-blur') canvas.dispatchEvent(new FocusEvent('blur'))
    if (reason === 'window-blur') window.dispatchEvent(new Event('blur'))
    if (reason === 'visibility') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    }
    if (reason === 'disable') controls.setEnabled(false)
    if (reason === 'dispose') controls.dispose()
    if (reason === 'pointer-cancel') pointer(canvas, 'pointercancel', 200, 200)
    const stopped = controls.getState()
    controls.update(200)
    pointer(canvas, 'pointermove', 400, 400)
    expect(controls.getState()).toEqual(stopped)
    expect(captured.size).toBe(0)
  })

  it('bounds extreme zoom and polar rotations and returns fresh state copies', () => {
    const { canvas, controls } = fixture()
    controls.setEnabled(true)
    pointer(canvas, 'pointerdown', 200, 200)
    pointer(canvas, 'pointermove', 1e8, 1e8)
    wheel(canvas, -1e8)
    expect(controls.getState().distanceM).toBeGreaterThanOrEqual(0.5)
    wheel(canvas, 1e8)
    expect(controls.getState().distanceM).toBeLessThanOrEqual(2000)
    const state = controls.getState()
    expect([...Object.values(state.positionM), ...Object.values(state.targetM), state.distanceM].every(Number.isFinite)).toBe(true)
    Object.assign(state.positionM, { x: 1e9 })
    Object.assign(state.targetM, { z: 1e9 })
    expect(controls.getState().positionM.x).not.toBe(1e9)
    expect(controls.getState().targetM.z).not.toBe(1e9)
  })

  it('removes event ownership on disposal so the canvas can be reused', () => {
    const { canvas, rig, controls } = fixture()
    controls.setEnabled(true)
    controls.dispose()
    canvas.focus()
    expect(pointer(canvas, 'pointerdown', 100, 100).defaultPrevented).toBe(false)
    expect(wheel(canvas, -100).defaultPrevented).toBe(false)
    expect(key(canvas, 'keydown', 'ArrowUp').defaultPrevented).toBe(false)
    const replacement = new FreeCameraControls(canvas, rig, vi.fn())
    cleanups.push(() => replacement.dispose())
    replacement.focus({ x: 0, y: 5, z: 0 })
    replacement.setEnabled(true)
    const before = replacement.getState()
    wheel(canvas, -100)
    expect(replacement.getState().distanceM).toBeLessThan(before.distanceM)
  })
})
