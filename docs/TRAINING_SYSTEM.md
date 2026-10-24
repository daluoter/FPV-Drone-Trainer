# Training system

Release **2026.10.24.1** presents beginner lessons **L01–L09**: combined
takeoff/stationary hover, straight-line rings, landing, direction control,
coordinated turns, square route, figure eight, wide gates and basic recovery.
L00 knowledge completion is separate; retained Split-S and Orbit are L12/L13.
The learning menu has 11 flight lessons. `LEARNING_LESSONS` excludes the retired
standalone `hover` entry, while the registry and evaluator remain available for
historical compatibility. The `takeoff` ID retains its existing 1.5-second
settled-hover condition, so the merge changes teaching labels and navigation
without changing criteria or rule scopes. Saved `hover` selection opens L01;
old Hover records are kept and are not credited as new L01 results.

The user accepted basic recovery in `2026.10.23.6` / `b30806e`, under its old
number L10. It is now L09 and retains rules 6. Earlier approvals carry forward
with the stable lesson IDs. Exact local build, browser and hardware details
were not supplied. See [the numbering table](LEARNING_CONTRACT.md#課程編號與合併相容性)
and [the roadmap](LEARNING_ROADMAP.md). The next planned course is L10 Roll;
it is not implemented in this merge.

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
callbacks cannot teleport or reset the player. L08 setup additionally supplies
the shared static gate boxes. The runtime validates and copies them while
disarmed; the simulation, rather than the evaluator or renderer, owns contact
and crash decisions. Free Flight and other lessons clear the static field.

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
custom tests may omit it, but shipped evaluators never pass without
`armed === true`.

## Geometric lessons

### L01 Takeoff and stationary hover

The target is two metres above the `takeoff-pad` reference, which is the spawn
anchor (default world Y=0.5), not the physical pad surface. The prototype evaluator
requires a low, level start, actual liftoff and 1.5 seconds of continuous settled
flight near the target. It rejects crash/disarm, inconsistent position jumps,
telemetry gaps and excessive drift/speed/tilt. Thresholds require human trial
calibration. The amber presentation target matches the reference-relative height.

### Historical standalone Hover

The retired `hover` definition remains for historical evaluator/data compatibility;
it is not a separate choice in the learning menu. Its target is the elevated
`hover-zone` reference above the takeoff pad.
The evaluator requires a contiguous in-zone dwell (horizontal radius and
altitude tolerance), bounded horizontal/vertical velocity, and realistic tilt
limits. It records altitude error, horizontal drift, speed, tilt, contiguous
dwell, and stick smoothness diagnostics. Leaving the zone resets the contiguous
dwell; elapsed time or input movement alone cannot pass it.

### Coordinated Turn

L05 starts on the supported ground, then orders right entry/apex/exit followed
by left entry/apex/exit. Continuous segments can enter the 1.8 m target spheres
with a further 0.1 m edge tolerance. Heading has a 70° allowance, and each exit
needs at least 25° of measured trajectory-direction change in the requested
direction. An exact roll/yaw stick sequence or yaw in place cannot replace
motion. Missed targets and non-crash ground returns retain checkpoints; there
is no extra speed, dwell or corridor-reset requirement. Practice is untimed;
challenge allows 180 seconds. See [the L05 guide](L05_COORDINATED_TURN.md).

### Wide gates

L08 (`wide-gate`, rules 5) has five checkpoints: actual launch-ground contact,
manual liftoff, then ordered forward crossings of `wide-gate-1`, `wide-gate-2`
and `wide-gate-3`. The shared layout places 4 × 4 m clear openings 8 / 16 / 24 m
ahead of launch, centered at configured ground + 3 m. A crossing is the actual
continuous movement segment's intersection with the current gate plane inside
the opening, traveling toward negative scene Z. Reaching the far side by going
around, flying backward through the gate or sliding along the ground cannot
substitute for passage. The physics solver first checks the conservative
full-drone swept envelope against all four solid frame members; the evaluator
then observes the resolved sample and never invents collision from a COM-only
test.

There is no added speed, heading, dwell or landing target. Missing a gate or
returning to the ground without crashing retains completed checkpoints; the
learner can return in front of the current gate or take off again locally.
Frame contact latches a physical crash with its gate/member ID and ends the
attempt. Crash, disarm, focus loss, reset and invalid/discontinuous samples
remain terminal. Practice has no timeout; challenge allows 240 seconds. All
three frames remain visible and physical after passing; only the current
guidance overlay advances. See [the L08 guide](L08_WIDE_GATE.md).

### Basic recovery

L09 (`basic-recovery`, rules 6) keeps eight ordered checkpoints: launch ground,
manual takeoff to at least 3 m, tilt onset / recovery, descent onset / recovery,
and drift onset / braking. Recommended height is now 4 m. The learner deliberately
creates each deviation from a visible prompt; actual quaternion attitude and
velocity determine onset and recovery, without live automatic disturbance or leveling.

Preparation lasts 0.1 s within a 40 m horizontal radius and at least 3 m above
ground, with body rate at most 90°/s. Its other conditions depend on the exercise:

| Exercise | Preparation | Observed onset | Recovery for 0.25 consecutive seconds |
| --- | --- | --- | --- |
| Tilt | Tilt ≤12°, vertical speed within ±1.5 m/s; horizontal drift allowed | Tilt ≥15° | Tilt ≤12° and body rate ≤90°/s |
| Descent | Tilt ≤25°, horizontal speed ≤3 m/s, vertical velocity −0.2 to +1.5 m/s | Vertical velocity ≤−0.5 m/s while at least 2.5 m high | Vertical velocity −0.2 to +2 m/s, tilt ≤25° and body rate ≤90°/s |
| Drift | Tilt ≤20°, horizontal speed ≤0.8 m/s, vertical speed within ±1.5 m/s | Horizontal speed ≥1.2 m/s | Horizontal speed ≤1.0 m/s, vertical speed within ±2 m/s, tilt ≤20° and body rate ≤90°/s |

Readiness must be latched from a preceding sample. Preparation and onset retain
separate ranges, so a continuing sink or drift cannot prepare and trigger itself.
All recoveries remain airborne, at least 1 m above ground, inside the practice area.
Landing cannot substitute for stopping descent or drift, and a short flash does
not replace the 0.25 s confirmation. Contact or insufficient height invalidates
the current onset and dwell; after climbing and preparing again the learner must
reproduce that deviation. Earlier completed exercise pairs remain. Leaving the
area resets preparation / dwell while retaining an already valid onset; return
allows recovery to continue. Terminal retry clears the attempt's checkpoints.
Crash, disarm, focus loss, reset and invalid/discontinuous samples stay terminal.
Practice is untimed; challenge allows 300 s.

The wider ranges reduce all-axis hover demands, especially between steps 4 and 5.
The user has accepted this recovery functionality; the ranges remain prototype
thresholds pending broader learner and pilot calibration. No fixed
XYZ return, heading target or long hover dwell is imposed. The motion HUD reads
live state or the paused ghost as appropriate. See [the L09 guide](L09_BASIC_RECOVERY.md).

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
for the launch, landing area, beginner-route targets and retained advanced
references. L08 appends `wide-gate-1` through `wide-gate-3`, with opening size
`{ x: 4, y: 4, z: 0.35 }`, without reordering earlier IDs. Evaluators use copied
positions/dimensions and never mutate Three.js objects. L08's frame meshes use
the exact shared collider boxes; the opening outline and arrow are guidance
only. `setWideGateTarget(id | null)` toggles those overlays without removing
passed physical frames. Other lesson targets, the Split-S reference and orbit
tower remain visual guides without static collision. L09 appends `recovery-zone`
at launch X/Z and ground + 4 m, with a 40 m horizontal practice radius. The
`basic-recovery-field` is a visual practice boundary and height guide; it does
not add collision or move the drone. Stage changes preserve the scene and canvas.

## Progress persistence and result feedback

The retained legacy `TrainingProgressStore` format writes schema version `1` to
`fpv-drone-trainer.training-progress.v1`. Attempts retain score, elapsed time,
sample count, checkpoint counts, completion time, and finite evaluator metrics.
Malformed JSON, schema, timestamps, or numeric values fall back to empty
progress. Only current lesson IDs are merged; legacy placeholder IDs are not
relabelled as completions. The Phase 7 panel exposes live metrics, checkpoint
progress, failure hints, retry/reset controls, and persisted recent/best
attempt status. Current UI attempts use the separate contextual format below;
the original document is preserved rather than relabelled as new completion.

## Evidence boundaries

The original automated evaluator fixtures cover positive and negative traces for all four
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
Current L09 attempts use rules 6; L05–L08 stay on rules 5 and earlier scopes
remain unchanged, including rules 4 for L02–L04. The prior L09 rules-5 document
remains readable as historical data and is not overwritten or relabeled as a
rules-6 completion. Current progress loads the per-lesson rule scope. Physics
context stays version 1; settings, input source and practice/challenge remain
separate comparison conditions.

The 12 existing demo kinds cover three L00 axis examples and L01–L09.
Their bounded recordings are generated through the real 240 Hz simulator and
play through the independent ghost. The L01 demonstration explicitly teaches both takeoff and continuous hover.
This release does not add Split-S or Orbit demonstration videos.

`createDemonstrationProgress` observes each retained course recording once with
its own checkpoint/evaluator state, outside the live session and progress store.
It creates a bounded immutable timeline; playback reads the current/completed/
pending snapshot for its clock. L00 has authored teaching-action chapters rather
than flight mastery checkpoints. Clicking a chapter pauses at its retained start;
seeking backward restores the earlier demo checkmarks. The demo panel replaces
live objective/checkpoint/result presentation while viewing, then restores the
unchanged learner view on exit. No demo progress is saved as learner completion.

Pose, recorded sticks, captions, scene stage and independent progress share the
same playback clock. L09 starts at 0.5×, with 2 s to read preparation and 0.75 s
to observe a real onset before its recorded correction. The L08 demo uses the
same physical frame field as live practice. All remain labeled as simulated
pending pilot review; their generated controls never override live practice.

## Historical beginner-school batch two (rules 2)

The UI now defaults to `practice`, with explicit `challenge` selection. Practice
skips challenge timeouts; an evaluator may return `recovery: restart` to clear
local objectives/dwell without resetting the actual pose, global attempt clock,
trajectory or continuous previous-flight sample. Crash, disarm/focus loss,
invalid data and discontinuous physics remain terminal safety conditions.

New attempts use rules version 2. Version 1 contextual documents and the original
legacy document remain separately readable. Each accepted active sample needs a
strictly increasing physical step and matching simulation/sample time deltas;
relabelled frozen physics cannot accrue dwell. Hover now needs a full 3.2 seconds
of consecutive settled position, altitude, speed and tilt.

L03 Landing uses authoritative configured-ground contact metadata (ground height,
raw orientation-dependent support offset and touching flag). It checks airborne
approach, every actual contact transition's pre-impact speed, the specified pad,
and a full grounded stable dwell. A small bounce resets dwell and rechecks speed.
L04 Straight Line requires ordered start/transit, observed deceleration inside
the brake zone, and a continuous settled stop on an eight-metre route.

The scene's pad anchor matches the geometry-clamped initial state. References
shift with configured ground; Split-S altitude gates use height above ground.
Airborne lesson setup resolves from these same anchors. A disarmed preparation
hold advances the authoritative fixed-step clock without falling from the lesson
spawn; successful explicit arm releases it. Ordinary disarmed free flight still
integrates gravity. Reset, reconfigure and playback boundaries clear the hold.

Independent simulation-generated takeoff, landing and straight-line demos carry
schema/lesson/kind, rules/physics version, exact settings identity and preset, with
bounded immutable recordings and frozen time cues. They are presentation-only
and remain pending human pilot review. L00 knowledge completion and last-lesson
preferences use a separate validated storage document; answering a quiz or
watching a demonstration never writes a flight result. Result coaching states
final observations, one measured gap and one next action without inferring a
cause, independent mastery or hardware skill.


## Historical learner-feedback revision and result review (rules 3)

Following manual feedback, display order is now L01 Takeoff, L02 Hover, L03
Straight Line, L04 Landing, while stable lesson IDs stay unchanged. Rules version
3 starts both revised lessons on the actual supported ground. Straight requires
manual takeoff then ordered travel, measured deceleration inside 5–8 m and a settled
stop. Landing requires manual takeoff and travel to a separately marked zone 8 m
forward. Low-altitude teaching geometry is configured-ground-relative rather
than inherited from an arbitrary elevated free-flight spawn. Ground-contact
telemetry now uses the same slop as the physical solver.

Result review captures an immutable, session-bound recording once at the terminal
UI boundary. `resultReplay.ts` trims it to the attempt window, projects checkpoint
and finish times relative to its first retained sample, and explicitly disables
missing/overwritten events. A tail within 50 ms can use an honestly labelled last
frame. The UI opens exactly that recording, pauses and seeks through the existing
ghost player. Later free flight or demonstrations cannot rebind those markers.
This remains in-memory presentation; it grants no progress and is not a complete
log of every recoverable excursion.
