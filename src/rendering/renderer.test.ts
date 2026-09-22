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

  it('reports context loss, skips invisible rendering, and resumes after restoration', () => {
    const canvas = document.createElement('canvas')
    const rendererStub = createRendererStub()
    const statuses: FlightRendererStatus[] = []
    const renderer = new FlightRenderer(canvas, {
      rendererFactory: () => rendererStub,
      onStatusChange: (status) => statuses.push(status),
    })

    expect(statuses.at(-1)?.kind).toBe('ready')
    canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(statuses.at(-1)?.kind).toBe('context-lost')
    renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
    expect(rendererStub.render).not.toHaveBeenCalled()

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(statuses.at(-1)?.kind).toBe('ready')
    renderer.render(createInitialDroneState(DEFAULT_DRONE_CONFIG))
    expect(rendererStub.render).toHaveBeenCalledOnce()
    renderer.dispose()
  })
})
