# Development workflow

## Start locally

Use Node.js 22+ and npm 10+:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. The Phase 0 shell is safe UI-only scaffolding; controller and flight controls are intentionally disabled.

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

- **Automated:** commands and deterministic tests run in the repository.
- **Browser:** a developer opens the Vite app and checks the rendered shell and browser console.
- **Hardware:** a physical RC transmitter is connected and tested through the browser Gamepad API. Hardware evidence must never be inferred from unit tests or a browser shell check.

Phase 0 has automated foundation coverage only. It has no Gamepad API path and therefore has no hardware evidence.

## Source boundaries

Keep high-frequency work outside React render functions. Add pure modules and deterministic tests at the domain boundary first, then connect UI and rendering through snapshots. Update `docs/ARCHITECTURE.md` when a boundary or unit convention changes, and update the README so planned work is not described as implemented.
