import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import TrainingPanel from './TrainingPanel'
import { createTrainingMachineState } from './machine'
import { createDefaultTrainingProgress } from './progress'
import type { TrainingMachineState } from './types'
import { BASIC_RECOVERY_LESSON } from './basicRecovery'
import type { TeachingDemonstrationProgressSnapshot } from './demonstrationProgress'
import { lessonById } from './lessons'

describe('training recovery feedback', () => {
  it('keeps the original reason and values visible through recovery reminders and resumed progress until reset', () => {
    const ready = createTrainingMachineState({ initialLessonId: 'straight-line' })
    const reason = '高度 4.1 m，超過本課上限 3.7 m。'
    const correction = '先降低高度，再回起飛區平穩接地。'
    const snapshot = Object.freeze({
      timestampSeconds: 12.5,
      message: reason,
      hint: correction,
      metrics: Object.freeze({ altitudeM: 4.1, altitudeLimitM: 3.7 }),
    })
    const recovery: TrainingMachineState = {
      ...ready,
      phase: 'ACTIVE',
      lastRecovery: snapshot,
      recoveryInProgress: true,
      lastEvaluation: { status: 'continue', recovery: 'restart', message: reason, hint: correction },
    }
    const props = {
      mode: 'practice' as const,
      progress: createDefaultTrainingProgress(),
      onSelectLesson: vi.fn(),
      onStart: vi.fn(),
      onRetry: vi.fn(),
      onReset: vi.fn(),
    }
    const { rerender } = render(<TrainingPanel {...props} state={recovery} />)
    const expectOriginalCause = (): void => {
      const history = screen.getByRole('region', { name: '最近重練原因' })
      expect(within(history).getByText('最近重練原因（當時數值）')).toBeInTheDocument()
      expect(within(history).getByText(reason)).toBeInTheDocument()
      expect(history).toHaveTextContent(correction)
    }
    expectOriginalCause()

    const reminder = '本次局部目標已重新開始；請回起飛區平穩接地。'
    rerender(<TrainingPanel {...props} state={{
      ...recovery,
      lastEvaluation: { status: 'continue', recovery: 'restart', message: reminder, hint: reminder, metrics: { altitudeM: 0.2 } },
    }} />)
    expectOriginalCause()
    expect(within(screen.getByRole('region', { name: '最近重練原因' })).queryByText(reminder)).not.toBeInTheDocument()

    rerender(<TrainingPanel {...props} state={{
      ...recovery,
      recoveryInProgress: false,
      lastEvaluation: { status: 'continue', checkpointIds: ['straight-ground'], hint: '請自行起飛，前往起點。', metrics: { altitudeM: 0.1 } },
    }} />)
    expectOriginalCause()

    rerender(<TrainingPanel {...props} state={ready} />)
    expect(screen.queryByRole('region', { name: '最近重練原因' })).not.toBeInTheDocument()
  })

  it('replaces live L09 four-step progress with the demo progress and restores the same live attempt on exit', () => {
    const ready = createTrainingMachineState({ initialLessonId: 'basic-recovery' })
    const state: TrainingMachineState = { ...ready, phase: 'FAILED', checkpoints: Object.fromEntries(
      BASIC_RECOVERY_LESSON.checkpoints.slice(0, 4).map(({ id }) => [id, { id, completed: true, completedAtSeconds: 4, metrics: {} }]),
    ), lastEvaluation: { status: 'failure', metrics: { recoveryPhase: 4, currentEpisodeValid: 0, exerciseReady: 0 } },
    result: { lessonId: 'basic-recovery', sessionId: 'live-four-step-attempt', outcome: 'FAILED', score: 50,
      elapsedSeconds: 10, sampleCount: 80, completedCheckpoints: 4, totalCheckpoints: 8,
      startedAtSeconds: 3, completedAtSeconds: 13, metrics: { recoveryPhase: 4, exercisesCompleted: 1 },
      message: 'Attempt stopped: the live runtime was disarmed.', hint: null },
    }
    const saved = createDefaultTrainingProgress()
    const props = { state, progress: saved, onSelectLesson: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onReset: vi.fn() }
    const before = JSON.stringify({ state, progress: saved })
    const storageBefore = { ...window.localStorage }
    const { rerender } = render(<TrainingPanel {...props} />)
    const live = screen.getByRole('list', { name: '本課步驟' })
    expect(live.querySelectorAll('.is-complete')).toHaveLength(4)
    expect(screen.getByText('4 / 8 個步驟完成')).toBeInTheDocument()
    const demo: TeachingDemonstrationProgressSnapshot = {
      kind: 'basic-recovery', lessonId: 'basic-recovery', title: 'L09 基礎失誤恢復', mode: 'lesson-checkpoints',
      steps: BASIC_RECOVERY_LESSON.checkpoints.map(({ id, title }, index) => ({ id, title,
        status: index < 5 ? 'completed' : index === 5 ? 'current' : 'pending',
        startedAtSeconds: index * 2, completedAtSeconds: index < 5 ? index * 2 + 1 : null })),
      completedSteps: 5, totalSteps: 8, currentStepIndex: 5, currentStepTitle: '止住下沉', complete: false, notice: null,
    }
    const onSeekDemonstrationStep = vi.fn()
    rerender(<TrainingPanel {...props} playbackActive demonstrationProgress={demo} onSeekDemonstrationStep={onSeekDemonstrationStep} />)
    expect(screen.getByRole('region', { name: '示範進度' }).parentElement?.firstElementChild).toBe(screen.getByRole('region', { name: '示範進度' }))
    expect(screen.queryByRole('list', { name: '本課步驟' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('目前任務')).not.toBeInTheDocument()
    expect(screen.queryByText(/本次條件已練/)).not.toBeInTheDocument()
    expect(screen.queryByText('4 / 8 個步驟完成')).not.toBeInTheDocument()
    expect(screen.queryByText('這次練習已結束')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '示範進度' })).toHaveTextContent('5 / 8 個示範步驟完成')
    expect(screen.getByRole('list', { name: '示範步驟' }).querySelector('[aria-current="step"]')).toHaveTextContent('止住下沉')
    expect(screen.getByRole('button', { name: '重設課程' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '再練一次' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '觀看示範步驟：產生小幅下沉' }))
    expect(onSeekDemonstrationStep).toHaveBeenCalledWith(8)
    rerender(<TrainingPanel {...props} />)
    expect(screen.queryByRole('region', { name: '示範進度' })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: '本課步驟' }).querySelectorAll('.is-complete')).toHaveLength(4)
    expect(screen.getByText('4 / 8 個步驟完成')).toBeInTheDocument()
    expect(JSON.stringify({ state, progress: saved })).toBe(before)
    expect({ ...window.localStorage }).toEqual(storageBefore)
  })

  it('identifies a different course demonstration while the selected course and its result remain untouched', () => {
    const ready = createTrainingMachineState({ initialLessonId: 'basic-recovery' })
    const props = { state: ready, progress: createDefaultTrainingProgress(), onSelectLesson: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onReset: vi.fn() }
    const demo: TeachingDemonstrationProgressSnapshot = {
      kind: 'takeoff', lessonId: 'takeoff', title: 'L01 起飛與定點懸停示範', mode: 'lesson-checkpoints',
      steps: [{ id: 'takeoff-ready', title: '起飛前準備', status: 'current', startedAtSeconds: 0, completedAtSeconds: null }],
      completedSteps: 0, totalSteps: 1, currentStepIndex: 0, currentStepTitle: '起飛前準備', complete: false, notice: null,
    }
    const { rerender } = render(<TrainingPanel {...props} playbackActive demonstrationProgress={demo} />)
    expect(screen.getByRole('heading', { name: 'L01 起飛與定點懸停示範' })).toBeInTheDocument()
    expect(screen.getByLabelText('選擇課程')).toHaveValue('basic-recovery')
    expect(screen.getByLabelText('選擇課程')).toBeDisabled()
    expect(screen.getByRole('button', { name: '開始課程' })).toBeDisabled()
    expect(screen.queryByRole('list', { name: '本課步驟' })).not.toBeInTheDocument()
    rerender(<TrainingPanel {...props} />)
    expect(screen.getByRole('heading', { name: '基礎失誤恢復' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '本課步驟' })).toBeInTheDocument()
    expect(ready.result).toBeNull()
  })

  it('reveals a new demo at the panel top, preserves manual demo scrolling and restores the live reading position', () => {
    const scrollPage = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    try {
      const props = { state: createTrainingMachineState({ initialLessonId: 'basic-recovery' }), progress: createDefaultTrainingProgress(),
        onSelectLesson: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onReset: vi.fn() }
      const demoFor = (lessonId: 'basic-recovery' | 'takeoff', completedSteps = 0): TeachingDemonstrationProgressSnapshot => {
        const lesson = lessonById(lessonId)!
        return {
          kind: lessonId, lessonId, title: lesson.title, mode: 'lesson-checkpoints',
          steps: lesson.checkpoints.map(({ id, title }, index) => ({ id, title,
            status: index < completedSteps ? 'completed' : index === completedSteps ? 'current' : 'pending',
            startedAtSeconds: index * 2, completedAtSeconds: index < completedSteps ? index * 2 + 1 : null })),
          completedSteps, totalSteps: lesson.checkpoints.length, currentStepIndex: completedSteps,
          currentStepTitle: lesson.checkpoints[completedSteps].title, complete: false, notice: null,
        }
      }
      const { rerender } = render(<TrainingPanel {...props} />)
      const panel = screen.getByRole('region', { name: '今天練習哪個動作？' })
      panel.scrollTop = 280
      fireEvent.scroll(panel)
      rerender(<TrainingPanel {...props} playbackActive demonstrationProgress={demoFor('basic-recovery')} />)
      expect(panel.scrollTop).toBe(0)

      panel.scrollTop = 70
      fireEvent.scroll(panel)
      rerender(<TrainingPanel {...props} playbackActive demonstrationProgress={demoFor('basic-recovery', 1)} />)
      expect(panel.scrollTop).toBe(70)

      rerender(<TrainingPanel {...props} playbackActive demonstrationProgress={demoFor('takeoff')} />)
      expect(panel.scrollTop).toBe(0)
      panel.scrollTop = 40
      fireEvent.scroll(panel)
      rerender(<TrainingPanel {...props} />)
      expect(panel.scrollTop).toBe(280)
      expect(scrollPage).not.toHaveBeenCalled()
    } finally {
      scrollPage.mockRestore()
    }
  })
})
