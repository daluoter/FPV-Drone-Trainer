import { useEffect, useState, type ChangeEvent } from 'react'

import {
  actualRateCurve,
  CAMERA_MOUNT_ANGLE_OPTIONS,
  copyTuningSettings,
  createDefaultTuningSettings,
  TUNING_LIMITS,
  updateCameraTuning,
  updateDroneTuning,
  updatePidAxis,
  updateRateAxis,
  validateTuningSettings,
  type CameraMountAngleDegrees,
  type TuningPersistenceResult,
  type TuningSettings,
} from './config'
import { RATE_AXES, type RateAxis } from '../rates'

export interface TuningPanelProps {
  readonly settings: TuningSettings
  readonly notice?: string | null
  readonly disabled?: boolean
  readonly onApply: (settings: TuningSettings) => TuningPersistenceResult
}

function axisLabel(axis: RateAxis): string {
  return axis.toUpperCase()
}

function finiteInput(event: ChangeEvent<HTMLInputElement>): number | null {
  const value = Number(event.target.value)
  return Number.isFinite(value) ? value : null
}

export default function TuningPanel({ settings, notice, disabled = false, onApply }: TuningPanelProps) {
  const [draft, setDraft] = useState(() => copyTuningSettings(settings))
  const [curveAxis, setCurveAxis] = useState<RateAxis>('roll')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    setDraft(copyTuningSettings(settings))
    setError(null)
  }, [settings])

  const apply = (next: TuningSettings): void => {
    if (disabled) {
      setError('Tuning changes are disabled while a lesson is counting down or active. Reset or end the lesson first.')
      setStatus(null)
      return
    }
    const validation = validateTuningSettings(next)
    if (!validation.valid) {
      setError(validation.errors.join(' '))
      setStatus(null)
      return
    }
    const result = onApply(next)
    if (!result.saved) {
      setError(result.errors.join(' '))
      setStatus(null)
      return
    }
    setDraft(copyTuningSettings(next))
    setError(null)
    setStatus('Saved and queued for an explicit disarmed reset/reconfiguration.')
  }

  const reset = (): void => {
    apply(createDefaultTuningSettings())
  }

  const updateNumber = (update: (value: TuningSettings) => TuningSettings, event: ChangeEvent<HTMLInputElement>): void => {
    const value = finiteInput(event)
    if (value === null) return
    setDraft(update)
    setError(null)
    setStatus(null)
  }

  const selectedCurve = actualRateCurve(draft, curveAxis)
  const maximumCurveRate = Math.max(
    1,
    ...selectedCurve.map((point) => Math.abs(point.y)),
  )
  const curvePath = selectedCurve.map((point, index) => {
    const x = (index / Math.max(1, selectedCurve.length - 1)) * 200
    const y = 90 - (point.y / maximumCurveRate) * 82
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')

  const motor = draft.drone.motors[0]
  const linearDrag = draft.drone.linearDragCoefficientNPerMps
  const angularDrag = draft.drone.angularDragCoefficientNmPerRadPerSec

  return (
    <section className="tuning-section" id="tuning" aria-labelledby="tuning-title">
      <div className="tuning-heading">
        <div>
          <p className="panel-kicker">Phase 5 / Bounded tuning</p>
          <h2 id="tuning-title">Tune the response, then reset.</h2>
          <p>
            These settings are provisional trainer assumptions. Apply saves a versioned local profile and
            rebuilds the flight runtime disarmed; it never mutates an armed simulation in place.
          </p>
        </div>
        <div className="tuning-actions">
          <button className="lab-button lab-button-primary" type="button" onClick={() => apply(draft)} disabled={disabled}>Apply + reset</button>
          <button className="lab-button" type="button" onClick={reset} disabled={disabled}>Reset defaults</button>
        </div>
      </div>

      {(notice || error || status || disabled) && (
        <div className={`tuning-notice ${error ? 'tuning-notice-error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ?? status ?? (disabled ? 'Tuning changes are locked while a lesson is counting down or active.' : notice)}
        </div>
      )}

      <div className="tuning-layout">
        <section className="tuning-card" aria-labelledby="rates-tuning-title">
          <div className="tuning-card-heading">
            <div><p className="panel-kicker">01 / Actual Rates</p><h3 id="rates-tuning-title">Per-axis curve</h3></div>
            <label className="tuning-inline-label" htmlFor="curve-axis">Graph
              <select id="curve-axis" value={curveAxis} onChange={(event) => setCurveAxis(event.target.value as RateAxis)}>
                {RATE_AXES.map((axis) => <option key={axis} value={axis}>{axisLabel(axis)}</option>)}
              </select>
            </label>
          </div>
          <div className="rates-grid">
            <div className="rates-grid-head"><span>Axis</span><span>Center °/s</span><span>Max °/s</span><span>Expo</span></div>
            {RATE_AXES.map((axis) => {
              const config = draft.controller.rates.axes[axis]
              return (
                <div className="rates-grid-row" key={axis}>
                  <strong>{axisLabel(axis)}</strong>
                  <NumberField
                    label={`${axisLabel(axis)} center rate`}
                    value={config.centerRateDegPerSec}
                    min={0}
                    max={2_000}
                    step={1}
                    onChange={(event) => updateNumber((current) => updateRateAxis(current, axis, { centerRateDegPerSec: finiteInput(event) ?? config.centerRateDegPerSec }), event)}
                  />
                  <NumberField
                    label={`${axisLabel(axis)} maximum rate`}
                    value={config.maxRateDegPerSec}
                    min={0}
                    max={2_000}
                    step={1}
                    onChange={(event) => updateNumber((current) => updateRateAxis(current, axis, { maxRateDegPerSec: finiteInput(event) ?? config.maxRateDegPerSec }), event)}
                  />
                  <NumberField
                    label={`${axisLabel(axis)} expo`}
                    value={config.expo}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(event) => updateNumber((current) => updateRateAxis(current, axis, { expo: finiteInput(event) ?? config.expo }), event)}
                  />
                </div>
              )
            })}
          </div>
          <CurveGraph path={curvePath} maximum={maximumCurveRate} axis={curveAxis} />
        </section>

        <section className="tuning-card" aria-labelledby="airframe-tuning-title">
          <div className="tuning-card-heading">
            <div><p className="panel-kicker">02 / Simplified airframe</p><h3 id="airframe-tuning-title">Mass, motors, drag</h3></div>
          </div>
          <div className="tuning-field-grid">
            <NumberField label="Mass kg" value={draft.drone.massKg} min={TUNING_LIMITS.massKg.min} max={TUNING_LIMITS.massKg.max} step={0.01} onChange={(event) => updateNumber((current) => updateDroneTuning(current, { massKg: finiteInput(event) ?? current.drone.massKg }), event)} />
            <NumberField label="Max motor thrust N" value={motor.maxThrustN} min={TUNING_LIMITS.maxMotorThrustN.min} max={TUNING_LIMITS.maxMotorThrustN.max} step={0.1} onChange={(event) => updateNumber((current) => updateDroneTuning(current, { maxMotorThrustN: finiteInput(event) ?? current.drone.motors[0].maxThrustN }), event)} />
            <NumberField label="Motor response s" value={motor.responseTimeConstantSeconds} min={TUNING_LIMITS.motorResponseTimeConstantSeconds.min} max={TUNING_LIMITS.motorResponseTimeConstantSeconds.max} step={0.001} onChange={(event) => updateNumber((current) => updateDroneTuning(current, { motorResponseTimeConstantSeconds: finiteInput(event) ?? current.drone.motors[0].responseTimeConstantSeconds }), event)} />
          </div>
          <VectorFields
            label="Linear drag N/(m/s)"
            values={linearDrag}
            min={TUNING_LIMITS.linearDragCoefficientNPerMps.min}
            max={TUNING_LIMITS.linearDragCoefficientNPerMps.max}
            step={0.01}
            onChange={(axis, value) => setDraft((current) => updateDroneTuning(current, { linearDragCoefficientNPerMps: { [axis]: value } }))}
          />
          <VectorFields
            label="Angular drag Nm/(rad/s)"
            values={angularDrag}
            min={TUNING_LIMITS.angularDragCoefficientNmPerRadPerSec.min}
            max={TUNING_LIMITS.angularDragCoefficientNmPerRadPerSec.max}
            step={0.0001}
            onChange={(axis, value) => setDraft((current) => updateDroneTuning(current, { angularDragCoefficientNmPerRadPerSec: { [axis]: value } }))}
          />
        </section>

        <section className="tuning-card" aria-labelledby="pid-tuning-title">
          <div className="tuning-card-heading">
            <div><p className="panel-kicker">03 / Rate PID</p><h3 id="pid-tuning-title">SI gains</h3></div>
            <span className="tuning-unit-note">N m / SI rate</span>
          </div>
          <div className="pid-grid">
            <div className="pid-grid-head"><span>Axis</span><span>kp</span><span>ki</span><span>kd</span></div>
            {RATE_AXES.map((axis) => {
              const pid = draft.controller.pid[axis]
              return (
                <div className="pid-grid-row" key={axis}>
                  <strong>{axisLabel(axis)}</strong>
                  <NumberField label={`${axisLabel(axis)} kp`} value={pid.kp} min={TUNING_LIMITS.pidKp.min} max={TUNING_LIMITS.pidKp.max} step={0.001} onChange={(event) => updateNumber((current) => updatePidAxis(current, axis, { kp: finiteInput(event) ?? pid.kp }), event)} />
                  <NumberField label={`${axisLabel(axis)} ki`} value={pid.ki} min={TUNING_LIMITS.pidKi.min} max={TUNING_LIMITS.pidKi.max} step={0.001} onChange={(event) => updateNumber((current) => updatePidAxis(current, axis, { ki: finiteInput(event) ?? pid.ki }), event)} />
                  <NumberField label={`${axisLabel(axis)} kd`} value={pid.kd} min={TUNING_LIMITS.pidKd.min} max={TUNING_LIMITS.pidKd.max} step={0.0001} onChange={(event) => updateNumber((current) => updatePidAxis(current, axis, { kd: finiteInput(event) ?? pid.kd }), event)} />
                </div>
              )
            })}
          </div>
          <p className="tuning-footnote">Integral limits and torque output limits remain validator-backed defaults so this compact screen cannot remove the safety bounds.</p>
        </section>

        <section className="tuning-card" aria-labelledby="camera-tuning-title">
          <div className="tuning-card-heading">
            <div><p className="panel-kicker">04 / Presentation</p><h3 id="camera-tuning-title">FPV camera</h3></div>
          </div>
          <div className="tuning-field-grid">
            <label className="tuning-field">Mount angle
              <select value={draft.camera.fpvMountAngleDegrees} onChange={(event) => setDraft((current) => updateCameraTuning(current, { fpvMountAngleDegrees: Number(event.target.value) as CameraMountAngleDegrees }))}>
                {CAMERA_MOUNT_ANGLE_OPTIONS.map((angle) => <option key={angle} value={angle}>{angle}°</option>)}
              </select>
            </label>
            <NumberField label="FOV degrees" value={draft.camera.fpvFovDegrees} min={45} max={120} step={1} onChange={(event) => updateNumber((current) => updateCameraTuning(current, { fpvFovDegrees: finiteInput(event) ?? current.camera.fpvFovDegrees }), event)} />
          </div>
          <p className="tuning-footnote">Camera changes are presentation-only but are applied in the same explicit runtime boundary.</p>
        </section>
      </div>
      <p className="tuning-disclaimer">Provisional simplified dynamics for browser training only. Values are not measured hardware tuning and make no realism, flight-worthiness, or hardware compatibility claim.</p>
    </section>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="tuning-field">
      <span>{label}</span>
      <input aria-label={label} type="number" value={value} min={min} max={max} step={step} onChange={onChange} />
    </label>
  )
}

function VectorFields({
  label,
  values,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  values: { x: number; y: number; z: number }
  min: number
  max: number
  step: number
  onChange: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  return (
    <div className="tuning-vector-fields">
      <span className="tuning-vector-label">{label}</span>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <label className="tuning-field" key={axis}>
          <span>{axis}</span>
          <input aria-label={`${label} ${axis}`} type="number" value={values[axis]} min={min} max={max} step={step} onChange={(event) => { const value = finiteInput(event); if (value !== null) onChange(axis, value) }} />
        </label>
      ))}
    </div>
  )
}

function CurveGraph({ path, maximum, axis }: { path: string; maximum: number; axis: RateAxis }) {
  return (
    <figure className="rate-curve-figure">
      <svg className="rate-curve" viewBox="0 0 200 180" role="img" aria-label={`${axisLabel(axis)} Actual Rates curve graph`}>
        <line x1="0" y1="90" x2="200" y2="90" />
        <line x1="100" y1="0" x2="100" y2="180" />
        <path d={path} />
      </svg>
      <figcaption>{axisLabel(axis)} curve · ±{maximum.toFixed(0)} °/s at full stick</figcaption>
    </figure>
  )
}

