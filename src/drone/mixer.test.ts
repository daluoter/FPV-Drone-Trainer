import { describe, expect, it } from 'vitest'
import { mixQuadX } from './mixer'

describe('Quad-X mixer', () => {
  it('applies pure throttle equally to all motors', () => {
    const result = mixQuadX({ throttle: 0.35, roll: 0, pitch: 0, yaw: 0 })
    expect(result.commands).toEqual([0.35, 0.35, 0.35, 0.35])
    expect(result.saturated).toBe(false)
  })

  it('increases the left motors for pilot-positive roll', () => {
    const result = mixQuadX({ throttle: 0.5, roll: 0.25, pitch: 0, yaw: 0 })
    expect(result.commands).toEqual([0.75, 0.25, 0.75, 0.25])
  })

  it('increases the front motors for pilot-positive pitch', () => {
    const result = mixQuadX({ throttle: 0.5, roll: 0, pitch: 0.25, yaw: 0 })
    expect(result.commands).toEqual([0.75, 0.75, 0.25, 0.25])
  })

  it('increases the CCW motors for pilot-positive yaw', () => {
    const result = mixQuadX({ throttle: 0.5, roll: 0, pitch: 0, yaw: 0.25 })
    expect(result.commands).toEqual([0.75, 0.25, 0.25, 0.75])
  })

  it('reports saturation while preserving the differential direction', () => {
    const result = mixQuadX({ throttle: 0.8, roll: 0.6, pitch: 0, yaw: 0 })
    expect(result.saturated).toBe(true)
    expect(result.commands[0]).toBeGreaterThan(result.commands[1])
    expect(result.commands.every((command) => command >= 0 && command <= 1)).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('saturated'))).toBe(true)
  })
})
