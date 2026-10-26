# Development workflow

## Start locally

Use Node.js 22+ and npm 10+:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. Phase 8 exposes the Controller Lab handoff, Free Flight screen, four geometric lesson evaluators, fixed-step observer seam, live checkpoints/metrics, field references/path, Mode 2 overlays, and bounded replay. Phase 9 adds terminal-result navigation and an integrated mocked-runtime UI regression. Use Developer keyboard fallback explicitly for a no-hardware smoke check; a calibrated physical controller remains required for RC evidence. The manual owner sequence is tracked in [`VALIDATION.md`](VALIDATION.md).

### Confirm the updated local screen

The current release shows **版本 2026.10.26.1** near the page heading. Select **L13 大迴旋**, then open **L13 大迴旋示範**. There are 15 active flight lessons and 16 displayed demonstrations: three L00 axes and L01–L13. L00 俯仰 remains the short axis-introduction example. Course names stay Chinese; retained `split-s` and `orbit` entries remain **L14 翻轉下降** / **L15 正刷鍋**, keeping IDs, rules and historical results. See [the L13 guide](L13_POWER_LOOP.md) and [the numbering table](LEARNING_CONTRACT.md#課程編號與合併相容性).

Every demonstration has its own **示範進度**. Opening one temporarily replaces the live objectives/checkpoints/result presentation; chapter selection pauses at that step’s start. L09–L13 open at 0.5×. L13 has eight stages: ground, takeoff, forward entry, climb, inverted crest, descent, forward exit and recovery. Its pitch turn, actual rise and fore/aft span explain progress through the spatial maneuver. Each flip course requires its own direction through ground start, takeoff, preparation, inversion, full-turn and airborne recovery. Degree/rate/tilt instruments use live measurements or recorded samples plus the independent progress timeline; pause and backward seek restore matching values and steps.

The user accepted the original combined 前後翻轉 course in `2026.10.24.3` / `92517a8`, including both demonstrations and a self-flown complete turn. That approval remains with historical `full-flip`; the user also accepted the new split L11/L12 courses on 2026-10-26 in the `2026.10.25.1` / `44d673e` context. L01–L12 approvals remain. L13 actual user flight acceptance is still pending. No local storage clear is needed: reading saved `hover` or `full-flip` selects `takeoff` or `front-flip`, without rewriting raw preferences or granting completion. New `power-loop` and `front-flip` / `back-flip` use their own IDs at rules 6 and separately save attempts/results; none imports historical combined-course credit. This batch does not claim new hardware or pilot calibration.

If these are absent, stop the old terminal process with Ctrl+C, enter the intended repository, then update the feature branch and start the source server:

```bash
git fetch origin
git switch feat/beginner-flight-school
git pull --ff-only origin feat/beginner-flight-school
npm run dev
```

Open the exact URL printed by this new process and reload the page. Vite can choose another port when an older process already occupies its default port. For a production preview, run `npm run build` before `npm run preview`; preview serves the existing `dist` files and does not rebuild them when Git source changes. Keep the repository's chosen base path when testing a Pages build. No local storage clear is required, and the app does not register a service worker.

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
synchronized L01/L02/L03/L04/L05/L06/L07/L08/L09/L10/L11/L12/L13 demo controls without progress writes, L04/L05/L06/L07/L08/L09/L10/L11/L12/L13 seek/pause
and lesson reload, L02/L03/L04/L05/L06/L07/L08/L09/L10/L11/L12/L13 ground starts, an inline L00 playback exit,
independent progress and chapter seeking for every existing demo,
session-bound result marker seek with progress isolation, fullscreen recovery,
camera controls, and logo navigation. This workflow does
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

Phase 4/5/6/7/8 have automated controller/runtime/camera, tuning, training state/persistence, fixed-step hook, scene-reference, positive/negative maneuver-fixture, replay, and UI integration coverage. The UI integration test uses mocked runtime/renderer seams and is not browser evidence. No physical transmitter was available during implementation, so endpoint, direction, neutral and no-spontaneous-rotation hardware evidence remains outstanding. Browser/WebGL owner smoke is also required; deterministic fixtures and jsdom tests are not human-pilot, GPU-cleanup, or real-flight validation. L08 adds conservative full-drone swept collisions against all four sides of each shared gate frame. Ground contact remains global; Free Flight and other lessons clear the L08 static obstacle field, and their scene references remain visual guides. L09 consumes those same observational samples without adding live input overrides, automatic leveling or a new physics loop. Release-specific executed checks and counts belong in [the learning validation log](LEARNING_VALIDATION.md).

## Source boundaries

Keep high-frequency work outside React render functions. Add pure modules and deterministic tests at the domain boundary first, then connect UI and rendering through snapshots. Update `docs/ARCHITECTURE.md` when a boundary or unit convention changes, and update the README so planned work is not described as implemented.
