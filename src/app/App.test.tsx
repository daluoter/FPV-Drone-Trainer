import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import App from './App'
import { TrainingProgressStore } from '../training/progress'
import { fingerprintTrainingSettings, trainingAttemptContextKey } from '../training/attempt'
import { createTuningPreset } from '../tuning'
import { DEFAULT_LEARNING_PREFERENCES, LEARNING_PREFERENCES_KEY, saveLearningPreferences } from '../training/learningPreferences'

describe('beginner flight school', () => {
  beforeEach(() => window.localStorage.clear())
  it('offers merged takeoff and hover once, followed by the renumbered courses', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: '小幅操作，一步步學會飛。' })).toBeInTheDocument()
    expect(screen.getByLabelText('選擇課程')).toHaveValue('takeoff')
    const choices = within(screen.getByLabelText('選擇課程')).getAllByRole('option')
    expect(choices.map((option) => option.textContent?.split(' · ')[0])).toEqual([
      'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10', 'L11', 'L12', 'L13', 'L14', 'L15', 'L17',
    ])
    expect(choices[0]).toHaveTextContent('起飛與定點懸停')
    expect(choices.some((option) => (option as HTMLOptionElement).value === 'hover')).toBe(false)
    expect(screen.getByText(/機體不會自動回平或煞停/)).toBeInTheDocument()
    expect(screen.getByLabelText('操控設定')).toHaveValue('beginner')
  })

  it('resumes the retired hover selection at merged L01 without rewriting history or granting completion', () => {
    const original = JSON.stringify({ ...DEFAULT_LEARNING_PREFERENCES, lastLessonId: 'hover', mode: 'challenge', introCompleted: true })
    window.localStorage.setItem(LEARNING_PREFERENCES_KEY, original)
    render(<App />)
    expect(screen.getByLabelText('選擇課程')).toHaveValue('takeoff')
    expect(screen.getByRole('heading', { name: '起飛與定點懸停' })).toBeInTheDocument()
    expect(screen.getByLabelText('學習方式')).toHaveValue('challenge')
    expect(screen.getByRole('button', { name: 'L00 觀念複習 ✓' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '本課步驟' }).querySelectorAll('.is-complete')).toHaveLength(0)
    expect(window.localStorage.getItem(LEARNING_PREFERENCES_KEY)).toBe(original)
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith('fpv-drone-trainer.training-progress.'))).toEqual([])
  })

  it('preserves the old airborne split-s result without completing the new ground-start L14', () => {
    const scope = { rulesVersion: 4, physicsVersion: 1, presetId: 'beginner',
      settingsFingerprint: fingerprintTrainingSettings(createTuningPreset('beginner')),
      inputSource: 'controller', mode: 'practice', assistance: 'none' } as const
    const store = new TrainingProgressStore(window.localStorage)
    expect(store.recordResult({ lessonId: 'split-s', sessionId: 'split-s:airborne-prototype', outcome: 'SUCCESS',
      score: 100, elapsedSeconds: 10, sampleCount: 600, completedCheckpoints: 5, totalCheckpoints: 5,
      startedAtSeconds: 0, completedAtSeconds: 10, metrics: { headingChangeDegrees: 180 },
      message: 'Historical airborne prototype', hint: null, attemptContext: scope }).saved).toBe(true)
    const key = trainingAttemptContextKey(scope)
    const raw = window.localStorage.getItem(key)
    saveLearningPreferences({ ...DEFAULT_LEARNING_PREFERENCES, lastLessonId: 'split-s', introCompleted: true })
    render(<App />)
    expect(screen.getByLabelText('選擇課程')).toHaveValue('split-s')
    expect(screen.getByRole('heading', { name: '破S' })).toBeInTheDocument()
    const steps = screen.getByRole('list', { name: '本課步驟' })
    expect(within(steps).getAllByRole('listitem')).toHaveLength(8)
    expect(steps.querySelectorAll('.is-complete')).toHaveLength(0)
    expect(screen.getByText(/本次條件已練 0 次/)).toBeInTheDocument()
    expect(window.localStorage.getItem(key)).toBe(raw)
    expect(store.load(scope).progress.lessons['split-s']).toMatchObject({ completed: true, attempts: 1,
      best: { sessionId: 'split-s:airborne-prototype', totalCheckpoints: 5 } })
  })

  it('keeps the same canvas while changing workspace and opens calibration on request', () => {
    render(<App />)
    const canvas = screen.getByLabelText('Free Flight 3D scene')
    fireEvent.click(screen.getByRole('button', { name: '自由飛行' }))
    expect(screen.queryByLabelText('選擇課程')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Free Flight 3D scene')).toBe(canvas)
    fireEvent.click(screen.getByRole('button', { name: '開始學飛' }))
    expect(screen.getByLabelText('選擇課程')).toHaveValue('takeoff')
    fireEvent.click(screen.getByRole('button', { name: '設備與校正' }))
    expect(screen.getByRole('heading', { name: /make the transmitter boring/i })).toBeVisible()
  })

  it('resumes a saved lesson and knowledge badge without claiming flight mastery', () => {
    saveLearningPreferences({ ...DEFAULT_LEARNING_PREFERENCES, lastLessonId: 'landing', mode: 'challenge', introCompleted: true })
    render(<App />)
    expect(screen.getByLabelText('選擇課程')).toHaveValue('landing')
    expect(screen.getByLabelText('學習方式')).toHaveValue('challenge')
    expect(screen.getByRole('button', { name: '繼續練習' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'L00 觀念複習 ✓' })).toBeInTheDocument()
    expect(screen.getByText(/本次條件已練 0 次/)).toBeInTheDocument()
  })

  it('locks inputs and settings throughout countdown and releases them on explicit stop', () => {
    render(<App />)
    const training = document.getElementById('training')!
    fireEvent.click(within(training).getByRole('button', { name: '開始課程' }))
    expect(screen.getByRole('button', { name: /^Arm$/ })).toBeDisabled()
    expect(screen.getByLabelText('控制方式')).toBeDisabled()
    expect(screen.getByLabelText('操控設定')).toBeDisabled()
    expect(screen.getByLabelText('選擇課程')).toBeDisabled()
    fireEvent.click(within(training).getByRole('button', { name: '停止練習' }))
    expect(screen.getByText('準備選課')).toBeInTheDocument()
    expect(screen.getByLabelText('控制方式')).toBeEnabled()
    expect(screen.getByLabelText('操控設定')).toBeEnabled()
  })
})
