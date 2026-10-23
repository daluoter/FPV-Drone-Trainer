import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'

import { createBrowserGamepadPoller } from '../controller'
import type { FlightRenderer, FlightRendererOptions } from '../rendering'
import { createDefaultTuningSettings } from '../tuning'
import FreeFlight from './FreeFlight'
import type { FlightRuntime, FlightRuntimeOptions } from '../runtime'
import { createTrainingMachineState } from '../training/machine'
import type { TrainingMachineState, TrainingResult } from '../training/types'

const frames = vi.hoisted(() => ({ now: 0, next: null as ((time: number) => void) | null, runtime: null as FlightRuntime | null, renderer: null as FlightRenderer | null }))
vi.mock('../runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime')>()
  return { ...actual, FlightRuntime: class extends actual.FlightRuntime {
    constructor(options: FlightRuntimeOptions) {
      super({ ...options, now: () => frames.now, scheduleFrame: (callback) => { frames.next = callback; return 1 }, cancelFrame: () => { frames.next = null } })
      frames.runtime = this
    }
  } }
})

beforeEach(() => { frames.now = 0; frames.next = null; frames.runtime = null; frames.renderer = null })

function frame(time: number): void {
  act(() => { frames.now = time; const callback = frames.next; frames.next = null; callback?.(time) })
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
        frames.renderer = this
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
  const routeLessons = [
    { lessonId: 'direction-control', code: 'L05', prefix: 'direction', total: 9,
      targets: ['direction-right', 'direction-left', 'direction-forward', 'direction-back', 'direction-yaw', 'direction-turned-forward', 'direction-turned-right'],
      button: 'L05 方向示範', group: 'direction-control-targets', completion: '已完成側移、前後移動與換向後方向感' },
    { lessonId: 'coordinated-turn', code: 'L06', prefix: 'turn', total: 8,
      targets: ['turn-right-entry', 'turn-right-apex', 'turn-right-exit', 'turn-left-entry', 'turn-left-apex', 'turn-left-exit'],
      button: 'L06 轉彎示範', group: 'coordinated-turn-targets', completion: '已完成右轉與左轉協調航線' },
  ] as const

  it.each(routeLessons)('switches the active $code scene goal with actual progress while preserving the canvas', ({ lessonId, prefix, total, targets }) => {
    const base = createTrainingMachineState({ initialLessonId: lessonId })
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const { rerender, container } = render(<FreeFlight {...props} trainingState={base} />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    const visible = () => targets.filter((id) => frames.renderer!.flightScene.getReference(id)!.object.visible)
    expect(visible()).toEqual([targets[0]])
    const active: TrainingMachineState = { ...base, phase: 'ACTIVE', lastEvaluation: { status: 'continue',
      metrics: { [`${prefix}Phase`]: 3, [`${prefix}TargetIndex`]: 1, [`${prefix}TargetsCompleted`]: 1,
        targetRightM: -4, targetForwardM: 0, targetUpM: 0, targetDistanceM: 4, headingErrorDegrees: 0 } } }
    rerender(<FreeFlight {...props} trainingState={active} />)
    expect(visible()).toEqual([targets[1]])
    expect(container.querySelector('.school-viewport-hint')).toHaveTextContent('左方 4.0 m')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    rerender(<FreeFlight {...props} trainingState={{ ...active, lastEvaluation: { status: 'success', metrics: { [`${prefix}Phase`]: total, [`${prefix}TargetIndex`]: targets.length } } }} />)
    expect(visible()).toEqual([])
  })

  it.each(routeLessons)('seeks the $code demonstration goal with its ghost and captions without advancing live training', ({ button, targets, completion, group, lessonId }) => {
    const onFixedStep = vi.fn()
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={createDefaultTuningSettings()} onFixedStep={onFixedStep} />)
    fireEvent.click(screen.getByRole('button', { name: button }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const scene = frames.renderer!.flightScene
    expect(scene.getReference(targets[0])!.object.visible).toBe(true)
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.getState().durationSeconds } })
    expect(scene.getReference(targets.at(-1)!)!.object.visible).toBe(true)
    expect(scene.getReference(targets[0])!.object.visible).toBe(false)
    expect(screen.getByText(new RegExp(completion))).toBeInTheDocument()
    if (lessonId === 'direction-control') expect(parseFloat(screen.getByTestId('flight-position-z').textContent!)).toBeGreaterThan(3)
    else {
      expect(parseFloat(screen.getByTestId('flight-position-right').textContent!)).toBeGreaterThan(14)
      expect(parseFloat(screen.getByTestId('flight-position-z').textContent!)).toBeLessThan(-16)
    }
    frame(200)
    frame(400)
    expect(onFixedStep).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(scene.getReference(targets[0])!.object.visible).toBe(true)
    expect(scene.getReference(targets.at(-1)!)!.object.visible).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('button', { name: /^Disarm$/ })).toBeDisabled()
    expect(scene.scene.getObjectByName(group)!.visible).toBe(false)
  })

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
    const recordedAltitude = screen.getByTestId('flight-altitude').textContent
    const recordedRight = screen.getByTestId('flight-position-right').textContent

    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    const changed = { ...settings, drone: { ...settings.drone, ground: { ...settings.drone.ground, heightM: 10 }, spawnPositionM: { x: 5, y: 10, z: 8 } } }
    rerender(<FreeFlight {...props} settings={changed} trainingState={terminal} />)
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    frame(300)
    frame(1_000 / 60 + 300)
    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    expect(frames.runtime!.getReplayRecording()!.durationSeconds).toBeLessThan(source.durationSeconds)
    fireEvent.click(within(review).getByRole('button', { name: '回放：練習結束' }))
    expect(frames.runtime!.getReplayPlayback()?.getState().durationSeconds).toBeCloseTo(source.durationSeconds)
    // Result review uses the old ground and launch origin after tuning changes.
    expect(screen.getByTestId('flight-altitude')).toHaveTextContent(recordedAltitude!)
    expect(screen.getByTestId('flight-position-right')).toHaveTextContent(recordedRight!)
    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    fireEvent.click(screen.getByRole('button', { name: '橫滾 Roll' }))
    expect(screen.queryByRole('region', { name: '本次結果回放' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    fireEvent.click(within(screen.getByRole('region', { name: '本次結果回放' })).getByRole('button', { name: '回放：練習結束' }))
    expect(frames.runtime!.getReplayPlayback()?.getState().durationSeconds).toBeCloseTo(source.durationSeconds)
  })

  it('shows ground-relative altitude and launch-relative coordinates from the paused replay ghost', () => {
    const defaults = createDefaultTuningSettings()
    const settings = { ...defaults, drone: { ...defaults.drone,
      ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 5, y: 10, z: 8 } } }
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={settings} />)
    const hud = screen.getByRole('group', { name: '飛行位置' })
    expect(within(hud).getByTestId('flight-altitude')).toHaveTextContent('0.0 m')
    expect(within(hud).getByTestId('flight-position-right')).toHaveTextContent('0.0 m')
    expect(within(hud).getByTestId('flight-position-z')).toHaveTextContent('0.0 m')
    expect(within(hud).getByTestId('flight-position-x')).toHaveTextContent('X 左右')
    expect(within(hud).getByTestId('flight-position-y')).toHaveTextContent('Y 上下')
    expect(hud).toHaveTextContent('Z 前後')
    fireEvent.click(screen.getByRole('button', { name: 'L03 直線示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.getState().durationSeconds } })
    expect(within(hud).getByText('回放高度')).toBeInTheDocument()
    expect(within(hud).getByTestId('flight-altitude')).toHaveTextContent('3.0 m')
    const finalZ = Number.parseFloat(within(hud).getByTestId('flight-position-z').textContent!)
    expect(finalZ).toBeLessThanOrEqual(-8)
    expect(finalZ).toBeGreaterThan(-10)
    expect(within(hud).getByTestId('flight-position-up')).toHaveTextContent('+3.0 m')
    const paused = hud.textContent
    frame(200)
    frame(500)
    expect(hud.textContent).toBe(paused)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(within(hud).getByTestId('flight-altitude')).toHaveTextContent('0.0 m')
    expect(within(hud).getByTestId('flight-position-z')).toHaveTextContent('0.0 m')
  })

  it('keeps altitude and explicit XYZ values visible after an actual ground-impact crash', () => {
    const defaults = createDefaultTuningSettings()
    const settings = { ...defaults, drone: { ...defaults.drone,
      ground: { ...defaults.drone.ground, heightM: 10 }, spawnPositionM: { x: 2, y: 18, z: -3 } } }
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={settings} />)
    expect(screen.getByRole('checkbox', { name: 'Developer HUD' })).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    // No throttle: the real fixed-step simulation falls from 8 m and latches a crash.
    for (let index = 0; index <= 120; index++) frame(index * 1_000 / 60)
    expect(frames.runtime!.getTelemetry().state.crashed).toBe(true)
    expect(screen.getByText('CRASHED / reset required before re-arming')).toBeInTheDocument()
    const hud = screen.getByRole('group', { name: '飛行位置' })
    expect(hud).toBeVisible()
    expect(within(hud).getByTestId('flight-altitude')).toHaveTextContent('0.0 m')
    expect(within(hud).getByTestId('flight-position-x')).toHaveTextContent('X 左右 0.0 m')
    expect(within(hud).getByTestId('flight-position-y')).toHaveTextContent('Y 上下 0.0 m')
    expect(hud).toHaveTextContent('Z 前後 0.0 m')
    expect(within(hud).getByTestId('flight-position-z')).toHaveTextContent('0.0 m')
  })

  it('keeps the original recovery cause on the viewport until a valid lesson checkpoint resumes', () => {
    const state: TrainingMachineState = { ...createTrainingMachineState({ initialLessonId: 'straight-line' }),
      phase: 'ACTIVE', recoveryInProgress: true,
      lastRecovery: { timestampSeconds: 3, message: '偏離中心線 1.40 m，允許最多 1.25 m。', hint: '先減少側移，再回起飛區接地。', metrics: {} },
      lastEvaluation: { status: 'continue', recovery: 'restart', message: '尚未完成地面準備。', metrics: { routePhase: 0 } },
    }
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const { container, rerender } = render(<FreeFlight {...props} trainingState={state} />)
    expect(container.querySelector('.school-viewport-hint')).toHaveTextContent('偏離中心線 1.40 m')
    expect(container.querySelector('.school-viewport-hint')).not.toHaveTextContent('尚未完成地面準備')
    rerender(<FreeFlight {...props} trainingState={{ ...state, recoveryInProgress: false, lastEvaluation: { status: 'continue', checkpointIds: ['straight-ground'], metrics: { routePhase: 0 } } }} />)
    expect(container.querySelector('.school-viewport-hint')).not.toHaveTextContent('偏離中心線')
    expect(container.querySelector('.school-viewport-hint')).toHaveTextContent('起飛')
  })
})
