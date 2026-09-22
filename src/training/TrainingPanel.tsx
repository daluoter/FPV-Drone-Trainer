import type { NormalizedRcInput } from '../flight-controller'
import Mode2StickOverlay from './StickOverlay'
import { DEFAULT_LESSONS } from './lessons'
import type {
  LessonDefinition,
  LessonProgress,
  TrainingMachineState,
  TrainingProgressDocument,
} from './types'

export interface TrainingPanelProps {
  readonly lessons?: readonly LessonDefinition[]
  readonly state: TrainingMachineState
  readonly progress: TrainingProgressDocument
  readonly progressNotice?: string | null
  readonly liveInput?: NormalizedRcInput | null
  readonly onSelectLesson: (lessonId: string) => void
  readonly onStart: () => void
  readonly onRetry: () => void
  readonly onReset: () => void
}

function phaseLabel(state: TrainingMachineState): string {
  if (state.phase === 'READY') return 'Ready'
  if (state.phase === 'COUNTDOWN') return 'Countdown'
  if (state.phase === 'ACTIVE') return 'Active'
  if (state.phase === 'SUCCESS') return 'Success'
  if (state.phase === 'FAILED') return 'Failed'
  return 'Result'
}

function progressFor(progress: TrainingProgressDocument, lessonId: string): LessonProgress {
  return progress.lessons[lessonId] ?? { recent: null, best: null, completed: false, attempts: 0 }
}

function activeElapsedSeconds(state: TrainingMachineState): number {
  if (state.activeStartedAtSeconds === null || state.lastTimestampSeconds === null) return 0
  return Math.max(0, state.lastTimestampSeconds - state.activeStartedAtSeconds)
}

function countdownRemainingSeconds(state: TrainingMachineState): number {
  if (state.phase !== 'COUNTDOWN' || state.countdownEndsAtSeconds === null || state.lastTimestampSeconds === null) return 0
  return Math.max(0, state.countdownEndsAtSeconds - state.lastTimestampSeconds)
}

export default function TrainingPanel({
  lessons = DEFAULT_LESSONS,
  state,
  progress,
  progressNotice = null,
  liveInput = null,
  onSelectLesson,
  onStart,
  onRetry,
  onReset,
}: TrainingPanelProps) {
  const selected = state.lessonId ? lessons.find((lesson) => lesson.id === state.lessonId) ?? null : null
  const selectedProgress = selected ? progressFor(progress, selected.id) : null
  const canStart = state.phase === 'READY' && Boolean(selected?.available && selected.evaluator)
  const canRetry = Boolean(selected && (state.phase === 'RESULT' || state.phase === 'SUCCESS' || state.phase === 'FAILED'))

  return (
    <section className="training-section" id="training" aria-labelledby="training-title">
      <div className="training-heading">
        <div>
          <p className="panel-kicker">Phase 7 / Flight school evaluators</p>
          <h2 id="training-title">Train the state, not a stick ritual.</h2>
          <p>
            Four lessons consume finite fixed-step drone state and trajectory geometry. Start applies a
            disarmed reset; arm explicitly in Free Flight after the countdown, then use live checkpoints and diagnostics.
          </p>
        </div>
        <div className="training-phase-badge" aria-live="polite">
          <span aria-hidden="true" /> {phaseLabel(state)}
        </div>
      </div>

      <div className="training-layout">
        <div className="training-menu panel-card">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Lesson menu</p>
              <h3>Prioritized path</h3>
            </div>
            <span className="panel-tag">Geometry verified</span>
          </div>
          <div className="training-lesson-list">
            {lessons
              .slice()
              .sort((left, right) => left.priority - right.priority)
              .map((lesson) => {
                const lessonProgress = progressFor(progress, lesson.id)
                const selectedClass = lesson.id === state.lessonId ? 'training-lesson-selected' : ''
                return (
                  <button
                    className={`training-lesson ${selectedClass}`}
                    type="button"
                    key={lesson.id}
                    disabled={!lesson.available}
                    onClick={() => onSelectLesson(lesson.id)}
                    aria-pressed={lesson.id === state.lessonId}
                  >
                    <span className="training-lesson-priority">{String(lesson.priority).padStart(2, '0')}</span>
                    <span className="training-lesson-copy">
                      <strong>{lesson.title}</strong>
                      <span>{lesson.description}</span>
                    </span>
                    <span className={`training-lesson-status ${lesson.available ? 'training-status-available' : ''}`}>
                      {lesson.available ? (lessonProgress.completed ? 'Complete' : 'Available') : 'Coming soon'}
                    </span>
                  </button>
                )
              })}
          </div>
          <p className="training-menu-note">
            Results require actual state and trajectory evidence. Disarm, reset, focus loss, invalid telemetry, or retry stops an active attempt.
          </p>
          {progressNotice && <p className="training-error" role="status">{progressNotice}</p>}
        </div>

        <div className="training-detail panel-card">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Session contract</p>
              <h3>{selected?.title ?? 'Select a lesson'}</h3>
            </div>
            <span className="training-session-id">{state.sessionId ?? 'NO SESSION'}</span>
          </div>
          {selected ? (
            <>
              <p className="training-detail-description">{selected.description}</p>
              <div className="training-objectives">
                <strong>Objectives</strong>
                <ul>{selected.objectives.map((objective) => <li key={objective}>{objective}</li>)}</ul>
              </div>
              <div className="training-checkpoints">
                <strong>Checkpoints</strong>
                <div>{selected.checkpoints.map((checkpoint) => {
                  const checkpointState = state.checkpoints[checkpoint.id]
                  return <span className={checkpointState?.completed ? 'training-checkpoint-done' : ''} key={checkpoint.id}>{checkpointState?.completed ? '✓ ' : '○ '}{checkpoint.title}</span>
                })}</div>
              </div>
              {state.phase === 'COUNTDOWN' && (
                <div className="training-live-metrics" aria-live="polite">
                  <strong>Countdown</strong>
                  <span>{countdownRemainingSeconds(state).toFixed(1)} s · reset while disarmed</span>
                  <span>Arm in Free Flight during countdown / before Active</span>
                </div>
              )}
              {state.phase === 'ACTIVE' && (
                <div className="training-live-metrics" aria-live="polite">
                  <strong>Live metrics</strong>
                  <span>Active {activeElapsedSeconds(state).toFixed(2)} s</span>
                  <span>{state.sampleCount} samples</span>
                  {Object.entries(state.lastEvaluation?.metrics ?? {}).map(([metric, value]) => (
                    <span key={metric}>{metric} {value.toFixed(2)}</span>
                  ))}
                </div>
              )}
              {selectedProgress && (
                <div className="training-progress-summary">
                  <span>{selectedProgress.attempts} attempts</span>
                  <span>{selectedProgress.completed ? 'Completed' : 'Not completed'}</span>
                  <span>Best {selectedProgress.best ? `${selectedProgress.best.score.toFixed(0)} / 100` : '—'}</span>
                </div>
              )}
              <div className="training-actions">
                <button className="lab-button lab-button-primary" type="button" onClick={onStart} disabled={!canStart}>
                  {canStart ? 'Start countdown / reset' : 'Evaluator pending'}
                </button>
                <button className="lab-button" type="button" onClick={onRetry} disabled={!canRetry}>Retry</button>
                <button className="lab-button" type="button" onClick={onReset} disabled={state.phase === 'READY'}>Reset</button>
              </div>
              {state.result && (
                <div className={`training-result training-result-${state.result.outcome.toLowerCase()}`} aria-live="polite">
                  <div className="training-result-heading">
                    <strong>{state.result.outcome === 'SUCCESS' ? 'Lesson passed' : 'Attempt recorded'}</strong>
                    <span>{state.result.score.toFixed(0)} / 100</span>
                  </div>
                  <p>{state.result.message}</p>
                  <div className="training-result-metrics">
                    <span>Active {state.result.elapsedSeconds.toFixed(2)} s</span>
                    <span>{state.result.sampleCount} samples</span>
                    <span>{state.result.completedCheckpoints} / {state.result.totalCheckpoints} checkpoints</span>
                    {Object.entries(state.result.metrics)
                      .filter(([metric]) => !['elapsedSeconds', 'sampleCount', 'completedCheckpoints', 'totalCheckpoints'].includes(metric))
                      .slice(0, 8)
                      .map(([metric, value]) => <span key={metric}>{metric} {value.toFixed(2)}</span>)}
                  </div>
                  {state.result.hint && <p className="training-result-hint">Hint: {state.result.hint}</p>}
                </div>
              )}
            </>
          ) : (
            <p className="training-empty-state">Choose one of the prioritized lessons to inspect its setup and checkpoints.</p>
          )}
          {state.lastError && <p className="training-error" role="status">{state.lastError}</p>}
        </div>

        <div className="training-sticks">
          <Mode2StickOverlay input={liveInput} mode="live" />
          <Mode2StickOverlay mode="demonstration" compact />
        </div>
      </div>
    </section>
  )
}

export { TrainingPanel }
