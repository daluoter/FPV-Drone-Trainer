import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { NormalizedRcInput } from '../flight-controller'
import Mode2StickOverlay from './StickOverlay'

const centered: NormalizedRcInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0 }

function dot(label: 'Left' | 'Right'): HTMLElement {
  const pad = screen.getByLabelText(label === 'Left' ? 'Left stick: Throttle and Yaw' : 'Right stick: Pitch and Roll')
  return pad.querySelector<HTMLElement>('.mode2-stick-dot')!
}

describe.each(['live', 'demonstration'] as const)('physical Mode 2 sticks in %s', (mode) => {
  it.each([
    { name: 'nose-up input as a backward pull', pitch: 1, top: '92%' },
    { name: 'nose-down input as a forward push', pitch: -1, top: '8%' },
    { name: 'released pitch at center', pitch: 0, top: '50%' },
  ])('shows $name', ({ pitch, top }) => {
    const input = Object.freeze({ ...centered, pitch })
    render(<Mode2StickOverlay input={input} mode={mode} />)

    expect(dot('Right')).toHaveStyle({ left: '50%', top })
    expect(screen.getByText('Pitch ↓＋')).toBeInTheDocument()
    expect(screen.getByText('右桿前推：低頭（−）；後拉：抬頭（＋）。')).toBeInTheDocument()
    expect(input).toEqual({ ...centered, pitch })
  })

  it.each([
    { roll: 1, yaw: -1, throttle: 1, right: '92%', left: '8%', top: '8%' },
    { roll: -1, yaw: 1, throttle: 0, right: '8%', left: '92%', top: '92%' },
  ])('keeps roll $roll, yaw $yaw and throttle $throttle in their physical directions', ({ roll, yaw, throttle, right, left, top }) => {
    render(<Mode2StickOverlay input={{ ...centered, roll, yaw, throttle }} mode={mode} />)

    expect(dot('Right')).toHaveStyle({ left: right, top: '50%' })
    expect(dot('Left')).toHaveStyle({ left, top })
    expect(screen.getByText('Throttle ↑＋')).toBeInTheDocument()
  })
})
