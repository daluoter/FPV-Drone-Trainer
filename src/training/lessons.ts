import type { LessonDefinition, LessonSetup } from './types'

const DEFAULT_SETUP: LessonSetup = {
  requiresDisarmed: true,
  resetSimulation: true,
  sceneReferenceIds: ['takeoff-pad', 'marker-0', 'marker-1', 'marker-2', 'marker-3', 'gate'],
}

function comingSoonLesson(
  id: string,
  priority: number,
  title: string,
  description: string,
  objectives: readonly string[],
  checkpoints: LessonDefinition['checkpoints'],
  hints: readonly string[],
): LessonDefinition {
  return {
    id,
    priority,
    title,
    description,
    availability: 'coming-soon',
    available: false,
    objectives,
    setup: { ...DEFAULT_SETUP },
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
      metricLabels: ['elapsedSeconds', 'sampleCount', 'completedCheckpoints'],
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
    'stable-hover',
    1,
    'Stable hover',
    'Hold a controlled hover with measurable attitude, altitude, and drift limits.',
    [
      'Establish a safe lift-off without over-correcting.',
      'Keep attitude and horizontal drift inside the evaluator window.',
      'Settle back to the reference altitude before ending the attempt.',
    ],
    [
      { id: 'lift-off', title: 'Lift off', description: 'Leave the pad while maintaining a bounded attitude.' },
      { id: 'hold', title: 'Hold', description: 'Remain inside the hover position and attitude envelope.' },
      { id: 'settle', title: 'Settle', description: 'Return to a controlled reference altitude.' },
    ],
    ['Use small, early corrections; do not chase a drifting quad with full stick.'],
  ),
  comingSoonLesson(
    'straight-line',
    2,
    'Straight line',
    'Translate through a gate while preserving a bounded heading and lateral path.',
    [
      'Build speed with a measured pitch input.',
      'Cross the gate inside its geometric corridor.',
      'Reduce rate and finish without a hard correction.',
    ],
    [
      { id: 'launch', title: 'Launch', description: 'Leave the start reference with a controlled heading.' },
      { id: 'gate-entry', title: 'Gate entry', description: 'Enter the gate corridor with bounded lateral error.' },
      { id: 'gate-exit', title: 'Gate exit', description: 'Clear the gate without exceeding the failure envelope.' },
    ],
    ['Look through the gate and make one correction at a time.'],
  ),
  comingSoonLesson(
    'box-pattern',
    3,
    'Box pattern',
    'Fly four measured legs around the reference markers with clean corner transitions.',
    [
      'Use the environment references rather than stick timing alone.',
      'Turn at each corner while keeping altitude bounded.',
      'Close the pattern at the starting reference.',
    ],
    [
      { id: 'leg-one', title: 'Leg one', description: 'Reach the first reference marker.' },
      { id: 'leg-two', title: 'Leg two', description: 'Turn and reach the second reference marker.' },
      { id: 'leg-three', title: 'Leg three', description: 'Turn and reach the third reference marker.' },
      { id: 'leg-four', title: 'Leg four', description: 'Close the pattern at the start.' },
    ],
    ['Prioritize altitude and geometry before adding speed.'],
  ),
  comingSoonLesson(
    'figure-eight',
    4,
    'Figure eight',
    'Connect two reference points with a coordinated figure-eight trajectory.',
    [
      'Cross the center with a controlled heading change.',
      'Trace both loops inside the geometric corridor.',
      'Finish aligned with the exit reference.',
    ],
    [
      { id: 'first-loop', title: 'First loop', description: 'Complete the first loop around its reference.' },
      { id: 'crossing', title: 'Center crossing', description: 'Cross the center with bounded speed and altitude.' },
      { id: 'second-loop', title: 'Second loop', description: 'Complete the second loop and exit cleanly.' },
    ],
    ['Smooth coordinated inputs beat alternating full-stick commands.'],
  ),
]

export const TRAINING_LESSONS = DEFAULT_LESSONS

export function lessonById(lessonId: string): LessonDefinition | null {
  return DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId) ?? null
}
