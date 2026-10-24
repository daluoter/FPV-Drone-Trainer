import { useCallback, useMemo, useRef, useState } from 'react'

import { createBrowserGamepadPoller } from '../controller'
import ControllerLab, { type ControllerLabFlightHandoff } from '../controller/ControllerLab'
import FreeFlight from '../free-flight/FreeFlight'
import {
  LEARNING_LESSONS,
  TrainingPanel,
  TrainingProgressStore,
  TrainingSession,
  type TrainingMachineState,
  type TrainingSceneReference,
} from '../training'
import TuningPanel from '../tuning/TuningPanel'
import {
  copyTuningSettings,
  createTuningPreset,
  identifyTuningPreset,
  TuningSettingsStore,
  type TuningPersistenceResult,
  type TuningSettings,
} from '../tuning'
import type { FlightRuntimeFixedStepSample, FlightRuntimeTelemetry } from '../runtime'
import IntroLesson from '../training/IntroLesson'
import type { TeachingDemonstrationKind } from '../training/demonstrations'
import type { TeachingDemonstrationProgressSnapshot } from '../training/demonstrationProgress'
import DemonstrationProgress from '../training/TeachingDemonstrationProgress'
import { loadLearningPreferences, saveLearningPreferences, type LearningPreferences } from '../training/learningPreferences'
import { fingerprintTrainingSettings, trainingRulesVersionForLesson, type TrainingAttemptContext } from '../training/attempt'
import { prepareTrainingSetup } from '../training/setup'
import { APP_RELEASE } from './release'

function resultStateForUi(session: TrainingSession, state: TrainingMachineState): TrainingMachineState {
  return state.result && (state.phase === 'SUCCESS' || state.phase === 'FAILED')
    ? session.showResult()
    : state
}

export default function App() {
  const initialLearning = useMemo(() => loadLearningPreferences(), [])
  const [learningPreferences, setLearningPreferences] = useState(initialLearning.preferences)
  const [preferencesNotice, setPreferencesNotice] = useState(initialLearning.error)
  const [showIntro, setShowIntro] = useState(false)
  const [demonstrationRequest, setDemonstrationRequest] = useState<{ sequence: number; kind: TeachingDemonstrationKind } | null>(null)
  const [exitPlaybackRequest, setExitPlaybackRequest] = useState(0)
  const poller = useMemo(() => createBrowserGamepadPoller(), [])
  const tuningStore = useMemo(() => new TuningSettingsStore(), [])
  const initialTuningLoad = useMemo(() => tuningStore.load(), [tuningStore])
  const [customSettings, setCustomSettings] = useState(initialTuningLoad.settings)
  const [tuningSettings, setTuningSettings] = useState(() => initialTuningLoad.loaded ? initialTuningLoad.settings : createTuningPreset('beginner'))
  const [tuningNotice] = useState<string | null>(() => initialTuningLoad.errors.length > 0
    ? 'Saved tuning was unavailable or incompatible; bounded defaults are active.'
    : null)
  const [flightProfile, setFlightProfile] = useState<ControllerLabFlightHandoff['profile']>(null)
  const progressStore = useMemo(() => new TrainingProgressStore(), [])
  const initialProgressLoad = useMemo(() => progressStore.load(), [progressStore])
  const trainingSessionRef = useRef<TrainingSession | null>(null)
  if (trainingSessionRef.current === null) {
    trainingSessionRef.current = new TrainingSession({ lessons: LEARNING_LESSONS, initialLessonId: LEARNING_LESSONS.some((lesson) => lesson.id === initialLearning.preferences.lastLessonId) ? initialLearning.preferences.lastLessonId : 'takeoff' })
  }
  const [trainingState, setTrainingState] = useState<TrainingMachineState>(
    () => trainingSessionRef.current?.getState() ?? new TrainingSession({ lessons: LEARNING_LESSONS }).getState(),
  )
  const [progressRevision, setProgressRevision] = useState(0)
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null)
  const [inputSource, setInputSource] = useState<'controller' | 'keyboard'>('controller')
  const [flightBusy, setFlightBusy] = useState(false)
  const [playbackActive, setPlaybackActive] = useState(false)
  const [demonstrationProgress, setDemonstrationProgress] = useState<TeachingDemonstrationProgressSnapshot | null>(null)
  const [demonstrationSeekRequest, setDemonstrationSeekRequest] = useState<{ sequence: number; timeSeconds: number } | null>(null)
  const seekDemonstrationStep = useCallback((timeSeconds: number) => {
    setDemonstrationSeekRequest((previous) => ({ sequence: (previous?.sequence ?? 0) + 1, timeSeconds }))
  }, [])
  const [workspace, setWorkspace] = useState<'learning' | 'free'>('learning')
  const [showSetup, setShowSetup] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const attemptContext = useMemo<TrainingAttemptContext>(() => ({ rulesVersion: trainingRulesVersionForLesson(trainingState.lessonId), physicsVersion: 1, presetId: identifyTuningPreset(tuningSettings), settingsFingerprint: fingerprintTrainingSettings(tuningSettings), inputSource, mode: learningPreferences.mode, assistance: 'none' }), [trainingState.lessonId, tuningSettings, inputSource, learningPreferences.mode])
  const progressContext = trainingState.result?.attemptContext ?? attemptContext
  const progressLoad = useMemo(() => progressStore.loadCurrent(progressContext), [progressStore, progressContext, progressRevision])
  const trainingProgress = progressLoad.progress
  const [trainingResetKey, setTrainingResetKey] = useState(0)
  const [trainingDisarmKey, setTrainingDisarmKey] = useState(0)
  const recordedTrainingSessionRef = useRef<string | null>(null)
  const trainingUiLastPublishedSecondsRef = useRef<number | null>(null)
  const trainingUiCheckpointKeyRef = useRef('')
  const onFlightHandoff = useCallback((handoff: ControllerLabFlightHandoff) => {
    setFlightProfile(handoff.profile)
  }, [])
  const syncTrainingState = useCallback((next: TrainingMachineState) => {
    setTrainingState(next)
    if (!next.result || recordedTrainingSessionRef.current === next.result.sessionId) return
    const persisted = progressStore.recordResult(next.result)
    if (persisted.saved) {
      recordedTrainingSessionRef.current = next.result.sessionId
      setPersistenceNotice(null)
      setProgressRevision((value) => value + 1)
    } else {
      setPersistenceNotice('結果仍在本次頁面，但未成功保存。原有資料未被清除；請檢查瀏覽器儲存空間。')
    }
  }, [progressStore])
  const onTrainingSceneReferences = useCallback((sceneReferences: readonly TrainingSceneReference[]) => {
    const session = trainingSessionRef.current
    if (!session) return
    syncTrainingState(session.setSceneReferences(sceneReferences))
  }, [syncTrainingState])
  const onTrainingFixedStep = useCallback((sample: FlightRuntimeFixedStepSample) => {
    const session = trainingSessionRef.current
    if (!session) return
    const previous = session.getState()
    const next = session.consumeSample({
      timestampSeconds: sample.timestampSeconds,
      state: sample.state,
      normalizedInput: sample.normalizedInput,
      armed: sample.armed,
      groundContact: sample.groundContact,
    })
    if (next === previous) return
    const displayState = resultStateForUi(session, next)

    const checkpointKey = Object.values(displayState.checkpoints)
      .map((checkpoint) => `${checkpoint.id}:${checkpoint.completed}:${checkpoint.completedAtSeconds ?? ''}`)
      .join('|')
    const phaseChanged = displayState.phase !== previous.phase
    const resultChanged = displayState.result !== previous.result
    const checkpointChanged = checkpointKey !== trainingUiCheckpointKeyRef.current
    const lastPublishedSeconds = trainingUiLastPublishedSecondsRef.current
    const throttledMetricUpdate = lastPublishedSeconds === null || sample.timestampSeconds - lastPublishedSeconds >= 0.1
    if (phaseChanged || resultChanged || checkpointChanged || throttledMetricUpdate) {
      syncTrainingState(displayState)
      trainingUiLastPublishedSecondsRef.current = sample.timestampSeconds
      trainingUiCheckpointKeyRef.current = checkpointKey
    }
    // The fixed-step hook still feeds every sample to the pure session without
    // creating a second loop; only the React publication is throttled.
  }, [syncTrainingState])
  const onTrainingTelemetry = useCallback((telemetry: FlightRuntimeTelemetry) => {
    setInputSource(telemetry.source)
    setFlightBusy(telemetry.armed || telemetry.replay.active)
    setPlaybackActive(telemetry.replay.active)
    const session = trainingSessionRef.current
    if (!session) return
    const pendingState = session.getState()
    const phase = pendingState.phase
    if ((phase === 'COUNTDOWN' || phase === 'WAITING_FOR_ARM')
      && telemetry.state.timeSeconds < (pendingState.lastTimestampSeconds ?? 0)) {
      syncTrainingState(session.reset())
      return
    }
    if (telemetry.replay.active) {
      // Replay has no fixed-step training feed. An in-progress attempt is
      // ended at this explicit presentation boundary; terminal results remain
      // available for review while the ghost is playing.
      if (phase === 'ACTIVE') {
        const aborted = session.abort(
          'Replay opened; the active lesson was aborted before playback.',
          telemetry.state.timeSeconds,
        )
        syncTrainingState(resultStateForUi(session, aborted))
      } else if (phase === 'COUNTDOWN' || phase === 'WAITING_FOR_ARM') {
        syncTrainingState(session.reset())
      }
      return
    }
    if (telemetry.armed) return
    if (phase === 'ACTIVE' && session.getState().armedAtLeastOnce === true) {
      const aborted = session.abort(
        telemetry.safetyReasons[0] ?? 'The flight was disarmed, reset, or focus was lost; the attempt was stopped safely.',
        telemetry.state.timeSeconds,
      )
      syncTrainingState(resultStateForUi(session, aborted))
    }
  }, [syncTrainingState])
  const persistLearning = useCallback((next: LearningPreferences) => {
    setLearningPreferences(next)
    setPreferencesNotice(saveLearningPreferences(next).error)
  }, [])
  const selectTrainingLesson = useCallback((lessonId: string) => {
    const session = trainingSessionRef.current
    if (!session) return
    trainingUiLastPublishedSecondsRef.current = null
    trainingUiCheckpointKeyRef.current = ''
    persistLearning({ ...learningPreferences, lastLessonId: lessonId })
    syncTrainingState(session.selectLesson(lessonId))
    setTrainingDisarmKey((value) => value + 1)
  }, [syncTrainingState, learningPreferences, persistLearning])
  const startTraining = useCallback(() => {
    const session = trainingSessionRef.current
    if (!session) return
    trainingUiLastPublishedSecondsRef.current = null
    trainingUiCheckpointKeyRef.current = ''
    persistLearning({ ...learningPreferences, lastLessonId: session.getState().lessonId ?? 'takeoff' })
    setPersistenceNotice(null)
    syncTrainingState(session.start(0, attemptContext))
  }, [syncTrainingState, attemptContext, learningPreferences, persistLearning])
  const retryTraining = useCallback(() => {
    const session = trainingSessionRef.current
    if (!session) return
    trainingUiLastPublishedSecondsRef.current = null
    trainingUiCheckpointKeyRef.current = ''
    syncTrainingState(session.retry())
    setTrainingResetKey((key) => key + 1)
  }, [syncTrainingState])
  const resetTraining = useCallback(() => {
    const session = trainingSessionRef.current
    if (!session) return
    const previousPhase = session.getState().phase
    trainingUiLastPublishedSecondsRef.current = null
    trainingUiCheckpointKeyRef.current = ''
    syncTrainingState(session.reset())
    if (previousPhase === 'ACTIVE') {
      // ACTIVE reset must stop motor output without applying a spawn reset. The
      // runtime disarm boundary preserves the current pose and requires an
      // explicit arm action before flight can continue.
      setTrainingDisarmKey((key) => key + 1)
    } else {
      setTrainingResetKey((key) => key + 1)
    }
  }, [syncTrainingState])
  const trainingSettingsLocked = trainingState.phase === 'COUNTDOWN' || trainingState.phase === 'WAITING_FOR_ARM' || trainingState.phase === 'ACTIVE'
  const onTuningApply = useCallback((next: TuningSettings): TuningPersistenceResult => {
    if (trainingSettingsLocked) {
      return {
        saved: false,
        errors: ['Tuning changes are disabled while a lesson is counting down or active. Reset or end the lesson first.'],
      }
    }
    const result = tuningStore.save(next)
    if (result.saved) { setTuningSettings(copyTuningSettings(next)); setCustomSettings(copyTuningSettings(next)) }
    return result
  }, [trainingSettingsLocked, tuningStore])

  const preparedSetupRequest = useMemo(() => prepareTrainingSetup(trainingState.setupRequest, trainingState.sceneReferences), [trainingState.setupRequest, trainingState.sceneReferences])
  const selectedPreset = identifyTuningPreset(tuningSettings)
  const busy = trainingSettingsLocked || flightBusy
  const changePreset = (id: 'beginner' | 'standard' | 'custom'): void => {
    if (busy) return
    setTuningSettings(id === 'custom' ? copyTuningSettings(customSettings) : createTuningPreset(id, customSettings))
  }
  const revealSetup = (): void => {
    setShowSetup(true)
    requestAnimationFrame(() => document.getElementById('controller-lab')?.scrollIntoView({ behavior: 'smooth' }))
  }

  return (
    <div className="app-shell school-shell">
      <header className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="FPV Drone Trainer home">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span className="brand-name">FPV <strong>飛行學校</strong></span>
        </a>
        <nav className="school-navigation" aria-label="練習模式">
          <button type="button" aria-pressed={workspace === 'learning'} disabled={busy} onClick={() => { setWorkspace('learning'); setShowIntro(false) }}>{initialLearning.loaded ? '繼續練習' : '開始學飛'}</button>
          <button type="button" aria-pressed={workspace === 'free'} disabled={busy} onClick={() => setWorkspace('free')}>自由飛行</button>
          <button type="button" disabled={busy} onClick={revealSetup}>設備與校正</button>
        </nav>
      </header>
      <main>
        <section className="school-introduction">
          <div><p className="eyebrow">從第一次起飛開始 · <span data-testid="app-release">版本 {APP_RELEASE}</span></p><h1>小幅操作，一步步學會飛。</h1></div>
          <p>先看示範，理解四軸，再練習起飛。Acro 模式搖桿回中會停止旋轉，機體不會自動回平或煞停。</p>
        </section>
        <div className="school-toolbar">
          <label htmlFor="school-preset">操控設定</label>
          <select id="school-preset" value={selectedPreset} disabled={busy} onChange={(event) => changePreset(event.target.value as 'beginner' | 'standard' | 'custom')}>
            <option value="beginner">新手：低轉速、低鏡頭角度</option><option value="standard">一般：標準 Acro</option><option value="custom">原有自訂設定</option>
          </select>
          <label htmlFor="school-mode">學習方式</label>
          <select id="school-mode" value={learningPreferences.mode} disabled={busy} onChange={(event) => persistLearning({ ...learningPreferences, mode: event.target.value as 'practice' | 'challenge' })}>
            <option value="practice">引導練習（不限時）</option><option value="challenge">能力挑戰</option>
          </select>
          <button className="lab-button lab-button-small" id="school-open-intro" type="button" disabled={busy} onClick={() => setShowIntro((value) => !value)}>{showIntro ? '返回飛行課程' : learningPreferences.introCompleted ? 'L00 觀念複習 ✓' : 'L00 互動觀念課'}</button>
          <span>{inputSource === 'keyboard' ? '鍵盤體驗' : 'USB 遙控器'} · 成績依操控設定與輸入方式分開保存</span>
        </div>
        {preferencesNotice && <p className="school-help" role="status">{preferencesNotice}</p>}
        <FreeFlight
          poller={poller}
          profile={flightProfile}
          settings={tuningSettings}
          demonstrationRequest={demonstrationRequest}
          demonstrationSeekRequest={demonstrationSeekRequest}
          onDemonstrationProgress={setDemonstrationProgress}
          exitPlaybackRequest={exitPlaybackRequest}
          trainingResetKey={trainingResetKey}
          trainingDisarmKey={trainingDisarmKey}
          trainingSettingsLocked={trainingSettingsLocked}
          trainingArmBlocked={trainingState.phase === 'COUNTDOWN'}
          trainingSetupRequest={trainingState.phase === 'COUNTDOWN' ? preparedSetupRequest : null}
          trainingPath={trainingState.trajectory}
          onTrainingReset={resetTraining}
          trainingState={workspace === 'learning' && !showIntro ? trainingState : null}
          lessonPanel={workspace === 'learning' ? <div className="school-learning-sidebar"><div hidden={!showIntro}>{playbackActive && demonstrationProgress && <DemonstrationProgress progress={demonstrationProgress} onSeekStep={seekDemonstrationStep} />}<IntroLesson playbackActive={playbackActive} onExitPlayback={() => setExitPlaybackRequest((value) => value + 1)} disabled={busy} completed={learningPreferences.introCompleted} onDemonstrate={(kind) => setDemonstrationRequest((previous) => ({ sequence: (previous?.sequence ?? 0) + 1, kind }))} onComplete={() => { persistLearning({ ...learningPreferences, introCompleted: true }); setShowIntro(false) }} /></div><div hidden={showIntro}><TrainingPanel
            mode={learningPreferences.mode}
            state={trainingState}
            progress={trainingProgress}
            progressNotice={persistenceNotice ?? (progressLoad.errors.length > 0 ? '讀取紀錄遇到問題，原始資料仍保留。' : null)}
            onSelectLesson={selectTrainingLesson}
            onStart={startTraining}
            onRetry={retryTraining}
            onReset={resetTraining}
            playbackActive={playbackActive}
            demonstrationProgress={demonstrationProgress}
            onSeekDemonstrationStep={seekDemonstrationStep}
          /></div></div> : null}
          onSceneReferences={onTrainingSceneReferences}
          onFixedStep={onTrainingFixedStep}
          onTelemetry={onTrainingTelemetry}
        />
        <details className="school-settings" open={showSetup} onToggle={(event) => setShowSetup(event.currentTarget.open)}>
          <summary>設備設定與逐步校正</summary>
          <p className="school-help">接上 USB 遙控器並確認電腦辨識為搖桿，依下方完成中心、通道、端點與方向檢查。重新連線仍需完成當次穩定檢查。</p>
          <ControllerLab poller={poller} onFlightHandoff={onFlightHandoff} />
          <button className="lab-button" type="button" onClick={() => { setShowSetup(false); document.getElementById('free-flight')?.scrollIntoView({ behavior: 'smooth' }) }}>回到原課程</button>
        </details>
        <details className="school-settings" open={showAdvanced} onToggle={(event) => setShowAdvanced(event.currentTarget.open)}>
          <summary>進階調參與舊版紀錄</summary>
          <TuningPanel settings={tuningSettings} notice={tuningNotice} disabled={busy} onApply={onTuningApply} />
          <p className="school-help">{initialProgressLoad.errors.length > 0 ? '舊版紀錄暫時無法讀取，原始資料仍保留；' : `原有 v1 紀錄保留 ${Object.values(initialProgressLoad.progress.lessons).reduce((sum, value) => sum + value.attempts, 0)} 次練習；`}舊版未註明操控條件，不併入本次最佳成績。示範與課程門檻尚待真人試學驗證。</p>
        </details>
      </main>
    </div>
  )
}
