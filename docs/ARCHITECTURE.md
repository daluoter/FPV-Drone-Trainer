# Architecture

## Current scope

The application implements the controller boundary, canonical Actual Rates, a modular SI angular-rate PID loop, deterministic controller-to-simulation runtime, the Free Flight presentation seam, bounded tuning, beginner lessons through L11, the retained `split-s`/`orbit` evaluators, and bounded replay. The application-owned poller is sampled by the runtime's requestAnimationFrame owner; React receives throttled telemetry only. The direct Three.js scene contains ground/grid, a takeoff pad, lesson guidance, L08 physical gate frames, an L09 visual recovery area, an L10 visual roll-practice field, an L11 visual flip-practice field, bounded training path, a live quad, and an independent replay ghost, with rigid FPV, chase and free/debug cameras. The explicit RC arm handoff consumes the Controller Lab's verified profile/session and checks current neutral/low throttle only at arm time. Developer keyboard input is opt-in and follows the same normalized RC/rates/PID path. Tuning edits a copied, validated versioned configuration and reaches flight only through an explicit disarmed reset/reconfiguration boundary. Training consumes one per-fixed-step sample hook, carries explicit armed telemetry, uses O(1) incremental evaluator state with a fixed-capacity decimated/ring path snapshot, and never mutates physics. Replay records only compact decimated fields from armed fixed-step samples, retains one bounded in-memory last flight, and interpolates an immutable ghost without writing the live `DroneState`.

The phase contract is tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md). Each later phase must preserve the boundaries below and pass the phase gate before the next seam is started.

Release `2026.10.24.1` merges takeoff and hover in the learning navigation. L01
(`takeoff`) retains its existing liftoff and 1.5-second settled-hover evaluator;
the later display numbers shift down by one. `LEARNING_LESSONS` provides the 11
active choices, while the registry retains the old `hover` definition for
historical data and evaluator compatibility. A saved `hover` selection resolves
to `takeoff` without rewriting the source preferences document. Lesson IDs,
checkpoint IDs, rule scopes and stored results do not depend on display numbers.
The accepted recovery lesson is now L09. Release `2026.10.24.2` adds L10 (`full-roll`) as the twelfth active choice; the registry also retains historical Hover. The user accepted the L01 merge, navigation and record preservation in the `.1` delivery context. The user accepted L10 in the `2026.10.24.2` / `f1c8745` delivery context. The `2026.10.24.3` batch adds L11 前後翻轉 (`full-flip`, rules 6) as the thirteenth active choice, with two simulated demonstrations and independent playback progress. L11 automated and browser checks passed; user acceptance remains pending. Course titles are Chinese only; `split-s`/`orbit` display as L13 翻轉下降／L14 正刷鍋 without changing stable IDs, criteria or historical records. Their existing prototypes remain, with expanded teaching deferred to their own batches.

## Runtime boundaries

```text
React application shell / UI
  menus, configuration, lesson screens, HUD, results
                         │ commands + snapshots
                         ▼
Controller domain ──> Flight-control domain ──> Simulation domain
  Gamepad polling       rates + rate PID           state + forces + motors
  calibration           mixer commands             fixed-step integration
  signal diagnostics                                quaternion orientation
                         │ immutable state snapshots
                         ▼
                 Three.js rendering domain
                 scene, cameras, visual geometry

Training domain consumes state snapshots and trajectories.
Replay domain records bounded snapshots independently of player physics.
Config domain persists versioned settings and controller profiles locally.
```

### Ownership rules

- **React/UI** owns presentation, low-frequency application state and bounded tuning forms. It must not contain flight physics or direct controller-to-object rotation. Tuning may request a runtime reconfiguration, but it cannot mutate an armed simulation in place.
- **Controller** owns fresh Gamepad snapshots, device selection, calibration, normalization, inversion, deadband, filtering, profile compatibility, disconnect handling and safety status. `GamepadPoller` runs outside React; the Controller Lab subscribes only to a throttled presentation view. It must not know about Three.js.
- **Rates and flight controller** convert normalized channels into desired angular rates and motor corrections. The Phase 3 runtime owns per-axis SI rate PID state, antiwindup, bounded outputs, explicit pilot/body signs and telemetry. Acro mode never self-levels when the roll or pitch stick is released.
- **Simulation** owns the authoritative SI-unit state: position, velocity, quaternion orientation, angular velocity, mass, inertia, forces, torques, motor response, ground contact, optional static-box swept collision and fixed-step integration. The Phase 3 runtime feeds bounded mixer commands into that owner, has no React or renderer dependency and reports dropped steps, controller telemetry and safe-reset warnings.
- **Renderer** consumes simulation snapshots and owns Three.js objects, cameras, and visual environment. `FlightRenderer` handles resize/disposal and does not perform calibration or flight dynamics. Actual WebGL resource disposal/context-loss behavior remains browser-only evidence.
- **Training** evaluates state, geometry, trajectory, and timing windows through a pure `TrainingSession`/evaluator contract. The runtime sends one immutable observational sample per fixed step; a stick sequence alone cannot pass a lesson. Lesson setup can request a disarmed runtime reset but cannot apply physics or scene transforms.
- **Replay** stores compact immutable decimated samples from actual armed fixed-step callbacks in a bounded ring. Playback owns a relative clock and independent `ReplayGhostState`; shortest-path quaternion interpolation, trajectory drawing, and camera presentation never mutate the player simulation. Entering replay disarms and aborts an active lesson; exit resets timestamps/controller memory and requires explicit rearm. Replay is in-memory only and is not training input.
- **Config/tuning** validates complete versioned local settings and rejects corrupt or incompatible data. A settings apply replaces the fixed-step runtime only after disarming and resetting controller/input state.
- **Shared world geometry** describes L08 gate openings and frame boxes in `src/world/wideGates.ts`, independently of React and Three.js. Lesson setup supplies validated copied boxes to the runtime at a disarmed boundary. Rendering consumes the same boxes without owning collision decisions; the evaluator observes post-physics samples and ordered opening crossings.

## Data contracts

The intended flight data path is:

```text
raw Gamepad
  -> calibration profile
  -> normalized channels
  -> deadband / filter
  -> Actual Rates (target angular rates)
  -> angular-rate controller (target torque)
  -> Quad-X mixer
  -> motor response
  -> thrust and reaction torque
  -> rigid-body integration
  -> immutable DroneState snapshot
  -> renderer / HUD / training / replay
```

The signal path is deliberately explicit so neutral drift, sign errors, saturation, and invalid numerical state can be inspected at each boundary. Every internal physics value will use SI units: metres, seconds, kilograms, Newtons, Newton-metres, radians, and radians per second. UI degree-per-second values are converted at the rates boundary.

## Simulation loop contract

The simulation will run at a configurable fixed timestep (initial target: 240 Hz) using an accumulator. Render FPS and React render frequency must not determine physics integration. The browser input sampler will publish the latest controller snapshot; the fixed-step loop will consume that snapshot at each simulation step.

The authoritative orientation will be a normalized quaternion. Euler angles may be derived for display only. Gravity, body-frame thrust, aerodynamic drag, angular damping, motor response, and collision responses will be represented as forces and torques rather than direct position or Euler-angle edits.

Invalid timestep, non-finite state, invalid mass, or an unusable quaternion is a simulation warning and a safe reset condition—not a value to silently propagate.

## L08 physical environment

`createWideGates` defines three 4 × 4 m clear openings, centered at configured ground + 3 m and 8 / 16 / 24 m ahead of the supported launch X/Z. Every gate has separate left/right posts and top/bottom bars. `DroneSimulation` owns a bounded immutable static-box collection; the runtime rejects replacement while armed. The fixed-step solver sweeps a conservative all-orientation full-drone envelope along each COM segment and latches the earliest frame contact before publishing the observational sample. Crash state, zeroed motors and an explicit collider ID therefore originate in physics, independently of the lesson evaluator.

The UI applies this field only when L08 is selected and synchronizes it again at the arm boundary; Free Flight and other lessons use an empty static obstacle field. Lesson reset/setup, configuration changes and playback preserve the disarmed transition rules. Ground-contact behavior remains shared across lessons. These bounds do not add collisions to the legacy `split-s` gate, orbit tower or other teaching references.

The renderer appends `wide-gate-1` through `wide-gate-3` references without changing earlier IDs or order. `wide-gate-field` keeps every physical frame visible during L08, including passed gates and after completion. `setWideGateTarget(id | null)` changes only the named guidance overlay; a null target never removes an obstacle. Reconfiguration retains the selected lesson and guidance on the same canvas. Replay uses the independent ghost and cannot score a gate crossing or create mastery evidence.

## L09 observational recovery practice

L09 (`basic-recovery`) starts at the supported ground launch and keeps normal Acro control throughout the live exercise. The learner follows prompts to produce a small tilt, descent or horizontal drift; the evaluator waits for the corresponding actual state before accepting its recovery. No scripted live stick override, disturbance force, direct pose edit, automatic leveling or altitude controller is added.

The pure evaluator computes tilt from the authoritative quaternion, rotation rate from body angular velocity, and vertical / horizontal speeds from world velocity. It keeps bounded incremental preparation, onset-validity and recovery-dwell metrics. Each new exercise first needs a short settled preparation above the ground; a recovery then needs 0.25 seconds of consecutive valid airborne samples. Preparation is specific to the next exercise rather than requiring a full all-axis hover. Contact or low height invalidates the current onset and dwell. Earlier completed exercises remain; this exercise must be prepared and induced again. Leaving the broad practice area resets preparation / dwell but retains an already valid onset, so recovery can continue after returning. No fixed XYZ return or heading target is imposed.

The `basic-recovery-field` scene group and appended `recovery-zone` reference are visual guides around the launch, with a recommended 4 m height and a 40 m horizontal radius. They add no static colliders. Stage presentation and the live / replay motion HUD consume snapshots; the existing runtime remains the sole animation-loop and physics owner. A simulated teaching recording uses actual RC inputs through the solver, then plays as an independent ghost without awarding progress. See [the L09 guide](L09_BASIC_RECOVERY.md) and [the training contract](LEARNING_CONTRACT.md).

## L10 observational full roll

L10 (`full-roll`, rules 6) is a new lesson ID after accepted L09. It starts on
supported ground and observes launch, takeoff, preparation, inversion, a full
roll and airborne recovery. A signed net roll is accumulated from consecutive
quaternion increments and checked against actual body angular velocity. Both
left and right are valid. Inversion and a return to upright flight in the same
valid episode are required; yaw spins, pitch flips, absolute-angle rocking and
quaternion sign changes do not substitute for the maneuver.

The evaluator retains bounded incremental evidence. Ground/low-height contact,
leaving the area, excessive off-axis motion or overrotation invalidates the
current episode; historical checkpoints alone cannot bypass a fresh full roll.
Recovery requires a short airborne confirmation. The visual roll field and
`roll-zone` reference are ground-relative presentation geometry, not colliders.
`setFullRollStage` changes guidance on the same renderer/canvas. Live HUD derives
actual roll rate and tilt from state, while replay uses ghost state and the
recording's independent progress observer. No additional physics loop or player
control assistance is installed. Exact prototype thresholds and manual checks
are in [the L10 guide](L10_FULL_ROLL.md).

## Independent demonstration progress

All 13 existing demo kinds have their own bounded presentation timeline. For
course demos, `demonstrationProgress.ts` projects retained recording measurements
into a separate evaluator/checkpoint observer once. It never uses or writes the
live TrainingSession or progress store. L00 axis demos instead use authored
teaching-action chapters. Playback time selects completed/current/pending steps;
chapter seek pauses at the recorded start and seeking backward restores earlier
checkmarks. The React demo view temporarily replaces live objective/checkpoint/
result presentation; exiting restores the unchanged learner state.

L09's generated recording adds reading and actual-onset observation intervals; L10's
recording separates preparation, inversion, a complete roll and recovery. Both
open at 0.5×. These are recorded control choices and presentation settings, not
live flight assistance. Rules 6 isolates eased L09 results from historical rules 5;
New `full-roll` results also use rules 6 under their own lesson ID; L05–L08 and earlier course scopes remain unchanged.

## Safety boundary

Normal flight is unavailable until the controller contract can prove:

- one valid, compatible device is selected;
- roll, pitch, yaw, and throttle mappings are present and intentionally distinct;
- calibrated endpoint ranges are valid;
- centered roll, pitch, and yaw are stable after processing; and
- all processed values are finite.

The Controller Lab evaluates this boundary and displays each failure reason. Free Flight consumes this gate rather than bypassing it; the arm-time handoff adds current neutral and low-throttle checks.

## Testing strategy

Pure controller transforms, calibration statistics, profile compatibility, poller disconnect behavior and the safety gate are tested with deterministic inputs. Phase 2 adds coordinate/quaternion, configuration validation, motor lag, mixer signs and saturation, `r × F` moments, gravity, hover sanity, attitude-transformed thrust, safety reset and fixed-step render-rate equivalence tests. Phase 3 adds pilot/body sign conversion, bounded rate PID response and antiwindup, derivative-on-measurement, invalid-input reset, complete calibrated-neutral integration, Acro release, hover and frame-rate equivalence telemetry tests. Phase 4 adds camera transform contracts, runtime arm/disarm transitions, disconnect/session/invalid-input handling, source/profile changes and focus safety. Phase 6/7 adds training phase/timestamp/session isolation, malformed progress rejection, per-fixed-step armed hook, scene/reference/path contracts, retry safety, and positive/negative geometric fixtures. Phase 8 adds bounded recorder capacity/decimation, immutable compact snapshots, invalid timing rejection, antipodal shortest-path interpolation, playback clocks, ghost rendering, and runtime arm/training isolation. UI tests cover application state and accessibility-facing behavior. Browser smoke tests and real transmitter checks remain separate evidence; passing unit tests never claims hardware validation or aerodynamic realism.


## Explicit lesson preparation and observational contact

Airborne lessons request a disarmed preparation reset through the existing
runtime. `FlightSimulation` owns the preparation flag; `DroneSimulation.stepHeld`
advances fixed-step simulation time/index while keeping the prepared physical
state unchanged. Successful explicit arm releases the hold. Normal free flight,
reset/reconfigure and replay boundaries preserve their ordinary safety semantics;
no additional animation loop or live altitude controller is introduced.

The runtime includes optional configured-ground contact in immutable training
samples: actual ground height, raw orientation-dependent support offset, and a
contact flag. Landing evaluators consume these observations independently of
visual pad geometry. Renderer anchors normalize against the same configured
initial state, and reconfiguration disposes the former scene while retaining the
single WebGL owner.

Practice local recovery clears only evaluator objectives and incremental dwell.
A separate continuous previous-flight sample remains for physical-clock and path
integrity checks. Rules version 2 separates these stricter acceptance rules from
old contextual scores. Knowledge preferences, flight progress and presentation
recordings remain separate data domains.


Result-marker review retains one immutable terminal-session recording beside its
checkpoint times. It is a separate bounded presentation snapshot, captured once
per result session and trimmed to that attempt; later recorder writes, source
clock resets and demonstration playback cannot rebind it. Marker seek uses the
existing disarmed ghost runtime and never emits scored fixed-step samples.
Ground-start training anchors and demo targets share pure field geometry;
contact observation uses the physical solver's contact slop. Rules version 3
separates revised route/landing acceptance from earlier results.
