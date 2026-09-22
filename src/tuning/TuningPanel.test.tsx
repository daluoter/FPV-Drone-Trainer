import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import TuningPanel from './TuningPanel'
import { createDefaultTuningSettings, type TuningPersistenceResult, type TuningSettings } from './config'

function saved(): TuningPersistenceResult {
  return { saved: true, errors: [] }
}

describe('bounded tuning panel', () => {
  it('submits edited settings through the explicit apply action', () => {
    const settings = createDefaultTuningSettings()
    const onApply = vi.fn((next: TuningSettings): TuningPersistenceResult => { void next; return saved() })
    render(<TuningPanel settings={settings} onApply={onApply} />)

    fireEvent.change(screen.getByRole('spinbutton', { name: 'ROLL center rate' }), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: /apply \+ reset/i }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0]?.[0].controller.rates.axes.roll.centerRateDegPerSec).toBe(120)
    expect(screen.getByRole('status')).toHaveTextContent(/saved and queued/i)
  })

  it('resets all tuning fields to bounded defaults instead of mutating a live runtime', () => {
    const settings = createDefaultTuningSettings()
    const edited = {
      ...settings,
      controller: {
        ...settings.controller,
        rates: {
          ...settings.controller.rates,
          axes: {
            ...settings.controller.rates.axes,
            roll: { ...settings.controller.rates.axes.roll, centerRateDegPerSec: 120 },
          },
        },
      },
    }
    const onApply = vi.fn((next: TuningSettings): TuningPersistenceResult => { void next; return saved() })
    render(<TuningPanel settings={edited} onApply={onApply} />)

    fireEvent.click(screen.getByRole('button', { name: /reset defaults/i }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0]?.[0].controller.rates.axes.roll.centerRateDegPerSec).toBe(70)
  })
})
