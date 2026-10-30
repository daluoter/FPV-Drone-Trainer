import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { StaticBoxCollider } from '../simulation/obstacles'

export const GRAVITY_GATE_OPENING_WIDTH_M = 14
export const GRAVITY_GATE_OPENING_DEPTH_M = 14
export const GRAVITY_GATE_OPENING_HEIGHT_M = 14
export const GRAVITY_GATE_BOTTOM_HEIGHT_M = 10
export const GRAVITY_GATE_TOP_HEIGHT_M = GRAVITY_GATE_BOTTOM_HEIGHT_M + GRAVITY_GATE_OPENING_HEIGHT_M
export const GRAVITY_GATE_FORWARD_DISTANCE_M = 40
export const GRAVITY_GATE_FRAME_THICKNESS_M = 0.35

/** All bounds are the inner faces of the physical beams, never expanded scoring tolerances. */
export interface GravityGate {
  readonly id: 'gravity-gate-frame'
  readonly centerM: Vector3
  readonly topY: number
  readonly bottomY: number
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** The far, negative-Z face is the explicitly marked side exit. */
  readonly exitZ: number
  readonly topEntryCenterM: Vector3
  readonly sideExitCenterM: Vector3
  readonly colliders: readonly StaticBoxCollider[]
}

export interface GravityGateCrossing {
  readonly fraction: number
  readonly positionM: Vector3
  readonly insideOpening: boolean
}

/**
 * One immutable 12-beam field shared by rendering, setup, demonstration and
 * scoring. Beams sit outside the stated clear volume, leaving its top and side
 * genuinely open. Four posts continue to the ground as visible support legs.
 */
export function createGravityGate(launch: Vector3, groundHeightM: number): GravityGate {
  if (!isFiniteVector3(launch) || !Number.isFinite(groundHeightM)) {
    throw new RangeError('Gravity gate anchors must be finite.')
  }
  const centerM = Object.freeze({ x: launch.x,
    y: groundHeightM + (GRAVITY_GATE_BOTTOM_HEIGHT_M + GRAVITY_GATE_TOP_HEIGHT_M) / 2,
    z: launch.z - GRAVITY_GATE_FORWARD_DISTANCE_M })
  const minX = centerM.x - GRAVITY_GATE_OPENING_WIDTH_M / 2
  const maxX = centerM.x + GRAVITY_GATE_OPENING_WIDTH_M / 2
  const minZ = centerM.z - GRAVITY_GATE_OPENING_DEPTH_M / 2
  const maxZ = centerM.z + GRAVITY_GATE_OPENING_DEPTH_M / 2
  const bottomY = groundHeightM + GRAVITY_GATE_BOTTOM_HEIGHT_M
  const topY = groundHeightM + GRAVITY_GATE_TOP_HEIGHT_M
  const halfBeam = GRAVITY_GATE_FRAME_THICKNESS_M / 2
  const outerWidth = GRAVITY_GATE_OPENING_WIDTH_M + 2 * GRAVITY_GATE_FRAME_THICKNESS_M
  const outerDepth = GRAVITY_GATE_OPENING_DEPTH_M + 2 * GRAVITY_GATE_FRAME_THICKNESS_M
  const boxes: StaticBoxCollider[] = []
  const box = (part: string, center: Vector3, halfExtentsM: Vector3): void => {
    boxes.push(Object.freeze({ id: `gravity-gate-${part}`, centerM: Object.freeze(center), halfExtentsM: Object.freeze(halfExtentsM) }))
  }
  for (const [xSide, x] of [['left', minX - halfBeam], ['right', maxX + halfBeam]] as const) {
    for (const [zSide, z] of [['far', minZ - halfBeam], ['near', maxZ + halfBeam]] as const) {
      box(`${xSide}-${zSide}-post`, { x, y: groundHeightM + (GRAVITY_GATE_TOP_HEIGHT_M + GRAVITY_GATE_FRAME_THICKNESS_M) / 2, z },
        { x: halfBeam, y: (GRAVITY_GATE_TOP_HEIGHT_M + GRAVITY_GATE_FRAME_THICKNESS_M) / 2, z: halfBeam })
    }
  }
  for (const [level, y] of [['top', topY + halfBeam], ['bottom', bottomY - halfBeam]] as const) {
    for (const [side, z] of [['far', minZ - halfBeam], ['near', maxZ + halfBeam]] as const) {
      box(`${level}-${side}-bar`, { x: centerM.x, y, z }, { x: outerWidth / 2, y: halfBeam, z: halfBeam })
    }
    for (const [side, x] of [['left', minX - halfBeam], ['right', maxX + halfBeam]] as const) {
      box(`${level}-${side}-bar`, { x, y, z: centerM.z }, { x: halfBeam, y: halfBeam, z: outerDepth / 2 })
    }
  }
  return Object.freeze({ id: 'gravity-gate-frame', centerM, topY, bottomY, minX, maxX, minZ, maxZ, exitZ: minZ,
    topEntryCenterM: Object.freeze({ x: centerM.x, y: topY, z: centerM.z }),
    sideExitCenterM: Object.freeze({ x: centerM.x, y: centerM.y, z: minZ }),
    colliders: Object.freeze(boxes) })
}

function crossing(before: Vector3, current: Vector3, axis: 'y' | 'z', plane: number): Omit<GravityGateCrossing, 'insideOpening'> | null {
  if (!isFiniteVector3(before) || !isFiniteVector3(current)
    || !(current[axis] < before[axis] && before[axis] >= plane && current[axis] <= plane)) return null
  const fraction = (plane - before[axis]) / (current[axis] - before[axis])
  return { fraction, positionM: {
    x: before.x + (current.x - before.x) * fraction,
    y: before.y + (current.y - before.y) * fraction,
    z: before.z + (current.z - before.z) * fraction,
  } }
}

function clear(value: number, minimum: number, maximum: number, radiusM: number): boolean {
  // Touching the expanded frame is a collision in the shared physics sweep.
  return value > minimum + radiusM && value < maximum - radiusM
}

/** Downward crossing of the top inner-face plane, with the full body envelope clear of all four edges. */
export function gravityGateTopCrossing(before: Vector3, current: Vector3, gate: GravityGate, radiusM = 0): GravityGateCrossing | null {
  if (!Number.isFinite(radiusM) || radiusM < 0) return null
  const passage = crossing(before, current, 'y', gate.topY)
  if (!passage) return null
  return { ...passage, insideOpening: clear(passage.positionM.x, gate.minX, gate.maxX, radiusM)
    && clear(passage.positionM.z, gate.minZ, gate.maxZ, radiusM) }
}

/** Outward crossing of the marked negative-Z side, using the same inner faces and body clearance as the top. */
export function gravityGateExitCrossing(before: Vector3, current: Vector3, gate: GravityGate, radiusM = 0): GravityGateCrossing | null {
  if (!Number.isFinite(radiusM) || radiusM < 0) return null
  const passage = crossing(before, current, 'z', gate.exitZ)
  if (!passage) return null
  return { ...passage, insideOpening: clear(passage.positionM.x, gate.minX, gate.maxX, radiusM)
    && clear(passage.positionM.y, gate.bottomY, gate.topY, radiusM) }
}
