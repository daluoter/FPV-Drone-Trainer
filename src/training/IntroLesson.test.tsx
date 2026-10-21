import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import IntroLesson from './IntroLesson'

const CORRECT_CHOICES = [
  '橫滾 Roll：讓機身向左或右傾斜',
  '要求停止旋轉，但不會自動回平或煞停',
  '不一定，需觀察姿態與高度，再小量修正油門',
  '先確認狀態、低油門與中立，再明確按 Arm 解鎖',
] as const

function answer(label: string): void {
  fireEvent.click(screen.getByRole('radio', { name: label }))
  fireEvent.click(screen.getByRole('button', { name: '檢查答案' }))
}

describe('L00 introductory knowledge practice', () => {
  it('requires a correct answer before advancing and explains wrong answers without completing anything', () => {
    const complete = vi.fn()
    render(<IntroLesson completed={false} disabled={false} onDemonstrate={vi.fn()} onComplete={complete} />)

    expect(screen.getByRole('button', { name: '檢查答案' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    answer('偏航 Yaw：轉動機頭方向')
    expect(screen.getByRole('status')).toHaveTextContent('再試一次')
    expect(screen.getByRole('status')).toHaveTextContent('右桿左右是橫滾 Roll')
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    expect(complete).not.toHaveBeenCalled()

    answer(CORRECT_CHOICES[0])
    expect(screen.getByRole('status')).toHaveTextContent('答對了')
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled()
  })

  it('requires all four correct concepts and an explicit completion action, recorded once', () => {
    const complete = vi.fn()
    render(<IntroLesson completed={false} disabled={false} onDemonstrate={vi.fn()} onComplete={complete} />)

    for (const [index, choice] of CORRECT_CHOICES.entries()) {
      answer(choice)
      expect(complete).not.toHaveBeenCalled()
      if (index < CORRECT_CHOICES.length - 1) fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    }
    const finish = screen.getByRole('button', { name: '完成觀念練習' })
    expect(finish).toBeEnabled()
    fireEvent.click(finish)
    fireEvent.click(finish)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(finish).toBeDisabled()
    expect(screen.getByText(/這不代表已通過實際飛行或遙控器驗證/)).toBeInTheDocument()
  })

  it('invalidates a checked answer when changed, and demonstration requests never count as answers', () => {
    const demonstrate = vi.fn()
    const complete = vi.fn()
    render(<IntroLesson completed={false} disabled={false} onDemonstrate={demonstrate} onComplete={complete} />)

    fireEvent.click(screen.getByRole('button', { name: '看橫滾示意' }))
    expect(demonstrate).toHaveBeenCalledWith('roll')
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    answer(CORRECT_CHOICES[0])
    fireEvent.click(screen.getByRole('radio', { name: '偏航 Yaw：轉動機頭方向' }))
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('blocks quiz and demo controls during active flight and allows completed knowledge to be reviewed', () => {
    const demonstrate = vi.fn()
    const complete = vi.fn()
    const { rerender } = render(<IntroLesson completed={false} disabled onDemonstrate={demonstrate} onComplete={complete} />)
    expect(screen.getByRole('radio', { name: CORRECT_CHOICES[0] })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '看橫滾示意' }))
    expect(demonstrate).not.toHaveBeenCalled()

    rerender(<IntroLesson completed disabled={false} onDemonstrate={demonstrate} onComplete={complete} />)
    expect(screen.getByText(/觀念練習已完成/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('offers an inline exit while playback blocks the quiz and preserves the current answer afterward', () => {
    const complete = vi.fn()
    function IntroWithPlayback() {
      const [playing, setPlaying] = useState(false)
      return <IntroLesson completed={false} disabled={playing} playbackActive={playing}
        onDemonstrate={() => setPlaying(true)} onComplete={complete} onExitPlayback={() => setPlaying(false)} />
    }
    render(<IntroWithPlayback />)
    answer(CORRECT_CHOICES[0])
    fireEvent.click(screen.getByRole('button', { name: '看橫滾示意' }))
    expect(screen.getByRole('radio', { name: CORRECT_CHOICES[0] })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    const exit = screen.getByRole('button', { name: '結束示範，繼續作答' })
    expect(exit).toBeEnabled()
    fireEvent.click(exit)
    expect(screen.getByRole('radio', { name: CORRECT_CHOICES[0] })).toBeChecked()
    expect(screen.getByRole('radio', { name: CORRECT_CHOICES[0] })).toBeEnabled()
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '結束示範，繼續作答' })).not.toBeInTheDocument()
    expect(complete).not.toHaveBeenCalled()
  })
})
