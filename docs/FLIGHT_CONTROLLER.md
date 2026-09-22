# Phase 3 flight controller

Phase 3 adds a pure, deterministic angular-rate control path. It is a trainer
control model and tuning starting point, not a claim of Betaflight firmware
identity, hardware behavior, or aerodynamic realism.

## Data path and units

```text
processed normalized RC
  -> Actual Rates (deg/s)
  -> configured rate limit (optional)
  -> explicit deg/s -> rad/s conversion
  -> pilot-positive target rates
  -> body target rates (pitch, -yaw, -roll)
  -> body-rate PID torque (N m)
  -> pilot-positive normalized corrections
  -> existing Quad-X mixer
  -> independent motor lag
  -> existing SI rigid-body simulation
```

The simulation owns body angular velocity in rad/s, torque in N m and motor
thrust in N. The pilot convention is documented in
[`COORDINATE_SYSTEM.md`](COORDINATE_SYSTEM.md):

```text
omegaBody = (pitch, -yaw, -roll)
```

The inverse mapping is used to compare measured body rates to pilot-positive
setpoints. Torque uses the same explicit signs before passing corrections to
the existing mixer. Acro/rate control has no attitude or Euler-angle error
term; releasing a stick requests zero angular rate and therefore does not
self-level the accumulated attitude.

## PID and saturation

`RatePidAxisController` is a stateful per-axis module. Its gains are SI:

- `kp`: N m / (rad/s)
- `ki`: N m / rad
- `kd`: N m / (rad/s²)
- `integralLimit`: (rad/s) seconds
- `outputLimitNm`: N m

The default derivative is on measurement, so a setpoint step does not create a
derivative kick. A first-order derivative filter is optional. Output is
symmetrically bounded. Conditional integration holds an integral that would
push farther into an output limit while allowing recovery toward the linear
range. Invalid targets, measurements, configuration or timestep reset the
axis and return a zero output; they never retain the previous command.

The default gain values are deliberately transparent simplified-dynamics
starting assumptions:

| Pilot axis | kp | ki | kd | output limit |
| --- | ---: | ---: | ---: | ---: |
| roll | 0.035 | 0.12 | 0.0008 | 0.25 N m |
| pitch | 0.035 | 0.12 | 0.0008 | 0.25 N m |
| yaw | 0.018 | 0.06 | 0.0004 | 0.06 N m |

They are not measured hardware values and should not be presented as a
realism claim. Independent settings are validated before use.

## Runtime and safety

`FlightSimulation` owns a fixed-step accumulator and calls the rate controller
once per simulation step before `DroneSimulation.step`. Render FPS therefore
does not choose the controller or motor timestep. `arm`, `disarm` and `reset`
are explicit APIs; the Phase 4 `FlightRuntime` owns the requestAnimationFrame
sample/sim/render loop and starts disarmed. Its RC arm handoff calls the
Controller Lab safety gate with the current connection session plus current
neutral/low-throttle checks. Those position checks run only at arm time;
intended stick movement is not rejected after arming. Disarm clears PID history
and emits zero motor commands while the existing motor model applies its
independent lag. Invalid RC input, render delta, controller timestep,
simulation state or controller result disarms/reset-safely rather than
propagating stale commands. Device disconnect/session/profile/source changes,
blur and hidden documents also require explicit rearm.

Telemetry includes target and measured body rates, body-rate error, per-axis
PID terms/integrals/output, pilot corrections, mixer saturation, each motor's
command/target thrust/actual thrust, and warnings. `advanceProcessed` is the
handoff for the controller domain's calibrated `ProcessedControllerState`.

Tests cover all axis signs, finite validation, derivative behavior, bounded
integral behavior, quantitative rate response, Acro release, calibrated
neutral through the complete pipeline, hover symmetry and fixed-step render
rate equivalence. Automated evidence remains synthetic; no hardware or real
flight claim is implied.
