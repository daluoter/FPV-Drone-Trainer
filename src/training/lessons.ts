import { LANDING_LESSON } from './landing'
import { STRAIGHT_LINE_LESSON } from './straightLine'
import { DIRECTION_CONTROL_LESSON } from './directionControl'
import { COORDINATED_TURN_LESSON } from './coordinatedTurn'
import { SQUARE_ROUTE_LESSON } from './squareRoute'
import { FIGURE_EIGHT_LESSON } from './figureEight'
import {
  hoverEvaluator,
  orbitEvaluator,
  splitSEvaluator,
} from './evaluators'
import { takeoffEvaluator } from './takeoff'
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

/** Keep existing lesson order/IDs stable; learning order is determined by priority. */
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
  COORDINATED_TURN_LESSON,
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
  phase7Lesson({
    id: 'takeoff',
    priority: 0,
    title: '穩定起飛',
    description: '從起飛墊緩慢垂直離地，在墊上方 2 公尺的目標高度連續穩住。',
    objectives: [
      '從起飛墊附近的低高度、水平狀態開始，確認解鎖後才評估。',
      '控制上升速度，避免過度側移、傾斜或衝高。',
      '在目標高度附近連續穩住 1.5 秒，速度與姿態都要穩定。',
    ],
    setup: lessonSetup(['takeoff-pad']),
    checkpoints: [
      { id: 'takeoff-ready', title: '起飛前準備', description: '在起飛墊附近保持低高度、低速度與水平姿態。' },
      { id: 'takeoff-liftoff', title: '垂直離地', description: '實際離開起飛墊，緩慢上升且保持水平位置。' },
      { id: 'takeoff-settle', title: '目標高度穩住', description: '在起飛墊上方 2 公尺附近，以低速度、低傾角連續停留 1.5 秒。' },
    ],
    success: {
      title: '穩定起飛完成',
      description: '已觀察到從起飛墊起飛、上升及連續穩定停留；不以搖桿動作代替實際飛行。',
      criteria: ['從起飛墊附近起飛', '受控的高度、漂移、速度與傾角', '目標高度連續穩住 1.5 秒'],
    },
    failure: {
      title: '起飛尚未穩住',
      description: '此次起飛尚未在安全範圍內完成目標高度的連續穩定停留。',
      criteria: ['不能從空中直接開始', '不能墜毀、解除解鎖或瞬移', '不能過度側移、傾斜或衝高'],
    },
    scoring: {
      maxScore: 100,
      minimumPassingScore: 70,
      minimumActiveSeconds: 3,
      metricLabels: ['altitudeM', 'altitudeErrorM', 'horizontalDriftM', 'horizontalSpeedMps', 'verticalSpeedMps', 'maxTiltDegrees', 'contiguousDwellSeconds'],
    },
    hints: ['先把油門當作上升與下降速度的微調，接近目標時提早減少上升速度。門檻為模擬器原型訓練設定。'],
    evaluator: takeoffEvaluator,
  }),
  LANDING_LESSON,
  STRAIGHT_LINE_LESSON,
  DIRECTION_CONTROL_LESSON,
  SQUARE_ROUTE_LESSON,
  FIGURE_EIGHT_LESSON,
]

export const TRAINING_LESSONS = DEFAULT_LESSONS

export function lessonById(lessonId: string): LessonDefinition | null {
  return DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId) ?? null
}
