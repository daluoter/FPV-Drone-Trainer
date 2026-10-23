import { createInitialDroneState, droneGroundSupport } from '../drone'
import type { ReplaySample } from '../replay'
import { GROUND_CONTACT_SLOP_M } from '../simulation/dynamics'
import type { TuningSettings } from '../tuning/config'
import { fingerprintTrainingSettings } from './attempt'
import { lessonLearningContent } from './catalog'
import type { TeachingDemonstration, TeachingDemonstrationKind } from './demonstrations'
import { createTrainingFieldAnchors } from './field'
import { lessonById } from './lessons'
import type { TrainingCheckpointState, TrainingEvaluation, TrainingSample } from './types'

export type TeachingDemonstrationProgressMode = 'lesson-checkpoints' | 'teaching-steps'
export type TeachingDemonstrationStepStatus = 'completed' | 'current' | 'pending'

export interface TeachingDemonstrationProgressStep {
  readonly id: string
  readonly title: string
  readonly status: TeachingDemonstrationStepStatus
  /** The actual chapter start in the recording, including a chapter not yet watched. */
  readonly startedAtSeconds: number | null
  /** Only visible as completed after playback reaches the recorded observation. */
  readonly completedAtSeconds: number | null
}

export interface TeachingDemonstrationProgressSnapshot {
  readonly kind: TeachingDemonstrationKind
  readonly title: string
  readonly lessonId: TeachingDemonstration['lessonId']
  readonly mode: TeachingDemonstrationProgressMode
  readonly steps: readonly TeachingDemonstrationProgressStep[]
  readonly completedSteps: number
  readonly totalSteps: number
  readonly currentStepIndex: number | null
  readonly currentStepTitle: string
  readonly complete: boolean
  readonly notice: string | null
}

export interface TeachingDemonstrationProgressChapter {
  readonly id: string
  readonly title: string
  readonly startedAtSeconds: number | null
}

export interface TeachingDemonstrationProgressFrame {
  readonly timeSeconds: number
  readonly completedAtSeconds: readonly (number | null)[]
  readonly complete: boolean
  readonly notice: string | null
}

/** A bounded, immutable presentation index; it contains no live training state. */
export interface TeachingDemonstrationProgressTimeline {
  readonly kind: TeachingDemonstrationKind
  readonly title: string
  readonly lessonId: TeachingDemonstration['lessonId']
  readonly mode: TeachingDemonstrationProgressMode
  readonly durationSeconds: number
  readonly steps: readonly TeachingDemonstrationProgressChapter[]
  readonly frames: readonly TeachingDemonstrationProgressFrame[]
}

const CLOCK_TOLERANCE_SECONDS = 1e-9

function frozenFrame(timeSeconds: number, completedAtSeconds: readonly (number | null)[], complete = false, notice: string | null = null): TeachingDemonstrationProgressFrame {
  return Object.freeze({ timeSeconds, completedAtSeconds: Object.freeze([...completedAtSeconds]), complete, notice })
}

function freezeTimeline(timeline: TeachingDemonstrationProgressTimeline): TeachingDemonstrationProgressTimeline {
  return Object.freeze({ ...timeline,
    steps: Object.freeze(timeline.steps.map((step) => Object.freeze({ ...step }))),
    frames: Object.freeze([...timeline.frames]),
  })
}

/** L00 demonstrates actions, so its chapters describe those actions rather than flight mastery. */
function axisProgress(demonstration: TeachingDemonstration): TeachingDemonstrationProgressTimeline {
  const name = demonstration.kind === 'roll' ? '橫滾 Roll' : demonstration.kind === 'pitch' ? '俯仰 Pitch' : '偏航 Yaw'
  const labels = ['觀察起始姿態', `小量操作${name}`, '回中，觀察旋轉停止', '反向修正姿態或方向', '回中，觀察修正結果']
  const duration = demonstration.recording.durationSeconds
  const starts = demonstration.cues.map((cue) => cue.timeSeconds)
  const steps = labels.map((title, index) => ({ id: `axis-demo-${index + 1}`, title, startedAtSeconds: starts[index] ?? null }))
  const completed: (number | null)[] = steps.map(() => null)
  const frames: TeachingDemonstrationProgressFrame[] = [frozenFrame(0, completed)]
  for (let index = 0; index < steps.length; index += 1) {
    const end = starts[index + 1] ?? duration
    if (steps[index].startedAtSeconds === null || end > duration || end < (steps[index].startedAtSeconds ?? 0)) break
    completed[index] = end
    frames.push(frozenFrame(end, completed, index === steps.length - 1))
  }
  return freezeTimeline({ kind: demonstration.kind, title: `L00 ${name}示範`, lessonId: demonstration.lessonId,
    mode: 'teaching-steps', durationSeconds: duration, steps, frames })
}

/** Project only the recorded measured fields; missing motor/PID history is never invented as proof. */
function observedSample(settings: TuningSettings, pose: ReplaySample, index: number, initial: ReturnType<typeof createInitialDroneState>): TrainingSample {
  const supportOffsetM = droneGroundSupport(settings.drone, pose.orientation).supportOffsetM
  return {
    timestampSeconds: pose.timestampSeconds, armed: true, normalizedInput: pose.normalizedInput,
    groundContact: { heightM: settings.drone.ground.heightM, supportOffsetM,
      touching: pose.positionM.y - supportOffsetM <= settings.drone.ground.heightM + GROUND_CONTACT_SLOP_M + 1e-5 },
    state: { ...initial, positionM: pose.positionM, orientation: pose.orientation, velocityMps: pose.velocityMps,
      angularVelocityBodyRadPerSec: pose.angularVelocityBodyRadPerSec, timeSeconds: pose.timestampSeconds, stepIndex: index },
  }
}

/**
 * Observe a completed demo once, outside the live session/store. Chapter changes
 * come from actual retained state and the lesson evaluator, never future captions.
 */
export function createDemonstrationProgress(
  demonstration: TeachingDemonstration,
  settings: TuningSettings,
): TeachingDemonstrationProgressTimeline {
  if (demonstration.settingsFingerprint !== fingerprintTrainingSettings(settings)) {
    throw new RangeError('示範進度需要使用錄製當時的設定。')
  }
  if (demonstration.lessonId === 'intro') return axisProgress(demonstration)
  const lesson = lessonById(demonstration.lessonId)
  if (!lesson) throw new RangeError('此示範沒有對應的課程步驟。')
  const evaluator = typeof lesson.evaluator === 'function' ? lesson.evaluator : lesson.evaluator?.evaluate
  if (!evaluator) throw new RangeError('此示範沒有可觀察的課程判定。')
  const { pad, launch, landing } = createTrainingFieldAnchors(settings.drone)
  const references = [
    { id: 'takeoff-pad', kind: 'pad', positionM: pad },
    { id: 'training-launch', kind: 'spawn', positionM: launch },
    { id: 'landing-surface', kind: 'ground', positionM: landing },
  ]
  const firstTime = demonstration.recording.samples[0]?.timestampSeconds ?? 0
  const steps = lesson.checkpoints.map((checkpoint, index) => ({ id: checkpoint.id, title: checkpoint.title,
    startedAtSeconds: index === 0 ? 0 : null as number | null }))
  let checkpoints: Record<string, TrainingCheckpointState> = {}
  let completed = steps.map((): number | null => null)
  const frames: TeachingDemonstrationProgressFrame[] = [frozenFrame(0, completed)]
  const initial = createInitialDroneState(settings.drone)
  let previous: TrainingSample | null = null
  let previousFlight: TrainingSample | null = null
  let previousEvaluation: TrainingEvaluation | null = null
  let complete = false
  for (const [index, pose] of demonstration.recording.samples.entries()) {
    const sample = observedSample(settings, pose, index, initial)
    const time = pose.timestampSeconds - firstTime
    const evaluation: TrainingEvaluation = evaluator(sample, {
      lesson, mode: 'practice', elapsedSeconds: time, trajectory: [], checkpoints, sceneReferences: references,
      sampleCount: index + 1, previousSample: previous, previousFlightSample: previousFlight, previousEvaluation,
    })
    if (evaluation.recovery === 'restart') {
      checkpoints = {}
      if (completed.some((value) => value !== null)) {
        completed = steps.map(() => null)
        frames.push(frozenFrame(time, completed))
      }
      previous = null
      previousEvaluation = null
      previousFlight = sample
      continue
    }
    let changed = false
    for (const id of evaluation.checkpointIds ?? []) {
      const stepIndex = steps.findIndex((step) => step.id === id)
      if (stepIndex < 0 || completed[stepIndex] !== null) continue
      completed[stepIndex] = time
      checkpoints[id] = { id, completed: true, completedAtSeconds: pose.timestampSeconds, metrics: { ...evaluation.metrics } }
      changed = true
    }
    // An evaluator may observe several ordered phases in one retained frame
    // (for example liftoff and transit). Those chapters share the preceding
    // physical observation rather than remaining unseekable after completion.
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      if (completed[stepIndex] !== null && steps[stepIndex].startedAtSeconds === null) {
        steps[stepIndex].startedAtSeconds = stepIndex === 0 ? 0 : completed[stepIndex - 1] ?? time
      }
    }
    const nextIndex = completed.findIndex((value) => value === null)
    if (nextIndex >= 0 && steps[nextIndex].startedAtSeconds === null) steps[nextIndex].startedAtSeconds = time
    complete = evaluation.status === 'success' && nextIndex === -1 && time >= lesson.scoring.minimumActiveSeconds
    if (changed || complete) frames.push(frozenFrame(time, completed, complete))
    if (evaluation.status === 'failure') {
      frames.push(frozenFrame(time, completed, false, '這段示範尚未完成全部課程步驟。'))
      break
    }
    if (complete) break
    previous = sample
    previousFlight = sample
    previousEvaluation = evaluation
  }
  if (!complete) {
    frames.push(frozenFrame(demonstration.recording.durationSeconds, completed, false, '這段示範尚未完成全部課程步驟。'))
  }
  const content = lessonLearningContent(lesson.id)
  return freezeTimeline({ kind: demonstration.kind, title: `${content?.code ?? ''} ${content?.title ?? lesson.title}`.trim(),
    lessonId: demonstration.lessonId, mode: 'lesson-checkpoints', durationSeconds: demonstration.recording.durationSeconds,
    steps, frames })
}

/** Query only the playback clock. Seeking backward restores earlier checks as well as the current chapter. */
export function demonstrationProgressAt(
  timeline: TeachingDemonstrationProgressTimeline,
  timeSeconds: number,
): TeachingDemonstrationProgressSnapshot {
  const time = Number.isFinite(timeSeconds) ? Math.max(0, Math.min(timeline.durationSeconds, timeSeconds)) : 0
  let low = 0
  let high = timeline.frames.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (timeline.frames[middle].timeSeconds <= time + CLOCK_TOLERANCE_SECONDS) low = middle
    else high = middle - 1
  }
  const frame = timeline.frames[low]
  const firstPending = frame.completedAtSeconds.findIndex((completedAt) => completedAt === null)
  const currentStepIndex = frame.complete ? null : firstPending < 0 ? timeline.steps.length - 1 : firstPending
  const steps = timeline.steps.map((step, index): TeachingDemonstrationProgressStep => Object.freeze({
    ...step, completedAtSeconds: frame.completedAtSeconds[index] ?? null,
    status: frame.completedAtSeconds[index] !== null ? 'completed' : index === currentStepIndex ? 'current' : 'pending',
  }))
  return Object.freeze({ kind: timeline.kind, title: timeline.title, lessonId: timeline.lessonId, mode: timeline.mode,
    steps: Object.freeze(steps), completedSteps: frame.completedAtSeconds.filter((value) => value !== null).length,
    totalSteps: timeline.steps.length, currentStepIndex,
    currentStepTitle: currentStepIndex === null ? '示範步驟已完成' : timeline.steps[currentStepIndex]?.title ?? '等待示範開始',
    complete: frame.complete, notice: frame.notice })
}
