import { clamp } from '../math/vector'
import { DEFAULT_DRONE_CONFIG } from './config'
import type { DroneConfig, MixerCommand, QuadXMixResult } from './types'

/**
 * Motor order: front-left, front-right, rear-left, rear-right.
 * Coefficients add pilot-positive differential thrust to collective:
 * roll + => left motors, pitch + => front motors, yaw + => CCW motors.
 */
export const QUAD_X_MIXING_COEFFICIENTS = [
  { roll: 1, pitch: 1, yaw: 1 },
  { roll: -1, pitch: 1, yaw: -1 },
  { roll: 1, pitch: -1, yaw: -1 },
  { roll: -1, pitch: -1, yaw: 1 },
] as const

interface SanitizedCommand {
  readonly value: number
  readonly warning?: string
}

function sanitizeCommand(value: number, minimum: number, maximum: number, name: string): SanitizedCommand {
  if (!Number.isFinite(value)) return { value: 0, warning: `${name} command was non-finite and was replaced with zero.` }
  const clamped = clamp(value, minimum, maximum)
  if (clamped !== value) return { value: clamped, warning: `${name} command was clamped to its safe range.` }
  return { value }
}

function validWeight(value: number, name: string, warnings: string[]): number {
  if (!Number.isFinite(value) || value < 0) {
    warnings.push(`${name} mixer weight is invalid; zero authority was used.`)
    return 0
  }
  return value
}

/**
 * Allocate a collective plus pilot-axis commands to four normalized thrust
 * commands. When the requested range exceeds [0, 1], all motors are affine
 * rescaled together so differential direction is preserved instead of
 * independently clipping one corner of the quad.
 */
export function mixQuadX(
  command: MixerCommand,
  config: DroneConfig = DEFAULT_DRONE_CONFIG,
): QuadXMixResult {
  const warnings: string[] = []
  const throttle = sanitizeCommand(command.throttle, 0, 1, 'Throttle')
  const roll = sanitizeCommand(command.roll, -1, 1, 'Roll')
  const pitch = sanitizeCommand(command.pitch, -1, 1, 'Pitch')
  const yaw = sanitizeCommand(command.yaw, -1, 1, 'Yaw')
  for (const result of [throttle, roll, pitch, yaw]) {
    if (result.warning) warnings.push(result.warning)
  }

  const rollWeight = validWeight(config.mixer.rollWeight, 'Roll', warnings)
  const pitchWeight = validWeight(config.mixer.pitchWeight, 'Pitch', warnings)
  const yawWeight = validWeight(config.mixer.yawWeight, 'Yaw', warnings)
  const raw = QUAD_X_MIXING_COEFFICIENTS.map((coefficient) => (
    throttle.value +
    coefficient.roll * roll.value * rollWeight +
    coefficient.pitch * pitch.value * pitchWeight +
    coefficient.yaw * yaw.value * yawWeight
  )) as [number, number, number, number]

  const minimum = Math.min(...raw)
  const maximum = Math.max(...raw)
  const span = maximum - minimum
  let saturated = warnings.length > 0 || raw.some((value) => value < 0 || value > 1)
  let commands: [number, number, number, number]

  if (span > 1) {
    commands = raw.map((value) => (value - minimum) / span) as [number, number, number, number]
    saturated = true
  } else {
    const shift = minimum < 0 ? -minimum : maximum > 1 ? 1 - maximum : 0
    commands = raw.map((value) => clamp(value + shift, 0, 1)) as [number, number, number, number]
  }

  if (saturated && !warnings.some((warning) => warning.includes('saturated'))) {
    warnings.push('Motor allocation saturated; differential authority was preserved where possible.')
  }

  return {
    rawCommands: raw,
    commands,
    saturated,
    warnings,
  }
}
