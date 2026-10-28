import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG, droneGroundSupport } from '../drone'
import type { FlightRuntimeFixedStepSample, FlightRuntimeTelemetry } from '../runtime'
import { createTeachingDemonstration } from '../training/demonstrations'
import { createTuningPreset } from '../tuning'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'

import type { TrainingSample } from '../training/types'
import App from './App'

type RuntimeOptions = {
  readonly onTelemetry?: (telemetry: FlightRuntimeTelemetry) => void
  readonly onFixedStep?: (sample: FlightRuntimeFixedStepSample) => void
}

type RuntimeHarness = {
  readonly reconfigureCalls: number
  readonly fixedStepCalls: number
  arm(): boolean
  reset(): void
  emitSample(sample: TrainingSample): void
  enterReplay(): boolean
  playReplay(): boolean
}

const runtimeHarness = vi.hoisted(() => ({ instances: [] as RuntimeHarness[] }))

vi.mock('../rendering', () => {
  const sceneReferences = [
    { id: 'takeoff-pad', kind: 'pad', positionM: { x: 0, y: 0.5, z: 0 }, sizeM: { x: 2.4, y: 0.08, z: 2.4 } },
    { id: 'hover-zone', kind: 'zone', positionM: { x: 0, y: 3, z: 0 }, sizeM: { x: 2.4, y: 0.04, z: 2.4 } },
    { id: 'turn-entry', kind: 'marker', positionM: { x: -4, y: 0.45, z: -4 }, sizeM: { x: 0.36, y: 0.9, z: 0.36 } },
    { id: 'turn-apex', kind: 'marker', positionM: { x: 4, y: 0.45, z: -4 }, sizeM: { x: 0.36, y: 0.9, z: 0.36 } },
    { id: 'turn-exit', kind: 'marker', positionM: { x: -4, y: 0.45, z: 4 }, sizeM: { x: 0.36, y: 0.9, z: 0.36 } },
    { id: 'split-s-reference', kind: 'gate', positionM: { x: 0, y: 0.9, z: -5 }, sizeM: { x: 5.12, y: 1.8, z: 0.12 } },
    { id: 'orbit-poi', kind: 'poi', positionM: { x: 4, y: 2.5, z: 4 }, sizeM: { x: 0.36, y: 4, z: 0.36 } },
    { id: 'training-launch', kind: 'pad', positionM: { x: 0, y: 0.046, z: 0 } },
    { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: 0, z: -8 }, sizeM: { x: 3, y: 0, z: 3 } },
  ]

  class MockFlightRenderer {
    public readonly flightScene = { sceneReferences }

    public constructor() {}

    public resize(): void {}

    public setCameraMode(): void {}

    public setCameraOptions(): void {}

    public setTrainingPath(): void {}

    public dispose(): void {}
  }

  return { FlightRenderer: MockFlightRenderer }
})

vi.mock('../runtime', () => {
  const makeState = (): FlightRuntimeTelemetry['state'] => ({
    positionM: { x: 0, y: 0.5, z: 0 },
    velocityMps: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocityBodyRadPerSec: { x: 0, y: 0, z: 0 },
    motors: [],
    warnings: [],
    stepIndex: 0,
    timeSeconds: 0,
  } as unknown as FlightRuntimeTelemetry['state'])

  const makeTelemetry = (
    state: ReturnType<typeof makeState>,
    armed = false,
    replayActive = false,
    replayPlaying = false,
    replayAvailable = false,
  ): FlightRuntimeTelemetry => ({
    ...state,
    state,
    armed,
    targetPilotRateRadPerSec: { roll: 0, pitch: 0, yaw: 0 },
    targetBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
    measuredBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
    errorBodyRateRadPerSec: { x: 0, y: 0, z: 0 },
    pidIntegral: { roll: 0, pitch: 0, yaw: 0 },
    pidOutputTorqueBodyNm: { x: 0, y: 0, z: 0 },
    pilotCorrections: { roll: 0, pitch: 0, yaw: 0 },
    mixer: {} as FlightRuntimeTelemetry['mixer'],
    mixerSaturated: false,
    motors: [],
    warnings: [],
    source: 'keyboard',
    rawInput: null,
    processedInput: null,
    normalizedInput: null,
    metrics: {
      fps: 60,
      simHz: 240,
      droppedSteps: 0,
      droppedSeconds: 0,
      lastDroppedSteps: 0,
      lastDroppedSeconds: 0,
    },
    cameraMode: 'fpv',
    safetyReasons: [],
    replay: {
      active: replayActive,
      playing: replayPlaying,
      available: replayAvailable,
      sampleCount: replayAvailable ? 1 : 0,
      currentTimeSeconds: 0,
      durationSeconds: replayAvailable ? 1 : 0,
      speed: 1,
      label: replayActive ? 'PLAYBACK' : 'LIVE',
    },
  } as unknown as FlightRuntimeTelemetry)

  class MockFlightRuntime {
    private readonly options: RuntimeOptions
    private telemetry = makeTelemetry(makeState())
    private reconfigureCount = 0
    private fixedStepCount = 0

    public constructor(options: RuntimeOptions) {
      this.options = options
      runtimeHarness.instances.push(this)
    }

    public get reconfigureCalls(): number {
      return this.reconfigureCount
    }

    public get fixedStepCalls(): number {
      return this.fixedStepCount
    }

    public getTelemetry(): FlightRuntimeTelemetry {
      return this.telemetry
    }

    public start(): void {
      this.options.onTelemetry?.(this.telemetry)
    }

    public dispose(): void {}

    public setInputSource(): void {}

    public setCameraMode(): void {}

    public setTuningLocked(): void {}

    public setControllerProfile(): void {}

    public resetForTraining(): ReturnType<typeof makeState> {
      this.telemetry = makeTelemetry(makeState(), false, false, false, this.telemetry.replay.available)
      this.options.onTelemetry?.(this.telemetry)
      return this.telemetry.state
    }

    public reset(): void {
      this.telemetry = makeTelemetry(makeState(), false, false, false, this.telemetry.replay.available)
      this.options.onTelemetry?.(this.telemetry)
    }

    public disarm(): void {
      this.telemetry = makeTelemetry(this.telemetry.state, false, false, false, this.telemetry.replay.available)
      this.options.onTelemetry?.(this.telemetry)
    }

    public reconfigure(): boolean {
      this.reconfigureCount += 1
      this.telemetry = makeTelemetry(makeState(), false, false, false, this.telemetry.replay.available)
      this.options.onTelemetry?.(this.telemetry)
      return true
    }

    public arm(): boolean {
      this.telemetry = makeTelemetry(this.telemetry.state, true, false, false, this.telemetry.replay.available)
      this.options.onTelemetry?.(this.telemetry)
      return true
    }

    public enterReplay(): boolean {
      this.telemetry = makeTelemetry(this.telemetry.state, false, true, false, true)
      this.options.onTelemetry?.(this.telemetry)
      return true
    }

    public playReplay(): boolean {
      this.telemetry = makeTelemetry(this.telemetry.state, false, true, true, true)
      this.options.onTelemetry?.(this.telemetry)
      return true
    }

    public pauseReplay(): boolean {
      this.telemetry = makeTelemetry(this.telemetry.state, false, true, false, true)
      this.options.onTelemetry?.(this.telemetry)
      return true
    }

    public exitReplay(): boolean {
      this.telemetry = makeTelemetry(this.telemetry.state, false, false, false, true)
      this.options.onTelemetry?.(this.telemetry)
      return true
    }

    public seekReplay(): boolean {
      return true
    }

    public setReplaySpeed(): boolean {
      return true
    }

    public emitSample(sample: TrainingSample): void {
      this.fixedStepCount += 1
      const state = { ...sample.state, timeSeconds: sample.timestampSeconds }
      this.telemetry = makeTelemetry(state, sample.armed === true, false, false, true)
      this.options.onFixedStep?.(sample as unknown as FlightRuntimeFixedStepSample)
      if (sample.armed === true) this.options.onTelemetry?.(this.telemetry)
    }
  }

  return { FlightRuntime: MockFlightRuntime }
})

function trainingSection(): HTMLElement {
  const section = screen.getByRole('heading', { level: 2, name: /今天練習哪個動作/ }).closest('section')
  if (!section) throw new Error('Training section was not rendered')
  return section
}

function persistedAttempts(lessonId: string): number {
  let attempts = 0
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (!key?.startsWith('fpv-drone-trainer.training-progress.context.v1.')) continue
    const saved = JSON.parse(window.localStorage.getItem(key) ?? '{}') as { progress?: { lessons?: Record<string, { attempts?: number }> } }
    attempts += saved.progress?.lessons?.[lessonId]?.attempts ?? 0
  }
  return attempts
}

function emitCountdown(runtime: RuntimeHarness): void {
  runtime.emitSample({ timestampSeconds: 3, state: createInitialDroneState(DEFAULT_DRONE_CONFIG), normalizedInput: { roll: 0, pitch: 0, yaw: 0, throttle: 0 }, armed: false })
}

const takeoffSettings = createTuningPreset('beginner')
const takeoffRecording = createTeachingDemonstration(takeoffSettings, 'takeoff').recording

/** Actual physics-recorded ground start, liftoff and sustained hover; only the UI runtime is mocked. */
function emitTakeoffSuccess(runtime: RuntimeHarness): void {
  const initial = createInitialDroneState(takeoffSettings.drone)
  for (const pose of takeoffRecording.samples) {
    const timestampSeconds = pose.timestampSeconds + 3
    const supportOffsetM = droneGroundSupport(takeoffSettings.drone, pose.orientation).supportOffsetM
    runtime.emitSample({
      timestampSeconds, armed: true, normalizedInput: pose.normalizedInput,
      state: { ...initial, positionM: pose.positionM, velocityMps: pose.velocityMps,
        orientation: pose.orientation, angularVelocityBodyRadPerSec: pose.angularVelocityBodyRadPerSec,
        timeSeconds: timestampSeconds, stepIndex: Math.round(pose.timestampSeconds * 240) },
      groundContact: { heightM: takeoffSettings.drone.ground.heightM, supportOffsetM,
        touching: pose.positionM.y - supportOffsetM <= takeoffSettings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 },
    })
  }
}

function emitCoordinatedTurnFailure(runtime: RuntimeHarness): void {
  const state = createInitialDroneState(DEFAULT_DRONE_CONFIG)
  const input = { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 }
  runtime.emitSample({
    timestampSeconds: 3.1,
    state: { ...state, stepIndex: 1, timeSeconds: 3.1 },
    normalizedInput: input,
    armed: true,
  })
  runtime.emitSample({
    timestampSeconds: 3.2,
    state: { ...state, stepIndex: 2, timeSeconds: 3.2 },
    normalizedInput: input,
    armed: true,
  })
  runtime.emitSample({
    timestampSeconds: 3.3,
    state: { ...state, stepIndex: 3, timeSeconds: 3.3 },
    normalizedInput: input,
    armed: false,
  })
}

describe('integrated training/runtime UI boundaries', () => {
  beforeEach(() => {
    window.localStorage.clear()
    runtimeHarness.instances.length = 0
  })

  it.each([
    { lessonId: 'direction-control', code: 'L04', steps: 9, nextCode: 'L05' },
    { lessonId: 'coordinated-turn', code: 'L05', steps: 8, nextCode: 'L06' },
    { lessonId: 'square-route', code: 'L06', steps: 10, nextCode: 'L07' },
    { lessonId: 'figure-eight', code: 'L07', steps: 11, nextCode: 'L08' },
    { lessonId: 'wide-gate', code: 'L08', steps: 5, nextCode: 'L09' },
    { lessonId: 'basic-recovery', code: 'L09', steps: 8, nextCode: 'L10' },
    { lessonId: 'full-roll', code: 'L10', steps: 6, nextCode: 'L11' },
    { lessonId: 'front-flip', code: 'L11', steps: 6, nextCode: 'L12' },
    { lessonId: 'back-flip', code: 'L12', steps: 6, nextCode: 'L13' },
    { lessonId: 'power-loop', code: 'L13', steps: 8, nextCode: 'L14' },
    { lessonId: 'split-s', code: 'L14', steps: 8, nextCode: 'L15' },
    { lessonId: 'backward-flight', code: 'L17', steps: 7, nextCode: null },
  ] as const)('records an ordered $code result once and restores its current-rule progress after reload', ({ lessonId, steps, nextCode }) => {
    const { unmount } = render(<App />)
    const training = trainingSection()
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: lessonId } })
    fireEvent.change(screen.getByLabelText('控制方式'), { target: { value: 'keyboard' } })
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    const runtime = runtimeHarness.instances[0]!
    act(() => emitCountdown(runtime))
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    // Feed a physics-generated recording through the real App/session/store
    // boundary. The runtime/renderer are mocked here; this is UI evidence.
    const settings = createTuningPreset('beginner')
    const demo = createTeachingDemonstration(settings, lessonId)
    const initial = createInitialDroneState(settings.drone)
    act(() => {
      for (const pose of demo.recording.samples) {
        const timestampSeconds = pose.timestampSeconds + 3
        const supportOffsetM = droneGroundSupport(settings.drone, pose.orientation).supportOffsetM
        runtime.emitSample({
          timestampSeconds, armed: true, normalizedInput: pose.normalizedInput,
          state: { ...initial, positionM: pose.positionM, velocityMps: pose.velocityMps,
            orientation: pose.orientation, angularVelocityBodyRadPerSec: pose.angularVelocityBodyRadPerSec,
            timeSeconds: timestampSeconds, stepIndex: Math.round(pose.timestampSeconds * 240) },
          groundContact: { heightM: settings.drone.ground.heightM, supportOffsetM,
            touching: pose.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 },
        })
      }
    })
    expect(within(training).getByText('引導目標完成！')).toBeInTheDocument()
    expect(within(training).getByText(`${steps} / ${steps} 個步驟完成`)).toBeInTheDocument()
    expect(persistedAttempts(lessonId)).toBe(1)
    expect(persistedAttempts('landing')).toBe(0)
    if (lessonId === 'power-loop' || lessonId === 'split-s') {
      expect(persistedAttempts('front-flip')).toBe(0)
      expect(persistedAttempts('back-flip')).toBe(0)
      if (lessonId === 'split-s') expect(persistedAttempts('power-loop')).toBe(0)
    }
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    if (nextCode) expect(within(training).getByRole('button', { name: new RegExp(`^下一課：${nextCode}`) })).toBeEnabled()
    else expect(within(training).queryByRole('button', { name: /^下一課：/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    unmount()
    render(<App />)
    expect(within(trainingSection()).getByLabelText('選擇課程')).toHaveValue(lessonId)
    expect(within(trainingSection()).getByText(/本次條件已練 1 次/)).toBeInTheDocument()
    expect(persistedAttempts(lessonId)).toBe(1)
  })

  it('clears a pending lesson when keyboard/runtime reset rewinds its clock', () => {
    render(<App />)
    const training = trainingSection()
    fireEvent.change(screen.getByLabelText('學習方式'), { target: { value: 'challenge' } })
    const runtime = runtimeHarness.instances[0]
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    act(() => emitCountdown(runtime))
    expect(within(training).getByText('等待解鎖')).toBeInTheDocument()
    act(() => runtime.reset())
    expect(within(training).getByText('準備選課')).toBeInTheDocument()
    expect(within(training).queryByText('這次練習已結束')).not.toBeInTheDocument()
    expect(screen.getByLabelText('控制方式')).toBeEnabled()
    expect(persistedAttempts('takeoff')).toBe(0)
  })

  it('keeps an unsaved result visible and explains storage failures', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    try {
      render(<App />)
      const training = trainingSection()
      fireEvent.change(screen.getByLabelText('學習方式'), { target: { value: 'challenge' } })
      const runtime = runtimeHarness.instances[0]
      fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: 'takeoff' } })
      fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
      act(() => emitCountdown(runtime))
      fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
      act(() => emitTakeoffSuccess(runtime))
      expect(within(training).getByText('本課完成！')).toBeInTheDocument()
      expect(within(training).getByText(/結果仍在本次頁面，但未成功保存/)).toBeInTheDocument()
      expect(persistedAttempts('takeoff')).toBe(0)
    } finally { write.mockRestore() }
  })

  it('keeps result and best-score provenance together after switching settings', () => {
    render(<App />)
    const training = trainingSection()
    fireEvent.change(screen.getByLabelText('學習方式'), { target: { value: 'challenge' } })
    const runtime = runtimeHarness.instances[0]
    fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: 'takeoff' } })
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    act(() => emitCountdown(runtime))
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    act(() => emitTakeoffSuccess(runtime))
    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    fireEvent.change(screen.getByLabelText('操控設定'), { target: { value: 'standard' } })
    expect(within(training).getByText(/本次條件：能力挑戰.*新手設定/)).toBeInTheDocument()
    expect(within(training).getByText(/本次條件已練 1 次/)).toBeInTheDocument()
    fireEvent.click(within(training).getByRole('button', { name: '再練一次' }))
    expect(within(training).getByText(/本次條件已練 0 次/)).toBeInTheDocument()
  })

  it('keeps guided practice completion separate from challenge progress', () => {
    render(<App />)
    const training = trainingSection()
    const runtime = runtimeHarness.instances[0]
    expect(screen.getByLabelText('學習方式')).toHaveValue('practice')
    fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: 'takeoff' } })
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    act(() => emitCountdown(runtime))
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    act(() => emitTakeoffSuccess(runtime))
    expect(within(training).getByText('引導目標完成！')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Disarm$/ }))
    fireEvent.change(screen.getByLabelText('學習方式'), { target: { value: 'challenge' } })
    expect(within(training).getByText(/本次條件：引導練習/)).toBeInTheDocument()
    fireEvent.click(within(training).getByRole('button', { name: '再練一次' }))
    expect(within(training).getByText(/本次條件已練 0 次/)).toBeInTheDocument()
  })

  it('recommends the next foundational lesson after success without remounting flight or granting it completion', () => {
    render(<App />)
    const training = trainingSection()
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    const runtime = runtimeHarness.instances[0]
    fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: 'takeoff' } })
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    act(() => emitCountdown(runtime))
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    act(() => emitTakeoffSuccess(runtime))
    fireEvent.click(within(training).getByRole('button', { name: /^下一課：L02/ }))
    expect(within(training).getByLabelText('選擇課程')).toHaveValue('straight-line')
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    expect(screen.getByRole('button', { name: /^Disarm$/ })).toBeDisabled()
    expect(persistedAttempts('straight-line')).toBe(0)
    expect(persistedAttempts('hover')).toBe(0)
    expect(persistedAttempts('takeoff')).toBe(1)
  })

  it('keeps result persistence, lesson isolation, retry/reset, replay, and tuning boundaries together', async () => {
    render(<App />)
    const training = trainingSection()
    fireEvent.change(screen.getByLabelText('學習方式'), { target: { value: 'challenge' } })
    fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: 'takeoff' } })
    fireEvent.click(screen.getByText('進階調參與舊版紀錄'))
    const runtime = runtimeHarness.instances[0]
    if (!runtime) throw new Error('Mock runtime was not created')

    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    expect(screen.getByRole('button', { name: /apply \+ reset/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeDisabled()
    act(() => emitCountdown(runtime))
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    act(() => emitTakeoffSuccess(runtime))
    expect(runtime.fixedStepCalls).toBe(1 + takeoffRecording.samples.length)

    await waitFor(() => expect(within(training).getByText('本課完成！')).toBeInTheDocument())
    expect(within(training).getByText('練習結果')).toBeInTheDocument()
    expect(persistedAttempts('takeoff')).toBe(1)
    act(() => emitTakeoffSuccess(runtime))
    expect(persistedAttempts('takeoff')).toBe(1)

    fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: 'coordinated-turn' } })
    expect(within(training).getByRole('heading', { level: 3, name: '協調轉彎' })).toBeInTheDocument()
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    expect(screen.getByRole('button', { name: /apply \+ reset/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeDisabled()
    act(() => emitCountdown(runtime))
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    act(() => emitCoordinatedTurnFailure(runtime))

    await waitFor(() => expect(within(training).getByText('這次練習已結束')).toBeInTheDocument())
    expect(within(training).getByText('練習結果')).toBeInTheDocument()
    expect(persistedAttempts('coordinated-turn')).toBe(1)

    fireEvent.click(within(training).getByRole('button', { name: '再練一次' }))
    expect(within(training).queryByText('這次練習已結束')).not.toBeInTheDocument()
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    fireEvent.click(within(training).getByRole('button', { name: '停止練習' }))
    expect(within(training).getByText('準備選課')).toBeInTheDocument()
    expect(persistedAttempts('coordinated-turn')).toBe(1)

    fireEvent.change(within(training).getByLabelText('選擇課程'), { target: { value: 'split-s' } })
    expect(within(training).getByRole('heading', { level: 3, name: '破S' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /enter replay/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /enter replay/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Play$/ }))
    expect(screen.getByText('PLAYBACK / playing ghost')).toBeInTheDocument()
    expect(persistedAttempts('coordinated-turn')).toBe(1)

    const apply = screen.getByRole('button', { name: /apply \+ reset/i })
    expect(apply).toBeDisabled()
    expect(runtime.reconfigureCalls).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '結束回放' }))
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    await waitFor(() => expect(runtime.reconfigureCalls).toBeGreaterThan(0))
  })
})
