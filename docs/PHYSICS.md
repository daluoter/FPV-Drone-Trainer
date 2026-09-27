# Phase 2 physics model

The Phase 2 core is a deterministic, dependency-light rigid-body model for a simplified 5-inch freestyle quad. It is intended to make controller and sign bugs measurable. It is **not** a claim of laboratory-grade aerodynamics, Betaflight firmware equivalence, or hardware realism.

## State and integration

The state contains world position and velocity, a body-to-world quaternion, body-frame angular velocity, and four motor states. The quaternion is authoritative and normalized after every step. Angular velocity uses the constant-body-rate exponential quaternion increment:

```text
q_next = normalize(q * quaternion(axis = omega_body, angle = |omega_body| * dt))
```

The fixed simulation timestep defaults to 240 Hz. A render-frame accumulator bounds catch-up work and reports dropped steps; render FPS therefore does not choose the physics timestep. An invalid render delta resets the accumulator; any already buffered sub-step is discarded and reported in `droppedSeconds` (while `droppedSteps` remains zero because no complete fixed step was buffered).

Linear motion uses semi-implicit Euler:

```text
v_next = v + (F_world / mass) * dt
p_next = p + v_next * dt
```

Body thrust and body drag are rotated into world coordinates. Gravity is continuously applied in world -Y. Body angular dynamics use Euler’s rigid-body equation with diagonal inertia:

```text
I * omega_dot = torque - omega x (I * omega)
omega_next = omega + omega_dot * dt
```

Angular drag is a configurable body-axis damping torque. The model intentionally omits propwash, blade-element aerodynamics, battery sag and ground effect. Ground contact uses a small finite-size support model described below; it is not a general-purpose rigid-body engine.

## Motors and forces

Each motor has an independent normalized command, target thrust and actual thrust. Actual thrust follows an exact first-order response for each constant timestep:

```text
T_next = T + (T_target - T) * (1 - exp(-dt / responseTimeConstant))
```

Force is the sum of motor thrust along body +Y. Arm torque is calculated as `r x F`; yaw is the propeller reaction torque derived from spin direction and a configured torque/thrust coefficient. Yaw is never faked by directly editing orientation.

## Quad-X allocation

The mixer adds pilot-positive roll/pitch/yaw differentials to collective in the documented motor order. If the requested output exceeds [0, 1], the allocation preserves the requested differential range by affine rescaling or shifting all four motors together, and reports saturation. It does not independently clip one motor and hide the resulting sign error.

## Ground contact and safety

The ground is a plane at the configured `ground.heightM`. `src/drone/geometry.ts` is the shared source for the visual body/arms/motors/props, FPV mount and contact features. At each near-ground step the solver rotates those finite support points into world space and moves the COM only enough to keep the lowest feature 1 mm above the plane. The feature set includes body/nose/arm bounds, motor hubs, a 16-point propeller perimeter with a small conservative radius margin, and an 8 cm half-extent envelope around the rigid FPV mount. That camera envelope contains the supported maximum 120° FOV near plane at the renderer's 1 cm near distance for viewport aspects up to 4:1; mount-angle tuning does not change its bound. New/reset poses, including training spawns, are raised to the same support height, so nonzero ground levels and initially tilted bodies use the same geometry.

This is a deliberately small ground-contact model, not a general-purpose rigid-body engine. A 2 mm contact slop keeps resting contact stable. Gentle downward contact uses the configured normal restitution and tangential retention; impacts below 0.5 m/s settle, and grounded angular rates receive 8 s⁻¹ contact damping. A downward contact-point normal speed of 4 m/s or faster, or a supported body tilt of 50° or more, latches a crash. The solver first resolves the pose to its supported contact height, then zeros linear/angular velocity and all motor command/target/actual thrust. The crashed pose remains fixed while simulation time advances; no automatic reset, teleport, or re-arm occurs. Runtime/training report the crash as disarmed/failure, and only explicit Reset clears the latch. Upright gentle landing and subsequent thrust takeoff remain possible; airborne Acro, including inverted flight, is not constrained by this ground model. These thresholds and geometry are transparent trainer assumptions, not damage estimates or claims of full airframe realism.

Invalid configuration, timestep, command, non-finite state, negative simulation time, excessive speed or distance causes a safe reset to the validated spawn state and returns a warning. The fixed-step accumulator also reports invalid frame deltas and dropped catch-up steps. Warnings are surfaced to callers for developer HUDs; numerical failure is never silently propagated.

## Configuration assumptions

The default config uses a 0.65 kg quad, 0.17 m motor radius, diagonal inertia `(0.0025, 0.0045, 0.0025) kg m²`, 5 N maximum thrust per motor, 30 ms motor response, configurable linear/angular drag and a 9.80665 m/s² gravity constant. These are transparent starting assumptions for tuning, not universal defaults.
