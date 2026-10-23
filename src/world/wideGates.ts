import type { Vector3 } from '../math/vector'
import type { StaticBoxCollider } from '../simulation/obstacles'

export const WIDE_GATE_OPENING_WIDTH_M = 4
export const WIDE_GATE_OPENING_HEIGHT_M = 4
export const WIDE_GATE_FRAME_THICKNESS_M = 0.22
export const WIDE_GATE_FRAME_DEPTH_M = 0.35
export const WIDE_GATE_TARGET_HEIGHT_AGL_M = 3
export const WIDE_GATE_DISTANCES_M = Object.freeze([8, 16, 24] as const)
export const WIDE_GATE_IDS = Object.freeze(['wide-gate-1', 'wide-gate-2', 'wide-gate-3'] as const)

export interface WideGate {
  readonly id: typeof WIDE_GATE_IDS[number]
  readonly label: string
  readonly positionM: Vector3
  readonly openingWidthM: number
  readonly openingHeightM: number
  readonly colliders: readonly StaticBoxCollider[]
}

/** Shared physical frame and visible opening; no renderer or flight state is involved. */
export function createWideGates(launch: Vector3, groundHeightM: number): readonly WideGate[] {
  const halfWidth = WIDE_GATE_OPENING_WIDTH_M / 2
  const halfHeight = WIDE_GATE_OPENING_HEIGHT_M / 2
  const halfThickness = WIDE_GATE_FRAME_THICKNESS_M / 2
  const halfDepth = WIDE_GATE_FRAME_DEPTH_M / 2
  const frameTop = WIDE_GATE_TARGET_HEIGHT_AGL_M + halfHeight + WIDE_GATE_FRAME_THICKNESS_M
  return Object.freeze(WIDE_GATE_IDS.map((id, index) => {
    const positionM = Object.freeze({ x: launch.x, y: groundHeightM + WIDE_GATE_TARGET_HEIGHT_AGL_M, z: launch.z - WIDE_GATE_DISTANCES_M[index] })
    const box = (part: string, centerM: Vector3, halfExtentsM: Vector3): StaticBoxCollider => Object.freeze({
      id: `${id}-${part}`, centerM: Object.freeze(centerM), halfExtentsM: Object.freeze(halfExtentsM),
    })
    const colliders = Object.freeze([
      box('left-post', { x: positionM.x - halfWidth - halfThickness, y: groundHeightM + frameTop / 2, z: positionM.z }, { x: halfThickness, y: frameTop / 2, z: halfDepth }),
      box('right-post', { x: positionM.x + halfWidth + halfThickness, y: groundHeightM + frameTop / 2, z: positionM.z }, { x: halfThickness, y: frameTop / 2, z: halfDepth }),
      box('top-bar', { x: positionM.x, y: positionM.y + halfHeight + halfThickness, z: positionM.z }, { x: halfWidth + WIDE_GATE_FRAME_THICKNESS_M, y: halfThickness, z: halfDepth }),
      box('bottom-bar', { x: positionM.x, y: positionM.y - halfHeight - halfThickness, z: positionM.z }, { x: halfWidth + WIDE_GATE_FRAME_THICKNESS_M, y: halfThickness, z: halfDepth }),
    ])
    return Object.freeze({ id, label: `第 ${index + 1} 道寬門`, positionM, openingWidthM: WIDE_GATE_OPENING_WIDTH_M, openingHeightM: WIDE_GATE_OPENING_HEIGHT_M, colliders })
  }))
}
