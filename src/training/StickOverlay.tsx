import type { CSSProperties } from 'react'

import type { NormalizedRcInput } from '../flight-controller'

export type StickOverlayMode = 'live' | 'demonstration'

export const DEMONSTRATION_MODE2_INPUT: NormalizedRcInput = {
  roll: 0.2,
  pitch: -0.16,
  yaw: 0.14,
  throttle: 0.58,
}

export interface Mode2StickOverlayProps {
  readonly input?: NormalizedRcInput | null
  readonly mode?: StickOverlayMode
  readonly className?: string
  readonly compact?: boolean
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function stickPosition(value: number, minimum: number, maximum: number, invert = false): CSSProperties {
  const normalized = clamp((value - minimum) / (maximum - minimum), 0, 1)
  const adjusted = invert ? 1 - normalized : normalized
  return {
    left: `${8 + adjusted * 84}%`,
    top: '50%',
  }
}

function verticalPosition(value: number, minimum: number, maximum: number, invert = false): CSSProperties {
  const normalized = clamp((value - minimum) / (maximum - minimum), 0, 1)
  const adjusted = invert ? 1 - normalized : normalized
  return {
    left: '50%',
    top: `${92 - adjusted * 84}%`,
  }
}

function StickPad({
  label,
  horizontalLabel,
  verticalLabel,
  horizontal,
  vertical,
  horizontalRange,
  verticalRange,
  verticalInverted,
  throttle,
}: {
  readonly label: string
  readonly horizontalLabel: string
  readonly verticalLabel: string
  readonly horizontal: number
  readonly vertical: number
  readonly horizontalRange: readonly [number, number]
  readonly verticalRange: readonly [number, number]
  readonly verticalInverted?: boolean
  readonly throttle?: boolean
}) {
  const horizontalStyle = stickPosition(horizontal, horizontalRange[0], horizontalRange[1])
  const verticalStyle = throttle
    ? verticalPosition(vertical, verticalRange[0], verticalRange[1])
    : verticalPosition(vertical, verticalRange[0], verticalRange[1], verticalInverted)
  const dotStyle: CSSProperties = {
    left: horizontalStyle.left,
    top: verticalStyle.top,
  }
  return (
    <div className="mode2-stick-panel" aria-label={`${label} stick: ${verticalLabel} and ${horizontalLabel}`}>
      <div className="mode2-stick-heading">
        <strong>{label}</strong>
        <span>{verticalLabel} + {horizontalLabel}</span>
      </div>
      <div className="mode2-stick-pad">
        <span className="mode2-stick-axis mode2-stick-axis-horizontal" aria-hidden="true" />
        <span className="mode2-stick-axis mode2-stick-axis-vertical" aria-hidden="true" />
        <span className="mode2-stick-endpoint mode2-stick-endpoint-top" aria-hidden="true" />
        <span className="mode2-stick-endpoint mode2-stick-endpoint-bottom" aria-hidden="true" />
        <span className="mode2-stick-endpoint mode2-stick-endpoint-left" aria-hidden="true" />
        <span className="mode2-stick-endpoint mode2-stick-endpoint-right" aria-hidden="true" />
        <span className="mode2-stick-cursor" style={verticalStyle} aria-hidden="true" />
        <span className="mode2-stick-cursor mode2-stick-cursor-horizontal" style={horizontalStyle} aria-hidden="true" />
        <span className="mode2-stick-dot" style={dotStyle} aria-hidden="true" />
      </div>
      <div className="mode2-stick-axis-labels" aria-hidden="true">
        <span>{horizontalLabel} −</span>
        <span>{verticalLabel} +</span>
        <span>{horizontalLabel} +</span>
      </div>
    </div>
  )
}

/** Reusable Mode 2 presentation-only overlay; it never sends commands to flight. */
export default function Mode2StickOverlay({
  input,
  mode = 'live',
  className = '',
  compact = false,
}: Mode2StickOverlayProps) {
  const values = mode === 'demonstration' ? input ?? DEMONSTRATION_MODE2_INPUT : input
  const live = values ?? { roll: 0, pitch: 0, yaw: 0, throttle: 0 }
  const rootClassName = ['mode2-stick-overlay', compact ? 'mode2-stick-overlay-compact' : '', className]
    .filter(Boolean)
    .join(' ')
  return (
    <section className={rootClassName} aria-label={`Mode 2 ${mode} stick overlay`}>
      <div className="mode2-stick-overlay-heading">
        <div>
          <p className="panel-kicker">Mode 2 sticks</p>
          <h3>{mode === 'live' ? 'Live input' : 'Demonstration'}</h3>
        </div>
        <span className="mode2-stick-mode">{mode === 'live' && values ? 'LIVE' : mode.toUpperCase()}</span>
      </div>
      <div className="mode2-stick-pads">
        <StickPad
          label="Left"
          horizontalLabel="Yaw"
          verticalLabel="Throttle"
          horizontal={live.yaw}
          vertical={live.throttle}
          horizontalRange={[-1, 1]}
          verticalRange={[0, 1]}
          throttle
        />
        <StickPad
          label="Right"
          horizontalLabel="Roll"
          verticalLabel="Pitch"
          horizontal={live.roll}
          vertical={live.pitch}
          horizontalRange={[-1, 1]}
          verticalRange={[-1, 1]}
          verticalInverted={false}
        />
      </div>
      {!values && mode === 'live' && <p className="mode2-stick-empty">Waiting for a normalized runtime sample.</p>}
    </section>
  )
}

export { Mode2StickOverlay }
