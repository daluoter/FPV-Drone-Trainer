# FPV Drone Trainer

A browser-based FPV flight school and freestyle trick trainer focused on trustworthy transmitter input, believable Acro / Rate flight, and measurable feedback.

> **Status: Phase 6 — training framework implemented.** The current build includes the Controller Lab handoff, explicit RC/developer arm gates, a direct Three.js field and quad, rigid FPV/chase/free cameras, a renderer-independent requestAnimationFrame owner around the fixed 240 Hz controller/simulation runtime, bounded tuning, a pure training state machine, defensive progress persistence, and Mode 2 sticks. The four geometric evaluators remain unavailable until Phase 7; replay remains out of scope.

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
- Training framework: explicit READY/COUNTDOWN/ACTIVE/SUCCESS/FAILED/RESULT machine, data-driven lesson contracts, one fixed-step sample hook, defensive recent/best/completed progress, truthful unavailable lesson menu/results/retry seam, scene reference IDs, and reusable live/demonstration Mode 2 sticks
- Architecture, controller, physics, Free Flight, tuning and training documentation in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/CONTROLLER_SYSTEM.md`](docs/CONTROLLER_SYSTEM.md), [`docs/COORDINATE_SYSTEM.md`](docs/COORDINATE_SYSTEM.md), [`docs/PHYSICS.md`](docs/PHYSICS.md), [`docs/FREE_FLIGHT.md`](docs/FREE_FLIGHT.md), [`docs/TUNING.md`](docs/TUNING.md), [`docs/TRAINING_SYSTEM.md`](docs/TRAINING_SYSTEM.md), and [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)

## In progress / next

Phase 6 is complete. The four geometric evaluators are the next Phase 7 owner; replay and final verification remain separate phases. The settings are provisional trainer assumptions only: the core makes no hardware-realism or flight-worthiness claim, and synthetic/browser evidence is not transmitter or flight validation.

## Planned

The serial plan continues through geometric lesson evaluators, replay and verification. See the implementation plan and [`docs/TRAINING_SYSTEM.md`](docs/TRAINING_SYSTEM.md) for phase gates and evaluator ownership.

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

- **Automated:** controller normalization, center offsets, asymmetric endpoints, inversion, throttle mapping, deadband remapping, non-finite rejection, axis identification, endpoint checks, neutral jitter, profile compatibility/persistence, safety gating and disconnect behavior are covered by Vitest. Phase 4/5 cover hidden-document and connection-session safety, keyboard pipeline equivalence, camera transforms, tuning ranges, persistence rejection and disarmed apply/reset behavior. Phase 6 covers training timing/session reset, malformed progress, fixed-step sample delivery and the lesson catalog contract.
- **Browser:** the Vite application, Controller Lab handoff, Three.js Free Flight scene, tuning UI and developer HUD are build- and test-verified. A real browser smoke check can confirm WebGL rendering, camera switching, keyboard fallback and settings application. Actual WebGL resource disposal/context-loss behavior remains browser-only evidence; jsdom tests do not prove GPU cleanup.
- **Hardware:** no physical RC transmitter was available during implementation; endpoint, direction, neutral and no-spontaneous-rotation checks remain required manual evidence.

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

React owns menus, settings, lessons, HUD and results. It does not own the high-frequency controller poller or future simulation loop. Controller processing never rotates a Three.js object directly, and training success will be based on drone state and trajectory rather than a stick sequence.
