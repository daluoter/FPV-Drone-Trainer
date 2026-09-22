import { clamp } from '../math/vector'
import type { NormalizedRcInput } from '../flight-controller'

const CONTROL_KEYS = new Set(['w', 's', 'a', 'd', 'q', 'e', 'r', 'f'])

/**
 * Explicit developer-only RC source. Keys produce normalized channels and are
 * fed through the same rates/PID/simulation path as a calibrated controller.
 * This class never writes a pose or an attitude; `x` only requests runtime
 * reset so the normal simulation reset path remains authoritative.
 */
export class DeveloperKeyboardInput {
  private readonly pressed = new Set<string>()
  private enabled = false
  private resetRequested = false
  private readonly onKeyDownBound = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase()
    if (key === 'x') {
      this.resetRequested = true
      event.preventDefault()
      return
    }
    if (!CONTROL_KEYS.has(key)) return
    this.pressed.add(key)
    event.preventDefault()
  }
  private readonly onKeyUpBound = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase()
    if (!CONTROL_KEYS.has(key)) return
    this.pressed.delete(key)
    event.preventDefault()
  }
  private readonly releaseBound = (): void => {
    this.releaseKeys()
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.releaseKeys()
    if (typeof window === 'undefined') return
    if (enabled) {
      window.addEventListener('keydown', this.onKeyDownBound)
      window.addEventListener('keyup', this.onKeyUpBound)
      window.addEventListener('blur', this.releaseBound)
    } else {
      window.removeEventListener('keydown', this.onKeyDownBound)
      window.removeEventListener('keyup', this.onKeyUpBound)
      window.removeEventListener('blur', this.releaseBound)
    }
  }

  public releaseKeys(): void {
    this.pressed.clear()
  }

  public consumeResetRequest(): boolean {
    const requested = this.resetRequested
    this.resetRequested = false
    return requested
  }

  public getInput(): NormalizedRcInput {
    if (!this.enabled) return { roll: 0, pitch: 0, yaw: 0, throttle: 0 }
    return {
      roll: this.axis('d', 'a'),
      pitch: this.axis('w', 's'),
      yaw: this.axis('e', 'q'),
      throttle: this.throttle(),
    }
  }

  public dispose(): void {
    this.setEnabled(false)
    this.resetRequested = false
  }

  private axis(positive: string, negative: string): number {
    return (this.pressed.has(positive) ? 1 : 0) - (this.pressed.has(negative) ? 1 : 0)
  }

  private throttle(): number {
    const up = this.pressed.has('r')
    const down = this.pressed.has('f')
    if (up && !down) return 1
    if (down && !up) return 0
    return clamp(0, 0, 1)
  }
}