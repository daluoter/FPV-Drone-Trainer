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
    expect(screen.getByText('Foundation build')).toBeInTheDocument()
    expect(screen.getByText('No transmitter data is read or acted on in this build.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /controller lab/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /free flight/i })).toBeDisabled()
  })

  it('exposes the planned signal path without starting simulation', () => {
    render(<App />)

    expect(screen.getByText('RC device')).toBeInTheDocument()
    expect(screen.getByText('Renderer')).toBeInTheDocument()
    expect(screen.getByText('No flight simulation running')).toBeInTheDocument()
  })
})
