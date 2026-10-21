import { STRAIGHT_LINE_HEIGHT_OFFSET_M } from './straightLine'
import type { TrainingSceneReference, TrainingSetupRequest } from './types'

/** Resolve teaching heights from the same configured anchors used by scoring. */
export function prepareTrainingSetup(
  request: TrainingSetupRequest | null,
  references: readonly TrainingSceneReference[],
): TrainingSetupRequest | null {
  if (!request) return null
  if (request.lessonId === 'landing' || request.lessonId === 'straight-line') {
    const pad = references.find((reference) => reference.id === 'takeoff-pad')
    if (!pad) return request
    return {
      ...request,
      setup: { ...request.setup, spawnPositionM: { ...pad.positionM, y: pad.positionM.y + STRAIGHT_LINE_HEIGHT_OFFSET_M } },
    }
  }
  const spawn = request.setup.spawnPositionM
  const surface = references.find((reference) => reference.id === 'landing-surface')
  if (request.lessonId === 'split-s' && spawn && surface) {
    return { ...request, setup: { ...request.setup, spawnPositionM: { ...spawn, y: surface.positionM.y + spawn.y } } }
  }
  return request
}
