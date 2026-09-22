import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import App from './App'

describe('application shell', () => {
  it('communicates the safe foundation state', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /train the inputs before you trust the drone/i,
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Phase 8 / Replay build')).toBeInTheDocument()
    expect(screen.getByText('Controller Lab reads only raw input until calibration proves it safe.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /controller lab/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /free flight/i })).toBeEnabled()
    expect(screen.getByRole('heading', { name: /tune the response, then reset/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /apply \+ reset/i })).toBeEnabled()
  })

  it('exposes the implemented signal path without starting simulation', () => {
    render(<App />)

    expect(screen.getByText('RC device')).toBeInTheDocument()
    expect(screen.getByText('Renderer')).toBeInTheDocument()
    expect(screen.getByLabelText('Implemented simulator data flow')).toBeInTheDocument()
    expect(screen.getByText('Free Flight runtime / scroll above')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: /make the transmitter boring/i })).toBeInTheDocument()
    expect(screen.getByText(/Gamepad API unavailable/i)).toBeInTheDocument()
  })

  it('locks tuning actions during countdown and permits them after the lesson is reset', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /start countdown \/ reset/i }))
    const apply = screen.getByRole('button', { name: /apply \+ reset/i })
    const resetDefaults = screen.getByRole('button', { name: /reset defaults/i })
    expect(apply).toBeDisabled()
    expect(resetDefaults).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/locked while a lesson is counting down or active/i)

    const trainingSection = screen.getByRole('heading', { level: 2, name: /train the state/i }).closest('section')
    if (!trainingSection) throw new Error('Training section was not rendered')
    fireEvent.click(within(trainingSection).getByRole('button', { name: /^Reset$/ }))

    expect(apply).toBeEnabled()
    expect(resetDefaults).toBeEnabled()
    fireEvent.click(apply)
    expect(screen.getByRole('status')).toHaveTextContent(/saved and queued/i)
  })
})
