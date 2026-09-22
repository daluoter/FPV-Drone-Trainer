# Coordinate system and signs

Phase 2 uses one right-handed coordinate convention throughout the simulation and the future Three.js renderer.

## Axes

- **World and body +X:** right.
- **World and body +Y:** up.
- **World and body +Z:** rear; therefore **-Z is forward/nose direction**.
- `orientation` is a quaternion mapping body vectors into world vectors. It is the authoritative attitude state; Euler angles are derived display values only.
- `positionM` and `velocityMps` are world-frame metres and metres/second.
- `angularVelocityBodyRadPerSec` is body-frame radians/second.
- Motor thrust acts along body +Y.
- Gravity acts along world -Y.

This is the same handedness used by Three.js (`Object3D` local +Y is up and the conventional camera look direction is -Z), so a renderer can consume the state without changing signs or silently introducing a second convention.

## Pilot signs

Pilot-positive axes are defined by the maneuver they produce, not by a browser axis index:

| Pilot axis | Positive maneuver | Physical body rotation vector |
| --- | --- | --- |
| Roll | Right wing down | body -Z |
| Pitch | Nose up | body +X |
| Yaw | Nose turns right | body -Y |

For a pilot command vector `(roll, pitch, yaw)`, conversion to the physical body angular vector is:

```text
omegaBody = ( pitch, -yaw, -roll )
```

The same conversion applies to pilot-positive desired rates and torque directions. The mixer uses these signs explicitly rather than relying on an implicit “stick axis” convention.

## Quad-X motor order

The four motors are always ordered:

1. front-left: `(-X, 0, -Z)`, CCW propeller
2. front-right: `(+X, 0, -Z)`, CW propeller
3. rear-left: `(-X, 0, +Z)`, CW propeller
4. rear-right: `(+X, 0, +Z)`, CCW propeller

The position coordinates are diagonal Quad-X locations. “CW” and “CCW” are viewed from above, looking down along -Y. A CW propeller contributes +body-Y reaction torque to the frame; CCW contributes -body-Y.

Thrust moment follows the physical equation `tau = r x F` with `F = (0, thrust, 0)`. Consequently:

- left-side thrust increases pilot-positive roll (`-Z` moment);
- front-side thrust increases pilot-positive pitch (`+X` moment);
- CCW-side thrust increases pilot-positive yaw (`-Y` moment).

The mixer and force derivation tests are the executable sign contract for this document.
