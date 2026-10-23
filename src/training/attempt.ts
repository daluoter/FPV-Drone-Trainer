/** Shared baseline for lessons whose approved goals have not changed. */
export const CURRENT_TRAINING_RULES_VERSION = 4

/** Use the current route-course rules while preserving the approved earlier goals. */
export function trainingRulesVersionForLesson(lessonId: string | null): 4 | 5 {
  return lessonId === 'coordinated-turn' || lessonId === 'square-route' ? 5 : CURRENT_TRAINING_RULES_VERSION
}

/** Conditions which must match before two attempts can share a progress view. */
export interface TrainingAttemptContext {
  readonly rulesVersion: 1 | 2 | 3 | 4 | 5
  readonly physicsVersion: 1
  readonly presetId: 'beginner' | 'standard' | 'custom'
  readonly settingsFingerprint: string
  readonly inputSource: 'controller' | 'keyboard'
  readonly mode: 'practice' | 'challenge'
  readonly assistance: 'none'
}

const CONTEXT_STORAGE_PREFIX = 'fpv-drone-trainer.training-progress.context.v1.'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new TypeError('Training settings must contain only finite JSON values.')
}

/**
 * Exact, deterministic settings identity. This intentionally retains canonical
 * JSON rather than a short hash, so unrelated settings cannot share progress
 * through a hash collision. It is not encryption or an artifact checksum.
 */
export function fingerprintTrainingSettings(settings: unknown): string {
  return `settings.v1:${canonicalJson(settings)}`
}

export function isTrainingAttemptContext(value: unknown): value is TrainingAttemptContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  return (context.rulesVersion === 1 || context.rulesVersion === 2 || context.rulesVersion === 3 || context.rulesVersion === 4 || context.rulesVersion === 5)
    && context.physicsVersion === 1
    && ['beginner', 'standard', 'custom'].includes(context.presetId as string)
    && typeof context.settingsFingerprint === 'string'
    && context.settingsFingerprint.startsWith('settings.v1:')
    && context.settingsFingerprint.length > 'settings.v1:'.length
    && ['controller', 'keyboard'].includes(context.inputSource as string)
    && ['practice', 'challenge'].includes(context.mode as string)
    && context.assistance === 'none'
}

export function copyTrainingAttemptContext(context: TrainingAttemptContext): TrainingAttemptContext {
  return {
    rulesVersion: context.rulesVersion,
    physicsVersion: context.physicsVersion,
    presetId: context.presetId,
    settingsFingerprint: context.settingsFingerprint,
    inputSource: context.inputSource,
    mode: context.mode,
    assistance: context.assistance,
  }
}

export function trainingAttemptContextKey(context: TrainingAttemptContext): string {
  if (!isTrainingAttemptContext(context)) throw new TypeError('Training attempt context is invalid.')
  return `${CONTEXT_STORAGE_PREFIX}${encodeURIComponent(canonicalJson(copyTrainingAttemptContext(context)))}`
}
