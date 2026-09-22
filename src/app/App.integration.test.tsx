import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import type { FlightRuntimeFixedStepSample, FlightRuntimeTelemetry } from '../runtime'
import { createHoverSuccessFixture } from '../training'
import { TRAINING_PROGRESS_STORAGE_KEY } from '../training/progress'
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
  const section = screen.getByRole('heading', { level: 2, name: /train the state/i }).closest('section')
  if (!section) throw new Error('Training section was not rendered')
  return section
}

function persistedAttempts(lessonId: string): number {
  const raw = window.localStorage.getItem(TRAINING_PROGRESS_STORAGE_KEY)
  if (!raw) return 0
  const document = JSON.parse(raw) as { lessons?: Record<string, { attempts?: number }> }
  return document.lessons?.[lessonId]?.attempts ?? 0
}

function emitHoverSuccess(runtime: RuntimeHarness): void {
  for (const [index, sample] of createHoverSuccessFixture().entries()) {
    runtime.emitSample({
      ...sample,
      timestampSeconds: sample.timestampSeconds + 3,
    })
    if (index === 0) expect(sample.armed).toBe(true)
  }
}

function emitCoordinatedTurnFailure(runtime: RuntimeHarness): void {
  const state = createInitialDroneState(DEFAULT_DRONE_CONFIG)
  const input = { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 }
  runtime.emitSample({
    timestampSeconds: 3.1,
    state: { ...state, stepIndex: 1 },
    normalizedInput: input,
    armed: true,
  })
  runtime.emitSample({
    timestampSeconds: 3.2,
    state: { ...state, stepIndex: 2 },
    normalizedInput: input,
    armed: true,
  })
  runtime.emitSample({
    timestampSeconds: 3.3,
    state: { ...state, stepIndex: 3 },
    normalizedInput: input,
    armed: false,
  })
}

describe('integrated training/runtime UI boundaries', () => {
  beforeEach(() => {
    window.localStorage.clear()
    runtimeHarness.instances.length = 0
  })

  it('keeps result persistence, lesson isolation, retry/reset, replay, and tuning boundaries together', async () => {
    render(<App />)
    const training = trainingSection()
    const runtime = runtimeHarness.instances[0]
    if (!runtime) throw new Error('Mock runtime was not created')

    fireEvent.click(within(training).getByRole('button', { name: /start countdown \/ reset/i }))
    expect(screen.getByRole('button', { name: /apply \+ reset/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    act(() => emitHoverSuccess(runtime))
    expect(runtime.fixedStepCalls).toBe(36)

    await waitFor(() => expect(within(training).getByText('Lesson passed')).toBeInTheDocument())
    expect(within(training).getByText('Result')).toBeInTheDocument()
    expect(persistedAttempts('hover')).toBe(1)
    act(() => emitHoverSuccess(runtime))
    expect(persistedAttempts('hover')).toBe(1)

    fireEvent.click(within(training).getByRole('button', { name: /coordinated turn/i }))
    expect(within(training).getByRole('heading', { level: 3, name: 'Coordinated Turn' })).toBeInTheDocument()
    fireEvent.click(within(training).getByRole('button', { name: /start countdown \/ reset/i }))
    expect(screen.getByRole('button', { name: /apply \+ reset/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Arm$/ }))
    act(() => emitCoordinatedTurnFailure(runtime))

    await waitFor(() => expect(within(training).getByText('Attempt recorded')).toBeInTheDocument())
    expect(within(training).getByText('Result')).toBeInTheDocument()
    expect(persistedAttempts('coordinated-turn')).toBe(1)

    fireEvent.click(within(training).getByRole('button', { name: /^Retry$/ }))
    expect(within(training).queryByText('Attempt recorded')).not.toBeInTheDocument()
    fireEvent.click(within(training).getByRole('button', { name: /start countdown \/ reset/i }))
    fireEvent.click(within(training).getByRole('button', { name: /^Reset$/ }))
    expect(within(training).getByText('Ready')).toBeInTheDocument()
    expect(persistedAttempts('coordinated-turn')).toBe(1)

    fireEvent.click(within(training).getByRole('button', { name: /split-s/i }))
    expect(within(training).getByRole('heading', { level: 3, name: 'Split-S' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /enter replay/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /enter replay/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Play$/ }))
    expect(screen.getByText('PLAYBACK / playing ghost')).toBeInTheDocument()
    expect(persistedAttempts('coordinated-turn')).toBe(1)

    const apply = screen.getByRole('button', { name: /apply \+ reset/i })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    expect(runtime.reconfigureCalls).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /exit playback/i }))
    await waitFor(() => expect(runtime.reconfigureCalls).toBeGreaterThan(0))
  })
})
