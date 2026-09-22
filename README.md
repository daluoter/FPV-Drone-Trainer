# FPV Drone Trainer

A browser-based FPV flight school and freestyle trick trainer focused on trustworthy transmitter input, believable Acro / Rate flight, and measurable feedback.

> **Status: Phase 0 — foundation implemented.** The current build is a safe application shell only. It does not read a controller, run flight physics, or enable flight controls yet.

## Implemented

- Vite + React + strict TypeScript application scaffold
- Direct Three.js dependency reserved for the renderer boundary
- Vitest + Testing Library foundation test setup
- ESLint flat configuration and normal development scripts
- Dark, readable application shell with an explicit locked safety state
- Architecture and phase ownership documentation in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)

## In progress / next

Phase 1 is the Controller Lab: Gamepad discovery, channel mapping, calibration, endpoint handling, signal inspection, profile persistence, and the neutral-stability safety gate. No RC transmitter is accepted for flight until that contract is implemented and tested.

## Planned

The serial plan continues through the fixed-step dynamics core, Betaflight-style rates, rate control, Free Flight, and data-driven Hover, Coordinated Turn, Split-S, and Orbit lessons. See the implementation plan for phase gates and ownership.

## Local development

Requirements: Node.js 22+ and npm 10+.

```bash
npm install
npm run dev
```

Available commands:

```bash
npm test             # deterministic test suite
npm run typecheck    # strict TypeScript project checks
npm run lint         # ESLint with warnings treated as failures
npm run build        # typecheck and production Vite build
npm run preview      # serve the production build locally
```

## Browser and hardware status

Desktop Chrome and Edge are the initial target browsers because the future Controller Lab depends on the browser Gamepad API. Phase 0 has no browser Gamepad integration and has not been hardware-tested. Automated tests currently verify only the foundation shell; synthetic tests must not be interpreted as validation of an RC transmitter.

When controller support lands, the manual validation checklist will distinguish browser detection, calibration, neutral output, and real-transmitter flight checks.

## Architecture

The high-level data path is:

```text
RC device
  -> calibration
  -> normalized channels
  -> deadband / filtering
  -> rates
  -> flight controller
  -> motor mixer and motor dynamics
  -> rigid-body simulation
  -> drone state
  -> Three.js renderer
```

React owns menus, settings, lessons, HUD, and results. It does not own the high-frequency simulation loop. Controller processing will not rotate a Three.js object directly, and training success will be based on drone state and trajectory rather than a stick sequence.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for boundaries, contracts, and the planned runtime loop.
