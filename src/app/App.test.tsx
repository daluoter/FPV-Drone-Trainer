import { render, screen } from '@testing-library/react'
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
    expect(screen.getByText('Phase 7 / Flight school build')).toBeInTheDocument()
    expect(screen.getByText('Controller Lab reads only raw input until calibration proves it safe.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /controller lab/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /free flight/i })).toBeEnabled()
    expect(screen.getByRole('heading', { name: /tune the response, then reset/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /apply \+ reset/i })).toBeEnabled()
  })

  it('exposes the planned signal path without starting simulation', () => {
    render(<App />)

    expect(screen.getByText('RC device')).toBeInTheDocument()
    expect(screen.getByText('Renderer')).toBeInTheDocument()
    expect(screen.getByText('Free Flight runtime / scroll above')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: /make the transmitter boring/i })).toBeInTheDocument()
    expect(screen.getByText(/Gamepad API unavailable/i)).toBeInTheDocument()
  })
})
