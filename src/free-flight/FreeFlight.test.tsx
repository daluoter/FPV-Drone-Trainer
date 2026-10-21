import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'

import { createBrowserGamepadPoller } from '../controller'
import type { FlightRendererOptions } from '../rendering'
import { createDefaultTuningSettings } from '../tuning'
import FreeFlight from './FreeFlight'
import type { FlightRuntime, FlightRuntimeOptions } from '../runtime'
import { createTrainingMachineState } from '../training/machine'
import type { TrainingMachineState, TrainingResult } from '../training/types'

const frames = vi.hoisted(() => ({ next: null as ((time: number) => void) | null, runtime: null as FlightRuntime | null }))
vi.mock('../runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime')>()
  return { ...actual, FlightRuntime: class extends actual.FlightRuntime {
    constructor(options: FlightRuntimeOptions) {
      super({ ...options, scheduleFrame: (callback) => { frames.next = callback; return 1 }, cancelFrame: () => { frames.next = null } })
      frames.runtime = this
    }
  } }
})

beforeEach(() => { frames.next = null; frames.runtime = null })

function frame(time: number): void {
  act(() => { const callback = frames.next; frames.next = null; callback?.(time) })
}

// Keep the real runtime, scene and arm gates; only replace the unavailable GPU.
vi.mock('../rendering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rendering')>()
  return {
    ...actual,
    FlightRenderer: class extends actual.FlightRenderer {
      public constructor(canvas: HTMLCanvasElement, options: FlightRendererOptions = {}) {
        super(canvas, {
          ...options,
          rendererFactory: () => ({
            dispose: vi.fn(),
            render: vi.fn(),
            setPixelRatio: vi.fn(),
            setSize: vi.fn(),
            shadowMap: { enabled: false },
          }) as unknown as THREE.WebGLRenderer,
        })
      }
    },
  }
})

function attemptUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('Free Flight native navigation confirmation', () => {
  it('requests confirmation while armed and removes it after an explicit disarm', () => {
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={createDefaultTuningSettings()} />)
    expect(attemptUnload().defaultPrevented).toBe(false)

    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    expect(screen.getByText('ARMED / simulation running')).toBeInTheDocument()
    expect(attemptUnload().defaultPrevented).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    expect(attemptUnload().defaultPrevented).toBe(false)
  })

  it('protects a pending lesson while disarmed and cleans up when safe or unmounted', () => {
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const { rerender, unmount } = render(<FreeFlight {...props} trainingSettingsLocked />)
    expect(attemptUnload().defaultPrevented).toBe(true)

    rerender(<FreeFlight {...props} trainingSettingsLocked={false} />)
    expect(attemptUnload().defaultPrevented).toBe(false)

    rerender(<FreeFlight {...props} trainingSettingsLocked />)
    expect(attemptUnload().defaultPrevented).toBe(true)
    unmount()
    expect(attemptUnload().defaultPrevented).toBe(false)
  })

  it('exits a demonstration from the inline lesson request without arming or replacing the canvas', () => {
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const { rerender } = render(<FreeFlight {...props} />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: '橫滾 Roll' }))
    expect(screen.getByRole('button', { name: '結束示範' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '結束示範／回到練習' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeDisabled()

    rerender(<FreeFlight {...props} exitPlaybackRequest={1} />)
    expect(screen.queryByRole('button', { name: '結束示範' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Disarm$/ })).toBeDisabled()
    expect(screen.getByText('SAFE / disarmed')).toBeInTheDocument()

    // A consumed request must not immediately close a newly opened demonstration.
    fireEvent.click(screen.getByRole('button', { name: '偏航 Yaw' }))
    expect(screen.getByRole('button', { name: '結束示範' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Disarm$/ })).toBeDisabled()
  })

  it('seeks session-bound result markers while paused and preserves their recording after another flight or demo', () => {
    const defaults = createDefaultTuningSettings()
    const settings = { ...defaults, drone: { ...defaults.drone, spawnPositionM: { x: 0, y: 0, z: 0 } } }
    const onFixedStep = vi.fn()
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings, onFixedStep }
    const { rerender } = render(<FreeFlight {...props} />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    for (let index = 0; index <= 8; index++) frame(index * 1_000 / 60)
    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    const source = frames.runtime!.getReplayRecording()!
    expect(source.samples.length).toBeGreaterThan(3)
    const start = source.samples[0]!.timestampSeconds
    const finish = source.samples.at(-1)!.timestampSeconds
    const checkpointTime = source.samples[1]!.timestampSeconds
    // A terminal UI fixture exercises recording binding, not lesson mastery.
    const result: TrainingResult = { lessonId: 'takeoff', sessionId: 'takeoff:review', outcome: 'FAILED', score: 0,
      startedAtSeconds: start, completedAtSeconds: finish, elapsedSeconds: finish - start,
      sampleCount: 32, completedCheckpoints: 1, totalCheckpoints: 3, metrics: {}, message: 'Stopped', hint: null }
    const terminal: TrainingMachineState = { ...createTrainingMachineState({ initialLessonId: 'takeoff' }), phase: 'RESULT', sessionId: result.sessionId, result,
      checkpoints: { 'takeoff-ready': { id: 'takeoff-ready', completed: true, completedAtSeconds: checkpointTime, metrics: {} } } }
    rerender(<FreeFlight {...props} trainingState={terminal} />)
    const review = screen.getByRole('region', { name: '本次結果回放' })
    const firstMarker = within(review).getAllByRole('button')[0]!
    const beforePlayback = onFixedStep.mock.calls.length
    fireEvent.click(firstMarker)
    expect(frames.runtime!.getReplayPlayback()?.currentTime).toBeCloseTo(checkpointTime - start)
    expect(frames.runtime!.getReplayPlayback()?.getState().playing).toBe(false)
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Disarm$/ })).toBeDisabled()
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    frame(200)
    frame(250)
    expect(onFixedStep).toHaveBeenCalledTimes(beforePlayback)

    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    frame(300)
    frame(1_000 / 60 + 300)
    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    expect(frames.runtime!.getReplayRecording()!.durationSeconds).toBeLessThan(source.durationSeconds)
    fireEvent.click(within(review).getByRole('button', { name: '回放：練習結束' }))
    expect(frames.runtime!.getReplayPlayback()?.getState().durationSeconds).toBeCloseTo(source.durationSeconds)
    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    fireEvent.click(screen.getByRole('button', { name: '橫滾 Roll' }))
    expect(screen.queryByRole('region', { name: '本次結果回放' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    fireEvent.click(within(screen.getByRole('region', { name: '本次結果回放' })).getByRole('button', { name: '回放：練習結束' }))
    expect(frames.runtime!.getReplayPlayback()?.getState().durationSeconds).toBeCloseTo(source.durationSeconds)
  })
})
