import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { StaticBoxCollider } from '../simulation/obstacles'

export const GRAVITY_GATE_OPENING_WIDTH_M = 8
export const GRAVITY_GATE_OPENING_DEPTH_M = 8
export const GRAVITY_GATE_OPENING_HEIGHT_M = 10
export const GRAVITY_GATE_BOTTOM_HEIGHT_M = 4
export const GRAVITY_GATE_MIDDLE_HEIGHT_M = 9
export const GRAVITY_GATE_TOP_HEIGHT_M = GRAVITY_GATE_BOTTOM_HEIGHT_M + GRAVITY_GATE_OPENING_HEIGHT_M
export const GRAVITY_GATE_FORWARD_DISTANCE_M = 28
export const GRAVITY_GATE_FRAME_THICKNESS_M = 0.28

export type GravityGateSide = 'front' | 'right' | 'back' | 'left'

/** All bounds are the inner faces of the physical beams, never expanded scoring tolerances. */
export interface GravityGate {
  readonly id: 'gravity-gate-frame'
  readonly centerM: Vector3
  readonly topY: number
  /** Center height of the open middle ring, not a hidden solid floor. */
  readonly middleY: number
  readonly bottomY: number
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** Physical right boundary retained for existing coordinate consumers. */
  readonly exitX: number
  /** Default guidance returns through the front, positive-Z face. */
  readonly exitZ: number
  readonly lowerExitMinY: number
  /** The underside of the middle ring defines the lower exit's clear upper edge. */
  readonly lowerExitMaxY: number
  readonly approachPointM: Vector3
  readonly approachDirection: Vector3
  readonly exitDirection: Vector3
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
 * One immutable two-level, 16-beam field shared by rendering, setup,
 * demonstration and scoring. The open middle ring marks the two levels without
 * adding a floor. Four posts continue to the ground as visible support legs.
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
  const middleY = groundHeightM + GRAVITY_GATE_MIDDLE_HEIGHT_M
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
  for (const [level, y] of [['top', topY + halfBeam], ['middle', middleY], ['bottom', bottomY - halfBeam]] as const) {
    for (const [side, z] of [['far', minZ - halfBeam], ['near', maxZ + halfBeam]] as const) {
      box(`${level}-${side}-bar`, { x: centerM.x, y, z }, { x: outerWidth / 2, y: halfBeam, z: halfBeam })
    }
    for (const [side, x] of [['left', minX - halfBeam], ['right', maxX + halfBeam]] as const) {
      box(`${level}-${side}-bar`, { x, y, z: centerM.z }, { x: halfBeam, y: halfBeam, z: outerDepth / 2 })
    }
  }
  const lowerExitMaxY = middleY - halfBeam
  return Object.freeze({ id: 'gravity-gate-frame', centerM, topY, middleY, bottomY, minX, maxX, minZ, maxZ,
    exitX: maxX, exitZ: maxZ, lowerExitMinY: bottomY, lowerExitMaxY,
    approachPointM: Object.freeze({ x: centerM.x, y: groundHeightM + 8, z: centerM.z + 14 }),
    approachDirection: Object.freeze({ x: 0, y: 0, z: -1 }),
    exitDirection: Object.freeze({ x: 0, y: 0, z: 1 }),
    topEntryCenterM: Object.freeze({ x: centerM.x, y: topY, z: centerM.z }),
    sideExitCenterM: Object.freeze({ x: centerM.x, y: (bottomY + lowerExitMaxY) / 2, z: maxZ }),
    colliders: Object.freeze(boxes) })
}

function crossing(before: Vector3, current: Vector3, axis: 'x' | 'y' | 'z', plane: number, direction: -1 | 1): Omit<GravityGateCrossing, 'insideOpening'> | null {
  if (!isFiniteVector3(before) || !isFiniteVector3(current)
    || !((current[axis] - before[axis]) * direction > 0
      && (before[axis] - plane) * direction <= 0 && (current[axis] - plane) * direction >= 0)) return null
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
  const passage = crossing(before, current, 'y', gate.topY, -1)
  if (!passage) return null
  return { ...passage, insideOpening: clear(passage.positionM.x, gate.minX, gate.maxX, radiusM)
    && clear(passage.positionM.z, gate.minZ, gate.maxZ, radiusM) }
}

/** Downward passage into the lower level; only the perimeter ring is solid. */
export function gravityGateLowerCrossing(before: Vector3, current: Vector3, gate: GravityGate, radiusM = 0): GravityGateCrossing | null {
  if (!Number.isFinite(radiusM) || radiusM < 0) return null
  const passage = crossing(before, current, 'y', gate.lowerExitMaxY, -1)
  if (!passage) return null
  return { ...passage, insideOpening: clear(passage.positionM.x, gate.minX, gate.maxX, radiusM)
    && clear(passage.positionM.z, gate.minZ, gate.maxZ, radiusM) }
}

/** Last outside-footprint face, using the dominant normalized offset at corners. */
export function gravityGateApproachSide(point: Vector3, gate: GravityGate): GravityGateSide | null {
  if (!isFiniteVector3(point)) return null
  const x = (point.x - gate.centerM.x) / ((gate.maxX - gate.minX) / 2)
  const z = (point.z - gate.centerM.z) / ((gate.maxZ - gate.minZ) / 2)
  if (Math.abs(x) <= 1 && Math.abs(z) <= 1) return null
  return Math.abs(z) >= Math.abs(x) ? z >= 0 ? 'front' : 'back' : x >= 0 ? 'right' : 'left'
}

/** Low clear opening and outward normal for a recorded approach face. */
export function gravityGateSideExit(gate: GravityGate, side: GravityGateSide): {
  readonly centerM: Vector3
  readonly outwardDirection: Vector3
  readonly halfWidthM: number
} {
  const y = (gate.lowerExitMinY + gate.lowerExitMaxY) / 2
  switch (side) {
    case 'front': return { centerM: { x: gate.centerM.x, y, z: gate.maxZ }, outwardDirection: { x: 0, y: 0, z: 1 }, halfWidthM: (gate.maxX - gate.minX) / 2 }
    case 'back': return { centerM: { x: gate.centerM.x, y, z: gate.minZ }, outwardDirection: { x: 0, y: 0, z: -1 }, halfWidthM: (gate.maxX - gate.minX) / 2 }
    case 'right': return { centerM: { x: gate.maxX, y, z: gate.centerM.z }, outwardDirection: { x: 1, y: 0, z: 0 }, halfWidthM: (gate.maxZ - gate.minZ) / 2 }
    case 'left': return { centerM: { x: gate.minX, y, z: gate.centerM.z }, outwardDirection: { x: -1, y: 0, z: 0 }, halfWidthM: (gate.maxZ - gate.minZ) / 2 }
  }
}

/** Outward crossing of the recorded approach-side opening, below the middle ring. */
export function gravityGateExitCrossing(before: Vector3, current: Vector3, gate: GravityGate, radiusM = 0, side: GravityGateSide = 'front'): GravityGateCrossing | null {
  if (!Number.isFinite(radiusM) || radiusM < 0) return null
  const exit = gravityGateSideExit(gate, side)
  const axis = exit.outwardDirection.x === 0 ? 'z' : 'x'
  const transverse = axis === 'x' ? 'z' : 'x'
  const passage = crossing(before, current, axis, exit.centerM[axis], exit.outwardDirection[axis] as -1 | 1)
  if (!passage) return null
  return { ...passage, insideOpening: clear(passage.positionM[transverse], gate.centerM[transverse] - exit.halfWidthM, gate.centerM[transverse] + exit.halfWidthM, radiusM)
    && clear(passage.positionM.y, gate.lowerExitMinY, gate.lowerExitMaxY, radiusM) }
}
