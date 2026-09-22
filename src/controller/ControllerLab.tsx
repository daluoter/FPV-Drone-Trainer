import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  return channel.toUpperCase()
}

function formatValue(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'INVALID'
}

function stepTitle(step: WizardStep): string {
  if (step === 'select') return 'Select controller'
  if (step === 'center') return 'Center sticks'
  if (step === 'direction') return 'Verify direction'
  if (step === 'neutral') return 'Neutral stability'
  if (step === 'ready') return 'Profile complete'
  return `Calibrate ${channelLabel(step)}`
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
    setCaptureLabel(`Collecting fresh Gamepad samples for ${Math.round(durationMs / 100) / 10} seconds…`)
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
      setCaptureError('Controller disconnected during capture. Reconnect it and restart this step.')
      return
    }
    const summary = calculateSampleSummary(result.samples)
    if (!summary.valid || summary.sampleCount < 30) {
      setCaptureError(summary.reason ?? 'Not enough center samples were collected.')
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
      setCaptureError('Controller disconnected during capture. Reconnect it and restart this step.')
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
      setCaptureError(`Axis ${axis} is already assigned. Move only ${channelLabel(channel)} and try again.`)
      return
    }
    const centerStats = centerSummary.axes[axis]
    if (!centerStats || !isCenterStable(centerStats)) {
      setCaptureError(`${channelLabel(channel)} center jitter was unstable. Recalibrate with the stick untouched.`)
      return
    }
    const endpoint = summarizeEndpointRange(
      result.samples.map((sample) => sample.axes[axis] ?? Number.NaN),
      channel === 'throttle' ? 'single-ended' : 'centered',
      centerStats.center,
    )
    if (!endpoint.valid) {
      setCaptureError(endpoint.reason ?? 'Endpoint calibration was invalid.')
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
      setCaptureError('Controller disconnected during capture. Neutral approval was not granted.')
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
      setCaptureError('Neutral capture contained invalid axis or button input. Approval was not granted.')
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
      setCaptureError(report.reason ?? 'Neutral stability failed. Recalibrate and repeat hands-off.')
      setWizardStep('neutral')
      return
    }

    const session = selectedDevice.connectionSession ?? deviceKey
    const verified = session
      ? markNeutralVerified(profile, report, new Date().toISOString(), session)
      : null
    if (!verified?.neutralVerificationSession) {
      setCaptureError('Controller connection identity was unavailable. Run the neutral test again.')
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
          <p className="panel-kicker">Phase 1 / Controller Lab</p>
          <h2 id="controller-lab-title">Make the transmitter boring.</h2>
          <p>
            Fresh Gamepad snapshots are calibrated before they can become flight commands. Every
            stage stays visible so a center offset cannot masquerade as physics.
          </p>
        </div>
        <div className={`lab-support-badge ${pollState.supported ? 'lab-support-ready' : 'lab-support-missing'}`}>
          <span aria-hidden="true" />
          {pollState.supported ? 'Gamepad API available' : 'Gamepad API unavailable'}
        </div>
      </div>

      <div className="controller-lab-grid">
        <div className="controller-lab-main">
          <section className="lab-card lab-device-card" aria-labelledby="device-title">
            <div className="lab-card-heading">
              <div>
                <p className="panel-kicker">01 / Device discovery</p>
                <h3 id="device-title">Choose the hardware</h3>
              </div>
              <span className="lab-live-indicator"><span aria-hidden="true" /> Polling outside React</span>
            </div>
            {!pollState.supported ? (
              <p className="lab-empty-state">
                This browser does not expose <code>navigator.getGamepads()</code>. Use desktop Chrome or
                Edge over a secure context, then reconnect the transmitter.
              </p>
            ) : pollState.devices.length === 0 ? (
              <p className="lab-empty-state">No connected Gamepad was returned. Connect a transmitter and release the sticks.</p>
            ) : (
              <div className="device-list">
                {pollState.devices.map((device) => (
                  <div className={`device-row ${device.index === pollState.selectedDeviceIndex ? 'device-selected' : ''}`} key={`${device.id}:${device.index}`}>
                    <div className="device-identity">
                      <span className={`device-dot ${device.connected ? 'device-connected' : ''}`} aria-hidden="true" />
                      <div>
                        <strong>{device.id || 'Unnamed Gamepad'}</strong>
                        <span>Index {device.index} · {device.mapping || 'unmapped'} mapping</span>
                      </div>
                    </div>
                    <div className="device-specs">
                      <span>{device.axisCount} axes</span>
                      <span>{device.buttonCount} buttons</span>
                    </div>
                    <button
                      className="lab-button lab-button-small"
                      type="button"
                      disabled={!device.connected}
                      aria-pressed={device.index === pollState.selectedDeviceIndex}
                      onClick={() => selectDevice(device.index)}
                    >
                      {device.index === pollState.selectedDeviceIndex ? 'Selected' : device.connected ? 'Select' : 'Disconnected'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="lab-card" aria-labelledby="wizard-title">
            <div className="lab-card-heading">
              <div>
                <p className="panel-kicker">02 / Guided calibration</p>
                <h3 id="wizard-title">{stepTitle(wizardStep)}</h3>
              </div>
              <span className="lab-step-count">{wizardStep === 'ready' ? 'COMPLETE' : wizardStep === 'select' ? 'WAITING' : 'HANDS-ON'}</span>
            </div>
            <div className="wizard-steps" aria-label="Calibration progress">
              {(['select', 'center', 'roll', 'pitch', 'yaw', 'throttle', 'direction', 'neutral'] as const).map((step, index) => (
                <span className={`wizard-step ${wizardStep === step ? 'wizard-step-current' : ''} ${stepCompleted(step, wizardStep) ? 'wizard-step-complete' : ''}`} key={step}>
                  <span>{String(index + 1).padStart(2, '0')}</span>{step === 'center' ? 'Center' : channelLabel(step as ControlChannel)}
                </span>
              ))}
            </div>

            {!selectedDevice && <p className="lab-instruction">Select a connected device to begin. No input is trusted before calibration.</p>}
            {selectedDevice && wizardStep === 'center' && (
              <div className="wizard-instruction">
                <p>Release Roll, Pitch and Yaw. Leave the transmitter untouched for approximately 2.5 seconds. Throttle is recorded for diagnostics but does not need a center.</p>
                <button className="lab-button lab-button-primary" type="button" disabled={capturing} onClick={() => void runCenterCapture()}>
                  {capturing ? 'Collecting…' : 'Capture center samples'}
                </button>
              </div>
            )}
            {selectedDevice && MOVEMENT_CHANNELS.includes(wizardStep as ControlChannel) && (
              <div className="wizard-instruction">
                <p>
                  Move <strong>{channelLabel(wizardStep as ControlChannel)}</strong> fully through its range several times, while leaving every other control untouched. The moved axis must be unambiguous; endpoint assumptions are not used.
                </p>
                <button className="lab-button lab-button-primary" type="button" disabled={capturing || !centerSummary} onClick={() => void runMovementCapture(wizardStep as ControlChannel)}>
                  {capturing ? 'Collecting…' : `Capture ${channelLabel(wizardStep as ControlChannel)} movement`}
                </button>
              </div>
            )}
            {selectedDevice && wizardStep === 'direction' && profile && (
              <div className="wizard-instruction">
                <p>Move each physical control and verify the virtual channel below. Invert one channel at a time if its direction is backwards. Changing an inversion invalidates both verification gates.</p>
                <button className="lab-button lab-button-primary" type="button" onClick={verifyDirections}>Directions verified</button>
              </div>
            )}
            {selectedDevice && wizardStep === 'neutral' && profile && (
              <div className="wizard-instruction">
                <p>Do not touch the transmitter. The processed Roll, Pitch and Yaw outputs must remain within the documented 0.02 normalized-output threshold for three seconds. An unstable result blocks the safety gate and explains the offending channel; reloads and reconnects require a fresh timed run.</p>
                <button className="lab-button lab-button-primary" type="button" disabled={capturing} onClick={() => void runNeutralCapture()}>
                  {capturing ? 'Testing neutral…' : 'Run 3-second neutral test'}
                </button>
              </div>
            )}
            {selectedDevice && wizardStep === 'ready' && (
              <div className="lab-success-message">
                <span aria-hidden="true">✓</span>
                Fresh neutral output is verified for this connection. This Phase 1 build still has no flight mode; future flight must consume this gate.
              </div>
            )}
            {captureLabel && <p className="capture-status" role="status">{captureLabel}</p>}
            {captureError && <p className="lab-error" role="alert">{captureError}</p>}
            {centerSummary && <CenterSummary summary={centerSummary} />}
          </section>

          <RawMonitor snapshot={selectedSnapshot} />
          <SignalPipeline snapshot={selectedSnapshot} profile={profile} processed={processed} />
        </div>

        <aside className="controller-lab-side">
          <section className={`lab-card lab-safety-card ${eligibility.eligible ? 'lab-safety-pass' : ''}`} aria-labelledby="safety-title">
            <div className="lab-card-heading">
              <div>
                <p className="panel-kicker">03 / Safety gate</p>
                <h3 id="safety-title">{eligibility.eligible ? 'Controller eligible' : 'Flight locked'}</h3>
              </div>
              <span className="safety-state">{eligibility.eligible ? 'PASS' : 'LOCKED'}</span>
            </div>
            <p className="safety-description">
              This gate is the only contract a future flight mode may use. It never hides invalid data behind a larger deadzone.
            </p>
            <ul className="safety-reasons">
              {eligibility.eligible ? <li className="reason-pass">Device, mapping, endpoints, direction and neutral are verified.</li> : eligibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
            <button className="lab-button lab-button-secondary" type="button" onClick={resetCalibration} disabled={!selectedDevice}>
              Recalibrate selected device
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
                <p className="panel-kicker">04 / Local profile</p>
                <h3 id="profile-title">Versioned persistence</h3>
              </div>
              <span className="profile-version">v{profile?.schemaVersion ?? 1}</span>
            </div>
            <p>{profile ? `Saved for ${profile.deviceId}. Profiles are loaded only when ID, mapping, axis count and button count match.` : 'A profile is created after all four channels pass endpoint calibration.'}</p>
            {profile && <dl className="profile-details"><div><dt>Calibrated</dt><dd>{profile.calibrationTimestamp}</dd></div><div><dt>Axes</dt><dd>{profile.axisCount}</dd></div><div><dt>Neutral</dt><dd>{profile.neutralVerifiedAt && profile.neutralVerificationSession === connectionSession ? 'Verified this connection' : 'Fresh test required'}</dd></div></dl>}
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
      <div className="summary-heading"><strong>Center sample statistics</strong><span>{summary.sampleCount} samples</span></div>
      <div className="summary-grid"><span>Axis</span><span>Center</span><span>Jitter p-p</span><span>Std dev</span>{summary.axes.map((axis, index) => <div className="summary-row" key={index}><strong>{index}</strong><span>{formatValue(axis.center)}</span><span>{formatValue(axis.jitter)}</span><span>{formatValue(axis.standardDeviation)}</span></div>)}</div>
    </div>
  )
}

function RawMonitor({ snapshot }: { snapshot: RawGamepadSnapshot | null }) {
  return (
    <section className="lab-card monitor-card" aria-labelledby="raw-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">05 / Raw monitor</p><h3 id="raw-title">Never guess the axis order</h3></div><span className="monitor-time">{snapshot ? `t ${formatValue(snapshot.timestamp, 0)}` : 'NO SAMPLE'}</span></div>
      {!snapshot ? <p className="lab-empty-state">Select a connected device to inspect fresh axes and buttons.</p> : <>
        <div className="axis-monitor">{snapshot.axes.map((value, index) => <div className="axis-monitor-cell" key={index}><span>AXIS {index}</span><strong className={Number.isFinite(value) ? '' : 'invalid-value'}>{formatValue(value)}</strong><meter min={-1} max={1} value={Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0} aria-label={`Axis ${index} raw value`} /></div>)}</div>
        <div className="button-monitor"><span>Buttons</span>{snapshot.buttons.map((button, index) => <span className={button.pressed ? 'button-pressed' : ''} key={index}>{index}:{button.pressed ? 'down' : formatValue(button.value)}</span>)}</div>
      </>}
    </section>
  )
}

function SignalPipeline({ snapshot, profile, processed }: { snapshot: RawGamepadSnapshot | null; profile: ControllerProfile | null; processed: ReturnType<typeof processControllerSnapshot> | null }) {
  return (
    <section className="lab-card pipeline-monitor-card" aria-labelledby="pipeline-monitor-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">06 / Signal pipeline</p><h3 id="pipeline-monitor-title">Raw → final, in public</h3></div><span className="monitor-time">{profile && snapshot ? 'LIVE' : 'WAITING'}</span></div>
      {!profile || !snapshot || !processed ? <p className="lab-empty-state">Complete endpoint calibration to expose calibrated, normalized, deadband, filtered and final channels.</p> : <div className="signal-table-wrap"><table className="signal-table"><thead><tr><th>Channel</th><th>Raw</th><th>Calibrated</th><th>Normalized</th><th>Deadband</th><th>Filtered</th><th>Final</th></tr></thead><tbody>{CONTROL_CHANNELS.map((channel) => { const values = processed.channels[channel]; return <tr key={channel}><th scope="row">{channelLabel(channel)}</th><td>{formatValue(values.raw)}</td><td>{formatValue(values.calibrated)}</td><td>{formatValue(values.normalized)}</td><td>{formatValue(values.deadband)}</td><td>{formatValue(values.filtered)}</td><td className={values.valid ? '' : 'invalid-value'}>{formatValue(values.final)}</td></tr> })}</tbody></table></div>}
    </section>
  )
}

function DirectionPanel({ profile, processed, onUpdate }: { profile: ControllerProfile; processed: ReturnType<typeof processControllerSnapshot> | null; onUpdate: (channel: ControlChannel, patch: { invert?: boolean; deadband?: number }) => void }) {
  return (
    <section className="lab-card direction-card" aria-labelledby="direction-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">07 / Direction + feel</p><h3 id="direction-title">Virtual channels</h3></div><span className="profile-version">{profile.directionVerifiedAt ? 'VERIFIED' : 'VERIFY'}</span></div>
      <div className="direction-list">{CONTROL_CHANNELS.map((channel) => { const calibration = profile.channels[channel]; const value = processed?.channels[channel].final ?? Number.NaN; return <div className="direction-row" key={channel}><div><strong>{channelLabel(channel)}</strong><span>Axis {calibration.axis} · {formatValue(value)}</span></div><label><input type="checkbox" checked={calibration.invert} onChange={(event) => onUpdate(channel, { invert: event.target.checked })} /> Invert</label>{channel !== 'throttle' && <label className="deadband-control">Deadband <input type="number" min="0" max="0.2" step="0.005" value={calibration.deadband} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next) && next >= 0 && next <= 0.2) onUpdate(channel, { deadband: next }) }} /></label>}</div> })}</div>
    </section>
  )
}

function NeutralReport({ report, fresh }: { report: NeutralStabilityReport | null; fresh: boolean }) {
  const passingNow = Boolean(report?.stable && fresh)
  return (
    <section className="lab-card neutral-card" aria-labelledby="neutral-report-title">
      <div className="lab-card-heading"><div><p className="panel-kicker">08 / Stability evidence</p><h3 id="neutral-report-title">Hands-off report</h3></div><span className={`profile-version ${passingNow ? 'report-pass' : ''}`}>{!report ? 'NO RUN' : passingNow ? 'PASS' : report.stable ? 'RETEST' : 'FAIL'}</span></div>
      {!report ? <p>Run the timed neutral test after direction verification. Reloading or reconnecting preserves calibration but requires a fresh hands-off capture.</p> : <><div className="neutral-metrics">{(['roll', 'pitch', 'yaw'] as const).map((channel) => <div key={channel}><strong>{channelLabel(channel)}</strong><span>max {formatValue(report.maxAbsolute[channel])}</span><span>σ {formatValue(report.standardDeviation[channel])}</span></div>)}</div><p className={passingNow ? 'report-pass' : 'report-fail'}>{report.stable && !fresh ? 'Historical pass; rerun the timed test for this connection.' : report.reason}</p></>}
    </section>
  )
}
