# Architecture

## Current scope

Phase 1 implements the controller boundary and Controller Lab on top of the Phase 0 foundation. The React shell remains intentionally non-flight: browser Gamepad polling, calibration, profile compatibility, signal diagnostics, disconnect handling and neutral safety evaluation exist, but no Three.js scene, rates, physics, flight controller or lesson logic is enabled. Keeping flight absent is preferable to presenting an untrusted input path as flight-ready.

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
- **Rates and flight controller** convert normalized channels into desired angular rates and motor corrections. Acro mode never self-levels when the roll or pitch stick is released.
- **Simulation** owns the authoritative SI-unit state: position, velocity, quaternion orientation, angular velocity, mass, inertia, forces, torques, motor response, and fixed-step integration.
- **Renderer** consumes simulation snapshots and owns Three.js objects, cameras, and visual environment. It does not perform calibration or flight dynamics.
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

Pure controller transforms, calibration statistics, profile compatibility, poller disconnect behavior and the safety gate are tested with deterministic inputs. Later phases will add rates, mixer, quaternion, fixed-step and lesson tests. UI tests cover application state and accessibility-facing behavior. Browser smoke tests and real transmitter checks remain separate evidence; passing unit tests never claims hardware validation.
