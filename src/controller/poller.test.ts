import { describe, expect, it } from 'vitest'

import { GamepadPoller, snapshotGamepad } from './poller'
import type { GamepadLike } from './types'

function gamepad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    id: 'USB transmitter',
    index: 1,
    connected: true,
    mapping: '',
    axes: [0, 0, 0, -1],
    buttons: [{ pressed: false, touched: false, value: 0 }],
    timestamp: 1,
    ...overrides,
  }
}

describe('GamepadPoller', () => {
  it('discovers, selects and snapshots raw devices without assuming axis order', () => {
    const pads: readonly (GamepadLike | null)[] = [gamepad()]
    const poller = new GamepadPoller({ provider: () => pads, supported: true })
    const state = poller.poll()

    expect(state.devices).toHaveLength(1)
    expect(state.selectedDeviceIndex).toBe(1)
    expect(poller.getSelectedSnapshot()?.axes).toEqual([0, 0, 0, -1])
    expect(poller.selectDevice(1)).toBe(true)
  })

  it('assigns a new connection session after a disconnect and reconnect', () => {
    let pads: readonly (GamepadLike | null)[] = [gamepad()]
    const poller = new GamepadPoller({ provider: () => pads, supported: true })
    const first = poller.poll().devices[0].connectionSession
    pads = []
    poller.poll()
    pads = [gamepad({ timestamp: 2 })]
    const reconnected = poller.poll().devices[0].connectionSession
    expect(first).toBeTruthy()
    expect(reconnected).toBeTruthy()
    expect(reconnected).not.toBe(first)
  })

  it('marks a vanished selected device disconnected instead of silently switching', () => {
    let pads: readonly (GamepadLike | null)[] = [gamepad()]
    const poller = new GamepadPoller({ provider: () => pads, supported: true })
    poller.poll()
    pads = []
    const state = poller.poll()

    expect(state.selectedDeviceIndex).toBeNull()
    expect(state.devices[0].connected).toBe(false)
    expect(poller.getSelectedSnapshot()).toBeNull()
  })

  it('surfaces non-finite axes and button values for the safety layer', () => {
    const snapshot = snapshotGamepad(gamepad({ axes: [Number.NaN, 0, 0, -1], buttons: [{ pressed: false, value: Number.POSITIVE_INFINITY }] }))
    expect(snapshot.invalidAxisIndices).toEqual([0])
    expect(snapshot.invalidButtonIndices).toEqual([0])
  })
})
