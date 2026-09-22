import { normalizeQuaternion, quaternionNorm, type Quaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import type {
  ReplayControllerOutput,
  ReplayGhostState,
  ReplayRecording,
  ReplaySample,
} from './types'

function lerp(left: number, right: number, amount: number): number {
  return left + (right - left) * amount
}

function lerpVector(left: Vector3, right: Vector3, amount: number): Vector3 {
  return {
    x: lerp(left.x, right.x, amount),
    y: lerp(left.y, right.y, amount),
    z: lerp(left.z, right.z, amount),
  }
}

function finiteQuaternion(value: Quaternion): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isFinite(value.w)
    && Number.isFinite(quaternionNorm(value)) && quaternionNorm(value) > 1e-8
}

/**
 * Spherical interpolation using the shortest quaternion path. Quaternions q
 * and -q represent the same attitude, so the right endpoint is negated when
 * their dot product is negative. The near-zero-angle fallback also handles
 * antipodal representations without introducing a NaN axis.
 */
export function slerpQuaternionShortestPath(
  left: Quaternion,
  right: Quaternion,
  amount: number,
): Quaternion {
  if (!finiteQuaternion(left) || !finiteQuaternion(right)) return normalizeQuaternion(left)
  const a = normalizeQuaternion(left)
  let b = normalizeQuaternion(right)
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  if (dot < 0) {
    b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }
    dot = -dot
  }
  const t = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0
  if (dot > 0.9995) {
    return normalizeQuaternion({
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      w: lerp(a.w, b.w, t),
    })
  }
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
  const sine = Math.sin(angle)
  if (Math.abs(sine) <= 1e-8) return a
  const leftWeight = Math.sin((1 - t) * angle) / sine
  const rightWeight = Math.sin(t * angle) / sine
  return normalizeQuaternion({
    x: a.x * leftWeight + b.x * rightWeight,
    y: a.y * leftWeight + b.y * rightWeight,
    z: a.z * leftWeight + b.z * rightWeight,
    w: a.w * leftWeight + b.w * rightWeight,
  })
}

function copyOutput(output: ReplayControllerOutput): ReplayControllerOutput {
  return Object.freeze({
    targetPilotRateRadPerSec: Object.freeze({
      roll: output.targetPilotRateRadPerSec.roll,
      pitch: output.targetPilotRateRadPerSec.pitch,
      yaw: output.targetPilotRateRadPerSec.yaw,
    }),
    targetBodyRateRadPerSec: Object.freeze({ ...output.targetBodyRateRadPerSec }),
    pidOutputTorqueBodyNm: Object.freeze({ ...output.pidOutputTorqueBodyNm }),
    pilotCorrections: Object.freeze({ ...output.pilotCorrections }),
    motorCommands: Object.freeze([...output.motorCommands]) as unknown as readonly [number, number, number, number],
    mixerSaturated: output.mixerSaturated,
  })
}

function interpolateInput(
  left: ReplaySample['normalizedInput'],
  right: ReplaySample['normalizedInput'],
  amount: number,
): ReplaySample['normalizedInput'] {
  if (!left && !right) return null
  if (!left) return amount < 0.5 ? null : {
    roll: right?.roll ?? 0,
    pitch: right?.pitch ?? 0,
    yaw: right?.yaw ?? 0,
    throttle: right?.throttle ?? 0,
  }
  if (!right) return amount < 0.5 ? {
    roll: left.roll,
    pitch: left.pitch,
    yaw: left.yaw,
    throttle: left.throttle,
  } : null
  return {
    roll: lerp(left.roll, right.roll, amount),
    pitch: lerp(left.pitch, right.pitch, amount),
    yaw: lerp(left.yaw, right.yaw, amount),
    throttle: lerp(left.throttle, right.throttle, amount),
  }
}

function interpolateOutput(
  left: ReplayControllerOutput,
  right: ReplayControllerOutput,
  amount: number,
): ReplayControllerOutput {
  return {
    targetPilotRateRadPerSec: {
      roll: lerp(left.targetPilotRateRadPerSec.roll, right.targetPilotRateRadPerSec.roll, amount),
      pitch: lerp(left.targetPilotRateRadPerSec.pitch, right.targetPilotRateRadPerSec.pitch, amount),
      yaw: lerp(left.targetPilotRateRadPerSec.yaw, right.targetPilotRateRadPerSec.yaw, amount),
    },
    targetBodyRateRadPerSec: lerpVector(left.targetBodyRateRadPerSec, right.targetBodyRateRadPerSec, amount),
    pidOutputTorqueBodyNm: lerpVector(left.pidOutputTorqueBodyNm, right.pidOutputTorqueBodyNm, amount),
    pilotCorrections: {
      roll: lerp(left.pilotCorrections.roll, right.pilotCorrections.roll, amount),
      pitch: lerp(left.pilotCorrections.pitch, right.pilotCorrections.pitch, amount),
      yaw: lerp(left.pilotCorrections.yaw, right.pilotCorrections.yaw, amount),
    },
    motorCommands: left.motorCommands.map((value, index) => lerp(value, right.motorCommands[index] ?? value, amount)) as [number, number, number, number],
    mixerSaturated: amount < 0.5 ? left.mixerSaturated : right.mixerSaturated,
  }
}

function freezeGhost(state: ReplayGhostState): ReplayGhostState {
  return Object.freeze({
    ...state,
    positionM: Object.freeze({ ...state.positionM }),
    orientation: Object.freeze({ ...state.orientation }),
    velocityMps: Object.freeze({ ...state.velocityMps }),
    angularVelocityBodyRadPerSec: Object.freeze({ ...state.angularVelocityBodyRadPerSec }),
    normalizedInput: state.normalizedInput ? Object.freeze({ ...state.normalizedInput }) : null,
    controllerOutput: copyOutput(state.controllerOutput),
  })
}

function ghostFromSample(sample: ReplaySample): ReplayGhostState {
  return freezeGhost({
    timestampSeconds: sample.timestampSeconds,
    positionM: { ...sample.positionM },
    orientation: { ...sample.orientation },
    velocityMps: { ...sample.velocityMps },
    angularVelocityBodyRadPerSec: { ...sample.angularVelocityBodyRadPerSec },
    normalizedInput: sample.normalizedInput ? { ...sample.normalizedInput } : null,
    controllerOutput: copyOutput(sample.controllerOutput),
  })
}

function validSampleTimeline(samples: readonly ReplaySample[]): boolean {
  let previous: number | null = null
  for (const sample of samples) {
    if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0) return false
    if (previous !== null && sample.timestampSeconds <= previous) return false
    previous = sample.timestampSeconds
  }
  return samples.length > 0
}

/** Interpolate a chronological compact sample list at its absolute timestamp. */
export function interpolateReplaySamples(
  samples: readonly ReplaySample[],
  timestampSeconds: number,
): ReplayGhostState | null {
  if (!validSampleTimeline(samples) || !Number.isFinite(timestampSeconds)) return null
  if (samples.length === 1) return ghostFromSample(samples[0])
  if (timestampSeconds <= samples[0].timestampSeconds) return ghostFromSample(samples[0])
  const last = samples[samples.length - 1]
  if (timestampSeconds >= last.timestampSeconds) return ghostFromSample(last)

  let low = 0
  let high = samples.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (samples[middle].timestampSeconds <= timestampSeconds) low = middle
    else high = middle
  }
  const left = samples[low]
  const right = samples[high]
  const interval = right.timestampSeconds - left.timestampSeconds
  if (!Number.isFinite(interval) || interval <= 0) return null
  const amount = (timestampSeconds - left.timestampSeconds) / interval
  return freezeGhost({
    timestampSeconds,
    positionM: lerpVector(left.positionM, right.positionM, amount),
    orientation: slerpQuaternionShortestPath(left.orientation, right.orientation, amount),
    velocityMps: lerpVector(left.velocityMps, right.velocityMps, amount),
    angularVelocityBodyRadPerSec: lerpVector(left.angularVelocityBodyRadPerSec, right.angularVelocityBodyRadPerSec, amount),
    normalizedInput: interpolateInput(left.normalizedInput, right.normalizedInput, amount),
    controllerOutput: interpolateOutput(left.controllerOutput, right.controllerOutput, amount),
  })
}

/** Interpolate using the recording's relative playback clock. */
export function interpolateReplayRecording(
  recording: ReplayRecording,
  elapsedSeconds: number,
): ReplayGhostState | null {
  const first = recording.samples[0]
  if (!first || !Number.isFinite(elapsedSeconds)) return null
  const safeElapsed = Math.max(0, Math.min(recording.durationSeconds, elapsedSeconds))
  return interpolateReplaySamples(recording.samples, first.timestampSeconds + safeElapsed)
}

export const interpolateReplayState = interpolateReplaySamples
