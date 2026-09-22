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

### Phase 7 lesson handoff

The Phase 6 catalog contains exactly these unavailable evaluator slots:

| ID | Title | Setup references | Checkpoints |
| --- | --- | --- | --- |
| `hover` | Hover | `takeoff-pad`, `hover-zone` | `enter-hover-zone`, `hold-hover`, `settle-hover` |
| `coordinated-turn` | Coordinated Turn | `takeoff-pad`, `turn-entry`, `turn-apex`, `turn-exit` | `turn-entry`, `turn-apex`, `turn-exit` |
| `split-s` | Split-S | `split-s-reference` | `entry`, `inverted`, `descent`, `reversed`, `recovered` |
| `orbit` | Orbit / 刷鍋 | `takeoff-pad`, `orbit-poi` | `orbit-entry`, `orbit-lap`, `orbit-exit` |

All four entries remain `available: false` with `evaluator: null`. The Split-S
setup requests a disarmed reset at `{ x: 0, y: 25, z: 0 }` with an explicit
identity spawn orientation so the evaluator can start from sufficient altitude.
The other lessons use the ground takeoff spawn. These are setup requests only;
the application honors them through `FlightRuntime.resetForTraining` during
COUNTDOWN and never mutates the player from an ACTIVE evaluator callback.

`FlightScene.sceneReferences` exposes immutable, renderer-independent handoff
snapshots for the IDs above: `takeoff-pad` at the configured spawn, `hover-zone`
three metres above the pad, ordered `turn-entry`/`turn-apex`/`turn-exit`
markers, the `split-s-reference` gate at `{ x: 0, y: 0.9, z: -5 }` with size
`{ x: 5.12, y: 1.8, z: 0.12 }`, and the `orbit-poi` tower at its copied anchor.
The reference object is presentation-only; geometric checks must use copied
positions/dimensions and must not mutate Three.js objects. Thresholds and
positive/negative traces belong to the Phase 7 evaluator owner.

Each evaluator should use those semantic stable IDs rather than generic marker
names. The Phase 7 owner must cover both successful and false-positive traces
for altitude, attitude, route/corridor, heading, radial and speed limits as
appropriate to the lesson.

## Progress persistence

`TrainingProgressStore` writes schema version `1` to
`fpv-drone-trainer.training-progress.v1`. Each lesson has `recent`, `best`,
`completed`, and `attempts`. Attempts retain score, elapsed seconds, sample
count, completed/total checkpoints, completion timestamp, and evaluator
metrics. JSON, schema, timestamps, finite numeric ranges, and checkpoint
relationships are validated before use; malformed data falls back to empty
progress and never reaches the runtime. The schema version is retained for
this catalog correction, but load merges only current lesson IDs. Legacy
placeholder keys such as `stable-hover`, `straight-line`, `box-pattern`, and
`figure-eight` are ignored rather than relabeled as completions for the new
curriculum; no shipped Phase 6 evaluator can create an actual completion.

## Presentation

`Mode2StickOverlay` is reusable and presentation-only. In live mode it consumes
throttled normalized runtime input; in demonstration mode it shows a fixed
example. Mode 2 is explicit: left stick is throttle + yaw, right stick is
pitch + roll. It does not arm, reset, evaluate, or mutate the simulator.

## Known Phase 6 gaps

- The four evaluator slots and geometric positive/negative trace fixtures are
  intentionally deferred to Phase 7.
- Scene references provide stable semantic IDs, copied anchor positions and
  dimensions; richer corridors and thresholds belong with the evaluator owner.
- Browser WebGL, transmitter, and aerodynamic realism evidence remain separate
  from deterministic framework tests.
