# Development workflow

## Start locally

Use Node.js 22+ and npm 10+:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. Phase 8 exposes the Controller Lab handoff, Free Flight screen, four geometric lesson evaluators, fixed-step observer seam, live checkpoints/metrics, field references/path, Mode 2 overlays, and bounded replay. Phase 9 adds terminal-result navigation and an integrated mocked-runtime UI regression. Use Developer keyboard fallback explicitly for a no-hardware smoke check; a calibrated physical controller remains required for RC evidence. The manual owner sequence is tracked in [`VALIDATION.md`](VALIDATION.md).

### Confirm the updated local screen

The current release shows **版本 2026.10.28.1** near the page heading. In **Free / debug**, use the visible **前移鏡頭 1 m／後移鏡頭 1 m／左移鏡頭 1 m／右移鏡頭 1 m** buttons beside **升高鏡頭 1 m／降低鏡頭 1 m**. Horizontal moves follow current camera yaw on the level plane; all buttons preserve view angle/distance and work without canvas focus, including paused replay. Button focus remains available for repeated Enter activation. Mouse orbit/pan/wheel and focused-canvas arrows, Page Up/Down, Shift+arrows, +/- and Home remain available; **定位飛機** reframes the visible aircraft. The altitude/XYZ instruments still show aircraft coordinates. See [the free-camera guide](FREE_CAMERA.md).

The workspace has 15 active flight lessons and 18 displayed demonstrations: three L00 axes and L01–L15. Choose **L15 正刷鍋** or **L15 正刷鍋示範** for ground takeoff, inward-facing lateral orbit for five complete 360° laps (1,800°), then controlled exit and airborne recovery. The target must remain clearly visible and tracked in front of the nose. After 5/5, fly outward at least 3 m beyond the fifth-lap radius with outward speed at least 0.5 m/s; hovering or merely slowing is not departure. The visible target is 30 m forward of the launch at 10 m above the ground, with a suggested 15 m radius. Its `orbit` ID now uses rule 6; old rule-4 prototype records remain in their original scope. See [the L15 guide](L15_ORBIT.md) and [record compatibility](LEARNING_CONTRACT.md#課程編號與合併相容性).

Every demonstration has its own **示範進度**. Opening one temporarily replaces the live objectives/checkpoints/result presentation; chapter selection pauses at that step’s start. L09–L15 open at 0.5×. L14 has eight stages: ground, takeoff, forward entry, roll inversion, descending half-loop, reversal, upright exit and airborne recovery. The instruments show the measured roll, post-inversion pitch and height lost during the maneuver. Pause and backward seek restore the matching movie state, captions, instruments and steps. L15 has nine observed ground/takeoff/entry/first-through-fifth-lap/recovery stages, with radius, inward heading error, full-lap count and measured orbit angle; L13 retains its own eight-stage spatial-loop demonstration; L11 and L12 retain their separate six-stage directional flip demonstrations.

The user accepted the original combined 前後翻轉 course, the split L11/L12 courses, and L13’s original empty-field version in their recorded delivery contexts. On **2026-10-28**, the user explicitly accepted **Free camera, L13’s 25 m update, and L14 破S with its reference gantry** (`2026.10.27.2` / `67c64f1` context). L01–L14 approvals remain; **L15 正刷鍋 is pending user flight acceptance**. No local storage clear is needed. Reading saved `hover` or `full-flip` selects `takeoff` or `front-flip` without rewriting raw preferences or granting completion. Saved `orbit` still opens L15; old rule-4 scores stay available in their historical context and do not grant current nine-step, five-lap rule-6 completion. Other course records remain unchanged.

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
synchronized L01/L02/L03/L04/L05/L06/L07/L08/L09/L10/L11/L12/L13/L14/L15 demo controls without progress writes, L04/L05/L06/L07/L08/L09/L10/L11/L12/L13/L14/L15 seek/pause
and lesson reload, L02/L03/L04/L05/L06/L07/L08/L09/L10/L11/L12/L13/L14/L15 ground starts, an inline L00 playback exit,
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
