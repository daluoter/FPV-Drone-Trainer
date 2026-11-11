import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { localizedSetupMessage } from '../setup/messages'

import {
  CONTROL_CHANNELS,
  DEFAULT_STICK_DEADBAND,
  calculateSampleStatistics,
  ControllerProfileStore,
  createBrowserGamepadPoller,
  createControllerProfile,
  evaluateFlightEligibility,
  evaluateNeutralStability,
  identifyAxisByMovement,
  isCenterStable,
  markDirectionsVerified,
  markNeutralVerified,
  ControllerSignalHistory,
  processControllerSnapshot,
  summarizeEndpointRange,
  updateChannelCalibration,
  validateControllerProfile,
  type AxisMovementResult,
  type CalibrationSampleSummary,
  type ControlChannel,
  type ControllerDevice,
  type ControllerProfile,
  type NeutralStabilityReport,
  type PollerState,
  type ProcessedControllerState,
  type RawGamepadSnapshot,
  type GamepadPoller,
} from './index'

const MOVEMENT_CHANNELS: readonly ControlChannel[] = ['roll', 'pitch', 'yaw', 'throttle']
const CAPTURE_DURATION_MS = 2_500
const NEUTRAL_CAPTURE_DURATION_MS = 3_000

type WizardStep = 'select' | 'center' | ControlChannel | 'direction' | 'neutral' | 'ready'

type CalibrationDraft = Readonly<{
  axis: number
  center: number
  minimum: number
  maximum: number
  invert: boolean
  deadband: number
}>

/** The explicit, low-frequency handoff from Controller Lab to Free Flight. */
export interface ControllerLabFlightHandoff {
  readonly device: ControllerDevice | null
  readonly profile: ControllerProfile | null
  readonly connectionSession: string | null
}

export interface ControllerLabProps {
  /** An application-owned poller lets the runtime own the single fresh sample loop. */
  readonly poller?: GamepadPoller
  readonly onFlightHandoff?: (handoff: ControllerLabFlightHandoff) => void
}

function channelLabel(channel: ControlChannel): string {
  return { roll: '橫滾', pitch: '俯仰', yaw: '偏航', throttle: '油門' }[channel]
}

function formatValue(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '無效'
}

function stepTitle(step: WizardStep): string {
  if (step === 'select') return '選擇控制器'
  if (step === 'center') return '搖桿回中'
  if (step === 'direction') return '確認操作方向'
  if (step === 'neutral') return '回中穩定性'
  if (step === 'ready') return '校正設定完成'
  return `校正${channelLabel(step)}`
}

function stepLabel(step: WizardStep): string {
  if (step === 'select') return '選擇設備'
  if (step === 'center') return '搖桿回中'
  if (step === 'direction') return '確認方向'
  if (step === 'neutral') return '回中測試'
  if (step === 'ready') return '完成校正'
  return channelLabel(step)
}

function nextMovementStep(channel: ControlChannel): WizardStep {
  const index = MOVEMENT_CHANNELS.indexOf(channel)
  return MOVEMENT_CHANNELS[index + 1] ?? 'direction'
}

function copySnapshot(snapshot: RawGamepadSnapshot): RawGamepadSnapshot {
  return {
    ...snapshot,
    axes: [...snapshot.axes],
    buttons: snapshot.buttons.map((button) => ({ ...button })),
    invalidAxisIndices: [...snapshot.invalidAxisIndices],
    invalidButtonIndices: [...snapshot.invalidButtonIndices],
  }
}

function selectedDeviceKey(device: ControllerDevice | null): string | null {
  return device
    ? `${device.id}:${device.index}:${device.mapping}:${device.axisCount}:${device.buttonCount}:${device.connectionSession ?? 'unknown'}`
    : null
}

function initialStep(profile: ControllerProfile | null, connectionSession: string | null): WizardStep {
  if (!profile) return 'center'
  if (
    profile.neutralVerifiedAt &&
    profile.neutralStability?.stable &&
    profile.neutralVerificationSession &&
    profile.neutralVerificationSession === connectionSession
  ) return 'ready'
  if (profile.directionVerifiedAt) return 'neutral'
  return 'direction'
}

export default function ControllerLab({ poller: providedPoller, onFlightHandoff }: ControllerLabProps = {}) {
  const poller = useMemo(() => providedPoller ?? createBrowserGamepadPoller(), [providedPoller])
  const ownsPoller = providedPoller === undefined
  const profileStore = useMemo(() => new ControllerProfileStore(), [])
  const [pollState, setPollState] = useState<PollerState>(() => poller.getState())
  const [profile, setProfile] = useState<ControllerProfile | null>(null)
  const [wizardStep, setWizardStep] = useState<WizardStep>('select')
  const [centerSummary, setCenterSummary] = useState<CalibrationSampleSummary | null>(null)
  const [assignments, setAssignments] = useState<Partial<Record<ControlChannel, CalibrationDraft>>>({})
  const [neutralReport, setNeutralReport] = useState<NeutralStabilityReport | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [captureLabel, setCaptureLabel] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [processed, setProcessed] = useState<ProcessedControllerState | null>(null)
  const latestPollState = useRef(poller.getState())
  const latestProcessed = useRef<ProcessedControllerState | null>(null)
  const activeProfile = useRef<ControllerProfile | null>(null)
  const signalHistory = useRef(new ControllerSignalHistory())
  const previousDeviceKey = useRef<string | null>(null)

  useEffect(() => {
    let updateTimer: number | null = null
    const unsubscribe = poller.subscribe((next) => {
      latestPollState.current = next
      const snapshot = next.snapshots.find((candidate) => candidate.index === next.selectedDeviceIndex) ?? null
      if (activeProfile.current && snapshot) {
        latestProcessed.current = signalHistory.current.process(snapshot, activeProfile.current)
      } else {
        signalHistory.current.reset()
        latestProcessed.current = null
      }
      if (updateTimer !== null) return
      updateTimer = window.setTimeout(() => {
        updateTimer = null
        setPollState(latestPollState.current)
        setProcessed(latestProcessed.current)
      }, 100)
    })
    if (ownsPoller) poller.start()
    return () => {
      unsubscribe()
      if (ownsPoller) poller.stop()
      if (updateTimer !== null) window.clearTimeout(updateTimer)
    }
  }, [ownsPoller, poller])

  const selectedDevice = pollState.devices.find((device) => device.index === pollState.selectedDeviceIndex) ?? null
  const selectedSnapshot = pollState.snapshots.find((snapshot) => snapshot.index === pollState.selectedDeviceIndex) ?? null
  const deviceKey = selectedDeviceKey(selectedDevice)
  const connectionSession = selectedDevice?.connectionSession ?? deviceKey

  useEffect(() => {
    if (deviceKey === previousDeviceKey.current) return
    previousDeviceKey.current = deviceKey
    signalHistory.current.reset()
    latestProcessed.current = null
    activeProfile.current = null
    setProcessed(null)
    setCaptureError(null)
    setNeutralReport(null)
    setCenterSummary(null)
    setAssignments({})
    if (!selectedDevice) {
      setProfile(null)
      setWizardStep('select')
      return
    }
    const loaded = profileStore.loadCompatible(selectedDevice)
    setProfile(loaded)
    setWizardStep(initialStep(loaded, selectedDevice.connectionSession ?? deviceKey))
  }, [deviceKey, profileStore])

  useEffect(() => {
    onFlightHandoff?.({
      device: selectedDevice,
      profile,
      connectionSession: selectedDevice?.connectionSession ?? deviceKey,
    })
  }, [deviceKey, onFlightHandoff, profile, selectedDevice])

  useEffect(() => {
    activeProfile.current = profile
    signalHistory.current.reset()
    latestProcessed.current = null
    if (profile) {
      const snapshot = latestPollState.current.snapshots.find(
        (candidate) => candidate.index === latestPollState.current.selectedDeviceIndex,
      ) ?? null
      if (snapshot) latestProcessed.current = signalHistory.current.process(snapshot, profile)
    }
    setProcessed(latestProcessed.current)
  }, [profile])

  useEffect(() => {
    if (profile) profileStore.save(profile)
  }, [profile, profileStore])

  const eligibility = useMemo(
    () => evaluateFlightEligibility(selectedDevice, profile, processed, { connectionSession }),
    [connectionSession, processed, profile, selectedDevice],
  )

  const selectDevice = (index: number) => {
    if (poller.selectDevice(index)) setPollState(poller.getState())
  }

  const captureSamples = useCallback(async (durationMs: number): Promise<{
    samples: RawGamepadSnapshot[]
    elapsedMs: number
    completed: boolean
  }> => {
    const selectedIndex = poller.getState().selectedDeviceIndex
    const initialSnapshot = poller.getSelectedSnapshot()
    if (selectedIndex === null || !initialSnapshot || initialSnapshot.index !== selectedIndex) {
      return { samples: [], elapsedMs: 0, completed: false }
    }
    const connectionSession = initialSnapshot.connectionSession ?? null

    setCapturing(true)
    setCaptureError(null)
    setCaptureLabel(`正在收集控制器訊號，持續 ${Math.round(durationMs / 100) / 10} 秒…`)
    const samples: RawGamepadSnapshot[] = []
    const startedAt = performance.now()
    let sampleTimer: number | null = null
    let completionTimer: number | null = null
    let resolveCapture: ((completed: boolean) => void) | null = null
    const captureResult = new Promise<boolean>((resolve) => {
      resolveCapture = resolve
    })
    const finish = (completed: boolean) => {
      if (sampleTimer !== null) window.clearInterval(sampleTimer)
      if (completionTimer !== null) window.clearTimeout(completionTimer)
      sampleTimer = null
      completionTimer = null
      setCapturing(false)
      setCaptureLabel(null)
      resolveCapture?.(completed)
      resolveCapture = null
    }
    const sample = () => {
      const snapshot = poller.getSelectedSnapshot()
      if (
        !snapshot ||
        snapshot.index !== selectedIndex ||
        !snapshot.connected ||
        (connectionSession !== null && snapshot.connectionSession !== connectionSession)
      ) {
        finish(false)
        return
      }
      samples.push(copySnapshot(snapshot))
    }

    sample()
    if (resolveCapture === null) {
      return { samples, elapsedMs: performance.now() - startedAt, completed: false }
    }
    sampleTimer = window.setInterval(sample, 50)
    completionTimer = window.setTimeout(() => finish(true), durationMs)
    const completed = await captureResult
    return { samples, elapsedMs: performance.now() - startedAt, completed }
  }, [poller])

  const runCenterCapture = async () => {
    if (!selectedDevice) return
    const result = await captureSamples(CAPTURE_DURATION_MS)
    if (!result.completed) {
      setCaptureError('收集訊號時控制器已斷線，請重新連接並重做此步驟。')
      return
    }
    const summary = calculateSampleSummary(result.samples)
    if (!summary.valid || summary.sampleCount < 30) {
      setCaptureError(summary.reason ?? '回中訊號樣本不足，請重新收集。')
      return
    }
    setCenterSummary(summary)
    setAssignments({})
    setWizardStep('roll')
  }

  const runMovementCapture = async (channel: ControlChannel) => {
    if (!selectedDevice || !centerSummary?.valid) return
    const result = await captureSamples(CAPTURE_DURATION_MS)
    if (!result.completed) {
      setCaptureError('收集訊號時控制器已斷線，請重新連接並重做此步驟。')
      return
    }
    const movement: AxisMovementResult = identifyAxisByMovement(
      centerSummary.axes.map((axis) => axis.center),
      result.samples.map((sample) => sample.axes),
    )
    if (movement.status !== 'identified' || movement.axis === null) {
      setCaptureError(movement.reason)
      return
    }
    const axis = movement.axis
    if (Object.values(assignments).some((assignment) => assignment?.axis === axis)) {
      setCaptureError(`輸入軸 ${axis} 已分配給其他通道。請只移動${channelLabel(channel)}，再試一次。`)
      return
    }
    const centerStats = centerSummary.axes[axis]
    if (!centerStats || !isCenterStable(centerStats)) {
      setCaptureError(`${channelLabel(channel)}回中訊號不穩定，請放開搖桿並重新校正。`)
      return
    }
    const endpoint = summarizeEndpointRange(
      result.samples.map((sample) => sample.axes[axis] ?? Number.NaN),
      channel === 'throttle' ? 'single-ended' : 'centered',
      centerStats.center,
    )
    if (!endpoint.valid) {
      setCaptureError(endpoint.reason ?? '行程端點校正無效，請重新校正。')
      return
    }

    const draft: CalibrationDraft = {
      axis,
      center: endpoint.center,
      minimum: endpoint.minimum,
      maximum: endpoint.maximum,
      invert: false,
      deadband: channel === 'throttle' ? 0 : DEFAULT_STICK_DEADBAND,
    }
    const nextAssignments = { ...assignments, [channel]: draft }
    setAssignments(nextAssignments)
    setCaptureError(null)
    const complete = MOVEMENT_CHANNELS.every((name) => nextAssignments[name] !== undefined)
    if (!complete) {
      setWizardStep(nextMovementStep(channel))
      return
    }

    const newProfile = createControllerProfile(selectedDevice, {
      roll: nextAssignments.roll as CalibrationDraft,
      pitch: nextAssignments.pitch as CalibrationDraft,
      yaw: nextAssignments.yaw as CalibrationDraft,
      throttle: nextAssignments.throttle as CalibrationDraft,
    })
    const validation = validateControllerProfile(newProfile, selectedDevice)
    if (!validation.valid) {
      setCaptureError(validation.errors.join(' '))
      return
    }
    setProfile(newProfile)
    setWizardStep('direction')
  }

  const resetCalibration = () => {
    if (selectedDevice) profileStore.reset(selectedDevice.id)
    setProfile(null)
    setCenterSummary(null)
    setAssignments({})
    setNeutralReport(null)
    setCaptureError(null)
    setWizardStep(selectedDevice ? 'center' : 'select')
  }

  const updateProfileChannel = (channel: ControlChannel, patch: { invert?: boolean; deadband?: number }) => {
    setProfile((current) => current ? updateChannelCalibration(current, channel, patch) : current)
    setNeutralReport(null)
    setWizardStep('direction')
  }

  const verifyDirections = () => {
    setProfile((current) => current ? markDirectionsVerified(current) : current)
    setNeutralReport(null)
    setCaptureError(null)
    setWizardStep('neutral')
  }

  const runNeutralCapture = async () => {
    if (!profile || !selectedDevice) return
    const result = await captureSamples(NEUTRAL_CAPTURE_DURATION_MS)
    if (!result.completed) {
      setCaptureError('測試時控制器已斷線，回中穩定性尚未通過。')
      return
    }

    const captureHistory = new ControllerSignalHistory()
    const processedStates = result.samples.map((sample) => captureHistory.process(sample, profile))
    if (processedStates.some((state) => !state.valid)) {
      setNeutralReport(null)
      setProfile((current) => current ? {
        ...current,
        neutralVerifiedAt: null,
        neutralVerificationSession: null,
      } : current)
      setCaptureError('測試時收到無效的輸入軸或按鈕訊號，回中穩定性尚未通過。')
      setWizardStep('neutral')
      return
    }

    const report = evaluateNeutralStability(
      processedStates.map((state) => state.channels),
      result.elapsedMs,
    )
    setNeutralReport(report)
    if (!report.stable) {
      setProfile((current) => current ? {
        ...current,
        neutralVerifiedAt: null,
        neutralStability: report,
        neutralVerificationSession: null,
      } : current)
      setCaptureError(report.reason ?? '回中穩定性未通過，請重新校正，再放開搖桿重測。')
      setWizardStep('neutral')
      return
    }

    const session = selectedDevice.connectionSession ?? deviceKey
    const verified = session
      ? markNeutralVerified(profile, report, new Date().toISOString(), session)
      : null
    if (!verified?.neutralVerificationSession) {
      setCaptureError('無法確認目前的控制器連線，請重新執行回中穩定性測試。')
      setWizardStep('neutral')
      return
    }
    setProfile(verified)
    setCaptureError(null)
    setWizardStep('ready')
  }

  return (
    <section className="controller-lab-section" id="controller-lab" aria-labelledby="controller-lab-title">
      <div className="controller-lab-heading">
        <div>
          <p className="panel-kicker">設備與校正</p>
          <h2 id="controller-lab-title">先校正遙控器，再開始飛行。</h2>
          <p>
            遙控器訊號必須先經校正，才能用來操控飛行。下方可查看各階段數值，
            確認搖桿回中偏移與飛機反應的關係。
          </p>
        </div>
        <div className={`lab-support-badge ${pollState.supported ? 'lab-support-ready' : 'lab-support-missing'}`}>
          <span aria-hidden="true" />
          {pollState.supported ? '瀏覽器支援控制器讀取' : '瀏覽器不支援控制器讀取'}
        </div>
      </div>

      <div className="controller-lab-grid">
        <div className="controller-lab-main">
          <section className="lab-card lab-device-card" aria-labelledby="device-title">
            <div className="lab-card-heading">
              <div>
                <p className="panel-kicker">01 / 連接設備</p>
                <h3 id="device-title">選擇控制器</h3>
              </div>
              <span className="lab-live-indicator"><span aria-hidden="true" /> 即時讀取控制器訊號</span>
            </div>
            {!pollState.supported ? (
              <p className="lab-empty-state">
                此瀏覽器無法讀取控制器。請使用桌面版 Chrome 或 Edge，透過 HTTPS 網址或
                本機網頁開啟，再重新連接遙控器。
              </p>
            ) : pollState.devices.length === 0 ? (
              <p className="lab-empty-state">尚未偵測到控制器，請連接遙控器並放開搖桿。</p>
            ) : (
              <div className="device-list">
                {pollState.devices.map((device) => (
                  <div className={`device-row ${device.index === pollState.selectedDeviceIndex ? 'device-selected' : ''}`} key={`${device.id}:${device.index}`}>
                    <div className="device-identity">
                      <span className={`device-dot ${device.connected ? 'device-connected' : ''}`} aria-hidden="true" />
                      <div>
                        <strong>{device.id || '未命名控制器'}</strong>
                        <span>編號 {device.index} · {device.mapping || '未提供'} 映射</span>
                      </div>
                    </div>
                    <div className="device-specs">
                      <span>{device.axisCount} 個輸入軸</span>
                      <span>{device.buttonCount} 個按鈕</span>
                    </div>
                    <button
                      className="lab-button lab-button-small"
                      type="button"
                      disabled={!device.connected}
                      aria-pressed={device.index === pollState.selectedDeviceIndex}
                      onClick={() => selectDevice(device.index)}
                    >
                      {device.index === pollState.selectedDeviceIndex ? '已選擇' : device.connected ? '選擇' : '已斷線'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="lab-card" aria-labelledby="wizard-title">
            <div className="lab-card-heading">
              <div>
                <p className="panel-kicker">02 / 逐步校正</p>
                <h3 id="wizard-title">{stepTitle(wizardStep)}</h3>
              </div>
              <span className="lab-step-count">{wizardStep === 'ready' ? '已完成' : wizardStep === 'select' ? '等待選擇' : '請操作搖桿'}</span>
            </div>
            <div className="wizard-steps" aria-label="校正進度">
              {(['select', 'center', 'roll', 'pitch', 'yaw', 'throttle', 'direction', 'neutral'] as const).map((step, index) => (
                <span className={`wizard-step ${wizardStep === step ? 'wizard-step-current' : ''} ${stepCompleted(step, wizardStep) ? 'wizard-step-complete' : ''}`} key={step}>
                  <span>{String(index + 1).padStart(2, '0')}</span>{stepLabel(step)}
                </span>
              ))}
            </div>

            {!selectedDevice && <p className="lab-instruction">請先選擇已連接的控制器。校正完成前，控制器訊號不會用來操控飛行。</p>}
            {selectedDevice && wizardStep === 'center' && (
              <div className="wizard-instruction">
                <p>放開橫滾、俯仰與偏航搖桿，約 2.5 秒內不要碰觸遙控器。油門訊號也會記錄，但不需要回中。</p>
                <button className="lab-button lab-button-primary" type="button" disabled={capturing} onClick={() => void runCenterCapture()}>
                  {capturing ? '正在收集…' : '收集回中訊號'}
                </button>
              </div>
            )}
            {selectedDevice && MOVEMENT_CHANNELS.includes(wizardStep as ControlChannel) && (
              <div className="wizard-instruction">
                <p>
                  只移動<strong>{channelLabel(wizardStep as ControlChannel)}</strong>，反覆推到行程兩端數次，其餘控制保持不動。系統會依實際移動辨認輸入軸與行程端點。
                </p>
                <button className="lab-button lab-button-primary" type="button" disabled={capturing || !centerSummary} onClick={() => void runMovementCapture(wizardStep as ControlChannel)}>
                  {capturing ? '正在收集…' : `收集${channelLabel(wizardStep as ControlChannel)}行程`}
                </button>
              </div>
            )}
            {selectedDevice && wizardStep === 'direction' && profile && (
              <div className="wizard-instruction">
                <p>逐一移動實體搖桿，確認下方通道的輸出方向。若方向相反，請調整該通道的「反向」；修改後須重新確認方向及測試回中穩定性。</p>
                <button className="lab-button lab-button-primary" type="button" onClick={verifyDirections}>已確認所有操作方向</button>
              </div>
            )}
            {selectedDevice && wizardStep === 'neutral' && profile && (
              <div className="wizard-instruction">
                <p>請勿碰觸遙控器。處理後的橫滾、俯仰與偏航輸出須連續 3 秒保持在正規化數值 ±0.02 內。未通過時會指出不穩定的通道，並阻止解鎖；重新整理或重新連接後都須重測。</p>
                <button className="lab-button lab-button-primary" type="button" disabled={capturing} onClick={() => void runNeutralCapture()}>
                  {capturing ? '正在測試回中…' : '開始 3 秒回中測試'}
                </button>
              </div>
            )}
            {selectedDevice && wizardStep === 'ready' && (
              <div className="lab-success-message">
                <span aria-hidden="true">✓</span>
                目前連線的回中穩定性已通過，飛行解鎖時會再次檢查。重新連接後仍須重做定時測試。
              </div>
            )}
            {captureLabel && <p className="capture-status" role="status">{captureLabel}</p>}
            {captureError && <p className="lab-error" role="alert">{localizedSetupMessage(captureError)}</p>}
            {centerSummary && <CenterSummary summary={centerSummary} />}
          </section>

          <RawMonitor snapshot={selectedSnapshot} />
          <SignalPipeline snapshot={selectedSnapshot} profile={profile} processed={processed} />
        </div>

        <aside className="controller-lab-side">
          <section className={`lab-card lab-safety-card ${eligibility.eligible ? 'lab-safety-pass' : ''}`} aria-labelledby="safety-title">
            <div className="lab-card-heading">
              <div>
                <p className="panel-kicker">03 / 解鎖條件</p>
                <h3 id="safety-title">{eligibility.eligible ? '控制器檢查通過' : '尚未符合解鎖條件'}</h3>
              </div>
              <span className="safety-state">{eligibility.eligible ? '通過' : '未通過'}</span>
            </div>
            <p className="safety-description">
              飛行解鎖時會檢查以下條件。無效訊號必須先修正，不能靠放大搖桿死區略過。
            </p>
            <ul className="safety-reasons">
              {eligibility.eligible ? <li className="reason-pass">設備、通道映射、行程端點、方向與回中穩定性均已通過檢查。</li> : eligibility.reasons.map((reason) => <li key={reason}>{localizedSetupMessage(reason)}</li>)}
            </ul>
            <button className="lab-button lab-button-secondary" type="button" onClick={resetCalibration} disabled={!selectedDevice}>
              重新校正此控制器
            </button>
          </section>

          {profile && <DirectionPanel profile={profile} processed={processed} onUpdate={updateProfileChannel} />}
          {profile && <NeutralReport
            report={neutralReport ?? profile.neutralStability}
            fresh={Boolean(
              profile.neutralVerifiedAt &&
              profile.neutralVerificationSession &&
              connectionSession &&
              profile.neutralVerificationSession === connectionSession,
            )}
          />}

          <section className="lab-card profile-card" aria-labelledby="profile-title">
            <div className="lab-card-heading">
              <div>
                <p className="panel-kicker">04 / 本機校正設定</p>
                <h3 id="profile-title">保存與相容性</h3>
              </div>
              <span className="profile-version">v{profile?.schemaVersion ?? 1}</span>
            </div>
            <p>{profile ? `已為 ${profile.deviceId} 保存校正設定。只有設備識別、映射、輸入軸數與按鈕數相符時，才會載入。` : '四個通道都完成行程端點校正後，會建立校正設定。'}</p>
            {profile && <dl className="profile-details"><div><dt>校正時間</dt><dd>{profile.calibrationTimestamp}</dd></div><div><dt>輸入軸數</dt><dd>{profile.axisCount}</dd></div><div><dt>回中檢查</dt><dd>{profile.neutralVerifiedAt && profile.neutralVerificationSession === connectionSession ? '目前連線已通過' : '需要重新測試'}</dd></div></dl>}
          </section>
        </aside>
      </div>
    </section>
  )
}

function calculateSampleSummary(samples: readonly RawGamepadSnapshot[]): CalibrationSampleSummary {
  return calculateSampleStatistics(samples.map((sample) => sample.axes))
}

function stepCompleted(step: 'select' | 'center' | 'roll' | 'pitch' | 'yaw' | 'throttle' | 'direction' | 'neutral', current: WizardStep): boolean {
  const order = ['select', 'center', 'roll', 'pitch', 'yaw', 'throttle', 'direction', 'neutral', 'ready']
  return order.indexOf(step) < order.indexOf(current)
}

function CenterSummary({ summary }: { summary: CalibrationSampleSummary }) {
  return (
    <div className="calibration-summary">
      <div className="summary-heading"><strong>回中訊號統計</strong><span>{summary.sampleCount} 個樣本</span></div>
      <div className="summary-grid"><span>輸入軸</span><span>中心值</span><span title="最大值與最小值之差">峰對峰抖動</span><span>標準差</span>{summary.axes.map((axis, index) => <div className="summary-row" key={index}><strong>{index}</strong><span>{formatValue(axis.center)}</span><span>{formatValue(axis.jitter)}</span><span>{formatValue(axis.standardDeviation)}</span></div>)}</div>
    </div>
  )
}

function RawMonitor({ snapshot }: { snapshot: RawGamepadSnapshot | null }) {
  return (
    <section className="lab-card monitor-card" aria-labelledby="raw-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">05 / 原始訊號</p><h3 id="raw-title">查看輸入軸與按鈕</h3></div><span className="monitor-time">{snapshot ? `時間 ${formatValue(snapshot.timestamp, 0)}` : '尚無樣本'}</span></div>
      {!snapshot ? <p className="lab-empty-state">請選擇已連接的控制器，查看即時輸入軸與按鈕訊號。</p> : <>
        <div className="axis-monitor">{snapshot.axes.map((value, index) => <div className="axis-monitor-cell" key={index}><span>輸入軸 {index}</span><strong className={Number.isFinite(value) ? '' : 'invalid-value'}>{formatValue(value)}</strong><meter min={-1} max={1} value={Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0} aria-label={`輸入軸 ${index} 原始值`} /></div>)}</div>
        <div className="button-monitor"><span>按鈕</span>{snapshot.buttons.map((button, index) => <span className={button.pressed ? 'button-pressed' : ''} key={index}>{index}:{button.pressed ? '按下' : formatValue(button.value)}</span>)}</div>
      </>}
    </section>
  )
}

function SignalPipeline({ snapshot, profile, processed }: { snapshot: RawGamepadSnapshot | null; profile: ControllerProfile | null; processed: ReturnType<typeof processControllerSnapshot> | null }) {
  return (
    <section className="lab-card pipeline-monitor-card" aria-labelledby="pipeline-monitor-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">06 / 訊號處理流程</p><h3 id="pipeline-monitor-title">從原始訊號到最終輸出</h3></div><span className="monitor-time">{profile && snapshot ? '即時訊號' : '等待訊號'}</span></div>
      {!profile || !snapshot || !processed ? <p className="lab-empty-state">完成行程端點校正後，可查看各通道經校正、正規化、死區及濾波處理後的最終輸出。</p> : <div className="signal-table-wrap"><table className="signal-table"><thead><tr><th>通道</th><th>原始值</th><th>校正後</th><th>正規化</th><th>死區處理後</th><th>濾波後</th><th>最終輸出</th></tr></thead><tbody>{CONTROL_CHANNELS.map((channel) => { const values = processed.channels[channel]; return <tr key={channel}><th scope="row">{channelLabel(channel)}</th><td>{formatValue(values.raw)}</td><td>{formatValue(values.calibrated)}</td><td>{formatValue(values.normalized)}</td><td>{formatValue(values.deadband)}</td><td>{formatValue(values.filtered)}</td><td className={values.valid ? '' : 'invalid-value'}>{formatValue(values.final)}</td></tr> })}</tbody></table></div>}
    </section>
  )
}

function DirectionPanel({ profile, processed, onUpdate }: { profile: ControllerProfile; processed: ReturnType<typeof processControllerSnapshot> | null; onUpdate: (channel: ControlChannel, patch: { invert?: boolean; deadband?: number }) => void }) {
  return (
    <section className="lab-card direction-card" aria-labelledby="direction-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">07 / 方向與死區</p><h3 id="direction-title">校正後的控制通道</h3></div><span className="profile-version">{profile.directionVerifiedAt ? '已確認方向' : '待確認方向'}</span></div>
      <p>Mode 2 俯仰：右桿後拉，俯仰應為正值（抬頭）；前推應為負值（低頭）。若相反，調整俯仰的「反向」，再重新完成方向確認與回中測試。</p>
      <div className="direction-list">{CONTROL_CHANNELS.map((channel) => { const calibration = profile.channels[channel]; const value = processed?.channels[channel].final ?? Number.NaN; return <div className="direction-row" key={channel}><div><strong>{channelLabel(channel)}</strong><span>輸入軸 {calibration.axis} · {formatValue(value)}</span></div><label><input type="checkbox" checked={calibration.invert} onChange={(event) => onUpdate(channel, { invert: event.target.checked })} /> 反向</label>{channel !== 'throttle' && <label className="deadband-control">搖桿死區 <input type="number" min="0" max="0.2" step="0.005" value={calibration.deadband} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next) && next >= 0 && next <= 0.2) onUpdate(channel, { deadband: next }) }} /></label>}</div> })}</div>
    </section>
  )
}

function NeutralReport({ report, fresh }: { report: NeutralStabilityReport | null; fresh: boolean }) {
  const passingNow = Boolean(report?.stable && fresh)
  return (
    <section className="lab-card neutral-card" aria-labelledby="neutral-report-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">08 / 回中穩定性</p><h3 id="neutral-report-title">放開搖桿測試結果</h3></div><span className={`profile-version ${passingNow ? 'report-pass' : ''}`}>{!report ? '尚未測試' : passingNow ? '通過' : report.stable ? '須重測' : '未通過'}</span></div>
      {!report ? <p>確認方向後，請執行定時回中測試。重新整理或連接後會保留校正設定，但須再次放開搖桿測試。</p> : <><div className="neutral-metrics">{(['roll', 'pitch', 'yaw'] as const).map((channel) => <div key={channel}><strong>{channelLabel(channel)}</strong><span>最大絕對值 {formatValue(report.maxAbsolute[channel])}</span><span>標準差 {formatValue(report.standardDeviation[channel])}</span></div>)}</div><p className={passingNow ? 'report-pass' : 'report-fail'}>{report.stable && !fresh ? '先前測試曾通過；請針對目前連線重新執行定時測試。' : localizedSetupMessage(report.reason ?? '')}</p></>}
    </section>
  )
}
