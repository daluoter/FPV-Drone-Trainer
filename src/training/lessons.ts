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

function comingSoonLesson(
  id: string,
  priority: number,
  title: string,
  description: string,
  objectives: readonly string[],
  setup: LessonSetup,
  checkpoints: LessonDefinition['checkpoints'],
  hints: readonly string[],
  metricLabels: readonly string[],
): LessonDefinition {
  return {
    id,
    priority,
    title,
    description,
    availability: 'coming-soon',
    available: false,
    objectives,
    setup,
    checkpoints,
    success: {
      title: 'Evaluator pending',
      description: 'A state and trajectory evaluator will define this lesson in Phase 7.',
      criteria: ['No result is produced until the evaluator contract is implemented.'],
    },
    failure: {
      title: 'Evaluator pending',
      description: 'This lesson cannot run before its geometric evaluator lands.',
      criteria: ['No failure is inferred from stick movement or UI state.'],
    },
    scoring: {
      maxScore: 100,
      minimumPassingScore: 70,
      minimumActiveSeconds: 0,
      metricLabels,
    },
    hints,
    evaluator: null,
  }
}

/**
 * Phase 6 owns the menu-facing lesson catalog only. The four evaluators remain
 * deliberately absent until Phase 7; these definitions cannot manufacture a
 * success from controller input or from elapsed time.
 */
export const DEFAULT_LESSONS: readonly LessonDefinition[] = [
  comingSoonLesson(
    'hover',
    1,
    'Hover',
    'Establish and hold a bounded hover inside the elevated hover zone above the takeoff pad.',
    [
      'Reach the hover zone at its reference altitude.',
      'Hold position and attitude inside the hover envelope.',
      'Exit and settle without leaving the bounded zone.',
    ],
    lessonSetup(['takeoff-pad', 'hover-zone']),
    [
      { id: 'enter-hover-zone', title: 'Enter hover zone', description: 'Reach the elevated hover-zone reference above the pad.' },
      { id: 'hold-hover', title: 'Hold hover', description: 'Remain inside the position, altitude, and attitude envelope.' },
      { id: 'settle-hover', title: 'Settle', description: 'Finish with bounded drift and a controlled reference altitude.' },
    ],
    ['Prioritize position and altitude before making small attitude corrections.'],
    ['altitudeErrorM', 'horizontalDriftM', 'maxTiltDegrees'],
  ),
  comingSoonLesson(
    'coordinated-turn',
    2,
    'Coordinated Turn',
    'Track the ordered turn-entry, apex, and exit references through a bounded 90-degree route.',
    [
      'Enter the route at the reference altitude and heading.',
      'Track the 90-degree apex with bounded lateral and altitude error.',
      'Exit aligned with the route and settle the turn.',
    ],
    lessonSetup(['takeoff-pad', 'turn-entry', 'turn-apex', 'turn-exit']),
    [
      { id: 'turn-entry', title: 'Turn entry', description: 'Reach the entry reference with bounded speed and altitude.' },
      { id: 'turn-apex', title: 'Turn apex', description: 'Pass the 90-degree apex inside the route corridor.' },
      { id: 'turn-exit', title: 'Turn exit', description: 'Leave the route aligned with the exit reference.' },
    ],
    ['Look through the route and keep altitude bounded while the heading changes.'],
    ['entryErrorM', 'apexErrorM', 'exitErrorM', 'headingErrorDegrees'],
  ),
  comingSoonLesson(
    'split-s',
    3,
    'Split-S',
    'Use the elevated split-S reference to invert, descend, reverse heading, and recover level.',
    [
      'Enter the split-S from sufficient altitude with bounded energy.',
      'Pass through the inverted and descending portions of the reference.',
      'Reverse heading and recover level without exceeding the safety envelope.',
    ],
    lessonSetup(['split-s-reference'], {
      spawnPositionM: SPLIT_S_SPAWN,
      spawnOrientation: SPLIT_S_ORIENTATION,
    }),
    [
      { id: 'entry', title: 'Entry', description: 'Reach the split-S entry reference at sufficient altitude.' },
      { id: 'inverted', title: 'Inverted', description: 'Pass through the inverted portion with bounded attitude.' },
      { id: 'descent', title: 'Descent', description: 'Descend through the reference plane without exceeding limits.' },
      { id: 'reversed', title: 'Reversed heading', description: 'Complete the heading reversal inside the geometric corridor.' },
      { id: 'recovered', title: 'Recovered', description: 'Recover level flight with bounded altitude and speed.' },
    ],
    ['Use the reference altitude for the entry; recovery quality matters more than speed.'],
    ['entryAltitudeM', 'invertedTiltDegrees', 'descentRateMps', 'headingChangeDegrees', 'recoveryAltitudeErrorM'],
  ),
  comingSoonLesson(
    'orbit',
    4,
    'Orbit / 刷鍋',
    'Fly a bounded orbit around the orbit point of interest while preserving altitude and heading flow.',
    [
      'Enter the orbit at the reference altitude and radius.',
      'Hold the desired approximately 10 m radius around the point of interest.',
      'Exit aligned with bounded altitude, speed, and radial error.',
    ],
    lessonSetup(['takeoff-pad', 'orbit-poi']),
    [
      { id: 'orbit-entry', title: 'Orbit entry', description: 'Reach the orbit point of interest at the reference altitude.' },
      { id: 'orbit-lap', title: 'Orbit lap', description: 'Maintain the desired radius and altitude through the orbit.' },
      { id: 'orbit-exit', title: 'Orbit exit', description: 'Exit aligned without exceeding radial or speed limits.' },
    ],
    ['Keep the point of interest in a steady reference position while preserving altitude.'],
    ['radialErrorM', 'altitudeErrorM', 'headingErrorDegrees', 'orbitProgress'],
  ),
]

export const TRAINING_LESSONS = DEFAULT_LESSONS

export function lessonById(lessonId: string): LessonDefinition | null {
  return DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId) ?? null
}
