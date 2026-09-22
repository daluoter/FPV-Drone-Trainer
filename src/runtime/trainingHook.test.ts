import { describe, expect, it } from 'vitest'

import { FlightRuntime } from './flightRuntime'

function frames() {
  let callback: ((time: number) => void) | null = null
  return {
    schedule: (next: (time: number) => void): number => {
      callback = next
      return 1
    },
    cancel: (): void => undefined,
    run: (time: number): void => callback?.(time),
  }
}

describe('FlightRuntime fixed-step training hook', () => {
  it('publishes one sample per completed fixed step without a second loop', () => {
    const runner = frames()
    const samples: Array<{ timestampSeconds: number; stepIndex: number }> = []
    const runtime = new FlightRuntime({
      scheduleFrame: runner.schedule,
      cancelFrame: runner.cancel,
      onFixedStep: (sample) => {
        samples.push({
          timestampSeconds: sample.timestampSeconds,
          stepIndex: sample.state.stepIndex,
        })
        ;(sample.state.positionM as { x: number }).x = 999
      },
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    runner.run(0)
    expect(runtime.arm()).toBe(true)
    runner.run(100)

    expect(samples.length).toBe(runtime.simulation.getState().stepIndex)
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.every((sample, index) => sample.stepIndex === index + 1)).toBe(true)
    expect(runtime.simulation.getState().positionM.x).not.toBe(999)
    expect(samples.every((sample, index) => index === 0 || sample.timestampSeconds > samples[index - 1].timestampSeconds)).toBe(true)
    runtime.dispose()
  })
})
