import { useEffect, useRef } from 'react'

import type { TeachingDemonstrationProgressSnapshot } from './demonstrationProgress'

export interface DemonstrationProgressProps {
  readonly progress: TeachingDemonstrationProgressSnapshot
  readonly onSeekStep?: (timeSeconds: number) => void
}

/** Playback-only teaching progress; no live session or saved result is changed. */
export default function DemonstrationProgress({ progress, onSeekStep }: DemonstrationProgressProps) {
  const listRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    const list = listRef.current
    const current = list?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!list || !current || list.clientHeight <= 0) return
    const top = current.offsetTop
    const bottom = top + current.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [progress.kind, progress.currentStepIndex])

  return <section className="school-demonstration-progress" aria-label="示範進度">
    <div className="school-demonstration-heading">
      <strong>示範進度</strong>
      <span>{progress.completedSteps} / {progress.totalSteps} 個示範步驟完成</span>
    </div>
    <p className="school-demonstration-title">{progress.title}</p>
    <p className="school-demonstration-current" aria-live="polite">
      {progress.complete ? '示範步驟已全部演示。' : progress.currentStepIndex !== null
        ? `正在示範第 ${progress.currentStepIndex + 1} / ${progress.totalSteps} 步：${progress.currentStepTitle}`
        : '這段示範尚未演示到後續步驟。'}
    </p>
    <ol ref={listRef} className="school-checkpoints school-demo-checkpoints" aria-label="示範步驟">
      {progress.steps.map((step, index) => <li key={step.id}
        className={step.status === 'completed' ? 'is-complete' : step.status === 'current' ? 'is-current' : ''}
        aria-current={step.status === 'current' ? 'step' : undefined}>
        {onSeekStep ? <button className="lab-button lab-button-small school-demo-step" type="button"
          aria-label={`觀看示範步驟：${step.title}`} disabled={step.startedAtSeconds === null}
          onClick={() => { if (step.startedAtSeconds !== null) onSeekStep(step.startedAtSeconds) }}>
          <span aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'current' ? '▶' : '○'}</span>
          <span>{index + 1}. {step.title}</span>
          {step.status === 'current' && <small>目前</small>}
          {step.startedAtSeconds === null && <small>片段未保留</small>}
        </button> : <>
          <span aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'current' ? '▶' : '○'}</span>
          {' '}{index + 1}. {step.title}{step.status === 'current' ? '（目前）' : ''}
        </>}
      </li>)}
    </ol>
    {progress.notice && <p className="school-demo-notice" role="note">{progress.notice}</p>}
    {onSeekStep && <p className="school-prototype-note">點選步驟會暫停在該段開頭，再按 Play 觀看。</p>}
    <p className="school-prototype-note">示範進度獨立於你的練習；觀看不計成績。</p>
  </section>
}

export { DemonstrationProgress }
