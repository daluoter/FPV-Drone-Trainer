import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'

import { createBrowserGamepadPoller } from '../controller'
import type { FlightRendererOptions } from '../rendering'
import { createDefaultTuningSettings } from '../tuning'
import FreeFlight from './FreeFlight'

// Keep the real runtime, scene and arm gates; only replace the unavailable GPU.
vi.mock('../rendering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rendering')>()
  return {
    ...actual,
    FlightRenderer: class extends actual.FlightRenderer {
      public constructor(canvas: HTMLCanvasElement, options: FlightRendererOptions = {}) {
        super(canvas, {
          ...options,
          rendererFactory: () => ({
            dispose: vi.fn(),
            render: vi.fn(),
            setPixelRatio: vi.fn(),
            setSize: vi.fn(),
            shadowMap: { enabled: false },
          }) as unknown as THREE.WebGLRenderer,
        })
      }
    },
  }
})

function attemptUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('Free Flight native navigation confirmation', () => {
  it('requests confirmation while armed and removes it after an explicit disarm', () => {
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={createDefaultTuningSettings()} />)
    expect(attemptUnload().defaultPrevented).toBe(false)

    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    expect(screen.getByText('ARMED / simulation running')).toBeInTheDocument()
    expect(attemptUnload().defaultPrevented).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    expect(attemptUnload().defaultPrevented).toBe(false)
  })

  it('protects a pending lesson while disarmed and cleans up when safe or unmounted', () => {
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const { rerender, unmount } = render(<FreeFlight {...props} trainingSettingsLocked />)
    expect(attemptUnload().defaultPrevented).toBe(true)

    rerender(<FreeFlight {...props} trainingSettingsLocked={false} />)
    expect(attemptUnload().defaultPrevented).toBe(false)

    rerender(<FreeFlight {...props} trainingSettingsLocked />)
    expect(attemptUnload().defaultPrevented).toBe(true)
    unmount()
    expect(attemptUnload().defaultPrevented).toBe(false)
  })
})
