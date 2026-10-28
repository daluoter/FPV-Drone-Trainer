import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { ControllerProfile, GamepadPoller } from '../controller'
import type { DroneConfig } from '../drone'
import {
  FlightRenderer,
  FlightRendererInitializationError,
  type CameraMode,
  type FlightRendererStatus,
} from '../rendering'
import {
  FlightRuntime,
  type FlightInputSource,
  type FlightRuntimeFixedStepSample,
  type FlightRuntimeTelemetry,
} from '../runtime'
import Mode2StickOverlay from '../training/StickOverlay'
import { trainingHint, trainingObjective, wideGateCollisionCause } from '../training/feedback'
import { createResultReplaySnapshot, type ResultReplayMarker, type ResultReplaySnapshot } from '../training/resultReplay'
import { createTeachingDemonstration, teachingCueAt, teachingTargetAt, teachingRecoveryPhaseAt, teachingFullRollPhaseAt, teachingFullFlipPhaseAt, teachingPowerLoopPhaseAt, teachingSplitSPhaseAt, teachingOrbitPhaseAt, type TeachingDemonstration, type TeachingDemonstrationKind } from '../training/demonstrations'
import { DIRECTION_CONTROL_TARGET_IDS } from '../training/directionControl'
import { COORDINATED_TURN_TARGET_IDS } from '../training/coordinatedTurn'
import { SQUARE_ROUTE_TARGET_IDS } from '../training/squareRoute'
import { FIGURE_EIGHT_TARGET_IDS } from '../training/figureEight'
import { createTrainingFieldAnchors } from '../training/field'
import { createWideGates, WIDE_GATE_IDS } from '../world/wideGates'
import { measureBasicRecoveryMotion } from '../training/basicRecovery'
import { measureFullFlipMotion } from '../training/fullFlip'
import { lessonLearningContent } from '../training/catalog'
import DemonstrationProgress from '../training/TeachingDemonstrationProgress'
import { createDemonstrationProgress, demonstrationProgressAt, type TeachingDemonstrationProgressSnapshot } from '../training/demonstrationProgress'
import type { TrainingMachineState, TrainingSample, TrainingSceneReference, TrainingSetupRequest } from '../training/types'
import { copyTuningSettings, flightSimulationConfigFromTuning, type TuningSettings } from '../tuning'
import { REPLAY_SPEEDS, type ReplaySpeed } from '../replay'
import { makePositionReadout } from './positionTelemetry'

export interface FreeFlightProps {
  readonly poller: GamepadPoller
  readonly profile: ControllerProfile | null
  readonly settings: TuningSettings
  readonly trainingResetKey?: number
  readonly trainingDisarmKey?: number
  readonly trainingSettingsLocked?: boolean
  readonly trainingSetupRequest?: TrainingSetupRequest | null
  readonly trainingPath?: readonly TrainingSample[]
  readonly demonstrationRequest?: { readonly sequence: number; readonly kind: TeachingDemonstrationKind } | null
  readonly demonstrationSeekRequest?: { readonly sequence: number; readonly timeSeconds: number } | null
  readonly onDemonstrationProgress?: (progress: TeachingDemonstrationProgressSnapshot | null) => void
  readonly exitPlaybackRequest?: number
  readonly onTrainingReset?: () => void
  readonly trainingArmBlocked?: boolean
  readonly trainingState?: TrainingMachineState | null
  readonly lessonPanel?: ReactNode
  readonly onSceneReferences?: (references: readonly TrainingSceneReference[]) => void
  readonly onFixedStep?: (sample: FlightRuntimeFixedStepSample) => void
  readonly onTelemetry?: (telemetry: FlightRuntimeTelemetry) => void
}

function format(value: number | undefined, digits = 2): string {
  return value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function isFlipLesson(lessonId: string | null | undefined): boolean {
  return lessonId === 'front-flip' || lessonId === 'back-flip' || lessonId === 'full-flip'
}

function positionValue(value: number | null, signed = false): string {
  if (value === null) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${signed && rounded > 0 ? '+' : ''}${rounded.toFixed(1)} m`
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

type FreeFlightRenderingState = 'initializing' | FlightRendererStatus['kind']

function fallbackTelemetryLabel(
  telemetry: FlightRuntimeTelemetry | null,
  renderingState: FreeFlightRenderingState,
): string {
  if (renderingState === 'initializing') return 'RENDERER / starting'
  if (renderingState !== 'ready') return 'SAFE / rendering unavailable'
  if (!telemetry) return 'Starting runtime…'
  if (telemetry.replay.active) return telemetry.replay.playing ? 'PLAYBACK / playing ghost' : 'PLAYBACK / paused ghost'
  if (telemetry.state.crashed) return 'CRASHED / reset required'
  return telemetry.armed ? 'ARMED / simulation running' : 'SAFE / disarmed'
}

function rendererFailureMessage(error: unknown): string {
  if (error instanceof FlightRendererInitializationError) return error.message
  if (error instanceof Error && error.message.trim().length > 0) return `WebGL renderer initialization failed: ${error.message}`
  return 'WebGL renderer initialization failed. Check browser hardware acceleration and retry.'
}

export default function FreeFlight({
  poller,
  profile,
  settings,
  trainingResetKey = 0,
  trainingDisarmKey = 0,
  trainingSettingsLocked = false,
  trainingSetupRequest = null,
  trainingPath = [],
  demonstrationRequest = null,
  demonstrationSeekRequest = null,
  onDemonstrationProgress,
  exitPlaybackRequest = 0,
  onTrainingReset,
  trainingArmBlocked = false,
  trainingState = null,
  lessonPanel = null,
  onSceneReferences,
  onFixedStep,
  onTelemetry,
}: FreeFlightProps) {
  const workspaceRef = useRef<HTMLElement | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const appliedSettingsRef = useRef(settings)
  const runtimeRef = useRef<FlightRuntime | null>(null)
  const rendererRef = useRef<FlightRenderer | null>(null)
  const [telemetry, setTelemetry] = useState<FlightRuntimeTelemetry | null>(null)
  const [renderingState, setRenderingState] = useState<FreeFlightRenderingState>('initializing')
  const [renderingError, setRenderingError] = useState<string | null>(null)
  const [rendererRetryKey, setRendererRetryKey] = useState(0)
  const [demonstration, setDemonstration] = useState<TeachingDemonstration | null>(null)
  const [demonstrationSettings, setDemonstrationSettings] = useState<TuningSettings | null>(null)
  const [demoError, setDemoError] = useState<string | null>(null)
  const [resultReplay, setResultReplay] = useState<ResultReplaySnapshot | null>(null)
  const capturedResultSessionRef = useRef<string | null>(null)
  const lastFlightConfigRef = useRef<DroneConfig>(settings.drone)
  const capturedResultConfigRef = useRef<DroneConfig | null>(null)
  const [replayCoordinateConfig, setReplayCoordinateConfig] = useState<DroneConfig | null>(null)
  const [playingResultSession, setPlayingResultSession] = useState<string | null>(null)
  const [source, setSource] = useState<FlightInputSource>('controller')
  const [cameraMode, setCameraMode] = useState<CameraMode>('fpv')
  const [showHud, setShowHud] = useState(false)
  const fixedStepListenerRef = useRef(onFixedStep)
  const telemetryListenerRef = useRef(onTelemetry)
  const sceneReferencesListenerRef = useRef(onSceneReferences)
  const wideGateObstacles = useMemo(() => {
    const { launch } = createTrainingFieldAnchors(settings.drone)
    return createWideGates(launch, settings.drone.ground.heightM).flatMap((gate) => gate.colliders)
  }, [settings.drone])
  const shouldConfirmExit = Boolean(telemetry?.armed || trainingSettingsLocked)
  const demonstrationTimeline = useMemo(() => demonstration && demonstrationSettings
    ? createDemonstrationProgress(demonstration, demonstrationSettings) : null, [demonstration, demonstrationSettings])
  const demonstrationProgress = useMemo(() => telemetry?.replay.active && demonstrationTimeline
    ? demonstrationProgressAt(demonstrationTimeline, telemetry.replay.currentTimeSeconds) : null,
  [demonstrationTimeline, telemetry?.replay.active, telemetry?.replay.currentTimeSeconds])

  useEffect(() => {
    onDemonstrationProgress?.(demonstrationProgress)
  }, [demonstrationProgress, onDemonstrationProgress])

  useEffect(() => {
    if (!shouldConfirmExit) return
    const confirmExit = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // The browser controls the native prompt and may require prior interaction.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', confirmExit)
    return () => window.removeEventListener('beforeunload', confirmExit)
  }, [shouldConfirmExit])

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

    let active = true
    let cleanupResize = (): void => undefined
    let runtime: FlightRuntime | null = null
    let currentRendererStatus: FlightRendererStatus = { kind: 'ready' }
    setTelemetry(null)
    setRenderingState('initializing')
    setRenderingError(null)

    const onRendererStatus = (status: FlightRendererStatus): void => {
      currentRendererStatus = status
      if (!active) return
      setRenderingState(status.kind)
      setRenderingError(status.kind === 'ready' ? null : status.message ?? 'The WebGL renderer is unavailable.')
      runtime?.setRenderingAvailable?.(status.kind === 'ready', status.message)
    }

    let renderer: FlightRenderer
    try {
      renderer = new FlightRenderer(canvas, {
        ...settings.camera,
        droneConfig: settings.drone,
        onStatusChange: onRendererStatus,
      })
    } catch (error) {
      setRenderingState('unavailable')
      setRenderingError(rendererFailureMessage(error))
      return () => {
        active = false
        runtimeRef.current = null
        rendererRef.current = null
      }
    }
    setRenderingState(currentRendererStatus.kind)
    setRenderingError(currentRendererStatus.kind === 'ready' ? null : currentRendererStatus.message ?? 'The WebGL renderer is unavailable.')

    runtime = new FlightRuntime({
      poller,
      profile,
      renderer,
      renderingAvailable: currentRendererStatus.kind === 'ready',
      simulation: flightSimulationConfigFromTuning(settings),
      onTelemetry: (nextTelemetry) => {
        setTelemetry(nextTelemetry)
        telemetryListenerRef.current?.(nextTelemetry)
      },
      onFixedStep: (sample) => fixedStepListenerRef.current?.(sample),
    })
    runtime.setTrainingArmBlocked?.(trainingArmBlocked)
    runtime.setRenderingAvailable?.(currentRendererStatus.kind === 'ready', currentRendererStatus.message)
    runtime.setInputSource(source)
    runtime.setCameraMode(cameraMode)
    runtime.setTuningLocked(trainingSettingsLocked)
    runtimeRef.current = runtime
    rendererRef.current = renderer
    renderer.setLessonTarget?.(trainingState?.lessonId ?? null)
    appliedSettingsRef.current = settings
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
      active = false
      cleanupResize()
      runtime?.dispose()
      renderer.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = null
      if (rendererRef.current === renderer) rendererRef.current = null
    }
    // The runtime owns the loop; profile/source updates are handed off by the
    // effects below rather than restarting the renderer.
  }, [poller, rendererRetryKey])

  useEffect(() => {
    runtimeRef.current?.setTrainingArmBlocked?.(trainingArmBlocked)
  }, [trainingArmBlocked, rendererRetryKey])

  useEffect(() => {
    const runtime = runtimeRef.current
    runtime?.setTuningLocked(trainingSettingsLocked)
  }, [trainingSettingsLocked])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || trainingSettingsLocked || telemetry?.replay.active || appliedSettingsRef.current === settings) return
    if (runtime.reconfigure(flightSimulationConfigFromTuning(settings)) === false) return
    rendererRef.current?.setCameraOptions(settings.camera)
    rendererRef.current?.reconfigureScene?.(settings.drone)
    const nextReferences = rendererRef.current?.flightScene.sceneReferences
    if (nextReferences) sceneReferencesListenerRef.current?.(nextReferences.map(({ id, kind, positionM, sizeM }) => ({ id, kind, positionM: { ...positionM }, sizeM: sizeM ? { ...sizeM } : undefined })))
    appliedSettingsRef.current = settings
    setTelemetry(runtime.getTelemetry())
  }, [settings, telemetry?.replay.active, trainingSettingsLocked])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || runtime.getTelemetry().armed || runtime.getTelemetry().replay.active) return
    runtime.setStaticObstacles?.(trainingState?.lessonId === 'wide-gate' ? wideGateObstacles : [])
  }, [trainingState?.lessonId, wideGateObstacles, rendererRetryKey, telemetry?.armed, telemetry?.replay.active])

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
    const runtime = runtimeRef.current
    if (!runtime || trainingDisarmKey <= 0) return
    runtime.disarm('Training attempt reset; explicit rearm is required.')
    setTelemetry(runtime.getTelemetry())
  }, [trainingDisarmKey])

  useEffect(() => {
    const lessonId = telemetry?.replay.active && demonstration
      ? demonstration.lessonId === 'intro' ? null : demonstration.lessonId
      : trainingState?.lessonId ?? null
    rendererRef.current?.setLessonTarget?.(lessonId)
    const index = trainingState?.lastEvaluation?.metrics?.directionTargetIndex ?? 0
    const targetId = lessonId !== 'direction-control' ? null : telemetry?.replay.active
      ? demonstration ? teachingTargetAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : Number.isInteger(index) && index >= 0 ? DIRECTION_CONTROL_TARGET_IDS[index] ?? null : null
    rendererRef.current?.setDirectionTarget?.(targetId)
    const turnIndex = trainingState?.lastEvaluation?.metrics?.turnTargetIndex ?? 0
    const turnTargetId = lessonId !== 'coordinated-turn' ? null : telemetry?.replay.active
      ? demonstration ? teachingTargetAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : Number.isInteger(turnIndex) && turnIndex >= 0 ? COORDINATED_TURN_TARGET_IDS[turnIndex] ?? null : null
    rendererRef.current?.setTurnTarget?.(turnTargetId)
    const squareIndex = trainingState?.lastEvaluation?.metrics?.squareTargetIndex ?? 0
    const squareTargetId = lessonId !== 'square-route' ? null : telemetry?.replay.active
      ? demonstration ? teachingTargetAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : Number.isInteger(squareIndex) && squareIndex >= 0 ? SQUARE_ROUTE_TARGET_IDS[squareIndex] ?? null : null
    rendererRef.current?.setSquareTarget?.(squareTargetId)
    const eightIndex = trainingState?.lastEvaluation?.metrics?.eightTargetIndex ?? 0
    const eightTargetId = lessonId !== 'figure-eight' ? null : telemetry?.replay.active
      ? demonstration ? teachingTargetAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : Number.isInteger(eightIndex) && eightIndex >= 0 ? FIGURE_EIGHT_TARGET_IDS[eightIndex] ?? null : null
    rendererRef.current?.setFigureEightTarget?.(eightTargetId)
    const gateIndex = trainingState?.lastEvaluation?.metrics?.gateTargetIndex ?? 0
    const gateTargetId = lessonId !== 'wide-gate' ? null : telemetry?.replay.active
      ? demonstration ? teachingTargetAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : Number.isInteger(gateIndex) && gateIndex >= 0 ? WIDE_GATE_IDS[gateIndex] ?? null : null
    rendererRef.current?.setWideGateTarget?.(gateTargetId)
    const recoveryPhase = lessonId !== 'basic-recovery' ? null : telemetry?.replay.active
      ? demonstration ? teachingRecoveryPhaseAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : trainingState?.lastEvaluation?.metrics?.recoveryPhase ?? 0
    rendererRef.current?.setRecoveryStage?.(recoveryPhase)
    const rollPhase = lessonId !== 'full-roll' ? null : telemetry?.replay.active
      ? demonstration ? teachingFullRollPhaseAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : trainingState?.lastEvaluation?.metrics?.rollPhase ?? 0
    rendererRef.current?.setFullRollStage?.(rollPhase)
    const flipPhase = !isFlipLesson(lessonId) ? null : telemetry?.replay.active
      ? demonstration ? teachingFullFlipPhaseAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : trainingState?.lastEvaluation?.metrics?.flipPhase ?? 0
    rendererRef.current?.setFullFlipStage?.(flipPhase)
    const loopPhase = lessonId !== 'power-loop' ? null : telemetry?.replay.active
      ? demonstration ? teachingPowerLoopPhaseAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : trainingState?.lastEvaluation?.metrics?.loopPhase ?? 0
    rendererRef.current?.setPowerLoopStage?.(loopPhase)
    const splitPhase = lessonId !== 'split-s' ? null : telemetry?.replay.active
      ? demonstration ? teachingSplitSPhaseAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : trainingState?.lastEvaluation?.metrics?.splitPhase ?? 0
    rendererRef.current?.setSplitSStage?.(splitPhase)
    const orbitPhase = lessonId !== 'orbit' ? null : telemetry?.replay.active
      ? demonstration ? teachingOrbitPhaseAt(demonstration, telemetry.replay.currentTimeSeconds) : null
      : trainingState?.lastEvaluation?.metrics?.orbitPhase ?? 0
    rendererRef.current?.setOrbitStage?.(orbitPhase)
  }, [trainingState?.lessonId, trainingState?.lastEvaluation?.metrics?.directionTargetIndex, trainingState?.lastEvaluation?.metrics?.turnTargetIndex, trainingState?.lastEvaluation?.metrics?.squareTargetIndex, trainingState?.lastEvaluation?.metrics?.eightTargetIndex, trainingState?.lastEvaluation?.metrics?.gateTargetIndex, trainingState?.lastEvaluation?.metrics?.recoveryPhase, trainingState?.lastEvaluation?.metrics?.rollPhase, trainingState?.lastEvaluation?.metrics?.flipPhase, trainingState?.lastEvaluation?.metrics?.loopPhase, trainingState?.lastEvaluation?.metrics?.splitPhase, trainingState?.lastEvaluation?.metrics?.orbitPhase, rendererRetryKey, telemetry?.replay.active, telemetry?.replay.currentTimeSeconds, demonstration])

  useEffect(() => {
    rendererRef.current?.setTrainingPath(trainingPath.map((sample) => sample.state.positionM))
  }, [trainingPath])

  useEffect(() => {
    const result = trainingState?.result
    if (!result || capturedResultSessionRef.current === result.sessionId) return
    // Capture this session once. Later flights, clock resets and demonstrations
    // must never supply a replacement recording for these result markers.
    capturedResultSessionRef.current = result.sessionId
    capturedResultConfigRef.current = lastFlightConfigRef.current
    setResultReplay(createResultReplaySnapshot(trainingState, runtimeRef.current?.getReplayRecording?.() ?? null))
  }, [trainingState?.result?.sessionId])

  useEffect(() => {
    runtimeRef.current?.setControllerProfile(profile)
  }, [profile])

  useEffect(() => {
    runtimeRef.current?.setInputSource(source)
  }, [source])

  useEffect(() => {
    runtimeRef.current?.setCameraMode(cameraMode)
    if (cameraMode === 'free') canvasRef.current?.focus({ preventScroll: true })
  }, [cameraMode])

  const retryRendering = (): void => {
    if (trainingSettingsLocked) onTrainingReset?.()
    setRenderingState('initializing')
    setRenderingError(null)
    setRendererRetryKey((key) => key + 1)
  }

  const arm = (): void => {
    if (trainingArmBlocked) return
    const runtime = runtimeRef.current
    if (!runtime || renderingState !== 'ready') return
    runtime.setStaticObstacles?.(trainingState?.lessonId === 'wide-gate' ? wideGateObstacles : [])
    runtime.arm()
    if (runtime.getTelemetry().armed) lastFlightConfigRef.current = copyTuningSettings(appliedSettingsRef.current).drone
    setTelemetry(runtime.getTelemetry())
  }

  const enterReplay = (): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    setDemonstration(null)
    setDemonstrationSettings(null)
    setPlayingResultSession(null)
    if (!runtime.enterReplay()) return
    setDemoError(null)
    setReplayCoordinateConfig(lastFlightConfigRef.current)
    setTelemetry(runtime.getTelemetry())
  }

  const exitReplay = (): void => {
    setDemonstration(null)
    setDemonstrationSettings(null)
    setPlayingResultSession(null)
    setReplayCoordinateConfig(null)
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.exitReplay()
    setTelemetry(runtime.getTelemetry())
  }

  useEffect(() => {
    if (exitPlaybackRequest > 0 && runtimeRef.current?.getTelemetry().replay.active) exitReplay()
  }, [exitPlaybackRequest])

  const replayResultMarker = (marker: ResultReplayMarker): void => {
    const runtime = runtimeRef.current
    if (!runtime || !resultReplay?.recording || marker.timeSeconds === null || trainingSettingsLocked) return
    if (runtime.getTelemetry().replay.active && playingResultSession !== resultReplay.sessionId) runtime.exitReplay()
    if (!runtime.getTelemetry().replay.active && !runtime.enterReplay(resultReplay.recording)) return
    setReplayCoordinateConfig(capturedResultConfigRef.current)
    setDemonstration(null)
    setDemonstrationSettings(null)
    runtime.pauseReplay()
    runtime.seekReplay(marker.timeSeconds)
    setPlayingResultSession(resultReplay.sessionId)
    setTelemetry(runtime.getTelemetry())
  }

  const playReplay = (): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.playReplay()
    setTelemetry(runtime.getTelemetry())
  }

  const pauseReplay = (): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.pauseReplay()
    setTelemetry(runtime.getTelemetry())
  }

  const seekReplay = (seconds: number): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.seekReplay(seconds)
    setTelemetry(runtime.getTelemetry())
  }

  const seekDemonstrationStep = (seconds: number): void => {
    const runtime = runtimeRef.current
    if (!runtime || !demonstration || !runtime.getTelemetry().replay.active) return
    runtime.pauseReplay()
    runtime.seekReplay(seconds)
    setTelemetry(runtime.getTelemetry())
  }

  useEffect(() => {
    if (demonstrationSeekRequest) seekDemonstrationStep(demonstrationSeekRequest.timeSeconds)
  }, [demonstrationSeekRequest])

  const setReplaySpeed = (speed: ReplaySpeed): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.setReplaySpeed(speed)
    setTelemetry(runtime.getTelemetry())
  }

  const disarm = (): void => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.disarm('Pilot requested disarm.')
    setTelemetry(runtime.getTelemetry())
  }

  const reset = (): void => {
    setDemonstration(null)
    setDemonstrationSettings(null)
    setReplayCoordinateConfig(null)
    if (trainingSettingsLocked && onTrainingReset) { onTrainingReset(); return }
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.reset()
    setTelemetry(runtime.getTelemetry())
  }

  const startDemonstration = (kind: TeachingDemonstrationKind): void => {
    const runtime = runtimeRef.current
    if (!runtime || trainingSettingsLocked || telemetry?.armed) return
    setDemonstration(null)
    setDemonstrationSettings(null)
    setReplayCoordinateConfig(null)
    setPlayingResultSession(null)
    try {
      if (runtime.isReplayActive?.()) runtime.exitReplay()
      const recordedSettings = copyTuningSettings(settings)
      const demo = createTeachingDemonstration(recordedSettings, kind)
      if (!runtime.enterReplay(demo.recording)) throw new Error('Teaching playback could not start.')
      setReplayCoordinateConfig(recordedSettings.drone)
      setDemonstrationSettings(recordedSettings)
      setDemonstration(demo)
      setDemoError(null)
      runtime.setReplaySpeed(kind === 'basic-recovery' || kind === 'full-roll' || kind === 'full-flip' || kind === 'front-flip' || kind === 'back-flip' || kind === 'power-loop' || kind === 'split-s' || kind === 'orbit' ? 0.5 : 1)
      runtime.playReplay()
      setTelemetry(runtime.getTelemetry())
    } catch {
      setTelemetry(runtime.getTelemetry())
      setDemoError('目前設定無法建立示範，請選擇新手預設後再試。')
    }
  }
  useEffect(() => {
    if (demonstrationRequest) startDemonstration(demonstrationRequest.kind)
  }, [demonstrationRequest])
  useEffect(() => {
    const syncFullscreen = (): void => setFullscreen(document.fullscreenElement === workspaceRef.current)
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => document.removeEventListener('fullscreenchange', syncFullscreen)
  }, [])
  const toggleFullscreen = async (): Promise<void> => {
    if (telemetry?.armed || trainingSettingsLocked || telemetry?.replay.active) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (workspaceRef.current?.requestFullscreen) await workspaceRef.current.requestFullscreen()
      else throw new Error('unsupported')
      setFullscreenError(null)
    } catch { setFullscreenError('瀏覽器未提供全螢幕；仍可在目前畫面練習。') }
  }
  const replayGhost = telemetry?.replay.active ? runtimeRef.current?.getReplayPlayback?.()?.getGhostState() ?? null : null
  const playbackInput = telemetry?.replay.active ? replayGhost?.normalizedInput ?? null : telemetry?.normalizedInput
  const positionConfig = telemetry?.replay.active ? replayCoordinateConfig : appliedSettingsRef.current.drone
  const position = makePositionReadout(
    positionConfig ? telemetry?.replay.active ? replayGhost : telemetry?.state ?? null : null,
    positionConfig ?? settings.drone,
  )
  const collisionCause = telemetry?.state.warnings.map(wideGateCollisionCause).find(Boolean)
  const showRecoveryHud = telemetry?.replay.active && demonstration
    ? demonstration.lessonId === 'basic-recovery'
    : trainingState?.lessonId === 'basic-recovery'
  const recoveryMotionState = telemetry?.replay.active ? replayGhost : telemetry?.state
  const recoveryMotion = showRecoveryHud && recoveryMotionState ? measureBasicRecoveryMotion(recoveryMotionState) : null
  const showRollHud = telemetry?.replay.active ? demonstration?.lessonId === 'full-roll' : trainingState?.lessonId === 'full-roll'
  const showFlipHud = isFlipLesson(telemetry?.replay.active ? demonstration?.lessonId : trainingState?.lessonId)
  const showLoopHud = (telemetry?.replay.active ? demonstration?.lessonId : trainingState?.lessonId) === 'power-loop'
  const loopMetrics = telemetry?.replay.active ? demonstrationProgress?.metrics : trainingState?.lastEvaluation?.metrics
  const showSplitHud = (telemetry?.replay.active ? demonstration?.lessonId : trainingState?.lessonId) === 'split-s'
  const splitMetrics = telemetry?.replay.active ? demonstrationProgress?.metrics : trainingState?.lastEvaluation?.metrics
  const showOrbitHud = (telemetry?.replay.active ? demonstration?.lessonId : trainingState?.lessonId) === 'orbit'
  const orbitMetrics = telemetry?.replay.active ? demonstrationProgress?.metrics : trainingState?.lastEvaluation?.metrics
  const showMotionHud = showRecoveryHud || showRollHud || showFlipHud || showLoopHud || showSplitHud || showOrbitHud
  const rollMotion = showRollHud && recoveryMotionState ? measureBasicRecoveryMotion(recoveryMotionState) : null
  const rollProgress = telemetry?.replay.active ? demonstrationProgress?.metrics?.rollProgressDegrees : trainingState?.lastEvaluation?.metrics?.rollProgressDegrees
  const rollRate = showRollHud && recoveryMotionState ? -recoveryMotionState.angularVelocityBodyRadPerSec.z * 180 / Math.PI : undefined
  const flipMotion = showFlipHud && recoveryMotionState ? measureFullFlipMotion(recoveryMotionState) : null
  const flipProgress = telemetry?.replay.active ? demonstrationProgress?.metrics?.flipProgressDegrees : trainingState?.lastEvaluation?.metrics?.flipProgressDegrees
  const recovery = trainingState?.recoveryInProgress ? trainingState.lastRecovery : null
  const currentObjective = trainingObjective(trainingState?.lessonId ?? null, trainingState?.lastEvaluation)
  const visibleResultReplay = resultReplay?.sessionId === trainingState?.result?.sessionId && !demonstration ? resultReplay : null
  const channels = channelValues(telemetry)
  const rawAxes = telemetry?.rawInput?.axes ?? []
  const processed = telemetry?.processedInput
  const state = telemetry?.state
  const pid = telemetry?.pid

  return (
    <section ref={workspaceRef} className={`free-flight-section school-flight ${lessonPanel ? 'has-lessons' : ''}`} id="free-flight" aria-labelledby="free-flight-title">
      <div className="free-flight-heading">
        <div>
          <p className="panel-kicker">練習工作區 · Acro</p>
          <h2 id="free-flight-title">看懂動作，再親手試一次。</h2>
          <p>Arm 解鎖開始飛行，Disarm 停止馬達；課程倒數後等待你準備完成。示範與回放不會累積成績。</p>
        </div>
        <button className="lab-button lab-button-small school-fullscreen" type="button" disabled={trainingSettingsLocked || Boolean(telemetry?.armed || telemetry?.replay.active)} onClick={() => void toggleFullscreen()}>{fullscreen ? '離開全螢幕' : '全螢幕練習'}</button>
        <div className={`flight-state-badge ${renderingState === 'ready' && telemetry?.armed ? 'flight-state-armed' : ''}`}>
          <span aria-hidden="true" /> {fallbackTelemetryLabel(telemetry, renderingState)}
        </div>
      </div>

      <div className="school-demo-bar school-demo-toolbar" aria-label="四軸與課程示範">
        <strong>L00 看懂四軸</strong>
        {([['roll', '橫滾'], ['pitch', '俯仰'], ['yaw', '偏航'], ['takeoff', '起飛與懸停示範'], ['straight-line', '直線示範'], ['landing', '降落示範'], ['direction-control', '方向示範'], ['coordinated-turn', '轉彎示範'], ['square-route', '方形示範'], ['figure-eight', '八字示範'], ['wide-gate', '穿門示範'], ['basic-recovery', '恢復示範'], ['full-roll', '橫滾示範'], ['front-flip', '前翻示範'], ['back-flip', '後翻示範'], ['power-loop', '大迴旋示範'], ['split-s', '破S示範'], ['orbit', '正刷鍋示範']] as const).map(([kind, label]) => {
          const course = lessonLearningContent(kind)
          return <button className="lab-button lab-button-small" type="button" key={kind} disabled={trainingSettingsLocked || Boolean(telemetry?.armed) || renderingState !== 'ready'} onClick={() => startDemonstration(kind)}>{course ? `${course.code} ${label}` : label}</button>
        })}
        <span>左桿：油門／偏航 · 右桿：橫滾／俯仰</span>
      </div>
      {fullscreenError && <p role="status">{fullscreenError}</p>}
      {demoError && <p role="alert">{demoError}</p>}
      <div className="free-flight-layout">
        {lessonPanel && <aside className="school-lesson-slot">{lessonPanel}</aside>}
        <div className="free-flight-main">
          {telemetry?.replay.active && <div className="school-demo-bar school-playback-return">
            <strong>{demonstration ? '正在觀看教學示範' : '正在觀看飛行回放'}</strong>
            <button className="lab-button lab-button-primary" type="button" onClick={exitReplay}>{demonstration ? '結束示範' : '結束回放'}</button>
            <span>結束後回到練習，仍需自行解鎖。</span>
          </div>}
          <div className={`free-flight-viewport${showMotionHud ? ' has-recovery-hud' : ''}${showOrbitHud ? ' has-orbit-hud' : ''}`} role="group" aria-label="Three.js Free Flight simulation viewport">
            <canvas key={rendererRetryKey} ref={canvasRef} className={`flight-canvas${cameraMode === 'free' ? ' is-free-camera' : ''}`} aria-label="Free Flight 3D scene"
              tabIndex={cameraMode === 'free' ? 0 : -1} aria-describedby={cameraMode === 'free' ? 'free-camera-help' : undefined} />
            <div className="flight-viewport-overlay" aria-hidden="true">
              <span>{telemetry?.replay.active ? 'PLAYBACK GHOST' : 'LIVE SIM'} / {telemetry?.cameraMode?.toUpperCase() ?? 'FPV'}</span>
              <span>{format(telemetry?.metrics.fps, 0)} FPS · {format(telemetry?.metrics.simHz, 0)} SIM HZ</span>
            </div>
            <div className={showMotionHud ? 'flight-instruments' : undefined}>
              <div className="flight-position-hud" role="group" aria-label="飛行位置">
              <div className="flight-altitude"><span>{telemetry?.replay.active ? '回放高度' : '高度'} <small>地面上方</small></span><strong data-testid="flight-altitude">{positionValue(position.altitudeAboveGroundM)}</strong></div>
              <div className="flight-position-coordinates">
                <span data-testid="flight-position-x">X 左右 <b data-testid="flight-position-right">{positionValue(position.rightM, true)}</b></span>
                <span data-testid="flight-position-y">Y 上下 <b data-testid="flight-position-up">{positionValue(position.upM, true)}</b></span>
                <span>Z 前後 <b data-testid="flight-position-z">{positionValue(position.zM, true)}</b></span>
              </div>
              <small>相對起飛點 · −Z 為前方 · 單位 m</small>
              </div>
              {showRecoveryHud && <div className="flight-recovery-hud" role="group" aria-label="恢復練習數值">
                <strong>{telemetry?.replay.active ? '回放恢復數值' : '即時恢復數值'}</strong>
                <div>
                  <span>傾斜角<b data-testid="recovery-tilt">{format(recoveryMotion?.tiltDegrees, 1)}°</b></span>
                  <span>升降速度<b data-testid="recovery-vertical-speed">{format(recoveryMotion?.verticalSpeedMps, 1)} m/s</b></span>
                  <span>水平速度<b data-testid="recovery-horizontal-speed">{format(recoveryMotion?.horizontalSpeedMps, 1)} m/s</b></span>
                </div>
              </div>}
              {showRollHud && <div className="flight-recovery-hud" role="group" aria-label="橫滾練習數值">
                <strong>{telemetry?.replay.active ? '回放橫滾數值' : '即時橫滾數值'} · 右滾＋</strong>
                <div>
                  <span>本圈進度<b data-testid="roll-progress">{format(rollProgress ?? 0, 0)}°</b></span>
                  <span>橫滾速度<b data-testid="roll-rate">{format(rollRate, 1)}°/s</b></span>
                  <span>機身傾角<b data-testid="roll-tilt">{format(rollMotion?.tiltDegrees, 1)}°</b></span>
                </div>
              </div>}
              {showFlipHud && <div className="flight-recovery-hud" role="group" aria-label="翻轉練習數值">
                <strong>{telemetry?.replay.active ? '回放翻轉數值' : '即時翻轉數值'} · 前翻＋</strong>
                <div>
                  <span>本圈進度<b data-testid="flip-progress">{format(flipProgress ?? 0, 0)}°</b></span>
                  <span>俯仰速度<b data-testid="flip-rate">{format(flipMotion?.flipRateDegreesPerSecond, 1)}°/s</b></span>
                  <span>機身傾角<b data-testid="flip-tilt">{format(flipMotion?.tiltDegrees, 1)}°</b></span>
                </div>
              </div>}
              {showLoopHud && <div className="flight-recovery-hud" role="group" aria-label="大迴旋即時狀態">
                <strong>{telemetry?.replay.active ? '回放大迴旋數值' : '即時大迴旋數值'}</strong>
                <div>
                  <span>俯仰進度<b data-testid="loop-progress">{format(loopMetrics?.loopProgressDegrees ?? 0, 0)}°</b></span>
                  <span>迴圈高度<b data-testid="loop-height">{format(loopMetrics?.loopHeightGainM ?? 0, 1)} m</b></span>
                  <span>前後跨度<b data-testid="loop-span">{format(loopMetrics?.loopForwardSpanM ?? 0, 1)} m</b></span>
                </div>
              </div>}
              {showSplitHud && <div className="flight-recovery-hud" role="group" aria-label="破S即時狀態">
                <strong>{telemetry?.replay.active ? '回放破S數值' : '即時破S數值'}</strong>
                <div>
                  <span>半圈橫滾<b data-testid="split-roll">{format(splitMetrics?.splitRollProgressDegrees ?? 0, 0)}°</b></span>
                  <span>下拉俯仰<b data-testid="split-pitch">{format(splitMetrics?.splitPitchProgressDegrees ?? 0, 0)}°</b></span>
                  <span>本段下降<b data-testid="split-descent">{format(splitMetrics?.splitHeightLossM ?? 0, 1)} m</b></span>
                </div>
              </div>}
              {showOrbitHud && <div className="flight-recovery-hud" role="group" aria-label="正刷鍋即時狀態">
                <strong>{telemetry?.replay.active ? '回放正刷鍋數值' : '即時正刷鍋數值'}</strong>
                <div>
                  <span>已完成圈數<b data-testid="orbit-laps">{format(orbitMetrics?.orbitCompletedLaps ?? 0, 0)} / 5 圈</b><small>累積 <span data-testid="orbit-progress">{format(orbitMetrics?.orbitProgressDegrees ?? 0, 0)}°</span></small></span>
                  <span>繞行半徑<b data-testid="orbit-radius">{format(orbitMetrics?.orbitRadiusM, 1)} m</b></span>
                  <span>機頭偏差<b data-testid="orbit-heading">{format(orbitMetrics?.orbitHeadingErrorDegrees, 0)}°</b></span>
                </div>
              </div>}
            </div>
            {renderingState !== 'ready' && (
              <div className="flight-rendering-error" role="alert" data-testid="flight-rendering-error">
                <strong>3D viewport unavailable</strong>
                <span>{renderingState === 'initializing' ? 'Starting the WebGL renderer…' : renderingError}</span>
                {renderingState !== 'initializing' && <span>Flight is disarmed and Arm is blocked until the viewport recovers.</span>}
                {renderingState !== 'initializing' && (
                  <button className="lab-button lab-button-small" type="button" onClick={retryRendering}>Retry rendering</button>
                )}
              </div>
            )}
            {renderingState === 'ready' && !telemetry?.armed && !telemetry?.replay.active && (
              <div className="flight-safe-overlay">
                {telemetry?.state.crashed ? collisionCause
                  ? `${collisionCause} · 請按 Reset 重設後重試`
                  : 'CRASHED / reset required before re-arming' : trainingArmBlocked ? '倒數準備中 · 請保持低油門' : trainingState?.phase === 'WAITING_FOR_ARM' ? '準備完成 · 按 Arm 開始，尚未計時' : 'SAFE / explicit arm required'}
              </div>
            )}
            {renderingState === 'ready' && telemetry?.replay.active && <div className="flight-safe-overlay" aria-label={demonstrationProgress ? '目前示範步驟' : undefined}>{demonstrationProgress
              ? demonstrationProgress.complete ? `示範完成 ${demonstrationProgress.completedSteps}／${demonstrationProgress.totalSteps} 步 · 觀看不計成績`
                : `示範第 ${(demonstrationProgress.currentStepIndex ?? 0) + 1}／${demonstrationProgress.totalSteps} 步：${demonstrationProgress.currentStepTitle}`
              : demonstration ? demonstration.title : '飛行回放'} · 真人飛行已停止</div>}
            {trainingState?.phase === 'ACTIVE' && <div tabIndex={0} aria-label="目前練習提示" className={`school-viewport-hint${recovery ? ' is-recovering' : ''}`}>{recovery
              ? <><strong>重練原因（當時數值）：{recovery.message}</strong><span>{recovery.hint}</span></>
              : currentObjective && trainingState.lastEvaluation?.recovery !== 'restart' ? <><strong>{currentObjective.title}</strong><span>{trainingState.lessonId === 'direction-control' || trainingState.lessonId === 'coordinated-turn' || trainingState.lessonId === 'square-route' || trainingState.lessonId === 'figure-eight' || trainingState.lessonId === 'wide-gate' || trainingState.lessonId === 'basic-recovery' || trainingState.lessonId === 'full-roll' || isFlipLesson(trainingState.lessonId) || trainingState.lessonId === 'power-loop' || trainingState.lessonId === 'split-s' || trainingState.lessonId === 'orbit' || !trainingState.lastEvaluation?.hint ? currentObjective.detail : trainingHint(trainingState.lessonId, trainingState.lastEvaluation)}</span></> : trainingHint(trainingState.lessonId, trainingState.lastEvaluation)}</div>}
          </div>
          <div className="flight-controls" aria-label="Flight controls">
            <div className="flight-control-group">
              <label htmlFor="flight-input-source">控制方式</label>
              <select
                id="flight-input-source"
                disabled={trainingSettingsLocked || Boolean(telemetry?.replay.active)}
                value={source}
                onChange={(event) => setSource(event.target.value as FlightInputSource)}
              >
                <option value="controller">USB 遙控器（需校正）</option>
                <option value="keyboard">鍵盤體驗</option>
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
              <button className="lab-button lab-button-primary" type="button" onClick={arm} disabled={Boolean(trainingArmBlocked || renderingState !== 'ready' || telemetry?.armed || telemetry?.state.crashed || telemetry?.replay.active)}>
                Arm
              </button>
              <button className="lab-button" type="button" onClick={disarm} disabled={!telemetry?.armed || Boolean(telemetry?.replay.active)}>
                Disarm
              </button>
              <button className="lab-button" type="button" onClick={reset}>
                {telemetry?.state.crashed ? 'Reset crashed drone' : 'Reset'}
              </button>
            </div>
          </div>
          {cameraMode === 'free' && <div className="free-camera-help" id="free-camera-help" role="group" aria-label="自由鏡頭操作">
            <div><strong>自由鏡頭</strong><button className="lab-button lab-button-small" type="button" disabled={renderingState !== 'ready'} onClick={() => {
              rendererRef.current?.focusFreeCamera?.()
              canvasRef.current?.focus({ preventScroll: true })
            }}>定位飛機</button></div>
            <div className="free-camera-height-controls" role="group" aria-label="鏡頭移動控制">
              <button className="lab-button lab-button-small" type="button" disabled={renderingState !== 'ready'} onClick={() => rendererRef.current?.moveFreeCameraVertically(1)}>升高鏡頭 1 m</button>
              <button className="lab-button lab-button-small" type="button" disabled={renderingState !== 'ready'} onClick={() => rendererRef.current?.moveFreeCameraVertically(-1)}>降低鏡頭 1 m</button>
              <button className="lab-button lab-button-small" type="button" disabled={renderingState !== 'ready'} onClick={() => rendererRef.current?.moveFreeCameraHorizontally(0, 1)}>前移鏡頭 1 m</button>
              <button className="lab-button lab-button-small" type="button" disabled={renderingState !== 'ready'} onClick={() => rendererRef.current?.moveFreeCameraHorizontally(0, -1)}>後移鏡頭 1 m</button>
              <button className="lab-button lab-button-small" type="button" disabled={renderingState !== 'ready'} onClick={() => rendererRef.current?.moveFreeCameraHorizontally(-1, 0)}>左移鏡頭 1 m</button>
              <button className="lab-button lab-button-small" type="button" disabled={renderingState !== 'ready'} onClick={() => rendererRef.current?.moveFreeCameraHorizontally(1, 0)}>右移鏡頭 1 m</button>
              <span>每按一次移動 1 公尺；前後左右依鏡頭朝向沿水平面移動，保持觀看角度。</span>
            </div>
            <p>左鍵拖曳旋轉 · 右鍵或 Shift＋左鍵拖曳平移 · 滾輪拉近／拉遠。</p>
            <p>點選 3D 畫面後：方向鍵前後左右移動，Page Up／Down 升降，Shift＋方向鍵旋轉，＋／－拉近拉遠，Home 定位飛機。</p>
            <small>畫面中的高度與 XYZ 是飛機位置；升降鏡頭不會改變飛機。選用鍵盤飛行時，WASD、Q／E、R／F、X 仍是飛行及重設按鍵。</small>
          </div>}
          {visibleResultReplay && <section className="school-result-replay" aria-label="本次結果回放">
            <strong>本次結果回放</strong>
            <p>點選步驟查看該次錄影，會停止目前飛行並暫停在標記位置。重新整理會清除錄影。</p>
            <div className="school-result-replay-markers">{visibleResultReplay.markers.map((marker) => <button
              className="lab-button lab-button-small" type="button" key={marker.id}
              aria-label={`回放：${marker.label}`}
              disabled={marker.timeSeconds === null || trainingSettingsLocked}
              onClick={() => replayResultMarker(marker)}
            >{marker.label}{marker.timeSeconds === null ? '（片段未保留）' : ` · ${marker.timeSeconds.toFixed(2)} s`}</button>)}</div>
            {visibleResultReplay.notice && <p className="school-prototype-note">{visibleResultReplay.notice}</p>}
          </section>}
          <section className="flight-replay-card" aria-labelledby="flight-replay-title">
            <div className="flight-card-heading">
              <div>
                <p className="panel-kicker">Bounded last flight</p>
                <h3 id="flight-replay-title">{demonstration ? '同步教學示範' : telemetry?.replay.active && playingResultSession ? '結果標記播放' : '飛行回放'}</h3>
              </div>
              <span className={telemetry?.replay.active ? 'flight-pass' : 'flight-warn'}>
                {telemetry?.replay.active ? 'PLAYBACK' : telemetry?.replay.available ? 'READY' : 'EMPTY'}
              </span>
            </div>
            <p className="flight-replay-note">
              {demonstration ? `${demonstration.description} · 模擬示範，尚待真人飛手驗證。` : '僅保留本次頁面的最後一段飛行，重新整理會清除。播放不會影響成績。'}
            </p>
            <div className="flight-replay-actions">
              {!telemetry?.replay.active ? (
                <button className="lab-button lab-button-primary" type="button" onClick={enterReplay} disabled={!telemetry?.replay.available}>
                  Enter replay
                </button>
              ) : (
                <>
                  <button className="lab-button lab-button-primary" type="button" onClick={telemetry.replay.playing ? pauseReplay : playReplay}>
                    {telemetry.replay.playing ? 'Pause' : 'Play'}
                  </button>
                  <button className="lab-button" type="button" onClick={exitReplay}>{demonstration ? '結束示範／回到練習' : '結束回放／回到練習'}</button>
                </>
              )}
            </div>
            {telemetry?.replay.active && (
              <>
                <label className="flight-replay-seek" htmlFor="flight-replay-timeline">
                  <span>Timeline {format(telemetry.replay.currentTimeSeconds, 2)} / {format(telemetry.replay.durationSeconds, 2)} s</span>
                  <input
                    id="flight-replay-timeline"
                    type="range"
                    min={0}
                    max={Math.max(telemetry.replay.durationSeconds, 0.01)}
                    step="any"
                    value={Math.min(telemetry.replay.currentTimeSeconds, Math.max(telemetry.replay.durationSeconds, 0.01))}
                    onChange={(event) => seekReplay(Number(event.target.value))}
                  />
                </label>
                <div className="flight-replay-speeds" aria-label="Replay speed">
                  <span>Speed</span>
                  {REPLAY_SPEEDS.map((speed) => (
                    <button
                      className={`lab-button lab-button-small ${telemetry.replay.speed === speed ? 'flight-camera-selected' : ''}`}
                      type="button"
                      key={speed}
                      aria-pressed={telemetry.replay.speed === speed}
                      onClick={() => setReplaySpeed(speed)}
                    >
                      {speed}×
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
          {demonstrationProgress && !lessonPanel && <DemonstrationProgress progress={demonstrationProgress} onSeekStep={seekDemonstrationStep} />}
          {demonstration && telemetry?.replay.active && <p className="school-demo-cue" aria-live="polite">{teachingCueAt(demonstration, telemetry.replay.currentTimeSeconds)}</p>}
          {source === 'keyboard' && (
            <p className="flight-input-note">
              鍵盤：W/S 俯仰 · A/D 橫滾 · Q/E 偏航 · R/F 油門 · X 重設。鍵盤是離散輸入；細緻操控練習建議使用 USB 遙控器。
            </p>
          )}
        </div>

        <aside className="flight-side-panel">
          <Mode2StickOverlay input={playbackInput} mode={telemetry?.replay.active ? 'demonstration' : 'live'} compact />
          <section className="flight-safety-card" aria-labelledby="flight-safety-title">
            <div className="flight-card-heading">
              <h3 id="flight-safety-title">解鎖條件</h3>
              <span className={telemetry?.armed ? 'flight-pass' : 'flight-warn'}>{telemetry?.armed ? 'PASS' : 'LOCKED'}</span>
            </div>
            <p>{profile ? '校正資料已就緒；仍需當次連線驗證、低油門與中立搖桿。' : '先完成下方設備校正，或選擇鍵盤體驗。'}</p>
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
        <span>{telemetry?.state.crashed ? 'CRASHED' : telemetry?.armed ? 'ARMED' : 'DISARMED'}</span>
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
