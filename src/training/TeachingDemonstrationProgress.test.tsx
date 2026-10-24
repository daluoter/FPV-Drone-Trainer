import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import DemonstrationProgress from './TeachingDemonstrationProgress'
import { BASIC_RECOVERY_LESSON } from './basicRecovery'
import type { TeachingDemonstrationProgressSnapshot } from './demonstrationProgress'

/** A playback UI fixture, not evidence of completing a recovery maneuver. */
function snapshot(completedSteps = 5): TeachingDemonstrationProgressSnapshot {
  return {
    kind: 'basic-recovery', lessonId: 'basic-recovery', title: 'L09 基礎失誤恢復', mode: 'lesson-checkpoints',
    steps: BASIC_RECOVERY_LESSON.checkpoints.map((checkpoint, index) => ({ id: checkpoint.id, title: checkpoint.title,
      status: index < completedSteps ? 'completed' : index === completedSteps ? 'current' : 'pending',
      startedAtSeconds: index * 2, completedAtSeconds: index < completedSteps ? index * 2 + 1 : null })),
    completedSteps, totalSteps: 8, currentStepIndex: completedSteps === 8 ? null : completedSteps,
    currentStepTitle: BASIC_RECOVERY_LESSON.checkpoints[completedSteps]?.title ?? '', complete: completedSteps === 8, notice: null,
  }
}

describe('independent demonstration progress', () => {
  it('shows observed completion, current numbered step and an explicit separate-score label', () => {
    render(<DemonstrationProgress progress={snapshot()} />)
    const progress = screen.getByRole('region', { name: '示範進度' })
    expect(progress).toHaveTextContent('5 / 8 個示範步驟完成')
    expect(progress).toHaveTextContent('正在示範第 6 / 8 步：止住下沉')
    expect(progress).toHaveTextContent('示範進度獨立於你的練習；觀看不計成績。')
    expect(within(screen.getByRole('list', { name: '示範步驟' })).getAllByRole('listitem')).toHaveLength(8)
    expect(progress.querySelector('[aria-current="step"]')).toHaveTextContent('止住下沉')
    expect(within(progress).queryByRole('button')).not.toBeInTheDocument()
  })

  it('updates backward and forward seeks from snapshots without retaining future checks', () => {
    const { rerender } = render(<DemonstrationProgress progress={snapshot(8)} />)
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('示範步驟已全部演示。')
    expect(screen.getByRole('list', { name: '示範步驟' }).querySelector('[aria-current]')).toBeNull()
    rerender(<DemonstrationProgress progress={snapshot(2)} />)
    const list = screen.getByRole('list', { name: '示範步驟' })
    expect(list.querySelectorAll('.is-complete')).toHaveLength(2)
    expect(list.querySelector('[aria-current="step"]')).toHaveTextContent('產生小幅傾斜')
    expect(screen.queryByText('示範步驟已全部演示。')).not.toBeInTheDocument()
  })

  it('offers accessible chapter buttons, pauses through the parent callback and leaves missing chapters unavailable', () => {
    const onSeekStep = vi.fn()
    const progress = snapshot()
    const last = progress.steps[7]
    render(<DemonstrationProgress progress={{ ...progress, steps: [...progress.steps.slice(0, 7), { ...last, startedAtSeconds: null }] }} onSeekStep={onSeekStep} />)
    const sink = screen.getByRole('button', { name: '觀看示範步驟：產生小幅下沉' })
    sink.focus()
    expect(sink).toHaveFocus()
    fireEvent.click(sink)
    expect(onSeekStep).toHaveBeenLastCalledWith(8)
    fireEvent.click(screen.getByRole('button', { name: '觀看示範步驟：建立前進或側移' }))
    expect(onSeekStep).toHaveBeenLastCalledWith(12)
    const missing = screen.getByRole('button', { name: '觀看示範步驟：減速並恢復控制' })
    expect(missing).toBeDisabled()
    fireEvent.click(missing)
    expect(onSeekStep).toHaveBeenCalledTimes(2)
    expect(screen.getByText('點選步驟會暫停在該段開頭，再按 Play 觀看。')).toBeInTheDocument()
  })

  it('explains a partial recording without presenting the remaining steps as completed', () => {
    const progress = snapshot(4)
    render(<DemonstrationProgress progress={{ ...progress, notice: '錄影尚未演示到後續步驟。' }} />)
    expect(screen.getByRole('note')).toHaveTextContent('錄影尚未演示到後續步驟。')
    expect(screen.getByRole('list', { name: '示範步驟' }).querySelectorAll('.is-complete')).toHaveLength(4)
    expect(screen.queryByText('示範步驟已全部演示。')).not.toBeInTheDocument()
  })

  it('keeps the current chapter inside its own list when seeking forward and backward without scrolling the page', () => {
    const scrollPage = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    try {
      const { rerender } = render(<DemonstrationProgress progress={snapshot(0)} />)
      const list = screen.getByRole('list', { name: '示範步驟' })
      // jsdom has no layout; supply independent viewport/row measurements for
      // the observable requirement that the active chapter stays in view.
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 })
      within(list).getAllByRole('listitem').forEach((item, index) => {
        Object.defineProperties(item, {
          offsetTop: { configurable: true, value: index * 40 },
          offsetHeight: { configurable: true, value: 40 },
        })
      })
      const expectCurrentVisible = (): void => {
        const current = list.querySelector<HTMLElement>('[aria-current="step"]')!
        expect(current.offsetTop).toBeGreaterThanOrEqual(list.scrollTop)
        expect(current.offsetTop + current.offsetHeight).toBeLessThanOrEqual(list.scrollTop + list.clientHeight)
      }
      rerender(<DemonstrationProgress progress={snapshot(6)} />)
      expectCurrentVisible()
      expect(list.scrollTop).toBeGreaterThan(0)
      rerender(<DemonstrationProgress progress={snapshot(1)} />)
      expectCurrentVisible()
      expect(scrollPage).not.toHaveBeenCalled()
    } finally {
      scrollPage.mockRestore()
    }
  })
})
