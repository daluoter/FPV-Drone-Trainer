# Free Flight integration (Phase 4/6)

Phase 4 connects the completed controller, rates, flight-controller and rigid-body simulation contracts to a direct Three.js presentation. Phase 5 tuning remains a separate UI and Phase 6 training observes the runtime through a fixed-step hook; evaluators and replay remain separate seams and no hardware-realism claim is made.

## Ownership

- `FlightRuntime` owns one `requestAnimationFrame` loop. Each frame polls a fresh selected Gamepad snapshot, processes the handed-off profile, advances `FlightSimulation` through its fixed 240 Hz accumulator, updates the Three.js scene and publishes only a throttled telemetry snapshot to React. The optional `onFixedStep` observer receives one timestamped state/input sample per completed fixed step for training; it cannot run or mutate physics.
- Phase 5 tuning is handed to the runtime as a complete validated simulation configuration. `FlightRuntime.reconfigure` disarms, clears history and replaces the simulation from a safe initial state; it is never a silent in-flight mutation.
- `ControllerLab` and `FlightRuntime` share the application-owned `GamepadPoller`. The Lab subscribes to a throttled presentation view; it does not start a second polling loop in the Phase 4 shell.
- `FlightRenderer` owns the scene, visual quad, ground/grid, takeoff pad, semantic `sceneReferences` (`takeoff-pad`, `hover-zone`, `turn-entry`, `turn-apex`, `turn-exit`, `split-s-reference`, `orbit-poi`), cameras, resize and disposal. It consumes `DroneState` and never edits flight state. Training receives copied reference IDs/positions/dimensions as a read-only contract.

## Scene and cameras

The field uses the documented axes: world/body +X is right, +Y is up and -Z is the nose direction. The quad group receives position and quaternion directly from `DroneState`. A lesson setup may request a spawn position/orientation only through `FlightRuntime.resetForTraining`, which disarms and resets before COUNTDOWN; the ACTIVE fixed-step observer never applies setup changes.

- FPV is rigidly mounted at body-local `(0, 0.08, -0.11)` m, with a 20° local pitch and 90° FOV.
- Chase follows a body-relative rear/above offset and looks at the aircraft.
- Free/debug starts at a safe world-space vantage point and remains independent of the quad pose after initialization.
- `FlightRenderer.resize()` updates all camera aspects and renderer size; `dispose()` releases scene geometries/materials, WebGL resources and context loss hooks.

## Arm and runtime safety

The Controller Lab hands the selected compatible profile to Free Flight. RC arming calls `evaluateFlightArmEligibility` with the current connection session and therefore requires:

1. a connected selected device and compatible profile;
2. direction verification;
3. a timed neutral report bound to the current connection session;
4. finite current processed input; and
5. current roll/pitch/yaw neutral plus throttle `<= 0.05`.

The last condition is an **arm-time handoff only**. Once armed, intended stick movement is passed through normalized RC, Actual Rates, SI rate PID, mixer, motor response and simulation without reapplying the neutral/low-throttle condition. Disconnect, connection-session change, profile/source change, invalid processed input, window blur and hidden documents disarm and require a new explicit Arm action. Reset uses the simulation reset path and remains disarmed.

The developer keyboard fallback is opt-in in the Free Flight source selector. W/S, A/D, Q/E and R/F produce normalized RC values through the same controller/rates/PID path. Blur releases keys. X requests reset; there are no keyboard pose or Euler-angle shortcuts.

## Developer HUD and evidence

The optional HUD shows actual render FPS, actual fixed-step simHz, dropped work, world position/velocity, quaternion, body angular velocity, raw and processed input, target pilot rates, PID outputs, mixer saturation, motor command/target/actual thrust and warnings. Telemetry is for diagnostics, not a hardware or real-flight claim.

Run the four gates from the repository root:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

For a no-hardware browser smoke check, run `npm run dev`, open the printed local URL in a desktop browser, select Developer keyboard fallback explicitly, switch FPV/Chase/Free cameras, toggle the HUD, press Arm, exercise the reset/disarm controls, and check that blur/hidden transitions return to SAFE. A physical transmitter remains required for endpoint, direction, neutral and spontaneous-rotation validation; no real hardware evidence is implied by synthetic tests or browser smoke. Three.js disposal and actual WebGL context/resource release remain browser-only evidence; jsdom contract tests cannot prove GPU cleanup.
