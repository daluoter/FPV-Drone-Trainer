# Development workflow

## Start locally

Use Node.js 22+ and npm 10+:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. Phase 8 exposes the Controller Lab handoff, Free Flight screen, four geometric lesson evaluators, fixed-step observer seam, live checkpoints/metrics, field references/path, Mode 2 overlays, and bounded replay. Phase 9 adds terminal-result navigation and an integrated mocked-runtime UI regression. Use Developer keyboard fallback explicitly for a no-hardware smoke check; a calibrated physical controller remains required for RC evidence. The manual owner sequence is tracked in [`VALIDATION.md`](VALIDATION.md).

## Required checks

Run these before committing a phase:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run build` runs strict TypeScript project checks before creating the production bundle. `npm test` is a deterministic Vitest run suitable for CI; use `npm run test:watch` while developing.

## Continuous integration and production browser smoke

The `CI` workflow runs for pull requests, pushes to `main`, and manual dispatch.
It installs the locked npm dependencies, runs unit/integration tests and lint,
then builds with strict TypeScript checks for the GitHub Pages project path.
A Python Playwright smoke check opens that production build in Chromium and
checks project-path assets, an initialized WebGL2 canvas, explicit keyboard
arm/disarm, countdown and waiting for explicit arm, keyboard reset, training stop,
practice/challenge progress isolation, L00 knowledge completion and reload,
synchronized L01/L03/L04 demo controls without progress writes, airborne waiting
positions, fullscreen recovery, camera controls, and logo navigation. This workflow does
not deploy the site; production publishing remains a separate manual workflow.

To reproduce the browser check after the required npm gates:

```bash
python3 -m venv /tmp/fpv-browser-venv
/tmp/fpv-browser-venv/bin/python -m pip install -r scripts/browser-requirements.txt
/tmp/fpv-browser-venv/bin/python -m playwright install --with-deps chromium
npm run build -- --base=/FPV-Drone-Trainer/
/tmp/fpv-browser-venv/bin/python scripts/browser_smoke.py
```

Playwright's OS dependency installation may require administrator access on a
local machine. An existing compatible Chromium can instead be selected with
`--chromium-executable /path/to/chromium`. The script starts and stops its own
Vite preview using the same base path, so no separate preview process is needed.
Use `--port` if the default port is occupied. Each run writes diagnostics to a
new directory under `/tmp/fpv-browser-smoke`; `--artifact-dir` changes the parent.
For a local visual review, `--screenshot` also saves the successful 1280 × 720 workspace.
Failures include the preview log, browser errors, a screenshot and a Playwright
trace when the browser launched. CI uploads those diagnostics for seven days.

Chromium uses SwiftShader for repeatable headless WebGL checks. This smoke does
not establish physical GPU performance, transmitter compatibility or a human's
ability to complete a lesson; those remain separate owner checks.

## Evidence labels

- **Automated:** commands and deterministic tests run in the repository, including camera transforms and runtime safety transitions.
- **Browser:** a developer opens the Vite app, checks the Three.js scene/camera modes/HUD and browser console, and can exercise the explicit keyboard fallback.
- **Hardware:** a physical RC transmitter is connected and tested through the browser Gamepad API. Hardware evidence must never be inferred from unit tests or a browser shell check.

Phase 4/5/6/7/8 have automated controller/runtime/camera, tuning, training state/persistence, fixed-step hook, scene-reference, positive/negative maneuver-fixture, replay, and UI integration coverage. The UI integration test uses mocked runtime/renderer seams and is not browser evidence. No physical transmitter was available during implementation, so endpoint, direction, neutral and no-spontaneous-rotation hardware evidence remains outstanding. Browser/WebGL owner smoke is also required; deterministic fixtures and jsdom tests are not human-pilot, GPU-cleanup, or real-flight validation. Only ground collision is implemented; scene obstacles are visual references, not colliders.

## Source boundaries

Keep high-frequency work outside React render functions. Add pure modules and deterministic tests at the domain boundary first, then connect UI and rendering through snapshots. Update `docs/ARCHITECTURE.md` when a boundary or unit convention changes, and update the README so planned work is not described as implemented.
