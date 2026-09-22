# Actual Rates

`src/rates` is the independent pilot-stick-to-angular-rate boundary. It applies
Betaflight Actual Rates to one finite normalized stick sample and returns a
physical rate in degrees per second. It does not implement a PID controller,
UI, motor mixer or flight-loop integration.

## Canonical formula

The implementation follows Betaflight 4.5.2 `applyActualRates`:

```text
x = normalized stick input, in [-1, 1]
u = abs(x)
e = expo fraction, in [0, 1]
C = center rate, in deg/s
M = max(0, max rate - C), in deg/s

q = u * (e * x^5 + (1 - e) * x)
actual rate = C * x + M * q
```

`centerRateDegPerSec` and `maxRateDegPerSec` are physical values. The
firmware's profile values are scaled by **10 deg/s per rate unit**:

```text
C = 10 * rcRates
max rate = 10 * rates
e = rcExpo / 100
```

Expo is a fraction in this module, not a percentage. At full stick, when
`maxRateDegPerSec >= centerRateDegPerSec`, the endpoint is the configured
maximum rate. The formula intentionally uses `max(0, maxRate - C)`: when
`C > maxRate`, the endpoint remains `C` and expo cannot reduce it. This
canonical behavior is covered by tests and must not be replaced with a clamp
of `maxRate`.

The rate function does not apply a caller rate limit. Betaflight computes the
Actual Rates result first and then clamps the resulting setpoint to a separate
configured per-axis `rate_limit`. Use `applyConfiguredRateLimit` (or its
per-axis/radian counterpart) explicitly when that separate safety/configuration
limit is wanted:

```ts
const actualDegPerSec = applyActualRates(stick, axisConfig)
const limitedDegPerSec = applyConfiguredRateLimit(actualDegPerSec, limitDegPerSec)
```

A `null` configured limit means no separate limit. Rate limiting is symmetric
about zero and is deliberately a separate operation so the canonical Actual
Rates curve remains observable.

## Units and validation

- Stick input must be finite and normalized to `[-1, 1]`; out-of-range input is
  rejected with `NaN`, not silently clamped.
- Center and maximum rates must be finite and in `[0, 2000] deg/s`. This is the
  practical bound corresponding to Betaflight's documented Actual Rates profile
  range of `0..200` rate units at the 10 deg/s scale.
- Expo must be finite and in `[0, 1]`.
- The independent configured rate-limit bound is `[0, 2000] deg/s`; `null`
  disables that separate clamp.
- `validateActualRatesConfig`, `validateRatesConfig` and `validateRateLimits`
  expose structured validation. Calculation functions return `NaN` for invalid
  input/configuration so a caller can fail safely instead of propagating a
  non-finite control command.
- `degreesPerSecondToRadiansPerSecond` and
  `radiansPerSecondToDegreesPerSecond` are explicit finite-safe boundaries.
  The rates module's public physical configuration is deg/s; simulation state
  remains free to consume the converted rad/s value.

`DEFAULT_RATES_CONFIG` has independent roll, pitch and yaw entries, each
starting at `C = 70 deg/s`, `max rate = 670 deg/s`, `expo = 0`. These are
reasonable freestyle-trainer starting assumptions, not a measured setup or a
claim of airframe realism. `DEFAULT_RATE_LIMITS_DEG_PER_SEC` leaves the
caller-level limit disabled until a caller configures one.

## Source evidence

The canonical implementation was retrieved from the official Betaflight
4.5.2 tag:

- Source URL: [`rc.c` at tag `4.5.2`](https://raw.githubusercontent.com/betaflight/betaflight/4.5.2/src/main/fc/rc.c)
- Retrieved source SHA-256:
  `340cfd8de82ba2de2c9d072460423716fbd3b7a5d3e4799cdabc325eaf8dcbb9`
- Supporting profile header:
  [`controlrate_profile.h`](https://raw.githubusercontent.com/betaflight/betaflight/4.5.2/src/main/fc/controlrate_profile.h)
  (SHA-256
  `7445019cdb9313a6b17739b48870feca7741b319ea3c3db22328a85c47140f5f`)
- Supporting profile defaults/limits:
  [`controlrate_profile.c`](https://raw.githubusercontent.com/betaflight/betaflight/4.5.2/src/main/fc/controlrate_profile.c)
  (SHA-256
  `adf8ae7ce41e806ba011f5b51d6684e72964febef7aff12be1a2fcec905ca547`)

The source's `applyActualRates` calculates the curve without a clamp. Its
caller applies the separate `rate_limit[axis]` clamp to the resulting setpoint.
The module tests retain the verified vectors (`C = 70`, `max rate = 670`):
`x = .25 -> 55 deg/s`, `x = .5 -> 185 deg/s`, and with `e = .5`,
`x = .5 -> 114.6875 deg/s`.
