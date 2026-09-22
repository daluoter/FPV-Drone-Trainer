import { useCallback, useMemo, useState } from 'react'

import { createBrowserGamepadPoller } from '../controller'
import ControllerLab, { type ControllerLabFlightHandoff } from '../controller/ControllerLab'
import FreeFlight from '../free-flight/FreeFlight'
import TuningPanel from '../tuning/TuningPanel'
import { copyTuningSettings, TuningSettingsStore, type TuningSettings } from '../tuning'

type RoadmapStatus = 'active' | 'next' | 'planned' | 'complete'

type RoadmapItem = {
  title: string
  description: string
  status: RoadmapStatus
}

const roadmap: RoadmapItem[] = [
  {
    title: 'Foundation',
    description: 'Strict TypeScript shell, build tooling, and documented boundaries.',
    status: 'complete',
  },
  {
    title: 'Controller Lab',
    description: 'Discover, calibrate, inspect, and safely validate transmitter input.',
    status: 'complete',
  },
  {
    title: 'Acro flight core',
    description: 'Rates, motors, rigid-body dynamics, and a fixed-step simulation loop.',
    status: 'complete',
  },
  {
    title: 'Free Flight',
    description: 'Safe arm handoff, Three.js field, camera modes, and developer telemetry.',
    status: 'complete',
  },
  {
    title: 'Bounded tuning',
    description: 'Versioned Actual Rates, dynamics, PID and camera settings with reset safety.',
    status: 'active',
  },
  {
    title: 'Flight school',
    description: 'Stateful lessons that judge trajectory and aircraft state—not stick rituals.',
    status: 'planned',
  },
]

const pipeline = [
  'RC device',
  'Calibration',
  'Processed channels',
  'Rates',
  'Flight controller',
  'Quad dynamics',
  'Drone state',
  'Renderer',
]

function statusLabel(status: RoadmapStatus): string {
  if (status === 'active') return 'Building now'
  if (status === 'next') return 'Next gate'
  if (status === 'complete') return 'Complete'
  return 'Planned'
}

export default function App() {
  const poller = useMemo(() => createBrowserGamepadPoller(), [])
  const tuningStore = useMemo(() => new TuningSettingsStore(), [])
  const initialTuningLoad = useMemo(() => tuningStore.load(), [tuningStore])
  const [tuningSettings, setTuningSettings] = useState(initialTuningLoad.settings)
  const [tuningNotice] = useState<string | null>(() => initialTuningLoad.errors.length > 0
    ? 'Saved tuning was unavailable or incompatible; bounded defaults are active.'
    : null)
  const [flightProfile, setFlightProfile] = useState<ControllerLabFlightHandoff['profile']>(null)
  const onFlightHandoff = useCallback((handoff: ControllerLabFlightHandoff) => {
    setFlightProfile(handoff.profile)
  }, [])
  const onTuningApply = useCallback((next: TuningSettings) => {
    const result = tuningStore.save(next)
    if (result.saved) setTuningSettings(copyTuningSettings(next))
    return result
  }, [tuningStore])

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FPV Drone Trainer home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span className="brand-name">
            FPV <strong>TRAINER</strong>
          </span>
        </a>
        <div className="topbar-status" aria-label="Application status">
          <span className="status-light" aria-hidden="true" />
          <span>Phase 5 / Tuning + Free Flight build</span>
          <span className="status-divider" aria-hidden="true" />
          <span className="muted">RC gate + developer fallback</span>
        </div>
      </header>

      <main>
        <section className="hero-section" aria-labelledby="page-title">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="eyebrow-line" aria-hidden="true" />
              Flight school for the rate-minded
            </p>
            <h1 id="page-title" aria-label="Train the inputs before you trust the drone.">
              Train the inputs
              <br />
              <em>before</em> you trust the drone.
            </h1>
            <p className="hero-description">
              A controller-first FPV simulator built around trustworthy signals, believable Acro
              flight, and feedback that makes every correction measurable.
            </p>
            <div className="hero-actions">
              <button className="button button-primary" type="button" onClick={() => document.getElementById('controller-lab')?.scrollIntoView({ behavior: 'smooth' })}>
                Controller Lab
                <span className="button-meta">Open lab</span>
              </button>
              <button className="button button-secondary" type="button" onClick={() => document.getElementById('free-flight')?.scrollIntoView({ behavior: 'smooth' })}>
                Free Flight
                <span className="button-meta">Open screen</span>
              </button>
            </div>
            <p className="safety-note">
              <span className="safety-icon" aria-hidden="true">
                ✓
              </span>
              Flight controls stay locked until neutral input can be proven stable.
            </p>
          </div>

          <aside className="status-card" aria-label="Free Flight status">
            <div className="card-heading">
              <span>System status</span>
              <span className="safe-badge">SAFE / UI ONLY</span>
            </div>
            <div className="status-readout">
              <div className="readout-row">
                <span>Current phase</span>
                <strong>Bounded tuning</strong>
              </div>
              <div className="readout-row">
                <span>Controller</span>
                <strong className="readout-muted">Gamepad monitor active</strong>
              </div>
              <div className="readout-row">
                <span>Simulation</span>
                <strong className="readout-muted">Fixed-step runtime ready</strong>
              </div>
              <div className="readout-row">
                <span>Safety gate</span>
                <strong className="readout-safe">Explicit arm gate required</strong>
              </div>
            </div>
            <div className="card-note">
              <span className="note-indicator" aria-hidden="true" />
              Controller Lab reads only raw input until calibration proves it safe.
            </div>
          </aside>
        </section>

        <ControllerLab poller={poller} onFlightHandoff={onFlightHandoff} />

        <TuningPanel settings={tuningSettings} notice={tuningNotice} onApply={onTuningApply} />

        <FreeFlight poller={poller} profile={flightProfile} settings={tuningSettings} />

        <section className="workspace-grid" aria-label="Application preview and roadmap">
          <article className="viewport-card panel-card">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Integration map</p>
                <h2>Clear geometry. Clear feedback.</h2>
              </div>
              <span className="panel-tag">Renderer contract</span>
            </div>
            <div className="viewport-placeholder" role="img" aria-label="Free Flight integration preview">
              <div className="viewport-scanline" aria-hidden="true" />
              <div className="viewport-crosshair" aria-hidden="true">
                <span />
                <span />
              </div>
              <div className="viewport-message">
                <span className="viewport-icon" aria-hidden="true">
                  ◇
                </span>
                <strong>Live Three.js scene is in the Free Flight screen</strong>
                <span>Simulation state remains independent from this React shell.</span>
              </div>
              <span className="viewport-corner viewport-corner-tl" aria-hidden="true" />
              <span className="viewport-corner viewport-corner-tr" aria-hidden="true" />
              <span className="viewport-corner viewport-corner-bl" aria-hidden="true" />
              <span className="viewport-corner viewport-corner-br" aria-hidden="true" />
            </div>
            <div className="viewport-footer">
              <span>
                <span className="footer-dot" aria-hidden="true" />
                Free Flight runtime / scroll above
              </span>
              <span>Viewport / 01</span>
            </div>
          </article>

          <article className="roadmap-card panel-card">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Build sequence</p>
                <h2>Trust, then tune.</h2>
              </div>
              <span className="progress-count">05 / 09</span>
            </div>
            <div className="roadmap-list">
              {roadmap.map((item, index) => (
                <div className={`roadmap-item roadmap-${item.status}`} key={item.title}>
                  <span className="roadmap-index">{String(index + 1).padStart(2, '0')}</span>
                  <div className="roadmap-content">
                    <div className="roadmap-title-row">
                      <h3>{item.title}</h3>
                      <span className="roadmap-status">{statusLabel(item.status)}</span>
                    </div>
                    <p>{item.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="pipeline-section" aria-labelledby="pipeline-title">
          <div className="pipeline-intro">
            <p className="panel-kicker">Core data flow</p>
            <h2 id="pipeline-title">One signal path.<br />No hidden shortcuts.</h2>
            <p>
              UI, input, flight logic, and rendering are separate contracts. The high-frequency
              loop will never depend on React renders.
            </p>
          </div>
          <div className="pipeline" aria-label="Planned simulator data flow">
            {pipeline.map((stage, index) => (
              <div className="pipeline-stage" key={stage}>
                <span className="pipeline-number">{String(index + 1).padStart(2, '0')}</span>
                <span>{stage}</span>
                {index < pipeline.length - 1 && <span className="pipeline-arrow" aria-hidden="true">→</span>}
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <span>FPV Drone Trainer</span>
        <span>Built for measurable flight feel.</span>
        <span className="footer-version">v0.1.0 / phase 5 tuning</span>
      </footer>
    </div>
  )
}
