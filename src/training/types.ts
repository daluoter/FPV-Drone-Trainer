import type { DroneState } from '../drone'
import type { Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import type { NormalizedRcInput } from '../flight-controller'
import type { StaticBoxCollider } from '../simulation/obstacles'
import type { TrainingAttemptContext } from './attempt'

export const TRAINING_PHASES = [
  'READY',
  'COUNTDOWN',
  'WAITING_FOR_ARM',
  'ACTIVE',
  'SUCCESS',
  'FAILED',
  'RESULT',
] as const

export type TrainingPhase = (typeof TRAINING_PHASES)[number]
export type LessonAvailability = 'available' | 'coming-soon'
export type TrainingEvaluationStatus = 'continue' | 'success' | 'failure'
export type TrainingOutcome = 'SUCCESS' | 'FAILED'

/**
 * The only sample shape a lesson evaluator consumes. `state` is authoritative
 * simulation state; `normalizedInput` is context, never a success signal by
 * itself. Samples are timestamped by simulation time, not React render time.
 */
export interface TrainingSample {
  readonly timestampSeconds: number
  readonly state: DroneState
  readonly normalizedInput: NormalizedRcInput | null
  /** Runtime arm state. Missing legacy telemetry never starts or scores a session. */
  readonly armed?: boolean
  /** Camera calibration at this observation; view-dependent lessons combine it with the real body pose. */
  readonly fpvCamera?: {
    readonly fpvMountAngleDegrees: number
    readonly fpvFovDegrees: number
  }
  /** Configured ground contact telemetry, independent of a lesson's spawn/reference height. */
  readonly groundContact?: {
    readonly heightM: number
    readonly supportOffsetM: number
    readonly touching: boolean
  }
}

export interface TrainingCheckpointDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
}

export interface TrainingCheckpointState {
  readonly id: string
  readonly completed: boolean
  readonly completedAtSeconds: number | null
  readonly metrics: Readonly<Record<string, number>>
}

/** Pure, renderer-independent anchor data supplied to future evaluators. */
export interface TrainingSceneReference {
  readonly id: string
  readonly kind: string
  readonly positionM: Vector3
  readonly sizeM?: Vector3
}

/**
 * A setup is a request for the runtime integration layer. The training domain
 * never applies it to physics; callers must disarm and reset before honoring
 * this request.
 */
export interface LessonSetup {
  readonly requiresDisarmed: true
  readonly resetSimulation: true
  readonly sceneReferenceIds: readonly string[]
  readonly spawnPositionM?: Vector3
  readonly spawnOrientation?: Quaternion
  /** Physical geometry installed only at the explicit disarmed setup boundary. */
  readonly staticObstacles?: readonly StaticBoxCollider[]
}

export interface LessonOutcomeDefinition {
  readonly title: string
  readonly description: string
  readonly criteria: readonly string[]
}

export interface LessonScoringDefinition {
  /** Scores are normalized to this bound for persistence and UI display. */
  readonly maxScore: number
  readonly minimumPassingScore: number
  /** Evaluators cannot finish before this active duration has elapsed. */
  readonly minimumActiveSeconds: number
  readonly metricLabels: readonly string[]
}

export interface TrainingEvaluationContext {
  /** Omitted contexts retain the original timed challenge rules. */
  readonly mode?: 'practice' | 'challenge'
  readonly lesson: LessonDefinition
  readonly elapsedSeconds: number
  /** Total accepted fixed-step samples; independent of the bounded path length. */
  readonly sampleCount?: number
  /** Bounded decimated immutable path snapshot, not the full 240 Hz history. */
  readonly trajectory: readonly TrainingSample[]
  readonly checkpoints: Readonly<Record<string, TrainingCheckpointState>>
  readonly sceneReferences: readonly TrainingSceneReference[]
  /** O(1) incremental seam for evaluators; avoids rescanning the full 240 Hz trajectory. */
  readonly previousSample?: TrainingSample | null
  /** Continuous actual flight sample, retained across local practice restarts for integrity guards. */
  readonly previousFlightSample?: TrainingSample | null
  readonly previousEvaluation?: TrainingEvaluation | null
}

export interface TrainingEvaluation {
  readonly status: TrainingEvaluationStatus
  /** A continuing practice evaluation may restart local goals without resetting live flight. */
  readonly recovery?: 'restart'
  readonly checkpointIds?: readonly string[]
  readonly score?: number
  readonly metrics?: Readonly<Record<string, number>>
  readonly message?: string
  readonly hint?: string
}

/**
 * Phase 7 evaluators may be functions or objects so they can remain pure and
 * independently testable. They must not mutate simulation or scene objects.
 */
export type LessonEvaluatorFunction = (
  sample: TrainingSample,
  context: TrainingEvaluationContext,
) => TrainingEvaluation

export interface LessonEvaluatorContract {
  evaluate: LessonEvaluatorFunction
}

export type LessonEvaluator = LessonEvaluatorFunction | LessonEvaluatorContract

export interface LessonDefinition {
  readonly id: string
  readonly priority: number
  readonly title: string
  readonly description: string
  readonly availability: LessonAvailability
  readonly available: boolean
  readonly objectives: readonly string[]
  readonly setup: LessonSetup
  readonly checkpoints: readonly TrainingCheckpointDefinition[]
  readonly success: LessonOutcomeDefinition
  readonly failure: LessonOutcomeDefinition
  readonly scoring: LessonScoringDefinition
  readonly hints: readonly string[]
  readonly evaluator: LessonEvaluator | null
}

export interface TrainingResult {
  readonly attemptContext?: TrainingAttemptContext
  readonly lessonId: string
  readonly sessionId: string
  readonly outcome: TrainingOutcome
  readonly score: number
  readonly elapsedSeconds: number
  readonly sampleCount: number
  readonly completedCheckpoints: number
  readonly totalCheckpoints: number
  readonly startedAtSeconds: number
  readonly completedAtSeconds: number
  readonly metrics: Readonly<Record<string, number>>
  readonly message: string
  readonly hint: string | null
}

export interface TrainingSetupRequest {
  readonly lessonId: string
  readonly sessionId: string
  readonly setup: LessonSetup
}

/** First observed cause of one local practice restart, retained for review. */
export interface TrainingRecoverySnapshot {
  readonly timestampSeconds: number
  readonly message: string
  readonly hint: string | null
  readonly metrics: Readonly<Record<string, number>>
}

export interface TrainingMachineState {
  readonly attemptContext?: TrainingAttemptContext
  readonly phase: TrainingPhase
  readonly lessonId: string | null
  readonly sessionId: string | null
  readonly sessionNumber: number
  readonly countdownDurationSeconds: number
  readonly countdownStartedAtSeconds: number | null
  readonly countdownEndsAtSeconds: number | null
  readonly activeStartedAtSeconds: number | null
  /** Early arm telemetry requires an observed disarm before a fresh arm can start this attempt. */
  readonly requiresDisarmBeforeArm?: boolean
  readonly lastTimestampSeconds: number | null
  readonly lastSampleTimestampSeconds: number | null
  /** True once the pilot has supplied an armed fixed-step sample in this attempt. */
  readonly armedAtLeastOnce?: boolean
  readonly sampleCount: number
  /** Most recent accepted sample; kept separately because trajectory is decimated. */
  readonly previousSample?: TrainingSample | null
  /** Last actual armed sample; local practice restarts do not clear this safety boundary. */
  readonly previousFlightSample?: TrainingSample | null
  /** Bounded immutable UI/evaluator path snapshot. */
  readonly trajectory: readonly TrainingSample[]
  readonly checkpoints: Readonly<Record<string, TrainingCheckpointState>>
  readonly lastEvaluation: TrainingEvaluation | null
  /** Original restart cause; later return-to-start reminders do not replace it. */
  readonly lastRecovery?: TrainingRecoverySnapshot | null
  /** A new cause can be captured after a defined local checkpoint is observed again. */
  readonly recoveryInProgress?: boolean
  readonly result: TrainingResult | null
  readonly setupRequest: TrainingSetupRequest | null
  readonly sceneReferences: readonly TrainingSceneReference[]
  readonly lastError: string | null
}

export type TrainingAction =
  | { readonly type: 'SELECT_LESSON'; readonly lessonId: string }
  | { readonly type: 'SET_SCENE_REFERENCES'; readonly sceneReferences: readonly TrainingSceneReference[] }
  | { readonly type: 'START'; readonly timestampSeconds: number; readonly attemptContext?: TrainingAttemptContext }
  | { readonly type: 'TICK'; readonly timestampSeconds: number }
  | { readonly type: 'SAMPLE'; readonly sample: TrainingSample }
  | { readonly type: 'ABORT'; readonly timestampSeconds: number; readonly reason?: string }
  | { readonly type: 'SHOW_RESULT' }
  | { readonly type: 'RETRY' }
  | { readonly type: 'RESET' }

export interface TrainingMachineOptions {
  readonly attemptContext?: TrainingAttemptContext
  readonly countdownDurationSeconds?: number
  readonly initialLessonId?: string | null
  readonly sceneReferences?: readonly TrainingSceneReference[]
}

export interface TrainingSessionOptions extends TrainingMachineOptions {
  readonly lessons?: readonly LessonDefinition[]
}

export interface TrainingStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface TrainingAttemptMetric {
  readonly sessionId: string
  readonly outcome: TrainingOutcome
  readonly score: number
  readonly elapsedSeconds: number
  readonly sampleCount: number
  readonly completedCheckpoints: number
  readonly totalCheckpoints: number
  readonly completedAt: string
  readonly metrics: Readonly<Record<string, number>>
}

export interface LessonProgress {
  readonly recent: TrainingAttemptMetric | null
  readonly best: TrainingAttemptMetric | null
  readonly completed: boolean
  readonly attempts: number
}

export interface TrainingProgressDocument {
  readonly schemaVersion: 1
  readonly lessons: Readonly<Record<string, LessonProgress>>
}

export interface TrainingProgressLoadResult {
  readonly progress: TrainingProgressDocument
  readonly loaded: boolean
  readonly errors: readonly string[]
}

export interface TrainingProgressPersistenceResult {
  readonly saved: boolean
  readonly progress: TrainingProgressDocument
  readonly errors: readonly string[]
}
