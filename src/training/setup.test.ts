import { describe, expect, it } from 'vitest'
import { DEFAULT_LESSONS } from './lessons'
import { prepareTrainingSetup } from './setup'
import type { TrainingSetupRequest } from './types'
import { createGravityGate } from '../world/gravityGate'

function requestFor(lessonId: string): TrainingSetupRequest {
  return { lessonId, sessionId: 'setup-test', setup: DEFAULT_LESSONS.find((lesson) => lesson.id === lessonId)!.setup }
}

describe('reference-relative training setup', () => {
  it('starts ground-based lessons on supported ground independently of the elevated teaching pad', () => {
    const references = [
      { id: 'takeoff-pad', kind: 'pad', positionM: { x: 6, y: 5.5, z: -3 } },
      { id: 'training-launch', kind: 'pad', positionM: { x: 6, y: 5.05, z: -3 } },
    ]
    for (const lessonId of ['landing', 'straight-line', 'direction-control', 'coordinated-turn', 'square-route', 'figure-eight', 'basic-recovery', 'full-roll', 'full-flip', 'front-flip', 'back-flip', 'power-loop', 'split-s', 'orbit', 'backward-flight', 'reverse-orbit']) {
      const original = requestFor(lessonId)
      const before = JSON.stringify(original)
      expect(prepareTrainingSetup(original, references)?.setup.spawnPositionM).toEqual({ x: 6, y: 5.05, z: -3 })
      expect(JSON.stringify(original)).toBe(before)
    }
  })

  it('installs the visible L09 frames relative to a raised ground and shifted launch without mutating the request', () => {
    const request = requestFor('wide-gate')
    const original = JSON.stringify(request)
    const references = [
      { id: 'training-launch', kind: 'pad', positionM: { x: 6, y: 5.05, z: -3 } },
      { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: 5, z: 0 } },
    ]
    const prepared = prepareTrainingSetup(request, references)!
    expect(prepared.setup.spawnPositionM).toEqual(references[0].positionM)
    expect(prepared.setup.staticObstacles).toHaveLength(12)
    expect(prepared.setup.staticObstacles?.[0]).toMatchObject({ id: 'wide-gate-1-left-post', centerM: { x: expect.closeTo(3.89), y: expect.closeTo(7.61), z: -11 } })
    expect(JSON.stringify(request)).toBe(original)
    expect(prepareTrainingSetup(request, references.slice(0, 1))).toBe(request)
    expect(prepareTrainingSetup(request, references.slice(1))).toBe(request)
  })

  it('leaves default reset requests alone and waits for missing references', () => {
    const hover = requestFor('hover')
    expect(prepareTrainingSetup(hover, [])).toBe(hover)
    const landing = requestFor('landing')
    expect(prepareTrainingSetup(landing, [])).toBe(landing)
    expect(prepareTrainingSetup(null, [])).toBeNull()
  })

  it('prepares L19 only from explicit launch and ground anchors and installs the shared solid frame', () => {
    const request: TrainingSetupRequest = { lessonId: 'gravity-gate', sessionId: 'gravity-setup', setup: {
      requiresDisarmed: true, resetSimulation: true,
      sceneReferenceIds: ['training-launch', 'landing-surface', 'gravity-gate-frame'],
      spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
    } }
    const before = JSON.stringify(request)
    const references = [
      { id: 'training-launch', kind: 'pad', positionM: { x: 6, y: 5.05, z: -3 } },
      { id: 'landing-surface', kind: 'zone', positionM: { x: 0, y: 5, z: 0 } },
    ]
    const prepared = prepareTrainingSetup(request, references)!
    expect(prepared.setup.spawnPositionM).toEqual(references[0].positionM)
    expect(prepared.setup.spawnOrientation).toEqual({ x: 0, y: 0, z: 0, w: 1 })
    expect(prepared.setup.staticObstacles).toEqual(createGravityGate(references[0].positionM, 5).colliders)
    expect(prepared.setup.staticObstacles).toHaveLength(16)
    expect(JSON.stringify(request)).toBe(before)
    expect(prepareTrainingSetup(request, references.slice(0, 1))).toBe(request)
    expect(prepareTrainingSetup(request, references.slice(1))).toBe(request)
  })
})
