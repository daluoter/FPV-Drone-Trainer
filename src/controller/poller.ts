import type {
  ControllerDevice,
  GamepadLike,
  GamepadProvider,
  PollerState,
  RawButtonState,
  RawGamepadSnapshot,
} from './types'

export interface GamepadPollerOptions {
  readonly provider: GamepadProvider
  readonly supported: boolean
  readonly scheduleFrame?: (callback: (time: number) => void) => number
  readonly cancelFrame?: (handle: number) => void
}

export type PollerListener = (state: PollerState) => void

export function snapshotGamepad(gamepad: GamepadLike): RawGamepadSnapshot {
  const axes = Array.from(gamepad.axes)
  const buttons: RawButtonState[] = gamepad.buttons.map((button) => ({
    pressed: button.pressed,
    touched: button.touched ?? button.pressed,
    value: button.value,
  }))
  return {
    id: gamepad.id,
    index: gamepad.index,
    mapping: gamepad.mapping,
    axisCount: axes.length,
    buttonCount: buttons.length,
    connected: gamepad.connected,
    axes,
    buttons,
    timestamp: gamepad.timestamp,
    invalidAxisIndices: axes.flatMap((value, index) => Number.isFinite(value) ? [] : [index]),
    invalidButtonIndices: buttons.flatMap((button, index) => Number.isFinite(button.value) ? [] : [index]),
  }
}

function deviceFromSnapshot(snapshot: RawGamepadSnapshot): ControllerDevice {
  return {
    id: snapshot.id,
    index: snapshot.index,
    mapping: snapshot.mapping,
    axisCount: snapshot.axisCount,
    buttonCount: snapshot.buttonCount,
    connected: snapshot.connected,
    connectionSession: snapshot.connectionSession,
  }
}

function browserProvider(): { provider: GamepadProvider; supported: boolean } {
  const supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
  const provider: GamepadProvider = () => {
    if (!supported) return []
    return Array.from(navigator.getGamepads())
  }
  return { provider, supported }
}

export function createBrowserGamepadPoller(): GamepadPoller {
  const browser = browserProvider()
  const scheduleFrame = typeof requestAnimationFrame === 'function'
    ? (callback: (time: number) => void) => requestAnimationFrame(callback)
    : undefined
  const cancelFrame = typeof cancelAnimationFrame === 'function'
    ? (handle: number) => cancelAnimationFrame(handle)
    : undefined
  return new GamepadPoller({
    provider: browser.provider,
    supported: browser.supported,
    scheduleFrame,
    cancelFrame,
  })
}

export class GamepadPoller {
  private readonly provider: GamepadProvider
  private readonly scheduleFrame: ((callback: (time: number) => void) => number) | undefined
  private readonly cancelFrame: ((handle: number) => void) | undefined
  private readonly listeners = new Set<PollerListener>()
  private readonly knownDevices = new Map<number, ControllerDevice>()
  private readonly latestSnapshots = new Map<number, RawGamepadSnapshot>()
  private readonly sessionPrefix = `poller-${Math.random().toString(36).slice(2)}`
  private connectionCounter = 0
  private frameHandle: number | null = null
  private running = false
  private state: PollerState

  public constructor(options: GamepadPollerOptions) {
    this.provider = options.provider
    this.scheduleFrame = options.scheduleFrame
    this.cancelFrame = options.cancelFrame
    this.state = {
      supported: options.supported,
      devices: [],
      snapshots: [],
      selectedDeviceIndex: null,
    }
  }

  public subscribe(listener: PollerListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  public getState(): PollerState {
    return this.state
  }

  public getSelectedSnapshot(): RawGamepadSnapshot | null {
    if (this.state.selectedDeviceIndex === null) return null
    return this.latestSnapshots.get(this.state.selectedDeviceIndex) ?? null
  }

  public selectDevice(index: number): boolean {
    const device = this.knownDevices.get(index)
    if (!device?.connected || !this.latestSnapshots.has(index)) return false
    this.state = { ...this.state, selectedDeviceIndex: index }
    this.notify()
    return true
  }

  public poll(): PollerState {
    const connectedIndices = new Set<number>()
    const seenIndices = new Set<number>()
    const currentSnapshots: RawGamepadSnapshot[] = []

    for (const gamepad of this.provider()) {
      if (!gamepad) continue
      seenIndices.add(gamepad.index)
      const rawSnapshot = snapshotGamepad(gamepad)
      const previousDevice = this.knownDevices.get(gamepad.index)
      const connectionSession = gamepad.connected
        ? previousDevice?.connected && previousDevice.connectionSession
          ? previousDevice.connectionSession
          : `${this.sessionPrefix}:${gamepad.index}:${++this.connectionCounter}`
        : previousDevice?.connectionSession
      const snapshot = { ...rawSnapshot, connectionSession }
      const device = deviceFromSnapshot(snapshot)
      this.knownDevices.set(gamepad.index, device)
      if (gamepad.connected) {
        connectedIndices.add(gamepad.index)
        this.latestSnapshots.set(gamepad.index, snapshot)
        currentSnapshots.push(snapshot)
      } else {
        this.latestSnapshots.delete(gamepad.index)
      }
    }

    for (const [index, device] of this.knownDevices) {
      if (!seenIndices.has(index) || !connectedIndices.has(index)) {
        this.knownDevices.set(index, { ...device, connected: false })
        this.latestSnapshots.delete(index)
      }
    }

    const hadSelection = this.state.selectedDeviceIndex !== null
    let selectedDeviceIndex = this.state.selectedDeviceIndex
    if (selectedDeviceIndex !== null && !connectedIndices.has(selectedDeviceIndex)) {
      selectedDeviceIndex = null
    }
    if (!hadSelection && selectedDeviceIndex === null) {
      selectedDeviceIndex = currentSnapshots[0]?.index ?? null
    }

    const devices = [...this.knownDevices.values()].sort((left, right) => left.index - right.index)
    this.state = {
      supported: this.state.supported,
      devices,
      snapshots: currentSnapshots.sort((left, right) => left.index - right.index),
      selectedDeviceIndex,
    }
    this.notify()
    return this.state
  }

  public start(): void {
    if (this.running) return
    this.running = true
    this.poll()
    if (this.scheduleFrame) this.scheduleNextFrame()
  }

  public stop(): void {
    this.running = false
    if (this.frameHandle !== null && this.cancelFrame) {
      this.cancelFrame(this.frameHandle)
    }
    this.frameHandle = null
  }

  private scheduleNextFrame(): void {
    if (!this.running || !this.scheduleFrame) return
    this.frameHandle = this.scheduleFrame(() => {
      this.frameHandle = null
      this.poll()
      this.scheduleNextFrame()
    })
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state)
  }
}
