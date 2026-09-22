# FPV Drone Trainer

A browser-based FPV flight school and freestyle trick trainer focused on trustworthy transmitter input, believable Acro / Rate flight, and measurable feedback.

> **Status: Phase 2 — deterministic simulation core implemented.** The current build includes the Controller Lab safety boundary and a dependency-light quaternion rigid-body core with explicit Quad-X motors, forces, torques, ground contact and a fixed 240 Hz accumulator. It does not yet connect rates, a flight controller, Three.js Free Flight or training lessons.

## Implemented

- Vite + React + strict TypeScript application scaffold
- Direct Three.js dependency reserved for the renderer boundary
- Vitest + Testing Library and ESLint foundation
- Browser Gamepad discovery, selection, fresh polling and disconnect handling
- Guided center, axis-identification, endpoint and throttle calibration
- Independent channel inversion and small remapped stick deadbands
- Raw / calibrated / normalized / deadband / filtered / final diagnostics
- Versioned local controller profiles with compatibility checks
- Mandatory processed neutral-stability test and future-flight eligibility gate
- Deterministic 5-inch quad dynamics: validated configuration, exact motor lag, Quad-X allocation, `r × F` moments, gravity, drag, quaternion integration, safety resets and fixed-step timing
- Architecture, controller and physics documentation in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/CONTROLLER_SYSTEM.md`](docs/CONTROLLER_SYSTEM.md), [`docs/COORDINATE_SYSTEM.md`](docs/COORDINATE_SYSTEM.md), [`docs/PHYSICS.md`](docs/PHYSICS.md), and [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)

## In progress / next

Phase 3 connects Betaflight-style Actual Rates, angular-rate control and mixer commands to the validated simulation core. Phase 4 will add the Three.js Free Flight scene and developer HUD. The current core has no hardware-realism claim and remains independent of React and rendering.

## Planned

The serial plan continues through Betaflight-style Actual Rates, rate control, Free Flight, and data-driven Hover, Coordinated Turn, Split-S and Orbit lessons. See the implementation plan for phase gates and ownership.

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

## Controller Lab

Desktop Chrome and Edge are the initial targets because the lab uses the browser Gamepad API. The lab deliberately does not assume `Axis 0 = Roll`, `Axis 1 = Pitch`, `Axis 2 = Throttle` or any other transmitter layout. It discovers the device, samples fresh state outside React, measures centers and real endpoints, rejects ambiguous/duplicate/invalid mappings, and requires a hands-off processed neutral test before a profile is eligible for future flight.

See [`docs/CONTROLLER_SYSTEM.md`](docs/CONTROLLER_SYSTEM.md) for the processing contract and authoritative browser references. Follow [`docs/CONTROLLER_TESTING.md`](docs/CONTROLLER_TESTING.md) for physical transmitter validation.

## Evidence status

- **Automated:** controller normalization, center offsets, asymmetric endpoints, inversion, throttle mapping, deadband remapping, non-finite rejection, axis identification, endpoint checks, neutral jitter, profile compatibility/persistence, safety gating and disconnect behavior are covered by Vitest.
- **Browser:** the Vite application and Controller Lab UI are build- and test-verified. A real browser smoke check can confirm rendering and Gamepad API availability.
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
