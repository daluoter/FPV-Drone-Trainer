# FPV Drone Trainer

A browser-based FPV flight school and freestyle trick trainer focused on trustworthy transmitter input, believable Acro / Rate flight, and measurable feedback.

> **Status: Phase 9 integration/polish checkpoint.** Phases 0–8 are implemented: Controller Lab handoff, explicit RC/developer arm gates, a direct Three.js field and quad, rigid FPV/chase/free cameras, a renderer-independent requestAnimationFrame owner around the fixed 240 Hz controller/simulation runtime, bounded tuning, pure state/trajectory evaluators for Hover, Coordinated Turn, Split-S, and Orbit / 刷鍋, defensive progress persistence, live diagnostics, a bounded training path, Mode 2 sticks, and decimated immutable last-flight ghost playback. Terminal lesson states now present a `RESULT` screen and permit direct lesson selection without a reset. Phase 9 adds the integrated mocked-runtime UI regression and verification record; the owner browser/WebGL and hardware checklist remains required. Straight-line, box-pattern, and figure-eight replacements are not shipped; replay is in-memory only and not a physics continuation.

## Implemented

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
- Training framework and Phase 7 lessons: explicit READY/COUNTDOWN/ACTIVE/SUCCESS/FAILED/RESULT machine, disarmed lesson setup/reset boundary, fixed-step armed telemetry, pure incremental Hover/Coordinated Turn/Split-S/Orbit geometry checks, contiguous hover dwell, ordered turn gates, real Split-S inversion/reversal, directed orbit lap rejection of yaw-in-place/teleports, defensive progress, live metrics/checkpoints/results/retry, direct terminal lesson selection, visible references/path, and reusable Mode 2 sticks
- Phase 8 replay: bounded decimated recorder for actual fixed-step pose/quaternion/velocity/angular-rate/normalized-RC/controller-output samples, immutable snapshots, shortest-path quaternion ghost interpolation, 0.25x/0.5x/1x/2x playback, trajectory visualization, and explicit disarm/training/arm isolation; see [`docs/REPLAY.md`](docs/REPLAY.md)
- Phase 9 integration/polish: mocked runtime/renderer UI regression covering start/arm/sample success and failure, result persistence once, lesson selection, retry/reset, replay boundary, and tuning isolation. This is deterministic test evidence, not browser/WebGL evidence.
- Architecture, controller, physics, Free Flight, tuning and training documentation in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/CONTROLLER_SYSTEM.md`](docs/CONTROLLER_SYSTEM.md), [`docs/COORDINATE_SYSTEM.md`](docs/COORDINATE_SYSTEM.md), [`docs/PHYSICS.md`](docs/PHYSICS.md), [`docs/FREE_FLIGHT.md`](docs/FREE_FLIGHT.md), [`docs/TUNING.md`](docs/TUNING.md), [`docs/TRAINING_SYSTEM.md`](docs/TRAINING_SYSTEM.md), and [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)

## Verification status and owner checklist

Phase 9 automated gates and the deterministic mocked-runtime UI regression are recorded in [`docs/VALIDATION.md`](docs/VALIDATION.md). Browser/WebGL and physical-transmitter checks are **required and not performed** on this host. The owner must run the manual sequence there before claiming browser or hardware evidence; a mocked renderer/runtime is not a substitute.

The recorder is bounded and in-memory only; replay is presentation evidence rather than a full physics continuation. Dynamics, tuning values, and maneuver thresholds are provisional trainer assumptions only: the core makes no hardware-realism, flight-worthiness, or human-pilot claim. The simulation resolves ground contact only; there is no obstacle collision model for the pad, gates, tower, or other scene geometry. The production build currently emits Vite's advisory for a minified JavaScript chunk over 500 kB (about 915.73 kB, 250.06 kB gzip); this is a bundle-size warning, not a failed gate.

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
- **Browser/WebGL — REQUIRED / NOT PERFORMED:** run the manual owner sequence in [`docs/VALIDATION.md`](docs/VALIDATION.md). Browser pilot/WebGL smoke is currently blocked on this host because Chromium is unavailable and `libnspr4.so` is missing; it was not resolved with unrelated system changes. Actual WebGL resource disposal/context-loss behavior remains browser-only evidence; jsdom tests do not prove GPU cleanup.
- **Hardware — REQUIRED / NOT PERFORMED:** no physical RC transmitter was available during implementation. Endpoint, direction, neutral, arm handoff and no-spontaneous-rotation checks remain required manual evidence.
- **Known limitations:** only ground collision is implemented; scene obstacles do not collide. Simplified dynamics/tuning and training thresholds are provisional and unvalidated against hardware or human pilots. Replay is in-memory and presentation-only. `npm run build` emits the documented Vite bundle-size advisory for the approximately 915.73 kB minified entry chunk.

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
