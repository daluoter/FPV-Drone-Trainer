# Implementation plan and ownership

Initial inspection: main at 35c66d2 contained only README.md and MIT LICENSE. Phase 0 foundation completed in 49ca30d; Phase 1 Controller Lab completed in a70e907 plus safety fixes; Phase 2 deterministic dynamics and Phase 3 flight-controller integration are complete in this checkpoint.

## Current checkpoint

Phase 7 lessons are complete in this checkpoint. It consumes the Phase 6 controller/simulation contracts through one fixed-step runtime sample hook, adds armed/disarmed telemetry safety, pure incremental evaluators for Hover, Coordinated Turn, Split-S, and Orbit / 刷鍋, positive/negative deterministic fixtures, visible reference geometry/path, live metrics/results/retry, and current progress persistence. Straight-line, box-pattern, and figure-eight replacements are intentionally not included. Browser smoke, WebGL disposal, physical transmitter evidence, and human maneuver evidence remain separate from automated gates.

## Architecture decisions

- Vite, strict TypeScript, React application shell, direct Three.js renderer, Vitest and ESLint.
- Pure controller processing and calibration; no hardware assumptions. Poll fresh Gamepad snapshots outside React. Reject incompatible profiles, duplicate mappings, invalid endpoints and unstable neutral. Disconnect, blur and invalid input disarm.
- Pure SI-unit simulation state with quaternion orientation; fixed 240 Hz accumulator independent of React and render FPS.
- Pipeline: device -> calibration -> normalization -> deadband/filter -> Actual Rates -> SI angular-rate PID -> Quad-X allocation -> motor response -> force/torque -> rigid body -> renderer.
- Coordinate and mixer signs documented and tested before flight integration. Canonical Betaflight sources must support Actual Rates implementation.
- Renderer owns presentation only. Training consumes state and trajectory, never directly moves the player. Replay snapshots are independent of player dynamics.
- Local versioned storage only. No backend, accounts, multiplayer or decorative scope.

## Serial implementation lanes

This is multi-seam work. Exclusive ownership passes serially in /workspaces/FPV-Drone-Trainer on main; no concurrent writers. Each phase produces a validated commit and durable handoff before its dependent phase begins. Integration owners consume completed component contracts rather than reimplementing them.

| Phase / owner seam | Files or contract | Gate / handoff |
| --- | --- | --- |
| 0 Foundation (complete) | package/config, shell, architecture docs | startup, test, typecheck, lint, build; commit 49ca30d |
| 1 Controller (complete) | src/controller, Controller Lab UI, controller docs/tests | synthetic device calibration and neutral regression; commits a70e907, f8771a8, 8b2188b |
| 2 Dynamics (complete) | src/simulation, src/drone, math and coordinate/physics docs/tests | gravity, thrust, torque signs, quaternion, timestep; commit f8f9f7b |
| 3 Flight controller | src/rates, src/flight-controller, pipeline integration | canonical rates, SI rate PID/antiwindup, fixed-step neutral and hover integration; commit |
| 4 Free-flight integration | src/rendering, runtime and flight UI | safe arm, cameras, telemetry, browser smoke; complete |
| 5 Tuning | src/tuning, settings UI, validated configuration/persistence and runtime boundary | bounded settings, defaults, persistence rejection, reset safety and documentation; complete |
| 6 Training framework | src/training contracts/state machine, menu/results/sticks, fixed-step sample hook and scene reference IDs | state transitions, progress, reset/session isolation and truthful unavailable lessons; complete in this checkpoint |
| 7 Lessons | four geometric lesson evaluators, armed telemetry safety, fixtures, and reference/path presentation | positive/negative maneuver traces; complete in this checkpoint |
| 8 Replay | src/replay and playback/path integration | bounded recorder, immutable snapshots/playback; commit |
| 9 Verification/polish | integration fixes, accessibility and truthful docs | independent review, all commands, browser checks; commit |

All phases run npm test, npm run typecheck, npm run lint, npm run build. Never commit a knowingly broken build. Preserve LICENSE and history. Browser/hardware limitations must remain explicit; synthetic tests are not transmitter validation. If blocked, checkpoint coherently rather than claiming completion.
