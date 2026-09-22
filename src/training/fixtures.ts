import { createInitialDroneState, DEFAULT_DRONE_CONFIG } from '../drone'
import { quaternionFromRotationVector, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import type {
  NormalizedRcInput,
} from '../flight-controller'
import type { TrainingSample, TrainingSceneReference } from './types'

const NEUTRAL_INPUT: NormalizedRcInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 }
const TWO_PI = Math.PI * 2

export const TRAINING_SCENE_REFERENCES: readonly TrainingSceneReference[] = [
  { id: 'takeoff-pad', kind: 'pad', positionM: { x: 0, y: 0.5, z: 0 }, sizeM: { x: 2.4, y: 0.08, z: 2.4 } },
  { id: 'hover-zone', kind: 'zone', positionM: { x: 0, y: 3, z: 0 }, sizeM: { x: 2.4, y: 0.04, z: 2.4 } },
  { id: 'turn-entry', kind: 'marker', positionM: { x: -4, y: 0.45, z: -4 }, sizeM: { x: 0.36, y: 0.9, z: 0.36 } },
  { id: 'turn-apex', kind: 'marker', positionM: { x: 4, y: 0.45, z: -4 }, sizeM: { x: 0.36, y: 0.9, z: 0.36 } },
  { id: 'turn-exit', kind: 'marker', positionM: { x: -4, y: 0.45, z: 4 }, sizeM: { x: 0.36, y: 0.9, z: 0.36 } },
  { id: 'orbit-poi', kind: 'poi', positionM: { x: 4, y: 2.5, z: 4 }, sizeM: { x: 0.36, y: 4, z: 0.36 } },
  { id: 'split-s-reference', kind: 'gate', positionM: { x: 0, y: 0.9, z: -5 }, sizeM: { x: 5.12, y: 1.8, z: 0.12 } },
]

function orientationForForward(forward: Vector3): Quaternion {
  return quaternionFromRotationVector({ x: 0, y: Math.atan2(-forward.x, -forward.z), z: 0 })
}

function sample(
  timestampSeconds: number,
  stepIndex: number,
  positionM: Vector3,
  velocityMps: Vector3,
  orientation: Quaternion,
  armed = true,
): TrainingSample {
  const state = createInitialDroneState(DEFAULT_DRONE_CONFIG, positionM, orientation)
  return {
    timestampSeconds,
    state: {
      ...state,
      positionM: { ...positionM },
      velocityMps: { ...velocityMps },
      stepIndex,
    },
    normalizedInput: NEUTRAL_INPUT,
    armed,
  }
}

export function createHoverSuccessFixture(): readonly TrainingSample[] {
  return Array.from({ length: 36 }, (_, index) => sample(
    0.1 * (index + 1),
    index + 1,
    { x: 0.08 * Math.sin(index / 5), y: 3.02, z: 0.08 * Math.cos(index / 5) },
    { x: 0.08, y: index < 3 ? 0.2 : 0.02, z: -0.04 },
    orientationForForward({ x: 0, y: 0, z: -1 }),
  ))
}

export function createHoverDisarmedFixture(): readonly TrainingSample[] {
  return [
    sample(0.1, 1, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 0 }, orientationForForward({ x: 0, y: 0, z: -1 }), true),
    sample(0.2, 2, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 0 }, orientationForForward({ x: 0, y: 0, z: -1 }), false),
  ]
}

export function createHoverDriftFixture(): readonly TrainingSample[] {
  return Array.from({ length: 12 }, (_, index) => sample(
    0.1 * (index + 1),
    index + 1,
    { x: index < 2 ? 0 : index * 1.5, y: 3 + index * 0.3, z: 0 },
    { x: 15, y: 3, z: 0 },
    orientationForForward({ x: 1, y: 0, z: 0 }),
  ))
}

export function createCoordinatedTurnSuccessFixture(): readonly TrainingSample[] {
  const points: TrainingSample[] = []
  let stepIndex = 0
  let timestamp = 0
  const appendSegment = (start: Vector3, end: Vector3, speedDirection: Vector3, count: number): void => {
    for (let index = 0; index <= count; index += 1) {
      if (points.length > 0 && index === 0) continue
      const fraction = index / count
      const position = {
        x: start.x + (end.x - start.x) * fraction,
        y: start.y + (end.y - start.y) * fraction,
        z: start.z + (end.z - start.z) * fraction,
      }
      const directionLength = Math.hypot(speedDirection.x, speedDirection.z)
      const direction = { x: speedDirection.x / directionLength, y: 0, z: speedDirection.z / directionLength }
      points.push(sample(
        timestamp += 0.1,
        ++stepIndex,
        position,
        { x: direction.x * 6, y: 0, z: direction.z * 6 },
        orientationForForward(direction),
      ))
    }
  }
  appendSegment({ x: -4, y: 0.45, z: -4 }, { x: 4, y: 0.45, z: -4 }, { x: 1, y: 0, z: 0 }, 16)
  appendSegment({ x: 4, y: 0.45, z: -4 }, { x: -4, y: 0.45, z: 4 }, { x: -1, y: 0, z: 1 }, 22)
  return points
}

export function createCoordinatedTurnStraightFixture(): readonly TrainingSample[] {
  return Array.from({ length: 80 }, (_, index) => sample(
    0.1 * (index + 1),
    index + 1,
    { x: -4 + index * 0.1, y: 0.45, z: -4 },
    { x: 6, y: 0, z: 0 },
    orientationForForward({ x: 1, y: 0, z: 0 }),
  ))
}

export function createSplitSSuccessFixture(): readonly TrainingSample[] {
  const rollInverted = quaternionFromRotationVector({ x: Math.PI, y: 0, z: 0 })
  const uprightReversed = orientationForForward({ x: 0, y: 0, z: 1 })
  return [
    sample(0.2, 1, { x: 0, y: 20, z: -2 }, { x: 0, y: 0, z: -8 }, orientationForForward({ x: 0, y: 0, z: -1 })),
    sample(0.4, 2, { x: 0, y: 19, z: -3 }, { x: 0, y: -2, z: -5 }, rollInverted),
    sample(0.6, 3, { x: 0, y: 15, z: -4 }, { x: 0, y: -8, z: -2 }, rollInverted),
    sample(0.8, 4, { x: 0, y: 10, z: -4 }, { x: 0, y: -5, z: 6 }, rollInverted),
    sample(1.0, 5, { x: 0, y: 7, z: -3 }, { x: 0, y: -1, z: 5 }, uprightReversed),
    sample(1.2, 6, { x: 0, y: 7, z: -2.5 }, { x: 0, y: 0, z: 5 }, uprightReversed),
    sample(1.4, 7, { x: 0, y: 7, z: -2 }, { x: 0, y: 0, z: 5 }, uprightReversed),
    sample(1.6, 8, { x: 0, y: 7, z: -1.5 }, { x: 0, y: 0, z: 5 }, uprightReversed),
    sample(1.8, 9, { x: 0, y: 7, z: -1 }, { x: 0, y: 0, z: 5 }, uprightReversed),
    sample(2.0, 10, { x: 0, y: 7, z: -0.5 }, { x: 0, y: 0, z: 5 }, uprightReversed),
    sample(2.2, 11, { x: 0, y: 7, z: 0 }, { x: 0, y: 0, z: 5 }, uprightReversed),
  ]
}

export function createSplitSUprightUTurnFixture(): readonly TrainingSample[] {
  const forward = orientationForForward({ x: 0, y: 0, z: -1 })
  const reversed = orientationForForward({ x: 0, y: 0, z: 1 })
  return [
    sample(0.2, 1, { x: 0, y: 20, z: -2 }, { x: 0, y: 0, z: -8 }, forward),
    sample(0.4, 2, { x: 0, y: 16, z: -3 }, { x: 0, y: -3, z: -4 }, reversed),
    sample(0.6, 3, { x: 0, y: 12, z: -4 }, { x: 0, y: -3, z: 5 }, reversed),
    sample(2.2, 4, { x: 0, y: 8, z: -3 }, { x: 0, y: 0, z: 5 }, reversed),
  ]
}

export function createOrbitSuccessFixture(): readonly TrainingSample[] {
  const points: TrainingSample[] = []
  const poi = { x: 4, y: 2.5, z: 4 }
  const count = 72
  for (let index = 0; index <= count; index += 1) {
    const angle = (TWO_PI * index) / 64
    const radius = 10
    const position = { x: poi.x + radius * Math.cos(angle), y: poi.y, z: poi.z + radius * Math.sin(angle) }
    const tangent = { x: -Math.sin(angle), y: 0, z: Math.cos(angle) }
    points.push(sample(
      0.13 * (index + 1),
      index + 1,
      position,
      { x: tangent.x * 7.8, y: 0, z: tangent.z * 7.8 },
      orientationForForward(tangent),
    ))
  }
  return points
}

export function createOrbitYawInPlaceFixture(): readonly TrainingSample[] {
  return Array.from({ length: 100 }, (_, index) => sample(
    0.1 * (index + 1),
    index + 1,
    { x: 14, y: 2.5, z: 4 },
    { x: 0, y: 0, z: 0 },
    quaternionFromRotationVector({ x: 0, y: index * 0.2, z: 0 }),
  ))
}

export function createOrbitTeleportFixture(): readonly TrainingSample[] {
  return [
    sample(0.1, 1, { x: 14, y: 2.5, z: 4 }, { x: 0, y: 0, z: 7.8 }, orientationForForward({ x: 0, y: 0, z: 1 })),
    sample(0.2, 2, { x: -6, y: 2.5, z: 4 }, { x: 0, y: 0, z: 7.8 }, orientationForForward({ x: 0, y: 0, z: 1 })),
  ]
}

/** A bounded 7.8 m / 0.2 s jump whose reported speed falsely says 7.8 m/s. */
export function createOrbitVelocityMismatchFixture(): readonly TrainingSample[] {
  const firstAngle = 0
  const secondAngle = 0.8
  const firstTangent = { x: -Math.sin(firstAngle), y: 0, z: Math.cos(firstAngle) }
  const secondTangent = { x: -Math.sin(secondAngle), y: 0, z: Math.cos(secondAngle) }
  return [
    sample(
      0.1,
      1,
      { x: 14, y: 2.5, z: 4 },
      { x: firstTangent.x * 7.8, y: 0, z: firstTangent.z * 7.8 },
      orientationForForward(firstTangent),
    ),
    sample(
      0.3,
      2,
      { x: 4 + 10 * Math.cos(secondAngle), y: 2.5, z: 4 + 10 * Math.sin(secondAngle) },
      { x: secondTangent.x * 7.8, y: 0, z: secondTangent.z * 7.8 },
      orientationForForward(secondTangent),
    ),
  ]
}

export function createOrbitOscillatoryFixture(): readonly TrainingSample[] {
  return [0, 0.4, 0, 0.4, 0, 0.4].map((angle, index) => {
    const tangent = { x: -Math.sin(angle), y: 0, z: Math.cos(angle) }
    return sample(
      0.2 * (index + 1),
      index + 1,
      { x: 4 + 10 * Math.cos(angle), y: 2.5, z: 4 + 10 * Math.sin(angle) },
      { x: tangent.x * 7, y: 0, z: tangent.z * 7 },
      orientationForForward(tangent),
    )
  })
}

export const TWO_PI_RADIANS = TWO_PI
