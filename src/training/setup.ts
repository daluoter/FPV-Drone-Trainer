import { createWideGates } from '../world/wideGates'
import type { TrainingSceneReference, TrainingSetupRequest } from './types'

/** Resolve teaching heights from the same configured anchors used by scoring. */
export function prepareTrainingSetup(
  request: TrainingSetupRequest | null,
  references: readonly TrainingSceneReference[],
): TrainingSetupRequest | null {
  if (!request) return null
  if (request.lessonId === 'wide-gate') {
    const launch = references.find((reference) => reference.id === 'training-launch')
    const surface = references.find((reference) => reference.id === 'landing-surface')
    if (!launch || !surface) return request
    return { ...request, setup: { ...request.setup, spawnPositionM: { ...launch.positionM },
      staticObstacles: createWideGates(launch.positionM, surface.positionM.y).flatMap((gate) => gate.colliders) } }
  }
  if (request.lessonId === 'landing' || request.lessonId === 'straight-line' || request.lessonId === 'direction-control' || request.lessonId === 'coordinated-turn' || request.lessonId === 'square-route' || request.lessonId === 'figure-eight' || request.lessonId === 'basic-recovery' || request.lessonId === 'full-roll' || request.lessonId === 'full-flip' || request.lessonId === 'front-flip' || request.lessonId === 'back-flip' || request.lessonId === 'power-loop' || request.lessonId === 'split-s' || request.lessonId === 'orbit' || request.lessonId === 'backward-flight' || request.lessonId === 'reverse-orbit') {
    const launch = references.find((reference) => reference.id === 'training-launch')
    if (!launch) return request
    return {
      ...request,
      setup: { ...request.setup, spawnPositionM: { ...launch.positionM } },
    }
  }
  return request
}
