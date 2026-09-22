# Architecture

## Current scope

Phase 4 implements the controller boundary, canonical Actual Rates, a modular SI angular-rate PID loop, deterministic controller-to-simulation runtime and the Free Flight presentation seam. The application-owned poller is sampled by the runtime's requestAnimationFrame owner; React receives throttled telemetry only. The direct Three.js scene contains ground/grid, a takeoff pad, simple references and a quad, with rigid FPV, chase and free/debug cameras. The explicit RC arm handoff consumes the Controller Lab's verified profile/session and checks current neutral/low throttle only at arm time. Developer keyboard input is opt-in and follows the same normalized RC/rates/PID path. Training, tuning, replay and lessons remain separate phases.

The phase contract is tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md). Each later phase must preserve the boundaries below and pass the phase gate before the next seam is started.

## Runtime boundaries

```text
React application shell / UI
  menus, configuration, lesson screens, HUD, results
                         │ commands + snapshots
                         ▼
Controller domain ──> Flight-control domain ──> Simulation domain
  Gamepad polling       rates + rate PID           state + forces + motors
  calibration           mixer commands             fixed-step integration
  signal diagnostics                                quaternion orientation
                         │ immutable state snapshots
                         ▼
                 Three.js rendering domain
                 scene, cameras, visual geometry

Training domain consumes state snapshots and trajectories.
Replay domain records bounded snapshots independently of player physics.
Config domain persists versioned settings and controller profiles locally.
```

### Ownership rules

- **React/UI** owns presentation and low-frequency application state. It must not contain flight physics or direct controller-to-object rotation.
- **Controller** owns fresh Gamepad snapshots, device selection, calibration, normalization, inversion, deadband, filtering, profile compatibility, disconnect handling and safety status. `GamepadPoller` runs outside React; the Controller Lab subscribes only to a throttled presentation view. It must not know about Three.js.
- **Rates and flight controller** convert normalized channels into desired angular rates and motor corrections. The Phase 3 runtime owns per-axis SI rate PID state, antiwindup, bounded outputs, explicit pilot/body signs and telemetry. Acro mode never self-levels when the roll or pitch stick is released.
- **Simulation** owns the authoritative SI-unit state: position, velocity, quaternion orientation, angular velocity, mass, inertia, forces, torques, motor response, ground contact and fixed-step integration. The Phase 3 runtime feeds bounded mixer commands into that owner, has no React or renderer dependency and reports dropped steps, controller telemetry and safe-reset warnings.
- **Renderer** consumes simulation snapshots and owns Three.js objects, cameras, and visual environment. `FlightRenderer` handles resize/disposal and does not perform calibration or flight dynamics.
- **Training** evaluates state, geometry, trajectory, and timing windows. A stick sequence alone cannot pass a lesson.
- **Replay** stores compact immutable samples and can later drive a ghost or analysis view without mutating the player simulation.

## Data contracts

The intended flight data path is:

```text
raw Gamepad
  -> calibration profile
  -> normalized channels
  -> deadband / filter
  -> Actual Rates (target angular rates)
  -> angular-rate controller (target torque)
  -> Quad-X mixer
  -> motor response
  -> thrust and reaction torque
  -> rigid-body integration
  -> immutable DroneState snapshot
  -> renderer / HUD / training / replay
```

The signal path is deliberately explicit so neutral drift, sign errors, saturation, and invalid numerical state can be inspected at each boundary. Every internal physics value will use SI units: metres, seconds, kilograms, Newtons, Newton-metres, radians, and radians per second. UI degree-per-second values are converted at the rates boundary.

## Simulation loop contract

The simulation will run at a configurable fixed timestep (initial target: 240 Hz) using an accumulator. Render FPS and React render frequency must not determine physics integration. The browser input sampler will publish the latest controller snapshot; the fixed-step loop will consume that snapshot at each simulation step.

The authoritative orientation will be a normalized quaternion. Euler angles may be derived for display only. Gravity, body-frame thrust, aerodynamic drag, angular damping, motor response, and collision responses will be represented as forces and torques rather than direct position or Euler-angle edits.

Invalid timestep, non-finite state, invalid mass, or an unusable quaternion is a simulation warning and a safe reset condition—not a value to silently propagate.

## Safety boundary

Normal flight is unavailable until the controller contract can prove:

- one valid, compatible device is selected;
- roll, pitch, yaw, and throttle mappings are present and intentionally distinct;
- calibrated endpoint ranges are valid;
- centered roll, pitch, and yaw are stable after processing; and
- all processed values are finite.

The Controller Lab evaluates this boundary, displays each failure reason and deliberately leaves flight unavailable in Phase 1. Future flight phases must consume this gate rather than bypassing it.

## Testing strategy

Pure controller transforms, calibration statistics, profile compatibility, poller disconnect behavior and the safety gate are tested with deterministic inputs. Phase 2 adds coordinate/quaternion, configuration validation, motor lag, mixer signs and saturation, `r × F` moments, gravity, hover sanity, attitude-transformed thrust, safety reset and fixed-step render-rate equivalence tests. Phase 3 adds pilot/body sign conversion, bounded rate PID response and antiwindup, derivative-on-measurement, invalid-input reset, complete calibrated-neutral integration, Acro release, hover and frame-rate equivalence telemetry tests. Phase 4 adds camera transform contracts, runtime arm/disarm transitions, disconnect/session/invalid-input handling, source/profile changes and focus safety. UI tests cover application state and accessibility-facing behavior. Browser smoke tests and real transmitter checks remain separate evidence; passing unit tests never claims hardware validation or aerodynamic realism.
