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

})
