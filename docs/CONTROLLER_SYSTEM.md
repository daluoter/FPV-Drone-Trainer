# Controller system

Phase 1 implements the browser Gamepad input boundary and Controller Lab. It does **not** start flight or rotate a rendered object. The controller domain produces immutable raw snapshots, calibration profiles, and processed channels for a later rates/flight-controller phase.

## Browser contract

The implementation follows the authoritative browser contracts:

- [W3C Gamepad API](https://www.w3.org/TR/gamepad/) — `Gamepad` device shape, indexed axes/buttons, connection state and polling model.
- [MDN Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API) — browser support and connection lifecycle overview.
- [MDN Gamepad interface](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad) — `id`, `index`, `mapping`, `axes`, `buttons`, `connected` and `timestamp` fields.
- [MDN gamepadconnected event](https://developer.mozilla.org/en-US/docs/Web/API/Window/gamepadconnected_event) — connection notification behavior.

`navigator.getGamepads()` is sampled by `GamepadPoller` on its own `requestAnimationFrame` loop. React subscribes to a throttled view of that external poller; React render frequency is not the input source of truth. A browser-reported mapping string is displayed but does not make axis 0/1/2/3 assumptions safe. A missing device, disconnected device, non-finite axis or non-finite button value remains visible and causes the relevant safety checks to fail.

## Processing pipeline

```text
Gamepad snapshot
  -> selected device/profile compatibility
  -> endpoint and center calibration
  -> normalized centered sticks or single-ended throttle
  -> remapped small deadband (roll/pitch/yaw only)
  -> short low-pass filter (history owned by the external polling loop)
  -> final normalized channel
  -> future Actual Rates / flight controller
```

The Controller Lab exposes every stage for Roll, Pitch, Yaw and Throttle:

- **Raw** — browser axis value.
- **Calibrated** — raw value relative to measured center/minimum.
- **Normalized** — endpoint-corrected output (`[-1, 1]` for sticks, `[0, 1]` for throttle).
- **Deadband** — remapped output after the configured small stick deadband.
- **Filtered** — short first-order low-pass output.
- **Final** — the channel value that a later flight pipeline may consume.

The deadband transform is `sign(x) * (abs(x) - d) / (1 - d)` outside the deadband and zero inside it. This suppresses center jitter without permanently throwing away full-stick range. The configured range is intentionally limited to `0..0.20`; the defaults are `0.01` for Roll/Pitch/Yaw and `0` for Throttle. Deadband is not used to conceal invalid input. Filter history is maintained outside React, reset for a new connection/profile or invalid sample, and uses fresh Gamepad timestamps; measured full endpoints are not attenuated into a permanently smaller output.

## Calibration wizard

1. **Select** — list every discovered device with ID, browser index, mapping, axis count and button count. A disconnect is retained as a disconnected device and clears the selected live snapshot.
2. **Center** — collect approximately 2.5 seconds of untouched samples and calculate count, mean center, min/max, peak-to-peak jitter and standard deviation.
3. **Roll/Pitch/Yaw/Throttle movement** — capture several seconds of movement, compare each axis against the centered baseline, and choose an axis only when its excursion is significant and distinct. Tied or weak candidates are rejected as ambiguous/insufficient.
4. **Endpoints** — use observed minimum and maximum values. Self-centering channels must reach both sides of their measured center; throttle uses a separate single-ended range and never requires a center.
5. **Direction** — show live virtual channels and allow independent inversion. Direction verification is explicit; changing inversion or deadband clears both verification gates.
6. **Neutral stability** — with hands off the transmitter, process fresh samples for three seconds. Roll/Pitch/Yaw must stay within the documented `0.02` normalized-output threshold and `0.01` standard-deviation target. The report identifies maximum absolute output, mean and standard deviation per channel; persisted evidence is rejected if its count, duration, metrics, threshold or stable status is malformed.

Calibration never assumes `-1` or `+1` endpoints. A duplicate axis, out-of-range axis, invalid endpoint order, non-finite sample, unstable center or incompatible persisted profile is rejected.

## Versioned profiles

Profiles are stored under a versioned local-storage key and include:

- schema version
- exact device ID and browser mapping
- axis/button counts
- per-channel axis, inversion, center, minimum, maximum and deadband
- single-ended throttle mode
- calibration timestamp
- direction and neutral verification timestamps/report
- connection-session binding for neutral approval, retained only as stale evidence across reloads

A profile is loaded only when all identifying fields match the currently selected device and its complete runtime validation passes. A profile from another device, a changed axis/button layout, a changed mapping or an unsupported version is ignored. Calibration remains reusable after reload/reconnect, but neutral approval is bound to a runtime connection session; a stored report is historical evidence and never substitutes for a fresh timed test. Recalibration and channel edits clear verification timestamps. Storage failure is non-fatal: the current calibration remains in memory but is not silently treated as persisted.

## Safety gate

`evaluateFlightEligibility` requires a connected selected device, a compatible valid profile with four distinct axes and finite calibrated endpoints, explicit direction verification, a passing neutral report bound to the current connection session, a finite current processed snapshot, and finite button data. It is a continuously displayable calibration gate: intended stick movement does not revoke it. The separate `evaluateFlightArmEligibility` handoff adds current rotational neutral (`0.02`) and low throttle (`<= 0.05`) only when a future flight mode is armed; those conditions must not reject commands after arming. Phase 1 displays these contracts but deliberately has no Free Flight path. Later phases must call the arm gate before enabling RC-controlled flight.

## Hardware caveat

Automated tests use synthetic Gamepad-like objects and prove transform, rejection and disconnect behavior. The browser UI can be smoke-tested without hardware. A physical transmitter is still required for endpoint, direction, neutral and spontaneous-rotation validation; follow [`CONTROLLER_TESTING.md`](CONTROLLER_TESTING.md) and record browser/OS/device details.
