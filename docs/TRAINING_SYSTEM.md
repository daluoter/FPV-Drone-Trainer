# Training system

The catalog now includes **Takeoff**, **Hover**, **Coordinated Turn**, **Split-S**,
and **Orbit / 刷鍋**. The original four stable lesson IDs remain unchanged; takeoff
is presented first by priority. Landing, straight-line, box-pattern and
figure-eight lessons remain planned. See [the learning contracts](LEARNING_CONTRACT.md)
for current beginner workflow and [the roadmap](LEARNING_ROADMAP.md) for remaining work.

The evaluator result is based on finite fixed-step drone state and geometry. A
stick sequence cannot pass a lesson. Synthetic fixture success is deterministic
software evidence only; it is not browser pilot, WebGL, transmitter, or
flight-worthiness validation.

## Ownership and data flow

```text
FlightRuntime fixed step
  -> timestamp + DroneState + normalized RC input + armed telemetry
  -> TrainingSession / pure evaluator contract
  -> checkpoints + bounded decimated path snapshots + incremental evaluator metrics
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
READY -> COUNTDOWN -> WAITING_FOR_ARM -> ACTIVE -> SUCCESS/FAILED -> RESULT
```

- `READY` has a selected available lesson but no session or trajectory.
- `COUNTDOWN` records session identity and a disarmed setup request. Runtime and UI
  block arming; countdown samples cannot evaluate the lesson.
- `WAITING_FOR_ARM` begins after countdown with no active clock. It accepts the
  first valid explicitly armed sample as elapsed zero. An early-armed countdown
  sample requires a disarmed sample and fresh explicit arm before activation.
- `ACTIVE` requires strictly increasing finite samples with `armed === true`.
  Disarm, reset, crash, or runtime safety ends the attempt. Countdown and waiting
  do not consume challenge time; pending keyboard/runtime resets clear the session.
- `SUCCESS` and `FAILED` contain a terminal `TrainingResult`; `RESULT` is the
  presentation state after `SHOW_RESULT`.
- `RETRY` and `RESET` clear trajectory, checkpoints, result, and timestamps,
  advance session identity, and clear the field path. A reset/rewind observed
  during ACTIVE fails the current attempt rather than silently continuing it.

The evaluator metrics are carried forward from the preceding evaluation. This
lets dwell timers, route phases, unwrapped orbit angle, direction reversals,
path length, and diagnostics update incrementally without rescanning the full
240 Hz trajectory on every sample. The session keeps the most recent accepted
sample separately for exact previous-sample semantics, while a fixed-capacity
ring retains a decimated path. The public trajectory is an immutable snapshot
published at low frequency (and on terminal transitions), so React/rendering
never receives an ever-growing array or a per-step full-array copy. `sampleCount`
remains the total accepted sample count and is independent of the bounded path
length.

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

`TrainingEvaluationContext` includes a bounded immutable path snapshot for
optional inspection, the total `sampleCount`, and `previousSample` /
`previousEvaluation` for O(1) incremental calculations. `TrainingSample.armed`
is supplied by the runtime integration for Phase 7 evaluators; the machine
waits for the first true arm sample and rejects a later false sample. Legacy
custom tests may omit it, but the shipped four evaluators never pass without
`armed === true`.

## Geometric lessons

### Takeoff

The target is two metres above the `takeoff-pad` reference, which is the spawn
anchor (default world Y=0.5), not the physical pad surface. The prototype evaluator
requires a low, level start, actual liftoff and 1.5 seconds of continuous settled
flight near the target. It rejects crash/disarm, inconsistent position jumps,
telemetry gaps and excessive drift/speed/tilt. Thresholds require human trial
calibration. The amber presentation target matches the reference-relative height.

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
reversals. Each orbit displacement is also checked against the average reported
velocity over its sample interval. A deliberately generous 65 m/s² `dt²`
integration allowance covers accelerated/coarsely sampled flight while a 7.8 m
jump in 0.2 s reporting 7.8 m/s remains inconsistent and fails. Metrics include
radius, altitude, speed, radial rate, tangent/camera heading error, direction,
unwrapped progress, reverse radians, path length, displacement speed, and
velocity-consistency error.

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
physics model is realistic. A local headless Chromium smoke run covered the
Free Flight renderer and context-loss safety path; physical-browser/GPU,
physical transmitter, and human-pilot checks remain separate evidence gates.


## Contextual progress and demonstrations

New attempts snapshot rules/physics versions, full settings identity, preset,
input source, challenge/practice label and assistance state. Contextual progress
uses separate validated envelopes, preserving the original v1 document. Result
and best-score views remain bound to the result context after changing settings;
failed writes are visible and malformed history is not automatically overwritten.

Four-axis and takeoff examples are bounded recordings generated through the real
240 Hz simulator. They play through the existing independent ghost mechanism;
pose, normalized input and captions share its timeline. They never feed training,
never grant progress and remain labeled as simulated pending pilot review.
