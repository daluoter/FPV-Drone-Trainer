import { isFiniteDroneState, type DroneState } from '../drone'
import { isFiniteNormalizedRcInput } from '../flight-controller'
import { DEFAULT_LESSONS } from './lessons'
import type {
  LessonDefinition,
  LessonEvaluator,
  TrainingAction,
  TrainingCheckpointState,
  TrainingEvaluation,
  TrainingEvaluationContext,
  TrainingMachineOptions,
  TrainingMachineState,
  TrainingOutcome,
  TrainingResult,
  TrainingSample,
  TrainingSceneReference,
  TrainingSessionOptions,
  TrainingSetupRequest,
} from './types'

export const DEFAULT_COUNTDOWN_DURATION_SECONDS = 3

const DEFAULT_MAX_SCORE = 100

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function safeCountdown(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : DEFAULT_COUNTDOWN_DURATION_SECONDS
}

function lessonMap(lessons: readonly LessonDefinition[]): ReadonlyMap<string, LessonDefinition> {
  return new Map(lessons.map((lesson) => [lesson.id, lesson]))
}

function copyInput(input: TrainingSample['normalizedInput']): TrainingSample['normalizedInput'] {
  return input ? { ...input } : null
}

function copyState(state: DroneState): DroneState {
  return {
    ...state,
    positionM: { ...state.positionM },
    velocityMps: { ...state.velocityMps },
    orientation: { ...state.orientation },
    angularVelocityBodyRadPerSec: { ...state.angularVelocityBodyRadPerSec },
    motors: state.motors.map((motor) => ({ ...motor })) as unknown as DroneState['motors'],
    warnings: [...state.warnings],
  }
}

function copySample(sample: TrainingSample): TrainingSample {
  return {
    timestampSeconds: sample.timestampSeconds,
    state: copyState(sample.state),
    normalizedInput: copyInput(sample.normalizedInput),
  }
}

function finiteMetrics(metrics: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  if (!metrics) return {}
  return Object.fromEntries(
    Object.entries(metrics).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
  )
}

function copyEvaluation(evaluation: TrainingEvaluation): TrainingEvaluation {
  return {
    ...evaluation,
    checkpointIds: evaluation.checkpointIds ? [...evaluation.checkpointIds] : undefined,
    metrics: finiteMetrics(evaluation.metrics),
  }
}

function checkpointState(definitionId: string): TrainingCheckpointState {
  return {
    id: definitionId,
    completed: false,
    completedAtSeconds: null,
    metrics: {},
  }
}

function initialCheckpoints(lesson: LessonDefinition | null): Readonly<Record<string, TrainingCheckpointState>> {
  if (!lesson) return {}
  return Object.fromEntries(lesson.checkpoints.map((checkpoint) => [checkpoint.id, checkpointState(checkpoint.id)]))
}

function clearSession(
  state: TrainingMachineState,
  lessonId: string | null = state.lessonId,
): TrainingMachineState {
  return {
    ...state,
    phase: 'READY',
    lessonId,
    sessionId: null,
    countdownStartedAtSeconds: null,
    countdownEndsAtSeconds: null,
    activeStartedAtSeconds: null,
    lastTimestampSeconds: null,
    lastSampleTimestampSeconds: null,
    sampleCount: 0,
    trajectory: [],
    checkpoints: {},
    lastEvaluation: null,
    result: null,
    setupRequest: null,
    lastError: null,
  }
}

function nextSessionId(lessonId: string, sessionNumber: number): string {
  return `${lessonId}:${sessionNumber}`
}

function stateError(state: TrainingMachineState, message: string): TrainingMachineState {
  return { ...state, lastError: message }
}

function validTimestamp(value: number): boolean {
  return isFiniteNonNegative(value)
}

function validSample(sample: TrainingSample): boolean {
  if (!validTimestamp(sample.timestampSeconds) || !isFiniteDroneState(sample.state)) return false
  if (sample.normalizedInput !== null && !isFiniteNormalizedRcInput(sample.normalizedInput)) return false
  return true
}

function evaluatorFor(lesson: LessonDefinition): ((sample: TrainingSample, context: TrainingEvaluationContext) => TrainingEvaluation) | null {
  const evaluator: LessonEvaluator | null = lesson.evaluator
  if (!evaluator) return null
  if (typeof evaluator === 'function') return evaluator
  return typeof evaluator.evaluate === 'function' ? evaluator.evaluate : null
}

function isValidEvaluation(value: TrainingEvaluation): boolean {
  return value !== null && typeof value === 'object' && (
    value.status === 'continue' || value.status === 'success' || value.status === 'failure'
  )
}

function updateCheckpoints(
  state: TrainingMachineState,
  lesson: LessonDefinition,
  evaluation: TrainingEvaluation,
  timestampSeconds: number,
): Readonly<Record<string, TrainingCheckpointState>> {
  const next = { ...state.checkpoints }
  for (const id of evaluation.checkpointIds ?? []) {
    if (!next[id]) continue
    const current = next[id]
    next[id] = {
      ...current,
      completed: true,
      completedAtSeconds: current.completedAtSeconds ?? timestampSeconds,
      metrics: finiteMetrics(evaluation.metrics),
    }
  }
  // Definitions are authoritative. This also makes a state created from a
  // lesson edit safe rather than retaining unknown checkpoint keys.
  return Object.fromEntries(lesson.checkpoints.map((checkpoint) => [
    checkpoint.id,
    next[checkpoint.id] ?? checkpointState(checkpoint.id),
  ]))
}

function normalizedScore(lesson: LessonDefinition, evaluation: TrainingEvaluation): number {
  const maximum = Number.isFinite(lesson.scoring.maxScore) && lesson.scoring.maxScore > 0
    ? lesson.scoring.maxScore
    : DEFAULT_MAX_SCORE
  const candidate = evaluation.score ?? (evaluation.status === 'success' ? maximum : 0)
  if (!Number.isFinite(candidate)) return 0
  return Math.max(0, Math.min(maximum, candidate)) / maximum * 100
}

function createResult(
  state: TrainingMachineState,
  lesson: LessonDefinition,
  outcome: TrainingOutcome,
  timestampSeconds: number,
  evaluation: TrainingEvaluation,
  checkpoints: Readonly<Record<string, TrainingCheckpointState>>,
): TrainingResult {
  const startedAtSeconds = state.activeStartedAtSeconds ?? timestampSeconds
  const completedCheckpoints = Object.values(checkpoints).filter((checkpoint) => checkpoint.completed).length
  const elapsedSeconds = Math.max(0, timestampSeconds - startedAtSeconds)
  const metrics = {
    ...finiteMetrics(evaluation.metrics),
    elapsedSeconds,
    sampleCount: state.sampleCount,
    completedCheckpoints,
    totalCheckpoints: lesson.checkpoints.length,
  }
  return {
    lessonId: lesson.id,
    sessionId: state.sessionId ?? nextSessionId(lesson.id, state.sessionNumber),
    outcome,
    score: normalizedScore(lesson, evaluation),
    elapsedSeconds,
    sampleCount: state.sampleCount,
    completedCheckpoints,
    totalCheckpoints: lesson.checkpoints.length,
    startedAtSeconds,
    completedAtSeconds: timestampSeconds,
    metrics,
    message: evaluation.message ?? (outcome === 'SUCCESS' ? lesson.success.description : lesson.failure.description),
    hint: evaluation.hint ?? (outcome === 'SUCCESS' ? null : lesson.hints[0] ?? null),
  }
}

function startSession(state: TrainingMachineState, lesson: LessonDefinition, timestampSeconds: number): TrainingMachineState {
  const sessionNumber = state.sessionNumber + 1
  const sessionId = nextSessionId(lesson.id, sessionNumber)
  const countdownDuration = state.countdownDurationSeconds
  const countdownEnds = timestampSeconds + countdownDuration
  const setupRequest: TrainingSetupRequest = {
    lessonId: lesson.id,
    sessionId,
    setup: lesson.setup,
  }
  return {
    ...state,
    phase: 'COUNTDOWN',
    sessionId,
    sessionNumber,
    countdownStartedAtSeconds: timestampSeconds,
    countdownEndsAtSeconds: countdownEnds,
    activeStartedAtSeconds: null,
    lastTimestampSeconds: timestampSeconds,
    lastSampleTimestampSeconds: null,
    sampleCount: 0,
    trajectory: [],
    checkpoints: initialCheckpoints(lesson),
    lastEvaluation: null,
    result: null,
    setupRequest,
    lastError: null,
  }
}

function tick(state: TrainingMachineState, timestampSeconds: number): TrainingMachineState {
  if (!validTimestamp(timestampSeconds)) return stateError(state, 'Training timestamp must be finite and non-negative.')
  if (state.lastTimestampSeconds !== null && timestampSeconds < state.lastTimestampSeconds) {
    return stateError(state, 'Training timestamps must be monotonic.')
  }

  if (state.phase === 'COUNTDOWN') {
    const ends = state.countdownEndsAtSeconds ?? timestampSeconds
    if (timestampSeconds >= ends) {
      return {
        ...state,
        phase: 'ACTIVE',
        activeStartedAtSeconds: ends,
        lastTimestampSeconds: timestampSeconds,
        lastError: null,
      }
    }
  }

  if (state.phase === 'COUNTDOWN' || state.phase === 'ACTIVE') {
    return { ...state, lastTimestampSeconds: timestampSeconds, lastError: null }
  }
  return state
}

function sampleActiveState(
  state: TrainingMachineState,
  lesson: LessonDefinition,
  sample: TrainingSample,
): TrainingMachineState {
  if (!validSample(sample)) return stateError(state, 'Training sample is invalid or contains non-finite values.')
  if (state.activeStartedAtSeconds === null || sample.timestampSeconds < state.activeStartedAtSeconds) {
    return stateError(state, 'Training samples are not accepted before ACTIVE begins.')
  }
  if (
    state.lastSampleTimestampSeconds !== null &&
    sample.timestampSeconds <= state.lastSampleTimestampSeconds
  ) {
    return stateError(state, 'Training sample timestamps must increase for each sample.')
  }

  const storedSample = copySample(sample)
  const trajectory = [...state.trajectory, storedSample]
  const sampleCount = state.sampleCount + 1
  const baseState: TrainingMachineState = {
    ...state,
    lastTimestampSeconds: sample.timestampSeconds,
    lastSampleTimestampSeconds: sample.timestampSeconds,
    sampleCount,
    trajectory,
    lastError: null,
  }
  const evaluator = evaluatorFor(lesson)
  if (!evaluator) return stateError(baseState, 'This lesson has no evaluator and cannot produce a result.')

  const elapsedSeconds = Math.max(0, sample.timestampSeconds - (state.activeStartedAtSeconds ?? sample.timestampSeconds))
  const context: TrainingEvaluationContext = {
    lesson,
    elapsedSeconds,
    trajectory,
    checkpoints: state.checkpoints,
    sceneReferences: state.sceneReferences,
  }
  let evaluation: TrainingEvaluation
  try {
    const candidate = evaluator(storedSample, context)
    if (!isValidEvaluation(candidate)) throw new Error('Invalid evaluator result')
    evaluation = copyEvaluation(candidate)
  } catch {
    const failure: TrainingEvaluation = {
      status: 'failure',
      message: 'The lesson evaluator failed safely; this attempt was not passed.',
    }
    const result = createResult(baseState, lesson, 'FAILED', sample.timestampSeconds, failure, state.checkpoints)
    return {
      ...baseState,
      phase: 'FAILED',
      lastEvaluation: failure,
      result,
      setupRequest: null,
    }
  }

  const checkpoints = updateCheckpoints(baseState, lesson, evaluation, sample.timestampSeconds)
  const checkpointState = { ...baseState, checkpoints, lastEvaluation: evaluation }
  if (evaluation.status === 'failure') {
    return {
      ...checkpointState,
      phase: 'FAILED',
      result: createResult(checkpointState, lesson, 'FAILED', sample.timestampSeconds, evaluation, checkpoints),
      setupRequest: null,
    }
  }

  if (evaluation.status === 'success') {
    const minimumActiveSeconds = Number.isFinite(lesson.scoring.minimumActiveSeconds)
      ? Math.max(0, lesson.scoring.minimumActiveSeconds)
      : 0
    if (elapsedSeconds < minimumActiveSeconds) {
      return stateError(
        checkpointState,
        `Success is locked until ${minimumActiveSeconds.toFixed(2)} active seconds have elapsed.`,
      )
    }
    const score = normalizedScore(lesson, evaluation)
    const minimumPassingScore = Number.isFinite(lesson.scoring.minimumPassingScore)
      ? Math.max(0, Math.min(100, lesson.scoring.minimumPassingScore))
      : 0
    const outcome: TrainingOutcome = score >= minimumPassingScore ? 'SUCCESS' : 'FAILED'
    return {
      ...checkpointState,
      phase: outcome,
      result: createResult(checkpointState, lesson, outcome, sample.timestampSeconds, evaluation, checkpoints),
      setupRequest: null,
    }
  }

  return checkpointState
}

/** Build an immutable machine state without starting a physics session. */
export function createTrainingMachineState(
  options: TrainingMachineOptions = {},
  lessons: readonly LessonDefinition[] = DEFAULT_LESSONS,
): TrainingMachineState {
  const countdownDurationSeconds = safeCountdown(options.countdownDurationSeconds)
  const lesson = options.initialLessonId
    ? lessons.find((candidate) => candidate.id === options.initialLessonId) ?? null
    : null
  return {
    phase: 'READY',
    lessonId: lesson?.id ?? null,
    sessionId: null,
    sessionNumber: 0,
    countdownDurationSeconds,
    countdownStartedAtSeconds: null,
    countdownEndsAtSeconds: null,
    activeStartedAtSeconds: null,
    lastTimestampSeconds: null,
    lastSampleTimestampSeconds: null,
    sampleCount: 0,
    trajectory: [],
    checkpoints: {},
    lastEvaluation: null,
    result: null,
    setupRequest: null,
    sceneReferences: (options.sceneReferences ?? []).map((reference: TrainingSceneReference) => ({
      ...reference,
      positionM: { ...reference.positionM },
      sizeM: reference.sizeM ? { ...reference.sizeM } : undefined,
    })),
    lastError: null,
  }
}

/** Pure reducer for the READY -> COUNTDOWN -> ACTIVE -> result machine. */
export function reduceTrainingState(
  state: TrainingMachineState,
  action: TrainingAction,
  lessons: readonly LessonDefinition[] = DEFAULT_LESSONS,
): TrainingMachineState {
  const byId = lessonMap(lessons)
  switch (action.type) {
    case 'SELECT_LESSON': {
      if (state.phase !== 'READY' && state.phase !== 'RESULT') {
        return stateError(state, 'Select a lesson only when the training screen is ready.')
      }
      const lesson = byId.get(action.lessonId)
      if (!lesson) return stateError(state, 'The selected lesson is not registered.')
      if (!lesson.available || !lesson.evaluator) {
        return stateError(state, 'This lesson is coming soon; its evaluator is not available yet.')
      }
      return clearSession({ ...state, lessonId: lesson.id }, lesson.id)
    }
    case 'START': {
      if (state.phase !== 'READY') return stateError(state, 'A lesson can only start from READY.')
      if (!validTimestamp(action.timestampSeconds)) return stateError(state, 'Training timestamp must be finite and non-negative.')
      if (!state.lessonId) return stateError(state, 'Select an available lesson before starting training.')
      const lesson = byId.get(state.lessonId)
      if (!lesson || !lesson.available || !evaluatorFor(lesson)) {
        return stateError(state, 'This lesson is coming soon; its evaluator is not available yet.')
      }
      return startSession(state, lesson, action.timestampSeconds)
    }
    case 'TICK':
      return tick(state, action.timestampSeconds)
    case 'SAMPLE': {
      if (state.phase === 'READY' || state.phase === 'SUCCESS' || state.phase === 'FAILED' || state.phase === 'RESULT') {
        // The runtime observer remains attached outside a lesson session. Idle
        // and terminal samples are ignored, not treated as evaluator errors.
        return state
      }
      if (state.phase === 'COUNTDOWN') {
        // Crossing the countdown boundary changes phase, but the boundary
        // sample is not evaluated. This prevents pre-start state from passing.
        return tick(state, action.sample.timestampSeconds)
      }
      if (state.phase !== 'ACTIVE') return stateError(state, 'Samples are accepted only while ACTIVE.')
      if (!state.lessonId) return stateError(state, 'The active training session has no lesson.')
      const lesson = byId.get(state.lessonId)
      if (!lesson) return stateError(state, 'The active lesson is no longer registered.')
      return sampleActiveState(state, lesson, action.sample)
    }
    case 'SHOW_RESULT':
      if (state.phase !== 'SUCCESS' && state.phase !== 'FAILED') {
        return stateError(state, 'Results are shown only after SUCCESS or FAILED.')
      }
      return { ...state, phase: 'RESULT', lastError: null }
    case 'RETRY':
      if (!state.lessonId) return stateError(state, 'There is no lesson session to retry.')
      if (state.phase === 'COUNTDOWN' || state.phase === 'ACTIVE') {
        return clearSession({ ...state, sessionNumber: state.sessionNumber + 1 })
      }
      if (state.phase === 'SUCCESS' || state.phase === 'FAILED' || state.phase === 'RESULT') {
        return clearSession({ ...state, sessionNumber: state.sessionNumber + 1 })
      }
      return stateError(state, 'Retry is available after a lesson session starts.')
    case 'RESET':
      return clearSession({ ...state, sessionNumber: state.sessionNumber + (state.sessionId ? 1 : 0) })
    default:
      return state
  }
}

/** Stateful adapter for UI/runtime integration; all transitions remain pure. */
export class TrainingSession {
  private readonly lessons: readonly LessonDefinition[]
  private state: TrainingMachineState

  public constructor(options: TrainingSessionOptions = {}) {
    this.lessons = options.lessons ?? DEFAULT_LESSONS
    this.state = createTrainingMachineState(options, this.lessons)
  }

  public getState(): TrainingMachineState {
    return this.state
  }

  public get lessonsList(): readonly LessonDefinition[] {
    return this.lessons
  }

  public getLesson(lessonId: string): LessonDefinition | null {
    return this.lessons.find((lesson) => lesson.id === lessonId) ?? null
  }

  public dispatch(action: TrainingAction): TrainingMachineState {
    this.state = reduceTrainingState(this.state, action, this.lessons)
    return this.state
  }

  public selectLesson(lessonId: string): TrainingMachineState {
    return this.dispatch({ type: 'SELECT_LESSON', lessonId })
  }

  public start(timestampSeconds: number): TrainingMachineState {
    return this.dispatch({ type: 'START', timestampSeconds })
  }

  public tick(timestampSeconds: number): TrainingMachineState {
    return this.dispatch({ type: 'TICK', timestampSeconds })
  }

  public advance(timestampSeconds: number): TrainingMachineState {
    return this.tick(timestampSeconds)
  }

  public consumeSample(sample: TrainingSample): TrainingMachineState {
    return this.dispatch({ type: 'SAMPLE', sample })
  }

  public ingestSample(sample: TrainingSample): TrainingMachineState {
    return this.consumeSample(sample)
  }

  public showResult(): TrainingMachineState {
    return this.dispatch({ type: 'SHOW_RESULT' })
  }

  public finishResult(): TrainingMachineState {
    return this.showResult()
  }

  public retry(): TrainingMachineState {
    return this.dispatch({ type: 'RETRY' })
  }

  public reset(): TrainingMachineState {
    return this.dispatch({ type: 'RESET' })
  }
}

export const TrainingMachine = TrainingSession
export const TrainingStateMachine = TrainingSession
export const transitionTrainingState = reduceTrainingState
export const createTrainingState = createTrainingMachineState
