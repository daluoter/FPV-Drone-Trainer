import { SPLIT_S_TARGET_HEIGHT_M } from '../training/splitS'
import { POWER_LOOP_TARGET_HEIGHT_M } from '../training/powerLoop'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import {
  FlightRenderer,
  FlightRendererInitializationError,
  type FlightRendererStatus,
} from './renderer'

function createRendererStub(): THREE.WebGLRenderer {
  return {
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
    render: vi.fn(),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false },
  } as unknown as THREE.WebGLRenderer
}

describe('interactive free camera renderer integration', () => {
  function viewport(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.tabIndex = 0
    document.body.appendChild(canvas)
    return canvas
  }
  function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number): void {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    canvas.dispatchEvent(event)
  }
  function drag(canvas: HTMLCanvasElement): void {
    pointer(canvas, 'pointerdown', 10, 10)
    pointer(canvas, 'pointermove', 90, 30)
    pointer(canvas, 'pointerup', 90, 30)
  }
  it('frames the current live drone, preserves exploration across camera switches and reframes explicitly', () => {
    const canvas = viewport()
    const renderer = new FlightRenderer(canvas, { rendererFactory: createRendererStub })
    try {
      const live = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: 15, y: 28, z: -35 })
      const original = JSON.stringify(live)
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      renderer.render(live)
      renderer.setCameraMode('free')
      expect(renderer.getFreeCameraState().targetM).toEqual(live.positionM)
      const initial = renderer.getFreeCameraState()
      drag(canvas)
      const explored = renderer.getFreeCameraState()
      expect(explored.positionM).not.toEqual(initial.positionM)
      expect(explored.targetM).toEqual(initial.targetM)
      expect(JSON.parse(canvas.dataset.freeCameraPosition!)).toEqual(explored.positionM)
      renderer.setCameraMode('fpv')
      const next = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: -4, y: 17, z: 8 })
      renderer.render(next)
      renderer.setCameraMode('free')
      expect(renderer.getFreeCameraState()).toEqual(explored)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.getFreeCameraState()).toEqual(explored)
      renderer.focusFreeCamera()
      expect(renderer.getFreeCameraState().targetM).toEqual(next.positionM)
      expect(JSON.stringify(live)).toBe(original)
    } finally { renderer.dispose(); canvas.remove() }
  })

  it('frames the paused replay ghost and Home targets the latest seek without applying a live pose', () => {
    const canvas = viewport()
    const renderer = new FlightRenderer(canvas, { rendererFactory: createRendererStub })
    try {
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      const applyLive = vi.spyOn(renderer.flightScene, 'applyState')
      const ghost = { positionM: { x: 20, y: 40, z: -30 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
      const original = JSON.stringify(ghost)
      renderer.renderGhost(ghost)
      renderer.setCameraMode('free')
      expect(renderer.getFreeCameraState().targetM).toEqual(ghost.positionM)
      drag(canvas)
      const explored = renderer.getFreeCameraState()
      const seek = { ...ghost, positionM: { x: -13, y: 12, z: 5 } }
      renderer.renderGhost(seek)
      expect(renderer.getFreeCameraState()).toEqual(explored)
      canvas.focus()
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      expect(renderer.getFreeCameraState().targetM).toEqual(seek.positionM)
      expect(applyLive).not.toHaveBeenCalled()
      expect(JSON.stringify(ghost)).toBe(original)
    } finally { renderer.dispose(); canvas.remove() }
  })

  it('updates held camera keys on paused ghost frames without changing the ghost or consuming flight keys', () => {
    const canvas = viewport()
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const renderer = new FlightRenderer(canvas, { rendererFactory: createRendererStub })
    try {
      const ghost = { positionM: { x: 5, y: 15, z: -8 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
      renderer.renderGhost(ghost)
      renderer.setCameraMode('free')
      canvas.focus()
      const initial = renderer.getFreeCameraState()
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      const pressed = renderer.getFreeCameraState()
      expect(pressed.targetM).not.toEqual(initial.targetM)
      now = 1_000
      renderer.renderGhost(ghost)
      expect(renderer.getFreeCameraState().targetM).not.toEqual(pressed.targetM)
      canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true, ctrlKey: true }))
      const released = renderer.getFreeCameraState()
      now = 2_000
      renderer.renderGhost(ghost)
      expect(renderer.getFreeCameraState()).toEqual(released)
      const letter = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true })
      canvas.dispatchEvent(letter)
      expect(letter.defaultPrevented).toBe(false)
      expect(renderer.getFreeCameraState()).toEqual(released)
      expect(ghost.positionM).toEqual({ x: 5, y: 15, z: -8 })
    } finally { renderer.dispose(); canvas.remove(); clock.mockRestore() }
  })

  it('raises and lowers the live or paused-ghost viewpoint without writing either aircraft pose', () => {
    const canvas = viewport()
    const renderer = new FlightRenderer(canvas, { rendererFactory: createRendererStub })
    try {
      const live = createInitialDroneState(DEFAULT_DRONE_CONFIG, { x: 4, y: 8, z: -15 })
      const liveBefore = JSON.stringify(live)
      renderer.render(live)
      renderer.setCameraMode('free')
      const initial = renderer.getFreeCameraState()
      renderer.moveFreeCameraVertically(1)
      expect(renderer.getFreeCameraState().targetM).toEqual({ ...initial.targetM, y: initial.targetM.y + 1 })
      renderer.moveFreeCameraVertically(-1)
      expect(renderer.getFreeCameraState().targetM).toEqual(initial.targetM)
      renderer.moveFreeCameraHorizontally(0, 1)
      const forward = renderer.getFreeCameraState()
      expect(Math.hypot(forward.targetM.x - initial.targetM.x, forward.targetM.z - initial.targetM.z)).toBeCloseTo(1)
      expect(forward.targetM.y).toBe(initial.targetM.y)
      expect(JSON.stringify(live)).toBe(liveBefore)

      const ghost = { positionM: { x: 20, y: 30, z: -40 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
      const ghostBefore = JSON.stringify(ghost)
      renderer.renderGhost(ghost)
      renderer.focusFreeCamera()
      const applyLive = vi.spyOn(renderer.flightScene, 'applyState')
      renderer.moveFreeCameraVertically(-1)
      const lowered = renderer.getFreeCameraState()
      renderer.renderGhost(ghost)
      expect(renderer.getFreeCameraState()).toEqual(lowered)
      expect(lowered.targetM).toEqual({ ...ghost.positionM, y: ghost.positionM.y - 1 })
      expect(lowered.positionM.y).toBeCloseTo(ghost.positionM.y + 2)
      renderer.moveFreeCameraHorizontally(-1, 0)
      const shifted = renderer.getFreeCameraState()
      renderer.renderGhost(ghost)
      expect(renderer.getFreeCameraState()).toEqual(shifted)
      expect(Math.hypot(shifted.targetM.x - lowered.targetM.x, shifted.targetM.z - lowered.targetM.z)).toBeCloseTo(1)
      expect(shifted.targetM.y).toBe(lowered.targetM.y)
      expect(JSON.stringify(ghost)).toBe(ghostBefore)
      expect(JSON.stringify(live)).toBe(liveBefore)
      expect(applyLive).not.toHaveBeenCalled()
    } finally { renderer.dispose(); canvas.remove() }
  })

  it('ignores elevation commands outside Free mode, during context loss and after disposal', () => {
    const canvas = viewport()
    const renderer = new FlightRenderer(canvas, { rendererFactory: createRendererStub })
    try {
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      for (const mode of ['fpv', 'chase'] as const) {
        renderer.setCameraMode(mode)
        const before = renderer.getFreeCameraState()
        renderer.moveFreeCameraVertically(1)
        renderer.moveFreeCameraHorizontally(1, 1)
        expect(renderer.getFreeCameraState()).toEqual(before)
      }
      renderer.setCameraMode('free')
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
      const lost = renderer.getFreeCameraState()
      renderer.moveFreeCameraVertically(1)
      renderer.moveFreeCameraHorizontally(1, 1)
      expect(renderer.getFreeCameraState()).toEqual(lost)
      canvas.dispatchEvent(new Event('webglcontextrestored'))
      renderer.moveFreeCameraVertically(1)
      expect(renderer.getFreeCameraState().targetM.y).toBeCloseTo(lost.targetM.y + 1)
      renderer.dispose()
      const disposed = renderer.getFreeCameraState()
      renderer.moveFreeCameraVertically(-1)
      renderer.moveFreeCameraHorizontally(-1, -1)
      expect(renderer.getFreeCameraState()).toEqual(disposed)
    } finally { renderer.dispose(); canvas.remove() }
  })

  it('disables and releases camera input during context loss and removes handlers on disposal', () => {
    const canvas = viewport()
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const renderer = new FlightRenderer(canvas, { rendererFactory: createRendererStub })
    try {
      const state = createInitialDroneState(DEFAULT_DRONE_CONFIG)
      renderer.render(state)
      renderer.setCameraMode('free')
      canvas.focus()
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      pointer(canvas, 'pointerdown', 0, 0)
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
      const lost = renderer.getFreeCameraState()
      pointer(canvas, 'pointermove', 200, 300)
      const wheel = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
      canvas.dispatchEvent(wheel)
      expect(wheel.defaultPrevented).toBe(false)
      expect(renderer.getFreeCameraState()).toEqual(lost)
      canvas.dispatchEvent(new Event('webglcontextrestored'))
      now = 1_000
      renderer.render(state)
      expect(renderer.getFreeCameraState()).toEqual(lost)
      renderer.dispose()
      drag(canvas)
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))
      expect(renderer.getFreeCameraState()).toEqual(lost)
      const next = new FlightRenderer(canvas, { rendererFactory: createRendererStub })
      next.render(state)
      next.setCameraMode('free')
      const fresh = next.getFreeCameraState()
      drag(canvas)
      expect(next.getFreeCameraState()).not.toEqual(fresh)
      next.dispose()
    } finally { renderer.dispose(); canvas.remove(); clock.mockRestore() }
  })
  it('retains the orbit subject and stage across a raised-ground rebuild without replacing the canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('orbit')
      renderer.setOrbitStage(5)
      const stagePosition = renderer.scene.getObjectByName('orbit-stage-guidance')!.position.toArray()
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } })
      expect(renderer.scene.getObjectByName('orbit-field')?.visible).toBe(true)
      expect(renderer.flightScene.getReference('orbit-zone')?.positionM).toEqual({ x: 6, y: 15, z: -33 })
      expect(renderer.flightScene.getReference('orbit-poi')?.positionM).toEqual({ x: 4, y: 7.5, z: 4 })
      expect(renderer.flightScene.getReference('orbit-poi')?.object.visible).toBe(false)
      const accent = renderer.scene.getObjectByName('orbit-stage-guidance')!
      const guide = renderer.scene.getObjectByName('orbit-stage-reference') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(accent.position.toArray()).toEqual(stagePosition)
      expect(guide.material.color.getHex()).toBe(0xffc978)
      expect(renderer.scene.getObjectByName('split-s-field')?.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setOrbitStage(9)
      expect(guide.material.color.getHex()).toBe(0xb8f36b)
      expect(renderer.scene.getObjectByName('orbit-outward-exit-reference')?.visible).toBe(true)
      renderer.setOrbitStage(null)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('orbit-stage-guidance')?.visible).toBe(false)
      renderer.setLessonTarget('split-s')
      expect(renderer.scene.getObjectByName('orbit-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('split-s-field')?.visible).toBe(true)
    } finally { renderer.dispose() }
  })

})

describe('FlightRenderer backward-flight presentation', () => {
  it('retains backward references and phase after rebuild while preserving canvas and live state', () => {
    const canvas = document.createElement('canvas')
    const rendererStub = createRendererStub()
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('backward-flight')
      renderer.setBackwardFlightStage(4)
      const state = createInitialDroneState(DEFAULT_DRONE_CONFIG)
      const original = JSON.stringify(state)
      renderer.render(state)
      const previous = renderer.flightScene
      const dispose = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } })
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(dispose).toHaveBeenCalledOnce()
      expect(renderer.flightScene.getReference('backward-zone')?.positionM).toEqual({ x: 6, y: 15, z: -28 })
      expect(renderer.scene.getObjectByName('backward-field')?.visible).toBe(true)
      expect(renderer.scene.getObjectByName('orbit-field')?.visible).toBe(false)
      expect(renderer.flightScene.getReference('orbit-poi')?.positionM).toEqual({ x: 4, y: 7.5, z: 4 })
      expect(renderer.flightScene.getReference('orbit-poi')?.object.visible).toBe(false)
      const nose = renderer.scene.getObjectByName('backward-nose-direction-example')!
      expect(nose.rotation.y).toBe(Math.PI)
      const guide = renderer.scene.getObjectByName('backward-stage-reference') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(guide.material.color.getHex()).toBe(0xffc978)
      renderer.setBackwardFlightStage(7)
      expect(guide.material.color.getHex()).toBe(0xb8f36b)
      renderer.setBackwardFlightStage(null)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('backward-stage-guidance')?.visible).toBe(false)
      renderer.setLessonTarget('orbit')
      expect(renderer.scene.getObjectByName('backward-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('orbit-field')?.visible).toBe(true)
      expect(JSON.stringify(state)).toBe(original)
    } finally { renderer.dispose() }
  })
})

describe('FlightRenderer crane-orbit presentation', () => {
  it('retains crane phase and exit across a raised-ground rebuild without replacing the canvas or touching flight', () => {
    const canvas = document.createElement('canvas')
    const rendererStub = createRendererStub()
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('reverse-orbit')
      renderer.setReverseOrbitStage(6)
      const state = createInitialDroneState(DEFAULT_DRONE_CONFIG)
      const original = JSON.stringify(state)
      renderer.render(state)
      const previous = renderer.flightScene
      const dispose = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } })
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(dispose).toHaveBeenCalledOnce()
      expect(renderer.flightScene.getReference('reverse-orbit-zone')?.positionM).toEqual({ x: 6, y: 50, z: -33 })
      expect(renderer.scene.getObjectByName('reverse-orbit-field')?.visible).toBe(true)
      expect(renderer.scene.getObjectByName('reverse-orbit-crane-jib')).toBeDefined()
      expect(renderer.scene.getObjectByName('backward-field')?.visible).toBe(false)
      expect(renderer.flightScene.getReference('orbit-poi')?.positionM).toEqual({ x: 4, y: 7.5, z: 4 })
      expect(renderer.flightScene.getReference('orbit-poi')?.object.visible).toBe(false)
      expect(renderer.scene.getObjectByName('reverse-orbit-outward-exit-reference')?.visible).toBe(true)
      const guide = renderer.scene.getObjectByName('reverse-orbit-stage-reference') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(guide.material.color.getHex()).toBe(0xffc978)
      renderer.setReverseOrbitStage(7)
      expect(guide.material.color.getHex()).toBe(0xb8f36b)
      renderer.setReverseOrbitStage(null)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('reverse-orbit-stage-guidance')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('reverse-orbit-outward-exit-reference')?.visible).toBe(false)
      renderer.setLessonTarget('backward-flight')
      expect(renderer.scene.getObjectByName('reverse-orbit-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('backward-field')?.visible).toBe(true)
      expect(JSON.stringify(state)).toBe(original)
    } finally { renderer.dispose() }
  })
})

describe('FlightRenderer lifecycle and failure contract', () => {
  it('reuses a canvas after disposal without forcing its WebGL context lost', () => {
    const canvas = document.createElement('canvas')
    const firstStub = createRendererStub()
    const secondStub = createRendererStub()

    const first = new FlightRenderer(canvas, { rendererFactory: () => firstStub })
    first.dispose()
    const second = new FlightRenderer(canvas, { rendererFactory: () => secondStub })
    second.dispose()

    expect(firstStub.forceContextLoss).not.toHaveBeenCalled()
    expect(secondStub.forceContextLoss).not.toHaveBeenCalled()
    expect(firstStub.dispose).toHaveBeenCalledOnce()
    expect(secondStub.dispose).toHaveBeenCalledOnce()
  })

  it('throws an explicit initialization error instead of returning a silent no-renderer success', () => {
    const canvas = document.createElement('canvas')

    expect(() => new FlightRenderer(canvas, {
      rendererFactory: () => {
        throw new Error('WebGL2 unavailable')
      },
    })).toThrowError(FlightRendererInitializationError)
  })

  it('replaces configured anchors without replacing the WebGL owner and preserves the active lesson guide', () => {
    const canvas = document.createElement('canvas')
    const rendererStub = createRendererStub()
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    const previous = renderer.flightScene
    const disposePrevious = vi.spyOn(previous, 'dispose')
    renderer.setLessonTarget('landing')
    renderer.reconfigureScene({
      ...DEFAULT_DRONE_CONFIG,
      ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 2 },
      spawnPositionM: { x: 4, y: 2.5, z: -3 },
    })

    expect(renderer.flightScene).not.toBe(previous)
    expect(renderer.renderer).toBe(rendererStub)
    expect(renderer.flightScene.getReference('landing-surface')?.positionM).toEqual({ x: 4, y: 2, z: -11 })
    expect(renderer.flightScene.getReference('landing-surface')?.object.visible).toBe(true)
    expect(renderer.flightScene.getReference('hover-zone')?.object.visible).toBe(false)
    expect(disposePrevious).toHaveBeenCalledOnce()
    renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
    expect(rendererStub.render).toHaveBeenCalledOnce()
    expect(rendererStub.dispose).not.toHaveBeenCalled()
    renderer.dispose()
  })

  it('reports context loss, skips invisible rendering, and resumes after restoration', () => {
    const canvas = document.createElement('canvas')
    const rendererStub = createRendererStub()
    const statuses: FlightRendererStatus[] = []
    const renderer = new FlightRenderer(canvas, {
      rendererFactory: () => rendererStub,
      onStatusChange: (status) => statuses.push(status),
    })

    expect(statuses.at(-1)?.kind).toBe('ready')
    const contextLost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(contextLost)
    expect(contextLost.defaultPrevented).toBe(true)
    expect(statuses.at(-1)?.kind).toBe('context-lost')
    renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
    expect(rendererStub.render).not.toHaveBeenCalled()

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(statuses.at(-1)?.kind).toBe('ready')
    renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
    expect(rendererStub.render).toHaveBeenCalledOnce()
    renderer.dispose()
  })

  it('retains the active L05 step across a disarmed scene reconfiguration', () => {
    const rendererStub = createRendererStub()
    const renderer = new FlightRenderer(document.createElement('canvas'), { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('direction-control')
      renderer.setDirectionTarget('direction-yaw')
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } })
      const group = renderer.scene.getObjectByName('direction-control-targets')!
      expect(group.visible).toBe(true)
      expect(group.children.filter((marker) => marker.visible).map((marker) => marker.name)).toEqual(['direction-yaw-zone'])
      expect(renderer.flightScene.getReference('direction-yaw')?.positionM).toEqual({ x: 2, y: 8, z: -3 })
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setDirectionTarget('direction-turned-right')
      expect(group.children.filter((marker) => marker.visible).map((marker) => marker.name)).toEqual(['direction-turned-right-zone'])
      renderer.setDirectionTarget(null)
      expect(group.children.every((marker) => !marker.visible)).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('retains the active L06 turn target across scene reconfiguration on the same canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('coordinated-turn')
      renderer.setTurnTarget('turn-left-apex')
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } })
      const targets = renderer.scene.getObjectByName('coordinated-turn-targets')!
      expect(targets.visible).toBe(true)
      expect(targets.children.filter((marker) => marker.visible).map((marker) => marker.name)).toEqual(['turn-left-apex-zone'])
      expect(renderer.flightScene.getReference('turn-left-apex')?.positionM).toEqual({ x: 20, y: 8, z: -17 })
      expect(renderer.scene.getObjectByName('coordinated-turn-route')?.visible).toBe(true)
      expect(renderer.flightScene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setTurnTarget('turn-left-exit')
      expect(targets.children.filter((marker) => marker.visible).map((marker) => marker.name)).toEqual(['turn-left-exit-zone'])
      renderer.setTurnTarget(null)
      expect(targets.children.every((marker) => !marker.visible)).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('retains the active L07 step and ground path across scene reconfiguration on the same canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('square-route')
      renderer.setSquareTarget('square-corner-3')
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } })
      const targets = renderer.scene.getObjectByName('square-route-targets')!
      expect(targets.visible).toBe(true)
      expect(targets.children.filter((marker) => marker.visible).map((marker) => marker.name)).toEqual(['square-corner-3-zone'])
      expect(renderer.flightScene.getReference('square-corner-3')?.positionM).toEqual({ x: 18, y: 8, z: -3 })
      expect(renderer.scene.getObjectByName('square-route-path')?.visible).toBe(true)
      expect(renderer.scene.getObjectByName('coordinated-turn-targets')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('direction-control-targets')?.visible).toBe(false)
      expect(renderer.flightScene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setSquareTarget('square-finish')
      expect(targets.children.filter((marker) => marker.visible).map((marker) => marker.name)).toEqual(['square-finish-zone'])
      renderer.setSquareTarget(null)
      expect(targets.children.every((marker) => !marker.visible)).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('retains the L08 crossing step across raised-ground reconfiguration and keeps colocated goals distinct', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('figure-eight')
      renderer.setFigureEightTarget('eight-crossing')
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } })
      const targets = renderer.scene.getObjectByName('figure-eight-targets')!
      const visible = () => targets.children.filter((marker) => marker.visible).map((marker) => marker.name)
      expect(targets.visible).toBe(true)
      expect(visible()).toEqual(['eight-crossing-zone'])
      expect(renderer.flightScene.getReference('eight-crossing')?.positionM).toEqual({ x: 6, y: 8, z: -9 })
      expect(renderer.scene.getObjectByName('figure-eight-path')?.visible).toBe(true)
      expect(renderer.scene.getObjectByName('square-route-targets')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('coordinated-turn-targets')?.visible).toBe(false)
      expect(renderer.flightScene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setFigureEightTarget('eight-finish')
      expect(visible()).toEqual(['eight-finish-zone'])
      expect(renderer.flightScene.getReference('eight-finish')?.positionM)
        .toEqual(renderer.flightScene.getReference('eight-crossing')?.positionM)
      renderer.setFigureEightTarget(null)
      expect(visible()).toEqual([])
      renderer.setFigureEightTarget('unknown')
      expect(visible()).toEqual([])
    } finally {
      renderer.dispose()
    }
  })

  it('retains L09 physical gates and the active guidance across reconfiguration on the same canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('wide-gate')
      renderer.setWideGateTarget('wide-gate-2')
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } })
      const field = renderer.scene.getObjectByName('wide-gate-field')!
      const visibleGuides = () => field.children.flatMap((frame) => frame.children.filter((child) => child.name.endsWith('-guidance') && child.visible).map((child) => child.name))
      const assertFramesRemain = () => {
        expect(field.children).toHaveLength(3)
        expect(field.children.every((frame) => frame.visible)).toBe(true)
        const boxes = field.children.flatMap((frame) => frame.children.filter((child) => !child.name.endsWith('-guidance')))
        expect(boxes).toHaveLength(12)
        expect(boxes.every((box) => box.visible)).toBe(true)
      }
      expect(field.visible).toBe(true)
      expect(visibleGuides()).toEqual(['wide-gate-2-guidance'])
      assertFramesRemain()
      expect(renderer.flightScene.getReference('wide-gate-2')?.positionM).toEqual({ x: 6, y: 8, z: -19 })
      for (const name of ['figure-eight-targets', 'figure-eight-path', 'square-route-targets', 'coordinated-turn-targets']) {
        expect(renderer.scene.getObjectByName(name)?.visible).toBe(false)
      }
      expect(renderer.flightScene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setWideGateTarget('wide-gate-3')
      expect(visibleGuides()).toEqual(['wide-gate-3-guidance'])
      assertFramesRemain()
      for (const id of [null, 'unknown']) {
        renderer.setWideGateTarget(id)
        expect(visibleGuides()).toEqual([])
        assertFramesRemain()
      }
      renderer.setLessonTarget('figure-eight')
      expect(field.visible).toBe(false)
    } finally {
      renderer.dispose()
    }
  })

  it('retains the L10 recovery stage and ground-relative guides on the same renderer and canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('basic-recovery')
      renderer.setRecoveryStage(5)
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } })
      const area = renderer.scene.getObjectByName('basic-recovery-field')!
      const accent = renderer.scene.getObjectByName('recovery-stage-guidance')!
      const level = renderer.scene.getObjectByName('recovery-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(area.visible).toBe(true)
      expect(accent.visible).toBe(true)
      expect(level.material.color.getHex()).toBe(0xffc978)
      expect(renderer.flightScene.getReference('recovery-zone')?.positionM).toEqual({ x: 6, y: 9, z: -3 })
      expect(renderer.flightScene.getReference('recovery-zone')?.sizeM).toEqual({ x: 80, y: 5, z: 80 })
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(false)
      expect(renderer.flightScene.getReference('orbit-poi')?.object.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setRecoveryStage(8)
      expect(level.material.color.getHex()).toBe(0xb8f36b)
      renderer.setRecoveryStage(null)
      expect(accent.visible).toBe(false)
      expect(area.visible).toBe(true)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('basic-recovery-field')?.visible).toBe(true)
      expect(renderer.scene.getObjectByName('recovery-stage-guidance')?.visible).toBe(false)
      renderer.setRecoveryStage(2)
      const updatedLevel = renderer.scene.getObjectByName('recovery-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(updatedLevel.material.color.getHex()).toBe(0x45d7f7)
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      expect(renderer.getStatus()).toEqual({ kind: 'ready' })
      expect(rendererStub.render).toHaveBeenCalledOnce()
      renderer.setLessonTarget('wide-gate')
      expect(renderer.scene.getObjectByName('basic-recovery-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('retains full-roll stage and ground-relative guides across reconfiguration on the same canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('full-roll')
      renderer.setFullRollStage(3)
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 30, z: -3 } })
      const field = renderer.scene.getObjectByName('full-roll-field')!
      const level = renderer.scene.getObjectByName('roll-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(field.visible).toBe(true)
      expect(level.material.color.getHex()).toBe(0xffc978)
      expect(renderer.flightScene.getReference('roll-zone')?.positionM).toEqual({ x: 6, y: 15, z: -3 })
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('basic-recovery-field')?.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setFullRollStage(6)
      expect(level.material.color.getHex()).toBe(0xb8f36b)
      renderer.setFullRollStage(null)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('roll-stage-guidance')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('full-roll-field')?.visible).toBe(true)
      renderer.setFullRollStage(2)
      const nextLevel = renderer.scene.getObjectByName('roll-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(nextLevel.material.color.getHex()).toBe(0x45d7f7)
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      expect(renderer.getStatus()).toEqual({ kind: 'ready' })
      expect(rendererStub.render).toHaveBeenCalledOnce()
      renderer.setLessonTarget('wide-gate')
      expect(renderer.scene.getObjectByName('full-roll-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('retains full-flip stage and ground-relative guides across reconfiguration on the same canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('full-flip')
      renderer.setFullFlipStage(3)
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 30, z: -3 } })
      const field = renderer.scene.getObjectByName('full-flip-field')!
      const level = renderer.scene.getObjectByName('flip-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(field.visible).toBe(true)
      expect(level.material.color.getHex()).toBe(0xffc978)
      expect(renderer.flightScene.getReference('flip-zone')?.positionM).toEqual({ x: 6, y: 15, z: -3 })
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('basic-recovery-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('full-roll-field')?.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setFullFlipStage(6)
      expect(level.material.color.getHex()).toBe(0xb8f36b)
      renderer.setFullFlipStage(null)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('flip-stage-guidance')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('full-flip-field')?.visible).toBe(true)
      renderer.setFullFlipStage(2)
      const nextLevel = renderer.scene.getObjectByName('flip-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(nextLevel.material.color.getHex()).toBe(0x45d7f7)
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      expect(renderer.getStatus()).toEqual({ kind: 'ready' })
      expect(rendererStub.render).toHaveBeenCalledOnce()
      renderer.setLessonTarget('wide-gate')
      expect(renderer.scene.getObjectByName('full-flip-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('retains loop stage and ground-relative guides across scene rebuilds on the same canvas', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('power-loop')
      renderer.setPowerLoopStage(4)
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 30, z: -3 } })
      expect(renderer.scene.getObjectByName('power-loop-field')?.visible).toBe(true)
      const guide = renderer.scene.getObjectByName('loop-stage-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(guide.material.color.getHex()).toBe(0xffc978)
      expect(renderer.scene.getObjectByName('loop-stage-guidance')?.position.toArray()).toEqual([0, 16, -18])
      expect(renderer.flightScene.getReference('loop-zone')?.positionM).toEqual({ x: 6, y: 5 + POWER_LOOP_TARGET_HEIGHT_M, z: -3 })
      expect(renderer.scene.getObjectByName('full-flip-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setPowerLoopStage(8)
      expect(guide.material.color.getHex()).toBe(0xb8f36b)
      renderer.setPowerLoopStage(null)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('loop-stage-guidance')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('power-loop-field')?.visible).toBe(true)
      renderer.setPowerLoopStage(2)
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      expect(renderer.getStatus()).toEqual({ kind: 'ready' })
      expect(rendererStub.render).toHaveBeenCalledOnce()
      renderer.setLessonTarget('wide-gate')
      expect(renderer.scene.getObjectByName('power-loop-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

  it('retains descending half-loop stage and raised-ground anchors after rebuilding the scene', () => {
    const rendererStub = createRendererStub()
    const canvas = document.createElement('canvas')
    const renderer = new FlightRenderer(canvas, { rendererFactory: () => rendererStub })
    try {
      renderer.setLessonTarget('split-s')
      renderer.setSplitSStage(5)
      const previousGuidancePosition = renderer.scene.getObjectByName('split-stage-guidance')!.position.toArray()
      const previous = renderer.flightScene
      const disposePrevious = vi.spyOn(previous, 'dispose')
      renderer.reconfigureScene({ ...DEFAULT_DRONE_CONFIG,
        ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } })
      expect(renderer.scene.getObjectByName('split-s-field')?.visible).toBe(true)
      const guide = renderer.scene.getObjectByName('split-stage-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      expect(guide.material.color.getHex()).toBe(0xffc978)
      const accent = renderer.scene.getObjectByName('split-stage-guidance')!
      expect(accent.position.toArray()).toEqual(previousGuidancePosition)
      expect(accent.rotation.y).toBe(Math.PI)
      expect(renderer.flightScene.getReference('split-zone')?.positionM).toEqual({ x: 6, y: 5 + SPLIT_S_TARGET_HEIGHT_M, z: -3 })
      expect(renderer.flightScene.getReference('split-s-reference')?.object.visible).toBe(false)
      expect(renderer.scene.getObjectByName('power-loop-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('wide-gate-field')?.visible).toBe(false)
      expect(renderer.canvas).toBe(canvas)
      expect(renderer.renderer).toBe(rendererStub)
      expect(disposePrevious).toHaveBeenCalledOnce()
      renderer.setSplitSStage(8)
      expect(guide.material.color.getHex()).toBe(0xb8f36b)
      renderer.setSplitSStage(null)
      renderer.reconfigureScene(DEFAULT_DRONE_CONFIG)
      expect(renderer.scene.getObjectByName('split-stage-guidance')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('split-s-field')?.visible).toBe(true)
      renderer.setSplitSStage(2)
      renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
      expect(renderer.getStatus()).toEqual({ kind: 'ready' })
      expect(rendererStub.render).toHaveBeenCalledOnce()
      renderer.setLessonTarget('power-loop')
      expect(renderer.scene.getObjectByName('split-s-field')?.visible).toBe(false)
      expect(renderer.scene.getObjectByName('power-loop-field')?.visible).toBe(true)
    } finally {
      renderer.dispose()
    }
  })

})
