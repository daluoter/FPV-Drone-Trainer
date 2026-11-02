import { isFiniteVector3, type Vector3 } from '../math/vector'
import type { StaticBoxCollider } from '../simulation/obstacles'

export const SLALOM_FLAG_IDS = Object.freeze([
  'slalom-flag-1', 'slalom-flag-2', 'slalom-flag-3',
  'slalom-flag-4', 'slalom-flag-5', 'slalom-flag-6',
] as const)
export const SLALOM_FLAG_DISTANCES_M = Object.freeze([16, 28, 40, 52, 64, 76] as const)
export const SLALOM_FLAG_HEIGHT_M = 8
export const SLALOM_FLAG_WIDTH_M = 0.6
export const SLALOM_FLAG_DEPTH_M = 0.24
export const SLALOM_TARGET_HEIGHT_M = 4
export const SLALOM_PASS_MIN_OFFSET_M = 1
export const SLALOM_PASS_MAX_OFFSET_M = 8
export const SLALOM_PASS_MIN_HEIGHT_M = 1
export const SLALOM_PASS_MAX_HEIGHT_M = 7
export const SLALOM_EXIT_DISTANCE_M = 8

export interface SlalomFlag {
  readonly id: typeof SLALOM_FLAG_IDS[number]
  readonly label: string
  readonly index: number
  readonly positionM: Vector3
  readonly side: 'left' | 'right'
  readonly passSideSign: -1 | 1
  readonly passPointM: Vector3
  readonly colliders: readonly StaticBoxCollider[]
}

export interface SlalomFlagCrossing {
  readonly fraction: number
  readonly positionM: Vector3
  readonly insidePassage: boolean
  readonly correctSide: boolean
  readonly heightValid: boolean
  /** Positive values lie on this flag's required passing side. */
  readonly sideOffsetM: number
  readonly altitudeM: number
}

/** A shared straight row of solid flags; passing sides alternate left/right. */
export function createSlalomFlags(launch: Vector3, groundHeightM: number): readonly SlalomFlag[] {
  if (!isFiniteVector3(launch) || !Number.isFinite(groundHeightM)) throw new RangeError('Slalom anchors must be finite.')
  return Object.freeze(SLALOM_FLAG_IDS.map((id, index) => {
    const passSideSign = index % 2 === 0 ? -1 : 1
    const side = passSideSign < 0 ? 'left' : 'right'
    const positionM = Object.freeze({ x: launch.x, y: groundHeightM + SLALOM_FLAG_HEIGHT_M / 2,
      z: launch.z - SLALOM_FLAG_DISTANCES_M[index] })
    const colliders = Object.freeze([Object.freeze({ id: `${id}-banner`, centerM: positionM,
      halfExtentsM: Object.freeze({ x: SLALOM_FLAG_WIDTH_M / 2, y: SLALOM_FLAG_HEIGHT_M / 2, z: SLALOM_FLAG_DEPTH_M / 2 }) })])
    return Object.freeze({ id, label: `第 ${index + 1} 面刀旗`, index, positionM, side, passSideSign,
      passPointM: Object.freeze({ x: launch.x + passSideSign * 4, y: groundHeightM + SLALOM_TARGET_HEIGHT_M, z: positionM.z }), colliders })
  }))
}

/** Continuous forward plane crossing, independent of pose and stick gestures. */
export function slalomFlagCrossing(before: Vector3, current: Vector3, flag: SlalomFlag): SlalomFlagCrossing | null {
  if (!isFiniteVector3(before) || !isFiniteVector3(current)
    || !(current.z < before.z && before.z >= flag.positionM.z && current.z <= flag.positionM.z)) return null
  const fraction = (flag.positionM.z - before.z) / (current.z - before.z)
  const positionM = { x: before.x + (current.x - before.x) * fraction,
    y: before.y + (current.y - before.y) * fraction, z: flag.positionM.z }
  const sideOffsetM = (positionM.x - flag.positionM.x) * flag.passSideSign
  const altitudeM = positionM.y - flag.positionM.y + SLALOM_FLAG_HEIGHT_M / 2
  const correctSide = sideOffsetM >= SLALOM_PASS_MIN_OFFSET_M - 1e-9 && sideOffsetM <= SLALOM_PASS_MAX_OFFSET_M + 1e-9
  const heightValid = altitudeM >= SLALOM_PASS_MIN_HEIGHT_M - 1e-9 && altitudeM <= SLALOM_PASS_MAX_HEIGHT_M + 1e-9
  return { fraction, positionM, insidePassage: correctSide && heightValid, correctSide, heightValid, sideOffsetM, altitudeM }
}
