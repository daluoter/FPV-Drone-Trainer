import {
  coordinatedTurnEvaluator,
  hoverEvaluator,
  orbitEvaluator,
  splitSEvaluator,
} from './evaluators'
import type { LessonDefinition, LessonSetup } from './types'

const DEFAULT_SETUP: Omit<LessonSetup, 'sceneReferenceIds'> = {
  requiresDisarmed: true,
  resetSimulation: true,
}

const SPLIT_S_SPAWN = { x: 0, y: 25, z: 0 } as const
const SPLIT_S_ORIENTATION = { x: 0, y: 0, z: 0, w: 1 } as const

function lessonSetup(
  sceneReferenceIds: readonly string[],
  options: Pick<LessonSetup, 'spawnPositionM' | 'spawnOrientation'> = {},
): LessonSetup {
  return {
    ...DEFAULT_SETUP,
    sceneReferenceIds,
    ...(options.spawnPositionM ? { spawnPositionM: { ...options.spawnPositionM } } : {}),
    ...(options.spawnOrientation ? { spawnOrientation: { ...options.spawnOrientation } } : {}),
  }
}

function phase7Lesson(
  definition: Omit<LessonDefinition, 'availability' | 'available'>,
): LessonDefinition {
  return {
    ...definition,
    availability: 'available',
    available: true,
  }
}

/** Phase 7 owns exactly four state/trajectory lessons; no legacy replacement maneuvers are shipped. */
export const DEFAULT_LESSONS: readonly LessonDefinition[] = [
  phase7Lesson({
    id: 'hover',
    priority: 1,
    title: 'Hover',
    description: 'Establish and hold a bounded hover inside the elevated hover zone above the takeoff pad.',
    objectives: [
      'Reach the hover zone at its reference altitude.',
      'Hold a contiguous dwell with bounded position, velocity, and attitude.',
      'Finish settled with smooth, small corrections rather than a stick ritual.',
    ],
    setup: lessonSetup(['takeoff-pad', 'hover-zone']),
    checkpoints: [
      { id: 'enter-hover-zone', title: 'Enter hover zone', description: 'Reach the elevated hover-zone reference above the pad.' },
      { id: 'hold-hover', title: 'Hold hover', description: 'Remain inside the position, altitude, velocity, and attitude envelope.' },
      { id: 'settle-hover', title: 'Settle', description: 'Finish the contiguous dwell with bounded drift and smooth corrections.' },
    ],
    success: {
      title: 'Stable hover verified',
      description: 'The drone held the hover target continuously with bounded drift, altitude, velocity, and attitude.',
      criteria: ['Contiguous in-zone dwell', 'Horizontal and altitude tolerances', 'Settled velocity and attitude'],
    },
    failure: {
      title: 'Hover not held',
      description: 'The attempt did not complete a safe contiguous hover dwell.',
      criteria: ['No disarmed or reset telemetry', 'No unrecoverable envelope excursion', 'Finite fixed-step state'],
    },
    scoring: {
      maxScore: 100,
      minimumPassingScore: 70,
      minimumActiveSeconds: 3.2,
      metricLabels: [
        'altitudeErrorM',
        'horizontalDriftM',
        'horizontalSpeedMps',
        'verticalSpeedMps',
        'maxTiltDegrees',
        'contiguousDwellSeconds',
        'stickSmoothness',
      ],
    },
    hints: ['Enter the target gently, then let velocity settle before making the next correction.'],
    evaluator: hoverEvaluator,
  }),
  phase7Lesson({
    id: 'coordinated-turn',
    priority: 2,
    title: 'Coordinated Turn',
    description: 'Track the ordered turn-entry, apex, and exit references through a bounded route with real heading change.',
    objectives: [
      'Enter the route at the reference altitude and heading.',
      'Pass the apex inside the route corridor while the trajectory changes heading.',
      'Exit aligned with the second route leg without relying on an exact stick sequence.',
    ],
    setup: lessonSetup(['takeoff-pad', 'turn-entry', 'turn-apex', 'turn-exit']),
    checkpoints: [
      { id: 'turn-entry', title: 'Turn entry', description: 'Reach the entry reference with bounded speed and route alignment.' },
      { id: 'turn-apex', title: 'Turn apex', description: 'Pass the apex in order after an actual trajectory heading change.' },
      { id: 'turn-exit', title: 'Turn exit', description: 'Leave the route aligned with the exit leg and bounded altitude.' },
    ],
    success: {
      title: 'Coordinated turn verified',
      description: 'The ordered route was flown with a measured position/velocity heading change and aligned exit.',
      criteria: ['Ordered gate progression', 'Route corridor and altitude', 'Actual trajectory heading change'],
    },
    failure: {
      title: 'Turn route not completed',
      description: 'The route was out of order, disconnected, or left its bounded corridor.',
      criteria: ['Continuous fixed-step path', 'Entry before apex before exit', 'No stick-only pass'],
    },
    scoring: {
      maxScore: 100,
      minimumPassingScore: 70,
      minimumActiveSeconds: 2,
      metricLabels: [
        'entryErrorM',
        'apexErrorM',
        'exitErrorM',
        'headingChangeDegrees',
        'routeCorridorErrorM',
        'routeHeadingAlignment',
        'speedMps',
      ],
    },
    hints: ['Look through the route and keep altitude bounded while the heading changes from the flown line.'],
    evaluator: coordinatedTurnEvaluator,
  }),
  phase7Lesson({
    id: 'split-s',
    priority: 3,
    title: 'Split-S',
    description: 'Use the elevated Split-S reference to invert, descend through the half-loop, reverse heading, and recover level.',
    objectives: [
      'Enter from sufficient altitude with bounded speed and position.',
      'Pass through a real inverted transition and descending half-loop.',
      'Reverse heading and recover upright without an upright U-turn false positive.',
    ],
    setup: lessonSetup(['split-s-reference'], {
      spawnPositionM: SPLIT_S_SPAWN,
      spawnOrientation: SPLIT_S_ORIENTATION,
    }),
    checkpoints: [
      { id: 'entry', title: 'Entry', description: 'Reach the Split-S entry reference at sufficient altitude and energy.' },
      { id: 'inverted', title: 'Inverted', description: 'Pass through a measured inverted transition before descending.' },
      { id: 'descent', title: 'Descent', description: 'Descend through the inverted half-loop inside the safety envelope.' },
      { id: 'reversed', title: 'Reversed heading', description: 'Complete the heading reversal after the inverted descent.' },
      { id: 'recovered', title: 'Recovered', description: 'Recover upright with bounded altitude, speed, and position.' },
    ],
    success: {
      title: 'Split-S verified',
      description: 'Altitude entry, inversion, descending half-loop, heading reversal, and upright recovery were all observed.',
      criteria: ['Sufficient entry altitude', 'Actual inverted transition', 'Ordered reversal and recovery'],
    },
    failure: {
      title: 'Split-S not recovered',
      description: 'The maneuver missed a required attitude/energy phase or crossed the recovery safety floor.',
      criteria: ['Inversion before reversal', 'Descending half-loop', 'Finite bounded recovery'],
    },
    scoring: {
      maxScore: 100,
      minimumPassingScore: 70,
      minimumActiveSeconds: 2,
      metricLabels: [
        'entryAltitudeM',
        'invertedTiltDegrees',
        'descentRateMps',
        'headingChangeDegrees',
        'recoveryAltitudeErrorM',
        'positionErrorM',
        'speedMps',
      ],
    },
    hints: ['Start high, roll fully inverted, let the heading reverse through the descent, then recover level.'],
    evaluator: splitSEvaluator,
  }),
  phase7Lesson({
    id: 'orbit',
    priority: 4,
    title: 'Orbit / 刷鍋',
    description: 'Fly one directed geometric lap around the orbit tower while preserving radius, height, speed, and camera heading.',
    objectives: [
      'Enter the orbit at the reference height and approximately ten-metre radius.',
      'Hold one directed path with valid speed and tangent/camera relation.',
      'Complete a full unwrapped lap without teleport, yaw-in-place, or oscillatory partial arcs.',
    ],
    setup: lessonSetup(['takeoff-pad', 'orbit-poi']),
    checkpoints: [
      { id: 'orbit-entry', title: 'Orbit entry', description: 'Reach the POI orbit envelope with real lateral motion.' },
      { id: 'orbit-lap', title: 'Orbit lap', description: 'Complete one unwrapped directed geometric lap.' },
      { id: 'orbit-exit', title: 'Orbit exit', description: 'Hold a valid final sample with bounded radius, height, speed, and heading.' },
    ],
    success: {
      title: 'Orbit verified',
      description: 'One directed geometric lap was completed with valid radial, altitude, speed, and camera-heading statistics.',
      criteria: ['Unwrapped 2π progress', 'Valid radius/height/speed', 'Continuous tangent-directed path'],
    },
    failure: {
      title: 'Orbit not completed',
      description: 'The path did not make one valid directed lap around the POI.',
      criteria: ['No yaw-in-place pass', 'No oscillatory partial arc', 'No telemetry gap or teleport'],
    },
    scoring: {
      maxScore: 100,
      minimumPassingScore: 70,
      minimumActiveSeconds: 8,
      metricLabels: [
        'radialErrorM',
        'altitudeErrorM',
        'orbitRadiusM',
        'orbitSpeedMps',
        'headingErrorDegrees',
        'cameraHeadingErrorDegrees',
        'orbitProgress',
        'pathLengthM',
      ],
    },
    hints: ['Keep the POI in a steady camera reference while preserving one direction, radius, altitude, and speed.'],
    evaluator: orbitEvaluator,
  }),
]

export const TRAINING_LESSONS = DEFAULT_LESSONS

export function lessonById(lessonId: string): LessonDefinition | null {
  return DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId) ?? null
}
