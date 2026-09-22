# Replay and ghost contract

Phase 8 keeps one bounded, in-memory recording of the most recent armed
flight. `FlightReplayRecorder` receives the runtime's completed fixed-step
samples, keeps compact pose/input/controller-output fields, and stores one
sample per configured decimation interval in a fixed-capacity ring. The
current defaults are 2,400 retained samples and a decimation factor of four
(approximately 40 seconds at the 240 Hz runtime). Capacity and decimation are
bounded in code; replay is never written to localStorage and there is no
backend.

## Ghost-compatible data path

```text
actual fixed-step FlightRuntimeFixedStepSample
  -> bounded decimated ReplaySample
  -> immutable ReplayRecording snapshot
  -> ReplayPlayback clock
  -> interpolated ReplayGhostState
  -> renderer ghost + replay trajectory
```

A `ReplaySample` contains a timestamp, position, normalized quaternion,
velocity, body angular velocity, normalized RC input, and compact controller
output (target rates, torque, pilot corrections, motor commands and saturation).
It is deliberately not a `DroneState`: motors, warnings, PID internals and
other high-frequency state remain out of the replay ring. Recorded objects and
snapshots are frozen; the recorder only copies fields when a sample is kept,
not on every 240 Hz step.

Position and vector telemetry interpolate linearly. Quaternion interpolation
uses the shortest path and first resolves the `q`/`-q` antipodal
representation. Playback time is relative to the first retained timestamp;
source timestamps remain intact in the ghost state. The clock supports play,
pause, seek, and 0.25x / 0.5x / 1x / 2x speeds. The renderer owns a separate
orange ghost object and path, so FPV/chase camera presentation can follow the
ghost without applying a replay pose to the live simulation state.

## Safety boundaries and limitations

- Entering replay explicitly disarms live flight. The arm action is rejected
  while playback is active.
- An active training attempt is aborted (or a countdown is reset) at the replay
  boundary. Playback never calls the runtime fixed-step callback, so ghost
  samples cannot enter evaluators or training progress.
- Exiting replay clears the ghost presentation and resets live simulation time,
  controller memory and input history while disarmed. Live flight therefore
  requires an explicit re-arm and starts a fresh timestamp boundary.
- The retained recording is replaced when a new live flight is armed. It is
  not durable across reloads, tabs, or sessions.
- Replay is visual/diagnostic evidence, not a deterministic continuation of
  physics. It does not restore PID integrals, collisions, motor lag, input
  device identity, or a complete 240 Hz history. Decimation and ring eviction
  can remove fine details and older portions of a long flight.
- Automated tests cover recorder bounds, immutable samples, timing rejection,
  interpolation, runtime playback isolation and arm/training boundaries.
  They do not prove WebGL context behavior, transmitter safety, or human-flight
  fidelity.
