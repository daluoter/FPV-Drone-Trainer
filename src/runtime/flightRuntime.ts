import {
  evaluateFlightArmEligibility,
  evaluateFlightEligibility,
  ControllerSignalHistory,
  type ControllerProfile,
  type GamepadPoller,
  type PollerState,
  type ProcessedControllerState,
  type RawGamepadSnapshot,
  type ControllerDevice,
} from '../controller'
import {
  FlightSimulation,
  processedControllerStateToNormalizedRc,
  type FlightSimulationConfig,
  type FlightTelemetry,
  type NormalizedRcInput,
} from '../flight-controller'
import type { DroneState } from '../drone'
import type { LessonSetup } from '../training/types'
import { FlightRenderer } from '../rendering'
import {
  FlightReplayRecorder,
  ReplayPlayback,
  type ReplayRecording,
  type ReplaySpeed,
} from '../replay'
import { DeveloperKeyboardInput } from './keyboard'

export type FlightInputSource = 'controller' | 'keyboard'

export interface RuntimePoller {
  poll(): PollerState
  getState(): PollerState
  getSelectedSnapshot(): RawGamepadSnapshot | null
}

export interface FlightRuntimeMetrics {
  readonly fps: number
  readonly simHz: number
  readonly droppedSteps: number
  readonly droppedSeconds: number
  readonly lastDroppedSteps: number
  readonly lastDroppedSeconds: number
}

export interface FlightRuntimeFixedStepSample {
  /** Authoritative fixed-step simulation time in seconds. */
  readonly timestampSeconds: number
  readonly state: DroneState
  readonly normalizedInput: NormalizedRcInput | null
  /** Explicit arm state prevents disarmed/reset telemetry from producing a pass. */
  readonly armed: boolean
  readonly telemetry: FlightTelemetry
}

export interface FlightRuntimeReplayTelemetry {
  readonly active: boolean
  readonly playing: boolean
  readonly available: boolean
  readonly sampleCount: number
  readonly currentTimeSeconds: number
  readonly durationSeconds: number
  readonly speed: ReplaySpeed
  readonly label: 'LIVE' | 'PLAYBACK'
}

export interface FlightRuntimeTelemetry extends FlightTelemetry {
  readonly state: DroneState
  readonly source: FlightInputSource
  readonly rawInput: RawGamepadSnapshot | null
  readonly processedInput: ProcessedControllerState | null
  readonly normalizedInput: NormalizedRcInput | null
  readonly metrics: FlightRuntimeMetrics
  readonly cameraMode: 'fpv' | 'chase' | 'free'
  readonly safetyReasons: readonly string[]
  readonly replay: FlightRuntimeReplayTelemetry
}

export interface FlightRuntimeOptions {
  readonly poller?: RuntimePoller | GamepadPoller
  readonly profile?: ControllerProfile | null
  /** Omit only for renderer-independent simulation tests or inject a renderer double. */
  readonly renderer?: FlightRenderer | null
  /** Production Free Flight sets this false until a visible renderer is ready. */
  readonly renderingAvailable?: boolean
  readonly simulation?: FlightSimulationConfig
  readonly scheduleFrame?: (callback: (time: number) => void) => number
  readonly cancelFrame?: (handle: number) => void
  readonly now?: () => number
  readonly telemetryIntervalMs?: number
  readonly onTelemetry?: (telemetry: FlightRuntimeTelemetry) => void
  /** Called exactly once after each completed fixed simulation step. */
  readonly onFixedStep?: (sample: FlightRuntimeFixedStepSample) => void
  /** Optional bounded recorder; a recorder is created when omitted. */
  readonly replayRecorder?: FlightReplayRecorder
}

interface SampledInput {
  readonly device: ControllerDevice | null
  readonly snapshot: RawGamepadSnapshot | null
  readonly processed: ProcessedControllerState | null
  readonly input: NormalizedRcInput | null
  readonly safetyReasons: readonly string[]
}

const DEFAULT_TELEMETRY_INTERVAL_MS = 100
const DEFAULT_CAMERA_MODE: FlightRuntimeTelemetry['cameraMode'] = 'fpv'

function profileKey(profile: ControllerProfile | null): string | null {
  if (!profile) return null
  return JSON.stringify(profile)
}

function deviceKey(device: ControllerDevice | null): string | null {
  if (!device) return null
  return [
    device.id,
    device.index,
    device.mapping,
    device.axisCount,
    device.buttonCount,
    device.connected,
    device.connectionSession ?? null,
  ].join(':')
}

function browserScheduleFrame(callback: (time: number) => void): number {
  return requestAnimationFrame(callback)
}

function browserCancelFrame(handle: number): void {
  cancelAnimationFrame(handle)
}

function browserNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function validElapsedMs(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function copyDroneState(state: DroneState): DroneState {
  return {
    ...state,
    positionM: { ...state.positionM },
    velocityMps: { ...state.velocityMps },
    orientation: { ...state.orientation },
    angularVelocityBodyRadPerSec: { ...state.angularVelocityBodyRadPerSec },
    motors: state.motors.map((motor) => ({ ...motor })) as unknown as DroneState['motors'],
    warnings: [...state.warnings],
  }
}

function copyNormalizedInput(input: NormalizedRcInput | null): NormalizedRcInput | null {
  return input ? { ...input } : null
}

/**
 * Owns the high-frequency Phase 4 loop. It samples the selected Gamepad,
 * processes the verified profile, advances the fixed-step flight simulation,
 * updates Three.js, and only publishes a throttled immutable telemetry view.
 */
export class FlightRuntime {
  public simulation: FlightSimulation
  public readonly keyboard: DeveloperKeyboardInput
  private readonly poller: RuntimePoller | null
  private readonly renderer: FlightRenderer | null
  private readonly signalHistory = new ControllerSignalHistory()
  private readonly scheduleFrame: ((callback: (time: number) => void) => number) | null
  private readonly cancelFrame: ((handle: number) => void) | null
  private readonly now: () => number
  private readonly telemetryIntervalMs: number
  private readonly telemetryListener: ((telemetry: FlightRuntimeTelemetry) => void) | null
  private readonly fixedStepListener: ((sample: FlightRuntimeFixedStepSample) => void) | null
  public readonly replayRecorder: FlightReplayRecorder
  private replayPlayback: ReplayPlayback | null = null
  private controllerProfile: ControllerProfile | null
  private tuningLocked = false
  private renderingAvailable: boolean
  private renderingSafetyReason: string | null = null
  private source: FlightInputSource = 'controller'
  private cameraMode: FlightRuntimeTelemetry['cameraMode'] = DEFAULT_CAMERA_MODE
  private running = false
  private frameHandle: number | null = null
  private lastFrameTimeMs: number | null = null
  private lastTelemetryTimeMs: number | null = null
  private framesSinceTelemetry = 0
  private stepsSinceTelemetry = 0
  private droppedStepsTotal = 0
  private droppedSecondsTotal = 0
  private lastDeviceKey: string | null | undefined
  private lastProfileKey: string | null | undefined
  private lastSample: SampledInput = {
    device: null,
    snapshot: null,
    processed: null,
    input: null,
    safetyReasons: ['Controller input is not verified.'],
  }
  private lastSafetyReasons: readonly string[] = []
  private lastTelemetry: FlightRuntimeTelemetry
  private readonly onBlurBound = (): void => {
    this.keyboard.releaseKeys()
    this.disarm('Window focus was lost; explicit rearm is required.')
  }
  private readonly onVisibilityBound = (): void => {
    if (typeof document !== 'undefined' && document.hidden) {
      this.keyboard.releaseKeys()
      this.disarm('Document became hidden; explicit rearm is required.')
    }
  }
  private readonly onFrameBound = (time: number): void => {
    this.frameHandle = null
    this.frame(time)
  }

  public constructor(options: FlightRuntimeOptions = {}) {
    this.poller = options.poller ?? null
    this.renderer = options.renderer ?? null
    this.renderingAvailable = options.renderingAvailable ?? true
    this.simulation = new FlightSimulation(options.simulation)
    this.keyboard = new DeveloperKeyboardInput()
    this.controllerProfile = options.profile ?? null
    this.lastProfileKey = profileKey(this.controllerProfile)
    this.scheduleFrame = options.scheduleFrame
      ?? (typeof requestAnimationFrame === 'function' ? browserScheduleFrame : null)
    this.cancelFrame = options.cancelFrame
      ?? (typeof cancelAnimationFrame === 'function' ? browserCancelFrame : null)
    this.now = options.now ?? browserNow
    const interval = options.telemetryIntervalMs ?? DEFAULT_TELEMETRY_INTERVAL_MS
    this.telemetryIntervalMs = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_TELEMETRY_INTERVAL_MS
    this.telemetryListener = options.onTelemetry ?? null
    this.fixedStepListener = options.onFixedStep ?? null
    this.replayRecorder = options.replayRecorder ?? new FlightReplayRecorder()
    this.lastTelemetry = this.makeTelemetry(this.simulation.getTelemetry(), 0, 0, 0, 0)
  }

  public getTelemetry(): FlightRuntimeTelemetry {
    return this.lastTelemetry
  }

  public get inputSource(): FlightInputSource {
    return this.source
  }

  public isRunning(): boolean {
    return this.running
  }

  public isReplayActive(): boolean {
    return this.replayPlayback !== null
  }

  public getReplayRecording(): ReplayRecording | null {
    return this.replayRecorder.getRecording()
  }

  public getReplayPlayback(): ReplayPlayback | null {
    return this.replayPlayback
  }

  /** Enter an independent ghost view from the bounded last-flight recording. */
  public enterReplay(recording: ReplayRecording | null = this.getReplayRecording()): boolean {
    if (!recording || recording.samples.length === 0) return false
    if (this.replayPlayback) return true
    this.keyboard.releaseKeys()
    this.disarm('Replay playback entered; live flight was explicitly disarmed.')
    this.replayPlayback = new ReplayPlayback(recording)
    this.lastFrameTimeMs = null
    this.lastTelemetryTimeMs = null
    this.renderer?.setReplayPath(recording.samples.map((sample) => sample.positionM))
    this.renderReplay()
    this.emitTelemetry(true)
    return true
  }

  public exitReplay(): boolean {
    if (!this.replayPlayback) return false
    this.replayPlayback = null
    this.renderer?.clearReplay()
    // A replay exit is a clean live-runtime boundary: time and controller
    // memory restart at zero, and arm must be requested explicitly again.
    this.reset()
    this.lastFrameTimeMs = null
    this.lastTelemetryTimeMs = null
    this.emitTelemetry(true)
    return true
  }

  public playReplay(): boolean {
    if (!this.replayPlayback) return false
    this.replayPlayback.play()
    this.renderReplay()
    this.emitTelemetry(true)
    return true
  }

  public pauseReplay(): boolean {
    if (!this.replayPlayback) return false
    this.replayPlayback.pause()
    this.renderReplay()
    this.emitTelemetry(true)
    return true
  }

  public seekReplay(seconds: number): boolean {
    if (!this.replayPlayback) return false
    const changed = this.replayPlayback.seek(seconds)
    if (changed) {
      this.renderReplay()
      this.emitTelemetry(true)
    }
    return changed
  }

  public setReplaySpeed(speed: number): boolean {
    if (!this.replayPlayback) return false
    const changed = this.replayPlayback.setSpeed(speed)
    if (changed) this.emitTelemetry(true)
    return changed
  }

  public start(): void {
    if (this.running) return
    this.running = true
    this.lastFrameTimeMs = null
    this.lastTelemetryTimeMs = null
    this.addSafetyListeners()
    this.keyboard.setEnabled(this.source === 'keyboard')
    this.emitTelemetry(true)
    this.scheduleNextFrame()
  }

  public stop(): void {
    if (!this.running) return
    this.running = false
    if (this.frameHandle !== null && this.cancelFrame) this.cancelFrame(this.frameHandle)
    this.frameHandle = null
    this.removeSafetyListeners()
    this.keyboard.releaseKeys()
    if (this.replayPlayback) this.exitReplay()
    this.disarm('Flight runtime stopped; explicit rearm is required.')
  }

  public dispose(): void {
    this.stop()
    this.keyboard.dispose()
  }

  public setInputSource(source: FlightInputSource): void {
    if (source === this.source) return
    this.source = source
    this.keyboard.setEnabled(source === 'keyboard')
    this.signalHistory.reset()
    this.disarm(`Input source changed to ${source}; explicit rearm is required.`)
    this.emitTelemetry(true)
  }

  public setControllerProfile(profile: ControllerProfile | null): void {
    const nextKey = profileKey(profile)
    if (nextKey === this.lastProfileKey && profile === this.controllerProfile) return
    const changed = this.lastProfileKey !== undefined && nextKey !== this.lastProfileKey
    this.controllerProfile = profile
    this.lastProfileKey = nextKey
    this.signalHistory.reset()
    if (changed) this.disarm('Controller profile changed; explicit rearm is required.')
  }

  public setCameraMode(mode: FlightRuntimeTelemetry['cameraMode']): void {
    this.cameraMode = mode
    this.renderer?.setCameraMode(mode)
    this.emitTelemetry(true)
  }

  public isRenderingAvailable(): boolean {
    return this.renderingAvailable
  }

  /**
   * A live simulator is not armable unless its state can be shown. Renderer
   * context loss therefore follows the same explicit disarm boundary as blur,
   * disconnect, and invalid controller input.
   */
  public setRenderingAvailable(available: boolean, reason = 'The 3D renderer is unavailable; recover the viewport before arming.'): void {
    if (available) {
      const previousReason = this.renderingSafetyReason
      this.renderingAvailable = true
      this.renderingSafetyReason = null
      if (previousReason) this.lastSafetyReasons = this.lastSafetyReasons.filter((candidate) => candidate !== previousReason)
      this.emitTelemetry(true)
      return
    }
    this.renderingAvailable = false
    this.renderingSafetyReason = reason
    this.disarm(reason)
  }

  /** Prevent tuning from rebuilding the simulation during a lesson attempt. */
  public setTuningLocked(locked: boolean): void {
    this.tuningLocked = locked
  }

  public isTuningLocked(): boolean {
    return this.tuningLocked
  }

  public arm(): boolean {
    if (this.replayPlayback) {
      this.lastSafetyReasons = ['Exit replay playback before explicitly rearming the live flight.']
      this.emitTelemetry(true)
      return false
    }
    if (!this.renderingAvailable) {
      const reason = this.renderingSafetyReason ?? 'The 3D renderer is unavailable; recover the viewport before arming.'
      this.disarm(reason)
      return false
    }
    const sample = this.sampleInput()
    this.lastSample = sample
    if (this.source === 'controller') {
      const eligibility = evaluateFlightArmEligibility(
        sample.device,
        this.controllerProfile,
        sample.processed,
        { connectionSession: sample.device?.connectionSession ?? null },
      )
      if (!eligibility.eligible) {
        this.lastSafetyReasons = eligibility.reasons
        this.disarm(eligibility.reasons[0] ?? 'Controller arm gate is locked.')
        this.emitTelemetry(true)
        return false
      }
    }
    this.lastSafetyReasons = []
    this.simulation.arm()
    if (this.simulation.isArmed()) this.replayRecorder.beginFlight()
    this.emitTelemetry(true)
    return this.simulation.isArmed()
  }

  public disarm(reason = 'Flight runtime was disarmed.'): void {
    this.simulation.disarm(reason)
    this.replayRecorder.endFlight()
    this.lastSafetyReasons = [reason]
    this.refreshTelemetry(0, 0, 0)
    this.emitTelemetry(true)
  }

  public reset(): void {
    if (this.replayPlayback) {
      this.exitReplay()
      return
    }
    this.resetAt(this.simulation.droneConfig.spawnPositionM, undefined, 'Flight runtime was reset and disarmed.')
  }

  /**
   * Honor a lesson's spawn/orientation only through an explicit disarmed reset.
   * App/runtime callers invoke this during COUNTDOWN; fixed-step ACTIVE samples
   * never call it, so an evaluator cannot move the player as a side effect.
   */
  public resetForTraining(setup: LessonSetup): DroneState {
    if (setup.requiresDisarmed !== true || setup.resetSimulation !== true) {
      return this.resetAt(
        this.simulation.droneConfig.spawnPositionM,
        undefined,
        'Invalid training setup; runtime was reset and disarmed.',
      )
    }
    return this.resetAt(
      setup.spawnPositionM ?? this.simulation.droneConfig.spawnPositionM,
      setup.spawnOrientation,
      'Training setup applied through an explicit disarmed reset.',
    )
  }

  private resetAt(
    positionM: { readonly x: number; readonly y: number; readonly z: number },
    orientation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number } | undefined,
    reason: string,
  ): DroneState {
    this.keyboard.releaseKeys()
    this.signalHistory.reset()
    this.lastSample = {
      device: null,
      snapshot: null,
      processed: null,
      input: null,
      safetyReasons: [],
    }
    this.lastSafetyReasons = [reason]
    this.replayRecorder.endFlight()
    this.simulation.disarm(reason)
    this.simulation.resetAt(positionM, orientation)
    this.refreshTelemetry(0, 0, 0)
    this.emitTelemetry(true)
    return this.simulation.getState()
  }

  /**
   * Replace simulation configuration only through an explicit reset boundary.
   * This always disarms first, clears controller/input history, and starts the
   * replacement simulation from its safe initial state.
   */
  public reconfigure(config: FlightSimulationConfig): boolean {
    if (this.tuningLocked || this.replayPlayback) return false
    this.keyboard.releaseKeys()
    this.replayRecorder.endFlight()
    this.simulation.disarm('Flight settings changed; runtime was reset and disarmed.')
    this.simulation = new FlightSimulation(config)
    this.signalHistory.reset()
    this.lastSample = {
      device: null,
      snapshot: null,
      processed: null,
      input: null,
      safetyReasons: [],
    }
    this.lastSafetyReasons = ['Flight settings applied; runtime was reset and disarmed.']
    this.emitTelemetry(true)
    return true
  }

  private frame(time: number): void {
    if (!this.running) return
    const frameTime = Number.isFinite(time) ? time : this.now()
    const frameDeltaSeconds = this.lastFrameTimeMs === null
      ? 0
      : Math.max(0, (frameTime - this.lastFrameTimeMs) / 1_000)
    this.lastFrameTimeMs = frameTime
    this.framesSinceTelemetry += 1

    if (this.replayPlayback) {
      this.replayPlayback.advance(frameDeltaSeconds)
      this.renderReplay()
      this.refreshTelemetry(0, 0, frameDeltaSeconds * 1_000)
      this.scheduleNextFrame()
      return
    }

    const sample = this.sampleInput()
    this.lastSample = sample
    if (sample.safetyReasons.length > 0 && this.simulation.isArmed()) {
      this.disarm(sample.safetyReasons[0])
    }

    if (this.keyboard.consumeResetRequest()) this.reset()
    const result = this.simulation.advance(frameDeltaSeconds, sample.input, (step) => {
      const fixedStepSample: FlightRuntimeFixedStepSample = {
        timestampSeconds: step.state.timeSeconds,
        state: copyDroneState(step.state),
        normalizedInput: copyNormalizedInput(sample.input),
        armed: step.telemetry.armed,
        telemetry: step.telemetry,
      }
      if (fixedStepSample.armed) this.replayRecorder.record(fixedStepSample)
      this.fixedStepListener?.(fixedStepSample)
    })
    this.stepsSinceTelemetry += result.steps
    this.droppedStepsTotal += result.droppedSteps
    this.droppedSecondsTotal += result.droppedSeconds
    this.lastSafetyReasons = sample.safetyReasons.length > 0
      ? sample.safetyReasons
      : result.warnings
    this.renderer?.render(result.state)
    this.refreshTelemetry(
      result.droppedSteps,
      result.droppedSeconds,
      frameDeltaSeconds * 1_000,
    )
    this.scheduleNextFrame()
  }

  private renderReplay(): void {
    const playback = this.replayPlayback
    if (!playback) return
    const ghost = playback.getGhostState()
    if (!ghost) return
    this.renderer?.renderGhost(ghost)
  }

  private sampleInput(): SampledInput {
    const state: PollerState | null = this.poller ? this.poller.poll() : null
    const pollState = state ?? this.poller?.getState() ?? null
    const selectedDevice = pollState?.selectedDeviceIndex === null || pollState?.selectedDeviceIndex === undefined
      ? null
      : pollState.devices.find((device) => device.index === pollState.selectedDeviceIndex) ?? null
    const snapshot = this.poller?.getSelectedSnapshot() ?? (
      pollState?.snapshots.find((candidate) => candidate.index === pollState.selectedDeviceIndex) ?? null
    )
    const nextDeviceKey = deviceKey(selectedDevice)
    if (this.lastDeviceKey === undefined) this.lastDeviceKey = nextDeviceKey
    else if (nextDeviceKey !== this.lastDeviceKey) {
      this.lastDeviceKey = nextDeviceKey
      this.signalHistory.reset()
      if (this.simulation.isArmed()) this.disarm('Controller device/session changed; explicit rearm is required.')
    }

    if (this.source === 'keyboard') {
      return {
        device: selectedDevice,
        snapshot,
        processed: null,
        input: this.keyboard.getInput(),
        safetyReasons: selectedDevice && !selectedDevice.connected
          ? ['The selected controller is disconnected; explicit rearm is required.']
          : [],
      }
    }

    if (!selectedDevice || !snapshot) {
      return {
        device: selectedDevice,
        snapshot,
        processed: null,
        input: null,
        safetyReasons: ['Select a connected controller before using RC input.'],
      }
    }
    if (!this.controllerProfile) {
      return {
        device: selectedDevice,
        snapshot,
        processed: null,
        input: null,
        safetyReasons: ['Complete and verify the Controller Lab profile before RC flight.'],
      }
    }

    const processed = this.signalHistory.process(snapshot, this.controllerProfile)
    const eligibility = evaluateFlightEligibility(
      selectedDevice,
      this.controllerProfile,
      processed,
      { connectionSession: selectedDevice.connectionSession ?? null },
    )
    const input = processedControllerStateToNormalizedRc(processed)
    const safetyReasons = eligibility.eligible && input
      ? []
      : eligibility.reasons.length > 0
        ? eligibility.reasons
        : ['Processed controller input was invalid.']
    return {
      device: selectedDevice,
      snapshot,
      processed,
      input: safetyReasons.length === 0 ? input : null,
      safetyReasons,
    }
  }

  private refreshTelemetry(
    droppedSteps: number,
    droppedSeconds: number,
    frameDeltaMs: number,
  ): void {
    const now = this.now()
    const elapsedMs = this.lastTelemetryTimeMs === null
      ? 0
      : validElapsedMs(now - this.lastTelemetryTimeMs)
    const shouldPublish = this.lastTelemetryTimeMs === null || elapsedMs >= this.telemetryIntervalMs
    if (shouldPublish) {
      const divisorSeconds = elapsedMs > 0 ? elapsedMs / 1_000 : Math.max(frameDeltaMs / 1_000, 1 / 60)
      const metrics: FlightRuntimeMetrics = {
        fps: this.framesSinceTelemetry / divisorSeconds,
        simHz: this.stepsSinceTelemetry / divisorSeconds,
        droppedSteps: this.droppedStepsTotal,
        droppedSeconds: this.droppedSecondsTotal,
        lastDroppedSteps: droppedSteps,
        lastDroppedSeconds: droppedSeconds,
      }
      this.lastTelemetry = this.makeTelemetry(
        this.simulation.getTelemetry(),
        metrics.fps,
        metrics.simHz,
        droppedSteps,
        droppedSeconds,
        metrics,
      )
      this.framesSinceTelemetry = 0
      this.stepsSinceTelemetry = 0
      this.lastTelemetryTimeMs = now
      this.telemetryListener?.(this.lastTelemetry)
    }
  }

  private makeTelemetry(
    telemetry: FlightTelemetry,
    fps: number,
    simHz: number,
    droppedSteps: number,
    droppedSeconds: number,
    metrics: FlightRuntimeMetrics = {
      fps,
      simHz,
      droppedSteps: this.droppedStepsTotal,
      droppedSeconds: this.droppedSecondsTotal,
      lastDroppedSteps: droppedSteps,
      lastDroppedSeconds: droppedSeconds,
    },
  ): FlightRuntimeTelemetry {
    const recordingSummary = this.replayRecorder.getSummary()
    const playbackState = this.replayPlayback?.getState() ?? null
    return {
      ...telemetry,
      state: this.simulation.getState(),
      source: this.source,
      rawInput: this.lastSample.snapshot,
      processedInput: this.lastSample.processed,
      normalizedInput: this.lastSample.input,
      metrics: {
        ...metrics,
        droppedSteps: Math.max(metrics.droppedSteps, this.droppedStepsTotal),
        droppedSeconds: Math.max(metrics.droppedSeconds, this.droppedSecondsTotal),
        lastDroppedSteps: metrics.lastDroppedSteps,
        lastDroppedSeconds: metrics.lastDroppedSeconds,
      },
      cameraMode: this.cameraMode,
      replay: {
        active: playbackState !== null,
        playing: playbackState?.playing ?? false,
        available: recordingSummary.available,
        sampleCount: recordingSummary.sampleCount,
        currentTimeSeconds: playbackState?.currentTimeSeconds ?? 0,
        durationSeconds: playbackState?.durationSeconds ?? recordingSummary.durationSeconds,
        speed: playbackState?.speed ?? 1,
        label: playbackState ? 'PLAYBACK' : 'LIVE',
      },
      safetyReasons: [...this.lastSafetyReasons, ...this.lastSample.safetyReasons].filter(
        (reason, index, reasons) => reasons.indexOf(reason) === index,
      ),
      warnings: [
        ...telemetry.warnings,
        ...this.lastSafetyReasons,
      ].filter((warning, index, warnings) => warnings.indexOf(warning) === index),
    }
  }

  private emitTelemetry(force: boolean): void {
    if (!force) return
    this.lastTelemetry = this.makeTelemetry(this.simulation.getTelemetry(), 0, 0, 0, 0)
    this.telemetryListener?.(this.lastTelemetry)
  }

  private scheduleNextFrame(): void {
    if (!this.running || !this.scheduleFrame || this.frameHandle !== null) return
    this.frameHandle = this.scheduleFrame(this.onFrameBound)
  }

  private addSafetyListeners(): void {
    if (typeof window !== 'undefined') window.addEventListener('blur', this.onBlurBound)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibilityBound)
  }

  private removeSafetyListeners(): void {
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.onBlurBound)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityBound)
  }
}

export const FlightControllerRuntime = FlightRuntime