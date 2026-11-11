# Development workflow

## Start locally

Use Node.js 22+ and npm 10+:

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. Phase 8 exposes the Controller Lab handoff, Free Flight screen, four geometric lesson evaluators, fixed-step observer seam, live checkpoints/metrics, field references/path, Mode 2 overlays, and bounded replay. Phase 9 adds terminal-result navigation and an integrated mocked-runtime UI regression. Use Developer keyboard fallback explicitly for a no-hardware smoke check; a calibrated physical controller remains required for RC evidence. The manual owner sequence is tracked in [`VALIDATION.md`](VALIDATION.md).

### Confirm the updated local screen

The current release shows **版本 2026.11.11.1** near the page heading. In **Free / debug**, use the visible **前移鏡頭 1 m／後移鏡頭 1 m／左移鏡頭 1 m／右移鏡頭 1 m** buttons beside **升高鏡頭 1 m／降低鏡頭 1 m**. Horizontal moves follow current camera yaw on the level plane; all buttons preserve view angle/distance and work without canvas focus, including paused replay. Button focus remains available for repeated Enter activation. Mouse orbit/pan/wheel and focused-canvas arrows, Page Up/Down, Shift+arrows, +/- and Home remain available; **定位飛機** reframes the visible aircraft. The altitude/XYZ instruments still show aircraft coordinates. See [the free-camera guide](FREE_CAMERA.md).

The equipment/calibration and flight-tuning interfaces use Traditional Chinese. Open **設備與校正** for **設備與校正** and **先校正遙控器，再開始飛行。**; open **進階調參與舊版紀錄** for **飛行參數調整**. Approved terminology retains **角速度曲線（Actual Rates）** and **曲線彎曲程度（Expo）**, with **中心靈敏度** and **最大角速度**. Local device names, numeric units, calibration records and validation rules retain their original identities. See [the terminology and manual guide](SETUP_CHINESE.md).

Use **全螢幕** at the top right of the LIVE SIM viewport to expand only the current FPV / Chase / Free picture. The lesson sidebar, Mode 2 sidebar, source/camera controls and replay panel remain outside this view; altitude/XYZ, course instruments and compact Arm / Disarm / Reset controls remain available inside. Entering and leaving reuse the same canvas/runtime, including active flight and paused or playing demonstrations. **離開全螢幕** or Esc returns to the workspace. If native fullscreen is unavailable or rejected, the viewport fills the browser window and shows an explanatory notice. Select a course, input source or replay chapter before entering; leave fullscreen to access those panels again. See [the fullscreen guide and manual checklist](VIEWPORT_FULLSCREEN.md).

The workspace has 19 active flight lessons and 22 displayed demonstrations: three L00 axes and L01–L19. Choose **L18 刀旗 S 彎** or **L18 刀旗 S 彎示範** for a grounded takeoff, six ordered forward crossings alternating left/right, forward departure and airborne recovery. It has ten independent steps, solid flags, half-speed chapters, specific frozen interruption facts and a separate `slalom` / rule-6 result scope; no fixed 90° bank, minimum passage speed or stop is required. See [the L18 guide](L18_SLALOM.md). **L19 重力門** accepts downward entry through its horizontal top opening from any approach direction, descent inside to the lower level, then departure through the same side’s lower opening. The learner may brake or turn while descending; no low-level stop or minimum return speed/distance is required. The default example approaches from the front and returns through the front lower opening; guidance follows the recorded approach side. See [the L19 guide](L19_GRAVITY_GATE.md). Choose **L15 正刷鍋** or **L15 正刷鍋示範** for ground takeoff, inward-facing lateral orbit for five complete 360° laps (1,800°), then controlled exit and airborne recovery. The target must remain clearly visible and tracked in front of the nose. After 5/5, fly outward at least 3 m beyond the fifth-lap radius with outward speed at least 0.5 m/s; hovering or merely slowing is not departure. The visible target is 30 m forward of the launch at 10 m above the ground, with a suggested 15 m radius. Its `orbit` ID now uses rule 6; old rule-4 prototype records remain in their original scope. See [the L15 guide](L15_ORBIT.md) and [record compatibility](LEARNING_CONTRACT.md#課程編號與合併相容性).

Mode 2 right-stick pitch now follows the physical transmitter convention in live flight, demonstrations and replay: normalized pitch + (nose-up) is down/back; pitch − (nose-down) is up/forward. This fixes presentation only and does not invert saved controller profiles or change flight inputs/physics. Acro pitch commands angular rate, so holding back keeps rotating the aircraft; centering the stick stops the requested rotation rather than leveling it. See [the L16 control explanation](L16_REVERSE_ORBIT.md#搖桿示範與實際操控).

Every demonstration has its own **示範進度**. Opening one temporarily replaces the live objectives/checkpoints/result presentation; chapter selection pauses at that step’s start. L09–L19 open at 0.5×. L14 has eight stages: ground, takeoff, forward entry, roll inversion, descending half-loop, reversal, upright exit and airborne recovery. The instruments show the measured roll, post-inversion pitch and height lost during the maneuver. Pause and backward seek restore the matching movie state, captions, instruments and steps. L15 has nine observed ground/takeoff/entry/first-through-fifth-lap/recovery stages, with radius, inward heading error, full-lap count and measured orbit angle; L13 retains its own eight-stage spatial-loop demonstration; L11 and L12 retain their separate six-stage directional flip demonstrations.

The user accepted the original combined 前後翻轉 course, the split L11/L12 courses, and L13’s original empty-field version in their recorded delivery contexts. On **2026-10-28**, the user explicitly accepted **Free camera, L13’s 25 m update, and L14 破S with its reference gantry** (`2026.10.27.2` / `67c64f1` context). L01–L15, L17–L19 and free-camera approvals remain. **L19 重力門 passed user flight acceptance on 2026-11-01** in the `2026.11.01.2` / `a477fe2` delivery context; **L16 倒刷鍋 still has human acceptance deferred**, and **L18 and flight-only fullscreen passed user acceptance on 2026-11-11**. No local storage clear is needed. Reading saved `hover` or `full-flip` selects `takeoff` or `front-flip` without rewriting raw preferences or granting completion. Saved `orbit` still opens L15; old rule-4 scores stay available in their historical context and do not grant current nine-step, five-lap rule-6 completion. Other course records remain unchanged.

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
synchronized L01–L19 demonstrations without progress writes, chapter seek/pause
and lesson reload, supported-ground starts and explicit low-throttle Arm, an inline L00 playback exit,
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

Phase 4/5/6/7/8 have automated controller/runtime/camera, tuning, training state/persistence, fixed-step hook, scene-reference, positive/negative maneuver-fixture, replay, and UI integration coverage. The UI integration test uses mocked runtime/renderer seams and is not browser evidence. No physical transmitter was available during implementation, so endpoint, direction, neutral and no-spontaneous-rotation hardware evidence remains outstanding. Browser/WebGL owner smoke is also required; deterministic fixtures and jsdom tests are not human-pilot, GPU-cleanup, or real-flight validation. L08 adds conservative full-drone swept collisions against all four sides of each shared gate frame. L18 adds six solid knife flags and L19 its physical two-level frame. Ground contact remains global; Free Flight and unrelated lessons clear these static obstacle fields, and their other scene references remain visual guides. L09 consumes those same observational samples without adding live input overrides, automatic leveling or a new physics loop. Release-specific executed checks and counts belong in [the learning validation log](LEARNING_VALIDATION.md).

## Source boundaries

Keep high-frequency work outside React render functions. Add pure modules and deterministic tests at the domain boundary first, then connect UI and rendering through snapshots. Update `docs/ARCHITECTURE.md` when a boundary or unit convention changes, and update the README so planned work is not described as implemented.
