import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import TrainingPanel from './TrainingPanel'
import { createTrainingMachineState } from './machine'
import { createDefaultTrainingProgress } from './progress'
import type { TrainingMachineState } from './types'

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
})
