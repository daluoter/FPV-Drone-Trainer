# Development workflow

## Start locally

Use Node.js 22+ and npm 10+:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. Phase 6 exposes the Controller Lab handoff, Free Flight screen, training framework menu, fixed-step observer seam, and Mode 2 overlays. The four geometric lessons remain visibly unavailable until Phase 7. Use Developer keyboard fallback explicitly for a no-hardware smoke check; a calibrated physical controller remains required for RC evidence.

## Required checks

Run these before committing a phase:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run build` runs strict TypeScript project checks before creating the production bundle. `npm test` is a deterministic Vitest run suitable for CI; use `npm run test:watch` while developing.

## Evidence labels

- **Automated:** commands and deterministic tests run in the repository, including camera transforms and runtime safety transitions.
- **Browser:** a developer opens the Vite app, checks the Three.js scene/camera modes/HUD and browser console, and can exercise the explicit keyboard fallback.
- **Hardware:** a physical RC transmitter is connected and tested through the browser Gamepad API. Hardware evidence must never be inferred from unit tests or a browser shell check.

Phase 4/5/6 have automated controller/runtime/camera, tuning, training state/persistence, fixed-step hook, and scene-reference coverage with a browser Free Flight/training screen. No physical transmitter was available during implementation, so endpoint, direction, neutral and no-spontaneous-rotation hardware evidence remains outstanding. Browser smoke does not claim real hardware or real flight; maneuver evaluator evidence remains Phase 7 scope.

## Source boundaries

Keep high-frequency work outside React render functions. Add pure modules and deterministic tests at the domain boundary first, then connect UI and rendering through snapshots. Update `docs/ARCHITECTURE.md` when a boundary or unit convention changes, and update the README so planned work is not described as implemented.
