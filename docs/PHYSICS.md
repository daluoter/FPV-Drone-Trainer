# Phase 2 physics model

The Phase 2 core is a deterministic, dependency-light rigid-body model for a simplified 5-inch freestyle quad. It is intended to make controller and sign bugs measurable. It is **not** a claim of laboratory-grade aerodynamics, Betaflight firmware equivalence, or hardware realism.

## State and integration

The state contains world position and velocity, a body-to-world quaternion, body-frame angular velocity, and four motor states. The quaternion is authoritative and normalized after every step. Angular velocity uses the constant-body-rate exponential quaternion increment:

```text
q_next = normalize(q * quaternion(axis = omega_body, angle = |omega_body| * dt))
```

The fixed simulation timestep defaults to 240 Hz. A render-frame accumulator bounds catch-up work and reports dropped steps; render FPS therefore does not choose the physics timestep.

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

Angular drag is a configurable body-axis damping torque. The model intentionally omits propwash, blade-element aerodynamics, battery sag, ground effect and collision geometry beyond the training-field ground plane.

## Motors and forces

Each motor has an independent normalized command, target thrust and actual thrust. Actual thrust follows an exact first-order response for each constant timestep:

```text
T_next = T + (T_target - T) * (1 - exp(-dt / responseTimeConstant))
```

Force is the sum of motor thrust along body +Y. Arm torque is calculated as `r x F`; yaw is the propeller reaction torque derived from spin direction and a configured torque/thrust coefficient. Yaw is never faked by directly editing orientation.

## Quad-X allocation

The mixer adds pilot-positive roll/pitch/yaw differentials to collective in the documented motor order. If the requested output exceeds [0, 1], the allocation preserves the requested differential range by affine rescaling or shifting all four motors together, and reports saturation. It does not independently clip one motor and hide the resulting sign error.

## Ground contact and safety

Ground contact clamps position to the configured plane. A downward normal velocity is reflected with restitution, while tangential velocity is multiplied by the configured contact retention. This is a minimal collision response, not an artificial hover force.

Invalid configuration, timestep, command, non-finite state, excessive speed or distance causes a safe reset to the validated spawn state and returns a warning. The fixed-step accumulator also reports invalid frame deltas and dropped catch-up steps. Warnings are surfaced to callers for developer HUDs; numerical failure is never silently propagated.

## Configuration assumptions

The default config uses a 0.65 kg quad, 0.17 m motor radius, diagonal inertia `(0.0025, 0.0045, 0.0025) kg m²`, 5 N maximum thrust per motor, 30 ms motor response, configurable linear/angular drag and a 9.80665 m/s² gravity constant. These are transparent starting assumptions for tuning, not universal defaults.
