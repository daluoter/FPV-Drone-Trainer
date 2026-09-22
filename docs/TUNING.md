# Phase 5 bounded tuning

Phase 5 adds a compact configuration screen without moving physics into React.
The settings component edits a copied configuration, validates it with the
existing rates, flight-controller and drone validators plus bounded trainer
limits, and persists one versioned JSON document in local storage.

## Settings contract

The persisted key is `fpv-drone-trainer.tuning.v1` and the document has
`schemaVersion: 1` with complete `controller`, `drone` and `camera` objects.
A parse error, missing field, unsupported schema version, non-finite value or
out-of-range value rejects the whole document and activates fresh defaults; a
partial document is not merged into a live configuration.

The UI exposes:

- independent Actual Rates center rate, maximum rate and expo for roll, pitch
  and yaw, using the existing canonical Betaflight formula and a preview curve;
- mass, one shared maximum motor thrust value, one shared motor response time
  constant, and x/y/z linear and angular drag coefficients;
- independent SI `kp`, `ki` and `kd` values for the three rate-PID axes. The
  existing integral and torque output limits remain validator-backed defaults;
- FPV mount angle choices of 0°, 10°, 20°, 30°, 40° and 50°, plus an FPV FOV
  bounded to 45°..120°.

The additional Phase 5 bounds are intentionally conservative UI bounds:

| Setting | Bound |
| --- | ---: |
| mass | 0.1..5 kg |
| motor maximum thrust | 0.1..20 N |
| motor response time constant | 0.005..1 s |
| linear drag coefficient | 0..5 N/(m/s) per axis |
| angular drag coefficient | 0..0.1 N m/(rad/s) per axis |
| PID `kp`, `ki`, `kd` | `kp`/`ki` 0..5; `kd` 0..1 |
| Actual Rates | existing 0..2000 deg/s and expo 0..1 |

These values are provisional starting assumptions for this simplified browser
trainer. They are not measured values, hardware tuning recommendations,
aerodynamic identification or a flight-worthiness claim.

## Apply and reset safety

The **Apply + reset** action saves only a validated document and calls the
explicit `FlightRuntime.reconfigure` boundary. That boundary releases keyboard
input, disarms the old simulation, replaces it with a fresh fixed-step
simulation, clears controller/input history and starts from the safe initial
state. Camera presentation settings are updated in the same action. Settings
are never silently written into an armed simulation or its existing PID/motor
state. The runtime must be explicitly armed again through its normal source
and neutral gates.

**Reset defaults** submits a fresh factory configuration through that same
boundary and persistence path. Tuning does not add training lessons, replay,
attitude shortcuts or direct physics/renderer mutation.

## Evidence limits

Pure validation, persistence, curve, UI apply/reset and runtime safety behavior
are covered by Vitest plus the four npm gates. Browser smoke is still needed
to observe actual WebGL rendering, camera presentation and local-storage UI
behavior. Scene disposal and WebGL context/resource release remain browser-only
evidence; jsdom and pure tests cannot prove GPU cleanup. No physical
transmitter or real flight evidence is implied.
