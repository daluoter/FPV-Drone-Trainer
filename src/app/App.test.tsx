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
    expect(screen.getByText('Controller Lab build')).toBeInTheDocument()
    expect(screen.getByText('Controller Lab reads only raw input until calibration proves it safe.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /controller lab/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /free flight/i })).toBeDisabled()
  })

  it('exposes the planned signal path without starting simulation', () => {
    render(<App />)

    expect(screen.getByText('RC device')).toBeInTheDocument()
    expect(screen.getByText('Renderer')).toBeInTheDocument()
    expect(screen.getByText('No flight simulation running')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: /make the transmitter boring/i })).toBeInTheDocument()
    expect(screen.getByText(/Gamepad API unavailable/i)).toBeInTheDocument()
  })
})
