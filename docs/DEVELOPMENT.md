# Development workflow

## Start locally

Use Node.js 22+ and npm 10+:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. Phase 8 exposes the Controller Lab handoff, Free Flight screen, four geometric lesson evaluators, fixed-step observer seam, live checkpoints/metrics, field references/path, Mode 2 overlays, and bounded replay. Phase 9 adds terminal-result navigation and an integrated mocked-runtime UI regression. Use Developer keyboard fallback explicitly for a no-hardware smoke check; a calibrated physical controller remains required for RC evidence. The manual owner sequence is tracked in [`VALIDATION.md`](VALIDATION.md).

### Confirm the updated local screen

The current classroom shows **版本 2026.10.24.2** near the page heading. Select **L10 完整橫滾 Roll** and open its dedicated full-roll demonstration; the L00 Roll button remains the short axis-introduction example. There are 12 active flight lessons and 13 demonstrations, covering three L00 axes and L01–L10. See [the L10 guide](L10_FULL_ROLL.md), [the L01 guide](L01_TAKEOFF_HOVER.md) and [the numbering table](LEARNING_CONTRACT.md#課程編號與合併相容性).

Every existing demonstration has an independent **示範進度** view with its own current step and checkmarks. While a demo is open, this view replaces the learner's live objectives, checkpoints and result view; the learner's session remains unchanged. Clicking a chapter pauses at that step's start; press Play to watch it. For L09, try step 5「產生小幅下沉」and step 7「建立前進或側移」. L09 and L10 start at 0.5×. L09 leaves time to read the next action and observe the actual deviation before correction; L10 separates preparation, inversion, completion of the roll and airborne recovery. Every chapter remains synchronized with the recorded ghost and its actual observed progress.

The user has accepted basic recovery from `2026.10.23.6` / `b30806e`, called L10 at that time and now L09, and the merge/navigation/record-preservation work from `2026.10.24.1` / `d518897`. Earlier acceptance is retained under each stable lesson ID. The user has also accepted L10 Roll in the `2026.10.24.2` / `f1c8745` delivery context. No local storage clear is needed: a saved `hover` selection opens L01, old Hover results remain historical, and other results keep their existing IDs and rule scopes. The earlier L01 merge changed navigation and teaching labels while retaining its flight criteria. New L10 adds its own evaluator without changing the physics. L09 continues to use rules 6, with about 4 m recommended height; see [its guide](L09_BASIC_RECOVERY.md).

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
synchronized L01/L02/L03/L04/L05/L06/L07/L08/L09/L10 demo controls without progress writes, L04/L05/L06/L07/L08/L09/L10 seek/pause
and lesson reload, L02/L03/L04/L05/L06/L07/L08/L09/L10 ground starts, an inline L00 playback exit,
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
