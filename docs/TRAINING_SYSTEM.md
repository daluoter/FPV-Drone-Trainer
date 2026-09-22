# Training system (Phase 6)

Phase 6 provides the lesson framework and runtime seam. It does **not** claim
that a maneuver is learned: all four menu lessons remain unavailable until the
Phase 7 geometric evaluators are implemented.

## Ownership and data flow

```text
FlightRuntime fixed step
  -> timestamp + DroneState + normalized RC input
  -> TrainingSession / pure evaluator contract
  -> state machine + immutable trajectory
  -> results/progress store
  -> React menu, result card, and Mode 2 presentation
```

`FlightRuntime` owns the only requestAnimationFrame loop. Its optional
`onFixedStep` listener runs once after each completed fixed simulation step;
it is not a second simulation loop. The callback is observational. Training
never rotates the Three.js drone, writes a motor command, or changes physics.
A lesson setup is a request with `requiresDisarmed: true` and
`resetSimulation: true`; an integration caller must honor it through the
runtime's explicit disarmed `reset()` boundary.

## State machine

`TrainingSession` is a small stateful adapter over the pure
`reduceTrainingState` reducer. Its explicit phases are:

```text
READY -> COUNTDOWN -> ACTIVE -> SUCCESS/FAILED -> RESULT
```

- `READY` has a selected lesson but no session or trajectory.
- `COUNTDOWN` records the session identity and setup request. Samples crossing
  this boundary are not evaluated.
- `ACTIVE` accepts strictly increasing simulation timestamps and stores samples.
  A non-finite, backwards, or duplicate sample is rejected without appending.
- `SUCCESS` and `FAILED` contain a terminal `TrainingResult`.
- `RESULT` is the presentation state after `SHOW_RESULT`.
- `RETRY` and `RESET` clear trajectory, checkpoints, result, and timestamps.
  They advance the session sequence so an old result cannot be attributed to a
  new attempt.

A lesson cannot start unless it is registered, marked available, and has an
evaluator. Elapsed time, controller stick values, and UI actions never create
a result on their own.

## Lesson and evaluator API for Phase 7

A data-driven `LessonDefinition` contains:

- `id`, `priority`, `title`, `description`, and `objectives`;
- disarmed `setup` and stable `sceneReferenceIds`;
- ordered `checkpoints`;
- declarative `success` and `failure` descriptions;
- `scoring` (`maxScore`, minimum pass score, minimum active duration, and
  metric labels);
- `hints`; and
- `evaluator`, currently `null` for the four Phase 6 catalog entries.

An evaluator is either a function or an object with `evaluate`:

```ts
interface LessonEvaluatorContract {
  evaluate(
    sample: TrainingSample,
    context: TrainingEvaluationContext,
  ): TrainingEvaluation
}

interface TrainingSample {
  timestampSeconds: number
  state: DroneState
  normalizedInput: NormalizedRcInput | null
}

interface TrainingEvaluationContext {
  lesson: LessonDefinition
  elapsedSeconds: number
  trajectory: readonly TrainingSample[]
  checkpoints: Readonly<Record<string, TrainingCheckpointState>>
  sceneReferences: readonly TrainingSceneReference[]
}

interface TrainingSceneReference {
  id: string
  kind: string
  positionM: Vector3
  sizeM?: Vector3
}

type TrainingEvaluation = {
  status: 'continue' | 'success' | 'failure'
  checkpointIds?: readonly string[]
  score?: number
  metrics?: Readonly<Record<string, number>>
  message?: string
  hint?: string
}
```

The evaluator must be pure with respect to the simulation and scene. It may
inspect the current state and the prior trajectory, then report checkpoint IDs,
finite meaningful metrics, score, and an outcome. It must not pass from a
stick sequence alone. The machine enforces timestamp order, minimum active
duration, score bounds, and configured minimum pass score; an evaluator
exception becomes a safe failed attempt rather than a fake pass.

The next phase should implement positive and negative traces for:

1. `stable-hover` — altitude, attitude, and horizontal-drift windows;
2. `straight-line` — gate corridor, heading, and speed windows;
3. `box-pattern` — marker order, corner geometry, and altitude windows;
4. `figure-eight` — both loops, center crossing, and exit alignment.

Each evaluator should use the stable scene IDs `takeoff-pad`, `marker-0` …
`marker-3`, and `gate` exposed by `FlightScene.sceneReferences`. A reference
contains its stable `id`, `kind`, object, and immutable world-space `positionM`.
The object is for presentation; geometric checks should use the reference
position contract or a copied snapshot, not mutate Three.js objects.

## Progress persistence

`TrainingProgressStore` writes schema version `1` to
`fpv-drone-trainer.training-progress.v1`. Each lesson has `recent`, `best`,
`completed`, and `attempts`. Attempts retain score, elapsed seconds, sample
count, completed/total checkpoints, completion timestamp, and evaluator
metrics. JSON, schema, timestamps, finite numeric ranges, and checkpoint
relationships are validated before use; malformed data falls back to empty
progress and never reaches the runtime.

## Presentation

`Mode2StickOverlay` is reusable and presentation-only. In live mode it consumes
throttled normalized runtime input; in demonstration mode it shows a fixed
example. Mode 2 is explicit: left stick is throttle + yaw, right stick is
pitch + roll. It does not arm, reset, evaluate, or mutate the simulator.

## Known Phase 6 gaps

- The four evaluator slots and geometric positive/negative trace fixtures are
  intentionally deferred to Phase 7.
- Scene references currently provide stable IDs and anchor positions; richer
  gate dimensions/corridors belong with the evaluator owner.
- Browser WebGL, transmitter, and aerodynamic realism evidence remain separate
  from deterministic framework tests.
