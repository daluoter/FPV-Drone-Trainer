# FPV Drone Trainer

A browser-based FPV flight school and freestyle trick trainer focused on trustworthy transmitter input, believable Acro / Rate flight, and measurable feedback.

> **Status: release 2026.10.26.1.** The user accepted the separate **L11 前翻** and **L12 後翻** courses in the `2026.10.25.1` / `44d673e` delivery context. This batch adds **L13 大迴旋** (`power-loop`): ground takeoff, forward entry, an actual spatial vertical loop and airborne recovery, with eight independent demonstration steps. L13 automated, strict build, lint and Chromium checks passed; user flight acceptance remains pending and is tracked separately in [validation records](docs/LEARNING_VALIDATION.md); see [the tryout guide](docs/L13_POWER_LOOP.md) and [local update instructions](docs/DEVELOPMENT.md#confirm-the-updated-local-screen). Historical results retain their stable course IDs.

The [freestyle curriculum](docs/FREESTYLE_CURRICULUM.md) now extends through L24: L13 大迴旋 follows L11 前翻 and L12 後翻. Later techniques remain tracked individually; this batch implements the empty-field L13 course, while obstacle variants are deferred.

## Implemented

- L13 大迴旋 requires real climb, over-top inversion, descending travel and a forward exit; an in-place pitch flip cannot substitute for the flight path. It has a separate result ID and independent eight-step demonstration. See [the L13 guide](docs/L13_POWER_LOOP.md).
- The accepted split L11 前翻 / L12 後翻 implementation keeps the six ground/takeoff/preparation/inversion/full-turn/recovery phases while enforcing each course’s required direction. The two demonstrations and results are bound to their own course; L00 pitch remains separate. See [the tryout guide](docs/L11_FULL_FLIP.md).
- L10 完整橫滾 practice observes a real left or right 360° rotation, inversion and return to upright flight before airborne recovery can pass. The live player remains in Acro; the lesson never supplies automatic stick inputs or pose edits. See [the L10 tryout guide](docs/L10_FULL_ROLL.md).
- L01 controlled takeoff and stationary hover share one lesson and one synchronized demonstration. The active menu has 15 flight lessons; saved `hover` and `full-flip` selections open L01 and L11 respectively without rewriting raw preferences during reading. Their original results remain historical and are not credited to replacement courses.
- Independent demonstration progress covers 16 displayed demonstrations: three L00 axes and L01–L13. Seeking backward restores earlier checkpoints, exiting restores the unchanged learner view, and playback never writes learner results. This batch does not add demonstrations for L14 翻轉下降 or L15 正刷鍋.

- L09 ground-start guided recovery practice: measured tilt, sinking and drift onset before the corresponding recovery can pass, exercise-specific preparation, 0.25 s confirmation windows, current-stage motion feedback and a synchronized actual-physics demo. The revised demo starts at 0.5× with reading and observation time around each exercise. Earlier completed exercises survive a non-crash ground return or low-height interruption; the current exercise must then be prepared and induced again. Leaving the broad area pauses confirmation until returning. See [the L09 tryout guide](docs/L09_BASIC_RECOVERY.md).

- L08 ground-start wide-gate route, persistent physical frames with shared render/collision geometry, continuous crossing checks, active guidance, relative hints and an actual-physics synchronized demo. There is no added speed, dwell, heading or landing requirement; see [the L08 tryout guide](docs/L08_WIDE_GATE.md).

- L07 ground-start figure-eight route with opposing left/right loops, ordered central visits, active goal markers, relative hints and an actual-physics synchronized demo; see [the L07 tryout guide](docs/L07_FIGURE_EIGHT.md).

- L06 ground-start square route, four straight legs and ordered corners, active goal markers, relative hints and a synchronized actual-physics demo; see [the L06 tryout guide](docs/L06_SQUARE_ROUTE.md).

- L05 ground-start right/left coordinated turns, measured trajectory change, visible route and active targets, synchronized demo and rule-isolated progress; see [the L05 tryout guide](docs/L05_COORDINATED_TURN.md).

- L04 ground-start lateral movement and orientation lesson, active target zones, heading-relative hints and a synchronized real-physics teaching recording; see [the L04 tryout guide](docs/L04_DIRECTION_CONTROL.md).
- Always-visible altitude and explicit launch-relative X/Y/Z, using the recorded ghost and original field settings during replay; negative Z means forward. XYZ stays visible after a crash with Developer HUD off.
- Vite + React + strict TypeScript application scaffold
- Direct Three.js dependency reserved for the renderer boundary
- Vitest + Testing Library and ESLint foundation
- Browser Gamepad discovery, selection, fresh polling and disconnect handling
- Guided center, axis-identification, endpoint and throttle calibration
- Independent channel inversion and small remapped stick deadbands
- Raw / calibrated / normalized / deadband / filtered / final diagnostics
- Versioned local controller profiles with compatibility checks
- Mandatory processed neutral-stability test and Free Flight arm-eligibility gate
- Deterministic 5-inch quad dynamics: validated configuration, exact motor lag, Quad-X allocation, `r × F` moments, gravity, drag, quaternion integration, safety resets and fixed-step timing
- Betaflight Actual Rates to explicit pilot/body SI angular targets, bounded rate PID with antiwindup and derivative-on-measurement, fixed-step flight runtime, motor telemetry and safe reset/disarm
- Free Flight integration: direct Three.js ground/grid/takeoff field and quad, rigid FPV/chase/free cameras, resize/dispose handling, fixed-loop sampling/rendering, throttled telemetry HUD, RC arm handoff and explicit developer keyboard fallback
- Bounded tuning: per-axis Actual Rates center/max/expo with curve graph, bounded simplified mass/motor/drag/PID controls, discrete FPV mount angles and FOV, versioned local persistence with incompatible-data rejection, reset defaults and an explicit disarmed runtime reconfiguration boundary
- Training framework and Phase 7 lessons: explicit READY/COUNTDOWN/WAITING_FOR_ARM/ACTIVE/SUCCESS/FAILED/RESULT machine, disarmed lesson setup/reset boundary, fixed-step armed telemetry, pure incremental `hover`/`coordinated-turn`/`split-s`/`orbit` geometry checks, contiguous hover dwell, ordered turn gates, real `split-s` inversion/reversal, directed orbit lap rejection of yaw-in-place/teleports, defensive progress, live metrics/checkpoints/results/retry, direct terminal lesson selection, visible references/path, and reusable Mode 2 sticks
- Phase 8 replay: bounded decimated recorder for actual fixed-step pose/quaternion/velocity/angular-rate/normalized-RC/controller-output samples, immutable snapshots, shortest-path quaternion ghost interpolation, 0.25x/0.5x/1x/2x playback, trajectory visualization, and explicit disarm/training/arm isolation; see [`docs/REPLAY.md`](docs/REPLAY.md)
- Phase 9 integration/polish: mocked runtime/renderer UI regression covering start/arm/sample success and failure, result persistence once, lesson selection, retry/reset, replay boundary, and tuning isolation. This is deterministic test evidence, not browser/WebGL evidence.
- Architecture, controller, physics, Free Flight, tuning and training documentation in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/CONTROLLER_SYSTEM.md`](docs/CONTROLLER_SYSTEM.md), [`docs/COORDINATE_SYSTEM.md`](docs/COORDINATE_SYSTEM.md), [`docs/PHYSICS.md`](docs/PHYSICS.md), [`docs/FREE_FLIGHT.md`](docs/FREE_FLIGHT.md), [`docs/TUNING.md`](docs/TUNING.md), [`docs/TRAINING_SYSTEM.md`](docs/TRAINING_SYSTEM.md), and [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)

## Verification status and owner checklist

Phase 9 automated gates, the deterministic mocked-runtime UI regression, and the local browser/WebGL smoke evidence are recorded in [`docs/VALIDATION.md`](docs/VALIDATION.md). Physical-transmitter checks remain required and were not performed; a mocked renderer/runtime or headless browser is not hardware evidence.

The recorder is bounded and in-memory only; replay is presentation evidence rather than a full physics continuation. Dynamics, tuning values, and maneuver thresholds are provisional trainer assumptions only: the core makes no hardware-realism, flight-worthiness, or human-pilot claim. Ground contact remains global; static frame collisions are enabled only for the L08 environment. Free Flight and other lessons clear that obstacle field; their pads, teaching markers and tower remain visual references. The frame check uses a conservative full-drone envelope, so clearance near a corner can be stricter than the rendered airframe outline. The production build emits Vite's advisory for an entry chunk over 500 kB; current measurements are recorded in the learning validation log.

See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md), [`docs/REPLAY.md`](docs/REPLAY.md), and [`docs/TRAINING_SYSTEM.md`](docs/TRAINING_SYSTEM.md) for the domain contracts and evidence limits.

## Local development

Requirements: Node.js 22+ and npm 10+.

```bash
npm install
npm run dev
```

Available commands:

```bash
npm test             # deterministic controller and shell tests
npm run typecheck    # strict TypeScript project checks
npm run lint         # ESLint with warnings treated as failures
npm run build        # typecheck and production Vite build
npm run preview      # serve the production build locally
```

Free Flight is available at the Free Flight section after startup. Select **Developer keyboard fallback** explicitly for a no-hardware smoke check; W/S, A/D, Q/E and R/F are normalized RC commands and X requests the normal reset path. A physical transmitter is still required to validate calibration, direction, neutral and spontaneous-rotation behavior.

```bash
npm run dev          # browser smoke: open the printed localhost URL
```

## Controller Lab

Desktop Chrome and Edge are the initial targets because the lab uses the browser Gamepad API. The lab deliberately does not assume `Axis 0 = Roll`, `Axis 1 = Pitch`, `Axis 2 = Throttle` or any other transmitter layout. It discovers the device, samples fresh state outside React, measures centers and real endpoints, rejects ambiguous/duplicate/invalid mappings, and requires a hands-off processed neutral test before a profile is eligible for the Free Flight arm handoff.

See [`docs/CONTROLLER_SYSTEM.md`](docs/CONTROLLER_SYSTEM.md) for the processing contract and authoritative browser references. See [`docs/FLIGHT_CONTROLLER.md`](docs/FLIGHT_CONTROLLER.md) for SI gains, signs, runtime and telemetry. Follow [`docs/CONTROLLER_TESTING.md`](docs/CONTROLLER_TESTING.md) for physical transmitter validation.

## Evidence status

- **Automated:** controller normalization, center offsets, asymmetric endpoints, inversion, throttle mapping, deadband remapping, non-finite rejection, axis identification, endpoint checks, neutral jitter, profile compatibility/persistence, safety gating and disconnect behavior are covered by Vitest. Phase 4/5 cover hidden-document and connection-session safety, keyboard pipeline equivalence, camera transforms, tuning ranges, persistence rejection and disarmed apply/reset behavior. Phase 6/7 cover training timing, retry/reset isolation, armed/disarmed sample safety, progress persistence, fixed-step delivery, four positive/negative geometric fixture families, incremental route/dwell/lap checks, and the lesson catalog/scene contract. Phase 9 also covers the integrated React flow with mocked runtime/renderer seams; that test does not claim browser rendering or hardware behavior.
- **Browser/WebGL — COMPLETED (local smoke):** user-local Playwright Chromium with an extracted `libnspr4.so` rendered the initial FPV scene, Chase and Free/debug cameras, settings reset, replay playback, and an induced context-loss → disarm/Arm block → canvas replacement recovery path on the Vite dev server; the production preview also exposed a `946 × 430` WebGL2 canvas with no renderer/page errors. Initial console capture had no renderer initialization or page errors; headless Chromium emitted only SwiftShader `GL Driver Message ... GPU stall due to ReadPixels` performance warnings. Physical-browser/GPU variance and actual resource cleanup still need owner confirmation; jsdom tests do not prove GPU cleanup.
- **Hardware — REQUIRED / NOT PERFORMED:** no physical RC transmitter was available during implementation. Endpoint, direction, neutral, arm handoff and no-spontaneous-rotation checks remain required manual evidence.
- **Known limitations:** static obstacles are limited to L08's gate frames and use conservative full-drone swept bounds; other scene references do not collide. Simplified dynamics/tuning and training thresholds still require hardware and pilot calibration. Learner acceptance of earlier lessons does not establish physical realism or broader transmitter compatibility. Replay is in-memory and presentation-only. `npm run build` emits the documented Vite bundle-size advisory for the entry chunk over 500 kB.

## Architecture

The high-level data path is:

```text
RC device
  -> raw Gamepad snapshot
  -> calibration profile
  -> normalized channels
  -> deadband / filter
  -> rates
  -> flight controller
  -> motor mixer and motor dynamics
  -> rigid-body simulation
  -> drone state
  -> Three.js renderer
```

React owns menus, settings, lessons, HUD and results. It does not own the high-frequency controller poller or simulation loop. Controller processing never rotates a Three.js object directly, and training success is based on armed drone state and trajectory geometry rather than a stick sequence. The renderer may show a bounded presentation path, but evaluators remain pure and renderer-independent.
