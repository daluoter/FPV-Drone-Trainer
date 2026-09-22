import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ControllerLab from './ControllerLab'
import {
  ControllerProfileStore,
  createControllerProfile,
  markDirectionsVerified,
  markNeutralVerified,
} from './profile'
import type { GamepadLike, NeutralStabilityReport } from './types'

const report: NeutralStabilityReport = {
  sampleCount: 100,
  durationMs: 3_000,
  threshold: 0.02,
  maxAbsolute: { roll: 0.005, pitch: 0.005, yaw: 0.005 },
  mean: { roll: 0, pitch: 0, yaw: 0 },
  standardDeviation: { roll: 0.001, pitch: 0.001, yaw: 0.001 },
  stable: true,
  reason: 'stable',
}

function gamepad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    id: 'ControllerLab interaction pad',
    index: 0,
    connected: true,
    mapping: '',
    axes: [0, 0, 0, -1],
    buttons: [{ pressed: false, touched: false, value: 0 }],
    timestamp: 1,
    ...overrides,
  }
}

function seedProfile(): void {
  const device = {
    id: 'ControllerLab interaction pad',
    index: 0,
    connected: true,
    mapping: '',
    axisCount: 4,
    buttonCount: 1,
  }
  const profile = createControllerProfile(device, {
    roll: { axis: 0, center: 0, minimum: -1, maximum: 1 },
    pitch: { axis: 1, center: 0, minimum: -1, maximum: 1 },
    yaw: { axis: 2, center: 0, minimum: -1, maximum: 1 },
    throttle: { axis: 3, center: -1, minimum: -1, maximum: 1 },
  })
  const verified = markNeutralVerified(
    markDirectionsVerified(profile),
    report,
    '2026-01-01T00:00:00.000Z',
    'old-page-session',
  )
  expect(new ControllerProfileStore(window.localStorage).save(verified).saved).toBe(true)
}

describe('ControllerLab connection and live polling interactions', () => {
  let pads: readonly (GamepadLike | null)[]
  let frame: ((time: number) => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    pads = [gamepad()]
    frame = null
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => pads,
    })
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  function pollNextFrame(): void {
    const next = frame
    if (next) next(16)
  }

  it('loads calibration but requires a fresh neutral test after reconnect', async () => {
    seedProfile()
    render(<ControllerLab />)
    await act(async () => {
      vi.advanceTimersByTime(120)
    })

    expect(screen.getByRole('heading', { name: /neutral stability/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run 3-second neutral test/i })).toBeInTheDocument()
    expect(screen.getByText(/historical pass; rerun/i)).toBeInTheDocument()

    pads = []
    await act(async () => {
      pollNextFrame()
      vi.advanceTimersByTime(120)
    })
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument()

    pads = [gamepad({ timestamp: 32 })]
    await act(async () => {
      pollNextFrame()
      vi.advanceTimersByTime(120)
      pollNextFrame()
      vi.advanceTimersByTime(120)
    })
    expect(screen.getByRole('heading', { name: /neutral stability/i })).toBeInTheDocument()
    expect(screen.getByText(/historical pass; rerun/i)).toBeInTheDocument()
  })

  it('aborts neutral capture on disconnect and displays live filtered output', async () => {
    seedProfile()
    render(<ControllerLab />)
    await act(async () => {
      vi.advanceTimersByTime(120)
    })

    const neutralButton = screen.getByRole('button', { name: /run 3-second neutral test/i })
    await act(async () => {
      neutralButton.click()
      pads = []
      pollNextFrame()
      vi.advanceTimersByTime(60)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/disconnected during capture/i)

    pads = [gamepad({ timestamp: 32 })]
    await act(async () => {
      pollNextFrame()
      vi.advanceTimersByTime(120)
      pollNextFrame()
      vi.advanceTimersByTime(120)
    })
    pads = [gamepad({ axes: [0.7, 0, 0, -1], timestamp: 48 })]
    await act(async () => {
      pollNextFrame()
      vi.advanceTimersByTime(120)
    })
    const rollRow = screen.getByRole('row', { name: /ROLL/i })
    const cells = rollRow.querySelectorAll('td')
    expect(cells[3]?.textContent).not.toBe(cells[4]?.textContent)
  })
})
