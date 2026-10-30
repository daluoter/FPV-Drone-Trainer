import { GRAVITY_GATE_LESSON } from './gravityGate'
import { LANDING_LESSON } from './landing'
import { STRAIGHT_LINE_LESSON } from './straightLine'
import { DIRECTION_CONTROL_LESSON } from './directionControl'
import { COORDINATED_TURN_LESSON } from './coordinatedTurn'
import { SQUARE_ROUTE_LESSON } from './squareRoute'
import { FIGURE_EIGHT_LESSON } from './figureEight'
import { WIDE_GATE_LESSON } from './wideGate'
import { BASIC_RECOVERY_LESSON } from './basicRecovery'
import { FULL_ROLL_LESSON } from './fullRoll'
import { BACK_FLIP_LESSON, FRONT_FLIP_LESSON, FULL_FLIP_LESSON } from './fullFlip'
import { POWER_LOOP_LESSON } from './powerLoop'
import { SPLIT_S_LESSON } from './splitS'
import { ORBIT_LESSON } from './orbit'
import { BACKWARD_FLIGHT_LESSON } from './backwardFlight'
import { REVERSE_ORBIT_LESSON } from './reverseOrbit'
import {
  hoverEvaluator,
} from './evaluators'
import { takeoffEvaluator } from './takeoff'
import type { LessonDefinition, LessonSetup } from './types'

const DEFAULT_SETUP: Omit<LessonSetup, 'sceneReferenceIds'> = {
  requiresDisarmed: true,
  resetSimulation: true,
}

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

/** Stable registry includes the retired hover lesson for historical data/evaluators. */
export const DEFAULT_LESSONS: readonly LessonDefinition[] = [
  phase7Lesson({
    id: 'hover',
    priority: 1,
    title: '定點懸停',
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
  SPLIT_S_LESSON,
  ORBIT_LESSON,
  phase7Lesson({
    id: 'takeoff',
    priority: 0,
    title: '起飛與定點懸停',
    description: '從起飛墊緩慢垂直離地，在墊上方 2 公尺附近完成定點懸停。',
    objectives: [
      '從起飛墊附近的低高度、水平狀態開始，確認解鎖後才評估。',
      '控制上升速度，避免過度側移、傾斜或衝高。',
      '在目標高度附近定點懸停 1.5 秒，位置、速度與姿態都要穩定。',
    ],
    setup: lessonSetup(['takeoff-pad']),
    checkpoints: [
      { id: 'takeoff-ready', title: '起飛前準備', description: '在起飛墊附近保持低高度、低速度與水平姿態。' },
      { id: 'takeoff-liftoff', title: '垂直離地', description: '實際離開起飛墊，緩慢上升且保持水平位置。' },
      { id: 'takeoff-settle', title: '定點懸停 1.5 秒', description: '在起飛墊上方 2 公尺附近，以低漂移、低速度與低傾角連續懸停 1.5 秒。' },
    ],
    success: {
      title: '起飛與定點懸停完成',
      description: '已觀察到從起飛墊起飛、上升及連續定點懸停；不以搖桿動作代替實際飛行。',
      criteria: ['從起飛墊附近起飛', '受控的高度、漂移、速度與傾角', '目標高度定點懸停 1.5 秒'],
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
  WIDE_GATE_LESSON,
  BASIC_RECOVERY_LESSON,
  FULL_ROLL_LESSON,
  FULL_FLIP_LESSON,
  FRONT_FLIP_LESSON,
  BACK_FLIP_LESSON,
  POWER_LOOP_LESSON,
  BACKWARD_FLIGHT_LESSON,
  REVERSE_ORBIT_LESSON,
  GRAVITY_GATE_LESSON,
]

/** Legacy hover and combined-flip definitions remain available only for history. */
export const LEARNING_LESSONS: readonly LessonDefinition[] = DEFAULT_LESSONS.filter((lesson) => lesson.id !== 'hover' && lesson.id !== 'full-flip')
export const TRAINING_LESSONS = LEARNING_LESSONS

export function lessonById(lessonId: string): LessonDefinition | null {
  return DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId) ?? null
}
