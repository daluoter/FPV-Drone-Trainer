# Phase 9 validation

## Checkpoint status

Automated repository checks, the deterministic integrated UI regression, and the local browser/WebGL smoke below are the completed software evidence. Physical-transmitter checks remain **REQUIRED — NOT PERFORMED**. The integration regression mocks `FlightRuntime` and `FlightRenderer`; it is useful UI contract evidence, not browser verification.

## Final automated evidence

Run from the repository root:

| Command | Status | Evidence |
| --- | --- | --- |
| `npm test` | PASS | Vitest: 32 files, 140 tests passed across controller, dynamics, rendering lifecycle, runtime, replay, training, shell, and mocked-runtime UI suites. |
| `npm run typecheck` | PASS | Strict TypeScript project check. |
| `npm run lint` | PASS | ESLint with zero warnings allowed. |
| `npm run build` | PASS with advisory | Vite production bundle completed. The entry JavaScript chunk was approximately 919.75 kB minified / 251.19 kB gzip, so Vite emitted its `>500 kB` chunk-size advisory. |
| `git diff --check` | PASS | No whitespace errors in the checkpoint diff. |

The UI regression in `src/app/App.integration.test.tsx` covers a mocked Controller Lab/Free Flight shell through lesson start, explicit arm, fixed-step samples, success and failure results, one-time result persistence, direct lesson selection, retry, reset, replay enter/play/exit, and settings isolation. It does not exercise a real browser, WebGL context, Gamepad API, transmitter, or human flight.

## Local browser/WebGL smoke evidence

Completed against both the Vite dev server and a Vite production preview with the user-local Playwright Chromium 1243 binary at `/home/oliver/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`. The missing browser dependency was supplied only through `LD_LIBRARY_PATH=/home/oliver/.cache/huang-playwright-libs/extracted/usr/lib/x86_64-linux-gnu`; no privileged/system-wide changes were made.

The Playwright sequence verified:

- StrictMode initial mount produced a visible FPV scene (`946 × 430` canvas, WebGL2 context) with no initial `WebGLRenderer` initialization/context-loss error.
- Developer keyboard fallback armed and showed `ARMED / SIMULATION RUNNING`; FPV, Chase, and Free/debug all rendered, and Apply + reset kept the canvas available.
- A recorded keyboard flight entered and played replay, then exited safely.
- Dispatching `webglcontextlost` showed the visible `3D viewport unavailable` error, disarmed the runtime, disabled Arm, and exposed `Retry rendering`; retry replaced the canvas and restored WebGL2 rendering.
- Initial browser console capture had no page errors or renderer initialization errors. Headless Chromium emitted only SwiftShader performance warnings containing `GL Driver Message ... GPU stall due to ReadPixels`; these are browser screenshot/readback diagnostics, not app errors. The evidence screenshots were `/tmp/fpv-fixed-initial.png` and `/tmp/fpv-fixed-recovered.png` during validation.

This is local headless-browser/WebGL evidence, not proof across physical GPUs or browsers. Hardware transmitter, human-pilot behavior, and long-running resource pressure still require owner validation.

## White viewport root cause

The original blank canvas was reproduced and traced, not inferred: React StrictMode ran the Free Flight effect cleanup and setup against the same canvas; `FlightRenderer.dispose()` called `forceContextLoss()`, then the second `THREE.WebGLRenderer` creation failed because that canvas already had a lost WebGL2 context. The renderer caught that failure and returned `null`, so the fixed-step runtime continued publishing FPS/armed HUD telemetry while no frame could be drawn. CSS sizing and the FPV/chase/free camera clipping were not the cause; after removing forced context loss, the same canvas rendered the field through StrictMode and remount/retry paths. Initialization now throws to an explicit UI boundary, and context loss disarms/blocks Arm instead of allowing invisible flight.

## Owner browser and hardware sequence

Items marked completed below are local software smoke evidence. Remaining owner items are **REQUIRED — NOT PERFORMED** until run in a supported desktop browser and recorded with browser, OS, GPU, and controller details. Keep the browser console open for the entire sequence and record unexpected errors/warnings.

### Startup and console

- [x] **COMPLETED — local headless Chromium:** `npm run dev` was exercised against the user-local Playwright Chromium binary; the initial Free Flight canvas rendered with WebGL2 and no renderer initialization/page errors. Headless SwiftShader emitted only the documented performance warnings.
- [ ] **REQUIRED — OWNER CONFIRMATION:** Repeat startup and console checks in supported desktop Chrome or Edge on the target GPU/OS, recording any browser-specific WebGL warnings or context-loss messages.
- [x] **COMPLETED — local headless Chromium:** After `npm run build`, `npm run preview -- --host 127.0.0.1 --port 5180` loaded with a `946 × 430` WebGL2 canvas and no renderer initialization/page errors.
- [ ] **REQUIRED — OWNER CONFIRMATION:** Repeat the production-preview check in supported desktop Chrome or Edge on the target GPU/OS.

### Controller Lab and neutral gate

- [ ] **REQUIRED — NOT PERFORMED:** Connect the physical transmitter, confirm Gamepad API support, select the intended device, and record its ID, index, mapping, axis count, button count, and connection session behavior.
- [ ] **REQUIRED — NOT PERFORMED:** Capture center samples hands-off; calibrate Roll, Pitch, Yaw, and single-ended Throttle by moving one control at a time; verify no duplicate/ambiguous axes and inspect Raw → Calibrated → Normalized → Deadband → Filtered → Final values.
- [ ] **REQUIRED — NOT PERFORMED:** Verify direction/inversion one channel at a time, run the three-second neutral test, confirm the documented 0.02 normalized-output bound, and record the per-channel report.
- [ ] **REQUIRED — NOT PERFORMED:** Reload and reconnect; confirm calibration compatibility is checked and a fresh connection-bound neutral test is required. Disconnect during capture and confirm approval is not granted.

### Free Flight arm and runtime safety

- [ ] **REQUIRED — NOT PERFORMED:** Confirm the Controller Lab profile handoff reaches Free Flight only after the current safety gate passes. Without hardware, explicitly choose **Developer keyboard fallback**; this is only a browser smoke path, not hardware evidence.
- [x] **COMPLETED — local headless Chromium:** FPV, Chase, and Free/debug cameras, developer keyboard arm/disarm, settings reset, replay, induced context-loss disarm/Arm blocking, visible retry, and canvas replacement recovery were exercised. HUD/raw hardware telemetry and browser focus/disconnect paths remain owner checks.
- [ ] **REQUIRED — NOT PERFORMED:** With neutral sticks and low throttle, arm only through the explicit gate; move one physical control at a time after arming and stop immediately for unexplained command or rotation.

### Four lessons and result isolation

For each lesson — **Hover**, **Coordinated Turn**, **Split-S**, and **Orbit / 刷鍋**:

- [ ] **REQUIRED — NOT PERFORMED:** Start the countdown/reset while disarmed, apply the displayed setup, arm explicitly after the countdown, and observe fixed-step samples, checkpoints, metrics, references, and path.
- [ ] **REQUIRED — NOT PERFORMED:** Exercise a genuine positive attempt and a safe failure/disarm path; confirm both terminate at the `RESULT` screen, persist one attempt, and do not accept stale samples afterward.
- [ ] **REQUIRED — NOT PERFORMED:** From `RESULT`, select another available lesson directly; then verify Retry creates a fresh setup/session and Reset clears the current attempt without carrying trajectory, checkpoints, arm state, or result across lessons.
- [ ] **REQUIRED — NOT PERFORMED:** Confirm the browser console remains free of new lesson/runtime errors and record whether the maneuver is human-pilot evidence (not fixture evidence).

### Replay and settings isolation

- [ ] **REQUIRED — NOT PERFORMED:** Create a real armed flight with enough samples, disarm, enter replay, and exercise Play/Pause, timeline seek, 0.25×/0.5×/1×/2× speeds, trajectory/ghost presentation, and Exit playback.
- [ ] **REQUIRED — NOT PERFORMED:** While replay is active, verify live Arm is blocked, live fixed-step training callbacks do not advance, and an active lesson is safely aborted or a countdown is reset at the boundary. Exit must reset live time/input memory and require explicit rearm.
- [ ] **REQUIRED — NOT PERFORMED:** Change bounded tuning values and use Apply + reset/Reset defaults only while disarmed and outside an active lesson; verify active/countdown controls are disabled, replay does not mutate live flight, persistence survives reload, and the runtime resumes through an explicit reset boundary.
- [ ] **REQUIRED — NOT PERFORMED:** Check the console for WebGL/resource-disposal warnings after navigating/reloading; jsdom and the mocked renderer cannot prove GPU cleanup or context-loss behavior.

## Known limitations to carry into the owner report

- The simulation resolves **ground contact only**. The takeoff pad, gates, orbit tower, and other scene objects are visual references; there is no obstacle collision model.
- Dynamics, tuning values, and training maneuver thresholds are provisional browser-trainer assumptions. They are not measured hardware tuning and do not establish realism, flight-worthiness, transmitter compatibility, or human-pilot skill.
- Replay is bounded, decimated, in-memory, and presentation-only; it is not a persisted or full-physics continuation and does not replace flight evidence.
- Local headless Chromium/WebGL smoke was completed with a user-local extracted `libnspr4.so`; physical-browser/GPU variance, WebGL disposal under long-running navigation, Gamepad API, physical transmitter, and spontaneous-rotation evidence remain owner work.
- `npm run build` passes while emitting the Vite bundle-size advisory for the approximately 919.75 kB minified entry chunk (>500 kB; approximately 251.19 kB gzip). The advisory is recorded, not silently treated as a browser failure.
