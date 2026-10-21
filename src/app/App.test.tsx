import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('beginner flight school', () => {
  it('starts with a clear first lesson and preserves all existing lessons', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: '小幅操作，一步步學會飛。' })).toBeInTheDocument()
    expect(screen.getByLabelText('選擇課程')).toHaveValue('takeoff')
    expect(screen.getAllByRole('option').filter((option) => /L0[126]|L1[34]/.test(option.textContent ?? ''))).toHaveLength(5)
    expect(screen.getByText(/機體不會自動回平或煞停/)).toBeInTheDocument()
    expect(screen.getByLabelText('操控設定')).toHaveValue('beginner')
  })

  it('keeps the same canvas while changing workspace and opens calibration on request', () => {
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.click(screen.getByRole('button', { name: '自由飛行' }))
    expect(screen.queryByLabelText('選擇課程')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    fireEvent.click(screen.getByRole('button', { name: '開始學飛' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('takeoff')
    fireEvent.click(screen.getByRole('button', { name: '設備與校正' }))
    expect(screen.getByRole('heading', { name: /make the transmitter boring/i })).toBeVisible()
  })

  it('locks inputs and settings throughout countdown and releases them on explicit stop', () => {
    render(<App />)
    const training = document.getElementById('training')!
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeDisabled()
    expect(screen.getByLabelText('控制方式')).toBeDisabled()
    expect(screen.getByLabelText('操控設定')).toBeDisabled()
    expect(screen.getByLabelText('選擇課程')).toBeDisabled()
    fireEvent.click(within(training).getByRole('button', { name: '停止練習' }))
    expect(screen.getByText('準備選課')).toBeInTheDocument()
    expect(screen.getByLabelText('控制方式')).toBeEnabled()
    expect(screen.getByLabelText('操控設定')).toBeEnabled()
  })
})
