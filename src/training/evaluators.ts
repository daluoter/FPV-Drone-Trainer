import { rotateVectorByQuaternion } from '../math/quaternion'
import type { Vector3 } from '../math/vector'
import type {
  LessonEvaluatorContract,
  TrainingEvaluation,
  TrainingEvaluationContext,
  TrainingSample,
} from './types'

const PI = Math.PI
const TWO_PI = Math.PI * 2
const DEG = 180 / Math.PI

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function metric(context: TrainingEvaluationContext, name: string, fallback = 0): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function previousInput(context: TrainingEvaluationContext): TrainingSample['normalizedInput'] {
  return context.previousSample?.normalizedInput ?? null
}

function deltaSeconds(context: TrainingEvaluationContext, sample: TrainingSample): number {
  const previous = context.previousSample
  if (!previous) return 0
  const delta = sample.timestampSeconds - previous.timestampSeconds
  return Number.isFinite(delta) && delta > 0 ? delta : 0
}

function horizontalDistance(left: Vector3, right: Vector3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

function distance3d(left: Vector3, right: Vector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

function horizontalSpeed(sample: TrainingSample): number {
  return Math.hypot(sample.state.velocityMps.x, sample.state.velocityMps.z)
}

function speed(sample: TrainingSample): number {
  const velocity = sample.state.velocityMps
  return Math.hypot(velocity.x, velocity.y, velocity.z)
}

function bodyForward(sample: TrainingSample): Vector3 {
  return rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 0, z: -1 })
}

function bodyUp(sample: TrainingSample): Vector3 {
  return rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 1, z: 0 })
}

function horizontalUnit(value: Vector3): Vector3 | null {
  const magnitude = Math.hypot(value.x, value.z)
  if (!Number.isFinite(magnitude) || magnitude <= 1e-6) return null
  return { x: value.x / magnitude, y: 0, z: value.z / magnitude }
}

function headingRadians(vector: Vector3): number {
  return Math.atan2(vector.z, vector.x)
}

function wrappedAngle(value: number): number {
  let result = value
  while (result > PI) result -= TWO_PI
  while (result < -PI) result += TWO_PI
  return result
}

function headingDifferenceDegrees(left: number, right: number): number {
  return Math.abs(wrappedAngle(left - right)) * DEG
}

function motionDirection(sample: TrainingSample): Vector3 {
  return horizontalUnit(sample.state.velocityMps) ?? horizontalUnit(bodyForward(sample)) ?? { x: 0, y: 0, z: -1 }
}

function cameraHeadingErrorDegrees(sample: TrainingSample, target: Vector3): number {
  const camera = horizontalUnit(bodyForward(sample))
  const desired = horizontalUnit(target)
  if (!camera || !desired) return 180
  return Math.acos(clamp(camera.x * desired.x + camera.z * desired.z, -1, 1)) * DEG
}

function bodyTiltDegrees(sample: TrainingSample): number {
  return Math.acos(clamp(bodyUp(sample).y, -1, 1)) * DEG
}

function reference(context: TrainingEvaluationContext, id: string) {
  return context.sceneReferences.find((candidate) => candidate.id === id) ?? null
}

function safeEvaluation(
  status: TrainingEvaluation['status'],
  metrics: Readonly<Record<string, number>>,
  options: Pick<TrainingEvaluation, 'checkpointIds' | 'score' | 'message' | 'hint'> = {},
): TrainingEvaluation {
  return {
    status,
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [key, finite(value)]),
    ),
    ...options,
  }
}

function guardSample(sample: TrainingSample, context: TrainingEvaluationContext, referenceId: string): TrainingEvaluation | null {
  if (sample.armed === false) {
    return safeEvaluation('failure', { elapsedSeconds: context.elapsedSeconds }, {
      message: 'Attempt stopped: the flight was disarmed or focus was lost.',
      hint: 'Re-arm explicitly, then retry the lesson from its reset setup.',
    })
  }
  if (sample.armed !== true) {
    return safeEvaluation('continue', { elapsedSeconds: context.elapsedSeconds }, {
      message: 'Waiting for armed telemetry before evaluating the maneuver.',
      hint: 'Arm only after the countdown and keep the runtime focused.',
    })
  }
  if (!reference(context, referenceId)) {
    return safeEvaluation('failure', { elapsedSeconds: context.elapsedSeconds }, {
      message: `The ${referenceId} scene reference is unavailable; this attempt cannot be scored.`,
      hint: 'Reset the training field and retry.',
    })
  }
  return null
}

function pathGap(
  context: TrainingEvaluationContext,
  sample: TrainingSample,
  maximumSeconds = 0.35,
  maximumDistanceM = 8,
  maximumSpeedMps = 45,
): boolean {
  const previous = context.previousSample
  if (!previous) return false
  const delta = sample.timestampSeconds - previous.timestampSeconds
  const distance = distance3d(sample.state.positionM, previous.state.positionM)
  if (!Number.isFinite(delta) || delta <= 0 || delta > maximumSeconds) return true
  if (!Number.isFinite(distance) || distance > maximumDistanceM) return true
  return distance / delta > maximumSpeedMps
}

function stickDiagnostics(context: TrainingEvaluationContext, sample: TrainingSample): {
  readonly stickDelta: number
  readonly stickSmoothness: number
  readonly stickVariation: number
} {
  const input = sample.normalizedInput
  const previous = previousInput(context)
  const delta = input && previous
    ? Math.abs(input.roll - previous.roll)
      + Math.abs(input.pitch - previous.pitch)
      + Math.abs(input.yaw - previous.yaw)
      + Math.abs(input.throttle - previous.throttle)
    : 0
  const seconds = Math.max(deltaSeconds(context, sample), 1 / 240)
  const normalizedDelta = clamp(delta / (seconds * 8), 0, 1)
  const variation = metric(context, 'stickVariation', 0) + normalizedDelta * seconds
  return {
    stickDelta: finite(delta),
    stickVariation: finite(variation),
    stickSmoothness: finite(clamp(100 - variation * 4, 0, 100)),
  }
}

function scoreFromErrors(errors: readonly number[]): number {
  const penalty = errors.reduce((total, value) => total + Math.max(0, finite(value)), 0)
  return clamp(100 - penalty, 0, 100)
}

function evaluateHover(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  const guard = guardSample(sample, context, 'hover-zone')
  if (guard) return guard
  const zone = reference(context, 'hover-zone')
  if (!zone) return safeEvaluation('failure', {}, { message: 'Hover target is unavailable.' })

  const horizontalError = horizontalDistance(sample.state.positionM, zone.positionM)
  const altitudeError = Math.abs(sample.state.positionM.y - zone.positionM.y)
  const zoneRadius = Math.max(0.75, Math.min(zone.sizeM?.x ?? 2.4, zone.sizeM?.z ?? 2.4) * 0.46)
  const altitudeTolerance = 0.65
  const horizontalVelocity = horizontalSpeed(sample)
  const verticalVelocity = Math.abs(sample.state.velocityMps.y)
  const tilt = bodyTiltDegrees(sample)
  const inZone = horizontalError <= zoneRadius && altitudeError <= altitudeTolerance
  const previousInZone = metric(context, 'inZone', 0) > 0.5
  const dwell = inZone && previousInZone && deltaSeconds(context, sample) <= 0.3
    ? metric(context, 'contiguousDwellSeconds', 0) + deltaSeconds(context, sample)
    : 0
  const stick = stickDiagnostics(context, sample)
  const stable = inZone && horizontalVelocity <= 1.6 && verticalVelocity <= 1.2 && tilt <= 18
  const settled = stable && horizontalVelocity <= 0.8 && verticalVelocity <= 0.8 && tilt <= 10
  const checkpointIds = [
    ...(inZone ? ['enter-hover-zone'] : []),
    ...(stable && dwell >= 2.5 ? ['hold-hover'] : []),
    ...(settled && dwell >= 3.2 ? ['settle-hover'] : []),
  ] as const
  const metrics = {
    altitudeErrorM: altitudeError,
    horizontalDriftM: horizontalError,
    horizontalSpeedMps: horizontalVelocity,
    verticalSpeedMps: verticalVelocity,
    maxTiltDegrees: tilt,
    contiguousDwellSeconds: dwell,
    inZone: inZone ? 1 : 0,
    stickDelta: stick.stickDelta,
    stickVariation: stick.stickVariation,
    stickSmoothness: stick.stickSmoothness,
  }
  if (context.elapsedSeconds > 30) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      score: scoreFromErrors([horizontalError * 8, altitudeError * 15, horizontalVelocity * 3, tilt]),
      message: 'Hover attempt timed out before a contiguous stable dwell was completed.',
      hint: 'Enter the target gently, then keep drift and altitude corrections small.',
    })
  }
  if (horizontalError > 12 || altitudeError > 12 || speed(sample) > 45 || tilt > 165) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      score: scoreFromErrors([horizontalError * 4, altitudeError * 6, speed(sample)]),
      message: 'The hover left the recoverable flight envelope.',
      hint: 'Retry and reduce horizontal drift before correcting altitude.',
    })
  }
  if (settled && dwell >= 3.2 && context.elapsedSeconds >= 3.2) {
    return safeEvaluation('success', metrics, {
      checkpointIds,
      score: scoreFromErrors([
        horizontalError * 8,
        altitudeError * 15,
        horizontalVelocity * 3,
        verticalVelocity * 3,
        tilt,
        Math.max(0, 70 - stick.stickSmoothness) * 0.12,
      ]),
      message: 'Hover held continuously inside the position, altitude, and attitude envelope.',
    })
  }
  return safeEvaluation('continue', metrics, {
    checkpointIds,
    score: scoreFromErrors([horizontalError * 8, altitudeError * 15, horizontalVelocity * 3, tilt]),
    hint: inZone ? 'Hold the zone and let velocity settle before making the next correction.' : 'Climb into the green hover target above the takeoff pad.',
  })
}

function segmentDistance2d(point: Vector3, start: Vector3, end: Vector3): number {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared <= 1e-8) return horizontalDistance(point, start)
  const projection = clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, -0.25, 1.25)
  return Math.hypot(point.x - (start.x + projection * dx), point.z - (start.z + projection * dz))
}

function evaluateCoordinatedTurn(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  const guard = guardSample(sample, context, 'turn-entry')
  if (guard) return guard
  const entry = reference(context, 'turn-entry')
  const apex = reference(context, 'turn-apex')
  const exit = reference(context, 'turn-exit')
  if (!entry || !apex || !exit) {
    return safeEvaluation('failure', {}, { message: 'The ordered turn route is unavailable.' })
  }

  const current = sample.state.positionM
  const entryToApex = horizontalUnit({ x: apex.positionM.x - entry.positionM.x, y: 0, z: apex.positionM.z - entry.positionM.z }) ?? { x: 1, y: 0, z: 0 }
  const apexToExit = horizontalUnit({ x: exit.positionM.x - apex.positionM.x, y: 0, z: exit.positionM.z - apex.positionM.z }) ?? { x: 0, y: 0, z: 1 }
  const motion = motionDirection(sample)
  const heading = headingRadians(motion)
  const storedEntryHeading = metric(context, 'entryHeadingRad', Number.NaN)
  const entryHeadingReady = metric(context, 'entryHeadingReady', Number.isFinite(storedEntryHeading) ? 1 : 0) > 0.5
  const entryHeading = entryHeadingReady ? storedEntryHeading : Number.NaN
  const hasEntry = context.checkpoints['turn-entry']?.completed === true
  const currentEntryCandidate = horizontalDistance(current, entry.positionM) <= 2.2
    && Math.abs(current.y - entry.positionM.y) <= 1.4
    && horizontalSpeed(sample) >= 1.2
    && motion.x * entryToApex.x + motion.z * entryToApex.z >= 0.15
  const nextEntryHeading = Number.isFinite(entryHeading)
    ? entryHeading
    : currentEntryCandidate
      ? heading
      : Number.NaN
  const actualHeadingChange = Number.isFinite(nextEntryHeading)
    ? headingDifferenceDegrees(heading, nextEntryHeading)
    : 0
  const nearApex = horizontalDistance(current, apex.positionM) <= 2.4
    && Math.abs(current.y - apex.positionM.y) <= 1.5
  const nearExit = horizontalDistance(current, exit.positionM) <= 2.4
    && Math.abs(current.y - exit.positionM.y) <= 1.5
  const corridorDistance = Math.min(
    segmentDistance2d(current, entry.positionM, apex.positionM),
    segmentDistance2d(current, apex.positionM, exit.positionM),
  )
  const routeActive = hasEntry || currentEntryCandidate
  const routeError = routeActive ? corridorDistance : 0
  const routeValid = routeError <= 3.2 && Math.abs(current.y - entry.positionM.y) <= 2.2
  const coordinatedAlignment = Math.max(
    motion.x * entryToApex.x + motion.z * entryToApex.z,
    motion.x * apexToExit.x + motion.z * apexToExit.z,
  )
  const checkpointIds = [
    ...(currentEntryCandidate ? ['turn-entry'] : []),
    ...(hasEntry && nearApex && horizontalSpeed(sample) >= 1.2 && actualHeadingChange >= 45 && routeValid ? ['turn-apex'] : []),
    ...(context.checkpoints['turn-apex']?.completed === true
      && nearExit
      && horizontalSpeed(sample) >= 1.2
      && actualHeadingChange >= 55
      && motion.x * apexToExit.x + motion.z * apexToExit.z >= 0.2
      && routeValid
      ? ['turn-exit']
      : []),
  ] as const
  const metrics = {
    entryErrorM: horizontalDistance(current, entry.positionM),
    apexErrorM: horizontalDistance(current, apex.positionM),
    exitErrorM: horizontalDistance(current, exit.positionM),
    headingErrorDegrees: Number.isFinite(entryHeading) ? actualHeadingChange : 0,
    headingChangeDegrees: actualHeadingChange,
    routeCorridorErrorM: routeError,
    routeHeadingAlignment: finite(coordinatedAlignment),
    speedMps: speed(sample),
    lastHeadingRad: heading,
    entryHeadingRad: Number.isFinite(nextEntryHeading) ? nextEntryHeading : 0,
    entryHeadingReady: Number.isFinite(nextEntryHeading) ? 1 : 0,
    routeActive: routeActive ? 1 : 0,
  }
  if (pathGap(context, sample)) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'Turn telemetry contained a path gap or an impossible position jump.',
      hint: 'Keep fixed-step telemetry connected and fly the gates in order.',
    })
  }
  if (context.elapsedSeconds > 35) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      score: scoreFromErrors([routeError * 8, actualHeadingChange < 55 ? 30 : 0]),
      message: 'Turn attempt timed out before the ordered route was completed.',
      hint: 'Enter the first gate, look through the apex, and let the heading change come from the flight path.',
    })
  }
  if (routeActive && (!routeValid || speed(sample) > 45 || Math.abs(sample.state.velocityMps.y) > 12)) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'The turn left its corridor or exceeded the route energy envelope.',
      hint: 'Use a smoother coordinated line and keep altitude near the gate references.',
    })
  }
  const completedExit = checkpointIds.includes('turn-exit') || context.checkpoints['turn-exit']?.completed === true
  if (completedExit && context.elapsedSeconds >= 2) {
    return safeEvaluation('success', metrics, {
      checkpointIds,
      score: scoreFromErrors([
        metrics.exitErrorM * 8,
        metrics.routeCorridorErrorM * 5,
        Math.max(0, 55 - actualHeadingChange) * 0.6,
      ]),
      message: 'The ordered gates were flown with an actual trajectory heading change and aligned exit.',
    })
  }
  return safeEvaluation('continue', metrics, {
    checkpointIds,
    score: scoreFromErrors([routeError * 6, Math.max(0, 45 - actualHeadingChange) * 0.4]),
    hint: context.checkpoints['turn-entry']?.completed
      ? 'Carry the line through the apex; the heading change must come from position and velocity, not stick timing.'
      : 'Reach the turn-entry gate with the nose and velocity pointed into the route.',
  })
}

function evaluateSplitS(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  const guard = guardSample(sample, context, 'split-s-reference')
  if (guard) return guard
  const splitReference = reference(context, 'split-s-reference')
  if (!splitReference) return safeEvaluation('failure', {}, { message: 'The Split-S reference is unavailable.' })

  const current = sample.state.positionM
  const motion = motionDirection(sample)
  const heading = headingRadians(motion)
  const storedEntryHeading = metric(context, 'entryHeadingRad', Number.NaN)
  const entryHeadingReady = metric(context, 'entryHeadingReady', Number.isFinite(storedEntryHeading) ? 1 : 0) > 0.5
  const entryHeading = entryHeadingReady ? storedEntryHeading : Number.NaN
  const nextEntryHeading = Number.isFinite(entryHeading) ? entryHeading : heading
  const headingChange = headingDifferenceDegrees(heading, nextEntryHeading)
  const up = bodyUp(sample).y
  const previousUp = context.previousSample ? bodyUp(context.previousSample).y : 1
  const uprightSeen = metric(context, 'uprightSeen', 0) > 0.5 || up >= 0.82 || previousUp >= 0.82
  const horizontalFromReference = horizontalDistance(current, splitReference.positionM)
  const entryDirection = horizontalUnit({
    x: splitReference.positionM.x - current.x,
    y: 0,
    z: splitReference.positionM.z - current.z,
  })
  const entryAlignment = entryDirection
    ? motion.x * entryDirection.x + motion.z * entryDirection.z
    : 1
  const entryCandidate = current.y >= 12
    && horizontalFromReference <= 18
    && speed(sample) >= 3
    && entryAlignment >= -0.2
  const hasEntry = context.checkpoints.entry?.completed === true
  const hasInverted = context.checkpoints.inverted?.completed === true
  const invertedCandidate = hasEntry
    && !hasInverted
    && uprightSeen
    && up <= -0.55
    && (previousUp > -0.25 || metric(context, 'inversionTransition', 0) > 0.5)
    && current.y >= 8
  const invertedAltitude = metric(context, 'invertedAltitudeM', current.y)
  const descentDistance = Math.max(0, invertedAltitude - current.y)
  const descendingCandidate = hasInverted
    && up <= 0.2
    && sample.state.velocityMps.y <= -1.5
    && descentDistance >= 0.8
    && current.y >= 3
  const hasDescent = context.checkpoints.descent?.completed === true
  const reversedCandidate = hasDescent
    && headingChange >= 110
    && horizontalSpeed(sample) >= 2.5
    && current.y < invertedAltitude - 1
  const hasReversed = context.checkpoints.reversed?.completed === true
  const recoveredCandidate = hasReversed
    && up >= 0.72
    && current.y >= 2
    && Math.abs(sample.state.velocityMps.y) <= 8
    && horizontalFromReference <= 25
    && headingChange >= 110
  const checkpointIds = [
    ...(entryCandidate ? ['entry'] : []),
    ...(invertedCandidate ? ['inverted'] : []),
    ...(descendingCandidate ? ['descent'] : []),
    ...(reversedCandidate ? ['reversed'] : []),
    ...(recoveredCandidate ? ['recovered'] : []),
  ] as const
  const metrics = {
    entryAltitudeM: current.y,
    invertedTiltDegrees: bodyTiltDegrees(sample),
    descentRateMps: -sample.state.velocityMps.y,
    headingChangeDegrees: headingChange,
    recoveryAltitudeErrorM: Math.abs(current.y - splitReference.positionM.y),
    positionErrorM: horizontalFromReference,
    speedMps: speed(sample),
    entryHeadingRad: Number.isFinite(entryHeading) || entryCandidate ? nextEntryHeading : 0,
    entryHeadingReady: Number.isFinite(entryHeading) || entryCandidate ? 1 : 0,
    invertedAltitudeM: invertedCandidate ? current.y : invertedAltitude,
    uprightSeen: uprightSeen ? 1 : 0,
    inversionTransition: invertedCandidate || metric(context, 'inversionTransition', 0) > 0.5 ? 1 : 0,
  }
  if (pathGap(context, sample)) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'Split-S telemetry contained a path gap or impossible position jump.',
      hint: 'Keep the fixed-step path continuous through the inversion and recovery.',
    })
  }
  if (context.elapsedSeconds > 35) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      score: scoreFromErrors([Math.max(0, 110 - headingChange) * 0.4, horizontalFromReference]),
      message: 'Split-S attempt timed out before level recovery.',
      hint: 'Start high, complete the inverted descending half-loop, then recover level.',
    })
  }
  if (current.y < 1 && !hasReversed && !recoveredCandidate) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'The Split-S descended below the recovery safety floor before reversing.',
      hint: 'Enter with more altitude and delay the recovery until the heading has reversed.',
    })
  }
  if (speed(sample) > 50 || Math.abs(sample.state.velocityMps.y) > 35 || horizontalFromReference > 40) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'The Split-S exceeded the altitude, speed, or position safety envelope.',
      hint: 'Use the available altitude to manage energy through the half-loop.',
    })
  }
  const recovered = recoveredCandidate || context.checkpoints.recovered?.completed === true
  if (recovered && context.elapsedSeconds >= 2) {
    return safeEvaluation('success', metrics, {
      checkpointIds,
      score: scoreFromErrors([
        Math.max(0, 12 - current.y) * 2,
        Math.max(0, 8 - headingChange) * 2,
        horizontalFromReference * 1.5,
        Math.abs(sample.state.velocityMps.y),
      ]),
      message: 'Split-S completed: altitude entry, actual inversion, descending half-loop, heading reversal, and upright recovery were verified.',
    })
  }
  return safeEvaluation('continue', metrics, {
    checkpointIds,
    score: scoreFromErrors([Math.max(0, 110 - headingChange) * 0.2, horizontalFromReference * 0.2]),
    hint: hasInverted
      ? hasDescent
        ? 'Reverse the heading through the descent, then recover upright with energy remaining.'
        : 'Keep descending through the inverted half-loop before asking for the heading reversal.'
      : hasEntry
        ? 'Roll fully inverted before descending; an upright U-turn does not count as a Split-S.'
        : 'Build enough altitude and speed for the entry before beginning the half-loop.',
  })
}

function evaluateOrbit(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  const guard = guardSample(sample, context, 'orbit-poi')
  if (guard) return guard
  const poi = reference(context, 'orbit-poi')
  if (!poi) return safeEvaluation('failure', {}, { message: 'The orbit point of interest is unavailable.' })

  const current = sample.state.positionM
  const relative = { x: current.x - poi.positionM.x, y: 0, z: current.z - poi.positionM.z }
  const radius = Math.hypot(relative.x, relative.z)
  const radiusError = Math.abs(radius - 10)
  const altitudeError = Math.abs(current.y - poi.positionM.y)
  const currentAngle = Math.atan2(relative.z, relative.x)
  const previousRelative = context.previousSample
    ? {
      x: context.previousSample.state.positionM.x - poi.positionM.x,
      y: 0,
      z: context.previousSample.state.positionM.z - poi.positionM.z,
    }
    : null
  const previousAngle = previousRelative && Math.hypot(previousRelative.x, previousRelative.z) > 0.5
    ? Math.atan2(previousRelative.z, previousRelative.x)
    : currentAngle
  const angleDelta = previousRelative ? wrappedAngle(currentAngle - previousAngle) : 0
  const orbitSpeed = horizontalSpeed(sample)
  const radialUnit = horizontalUnit(relative)
  const motion = motionDirection(sample)
  const radialRate = radialUnit
    ? sample.state.velocityMps.x * radialUnit.x + sample.state.velocityMps.z * radialUnit.z
    : 0
  const tangentCross = radialUnit ? radialUnit.x * motion.z - radialUnit.z * motion.x : 0
  let directionSign = metric(context, 'directionSign', 0)
  const tangent = directionSign === 0
    ? { x: -Math.sign(tangentCross || 1) * relative.z, y: 0, z: Math.sign(tangentCross || 1) * relative.x }
    : { x: -directionSign * relative.z, y: 0, z: directionSign * relative.x }
  const tangentHeadingError = cameraHeadingErrorDegrees(sample, tangent)
  const validEnvelope = radius >= 7.2
    && radius <= 12.8
    && altitudeError <= 1.5
    && orbitSpeed >= 1.5
    && orbitSpeed <= 18
    && Math.abs(sample.state.velocityMps.y) <= 5
    && tangentHeadingError <= 65
    && (radialUnit ? Math.abs(radialRate) <= 9 : false)
  const previousValid = metric(context, 'orbitValid', 0) > 0.5
  const validAngleDelta = previousValid && validEnvelope ? angleDelta : 0
  if (directionSign === 0 && previousValid && validEnvelope && Math.abs(angleDelta) >= 0.005) directionSign = Math.sign(angleDelta)
  const directedDelta = directionSign === 0 ? 0 : directionSign * validAngleDelta
  const orbitProgress = Math.max(0, metric(context, 'orbitProgress', 0) + directedDelta)
  const reversal = directionSign !== 0 && directedDelta < -0.02
  const directionReversals = metric(context, 'directionReversals', 0) + (reversal ? 1 : 0)
  const reverseRadians = metric(context, 'reverseRadians', 0) + Math.max(0, -directedDelta)
  const invalidSeconds = validEnvelope ? 0 : metric(context, 'invalidSeconds', 0) + deltaSeconds(context, sample)
  const stationarySeconds = orbitSpeed < 0.5
    ? metric(context, 'stationarySeconds', 0) + deltaSeconds(context, sample)
    : 0
  const pathLength = metric(context, 'pathLengthM', 0)
    + (context.previousSample ? distance3d(current, context.previousSample.state.positionM) : 0)
  const checkpointIds = [
    ...(validEnvelope ? ['orbit-entry'] : []),
    ...(validEnvelope && orbitProgress >= TWO_PI ? ['orbit-lap'] : []),
    ...(validEnvelope && context.checkpoints['orbit-lap']?.completed === true && orbitProgress >= TWO_PI
      ? ['orbit-exit']
      : []),
  ] as const
  const metrics = {
    radialErrorM: radiusError,
    altitudeErrorM: altitudeError,
    orbitRadiusM: radius,
    orbitSpeedMps: orbitSpeed,
    headingErrorDegrees: tangentHeadingError,
    cameraHeadingErrorDegrees: tangentHeadingError,
    tangentAlignment: finite(Math.cos(tangentHeadingError / DEG)),
    radialRateMps: finite(radialRate),
    orbitProgress: finite(orbitProgress),
    directionSign: finite(directionSign),
    directionReversals: finite(directionReversals),
    reverseRadians: finite(reverseRadians),
    invalidSeconds: finite(invalidSeconds),
    stationarySeconds: finite(stationarySeconds),
    orbitValid: validEnvelope ? 1 : 0,
    pathLengthM: finite(pathLength),
    lastAngleRad: finite(currentAngle),
  }
  if (pathGap(context, sample, 0.3, 8, 40)) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'Orbit telemetry contained a path gap or teleport; geometric lap progress was discarded.',
      hint: 'Keep fixed-step samples continuous and fly the radius instead of jumping between points.',
    })
  }
  if (directionReversals >= 3 || reverseRadians > 0.55) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'The orbit direction oscillated instead of completing one directed geometric lap.',
      hint: 'Choose one direction around the tower and keep the tangent line smooth.',
    })
  }
  if (!context.checkpoints['orbit-entry']?.completed && stationarySeconds > 3) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'The orbit stayed nearly stationary; yaw-in-place cannot establish a geometric lap.',
      hint: 'Translate around the tower with real lateral speed before turning the camera.',
    })
  }
  if (context.elapsedSeconds > 45) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      score: scoreFromErrors([radiusError * 8, altitudeError * 8, tangentHeadingError * 0.25]),
      message: 'Orbit attempt timed out before a directed lap was completed.',
      hint: 'Use a steady radius, altitude, speed, and camera heading around the POI.',
    })
  }
  if (invalidSeconds > 1.2) {
    return safeEvaluation('failure', metrics, {
      checkpointIds,
      message: 'Orbit radius, altitude, speed, or heading stayed outside the valid envelope too long.',
      hint: 'Keep the point of interest in a steady camera reference while preserving speed.',
    })
  }
  const lapComplete = context.checkpoints['orbit-lap']?.completed === true
  const exitComplete = context.checkpoints['orbit-exit']?.completed === true
  if (lapComplete && exitComplete && context.elapsedSeconds >= 8) {
    return safeEvaluation('success', metrics, {
      checkpointIds,
      score: scoreFromErrors([
        radiusError * 6,
        altitudeError * 8,
        Math.max(0, tangentHeadingError - 20) * 0.5,
        Math.max(0, orbitSpeed - 14) * 1.5,
      ]),
      message: 'Orbit completed as one directed geometric lap with valid radius, height, speed, and camera heading.',
    })
  }
  return safeEvaluation('continue', metrics, {
    checkpointIds,
    score: scoreFromErrors([
      radiusError * 5,
      altitudeError * 6,
      Math.max(0, tangentHeadingError - 20) * 0.25,
      directionReversals * 12,
    ]),
    hint: directionSign === 0
      ? 'Enter the orbit with real lateral motion; yawing in place does not establish a lap direction.'
      : lapComplete
        ? 'Hold the valid envelope for one more stable sample to finish the orbit exit.'
        : 'Keep one direction, approximately ten metres of radius, and the POI in the camera heading.',
  })
}

export { evaluateHover, evaluateCoordinatedTurn, evaluateSplitS, evaluateOrbit }

export const hoverEvaluator: LessonEvaluatorContract = { evaluate: evaluateHover }
export const coordinatedTurnEvaluator: LessonEvaluatorContract = { evaluate: evaluateCoordinatedTurn }
export const splitSEvaluator: LessonEvaluatorContract = { evaluate: evaluateSplitS }
export const orbitEvaluator: LessonEvaluatorContract = { evaluate: evaluateOrbit }

export const HOVER_EVALUATOR = hoverEvaluator
export const COORDINATED_TURN_EVALUATOR = coordinatedTurnEvaluator
export const SPLIT_S_EVALUATOR = splitSEvaluator
export const ORBIT_EVALUATOR = orbitEvaluator
