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
import { localizedSetupMessage } from '../setup/messages'

export interface TuningPanelProps {
  readonly settings: TuningSettings
  readonly notice?: string | null
  readonly disabled?: boolean
  readonly onApply: (settings: TuningSettings) => TuningPersistenceResult
}

function axisLabel(axis: RateAxis): string {
  return { roll: '橫滾', pitch: '俯仰', yaw: '偏航' }[axis]
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
      setError('課程倒數或練習進行中無法調整參數，請先重設或結束課程。')
      setStatus(null)
      return
    }
    const validation = validateTuningSettings(next)
    if (!validation.valid) {
      setError(validation.errors.map(localizedSetupMessage).join(' '))
      setStatus(null)
      return
    }
    const result = onApply(next)
    if (!result.saved) {
      setError(result.errors.map(localizedSetupMessage).join(' '))
      setStatus(null)
      return
    }
    setDraft(copyTuningSettings(next))
    setError(null)
    setStatus('設定已儲存，等待在上鎖狀態下重設飛行或重新套用。')
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
          <p className="panel-kicker">飛行參數調整</p>
          <h2 id="tuning-title">調整飛行手感，套用後重新開始。</h2>
          <p>
            這些參數是供網頁練習使用的原型設定。套用後會將設定及版本儲存在本機，
            並在上鎖狀態下重設飛行；已解鎖飛行中的參數不會被直接更改。
          </p>
        </div>
        <div className="tuning-actions">
          <button className="lab-button lab-button-primary" type="button" onClick={() => apply(draft)} disabled={disabled}>套用並重設飛行</button>
          <button className="lab-button" type="button" onClick={reset} disabled={disabled}>恢復預設設定</button>
        </div>
      </div>

      {(notice || error || status || disabled) && (
        <div className={`tuning-notice ${error ? 'tuning-notice-error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ?? status ?? (disabled ? '課程倒數或練習進行中，參數調整已鎖定。' : notice ? localizedSetupMessage(notice) : notice)}
        </div>
      )}

      <div className="tuning-layout">
        <section className="tuning-card" aria-labelledby="rates-tuning-title">
          <div className="tuning-card-heading">
            <div><p className="panel-kicker">01 / 角速度曲線（Actual Rates）</p><h3 id="rates-tuning-title">各軸反應曲線</h3></div>
            <label className="tuning-inline-label" htmlFor="curve-axis">曲線軸向
              <select id="curve-axis" value={curveAxis} onChange={(event) => setCurveAxis(event.target.value as RateAxis)}>
                {RATE_AXES.map((axis) => <option key={axis} value={axis}>{axisLabel(axis)}</option>)}
              </select>
            </label>
          </div>
          <div className="rates-grid">
            <div className="rates-grid-head"><span>軸向</span><span>中心靈敏度 °/s</span><span>最大角速度 °/s</span><span>曲線彎曲程度（Expo）</span></div>
            {RATE_AXES.map((axis) => {
              const config = draft.controller.rates.axes[axis]
              return (
                <div className="rates-grid-row" key={axis}>
                  <strong>{axisLabel(axis)}</strong>
                  <NumberField
                    label={`${axisLabel(axis)} 中心靈敏度`}
                    value={config.centerRateDegPerSec}
                    min={0}
                    max={2_000}
                    step={1}
                    onChange={(event) => updateNumber((current) => updateRateAxis(current, axis, { centerRateDegPerSec: finiteInput(event) ?? config.centerRateDegPerSec }), event)}
                  />
                  <NumberField
                    label={`${axisLabel(axis)} 最大角速度`}
                    value={config.maxRateDegPerSec}
                    min={0}
                    max={2_000}
                    step={1}
                    onChange={(event) => updateNumber((current) => updateRateAxis(current, axis, { maxRateDegPerSec: finiteInput(event) ?? config.maxRateDegPerSec }), event)}
                  />
                  <NumberField
                    label={`${axisLabel(axis)} 曲線彎曲程度（Expo）`}
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
            <div><p className="panel-kicker">02 / 簡化機體模型</p><h3 id="airframe-tuning-title">質量、馬達與阻力</h3></div>
          </div>
          <div className="tuning-field-grid">
            <NumberField label="機體質量 kg" value={draft.drone.massKg} min={TUNING_LIMITS.massKg.min} max={TUNING_LIMITS.massKg.max} step={0.01} onChange={(event) => updateNumber((current) => updateDroneTuning(current, { massKg: finiteInput(event) ?? current.drone.massKg }), event)} />
            <NumberField label="單顆馬達最大推力 N" value={motor.maxThrustN} min={TUNING_LIMITS.maxMotorThrustN.min} max={TUNING_LIMITS.maxMotorThrustN.max} step={0.1} onChange={(event) => updateNumber((current) => updateDroneTuning(current, { maxMotorThrustN: finiteInput(event) ?? current.drone.motors[0].maxThrustN }), event)} />
            <NumberField label="馬達反應時間常數 s" value={motor.responseTimeConstantSeconds} min={TUNING_LIMITS.motorResponseTimeConstantSeconds.min} max={TUNING_LIMITS.motorResponseTimeConstantSeconds.max} step={0.001} onChange={(event) => updateNumber((current) => updateDroneTuning(current, { motorResponseTimeConstantSeconds: finiteInput(event) ?? current.drone.motors[0].responseTimeConstantSeconds }), event)} />
          </div>
          <VectorFields
            label="平移阻力係數 N/(m/s)"
            values={linearDrag}
            min={TUNING_LIMITS.linearDragCoefficientNPerMps.min}
            max={TUNING_LIMITS.linearDragCoefficientNPerMps.max}
            step={0.01}
            onChange={(axis, value) => setDraft((current) => updateDroneTuning(current, { linearDragCoefficientNPerMps: { [axis]: value } }))}
          />
          <VectorFields
            label="旋轉阻力係數 N·m/(rad/s)"
            values={angularDrag}
            min={TUNING_LIMITS.angularDragCoefficientNmPerRadPerSec.min}
            max={TUNING_LIMITS.angularDragCoefficientNmPerRadPerSec.max}
            step={0.0001}
            onChange={(axis, value) => setDraft((current) => updateDroneTuning(current, { angularDragCoefficientNmPerRadPerSec: { [axis]: value } }))}
          />
        </section>

        <section className="tuning-card" aria-labelledby="pid-tuning-title">
          <div className="tuning-card-heading">
            <div><p className="panel-kicker">03 / 角速度 PID</p><h3 id="pid-tuning-title">PID 增益（SI 單位）</h3></div>
            <span className="tuning-unit-note">採用國際單位制（SI）</span>
          </div>
          <div className="pid-grid">
            <div className="pid-grid-head"><span>軸向</span><span>比例 P</span><span>積分 I</span><span>微分 D</span></div>
            {RATE_AXES.map((axis) => {
              const pid = draft.controller.pid[axis]
              return (
                <div className="pid-grid-row" key={axis}>
                  <strong>{axisLabel(axis)}</strong>
                  <NumberField label={`${axisLabel(axis)} 比例增益 P`} value={pid.kp} min={TUNING_LIMITS.pidKp.min} max={TUNING_LIMITS.pidKp.max} step={0.001} onChange={(event) => updateNumber((current) => updatePidAxis(current, axis, { kp: finiteInput(event) ?? pid.kp }), event)} />
                  <NumberField label={`${axisLabel(axis)} 積分增益 I`} value={pid.ki} min={TUNING_LIMITS.pidKi.min} max={TUNING_LIMITS.pidKi.max} step={0.001} onChange={(event) => updateNumber((current) => updatePidAxis(current, axis, { ki: finiteInput(event) ?? pid.ki }), event)} />
                  <NumberField label={`${axisLabel(axis)} 微分增益 D`} value={pid.kd} min={TUNING_LIMITS.pidKd.min} max={TUNING_LIMITS.pidKd.max} step={0.0001} onChange={(event) => updateNumber((current) => updatePidAxis(current, axis, { kd: finiteInput(event) ?? pid.kd }), event)} />
                </div>
              )
            })}
          </div>
          <p className="tuning-footnote">積分項與輸出力矩的上限保留原有驗證限制，無法在這個介面中取消。</p>
        </section>

        <section className="tuning-card" aria-labelledby="camera-tuning-title">
          <div className="tuning-card-heading">
            <div><p className="panel-kicker">04 / 畫面設定</p><h3 id="camera-tuning-title">FPV 鏡頭</h3></div>
          </div>
          <div className="tuning-field-grid">
            <label className="tuning-field">鏡頭安裝仰角
              <select value={draft.camera.fpvMountAngleDegrees} onChange={(event) => setDraft((current) => updateCameraTuning(current, { fpvMountAngleDegrees: Number(event.target.value) as CameraMountAngleDegrees }))}>
                {CAMERA_MOUNT_ANGLE_OPTIONS.map((angle) => <option key={angle} value={angle}>{angle}°</option>)}
              </select>
            </label>
            <NumberField label="視野角度 FOV（度）" value={draft.camera.fpvFovDegrees} min={45} max={120} step={1} onChange={(event) => updateNumber((current) => updateCameraTuning(current, { fpvFovDegrees: finiteInput(event) ?? current.camera.fpvFovDegrees }), event)} />
          </div>
          <p className="tuning-footnote">鏡頭設定只影響畫面，仍需經過相同的上鎖與重設流程才會套用。</p>
        </section>
      </div>
      <p className="tuning-disclaimer">本專案採用簡化的原型物理模型，僅供網頁飛行練習。這些數值不是實測硬體調參，也不代表已驗證真實飛行手感、適航性或設備相容性。</p>
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
      <svg className="rate-curve" viewBox="0 0 200 180" role="img" aria-label={`${axisLabel(axis)}角速度曲線（Actual Rates）圖`}>
        <line x1="0" y1="90" x2="200" y2="90" />
        <line x1="100" y1="0" x2="100" y2="180" />
        <path d={path} />
      </svg>
      <figcaption>{axisLabel(axis)}角速度曲線 · 滿桿時 ±{maximum.toFixed(0)} °/s</figcaption>
    </figure>
  )
}

