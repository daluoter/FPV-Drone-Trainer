import { clamp } from '../math/vector'
import type { MotorConfig, MotorState } from './types'

export function createMotorState(): MotorState {
  return { command: 0, targetThrustN: 0, actualThrustN: 0 }
}

export function clampMotorCommand(command: number): number {
  if (!Number.isFinite(command)) return 0
  return clamp(command, 0, 1)
}

/** Exact first-order motor response for a constant target during one timestep. */
export function advanceMotorState(
  previous: MotorState,
  command: number,
  config: MotorConfig,
  deltaSeconds: number,
): MotorState {
  const safeCommand = clampMotorCommand(command)
  const targetThrustN = safeCommand * config.maxThrustN
  if (deltaSeconds <= 0 || !Number.isFinite(deltaSeconds)) {
    return { command: safeCommand, targetThrustN, actualThrustN: previous.actualThrustN }
  }
  const response = 1 - Math.exp(-deltaSeconds / config.responseTimeConstantSeconds)
  const actualThrustN = previous.actualThrustN + (targetThrustN - previous.actualThrustN) * response
  return { command: safeCommand, targetThrustN, actualThrustN }
}

export function motorResponseFraction(deltaSeconds: number, timeConstantSeconds: number): number {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || !Number.isFinite(timeConstantSeconds) || timeConstantSeconds <= 0) {
    return Number.NaN
  }
  return 1 - Math.exp(-deltaSeconds / timeConstantSeconds)
}
