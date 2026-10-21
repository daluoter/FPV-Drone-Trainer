import { isFiniteDroneState, type DroneState } from '../drone'
import { isFiniteNormalizedRcInput } from '../flight-controller'
import { DEFAULT_LESSONS } from './lessons'
import type { TrainingAttemptContext } from './attempt'
import {
  appendBoundedTrajectorySnapshot,
  TrainingTrajectoryBuffer,
} from './trajectory'
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
const EMPTY_TRAJECTORY: readonly TrainingSample[] = Object.freeze([])

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function safeCountdown(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : DEFAULT_COUNTDOWN_DURATION_SECONDS
}

function lessonMap(lessons: readonly LessonDefinition[]): ReadonlyMap<string, LessonDefinition> {
  return new Map(lessons.map((lesson) => [lesson.id, lesson]))
}

function copySceneReferences(references: readonly TrainingSceneReference[]): readonly TrainingSceneReference[] {
  return references.map((reference) => ({
    ...reference,
    positionM: { ...reference.positionM },
    sizeM: reference.sizeM ? { ...reference.sizeM } : undefined,
  }))
}

function copyInput(input: TrainingSample['normalizedInput']): TrainingSample['normalizedInput'] {
  return input ? { ...input } : null
}

function copyState(state: DroneState): DroneState {
  return Object.freeze({
    ...state,
    positionM: Object.freeze({ ...state.positionM }),
    velocityMps: Object.freeze({ ...state.velocityMps }),
    orientation: Object.freeze({ ...state.orientation }),
    angularVelocityBodyRadPerSec: Object.freeze({ ...state.angularVelocityBodyRadPerSec }),
    motors: Object.freeze(state.motors.map((motor) => Object.freeze({ ...motor }))) as unknown as DroneState['motors'],
    warnings: Object.freeze([...state.warnings]),
  })
}

function copySample(sample: TrainingSample): TrainingSample {
  const normalizedInput = copyInput(sample.normalizedInput)
  return Object.freeze({
    timestampSeconds: sample.timestampSeconds,
    state: copyState(sample.state),
    normalizedInput: normalizedInput ? Object.freeze(normalizedInput) : null,
    ...(sample.armed === undefined ? {} : { armed: sample.armed }),
    ...(sample.groundContact ? { groundContact: Object.freeze({ ...sample.groundContact }) } : {}),
  })
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
    requiresDisarmBeforeArm: false,
    lastTimestampSeconds: null,
    lastSampleTimestampSeconds: null,
    sampleCount: 0,
    trajectory: EMPTY_TRAJECTORY,
    checkpoints: {},
    lastEvaluation: null,
    lastRecovery: null,
    recoveryInProgress: false,
    result: null,
    setupRequest: null,
    armedAtLeastOnce: false,
    previousSample: null,
    previousFlightSample: null,
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
  if (sample.armed !== undefined && typeof sample.armed !== 'boolean') return false
  if (sample.groundContact !== undefined && (
    !Number.isFinite(sample.groundContact.heightM)
    || !Number.isFinite(sample.groundContact.supportOffsetM)
    || sample.groundContact.supportOffsetM < 0
    || typeof sample.groundContact.touching !== 'boolean'
  )) return false
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
  ) && (value.recovery === undefined || (value.recovery === 'restart' && value.status === 'continue'))
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
    ...(state.attemptContext ? { attemptContext: Object.freeze({ ...state.attemptContext }) } : {}),
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

function publishTrajectorySnapshot(
  state: TrainingMachineState,
  trajectoryBuffer: TrainingTrajectoryBuffer | undefined,
  timestampSeconds?: number,
): TrainingMachineState {
  if (!trajectoryBuffer) return state
  return { ...state, trajectory: trajectoryBuffer.snapshot(timestampSeconds) }
}

function abortSession(
  state: TrainingMachineState,
  lessons: readonly LessonDefinition[],
  timestampSeconds: number,
  reason = 'The flight was disarmed, reset, or focus was lost; the attempt was stopped safely.',
  trajectoryBuffer?: TrainingTrajectoryBuffer,
): TrainingMachineState {
  if (state.phase !== 'ACTIVE') return stateError(state, 'Only an ACTIVE lesson can be stopped by runtime safety telemetry.')
  const lesson = state.lessonId ? lessons.find((candidate) => candidate.id === state.lessonId) ?? null : null
  if (!lesson) return stateError(state, 'The active lesson is no longer registered.')
  const safeTimestamp = validTimestamp(timestampSeconds)
    ? timestampSeconds
    : state.lastTimestampSeconds ?? state.activeStartedAtSeconds ?? 0
  const failure: TrainingEvaluation = {
    status: 'failure',
    message: reason,
    hint: 'Retry to apply the lesson setup while disarmed, then arm explicitly after the countdown.',
  }
  const terminalState = publishTrajectorySnapshot(state, trajectoryBuffer, safeTimestamp)
  return {
    ...terminalState,
    phase: 'FAILED',
    lastEvaluation: failure,
    result: createResult(terminalState, lesson, 'FAILED', safeTimestamp, failure, state.checkpoints),
    setupRequest: null,
    lastError: reason,
  }
}

function startSession(
  state: TrainingMachineState,
  lesson: LessonDefinition,
  timestampSeconds: number,
  attemptContext = state.attemptContext,
): TrainingMachineState {
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
    attemptContext: attemptContext ? Object.freeze({ ...attemptContext }) : undefined,
    phase: 'COUNTDOWN',
    sessionId,
    sessionNumber,
    countdownStartedAtSeconds: timestampSeconds,
    countdownEndsAtSeconds: countdownEnds,
    activeStartedAtSeconds: null,
    requiresDisarmBeforeArm: false,
    lastTimestampSeconds: timestampSeconds,
    lastSampleTimestampSeconds: null,
    armedAtLeastOnce: false,
    previousSample: null,
    previousFlightSample: null,
    sampleCount: 0,
    trajectory: EMPTY_TRAJECTORY,
    checkpoints: initialCheckpoints(lesson),
    lastEvaluation: null,
    lastRecovery: null,
    recoveryInProgress: false,
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
        phase: 'WAITING_FOR_ARM',
        lastTimestampSeconds: timestampSeconds,
        lastError: null,
      }
    }
  }

  if (state.phase === 'COUNTDOWN' || state.phase === 'WAITING_FOR_ARM' || state.phase === 'ACTIVE') {
    return { ...state, lastTimestampSeconds: timestampSeconds, lastError: null }
  }
  return state
}

function sampleWaitingState(
  state: TrainingMachineState,
  lesson: LessonDefinition,
  sample: TrainingSample,
  trajectoryBuffer?: TrainingTrajectoryBuffer,
): TrainingMachineState {
  const waiting = { ...state, lastTimestampSeconds: sample.timestampSeconds }
  if (sample.state.crashed) {
    return stateError(waiting, 'Reset the crashed drone and retry before arming the lesson.')
  }
  if (sample.armed === false) {
    return { ...waiting, requiresDisarmBeforeArm: false, lastError: null }
  }
  if (sample.armed !== true) {
    return stateError(waiting, 'Waiting for explicit arm telemetry before the lesson can evaluate.')
  }
  if (state.requiresDisarmBeforeArm) {
    return stateError(waiting, 'The drone armed during countdown; disarm, then arm explicitly to start the lesson.')
  }
  // The first valid armed sample establishes the clock and the first scoring
  // sample together. Time spent in countdown or waiting is never charged.
  return sampleActiveState({
    ...waiting,
    phase: 'ACTIVE',
    activeStartedAtSeconds: sample.timestampSeconds,
    armedAtLeastOnce: true,
    lastError: null,
  }, lesson, sample, trajectoryBuffer)
}

function sampleActiveState(
  state: TrainingMachineState,
  lesson: LessonDefinition,
  sample: TrainingSample,
  trajectoryBuffer?: TrainingTrajectoryBuffer,
): TrainingMachineState {
  if (!validSample(sample)) return abortSession(state, [lesson], state.lastTimestampSeconds ?? 0,
    'Attempt stopped: training sample is invalid or contains non-finite values.', trajectoryBuffer)
  if (state.activeStartedAtSeconds === null || sample.timestampSeconds < state.activeStartedAtSeconds) {
    return stateError(state, 'Training samples are not accepted before ACTIVE begins.')
  }
  if (sample.state.crashed) {
    return abortSession(
      state,
      [lesson],
      sample.timestampSeconds,
      'Attempt stopped: the drone crashed; reset and retry the lesson.',
      trajectoryBuffer,
    )
  }
  if (sample.armed === false) {
    return abortSession(
      state,
      [lesson],
      sample.timestampSeconds,
      'Attempt stopped: the flight was disarmed or focus was lost.',
      trajectoryBuffer,
    )
  }
  if (sample.armed !== true) {
    return stateError(state, 'Explicit armed telemetry is required for each scored training sample.')
  }
  const previousSample = state.previousSample
  const previousFlightSample = state.previousFlightSample ?? previousSample
  if (
    state.lastTimestampSeconds !== null &&
    sample.timestampSeconds < state.lastTimestampSeconds
  ) {
    return stateError(state, 'Training sample timestamps must be monotonic.')
  }
  if (
    state.lastSampleTimestampSeconds !== null &&
    sample.timestampSeconds <= state.lastSampleTimestampSeconds
  ) {
    return stateError(state, 'Training sample timestamps must increase for each sample.')
  }

  if (
    previousFlightSample && (
      sample.state.stepIndex <= previousFlightSample.state.stepIndex
      || sample.state.timeSeconds <= previousFlightSample.state.timeSeconds
      || Math.abs((sample.state.timeSeconds - previousFlightSample.state.timeSeconds)
        - (sample.timestampSeconds - previousFlightSample.timestampSeconds)) > 1e-6
    )
  ) {
    const failure: TrainingEvaluation = {
      status: 'failure',
      message: 'The flight runtime reset, rewound or stopped advancing its physical clock; the lesson was stopped safely.',
      hint: 'Retry to apply the lesson setup while disarmed, then arm explicitly after the countdown.',
    }
    const terminalState = publishTrajectorySnapshot(state, trajectoryBuffer, sample.timestampSeconds)
    const result = createResult(terminalState, lesson, 'FAILED', sample.timestampSeconds, failure, state.checkpoints)
    return {
      ...terminalState,
      phase: 'FAILED',
      lastEvaluation: failure,
      result,
      setupRequest: null,
      lastError: failure.message ?? null,
    }
  }
  const storedSample = copySample(sample)
  const sampleCount = state.sampleCount + 1
  trajectoryBuffer?.append(storedSample, sampleCount)
  const trajectory = trajectoryBuffer
    ? trajectoryBuffer.shouldPublish(sampleCount, sample.timestampSeconds)
      ? trajectoryBuffer.snapshot(sample.timestampSeconds)
      : state.trajectory
    : appendBoundedTrajectorySnapshot(state.trajectory, storedSample, sampleCount)
  const baseState: TrainingMachineState = {
    ...state,
    lastTimestampSeconds: sample.timestampSeconds,
    lastSampleTimestampSeconds: sample.timestampSeconds,
    armedAtLeastOnce: state.armedAtLeastOnce === true || sample.armed === true,
    previousSample: storedSample,
    previousFlightSample: storedSample,
    sampleCount,
    trajectory,
    lastError: null,
  }
  const evaluator = evaluatorFor(lesson)
  if (!evaluator) return stateError(baseState, 'This lesson has no evaluator and cannot produce a result.')

  const elapsedSeconds = Math.max(0, sample.timestampSeconds - (state.activeStartedAtSeconds ?? sample.timestampSeconds))
  const context: TrainingEvaluationContext = {
    mode: state.attemptContext?.mode ?? 'challenge',
    lesson,
    elapsedSeconds,
    sampleCount,
    trajectory,
    checkpoints: state.checkpoints,
    sceneReferences: state.sceneReferences,
    previousSample,
    previousFlightSample,
    previousEvaluation: state.lastEvaluation?.recovery === 'restart' ? undefined : state.lastEvaluation,
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
    const terminalState = publishTrajectorySnapshot(baseState, trajectoryBuffer, sample.timestampSeconds)
    const result = createResult(terminalState, lesson, 'FAILED', sample.timestampSeconds, failure, state.checkpoints)
    return {
      ...terminalState,
      phase: 'FAILED',
      lastEvaluation: failure,
      result,
      setupRequest: null,
    }
  }

  if (context.mode === 'practice' && evaluation.recovery === 'restart') {
    const lastRecovery = state.recoveryInProgress && state.lastRecovery
      ? state.lastRecovery
      : Object.freeze({
        timestampSeconds: sample.timestampSeconds,
        message: typeof evaluation.message === 'string' && evaluation.message.trim()
          ? evaluation.message.trim() : '本次局部目標已重新開始；請依提示回到起點。',
        hint: typeof evaluation.hint === 'string' && evaluation.hint.trim() ? evaluation.hint.trim() : null,
        metrics: Object.freeze(finiteMetrics(evaluation.metrics)),
      })
    return {
      ...baseState,
      checkpoints: initialCheckpoints(lesson),
      previousSample: null,
      lastEvaluation: evaluation,
      lastRecovery,
      recoveryInProgress: true,
    }
  }

  const checkpoints = updateCheckpoints(baseState, lesson, evaluation, sample.timestampSeconds)
  const localProgressObserved = evaluation.status !== 'failure'
    && evaluation.checkpointIds?.some((id) => lesson.checkpoints.some((checkpoint) => checkpoint.id === id)) === true
  const checkpointState = {
    ...baseState, checkpoints, lastEvaluation: evaluation,
    recoveryInProgress: localProgressObserved ? false : state.recoveryInProgress,
  }
  if (evaluation.status === 'failure') {
    const terminalState = publishTrajectorySnapshot(checkpointState, trajectoryBuffer, sample.timestampSeconds)
    return {
      ...terminalState,
      phase: 'FAILED',
      result: createResult(terminalState, lesson, 'FAILED', sample.timestampSeconds, evaluation, checkpoints),
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
    const terminalState = publishTrajectorySnapshot(checkpointState, trajectoryBuffer, sample.timestampSeconds)
    return {
      ...terminalState,
      phase: outcome,
      result: createResult(terminalState, lesson, outcome, sample.timestampSeconds, evaluation, checkpoints),
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
    ...(options.attemptContext ? { attemptContext: Object.freeze({ ...options.attemptContext }) } : {}),
    phase: 'READY',
    lessonId: lesson?.id ?? null,
    sessionId: null,
    sessionNumber: 0,
    countdownDurationSeconds,
    countdownStartedAtSeconds: null,
    countdownEndsAtSeconds: null,
    activeStartedAtSeconds: null,
    requiresDisarmBeforeArm: false,
    lastTimestampSeconds: null,
    lastSampleTimestampSeconds: null,
    sampleCount: 0,
    trajectory: EMPTY_TRAJECTORY,
    checkpoints: {},
    lastEvaluation: null,
    lastRecovery: null,
    recoveryInProgress: false,
    result: null,
    setupRequest: null,
    sceneReferences: copySceneReferences(options.sceneReferences ?? []),
    armedAtLeastOnce: false,
    previousSample: null,
    previousFlightSample: null,
    lastError: null,
  }
}

/** Pure reducer for READY -> COUNTDOWN -> WAITING_FOR_ARM -> ACTIVE -> result. */
function reduceTrainingStateInternal(
  state: TrainingMachineState,
  action: TrainingAction,
  lessons: readonly LessonDefinition[],
  trajectoryBuffer?: TrainingTrajectoryBuffer,
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
    case 'SET_SCENE_REFERENCES': {
      // Renderer metadata is a setup contract, not a player mutation. Never
      // replace the evaluator context once an attempt is ACTIVE.
      if (state.phase === 'ACTIVE') return state
      return {
        ...state,
        sceneReferences: copySceneReferences(action.sceneReferences),
        lastError: null,
      }
    }
    case 'START': {
      if (state.phase !== 'READY') return stateError(state, 'A lesson can only start from READY.')
      if (!validTimestamp(action.timestampSeconds)) return stateError(state, 'Training timestamp must be finite and non-negative.')
      if (!state.lessonId) return stateError(state, 'Select an available lesson before starting training.')
      const lesson = byId.get(state.lessonId)
      if (!lesson || !lesson.available || !evaluatorFor(lesson)) {
        return stateError(state, 'This lesson is coming soon; its evaluator is not available yet.')
      }
      return startSession(state, lesson, action.timestampSeconds, action.attemptContext)
    }
    case 'TICK':
      return tick(state, action.timestampSeconds)
    case 'ABORT':
      return abortSession(state, lessons, action.timestampSeconds, action.reason)
    case 'SAMPLE': {
      if (state.phase === 'READY' || state.phase === 'SUCCESS' || state.phase === 'FAILED' || state.phase === 'RESULT') {
        // The runtime observer remains attached outside a lesson session. Idle
        // and terminal samples are ignored, not treated as evaluator errors.
        return state
      }
      if (state.phase === 'COUNTDOWN') {
        if (!validSample(action.sample)) return stateError(state, 'Training sample is invalid or contains non-finite values.')
        // Crossing the countdown boundary changes phase, but the boundary
        // sample is not evaluated. Early arm must be followed by an observed
        // disarm and a fresh arm rather than flowing into a scored attempt.
        const next = tick(state, action.sample.timestampSeconds)
        if (next.lastTimestampSeconds !== action.sample.timestampSeconds) return next
        return action.sample.armed === true
          ? {
            ...next,
            requiresDisarmBeforeArm: true,
            lastError: 'Keep the drone disarmed during countdown; disarm before starting the lesson.',
          }
          : next
      }
      if (!validSample(action.sample)) {
        return state.phase === 'ACTIVE'
          ? abortSession(state, lessons, state.lastTimestampSeconds ?? 0,
            'Attempt stopped: training sample is invalid or contains non-finite values.', trajectoryBuffer)
          : stateError(state, 'Training sample is invalid or contains non-finite values.')
      }
      if (state.phase === 'WAITING_FOR_ARM' && state.lastTimestampSeconds !== null && action.sample.timestampSeconds < state.lastTimestampSeconds) {
        return stateError(state, 'Training sample timestamps must be monotonic.')
      }
      if (!state.lessonId) return stateError(state, 'The active training session has no lesson.')
      const lesson = byId.get(state.lessonId)
      if (!lesson) return stateError(state, 'The active lesson is no longer registered.')
      if (state.phase === 'WAITING_FOR_ARM') return sampleWaitingState(state, lesson, action.sample, trajectoryBuffer)
      if (state.phase !== 'ACTIVE') return stateError(state, 'Samples are scored only while ACTIVE.')
      return sampleActiveState(state, lesson, action.sample, trajectoryBuffer)
    }
    case 'SHOW_RESULT':
      if (state.phase !== 'SUCCESS' && state.phase !== 'FAILED') {
        return stateError(state, 'Results are shown only after SUCCESS or FAILED.')
      }
      return { ...state, phase: 'RESULT', lastError: null }
    case 'RETRY':
      if (!state.lessonId) return stateError(state, 'There is no lesson session to retry.')
      if (state.phase === 'COUNTDOWN' || state.phase === 'WAITING_FOR_ARM' || state.phase === 'ACTIVE') {
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

export function reduceTrainingState(
  state: TrainingMachineState,
  action: TrainingAction,
  lessons: readonly LessonDefinition[] = DEFAULT_LESSONS,
): TrainingMachineState {
  return reduceTrainingStateInternal(state, action, lessons)
}

/** Stateful adapter for UI/runtime integration; all transitions remain pure. */
export class TrainingSession {
  private readonly lessons: readonly LessonDefinition[]
  private readonly trajectoryBuffer = new TrainingTrajectoryBuffer()
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
    const previous = this.state
    const reduced = reduceTrainingStateInternal(previous, action, this.lessons, this.trajectoryBuffer)
    const next = action.type === 'ABORT' && reduced.phase === 'FAILED'
      ? publishTrajectorySnapshot(reduced, this.trajectoryBuffer)
      : reduced
    if (
      (action.type === 'SELECT_LESSON' || action.type === 'START' || action.type === 'RETRY' || action.type === 'RESET')
      && next !== previous
      && next.trajectory.length === 0
    ) {
      this.trajectoryBuffer.clear()
    }
    this.state = next
    return this.state
  }

  public selectLesson(lessonId: string): TrainingMachineState {
    return this.dispatch({ type: 'SELECT_LESSON', lessonId })
  }

  public setSceneReferences(sceneReferences: readonly TrainingSceneReference[]): TrainingMachineState {
    return this.dispatch({ type: 'SET_SCENE_REFERENCES', sceneReferences })
  }

  public start(timestampSeconds: number, attemptContext?: TrainingAttemptContext): TrainingMachineState {
    return this.dispatch({ type: 'START', timestampSeconds, attemptContext })
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

  public abort(reason?: string, timestampSeconds = this.state.lastTimestampSeconds ?? 0): TrainingMachineState {
    return this.dispatch({ type: 'ABORT', timestampSeconds, reason })
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
