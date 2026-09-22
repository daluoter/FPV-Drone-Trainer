import { describe, expect, it } from 'vitest'
import { DEFAULT_DRONE_CONFIG, hoverThrottle } from '../drone'
import { quaternionNearlyEqual } from '../math'
import { DroneSimulation } from './simulation'
import { FixedTimestepAccumulator } from './fixed-step'

function runForOneSecond(renderHz: number): DroneSimulation {
  const simulation = new DroneSimulation()
  const command = hoverThrottle()
  const frameDelta = 1 / renderHz
  for (let frame = 0; frame < renderHz; frame += 1) {
    simulation.advance(frameDelta, [command, command, command, command])
  }
  return simulation
}

describe('fixed timestep simulation', () => {
  it('produces equivalent state across common render rates', () => {
    const at60 = runForOneSecond(60).getState()
    const at120 = runForOneSecond(120).getState()
    const at144 = runForOneSecond(144).getState()
    expect(at60.stepIndex).toBe(240)
    expect(at120.stepIndex).toBe(240)
    expect(at144.stepIndex).toBe(240)
    expect(at60.positionM.x).toBeCloseTo(at120.positionM.x, 10)
    expect(at60.positionM.y).toBeCloseTo(at144.positionM.y, 10)
    expect(at60.velocityMps.y).toBeCloseTo(at120.velocityMps.y, 10)
    expect(quaternionNearlyEqual(at60.orientation, at144.orientation, 1e-10)).toBe(true)
  })

  it('bounds catch-up work and reports exact dropped time', () => {
    const accumulator = new FixedTimestepAccumulator({
      stepSeconds: 0.1,
      maxCatchUpSteps: 2,
      maxFrameDeltaSeconds: 1,
    })
    let steps = 0
    const result = accumulator.advance(0.55, () => { steps += 1 })
    expect(steps).toBe(2)
    expect(result.steps).toBe(2)
    expect(result.droppedSteps).toBe(3)
    expect(result.droppedSeconds).toBeCloseTo(0.3, 12)
    expect(result.accumulatorSeconds).toBeCloseTo(0.05, 12)
    expect(result.simulatedSeconds + result.droppedSeconds + result.accumulatorSeconds).toBeCloseTo(0.55, 12)
    expect(result.warnings.join(' ')).toContain('Dropped')
  })

  it('reports invalid fixed-step configuration while using safe defaults', () => {
    const accumulator = new FixedTimestepAccumulator({ stepSeconds: 0, maxCatchUpSteps: 0 })
    const result = accumulator.advance(1 / 60, () => undefined)
    expect(result.warnings.join(' ')).toContain('Invalid fixed timestep configuration')
    expect(result.warnings.join(' ')).toContain('Invalid fixed catch-up configuration')
  })

  it('reports a discarded remainder when an invalid render delta resets the accumulator', () => {
    const accumulator = new FixedTimestepAccumulator({ stepSeconds: 0.1, maxFrameDeltaSeconds: 1 })
    accumulator.advance(0.05, () => undefined)

    const result = accumulator.advance(Number.NaN, () => undefined)

    expect(result.steps).toBe(0)
    expect(result.droppedSteps).toBe(0)
    expect(result.droppedSeconds).toBeCloseTo(0.05, 12)
    expect(result.accumulatorSeconds).toBe(0)
    expect(result.warnings.join(' ')).toContain('Invalid render delta')
  })

  it('rejects non-finite render deltas instead of silently integrating', () => {
    const simulation = new DroneSimulation(DEFAULT_DRONE_CONFIG)
    const result = simulation.advance(Number.NaN, [0, 0, 0, 0])
    expect(result.steps).toBe(0)
    expect(result.warnings.join(' ')).toContain('Invalid render delta')
    expect(simulation.getState().stepIndex).toBe(0)
  })
})
