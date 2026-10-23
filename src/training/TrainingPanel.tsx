import { useEffect, useRef } from 'react'

import { DEFAULT_LESSONS } from './lessons'
import { lessonLearningContent } from './catalog'
import { formatTrainingMetrics, trainingHint, trainingObjective, trainingRouteGuide } from './feedback'
import { summarizeTrainingResult } from './resultFeedback'
import DemonstrationProgress from './TeachingDemonstrationProgress'
import type { TeachingDemonstrationProgressSnapshot } from './demonstrationProgress'
import type { NormalizedRcInput } from '../flight-controller'
import type { LessonDefinition, TrainingMachineState, TrainingProgressDocument } from './types'

export interface TrainingPanelProps {
  readonly mode?: 'practice' | 'challenge'
  readonly lessons?: readonly LessonDefinition[]
  readonly state: TrainingMachineState
  readonly progress: TrainingProgressDocument
  readonly progressNotice?: string | null
  readonly liveInput?: NormalizedRcInput | null
  readonly playbackActive?: boolean
  readonly demonstrationProgress?: TeachingDemonstrationProgressSnapshot | null
  readonly onSeekDemonstrationStep?: (timeSeconds: number) => void
  readonly onSelectLesson: (lessonId: string) => void
  readonly onStart: () => void
  readonly onRetry: () => void
  readonly onReset: () => void
}

const PHASE_LABELS: Record<TrainingMachineState['phase'], string> = {
  READY: '準備選課', COUNTDOWN: '倒數準備', WAITING_FOR_ARM: '等待解鎖',
  ACTIVE: '練習進行中', SUCCESS: '完成', FAILED: '練習結束', RESULT: '練習結果',
}

export default function TrainingPanel({ mode = 'challenge', lessons = DEFAULT_LESSONS, state, progress, progressNotice, playbackActive = false, demonstrationProgress = null, onSeekDemonstrationStep, onSelectLesson, onStart, onRetry, onReset }: TrainingPanelProps) {
  const selected = lessons.find((lesson) => lesson.id === state.lessonId) ?? null
  const content = selected ? lessonLearningContent(selected.id) : null
  const locked = ['COUNTDOWN', 'WAITING_FOR_ARM', 'ACTIVE'].includes(state.phase)
  const terminal = ['RESULT', 'SUCCESS', 'FAILED'].includes(state.phase)
  const remaining = Math.max(0, (state.countdownEndsAtSeconds ?? 0) - (state.lastTimestampSeconds ?? 0))
  const metrics = formatTrainingMetrics(state.result?.metrics ?? state.lastEvaluation?.metrics ?? {}, selected?.id)
  const activeMode = state.phase === 'READY' ? mode : state.result?.attemptContext?.mode ?? state.attemptContext?.mode ?? mode
  const saved = selected ? progress.lessons[selected.id] : null
  const ordered = lessons.slice().sort((a, b) => a.priority - b.priority)
  const nextLesson = selected ? ordered[ordered.findIndex((lesson) => lesson.id === selected.id) + 1] : null
  const resultFeedback = state.result ? summarizeTrainingResult(state.result) : null
  const objective = trainingObjective(selected?.id ?? null, state.lastEvaluation)
  const routeGuide = trainingRouteGuide(selected?.id ?? null)
  const showingDemonstration = playbackActive && demonstrationProgress !== null
  const panelRef = useRef<HTMLElement | null>(null)
  const liveScrollTopRef = useRef<number | null>(null)
  const wasShowingDemonstrationRef = useRef(false)
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (showingDemonstration) {
      if (!wasShowingDemonstrationRef.current && liveScrollTopRef.current === null) {
        liveScrollTopRef.current = panel.scrollTop
      }
      panel.scrollTop = 0
    } else if (wasShowingDemonstrationRef.current) {
      panel.scrollTop = liveScrollTopRef.current ?? 0
    }
    wasShowingDemonstrationRef.current = showingDemonstration
  }, [showingDemonstration, demonstrationProgress?.kind])
  return (
    <section ref={panelRef} className="school-course-panel" id="training" aria-labelledby="training-title"
      onScroll={(event) => { if (!showingDemonstration) liveScrollTopRef.current = event.currentTarget.scrollTop }}>
      {showingDemonstration && <DemonstrationProgress progress={demonstrationProgress} onSeekStep={onSeekDemonstrationStep} />}
      <div className="school-course-heading"><p className="panel-kicker">循序練習 · 可自由選課</p><h2 id="training-title">今天練習哪個動作？</h2></div>
      <label className="school-lesson-label" htmlFor="school-lesson">選擇課程</label>
      <select id="school-lesson" value={state.lessonId ?? ''} disabled={locked || playbackActive} onChange={(event) => onSelectLesson(event.target.value)}>
        {lessons.slice().sort((a, b) => a.priority - b.priority).map((lesson) => <option key={lesson.id} value={lesson.id} disabled={!lesson.available}>{lessonLearningContent(lesson.id)?.code} · {lessonLearningContent(lesson.id)?.title ?? lesson.title}</option>)}
      </select>
      <div className="school-course-actions">
        {state.phase === 'READY' && <button className="lab-button lab-button-primary" type="button" disabled={!selected?.available || playbackActive} onClick={onStart}>開始課程</button>}
        {terminal && <button className="lab-button lab-button-primary" type="button" disabled={playbackActive} onClick={onRetry}>再練一次</button>}
        <button className="lab-button" type="button" disabled={state.phase === 'READY' || playbackActive} onClick={onReset}>{locked ? '停止練習' : '重設課程'}</button>
      </div>
      {!showingDemonstration && state.lastRecovery && <div className="school-recovery-history" role="region" aria-label="最近重練原因">
        <strong>最近重練原因（當時數值）</strong>
        <p>{state.lastRecovery.message}</p>
        {state.lastRecovery.hint && <p>下一步：{state.lastRecovery.hint}</p>}
      </div>}
      <div className="school-current-lesson"><span className="school-phase" role="status">{showingDemonstration ? '示範播放中' : PHASE_LABELS[state.phase]}</span><h3>{showingDemonstration ? demonstrationProgress.title : content?.title ?? selected?.title ?? '選擇課程'}</h3>{!showingDemonstration && <p>{content?.objectives[0] ?? selected?.description}</p>}</div>
      {!showingDemonstration && routeGuide && state.phase === 'READY' && <p className="school-route-guide">{routeGuide}</p>}
      {!showingDemonstration && objective && !terminal && <div className="school-objective" aria-label="目前任務" aria-live="polite"><strong>{objective.title}</strong><p>{objective.detail}</p></div>}
      {!showingDemonstration && content && <p className="school-prototype-note">建議先備：{content.prerequisiteIds.length ? content.prerequisiteIds.map((id) => id === 'intro' ? 'L00 四軸與 Acro' : lessonLearningContent(id)?.title ?? id).join('、') : '可從這一課開始'}；仍可自由選課。</p>}
      {!showingDemonstration && selected && <ol className="school-checkpoints" aria-label="本課步驟">{selected.checkpoints.map((checkpoint) => <li key={checkpoint.id} className={state.checkpoints[checkpoint.id]?.completed ? 'is-complete' : ''}>{state.checkpoints[checkpoint.id]?.completed ? '✓' : '○'} {checkpoint.title}</li>)}</ol>}
      {!showingDemonstration && state.phase === 'READY' && <p className="school-next-action">先看上方示範，再開始課程。倒數後請自行按 Arm 解鎖。</p>}
      {!showingDemonstration && state.phase === 'COUNTDOWN' && <p className="school-next-action" aria-live="polite">準備 {remaining.toFixed(1)} 秒 · 保持低油門，倒數期間無法解鎖。</p>}
      {!showingDemonstration && state.phase === 'WAITING_FOR_ARM' && <p className="school-next-action" aria-live="polite">{state.requiresDisarmBeforeArm ? '請先 Disarm，確認低油門後再解鎖。' : '準備完成。按飛行畫面下方 Arm 解鎖，等待不會消耗練習時間。'}</p>}
      {!showingDemonstration && state.phase === 'ACTIVE' && <p className="school-live-hint" aria-live="polite">{trainingHint(selected?.id ?? null, state.lastEvaluation)}</p>}
      {!showingDemonstration && metrics.length > 0 && <dl className="school-metrics">{metrics.map((metric) => <div key={metric.key}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>}
      {!showingDemonstration && state.result && <div className="school-result" aria-live="polite"><strong>{state.result.outcome === 'SUCCESS' ? activeMode === 'practice' ? '引導目標完成！' : '本課完成！' : '這次練習已結束'}</strong><p>{state.result.score.toFixed(0)} 分 · {state.result.elapsedSeconds.toFixed(1)} 秒</p><p>{state.result.outcome === 'SUCCESS' ? '你已完成本課步驟，可以再練一次確認穩定度。' : trainingHint(selected?.id ?? null, state.lastEvaluation)}</p>{state.result.attemptContext && <p>本次條件：{state.result.attemptContext.mode === 'practice' ? '引導練習' : '能力挑戰'} · {state.result.attemptContext.presetId === 'beginner' ? '新手' : state.result.attemptContext.presetId === 'standard' ? '一般' : '自訂'}設定 · {state.result.attemptContext.inputSource === 'keyboard' ? '鍵盤' : '遙控器'}</p>}<span>{state.result.completedCheckpoints} / {state.result.totalCheckpoints} 個步驟完成</span></div>}
      {!showingDemonstration && resultFeedback && <div className="school-result-feedback">
        {resultFeedback.observedStrength && <p>觀察到的表現：{resultFeedback.observedStrength}</p>}
        {resultFeedback.observedGap && <p>待改善的項目：{resultFeedback.observedGap}</p>}
        <p>下一次練習：{resultFeedback.nextPractice}</p>
        <p className="school-prototype-note">{resultFeedback.scopeNote}</p>
      </div>}
      {!showingDemonstration && state.result?.outcome === 'SUCCESS' && nextLesson && <button className="lab-button lab-button-small" type="button" disabled={playbackActive} onClick={() => onSelectLesson(nextLesson.id)}>下一課：{lessonLearningContent(nextLesson.id)?.code} {lessonLearningContent(nextLesson.id)?.title ?? nextLesson.title}</button>}
      {!showingDemonstration && saved && <p className="school-progress">本次條件已練 {saved.attempts} 次 · 最佳 {saved.best ? `${saved.best.score.toFixed(0)} 分` : '尚無完成紀錄'}</p>}
      {!showingDemonstration && <details className="school-lesson-notes"><summary>操作原理與常見錯誤</summary><ul>{content?.steps.map((step) => <li key={step}>{step}</li>)}</ul><p>{content?.commonMistakes[0]}</p></details>}
      {!showingDemonstration && <p className="school-prototype-note">{activeMode === 'practice' ? '引導練習不限時；一般偏離可重練局部目標，成績與能力挑戰分開。' : '能力挑戰有時限與明確完成條件。'}門檻尚待真人校準；示範不算通關。</p>}
      {!showingDemonstration && (state.lastError || progressNotice) && <p className="training-error">{state.lastError ? '練習已停止或資料尚未就緒，請重設後再試。' : progressNotice}</p>}
    </section>
  )
}

export { TrainingPanel }
