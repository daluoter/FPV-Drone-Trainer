import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { ControllerProfile, GamepadPoller } from '../controller'
import { FlightRenderer, type CameraMode } from '../rendering'
import {
  FlightRuntime,
  type FlightInputSource,
  type FlightRuntimeFixedStepSample,
  type FlightRuntimeTelemetry,
} from '../runtime'
import Mode2StickOverlay from '../training/StickOverlay'
import type { TrainingSceneReference, TrainingSetupRequest } from '../training/types'
import { flightSimulationConfigFromTuning, type TuningSettings } from '../tuning'

export interface FreeFlightProps {
  readonly poller: GamepadPoller
  readonly profile: ControllerProfile | null
  readonly settings: TuningSettings
  readonly trainingResetKey?: number
  readonly trainingSetupRequest?: TrainingSetupRequest | null
  readonly onSceneReferences?: (references: readonly TrainingSceneReference[]) => void
  readonly onFixedStep?: (sample: FlightRuntimeFixedStepSample) => void
  readonly onTelemetry?: (telemetry: FlightRuntimeTelemetry) => void
}

function format(value: number | undefined, digits = 2): string {
  return value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function vector(values: { x: number; y: number; z: number } | undefined, digits = 2): string {
  if (!values) return '—'
  return `${format(values.x, digits)}, ${format(values.y, digits)}, ${format(values.z, digits)}`
}

function quaternion(values: { x: number; y: number; z: number; w: number } | undefined): string {
  if (!values) return '—'
  return `${format(values.x, 3)}, ${format(values.y, 3)}, ${format(values.z, 3)}, ${format(values.w, 3)}`
}

function channelValues(telemetry: FlightRuntimeTelemetry | null): readonly [string, string, string, string] {
  const input = telemetry?.normalizedInput
  if (!input) return ['—', '—', '—', '—']
  return [format(input.roll, 3), format(input.pitch, 3), format(input.yaw, 3), format(input.throttle, 3)]
}

function fallbackTelemetryLabel(telemetry: FlightRuntimeTelemetry | null): string {
  if (!telemetry) return 'Starting runtime…'
  return telemetry.armed ? 'ARMED / simulation running' : 'SAFE / disarmed'
}

export default function FreeFlight({
  poller,
  profile,
  settings,
  trainingResetKey = 0,
  trainingSetupRequest = null,
  onSceneReferences,
  onFixedStep,
  onTelemetry,
}: FreeFlightProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const appliedSettingsRef = useRef(settings)
  const runtimeRef = useRef<FlightRuntime | null>(null)
  const rendererRef = useRef<FlightRenderer | null>(null)
  const [telemetry, setTelemetry] = useState<FlightRuntimeTelemetry | null>(null)
  const [source, setSource] = useState<FlightInputSource>('controller')
  const [cameraMode, setCameraMode] = useState<CameraMode>('fpv')
  const [showHud, setShowHud] = useState(true)
  const fixedStepListenerRef = useRef(onFixedStep)
  const telemetryListenerRef = useRef(onTelemetry)
  const sceneReferencesListenerRef = useRef(onSceneReferences)

  useEffect(() => {
    sceneReferencesListenerRef.current = onSceneReferences
  }, [onSceneReferences])

  useEffect(() => {
    fixedStepListenerRef.current = onFixedStep
  }, [onFixedStep])

  useEffect(() => {
    telemetryListenerRef.current = onTelemetry
  }, [onTelemetry])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cleanupResize = (): void => undefined
    const renderer = new FlightRenderer(canvas, settings.camera)
    const runtime = new FlightRuntime({
      poller,
      profile,
      renderer,
      simulation: flightSimulationConfigFromTuning(settings),
      onTelemetry: (nextTelemetry) => {
        setTelemetry(nextTelemetry)
        telemetryListenerRef.current?.(nextTelemetry)
      },
      onFixedStep: (sample) => fixedStepListenerRef.current?.(sample),
    })
    runtime.setInputSource(source)
    runtime.setCameraMode(cameraMode)
    runtimeRef.current = runtime
    rendererRef.current = renderer
    sceneReferencesListenerRef.current?.(renderer.flightScene.sceneReferences.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      positionM: { ...reference.positionM },
      sizeM: reference.sizeM ? { ...reference.sizeM } : undefined,
    })))
    runtime.start()
    setTelemetry(runtime.getTelemetry())

    const resize = (): void => {
      const parent = canvas.parentElement
      const width = parent?.clientWidth ?? canvas.clientWidth
      const height = parent?.clientHeight ?? canvas.clientHeight
      renderer.resize(width, height)
    }
    resize()
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      const observer = new ResizeObserver(resize)
      observer.observe(canvas.parentElement)
      cleanupResize = () => observer.disconnect()
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', resize)
      cleanupResize = () => window.removeEventListener('resize', resize)
    }

    return () => {
      cleanupResize()
      runtime.dispose()
      renderer.dispose()
      runtimeRef.current = null
      rendererRef.current = null
    }
    // The runtime owns the loop; profile/source updates are handed off by the
    // effects below rather than restarting the renderer.
  }, [poller])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || appliedSettingsRef.current === settings) return
    runtime.reconfigure(flightSimulationConfigFromTuning(settings))
    rendererRef.current?.setCameraOptions(settings.camera)
    appliedSettingsRef.current = settings
    setTelemetry(runtime.getTelemetry())
  }, [settings])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || !trainingSetupRequest) return
    runtime.resetForTraining(trainingSetupRequest.setup)
    setTelemetry(runtime.getTelemetry())
  }, [trainingSetupRequest])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || trainingResetKey <= 0) return
    runtime.reset()
    setTelemetry(runtime.getTelemetry())
  }, [trainingResetKey])

  useEffect(() => {
    runtimeRef.current?.setControllerProfile(profile)
  }, [profile])

  useEffect(() => {
    runtimeRef.current?.setInputSource(source)
  }, [source])

  useEffect(() => {
    runtimeRef.current?.setCameraMode(cameraMode)
  }, [cameraMode])

  const arm = (): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.arm()
    setTelemetry(runtime.getTelemetry())
  }

  const disarm = (): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.disarm('Pilot requested disarm.')
    setTelemetry(runtime.getTelemetry())
  }

  const reset = (): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.reset()
    setTelemetry(runtime.getTelemetry())
  }

  const channels = channelValues(telemetry)
  const rawAxes = telemetry?.rawInput?.axes ?? []
  const processed = telemetry?.processedInput
  const state = telemetry?.state
  const pid = telemetry?.pid

  return (
    <section className="free-flight-section" id="free-flight" aria-labelledby="free-flight-title">
      <div className="free-flight-heading">
        <div>
          <p className="panel-kicker">Phase 5 / Free Flight</p>
          <h2 id="free-flight-title">Fly the state, not the shortcut.</h2>
          <p>
            The simulation and renderer run outside React at a fixed 240 Hz. Arm is an explicit
            handoff: calibrated RC input needs a fresh session gate, neutral sticks, and low throttle.
            Tuning changes are applied only through a disarmed reset.
          </p>
        </div>
        <div className={`flight-state-badge ${telemetry?.armed ? 'flight-state-armed' : ''}`}>
          <span aria-hidden="true" /> {fallbackTelemetryLabel(telemetry)}
        </div>
      </div>

      <div className="free-flight-layout">
        <div className="free-flight-main">
          <div className="free-flight-viewport" role="img" aria-label="Three.js Free Flight simulation viewport">
            <canvas ref={canvasRef} className="flight-canvas" aria-label="Free Flight 3D scene" />
            <div className="flight-viewport-overlay" aria-hidden="true">
              <span>LIVE SIM / {telemetry?.cameraMode?.toUpperCase() ?? 'FPV'}</span>
              <span>{format(telemetry?.metrics.fps, 0)} FPS · {format(telemetry?.metrics.simHz, 0)} SIM HZ</span>
            </div>
            {!telemetry?.armed && <div className="flight-safe-overlay">SAFE / explicit arm required</div>}
          </div>
          <div className="flight-controls" aria-label="Flight controls">
            <div className="flight-control-group">
              <label htmlFor="flight-input-source">Input source</label>
              <select
                id="flight-input-source"
                value={source}
                onChange={(event) => setSource(event.target.value as FlightInputSource)}
              >
                <option value="controller">Verified RC controller</option>
                <option value="keyboard">Developer keyboard fallback</option>
              </select>
            </div>
            <div className="flight-control-group flight-camera-controls" aria-label="Camera mode">
              <span>Camera</span>
              {(['fpv', 'chase', 'free'] as const).map((mode) => (
                <button
                  className={`lab-button lab-button-small ${cameraMode === mode ? 'flight-camera-selected' : ''}`}
                  type="button"
                  key={mode}
                  aria-pressed={cameraMode === mode}
                  onClick={() => setCameraMode(mode)}
                >
                  {mode === 'fpv' ? 'FPV' : mode === 'chase' ? 'Chase' : 'Free / debug'}
                </button>
              ))}
            </div>
            <div className="flight-action-group">
              <button className="lab-button lab-button-primary" type="button" onClick={arm} disabled={Boolean(telemetry?.armed)}>
                Arm
              </button>
              <button className="lab-button" type="button" onClick={disarm} disabled={!telemetry?.armed}>
                Disarm
              </button>
              <button className="lab-button" type="button" onClick={reset}>
                Reset
              </button>
            </div>
          </div>
          {source === 'keyboard' && (
            <p className="flight-input-note">
              Developer fallback selected: W/S pitch · A/D roll · Q/E yaw · R/F throttle · X reset.
              Keys are normalized RC commands and still pass through Actual Rates, PID, mixer, and physics.
            </p>
          )}
        </div>

        <aside className="flight-side-panel">
          <Mode2StickOverlay input={telemetry?.normalizedInput} mode="live" compact />
          <section className="flight-safety-card" aria-labelledby="flight-safety-title">
            <div className="flight-card-heading">
              <h3 id="flight-safety-title">Arm handoff</h3>
              <span className={telemetry?.armed ? 'flight-pass' : 'flight-warn'}>{telemetry?.armed ? 'PASS' : 'LOCKED'}</span>
            </div>
            <p>{profile ? 'Controller Lab profile is handed to the runtime. Stick movement is allowed after arming.' : 'Verify a Controller Lab profile, or explicitly select the developer fallback.'}</p>
            {telemetry?.safetyReasons.map((reason) => <span className="flight-warning" key={reason}>{reason}</span>)}
          </section>
          <label className="flight-hud-toggle">
            <input type="checkbox" checked={showHud} onChange={(event) => setShowHud(event.target.checked)} />
            Developer HUD
          </label>
        </aside>
      </div>

      {showHud && <FlightHud telemetry={telemetry} channels={channels} rawAxes={rawAxes} processed={processed} state={state} pid={pid} />}
    </section>
  )
}

function FlightHud({
  telemetry,
  channels,
  rawAxes,
  processed,
  state,
  pid,
}: {
  telemetry: FlightRuntimeTelemetry | null
  channels: readonly [string, string, string, string]
  rawAxes: readonly number[]
  processed: FlightRuntimeTelemetry['processedInput'] | undefined
  state: FlightRuntimeTelemetry['state'] | undefined
  pid: FlightRuntimeTelemetry['pid'] | undefined
}) {
  return (
    <section className="flight-hud" aria-labelledby="flight-hud-title">
      <div className="flight-card-heading">
        <div>
          <p className="panel-kicker">Developer HUD</p>
          <h3 id="flight-hud-title">Runtime telemetry</h3>
        </div>
        <span>{telemetry?.armed ? 'ARMED' : 'DISARMED'}</span>
      </div>
      <div className="flight-hud-grid">
        <TelemetryCard title="Loop">
          <DataRow label="FPS" value={format(telemetry?.metrics.fps, 1)} />
          <DataRow label="Actual simHz" value={format(telemetry?.metrics.simHz, 1)} />
          <DataRow label="Dropped steps" value={String(telemetry?.metrics.droppedSteps ?? 0)} />
        </TelemetryCard>
        <TelemetryCard title="State / world">
          <DataRow label="Position m" value={vector(state?.positionM)} />
          <DataRow label="Velocity m/s" value={vector(state?.velocityMps)} />
          <DataRow label="Quaternion x y z w" value={quaternion(state?.orientation)} />
          <DataRow label="Angular velocity rad/s" value={vector(state?.angularVelocityBodyRadPerSec)} />
        </TelemetryCard>
        <TelemetryCard title="Input">
          <DataRow label="Raw axes" value={rawAxes.length ? rawAxes.map((value) => format(value, 3)).join(', ') : '—'} />
          <DataRow label="Processed RC" value={channels.join(', ')} />
          <DataRow label="Processed valid" value={processed?.valid ? 'yes' : 'no'} />
        </TelemetryCard>
        <TelemetryCard title="Rates / PID">
          <DataRow label="Target pilot rates rad/s" value={pilotRates(telemetry?.targetPilotRateRadPerSec)} />
          <DataRow label="PID output roll/pitch/yaw" value={pid ? `${format(pid.roll.outputNm, 4)}, ${format(pid.pitch.outputNm, 4)}, ${format(pid.yaw.outputNm, 4)}` : '—'} />
          <DataRow label="Mixer" value={telemetry?.mixerSaturated ? 'saturated' : 'within range'} />
        </TelemetryCard>
      </div>
      <div className="flight-motor-table-wrap">
        <table className="flight-motor-table">
          <thead><tr><th>Motor</th><th>Command</th><th>Target thrust N</th><th>Actual thrust N</th></tr></thead>
          <tbody>{telemetry?.motors.map((motor) => <tr key={motor.id}><th scope="row">{motor.id}</th><td>{format(motor.command, 3)}</td><td>{format(motor.targetThrustN, 3)}</td><td>{format(motor.actualThrustN, 3)}</td></tr>) ?? <tr><td colSpan={4}>Waiting for runtime sample.</td></tr>}</tbody>
        </table>
      </div>
      <div className="flight-warning-list" aria-live="polite">
        {(telemetry?.warnings.length ? telemetry.warnings : ['No runtime warnings.']).map((warning) => <span key={warning}>{warning}</span>)}
      </div>
    </section>
  )
}

function pilotRates(values: FlightRuntimeTelemetry['targetPilotRateRadPerSec'] | undefined): string {
  if (!values) return '—'
  return `${format(values.roll, 3)}, ${format(values.pitch, 3)}, ${format(values.yaw, 3)}`
}

function TelemetryCard({ title, children }: { title: string; children: ReactNode }) {
  return <div className="flight-telemetry-card"><strong>{title}</strong>{children}</div>
}

function DataRow({ label, value }: { label: string; value: string }) {
  return <div className="flight-data-row"><span>{label}</span><code>{value}</code></div>
}