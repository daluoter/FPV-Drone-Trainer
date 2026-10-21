import { useState, type FormEvent } from 'react'

import './IntroLesson.css'

export type IntroDemoKind = 'roll' | 'pitch' | 'yaw' | 'takeoff'

export interface IntroLessonProps {
  readonly onDemonstrate: (kind: IntroDemoKind) => void
  readonly onComplete: () => void
  readonly completed: boolean
  readonly disabled: boolean
  readonly playbackActive?: boolean
  readonly onExitPlayback?: () => void
}

interface IntroStep {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly question: string
  readonly choices: readonly { readonly id: string; readonly label: string }[]
  readonly correctId: string
  readonly explanation: string
  readonly demonstrations: readonly { readonly kind: IntroDemoKind; readonly label: string }[]
}

const STEPS: readonly IntroStep[] = [
  {
    id: 'mode2',
    title: '先認識 Mode 2 四軸',
    description: '左桿：上下是油門 Throttle、左右是偏航 Yaw。右桿：上下是俯仰 Pitch、左右是橫滾 Roll。',
    question: 'Mode 2 右搖桿左右移動，控制的是什麼？',
    choices: [
      { id: 'yaw', label: '偏航 Yaw：轉動機頭方向' },
      { id: 'roll', label: '橫滾 Roll：讓機身向左或右傾斜' },
      { id: 'throttle', label: '油門 Throttle：調整推力' },
    ],
    correctId: 'roll',
    explanation: '右桿左右是橫滾 Roll；轉動機頭的偏航 Yaw 在左桿左右。先分清兩個動作，再練協調轉彎。',
    demonstrations: [
      { kind: 'roll', label: '看橫滾示意' },
      { kind: 'pitch', label: '看俯仰示意' },
      { kind: 'yaw', label: '看偏航示意' },
    ],
  },
  {
    id: 'acro',
    title: '回中，不等於回平',
    description: 'Acro 模式以搖桿控制旋轉速度。回中會要求停止旋轉，已經傾斜的機身與原本的移動速度仍會保留。',
    question: '向右傾斜後把右桿回中，會發生什麼？',
    choices: [
      { id: 'level', label: '自動恢復水平，並停在原地' },
      { id: 'rotation', label: '要求停止旋轉，但不會自動回平或煞停' },
      { id: 'reverse', label: '自動向左旋轉，抵銷剛才的動作' },
    ],
    correctId: 'rotation',
    explanation: '回中只要求停止旋轉。恢復水平需要適量反向修正，減速還要觀察姿態、速度與油門。',
    demonstrations: [{ kind: 'roll', label: '看回中與姿態示意' }],
  },
  {
    id: 'thrust',
    title: '油門控制推力',
    description: '推力方向會跟著機身傾斜。相同油門在不同姿態下，對高度與前進速度的影響也不同。',
    question: '機身向前傾時，同樣的油門一定能保持高度嗎？',
    choices: [
      { id: 'always', label: '一定，油門位置就是固定高度' },
      { id: 'observe', label: '不一定，需觀察姿態與高度，再小量修正油門' },
      { id: 'zero', label: '只要把油門降到零，就會停在原高度' },
    ],
    correctId: 'observe',
    explanation: '油門調整的是推力，不是指定高度。傾斜後仍要觀察升降速度，避免連續大幅加減油門。',
    demonstrations: [{ kind: 'takeoff', label: '看起飛與油門示意' }],
  },
  {
    id: 'stop',
    title: '知道如何停下與重新開始',
    description: '需要結束本次模擬時，按 Disarm 解除解鎖。失焦、斷線或畫面故障後，系統不會自動恢復飛行。',
    question: '斷線或離開網頁後回來，應該怎麼做？',
    choices: [
      { id: 'resume', label: '等系統自動續飛，不需要再檢查' },
      { id: 'full', label: '先推滿油門，讓系統知道我要繼續' },
      { id: 'check', label: '先確認狀態、低油門與中立，再明確按 Arm 解鎖' },
    ],
    correctId: 'check',
    explanation: '先排除問題並確認低油門與搖桿中立；課程重試完成倒數後，再明確解鎖。',
    demonstrations: [],
  },
]

/** Knowledge practice only; it never owns a runtime or produces flight results. */
export default function IntroLesson({ onDemonstrate, onComplete, completed, disabled, playbackActive = false, onExitPlayback }: IntroLessonProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [answers, setAnswers] = useState<readonly string[]>(STEPS.map(() => ''))
  const [correct, setCorrect] = useState<readonly boolean[]>(STEPS.map(() => completed))
  const [feedback, setFeedback] = useState<{ readonly correct: boolean; readonly message: string } | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const step = STEPS[stepIndex]
  const correctCount = correct.filter(Boolean).length
  const allCorrect = correctCount === STEPS.length
  const finished = completed || submitted
  const blocked = disabled || playbackActive

  const choose = (answerId: string): void => {
    if (blocked) return
    setAnswers((previous) => previous.map((answer, index) => index === stepIndex ? answerId : answer))
    setCorrect((previous) => previous.map((value, index) => index === stepIndex ? false : value))
    setFeedback(null)
  }

  const check = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (blocked || !answers[stepIndex]) return
    const isCorrect = answers[stepIndex] === step.correctId
    setCorrect((previous) => previous.map((value, index) => index === stepIndex ? isCorrect : value))
    setFeedback({ correct: isCorrect, message: step.explanation })
  }

  const move = (nextIndex: number): void => {
    if (blocked || nextIndex < 0 || nextIndex >= STEPS.length) return
    if (nextIndex > stepIndex && !correct[stepIndex] && !finished) return
    setStepIndex(nextIndex)
    setFeedback(null)
  }

  const complete = (): void => {
    if (blocked || finished || !allCorrect) return
    setSubmitted(true)
    onComplete()
  }

  return (
    <section className="intro-lesson" aria-labelledby="intro-lesson-title">
      <div className="intro-lesson-heading">
        <div><p className="panel-kicker">L00 · 入門觀念</p><h3 id="intro-lesson-title">先懂操作，再開始飛</h3></div>
        <span className="intro-lesson-count">{finished ? STEPS.length : correctCount} / {STEPS.length} 題</span>
      </div>
      {finished && <p className="intro-lesson-completed" role="status">觀念練習已完成，可繼續複習。這不代表已通過實際飛行或遙控器驗證。</p>}
      <ol className="intro-lesson-progress" aria-label="觀念步驟">
        {STEPS.map((item, index) => <li key={item.id} aria-current={index === stepIndex ? 'step' : undefined} className={correct[index] || finished ? 'is-correct' : ''}><span>{correct[index] || finished ? '✓' : index + 1}</span><span className="intro-lesson-progress-name">{item.title}</span></li>)}
      </ol>
      <div className="intro-lesson-copy"><strong>{step.title}</strong><p>{step.description}</p></div>
      {step.demonstrations.length > 0 && <div className="intro-lesson-demos" aria-label="本步驟示意">{step.demonstrations.map((demo) => <button className="lab-button lab-button-small" key={demo.kind} type="button" disabled={blocked} onClick={() => { if (!blocked) onDemonstrate(demo.kind) }}>{demo.label}</button>)}</div>}
      {playbackActive && <div className="intro-playback-return">
        <p>正在觀看示範／回放。結束後可接著作答，已選答案會保留。</p>
        <button className="lab-button lab-button-primary" type="button" disabled={!onExitPlayback} onClick={onExitPlayback}>結束示範，繼續作答</button>
      </div>}
      <form onSubmit={check} className="intro-lesson-question">
        <fieldset disabled={blocked}>
          <legend>{step.question}</legend>
          {step.choices.map((choice) => <label key={choice.id} className="intro-lesson-choice"><input type="radio" name={`intro-answer-${step.id}`} value={choice.id} checked={answers[stepIndex] === choice.id} onChange={() => choose(choice.id)} /><span>{choice.label}</span></label>)}
        </fieldset>
        <button className="lab-button lab-button-small" type="submit" disabled={blocked || !answers[stepIndex]}>檢查答案</button>
      </form>
      {feedback && <p className={`intro-lesson-feedback ${feedback.correct ? 'is-correct' : 'is-retry'}`} role="status"><strong>{feedback.correct ? '答對了。' : '再試一次。'}</strong> {feedback.message}</p>}
      {disabled && !playbackActive && <p className="intro-lesson-note">飛行尚未結束。請按飛行畫面下方的 Disarm 解除解鎖，或在課程面板按「停止練習」，再繼續作答。</p>}
      <div className="intro-lesson-actions">
        <button className="lab-button lab-button-small" type="button" disabled={blocked || stepIndex === 0} onClick={() => move(stepIndex - 1)}>上一步</button>
        {stepIndex < STEPS.length - 1
          ? <button className="lab-button lab-button-small" type="button" disabled={blocked || (!correct[stepIndex] && !finished)} onClick={() => move(stepIndex + 1)}>下一步</button>
          : <button className="lab-button lab-button-primary lab-button-small" type="button" disabled={blocked || !allCorrect || finished} onClick={complete}>完成觀念練習</button>}
      </div>
    </section>
  )
}
