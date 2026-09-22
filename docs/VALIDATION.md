# Phase 9 validation

## Checkpoint status

Automated repository checks and the deterministic integrated UI regression are the completed Phase 9 evidence. Browser/WebGL and physical-transmitter checks below are **REQUIRED — NOT PERFORMED** on this host. The integration regression mocks `FlightRuntime` and `FlightRenderer`; it is useful UI contract evidence, not browser verification.

## Final automated evidence

Run from the repository root:

| Command | Status | Evidence |
| --- | --- | --- |
| `npm test` | PASS | Vitest: 31 files, 136 tests passed across controller, dynamics, runtime, replay, training, shell, and mocked-runtime UI suites. |
| `npm run typecheck` | PASS | Strict TypeScript project check. |
| `npm run lint` | PASS | ESLint with zero warnings allowed. |
| `npm run build` | PASS with advisory | Vite production bundle completed. The entry JavaScript chunk was approximately 915.73 kB minified / 250.06 kB gzip, so Vite emitted its `>500 kB` chunk-size advisory. |
| `git diff --check` | PASS | No whitespace errors in the checkpoint diff. |

The UI regression in `src/app/App.integration.test.tsx` covers a mocked Controller Lab/Free Flight shell through lesson start, explicit arm, fixed-step samples, success and failure results, one-time result persistence, direct lesson selection, retry, reset, replay enter/play/exit, and settings isolation. It does not exercise a real browser, WebGL context, Gamepad API, transmitter, or human flight.

## Owner browser and hardware sequence

Every item in this section is **REQUIRED — NOT PERFORMED** until an owner runs it in a supported desktop browser and records the result. Keep the browser console open for the entire sequence; record unexpected errors/warnings with the browser, OS, GPU, and controller details.

### Startup and console

- [ ] **REQUIRED — NOT PERFORMED:** From a clean checkout run `npm install`, then `npm run dev`; open the printed localhost URL in desktop Chrome or Edge over the intended secure/local context.
- [ ] **REQUIRED — NOT PERFORMED:** Confirm the page loads without uncaught console errors, inspect the Free Flight canvas/HUD, and note any WebGL warnings or context-loss messages.
- [ ] **REQUIRED — NOT PERFORMED:** After `npm run build`, optionally run `npm run preview` and repeat the console/page-load check against the production bundle.

### Controller Lab and neutral gate

- [ ] **REQUIRED — NOT PERFORMED:** Connect the physical transmitter, confirm Gamepad API support, select the intended device, and record its ID, index, mapping, axis count, button count, and connection session behavior.
- [ ] **REQUIRED — NOT PERFORMED:** Capture center samples hands-off; calibrate Roll, Pitch, Yaw, and single-ended Throttle by moving one control at a time; verify no duplicate/ambiguous axes and inspect Raw → Calibrated → Normalized → Deadband → Filtered → Final values.
- [ ] **REQUIRED — NOT PERFORMED:** Verify direction/inversion one channel at a time, run the three-second neutral test, confirm the documented 0.02 normalized-output bound, and record the per-channel report.
- [ ] **REQUIRED — NOT PERFORMED:** Reload and reconnect; confirm calibration compatibility is checked and a fresh connection-bound neutral test is required. Disconnect during capture and confirm approval is not granted.

### Free Flight arm and runtime safety

- [ ] **REQUIRED — NOT PERFORMED:** Confirm the Controller Lab profile handoff reaches Free Flight only after the current safety gate passes. Without hardware, explicitly choose **Developer keyboard fallback**; this is only a browser smoke path, not hardware evidence.
- [ ] **REQUIRED — NOT PERFORMED:** Verify FPV, Chase, and Free/debug cameras, HUD toggle, raw/processed telemetry, motor diagnostics, reset, disarm, blur/hidden-document, disconnect, and input-source safety boundaries.
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
- This host did not perform Chromium/WebGL smoke because Chromium is unavailable and `libnspr4.so` is missing. Browser console, WebGL disposal/context loss, Gamepad API, physical transmitter, and spontaneous-rotation evidence remain owner work.
- `npm run build` passes while emitting the Vite bundle-size advisory for the approximately 915.73 kB minified entry chunk (>500 kB; approximately 250.06 kB gzip). The advisory is recorded, not silently treated as a browser failure.
