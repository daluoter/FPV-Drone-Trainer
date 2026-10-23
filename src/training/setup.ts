import type { TrainingSceneReference, TrainingSetupRequest } from './types'

/** Resolve teaching heights from the same configured anchors used by scoring. */
export function prepareTrainingSetup(
  request: TrainingSetupRequest | null,
  references: readonly TrainingSceneReference[],
): TrainingSetupRequest | null {
  if (!request) return null
  if (request.lessonId === 'landing' || request.lessonId === 'straight-line' || request.lessonId === 'direction-control' || request.lessonId === 'coordinated-turn' || request.lessonId === 'square-route' || request.lessonId === 'figure-eight') {
    const launch = references.find((reference) => reference.id === 'training-launch')
    if (!launch) return request
    return {
      ...request,
      setup: { ...request.setup, spawnPositionM: { ...launch.positionM } },
    }
  }
  const spawn = request.setup.spawnPositionM
  const surface = references.find((reference) => reference.id === 'landing-surface')
  if (request.lessonId === 'split-s' && spawn && surface) {
    return { ...request, setup: { ...request.setup, spawnPositionM: { ...spawn, y: surface.positionM.y + spawn.y } } }
  }
  return request
}
