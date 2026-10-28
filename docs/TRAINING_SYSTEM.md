# Training system

Current release **2026.10.28.1** expands **L15 正刷鍋** (`orbit`, rules 6) into ground-start nine-step, five-lap teaching, a visible reference target and an independent actual-physics demonstration. The user explicitly accepted Free camera, L13’s 25 m version and L14 破S with its reference gantry on 2026-10-28 (`2026.10.27.2` / `67c64f1` context). **L15 user acceptance remains pending**. Earlier L15 rule-4 prototype results retain their original scope and do not credit current nine-step completion.

The learning menu has 15 courses; the registry has 17 definitions including historical `hover` and `full-flip`. `LEARNING_LESSONS` excludes both historical entries. L01 `takeoff` retains its 1.5-second settled-hover condition. Saved `hover` / `full-flip` selection opens `takeoff` / `front-flip`, without changing raw preferences during reading or crediting old results to replacements. Display numbers and the L14 title change are not storage keys.

The original combined and split flip-course approvals retain their recorded IDs/rule scopes. L01–L14 and Free camera have user acceptance; L15 does not yet. See [compatibility](LEARNING_CONTRACT.md#課程編號與合併相容性), [the roadmap](LEARNING_ROADMAP.md), and [the L15 guide](L15_ORBIT.md).

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

### 完整橫滾

L10 (`full-roll`, rules 6) has six checkpoints: ground, manual takeoff,
preparation, observed inversion, one full roll and airborne recovery. Its
suggested height is 10 m, with preparation at least 8 m high inside a 60 m
horizontal radius. Preparation takes 0.1 s with tilt ≤20°, body rate ≤90°/s,
horizontal speed ≤5 m/s and vertical speed within ±3.5 m/s. Once readiness is
latched, an upward throttle blip can establish height margin before the roll.

The observer accumulates signed net roll from successive actual quaternion
increments and checks their consistency with actual body angular velocity.
Left or right is accepted. A valid episode must pass actual inversion (tilt
at least 150°), reach a net 360° ±20° and return to tilt ≤25°. Summed absolute
Euler angles or rate integration alone are not proof; rocking half-rolls,
yaw spins, pitch flips, stationary stick input and antipodal quaternion signs
cannot create completion.

Recovery stays airborne and at least 1.5 m above ground, with tilt ≤25°, body
rate ≤90°/s, horizontal speed ≤5 m/s and vertical velocity −1.5 to +3 m/s for
0.25 consecutive seconds. There is no landing, original-XYZ return, fixed
heading or long hover requirement. Contact/low altitude, leaving the area,
excessive off-axis motion or overrotation invalidates the current episode.
Earlier checkpoint milestones may remain, but a fresh preparation and complete
observed roll are needed before recovery can pass. Crash, disarm, reset,
invalid samples and time/path discontinuity end the attempt; retry clears its
checkpoints. Practice is untimed; challenge allows 300 s.

The real-RC simulated demonstration uses the same evaluator, starts on the
ground and opens at 0.5×. It has its own chapter progress; replay cannot count
as a learner result. The live/replay roll HUD shows current episode progress,
signed roll rate (right positive) and actual tilt alongside altitude/XYZ.
The user accepted L10 in the `2026.10.24.2` / `f1c8745` delivery context. See [the L10 guide](L10_FULL_ROLL.md).

### 前翻與後翻

L11 (`front-flip`) and L12 (`back-flip`), each rules 6, have ground, manual takeoff, preparation, inversion, full-turn and recovery checkpoints. Suggested height is 10 m; preparation requires at least 8 m inside an 80 m horizontal radius. Preparation takes 0.1 s with tilt ≤25°, body rate ≤120°/s, horizontal speed ≤8 m/s and vertical speed within ±3.5 m/s.

The shared evaluator accumulates signed net actual quaternion rotation about the body pitch axis and cross-checks actual angular rate, including cumulative episode consistency. Forward is positive (`-body X`), backward negative. The lesson ID supplies `flipRequiredDirection`: +1 for `front-flip`, -1 for `back-flip`, 0 only for historical `full-flip`. A wrong-direction start invalidates the current episode, retains the triggering direction snapshot and asks for fresh preparation. A complete opposite-direction turn cannot pass the course. The same valid episode must show inversion (tilt ≥150°), 340–380° in the required direction and return to tilt ≤30°. Half-turn rocking, yaw/roll turns, rate-only or pose-only traces, q/-q representation changes and discontinuities cannot create completion.

Recovery requires at least 1.5 m altitude, tilt ≤30°, body rate ≤120°/s, horizontal speed ≤8 m/s and vertical speed -2.5 to +4 m/s for 0.2 s. Ground, low height, leaving the practice area, off-axis rotation, excess rotation, reversal or wrong direction clears current-episode proof. Retained checkpoint milestones cannot replace a fresh required-direction full turn after interruption. Practice is untimed, challenge 300 s. Success does not require landing, original heading or return-to-origin.

Displayed teaching kinds `front-flip` / `back-flip` bind to their respective lesson IDs. The internal legacy `full-flip` kind and lesson remain for compatibility, outside the displayed lesson/demo menu. Actual controller/physics recordings start from supported ground and open at 0.5×, with independent checkpoint timelines and measured degree/direction metrics. Playback never writes learner results. Live/replay instruments show turn progress, signed pitch rate and actual tilt beside altitude/XYZ. See [the guide](L11_FULL_FLIP.md).

### 破S

The active `split-s` lesson uses rule 6 and requests an explicit disarmed reset at the supported ground launch. Its eight phases are ground, takeoff, forward entry, measured half-roll inversion, descending pitch half-loop, reversed travel, upright exit and airborne recovery. Entry requires at least 15 m altitude, with 25 m recommended. A yaw-only U-turn or an in-place backflip cannot replace the real roll-then-dive path. The orange gantry and retained route illustrate entry above the beam, descent beyond it and reverse exit below it; the reference adds no collision or precise-passage requirement. See [the current criteria](LEARNING_CONTRACT.md) and [the guide](L14_SPLIT_S.md).

The former airborne rule-4 five-phase evaluator remains for historical contracts and scores. Old results stay in their original scope and are not credited to the current ground-start lesson.

### 正刷鍋

The current `orbit` lesson uses rules 6 and starts from supported ground. Its target is computed from `training-launch` and `landing-surface`: 30 m forward and 10 m above the configured ground. The new `orbit-zone` scene reference presents a clearly visible target and its teaching field; the legacy `orbit-poi` reference retains its original position and order for historical contracts.

Following the user's updated requirement, nine phases observe ground, takeoff, entry, five complete laps and recovery. Either direction is accepted, but five 360° laps must belong to one continuous directed episode (at least 1,800° net travel), with the nose tracking the visible target. The evaluator measures actual lateral motion around the target, not camera yaw alone or a forward-facing tangent circle. Broad radius (6–30 m), altitude (4–20 m), tangent-speed (at least 0.75 m/s) and inward-heading (at most 80° error) bounds remain. The HUD shows lap count toward 5/5. Exiting before five completed laps cannot finish the lesson. Invalid gaps cannot bridge positive angle progress; reversals cannot pump lap count. Sustained invalid flight or excessive backtracking restarts local proof while preserving the first measured reason; latched teaching milestones cannot finish a replacement episode. Physics timestamps, displacement/velocity and quaternion/rate consistency remain authoritative.

After the fifth complete lap, the evaluator freezes that completion radius. The pilot must actually depart outward by at least 3 m with outward radial speed at least 0.5 m/s, then maintain controlled airborne flight for 0.2 s. Slowing or hovering in place alone cannot complete the departure. The lesson does not demand landing, a perfect radius or a fixed exit point; practice is untimed and challenge allows 300 s. `orbitLearningEvaluator` observes flight only. It never modifies physics, sticks or scene state. The old `orbitEvaluator` remains a legacy rule-4 geometric contract; old three-step scores are preserved separately. See [the current criteria](LEARNING_CONTRACT.md) and [the L15 guide](L15_ORBIT.md).

## Scene references and visualization

`FlightScene.sceneReferences` exposes immutable renderer-independent snapshots
for the launch, landing area, beginner-route targets and retained advanced
references. L08 appends `wide-gate-1` through `wide-gate-3`, with opening size
`{ x: 4, y: 4, z: 0.35 }`, without reordering earlier IDs. Evaluators use copied
positions/dimensions and never mutate Three.js objects. L08's frame meshes use
the exact shared collider boxes; the opening outline and arrow are guidance
only. `setWideGateTarget(id | null)` toggles those overlays without removing
passed physical frames. Other lesson targets, the `split-s` reference and orbit
tower remain visual guides without static collision. L09 appends `recovery-zone`
at launch X/Z and ground + 4 m, with a 40 m horizontal practice radius. The
`basic-recovery-field` is a visual practice boundary and height guide; it does
not add collision or move the drone. Stage changes preserve the scene and canvas. L10 appends `roll-zone` and its own non-solid full-roll field with ground-relative height and horizontal guides; changing the lesson or stage never moves the physical drone. The shared L11/L12 scene appends `flip-zone` after `roll-zone` and a separate non-solid `full-flip-field`, with ground-relative preparation/target height, world-fixed horizontal and forward/backward references. `setFullFlipStage` changes stage colours without writing flight state.

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
lessons, retry isolation, disarmed telemetry, upright `split-s` U-turns,
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
remain unchanged, including rules 4 for L02–L04. L10 uses `full-roll`; L11 / L12 use `front-flip` / `back-flip`, each at rules 6 without modifying earlier results. Historical `full-flip` remains under its original scope and does not complete either new course. The prior L09 rules-5 document
remains readable as historical data and is not overwritten or relabeled as a
rules-6 completion. Current progress loads the per-lesson rule scope. Physics
context stays version 1; settings, input source and practice/challenge remain
separate comparison conditions.

The 18 displayed demonstrations cover three L00 axis examples and L01–L15, including separate L11 前翻, L12 後翻, L13 大迴旋 and L14 破S recordings.
Their bounded recordings are generated through the real 240 Hz simulator and
play through the independent ghost. The L01 demonstration explicitly teaches both takeoff and continuous hover.
L14 has an eight-stage physics demonstration; L15 has a separate nine-stage, five-full-lap recording. L15’s heading/radius/lap-count/directed-progress instruments follow the same retained observations as its chapters.

`createDemonstrationProgress` observes each retained course recording once with
its own checkpoint/evaluator state, outside the live session and progress store.
It creates a bounded immutable timeline; playback reads the current/completed/
pending snapshot for its clock. L00 has authored teaching-action chapters rather
than flight mastery checkpoints. Clicking a chapter pauses at its retained start;
seeking backward restores the earlier demo checkmarks. The demo panel replaces
live objective/checkpoint/result presentation while viewing, then restores the
unchanged learner view on exit. No demo progress is saved as learner completion.

Pose, recorded sticks, captions, scene stage and independent progress share the
same playback clock. L09–L15 start at 0.5×. L09 has 2 s to read preparation and 0.75 s
to observe a real onset before its recorded correction. The L08 demo uses the
same physical frame field as live practice. All remain labeled as simulated; their generated controls never override live practice.

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
shift with configured ground; `split-s` altitude gates use height above ground.
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
