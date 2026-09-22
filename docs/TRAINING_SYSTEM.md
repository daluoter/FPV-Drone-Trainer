# Training system (Phase 7)

Phase 7 enables exactly four state/trajectory lessons: **Hover**, **Coordinated
Turn**, **Split-S**, and **Orbit / 刷鍋**. Straight-line, box-pattern, and
figure-eight replacements are not part of this catalog.

The evaluator result is based on finite fixed-step drone state and geometry. A
stick sequence cannot pass a lesson. Synthetic fixture success is deterministic
software evidence only; it is not browser pilot, WebGL, transmitter, or
flight-worthiness validation.

## Ownership and data flow

```text
FlightRuntime fixed step
  -> timestamp + DroneState + normalized RC input + armed telemetry
  -> TrainingSession / pure evaluator contract
  -> checkpoints + immutable trajectory + incremental evaluator metrics
  -> results/progress store
  -> React menu, live metrics, result card, and field path
```

`FlightRuntime` owns the only requestAnimationFrame loop. Its optional
`onFixedStep` listener runs once after each completed fixed simulation step; it
is observational. Training never rotates the Three.js drone, writes a motor
command, or changes physics. A lesson setup is a request with
`requiresDisarmed: true` and `resetSimulation: true`; `FreeFlight` honors it
through `FlightRuntime.resetForTraining` during COUNTDOWN. ACTIVE evaluator
callbacks cannot teleport or reset the player.

The runtime fixed-step sample carries explicit `armed` telemetry into the
training sample. Disarm, invalid telemetry, runtime reset/rewind, focus loss,
or a disconnected controller cannot create a pass. An active attempt records a
clear failure on disarm/reset and offers retry; the runtime itself still
requires an explicit re-arm after focus or safety transitions.

## State machine and flow

`TrainingSession` is a small stateful adapter over the pure
`reduceTrainingState` reducer:

```text
READY -> COUNTDOWN -> ACTIVE -> SUCCESS/FAILED -> RESULT
```

- `READY` has a selected available lesson but no session or trajectory.
- `COUNTDOWN` records the session identity and disarmed setup request. Samples
  crossing this boundary are not evaluated. The UI tells the pilot to arm in
  Free Flight during the countdown or before ACTIVE.
- `ACTIVE` accepts strictly increasing simulation timestamps and finite state.
  It waits visibly for the first armed sample if the pilot has not armed by the
  countdown boundary; disarm after an armed sample stops the attempt. Evaluators
  receive the current sample, scene references, checkpoints, and O(1)
  `previousSample` / `previousEvaluation` seams.
- `SUCCESS` and `FAILED` contain a terminal `TrainingResult`; `RESULT` is the
  presentation state after `SHOW_RESULT`.
- `RETRY` and `RESET` clear trajectory, checkpoints, result, and timestamps,
  advance session identity, and clear the field path. A reset/rewind observed
  during ACTIVE fails the current attempt rather than silently continuing it.

The evaluator metrics are carried forward from the preceding evaluation. This
lets dwell timers, route phases, unwrapped orbit angle, direction reversals,
path length, and diagnostics update incrementally without rescanning the full
240 Hz trajectory on every sample. Trajectory data remains immutable for
results and diagnostics; the rendered path is bounded to a practical number of
points.

## Lesson and evaluator API

A data-driven `LessonDefinition` contains IDs, objectives, disarmed setup,
stable scene references, ordered checkpoints, success/failure copy, scoring,
hints, and an evaluator. The evaluator contract remains pure with respect to
physics and scene:

```ts
interface LessonEvaluatorContract {
  evaluate(
    sample: TrainingSample,
    context: TrainingEvaluationContext,
  ): TrainingEvaluation
}
```

`TrainingEvaluationContext` includes the current immutable trajectory for
inspection plus `previousSample` and `previousEvaluation` for bounded
incremental calculations. `TrainingSample.armed` is supplied by the runtime
integration for Phase 7 evaluators; the machine waits for the first true arm
sample and rejects a later false sample. Legacy custom tests may omit it, but
the shipped four evaluators never pass without `armed === true`.

## Geometric lessons

### Hover

The hover target is the elevated `hover-zone` reference above the takeoff pad.
The evaluator requires a contiguous in-zone dwell (horizontal radius and
altitude tolerance), bounded horizontal/vertical velocity, and realistic tilt
limits. It records altitude error, horizontal drift, speed, tilt, contiguous
dwell, and stick smoothness diagnostics. Leaving the zone resets the contiguous
dwell; elapsed time or input movement alone cannot pass it.

### Coordinated Turn

The route is ordered `turn-entry -> turn-apex -> turn-exit`. Position and
altitude gates use the copied semantic references and a route corridor. The
apex and exit require a measured heading change from actual trajectory motion
and aligned route legs; an exact roll/yaw stick sequence is never checked.
Position jumps, timestamp gaps, out-of-order gates, and corridor/energy
excursions fail the attempt. Metrics include gate errors, corridor error,
heading change/alignment, and speed.

### Split-S

The setup requests an explicit disarmed reset at `{ x: 0, y: 25, z: 0 }` with
identity orientation. The evaluator orders `entry -> inverted -> descent ->
reversed -> recovered`. It requires sufficient entry altitude and speed, an
upright-to-inverted attitude transition, descending motion while inverted, an
actual heading reversal, then upright recovery with bounded altitude, speed,
and position. The inverted checkpoint must precede reversal, so an upright
U-turn is not a pass.

### Orbit / 刷鍋

The orbit point of interest is the `orbit-poi` tower. The evaluator requires
real horizontal motion in the radius/height/speed envelope and tangent camera
heading. It unwraps directed POI angle incrementally and requires a full
`2π` geometric lap followed by a valid exit sample. It rejects yaw-in-place,
teleport/path gaps, sustained invalid envelope, and oscillatory direction
reversals. Metrics include radius, altitude, speed, radial rate, tangent/camera
heading error, direction, unwrapped progress, reverse radians, path length, and
reversal count.

## Scene references and visualization

`FlightScene.sceneReferences` exposes immutable renderer-independent snapshots
for `takeoff-pad`, `hover-zone`, ordered turn markers, `split-s-reference`, and
`orbit-poi`. The renderer presents the hover target, turn gate/poles, Split-S
gate, orbit tower/circle, and a bounded training path trace. These objects are
presentation-only; evaluators use copied positions/dimensions and never mutate
Three.js objects.

## Progress persistence and result feedback

`TrainingProgressStore` writes schema version `1` to
`fpv-drone-trainer.training-progress.v1`. Attempts retain score, elapsed time,
sample count, checkpoint counts, completion time, and finite evaluator metrics.
Malformed JSON, schema, timestamps, or numeric values fall back to empty
progress. Only current lesson IDs are merged; legacy placeholder IDs are not
relabelled as completions. The Phase 7 panel exposes live metrics, checkpoint
progress, failure hints, retry/reset controls, and persisted recent/best
attempt status.

## Evidence boundaries

Automated evaluator fixtures cover positive and negative traces for all four
lessons, retry isolation, disarmed telemetry, upright Split-S U-turns,
yaw-in-place/oscillatory orbit behavior, and path gaps/teleports. They do not
prove that a human can pilot the maneuver in a browser or that the simplified
physics model is realistic. Browser WebGL and physical transmitter checks
remain separate evidence gates. On the current verification host, Chromium
smoke testing is blocked unless the missing `libnspr4.so` dependency is
resolved without unrelated system changes.
