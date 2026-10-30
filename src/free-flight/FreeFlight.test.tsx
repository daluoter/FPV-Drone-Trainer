import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'

import { createBrowserGamepadPoller } from '../controller'
import type { FlightRenderer, FlightRendererOptions } from '../rendering'
import { createDefaultTuningSettings } from '../tuning'
import FreeFlight from './FreeFlight'
import App from '../app/App'
import type { FlightRuntime, FlightRuntimeOptions } from '../runtime'
import { createTrainingMachineState } from '../training/machine'
import { measureBasicRecoveryMotion } from '../training/basicRecovery'
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

function cameraPointer(canvas: HTMLElement, type: string, x: number, y: number, button = 0, shiftKey = false): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y,
    button, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : button === 2 ? 2 : 1, shiftKey })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  fireEvent(canvas, event)
}

describe('interactive free camera', () => {
  it('orbits, pans and zooms the view while preserving live drone state, input and learning results', () => {
    window.localStorage.clear()
    render(<App />)
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    frame(0)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    const renderer = frames.renderer!
    const runtime = frames.runtime!
    const state = JSON.stringify(runtime.simulation.getState())
    const saved = Object.fromEntries(Object.entries(window.localStorage))
    fireEvent.click(screen.getByRole('button', { name: 'Free / debug' }))
    expect(canvas).toHaveAttribute('tabindex', '0')
    expect(screen.getByLabelText('自由鏡頭操作')).toBeVisible()
    canvas.focus()
    const initial = renderer.getFreeCameraState()
    cameraPointer(canvas, 'pointerdown', 100, 100)
    cameraPointer(canvas, 'pointermove', 150, 120)
    cameraPointer(canvas, 'pointerup', 150, 120)
    const orbited = renderer.getFreeCameraState()
    expect(orbited.positionM).not.toEqual(initial.positionM)
    expect(orbited.targetM).toEqual(initial.targetM)
    cameraPointer(canvas, 'pointerdown', 100, 100, 2)
    cameraPointer(canvas, 'pointermove', 140, 125, 2)
    cameraPointer(canvas, 'pointerup', 140, 125, 2)
    const panned = renderer.getFreeCameraState()
    expect(panned.targetM).not.toEqual(orbited.targetM)
    fireEvent.wheel(canvas, { deltaY: -120, cancelable: true })
    expect(renderer.getFreeCameraState().distanceM).toBeLessThan(panned.distanceM)
    const beforeHeight = renderer.getFreeCameraState()
    const raiseCamera = screen.getByRole('button', { name: '升高鏡頭 1 m' })
    raiseCamera.focus()
    fireEvent.click(raiseCamera)
    fireEvent.click(raiseCamera)
    const raised = renderer.getFreeCameraState()
    expect(raised.positionM.y).toBeCloseTo(beforeHeight.positionM.y + 2)
    expect(raised.targetM.y).toBeCloseTo(beforeHeight.targetM.y + 2)
    expect(document.activeElement).toBe(raiseCamera)
    fireEvent.click(screen.getByRole('button', { name: '降低鏡頭 1 m' }))
    const lowered = renderer.getFreeCameraState()
    expect(lowered.positionM.y).toBeCloseTo(beforeHeight.positionM.y + 1)
    expect(lowered.targetM.y).toBeCloseTo(beforeHeight.targetM.y + 1)
    expect(lowered.positionM.x).toBeCloseTo(beforeHeight.positionM.x)
    expect(lowered.positionM.z).toBeCloseTo(beforeHeight.positionM.z)
    expect(lowered.distanceM).toBeCloseTo(beforeHeight.distanceM)
    const viewForward = renderer.camera.getWorldDirection(renderer.camera.position.clone()).setY(0).normalize()
    const viewRight = viewForward.clone().cross(renderer.camera.up).normalize()
    for (const [name, direction] of [
      ['前移鏡頭 1 m', viewForward], ['後移鏡頭 1 m', viewForward.clone().negate()],
      ['左移鏡頭 1 m', viewRight.clone().negate()], ['右移鏡頭 1 m', viewRight],
    ] as const) {
      const before = renderer.getFreeCameraState()
      const button = screen.getByRole('button', { name })
      button.focus()
      fireEvent.click(button)
      const moved = renderer.getFreeCameraState()
      expect(document.activeElement).toBe(button)
      expect(moved.targetM.y).toBe(before.targetM.y)
      expect(moved.positionM.y).toBeCloseTo(before.positionM.y)
      for (const axis of ['x', 'z'] as const) expect(moved.targetM[axis] - before.targetM[axis]).toBeCloseTo(direction[axis])
      expect(moved.distanceM).toBeCloseTo(before.distanceM)
    }
    expect(JSON.stringify(runtime.simulation.getState())).toBe(state)
    expect(runtime.keyboard.getInput()).toEqual({ roll: 0, pitch: 0, yaw: 0, throttle: 0 })
    expect(Object.fromEntries(Object.entries(window.localStorage))).toEqual(saved)
    fireEvent.click(screen.getByRole('button', { name: '定位飛機' }))
    expect(renderer.getFreeCameraState().targetM).toEqual(runtime.simulation.getState().positionM)
    fireEvent.click(screen.getByRole('button', { name: 'FPV' }))
    expect(screen.queryByLabelText('自由鏡頭操作')).not.toBeInTheDocument()
    const inactive = renderer.getFreeCameraState()
    cameraPointer(canvas, 'pointerdown', 100, 100)
    cameraPointer(canvas, 'pointermove', 180, 150)
    cameraPointer(canvas, 'pointerup', 180, 150)
    fireEvent.wheel(canvas, { deltaY: -120, cancelable: true })
    expect(renderer.getFreeCameraState()).toEqual(inactive)
  })

  it('moves with focused camera keys and releases held motion on blur or mode exit without driving the drone', () => {
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => frames.now)
    try {
      render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={createDefaultTuningSettings()} />)
      fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
      frame(0)
      const canvas = screen.getByLabelText('Free Flight 3D scene')
      const renderer = frames.renderer!
      const runtime = frames.runtime!
      fireEvent.click(screen.getByRole('button', { name: 'Free / debug' }))
      canvas.focus()
      const initial = renderer.getFreeCameraState()
      fireEvent.keyDown(canvas, { key: 'ArrowRight' })
      frame(100)
      expect(renderer.getFreeCameraState().targetM).not.toEqual(initial.targetM)
      expect(runtime.keyboard.getInput()).toEqual({ roll: 0, pitch: 0, yaw: 0, throttle: 0 })
      expect(runtime.getTelemetry().armed).toBe(false)
      expect(runtime.simulation.getState().positionM).toEqual({ x: 0, y: expect.any(Number), z: 0 })
      canvas.blur()
      const blurred = renderer.getFreeCameraState()
      frame(200)
      expect(renderer.getFreeCameraState()).toEqual(blurred)
      canvas.focus()
      fireEvent.keyDown(canvas, { key: 'PageUp' })
      frame(300)
      fireEvent.click(screen.getByRole('button', { name: 'Chase' }))
      const switched = renderer.getFreeCameraState()
      frame(400)
      fireEvent.keyUp(window, { key: 'PageUp' })
      fireEvent.click(screen.getByRole('button', { name: 'Free / debug' }))
      frame(500)
      expect(renderer.getFreeCameraState()).toEqual(switched)
      expect(runtime.keyboard.consumeResetRequest()).toBe(false)
    } finally { clock.mockRestore() }
  })

  it('reframes the paused replay ghost and changes only its camera while preserving playback, live state and saved results', () => {
    window.localStorage.clear()
    render(<App />)
    frame(0)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    const renderer = frames.renderer!
    const runtime = frames.runtime!
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L13 大迴旋示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const playback = runtime.getReplayPlayback()!
    fireEvent.change(screen.getByRole('slider'), { target: { value: playback.durationSeconds } })
    const ghost = playback.getGhostState()!
    const live = JSON.stringify(runtime.simulation.getState())
    const time = playback.getState().currentTimeSeconds
    const progress = screen.getByRole('region', { name: '示範進度' }).textContent
    fireEvent.click(screen.getByRole('button', { name: 'Free / debug' }))
    expect(renderer.getFreeCameraState().targetM).toEqual(ghost.positionM)
    const beforeHeight = renderer.getFreeCameraState()
    fireEvent.click(screen.getByRole('button', { name: '降低鏡頭 1 m' }))
    expect(renderer.getFreeCameraState().positionM.y).toBeCloseTo(beforeHeight.positionM.y - 1)
    expect(renderer.getFreeCameraState().targetM.y).toBeCloseTo(ghost.positionM.y - 1)
    fireEvent.click(screen.getByRole('button', { name: '升高鏡頭 1 m' }))
    expect(renderer.getFreeCameraState().positionM.y).toBeCloseTo(beforeHeight.positionM.y)
    expect(renderer.getFreeCameraState().targetM.y).toBeCloseTo(ghost.positionM.y)
    fireEvent.click(screen.getByRole('button', { name: '前移鏡頭 1 m' }))
    const forward = renderer.getFreeCameraState()
    expect(Math.hypot(forward.targetM.x - ghost.positionM.x, forward.targetM.z - ghost.positionM.z)).toBeCloseTo(1)
    expect(forward.targetM.y).toBeCloseTo(ghost.positionM.y)
    for (const name of ['左移鏡頭 1 m', '右移鏡頭 1 m', '後移鏡頭 1 m']) fireEvent.click(screen.getByRole('button', { name }))
    canvas.focus()
    cameraPointer(canvas, 'pointerdown', 100, 100)
    cameraPointer(canvas, 'pointermove', 145, 115)
    cameraPointer(canvas, 'pointercancel', 145, 115)
    const cancelled = renderer.getFreeCameraState()
    cameraPointer(canvas, 'pointermove', 190, 150)
    expect(renderer.getFreeCameraState()).toEqual(cancelled)
    fireEvent.wheel(canvas, { deltaY: -120, cancelable: true })
    fireEvent.keyDown(canvas, { key: 'Home' })
    fireEvent.keyUp(canvas, { key: 'Home' })
    expect(renderer.getFreeCameraState().targetM).toEqual(ghost.positionM)
    frame(200)
    expect(playback.isPlaying()).toBe(false)
    expect(playback.getState().currentTimeSeconds).toBe(time)
    expect(screen.getByRole('region', { name: '示範進度' }).textContent).toBe(progress)
    expect(JSON.stringify(runtime.simulation.getState())).toBe(live)
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    frame(300)
    fireEvent.click(screen.getByRole('button', { name: '定位飛機' }))
    expect(renderer.getFreeCameraState().targetM).toEqual(runtime.simulation.getState().positionM)
    expect(renderer.getFreeCameraState().targetM).not.toEqual(ghost.positionM)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(stored()).toEqual(before)
  })
})

describe('Free Flight native navigation confirmation', () => {
  it('shows gravity-gate entry errors and retains the first retry facts below the viewport', () => {
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const base = createTrainingMachineState({ initialLessonId: 'gravity-gate' })
    const { rerender } = render(<FreeFlight {...props} trainingState={base} />)
    expect(screen.getByRole('group', { name: '重力門即時狀態' })).toHaveTextContent('即時重力門數值')
    expect(screen.getByTestId('gravity-gate-status')).toHaveTextContent('頂部入 ○ → 側面出 ○')
    for (const id of ['gravity-gate-top-offset', 'gravity-gate-entry-x', 'gravity-gate-entry-z', 'gravity-gate-side-distance']) {
      expect(screen.getByTestId(id)).toHaveTextContent('—')
    }
    const observed: TrainingMachineState = { ...base, phase: 'ACTIVE', lastEvaluation: { status: 'continue', metrics: {
      gravityGatePhase: 6, gravityGateEntered: 1, gravityGateExited: 0,
      gravityGateTopHeightDifferenceM: -2.5, gravityGateEntryHorizontalErrorM: 1.2,
      gravityGateEntryForwardErrorM: -1.7, gravityGateExitDistanceM: 5.3,
    } } }
    rerender(<FreeFlight {...props} trainingState={observed} />)
    expect(screen.getByTestId('gravity-gate-phase')).toHaveTextContent('6 / 8 步')
    expect(screen.getByTestId('gravity-gate-status')).toHaveTextContent('頂部入 ✓ → 側面出 ○')
    expect(screen.getByTestId('gravity-gate-top-offset')).toHaveTextContent('-2.5 m')
    expect(screen.getByTestId('gravity-gate-entry-x')).toHaveTextContent('1.2 m')
    expect(screen.getByTestId('gravity-gate-entry-z')).toHaveTextContent('-1.7 m')
    expect(screen.getByTestId('gravity-gate-side-distance')).toHaveTextContent('5.3 m')
    const recovering = { ...observed, recoveryInProgress: true, lastRecovery: { timestampSeconds: 12,
      message: '頂入口錯過：當時右偏 8.2 m', hint: '拉開距離，重新帶速上拋。', metrics: { interruptionGravityGateEntryHorizontalErrorM: 8.2 } } }
    rerender(<FreeFlight {...props} trainingState={recovering} />)
    const hint = screen.getByLabelText('目前練習提示')
    expect(hint).toHaveTextContent('當時右偏 8.2 m')
    expect(hint).toHaveTextContent('重新帶速上拋')
    expect(hint).toHaveClass('is-below-viewport')
    const viewport = screen.getByRole('group', { name: 'Three.js Free Flight simulation viewport' })
    expect(viewport.contains(hint)).toBe(false)
    for (const id of ['flight-altitude', 'flight-position-x', 'flight-position-y', 'flight-position-z']) {
      expect(within(viewport).getByTestId(id)).toBeInTheDocument()
    }
    rerender(<FreeFlight {...props} trainingState={createTrainingMachineState({ initialLessonId: 'takeoff' })} />)
    expect(screen.queryByRole('group', { name: '重力門即時狀態' })).not.toBeInTheDocument()
    rerender(<FreeFlight {...props} trainingState={base} />)
    expect(screen.getByTestId('gravity-gate-top-offset')).toHaveTextContent('—')
    expect(screen.getByTestId('gravity-gate-status')).toHaveTextContent('頂部入 ○ → 側面出 ○')
  })

  it('plays eight measured gravity-gate steps and rewinds passage proof without updating live flight or saved results', () => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'gravity-gate' } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    const hud = () => screen.getByRole('group', { name: '重力門即時狀態' })
    const frameVisible = () => frames.renderer!.scene.getObjectByName('gravity-gate-field')?.visible
    expect(hud()).toHaveTextContent('即時')
    expect(frameVisible()).toBe(true)
    const physicalFrame = frames.runtime!.simulation.getStaticObstacles()
    expect(physicalFrame).toHaveLength(12)
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    const live = JSON.stringify(frames.runtime!.simulation.getState())
    fireEvent.click(screen.getByRole('button', { name: 'L19 重力門示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L19 重力門')
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(8)
    fireEvent.click(chapters[6])
    expect(screen.getByTestId('gravity-gate-status')).toHaveTextContent('頂部入 ✓ → 側面出 ○')
    const playback = frames.runtime!.getReplayPlayback()!
    const pausedTime = playback.getState().currentTimeSeconds
    const held = hud().textContent
    frame(400)
    expect(hud().textContent).toBe(held)
    expect(playback.getState().currentTimeSeconds).toBe(pausedTime)
    expect(JSON.stringify(frames.runtime!.simulation.getState())).toBe(live)
    expect(frames.runtime!.simulation.getStaticObstacles()).toEqual(physicalFrame)
    fireEvent.change(screen.getByRole('slider'), { target: { value: playback.durationSeconds } })
    expect(progress).toHaveTextContent('8 / 8 個示範步驟完成')
    expect(screen.getByTestId('gravity-gate-phase')).toHaveTextContent('8 / 8 步')
    expect(screen.getByTestId('gravity-gate-status')).toHaveTextContent('頂部入 ✓ → 側面出 ✓')
    expect(Number.parseFloat(screen.getByTestId('gravity-gate-side-distance').textContent!)).toBeLessThan(0)
    fireEvent.click(chapters[6])
    expect(screen.getByTestId('gravity-gate-status')).toHaveTextContent('頂部入 ✓ → 側面出 ○')
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('gravity-gate-status')).toHaveTextContent('頂部入 ○ → 側面出 ○')
    expect(progress).not.toHaveTextContent('8 / 8 個示範步驟完成')
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(screen.getByTestId('gravity-gate-top-offset')).toHaveTextContent('—')
    expect(hud()).toHaveTextContent('即時')
    expect(frameVisible()).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toEqual(physicalFrame)
    act(() => { expect(frames.runtime!.enterReplay(playback.recording)).toBe(true) })
    frame(500)
    expect(screen.queryByRole('group', { name: '重力門即時狀態' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    fireEvent.click(screen.getByRole('button', { name: /^偏航$/ }))
    expect(screen.queryByRole('group', { name: '重力門即時狀態' })).not.toBeInTheDocument()
    expect(frameVisible()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(frameVisible()).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toEqual(physicalFrame)
    expect(screen.getByLabelText('選擇課程')).toHaveValue('gravity-gate')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '自由飛行' }))
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    expect(frameVisible()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '開始學飛' }))
    expect(frames.runtime!.simulation.getStaticObstacles()).toEqual(physicalFrame)
    expect(frameVisible()).toBe(true)
  }, 15_000)

  it('shows observed upward view and crane visibility without carrying readings across lessons', () => {
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const base = createTrainingMachineState({ initialLessonId: 'reverse-orbit' })
    const { rerender } = render(<FreeFlight {...props} trainingState={base} />)
    const hud = () => screen.getByRole('group', { name: '倒刷鍋即時狀態' })
    expect(hud()).toHaveTextContent('即時倒刷鍋數值')
    expect(hud()).toHaveTextContent('仰看高處金色機臂')
    expect(screen.getByTestId('reverse-orbit-laps')).toHaveTextContent('0 / 3 圈')
    expect(screen.getByTestId('reverse-orbit-radius')).toHaveTextContent('—')
    expect(screen.getByTestId('reverse-orbit-view-elevation')).toHaveTextContent('—')
    expect(screen.getByTestId('reverse-orbit-target-error')).toHaveTextContent('—')
    const observed: TrainingMachineState = { ...base, phase: 'ACTIVE', lastEvaluation: { status: 'continue', metrics: {
      reverseOrbitPhase: 4, reverseOrbitCompletedLaps: 1, reverseOrbitProgressDegrees: 410,
      reverseOrbitRadiusM: 12.4, reverseOrbitViewElevationDegrees: 75, reverseOrbitTargetViewErrorDegrees: 21,
    } } }
    rerender(<FreeFlight {...props} trainingState={observed} />)
    expect(screen.getByTestId('reverse-orbit-laps')).toHaveTextContent('1 / 3 圈')
    expect(screen.getByTestId('reverse-orbit-progress')).toHaveTextContent('410°')
    expect(screen.getByTestId('reverse-orbit-radius')).toHaveTextContent('12.4 m')
    expect(screen.getByTestId('reverse-orbit-view-elevation')).toHaveTextContent('75°')
    expect(screen.getByTestId('reverse-orbit-target-error')).toHaveTextContent('21°')
    const viewport = screen.getByRole('group', { name: 'Three.js Free Flight simulation viewport' })
    expect(viewport.contains(screen.getByLabelText('目前練習提示'))).toBe(false)
    expect(screen.getByLabelText('目前練習提示')).toHaveClass('is-below-viewport')
    expect(within(viewport).getByRole('group', { name: '飛行位置' })).toBeInTheDocument()
    for (const id of ['flight-altitude', 'flight-position-x', 'flight-position-y', 'flight-position-z']) {
      expect(within(viewport).getByTestId(id)).toBeInTheDocument()
    }
    const recovering = { ...observed, recoveryInProgress: true, lastRecovery: { timestampSeconds: 8,
      message: '中斷時離地 1.2 m', hint: '先重新升高並仰看機臂。', metrics: { interruptionAltitudeM: 1.2 } } }
    rerender(<FreeFlight {...props} trainingState={recovering} />)
    expect(screen.getByLabelText('目前練習提示')).toHaveTextContent('中斷時離地 1.2 m')
    expect(screen.getByLabelText('目前練習提示')).toHaveTextContent('先重新升高並仰看機臂')
    expect(viewport.contains(screen.getByLabelText('目前練習提示'))).toBe(false)
    rerender(<FreeFlight {...props} trainingState={{ ...observed, lessonId: 'orbit' }} />)
    expect(viewport.contains(screen.getByLabelText('目前練習提示'))).toBe(true)
    rerender(<FreeFlight {...props} trainingState={createTrainingMachineState({ initialLessonId: 'orbit' })} />)
    expect(screen.queryByRole('group', { name: '倒刷鍋即時狀態' })).not.toBeInTheDocument()
    rerender(<FreeFlight {...props} trainingState={base} />)
    expect(screen.getByTestId('reverse-orbit-radius')).toHaveTextContent('—')
    expect(screen.getByTestId('reverse-orbit-view-elevation')).toHaveTextContent('—')
    expect(screen.getByTestId('reverse-orbit-target-error')).toHaveTextContent('—')
    expect(screen.getByTestId('reverse-orbit-laps')).toHaveTextContent('0 / 3 圈')
  })

  it('plays three physical upward-view crane orbits with independent seven-step progress and rewind', () => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'reverse-orbit' } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    const hud = () => screen.getByRole('group', { name: '倒刷鍋即時狀態' })
    expect(hud()).toHaveTextContent('即時')
    expect(frames.renderer!.scene.getObjectByName('reverse-orbit-field')?.visible).toBe(true)
    expect(frames.renderer!.scene.getObjectByName('reverse-orbit-crane')).toBeDefined()
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    const demoButtons = within(screen.getByLabelText('四軸與課程示範')).getAllByRole('button')
    expect(demoButtons).toHaveLength(21)
    expect(demoButtons.at(-3)).toHaveTextContent('L16 倒刷鍋示範')
    expect(demoButtons.at(-2)).toHaveTextContent('L17 後退飛行示範')
    expect(demoButtons.at(-1)).toHaveTextContent('L19 重力門示範')
    const initialAltitude = screen.getByTestId('flight-altitude').textContent
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L16 倒刷鍋示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L16 倒刷鍋')
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(7)
    for (const lap of [1, 2, 3]) {
      fireEvent.click(chapters[lap + 3])
      expect(progress).toHaveTextContent(`${lap + 3} / 7 個示範步驟完成`)
      expect(screen.getByTestId('reverse-orbit-laps')).toHaveTextContent(`${lap} / 3 圈`)
      expect(Number.parseFloat(screen.getByTestId('reverse-orbit-progress').textContent!)).toBeGreaterThanOrEqual(lap * 360)
      expect(Number.parseFloat(screen.getByTestId('reverse-orbit-view-elevation').textContent!)).toBeGreaterThanOrEqual(35)
      expect(Number.parseFloat(screen.getByTestId('reverse-orbit-target-error').textContent!)).toBeLessThanOrEqual(45)
    }
    const playback = frames.runtime!.getReplayPlayback()!
    expect(playback.isPlaying()).toBe(false)
    const held = hud().textContent
    const pausedTime = playback.getState().currentTimeSeconds
    const live = JSON.stringify(frames.runtime!.simulation.getState())
    frame(400)
    expect(hud().textContent).toBe(held)
    expect(playback.getState().currentTimeSeconds).toBe(pausedTime)
    expect(JSON.stringify(frames.runtime!.simulation.getState())).toBe(live)
    fireEvent.change(screen.getByRole('slider'), { target: { value: playback.durationSeconds } })
    expect(progress).toHaveTextContent('7 / 7 個示範步驟完成')
    expect(screen.getByTestId('reverse-orbit-laps')).toHaveTextContent('3 / 3 圈')
    expect(Number.parseFloat(screen.getByTestId('reverse-orbit-progress').textContent!)).toBeGreaterThanOrEqual(1080)
    expect(Number.parseFloat(screen.getByTestId('flight-altitude').textContent!)).toBeGreaterThan(1.5)
    fireEvent.click(chapters[4])
    expect(screen.getByTestId('reverse-orbit-laps')).toHaveTextContent('1 / 3 圈')
    expect(Number.parseFloat(screen.getByTestId('reverse-orbit-progress').textContent!)).toBeLessThan(720)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('reverse-orbit-laps')).toHaveTextContent('0 / 3 圈')
    expect(screen.getByTestId('reverse-orbit-progress')).toHaveTextContent('0°')
    expect(progress).not.toHaveTextContent('7 / 7 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(hud()).toHaveTextContent('即時')
    expect(screen.getByTestId('reverse-orbit-target-error')).toHaveTextContent('—')
    act(() => { expect(frames.runtime!.enterReplay(playback.recording)).toBe(true) })
    frame(500)
    expect(screen.queryByRole('group', { name: '倒刷鍋即時狀態' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    fireEvent.click(screen.getByRole('button', { name: /^偏航$/ }))
    expect(screen.queryByRole('group', { name: '倒刷鍋即時狀態' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L00')
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('reverse-orbit')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByTestId('flight-altitude').textContent).toBe(initialAltitude)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
    expect(stored()).toEqual(before)
  }, 15_000)

  it('shows signed movement relative to the nose and clears unobserved backward-flight readings when changing lessons', () => {
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const base = createTrainingMachineState({ initialLessonId: 'backward-flight' })
    const { rerender } = render(<FreeFlight {...props} trainingState={base} />)
    const hud = () => screen.getByRole('group', { name: '後退飛行即時狀態' })
    expect(hud()).toHaveTextContent('即時後退飛行數值')
    expect(hud()).toHaveTextContent('青色雙柱＝來向 · 金色三柱＝去向')
    expect(screen.getByTestId('backward-speed')).toHaveTextContent('—')
    expect(screen.getByTestId('backward-motion-direction')).toHaveTextContent('等待實際飛行資料')
    const observed: TrainingMachineState = { ...base, phase: 'ACTIVE', lastEvaluation: { status: 'continue', metrics: {
      backwardPhase: 4, backwardYawDegrees: 176, backwardSpeedMps: 2.5, backwardDistanceM: 1.7,
    } } }
    rerender(<FreeFlight {...props} trainingState={observed} />)
    expect(screen.getByTestId('backward-yaw')).toHaveTextContent('176°')
    expect(screen.getByTestId('backward-speed')).toHaveTextContent('2.5 m/s')
    expect(screen.getByTestId('backward-distance')).toHaveTextContent('1.7 m')
    expect(screen.getByTestId('backward-motion-direction')).toHaveTextContent('往機尾移動（後退）')
    rerender(<FreeFlight {...props} trainingState={{ ...observed, lastEvaluation: { status: 'continue', metrics: {
      backwardPhase: 6, backwardYawDegrees: 10, backwardSpeedMps: -2,
    } } }} />)
    expect(screen.getByTestId('backward-speed')).toHaveTextContent('-2.0 m/s')
    expect(screen.getByTestId('backward-motion-direction')).toHaveTextContent('往機頭移動（前進）')
    rerender(<FreeFlight {...props} trainingState={createTrainingMachineState({ initialLessonId: 'takeoff' })} />)
    expect(screen.queryByRole('group', { name: '後退飛行即時狀態' })).not.toBeInTheDocument()
    rerender(<FreeFlight {...props} trainingState={base} />)
    expect(screen.getByTestId('backward-speed')).toHaveTextContent('—')
    expect(screen.getByTestId('backward-yaw')).toHaveTextContent('0°')
    expect(screen.getByTestId('backward-distance')).toHaveTextContent('0.0 m')
  })

  it('plays seven measured backward-flight steps and restores their direction and distance without updating live results', () => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'backward-flight' } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    const hud = () => screen.getByRole('group', { name: '後退飛行即時狀態' })
    expect(hud()).toHaveTextContent('即時')
    expect(frames.renderer!.scene.getObjectByName('backward-field')?.visible).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    expect(within(screen.getByLabelText('四軸與課程示範')).getAllByRole('button')).toHaveLength(21)
    const initialAltitude = screen.getByTestId('flight-altitude').textContent
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L17 後退飛行示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L17 後退飛行')
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(7)
    fireEvent.click(chapters[5])
    const playback = frames.runtime!.getReplayPlayback()!
    expect(playback.isPlaying()).toBe(false)
    expect(Number.parseFloat(screen.getByTestId('backward-yaw').textContent!)).toBeGreaterThanOrEqual(120)
    expect(Number.parseFloat(screen.getByTestId('backward-speed').textContent!)).toBeGreaterThan(0.25)
    expect(screen.getByTestId('backward-motion-direction')).toHaveTextContent('往機尾移動（後退）')
    const held = hud().textContent
    const pausedTime = playback.getState().currentTimeSeconds
    const live = JSON.stringify(frames.runtime!.simulation.getState())
    frame(400)
    expect(hud().textContent).toBe(held)
    expect(playback.getState().currentTimeSeconds).toBe(pausedTime)
    expect(JSON.stringify(frames.runtime!.simulation.getState())).toBe(live)
    fireEvent.change(screen.getByRole('slider'), { target: { value: playback.durationSeconds } })
    expect(progress).toHaveTextContent('7 / 7 個示範步驟完成')
    expect(Number.parseFloat(screen.getByTestId('backward-distance').textContent!)).toBeGreaterThanOrEqual(3)
    expect(Number.parseFloat(screen.getByTestId('flight-altitude').textContent!)).toBeGreaterThan(1.5)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('backward-yaw')).toHaveTextContent('0°')
    expect(screen.getByTestId('backward-distance')).toHaveTextContent('0.0 m')
    expect(progress).not.toHaveTextContent('7 / 7 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(hud()).toHaveTextContent('即時')
    expect(screen.getByTestId('backward-speed')).toHaveTextContent('—')
    act(() => { expect(frames.runtime!.enterReplay(playback.recording)).toBe(true) })
    frame(500)
    expect(screen.queryByRole('group', { name: '後退飛行即時狀態' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    fireEvent.click(screen.getByRole('button', { name: /^偏航$/ }))
    expect(screen.queryByRole('group', { name: '後退飛行即時狀態' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L00')
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('backward-flight')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByTestId('flight-altitude').textContent).toBe(initialAltitude)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
    expect(stored()).toEqual(before)
  })

  // Recording five physical laps simulates over 100 seconds at 240 Hz.
  it('tracks five full inward-facing laps and restores their recorded counts without changing live flight or saved progress', () => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'orbit' } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    const hud = () => screen.getByRole('group', { name: '正刷鍋即時狀態' })
    expect(hud()).toHaveTextContent('即時')
    expect(screen.getByTestId('orbit-laps')).toHaveTextContent('0 / 5 圈')
    expect(screen.getByTestId('orbit-progress')).toHaveTextContent('0°')
    expect(screen.getByTestId('orbit-radius')).toHaveTextContent('—')
    expect(screen.getByTestId('orbit-heading')).toHaveTextContent('—')
    expect(within(screen.getByLabelText('四軸與課程示範')).getAllByRole('button')).toHaveLength(21)
    expect(frames.renderer!.scene.getObjectByName('orbit-field')?.visible).toBe(true)
    expect(frames.renderer!.scene.getObjectByName('orbit-reference-tower')).toBeDefined()
    expect(frames.renderer!.flightScene.getReference('orbit-poi')?.object.visible).toBe(false)
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    const initialAltitude = screen.getByTestId('flight-altitude').textContent
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L15 正刷鍋示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L15 正刷鍋')
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(9)
    fireEvent.click(chapters[4])
    const playback = frames.runtime!.getReplayPlayback()!
    expect(playback.isPlaying()).toBe(false)
    expect(screen.getByTestId('orbit-laps')).toHaveTextContent('1 / 5 圈')
    expect(Number.parseFloat(screen.getByTestId('orbit-progress').textContent!)).toBeGreaterThanOrEqual(360)
    fireEvent.click(chapters[6])
    expect(screen.getByTestId('orbit-laps')).toHaveTextContent('3 / 5 圈')
    expect(Number.parseFloat(screen.getByTestId('orbit-progress').textContent!)).toBeGreaterThanOrEqual(1080)
    expect(Number.parseFloat(screen.getByTestId('orbit-radius').textContent!)).toBeGreaterThanOrEqual(6)
    expect(Number.parseFloat(screen.getByTestId('orbit-radius').textContent!)).toBeLessThanOrEqual(30)
    expect(Number.parseFloat(screen.getByTestId('orbit-heading').textContent!)).toBeLessThanOrEqual(80)
    const pausedTime = playback.getState().currentTimeSeconds
    const held = hud().textContent
    const live = JSON.stringify(frames.runtime!.simulation.getState())
    frame(400)
    expect(hud().textContent).toBe(held)
    expect(playback.getState().currentTimeSeconds).toBe(pausedTime)
    expect(JSON.stringify(frames.runtime!.simulation.getState())).toBe(live)
    fireEvent.change(screen.getByRole('slider'), { target: { value: playback.durationSeconds } })
    expect(progress).toHaveTextContent('9 / 9 個示範步驟完成')
    expect(screen.getByTestId('orbit-laps')).toHaveTextContent('5 / 5 圈')
    expect(Number.parseFloat(screen.getByTestId('orbit-progress').textContent!)).toBeGreaterThanOrEqual(1800)
    expect(Number.parseFloat(screen.getByTestId('flight-altitude').textContent!)).toBeGreaterThanOrEqual(1.5)
    fireEvent.click(chapters[4])
    expect(screen.getByTestId('orbit-laps')).toHaveTextContent('1 / 5 圈')
    expect(Number.parseFloat(screen.getByTestId('orbit-progress').textContent!)).toBeGreaterThanOrEqual(360)
    expect(Number.parseFloat(screen.getByTestId('orbit-progress').textContent!)).toBeLessThan(720)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('orbit-laps')).toHaveTextContent('0 / 5 圈')
    expect(screen.getByTestId('orbit-progress')).toHaveTextContent('0°')
    expect(progress).not.toHaveTextContent('9 / 9 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(hud()).toHaveTextContent('即時')
    expect(screen.getByTestId('orbit-radius')).toHaveTextContent('—')
    act(() => { expect(frames.runtime!.enterReplay(playback.recording)).toBe(true) })
    frame(500)
    expect(screen.queryByRole('group', { name: '正刷鍋即時狀態' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    expect(hud()).toHaveTextContent('即時')
    fireEvent.click(screen.getByRole('button', { name: /^偏航$/ }))
    expect(screen.queryByRole('group', { name: '正刷鍋即時狀態' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L00')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('orbit')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByTestId('flight-altitude').textContent).toBe(initialAltitude)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
  }, 15_000)

  it('keeps the L14 roll-then-dive movie and its measured eight steps separate from live training', () => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'split-s' } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    const hud = () => screen.getByRole('group', { name: '破S即時狀態' })
    expect(hud()).toHaveTextContent('即時')
    for (const id of ['split-roll', 'split-pitch', 'split-descent']) expect(Number.parseFloat(screen.getByTestId(id).textContent!)).toBe(0)
    const initialAltitude = screen.getByTestId('flight-altitude').textContent
    expect(frames.renderer!.scene.getObjectByName('split-s-field')?.visible).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L14 破S示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L14 破S')
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(8)
    fireEvent.click(chapters[4])
    expect(progress).toHaveTextContent('4 / 8 個示範步驟完成')
    expect(frames.runtime!.getReplayPlayback()!.isPlaying()).toBe(false)
    expect(Number.parseFloat(screen.getByTestId('split-roll').textContent!)).toBeGreaterThanOrEqual(140)
    const held = hud().textContent
    frame(400)
    expect(hud().textContent).toBe(held)
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.durationSeconds } })
    expect(progress).toHaveTextContent('8 / 8 個示範步驟完成')
    expect(Number.parseFloat(screen.getByTestId('split-roll').textContent!)).toBeGreaterThanOrEqual(140)
    expect(Number.parseFloat(screen.getByTestId('split-pitch').textContent!)).toBeGreaterThanOrEqual(145)
    expect(Number.parseFloat(screen.getByTestId('split-descent').textContent!)).toBeGreaterThanOrEqual(3)
    expect(Number.parseFloat(screen.getByTestId('flight-altitude').textContent!)).toBeGreaterThanOrEqual(1.5)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    for (const id of ['split-roll', 'split-pitch', 'split-descent']) expect(Number.parseFloat(screen.getByTestId(id).textContent!)).toBe(0)
    expect(progress).not.toHaveTextContent('8 / 8 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(hud()).toHaveTextContent('即時')
    fireEvent.click(screen.getByRole('button', { name: /^橫滾$/ }))
    expect(screen.queryByRole('group', { name: '破S即時狀態' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L00')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('split-s')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByTestId('flight-altitude').textContent).toBe(initialAltitude)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
  })

  it('keeps the spatial L13 loop movie, eight chapters and measured dimensions separate from live progress', () => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'power-loop' } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    const hud = () => screen.getByRole('group', { name: '大迴旋即時狀態' })
    expect(hud()).toHaveTextContent('即時')
    expect(screen.getByTestId('loop-progress')).toHaveTextContent('0°')
    const initialAltitude = screen.getByTestId('flight-altitude').textContent
    expect(frames.renderer!.scene.getObjectByName('power-loop-field')?.visible).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L13 大迴旋示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L13 大迴旋')
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(8)
    fireEvent.click(chapters[5])
    expect(frames.runtime!.getReplayPlayback()!.isPlaying()).toBe(false)
    expect(Number.parseFloat(screen.getByTestId('loop-progress').textContent!)).toBeGreaterThan(140)
    expect(Number.parseFloat(screen.getByTestId('loop-height').textContent!)).toBeGreaterThanOrEqual(3)
    const held = hud().textContent
    frame(400)
    expect(hud().textContent).toBe(held)
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.durationSeconds } })
    expect(progress).toHaveTextContent('8 / 8 個示範步驟完成')
    expect(Number.parseFloat(screen.getByTestId('loop-progress').textContent!)).toBeGreaterThanOrEqual(325)
    expect(Number.parseFloat(screen.getByTestId('loop-height').textContent!)).toBeGreaterThanOrEqual(3)
    expect(Number.parseFloat(screen.getByTestId('loop-span').textContent!)).toBeGreaterThanOrEqual(6)
    expect(Number.parseFloat(screen.getByTestId('flight-altitude').textContent!)).toBeGreaterThanOrEqual(1.5)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('loop-progress')).toHaveTextContent('0°')
    expect(screen.getByTestId('loop-height')).toHaveTextContent('0.0')
    expect(screen.getByTestId('loop-span')).toHaveTextContent('0.0')
    expect(progress).not.toHaveTextContent('8 / 8 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(hud()).toHaveTextContent('即時')
    expect(screen.getByTestId('loop-progress')).toHaveTextContent('0°')
    fireEvent.click(screen.getByRole('button', { name: /^俯仰$/ }))
    expect(screen.queryByRole('group', { name: '大迴旋即時狀態' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L00')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('power-loop')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByTestId('flight-altitude').textContent).toBe(initialAltitude)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
  })

  it.each([
    { label: 'L11 前翻示範', direction: 1, lessonId: 'front-flip', title: 'L11 前翻' },
    { label: 'L12 後翻示範', direction: -1, lessonId: 'back-flip', title: 'L12 後翻' },
  ])('keeps the actual $label direction, degree HUD and playback checkpoints isolated from live training', ({ label, direction, lessonId, title }) => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: lessonId } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    expect(screen.getByRole('group', { name: '翻轉練習數值' })).toHaveTextContent('即時')
    expect(screen.getByTestId('flip-progress')).toHaveTextContent('0°')
    const initialAltitude = screen.getByTestId('flight-altitude').textContent
    expect(frames.renderer!.scene.getObjectByName('full-flip-field')?.visible).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: label }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent(title)
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(6)
    fireEvent.click(chapters[4])
    expect(frames.runtime!.getReplayPlayback()!.isPlaying()).toBe(false)
    expect(Number.parseFloat(screen.getByTestId('flip-tilt').textContent!)).toBeGreaterThan(140)
    expect(Number.parseFloat(screen.getByTestId('flip-progress').textContent!)).toBeGreaterThan(140)
    expect(Number.parseFloat(screen.getByTestId('flip-rate').textContent!) * direction).toBeGreaterThan(0)
    const held = screen.getByRole('group', { name: '翻轉練習數值' }).textContent
    frame(400)
    expect(screen.getByRole('group', { name: '翻轉練習數值' }).textContent).toBe(held)
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.durationSeconds } })
    expect(progress).toHaveTextContent('6 / 6 個示範步驟完成')
    expect(Number.parseFloat(screen.getByTestId('flip-progress').textContent!)).toBeGreaterThanOrEqual(340)
    expect(Number.parseFloat(screen.getByTestId('flip-tilt').textContent!)).toBeLessThanOrEqual(30)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('flip-progress')).toHaveTextContent('0°')
    expect(progress).not.toHaveTextContent('6 / 6 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(screen.getByTestId('flip-progress')).toHaveTextContent('0°')
    fireEvent.click(screen.getByRole('button', { name: /^俯仰$/ }))
    expect(screen.queryByRole('group', { name: '翻轉練習數值' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L00')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue(lessonId)
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByTestId('flight-altitude').textContent).toBe(initialAltitude)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
  })

  it('keeps the L10 full-roll movie, measured degree HUD and live progress separate from the L00 axis demonstration', () => {
    window.localStorage.clear()
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'full-roll' } })
    expect(screen.getByRole('group', { name: '橫滾練習數值' })).toHaveTextContent('即時')
    expect(screen.getByTestId('roll-progress')).toHaveTextContent('0°')
    expect(frames.renderer!.scene.getObjectByName('full-roll-field')?.visible).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    const liveSteps = screen.getByRole('list', { name: '本課步驟' }).textContent
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L10 橫滾示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L10 完整橫滾')
    const chapters = within(progress).getAllByRole('button')
    expect(chapters).toHaveLength(6)
    // The next chapter starts on the retained frame where actual inversion
    // was observed, rather than inferring it from a caption or timed input.
    fireEvent.click(chapters[4])
    expect(frames.runtime!.getReplayPlayback()!.isPlaying()).toBe(false)
    expect(Number.parseFloat(screen.getByTestId('roll-tilt').textContent!)).toBeGreaterThan(120)
    expect(Number.parseFloat(screen.getByTestId('roll-progress').textContent!)).toBeGreaterThan(140)
    const held = screen.getByRole('group', { name: '橫滾練習數值' }).textContent
    frame(400)
    expect(screen.getByRole('group', { name: '橫滾練習數值' }).textContent).toBe(held)
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.durationSeconds } })
    expect(progress).toHaveTextContent('6 / 6 個示範步驟完成')
    expect(Number.parseFloat(screen.getByTestId('roll-progress').textContent!)).toBeGreaterThanOrEqual(340)
    expect(Number.parseFloat(screen.getByTestId('roll-tilt').textContent!)).toBeLessThanOrEqual(25)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('roll-progress')).toHaveTextContent('0°')
    expect(progress).not.toHaveTextContent('6 / 6 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('list', { name: '本課步驟' }).textContent).toBe(liveSteps)
    expect(screen.getByTestId('roll-progress')).toHaveTextContent('0°')
    fireEvent.click(screen.getByRole('button', { name: /^橫滾$/ }))
    expect(screen.queryByRole('group', { name: '橫滾練習數值' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L00')
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('full-roll')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(stored()).toEqual(before)
    window.localStorage.clear()
  })

  it('clears failed replacement metadata before opening an ordinary live-flight replay', () => {
    const settings = createDefaultTuningSettings()
    const props = { poller: createBrowserGamepadPoller(), profile: null }
    const { rerender } = render(<FreeFlight {...props} settings={settings} />)
    fireEvent.click(screen.getByRole('button', { name: 'L01 起飛與懸停示範' }))
    expect(screen.getByRole('region', { name: '示範進度' })).toBeInTheDocument()
    const unsupported = { ...settings, controller: { ...settings.controller,
      rateLimitsDegPerSec: { ...settings.controller.rateLimitsDegPerSec, roll: 1 } } }
    rerender(<FreeFlight {...props} settings={unsupported} />)
    fireEvent.click(screen.getByRole('button', { name: '橫滾' }))
    expect(screen.getByRole('alert')).toHaveTextContent('目前設定無法建立示範')
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    expect(frames.runtime!.getTelemetry().replay.active).toBe(false)
    rerender(<FreeFlight {...props} settings={settings} />)
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    for (let index = 0; index <= 8; index += 1) frame(index * 1_000 / 60)
    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Enter replay' }))
    expect(frames.runtime!.getTelemetry().replay.active).toBe(true)
    expect(screen.getByRole('heading', { name: '飛行回放' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('目前示範步驟')).not.toBeInTheDocument()
  })

  it('advances independent teaching progress during ordinary playback and freezes it at Pause', () => {
    const onFixedStep = vi.fn()
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={createDefaultTuningSettings()} onFixedStep={onFixedStep} />)
    fireEvent.click(screen.getByRole('button', { name: '橫滾' }))
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('0 / 5 個示範步驟完成')
    frame(0)
    frame(1200)
    expect(progress).toHaveTextContent('1 / 5 個示範步驟完成')
    frame(2200)
    expect(progress).toHaveTextContent('2 / 5 個示範步驟完成')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const paused = progress.textContent
    frame(3200)
    expect(progress.textContent).toBe(paused)
    expect(onFixedStep).not.toHaveBeenCalled()
    fireEvent.click(within(progress).getByRole('button', { name: '觀看示範步驟：觀察起始姿態' }))
    expect(progress).toHaveTextContent('0 / 5 個示範步驟完成')
  })

  it('shows independent demonstration chapters through the real App sidebar and restores live progress after exit', () => {
    window.localStorage.clear()
    render(<App />)
    fireEvent.change(screen.getByLabelText('選擇課程'), { target: { value: 'basic-recovery' } })
    const liveSteps = screen.getByRole('list', { name: '本課步驟' })
    expect(within(liveSteps).getAllByRole('listitem').every((item) => !item.classList.contains('is-complete'))).toBe(true)
    const stored = () => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.')))
    const before = stored()
    fireEvent.click(screen.getByRole('button', { name: 'L09 恢復示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('L09 基礎失誤恢復')
    expect(screen.queryByRole('list', { name: '本課步驟' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '0.5×' })).toHaveAttribute('aria-pressed', 'true')
    for (const [title, current] of [['產生小幅下沉', '5 / 8'], ['建立前進或側移', '7 / 8']] as const) {
      fireEvent.click(within(progress).getByRole('button', { name: `觀看示範步驟：${title}` }))
      expect(frames.runtime!.getReplayPlayback()!.isPlaying()).toBe(false)
      expect(progress).toHaveTextContent(`正在示範第 ${current} 步：${title}`)
      expect(within(progress).getByRole('list', { name: '示範步驟' }).querySelector('[aria-current="step"]')).toHaveTextContent(title)
    }
    const duration = frames.runtime!.getReplayPlayback()!.durationSeconds
    fireEvent.change(screen.getByRole('slider'), { target: { value: duration } })
    expect(progress).toHaveTextContent('8 / 8 個示範步驟完成')
    expect(progress).toHaveTextContent('示範步驟已全部演示')
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(progress).not.toHaveTextContent('8 / 8 個示範步驟完成')
    expect(stored()).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: '本課步驟' })).getAllByRole('listitem').every((item) => !item.classList.contains('is-complete'))).toBe(true)
    expect(stored()).toEqual(before)
    // A different movie still owns its own steps while L09 remains selected.
    fireEvent.click(screen.getByRole('button', { name: 'L02 直線示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('L02')
    expect(screen.getByLabelText('選擇課程')).toHaveValue('basic-recovery')
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.durationSeconds } })
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('5 / 5 個示範步驟完成')
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('basic-recovery')
    expect(stored()).toEqual(before)
    window.localStorage.clear()
  })

  const routeLessons = [
    { lessonId: 'direction-control', code: 'L04', prefix: 'direction', total: 9,
      targets: ['direction-right', 'direction-left', 'direction-forward', 'direction-back', 'direction-yaw', 'direction-turned-forward', 'direction-turned-right'],
      button: 'L04 方向示範', group: 'direction-control-targets', completion: '已完成側移、前後移動與換向後方向感' },
    { lessonId: 'coordinated-turn', code: 'L05', prefix: 'turn', total: 8,
      targets: ['turn-right-entry', 'turn-right-apex', 'turn-right-exit', 'turn-left-entry', 'turn-left-apex', 'turn-left-exit'],
      button: 'L05 轉彎示範', group: 'coordinated-turn-targets', completion: '已完成右轉與左轉協調航線' },
    { lessonId: 'square-route', code: 'L06', prefix: 'square', total: 10,
      targets: ['square-leg-1', 'square-corner-1', 'square-leg-2', 'square-corner-2', 'square-leg-3', 'square-corner-3', 'square-leg-4', 'square-finish'],
      button: 'L06 方形示範', group: 'square-route-targets', completion: '已完成四段方形航線並回到起點上方' },
    { lessonId: 'figure-eight', code: 'L07', prefix: 'eight', total: 11,
      targets: ['eight-entry', 'eight-left-top', 'eight-left-outer', 'eight-left-bottom', 'eight-crossing', 'eight-right-top', 'eight-right-outer', 'eight-right-bottom', 'eight-finish'],
      button: 'L07 八字示範', group: 'figure-eight-targets', completion: '已完成左右八字航線並回到中央終點' },
    { lessonId: 'wide-gate', code: 'L08', prefix: 'gate', total: 5,
      targets: ['wide-gate-1', 'wide-gate-2', 'wide-gate-3'],
      button: 'L08 穿門示範', group: 'wide-gate-field', completion: '已依序穿過三道寬門且未碰撞門框' },
  ] as const

  it.each(routeLessons)('switches the active $code scene goal with actual progress while preserving the canvas', ({ lessonId, prefix, total, targets }) => {
    const base = createTrainingMachineState({ initialLessonId: lessonId })
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const { rerender, container } = render(<FreeFlight {...props} trainingState={base} />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    const visible = () => targets.filter((id) => lessonId === 'wide-gate'
      ? frames.renderer!.flightScene.scene.getObjectByName(`${id}-guidance`)!.visible
      : frames.renderer!.flightScene.getReference(id)!.object.visible)
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
    const goal = (id: string) => lessonId === 'wide-gate' ? scene.scene.getObjectByName(`${id}-guidance`)! : scene.getReference(id)!.object
    expect(goal(targets[0]).visible).toBe(true)
    fireEvent.change(screen.getByRole('slider'), { target: { value: frames.runtime!.getReplayPlayback()!.getState().durationSeconds } })
    expect(goal(targets.at(-1)!).visible).toBe(true)
    expect(goal(targets[0]).visible).toBe(false)
    expect(screen.getByText(new RegExp(completion))).toBeInTheDocument()
    if (lessonId === 'direction-control') expect(parseFloat(screen.getByTestId('flight-position-z').textContent!)).toBeGreaterThan(3)
    else if (lessonId === 'coordinated-turn') {
      expect(parseFloat(screen.getByTestId('flight-position-right').textContent!)).toBeGreaterThan(14)
      expect(parseFloat(screen.getByTestId('flight-position-z').textContent!)).toBeLessThan(-16)
    } else if (lessonId === 'square-route') {
      expect(Math.abs(parseFloat(screen.getByTestId('flight-position-right').textContent!))).toBeLessThan(0.6)
      expect(Math.abs(parseFloat(screen.getByTestId('flight-position-z').textContent!))).toBeLessThan(0.6)
    } else if (lessonId === 'wide-gate') {
      expect(Math.abs(parseFloat(screen.getByTestId('flight-position-right').textContent!))).toBeLessThan(0.6)
      expect(parseFloat(screen.getByTestId('flight-position-z').textContent!)).toBeLessThan(-24)
    } else {
      expect(Math.abs(parseFloat(screen.getByTestId('flight-position-right').textContent!))).toBeLessThan(0.6)
      expect(Math.abs(parseFloat(screen.getByTestId('flight-position-z').textContent!) + 6)).toBeLessThan(0.6)
    }
    frame(200)
    frame(400)
    expect(onFixedStep).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(goal(targets[0]).visible).toBe(true)
    expect(goal(targets.at(-1)!).visible).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('button', { name: /^Disarm$/ })).toBeDisabled()
    expect(scene.scene.getObjectByName(group)!.visible).toBe(false)
  })

  it.each([
    { lessonId: 'wide-gate', code: 'L08', fieldName: 'wide-gate-field', demoLabel: 'L08 穿門示範' },
    { lessonId: 'gravity-gate', code: 'L19', fieldName: 'gravity-gate-field', demoLabel: 'L19 重力門示範' },
  ])('keeps visible $code frames aligned with live colliders through Reset, Arm, replay and course changes', ({ lessonId, fieldName, demoLabel }) => {
    const settings = createDefaultTuningSettings()
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings }
    const selected = createTrainingMachineState({ initialLessonId: lessonId })
    const { rerender } = render(<FreeFlight {...props} trainingState={selected} />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    const colliders = () => frames.runtime!.simulation.getStaticObstacles()
    const field = () => frames.renderer!.flightScene.scene.getObjectByName(fieldName)!
    expect(colliders()).toHaveLength(12)
    expect(field().visible).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Reset$/ }))
    expect(colliders()).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    expect(frames.runtime!.getTelemetry().armed).toBe(true)
    expect(colliders()).toHaveLength(12)
    // Next-lesson navigation can update selection and request disarm together.
    rerender(<FreeFlight {...props} trainingDisarmKey={1} trainingState={createTrainingMachineState({ initialLessonId: 'figure-eight' })} />)
    expect(frames.runtime!.getTelemetry().armed).toBe(false)
    expect(colliders()).toHaveLength(0)
    expect(field().visible).toBe(false)
    rerender(<FreeFlight {...props} trainingDisarmKey={1} trainingState={selected} />)
    expect(colliders()).toHaveLength(12)
    const before = frames.runtime!.getTelemetry().state
    const savedEnvironment = colliders()
    fireEvent.click(screen.getByRole('button', { name: demoLabel }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.change(screen.getByRole('slider'), { target: { value: 20 } })
    expect(colliders()).toEqual(savedEnvironment)
    expect(frames.runtime!.getTelemetry().state.positionM).toEqual(before.positionM)
    expect(selected.checkpoints).toEqual({})
    expect(selected.result).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(colliders()).toHaveLength(12)
    expect(field().visible).toBe(true)
    rerender(<FreeFlight {...props} trainingState={createTrainingMachineState({ initialLessonId: 'figure-eight' })} />)
    expect(colliders()).toHaveLength(0)
    expect(field().visible).toBe(false)
    rerender(<FreeFlight {...props} trainingState={selected} />)
    expect(colliders()).toHaveLength(12)
    rerender(<FreeFlight {...props} trainingState={null} />)
    expect(colliders()).toHaveLength(0)
    expect(field().visible).toBe(false)
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
  })

  it.each([
    { lessonId: 'wide-gate', code: 'L08', cause: /碰到第 1 道門的左柱/ },
    { lessonId: 'gravity-gate', code: 'L19', cause: /重力門.*立柱/ },
  ])('shows the actual $code frame part after a real solver collision and requires Reset', ({ lessonId, cause }) => {
    const settings = createDefaultTuningSettings()
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={settings}
      trainingState={createTrainingMachineState({ initialLessonId: lessonId })} />)
    const post = frames.runtime!.simulation.getStaticObstacles()[0]
    act(() => {
      frames.runtime!.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [],
        spawnPositionM: { ...post.centerM }, spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
        staticObstacles: frames.runtime!.simulation.getStaticObstacles() })
    })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    frame(0)
    frame(120)
    expect(frames.runtime!.getTelemetry().state.crashed).toBe(true)
    expect(screen.getByText(cause)).toHaveTextContent('請按 Reset 重設後重試')
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeDisabled()
    expect(screen.getByTestId('flight-altitude')).not.toHaveTextContent('—')
    fireEvent.click(screen.getByRole('button', { name: 'Reset crashed drone' }))
    expect(frames.runtime!.getTelemetry().state.crashed).toBe(false)
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeEnabled()
  })

  it('shows L09 stages and actual live motion while clearing the preceding gate field on the same canvas', () => {
    const props = { poller: createBrowserGamepadPoller(), profile: null, settings: createDefaultTuningSettings() }
    const { rerender } = render(<FreeFlight {...props} trainingState={createTrainingMachineState({ initialLessonId: 'wide-gate' })} />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(12)
    const base = createTrainingMachineState({ initialLessonId: 'basic-recovery' })
    // This phase fixture exercises UI binding, not recovery mastery. The motion
    // instruments must read the real live state rather than these stale metrics.
    const active: TrainingMachineState = { ...base, phase: 'ACTIVE', lastEvaluation: { status: 'continue', metrics: {
      recoveryPhase: 3, currentEpisodeValid: 1, tiltDegrees: 99, verticalSpeedMps: 99, horizontalSpeedMps: 99,
    } } }
    rerender(<FreeFlight {...props} trainingState={active} />)
    const scene = frames.renderer!.flightScene
    const level = scene.scene.getObjectByName('recovery-level-reference') as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
    expect(scene.scene.getObjectByName('wide-gate-field')!.visible).toBe(false)
    expect(scene.scene.getObjectByName('basic-recovery-field')!.visible).toBe(true)
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
    expect(level.material.color.getHex()).toBe(0xffc978)
    expect(screen.getByTestId('recovery-tilt')).toHaveTextContent('0.0°')
    expect(screen.getByTestId('recovery-vertical-speed')).toHaveTextContent('0.0 m/s')
    expect(screen.getByTestId('recovery-horizontal-speed')).toHaveTextContent('0.0 m/s')
    expect(screen.getByLabelText('恢復練習數值')).toHaveTextContent('即時')
    rerender(<FreeFlight {...props} trainingState={{ ...active, lastEvaluation: { status: 'success', metrics: { recoveryPhase: 8 } } }} />)
    expect(level.material.color.getHex()).toBe(0xb8f36b)
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    rerender(<FreeFlight {...props} trainingState={null} />)
    expect(scene.scene.getObjectByName('basic-recovery-field')!.visible).toBe(false)
    expect(screen.queryByLabelText('恢復練習數值')).not.toBeInTheDocument()
    expect(frames.runtime!.simulation.getStaticObstacles()).toHaveLength(0)
  })

  it('seeks L09 motion instruments and stage guidance with real recorded physics without scoring live training', () => {
    const onFixedStep = vi.fn()
    const selected = createTrainingMachineState({ initialLessonId: 'basic-recovery' })
    render(<FreeFlight poller={createBrowserGamepadPoller()} profile={null} settings={createDefaultTuningSettings()}
      trainingState={selected} onFixedStep={onFixedStep} />)
    const liveBefore = frames.runtime!.getTelemetry().state
    const storedBefore = { ...window.localStorage }
    fireEvent.click(screen.getByRole('button', { name: 'L09 恢復示範' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const playback = frames.runtime!.getReplayPlayback()!
    const onset = playback.recording.samples.find((sample) => measureBasicRecoveryMotion(sample).tiltDegrees >= 15)!
    expect(onset).toBeDefined()
    fireEvent.change(screen.getByRole('slider'), { target: { value: onset.timestampSeconds } })
    const ghost = playback.getGhostState()!
    const motion = measureBasicRecoveryMotion(ghost)
    expect(screen.getByTestId('recovery-tilt')).toHaveTextContent(`${motion.tiltDegrees.toFixed(1)}°`)
    expect(screen.getByTestId('recovery-vertical-speed')).toHaveTextContent(`${motion.verticalSpeedMps.toFixed(1)} m/s`)
    expect(screen.getByTestId('recovery-horizontal-speed')).toHaveTextContent(`${motion.horizontalSpeedMps.toFixed(1)} m/s`)
    expect(screen.getByLabelText('恢復練習數值')).toHaveTextContent('回放')
    expect(screen.getByLabelText('目前示範步驟')).toHaveTextContent('主動修回水平')
    const level = frames.renderer!.flightScene.scene.getObjectByName('recovery-level-reference') as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
    expect(level.material.color.getHex()).toBe(0xffc978)
    const paused = screen.getByLabelText('恢復練習數值').textContent
    frame(200)
    frame(400)
    expect(screen.getByLabelText('恢復練習數值').textContent).toBe(paused)
    expect(onFixedStep).not.toHaveBeenCalled()
    expect(frames.runtime!.getTelemetry().state.positionM).toEqual(liveBefore.positionM)
    fireEvent.change(screen.getByRole('slider'), { target: { value: playback.durationSeconds } })
    expect(screen.getByText(/已完成傾斜、下沉與漂移恢復/)).toBeInTheDocument()
    expect(level.material.color.getHex()).toBe(0xb8f36b)
    fireEvent.change(screen.getByRole('slider'), { target: { value: 0 } })
    expect(screen.getByTestId('recovery-tilt')).toHaveTextContent('0.0°')
    expect(screen.getByTestId('recovery-vertical-speed')).toHaveTextContent('0.0 m/s')
    expect(level.material.color.getHex()).toBe(0x45d7f7)
    fireEvent.click(screen.getByRole('button', { name: '結束示範' }))
    expect(screen.getByRole('button', { name: /^Disarm$/ })).toBeDisabled()
    expect(screen.getByLabelText('恢復練習數值')).toHaveTextContent('即時')
    expect(selected.checkpoints).toEqual({})
    expect(selected.result).toBeNull()
    expect({ ...window.localStorage }).toEqual(storedBefore)
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
    fireEvent.click(screen.getByRole('button', { name: '橫滾' }))
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
    fireEvent.click(screen.getByRole('button', { name: '偏航' }))
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
    fireEvent.click(screen.getByRole('button', { name: '橫滾' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'L02 直線示範' }))
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
