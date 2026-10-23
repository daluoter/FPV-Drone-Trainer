import { describe, expect, it, vi } from 'vitest'

import {
  createControllerProfile,
  markDirectionsVerified,
  markNeutralVerified,
  type ControllerDevice,
  type ControllerProfile,
  type GamepadPoller,
  type PollerState,
  type RawGamepadSnapshot,
} from '../controller'
import { createDefaultFlightControllerConfig, FlightSimulation } from '../flight-controller'
import { DEFAULT_DRONE_CONFIG, droneGroundSupport, DRONE_GROUND_CLEARANCE_M, hoverThrottle } from '../drone'
import type { StaticBoxCollider } from '../simulation/obstacles'
import { DEFAULT_LESSONS, TRAINING_SCENE_REFERENCES, TrainingSession } from '../training'
import type { LessonSetup } from '../training/types'
import { FlightRuntime, type FlightRuntimeFixedStepSample } from './flightRuntime'

const neutralReport = {
  sampleCount: 100,
  durationMs: 3_000,
  threshold: 0.02,
  maxAbsolute: { roll: 0.005, pitch: 0.005, yaw: 0.005 },
  mean: { roll: 0, pitch: 0, yaw: 0 },
  standardDeviation: { roll: 0.001, pitch: 0.001, yaw: 0.001 },
  stable: true,
  reason: 'stable',
} as const

function createHandoff(): { device: ControllerDevice; profile: ControllerProfile; snapshot: RawGamepadSnapshot } {
  const device: ControllerDevice = {
    id: 'runtime-pad',
    index: 0,
    mapping: '',
    axisCount: 4,
    buttonCount: 1,
    connected: true,
    connectionSession: 'session-a',
  }
  const profile = markNeutralVerified(
    markDirectionsVerified(createControllerProfile(device, {
      roll: { axis: 0, center: 0, minimum: -1, maximum: 1 },
      pitch: { axis: 1, center: 0, minimum: -1, maximum: 1 },
      yaw: { axis: 2, center: 0, minimum: -1, maximum: 1 },
      throttle: { axis: 3, center: -1, minimum: -1, maximum: 1 },
    })),
    neutralReport,
    '2026-01-01T00:00:00.000Z',
    'session-a',
  )
  const snapshot: RawGamepadSnapshot = {
    ...device,
    axes: [0, 0, 0, -1],
    buttons: [{ pressed: false, touched: false, value: 0 }],
    timestamp: 1,
    invalidAxisIndices: [],
    invalidButtonIndices: [],
  }
  return { device, profile, snapshot }
}

class FakePoller implements RuntimePollerForTest {
  public state: PollerState
  public snapshot: RawGamepadSnapshot | null

  public constructor(device: ControllerDevice, snapshot: RawGamepadSnapshot) {
    this.snapshot = snapshot
    this.state = { supported: true, devices: [device], snapshots: [snapshot], selectedDeviceIndex: device.index }
  }

  public poll(): PollerState {
    return this.state
  }

  public getState(): PollerState {
    return this.state
  }

  public getSelectedSnapshot(): RawGamepadSnapshot | null {
    return this.snapshot
  }
}

type RuntimePollerForTest = Pick<GamepadPoller, 'poll' | 'getState' | 'getSelectedSnapshot'>

function nextFrameRunner() {
  let callback: ((time: number) => void) | null = null
  return {
    schedule: (next: (time: number) => void): number => {
      callback = next
      return 1
    },
    cancel: vi.fn(),
    run: (time: number): void => callback?.(time),
  }
}

describe('Free Flight runtime safety transitions', () => {
  const frameBottom: StaticBoxCollider = {
    id: 'runtime-frame-bottom',
    centerM: { x: 0, y: 1, z: 0 },
    halfExtentsM: { x: 2, y: 0.12, z: 0.15 },
  }
  const obstacleSetup: LessonSetup = {
    requiresDisarmed: true,
    resetSimulation: true,
    sceneReferenceIds: [],
    spawnPositionM: { x: 0, y: 3, z: 0 },
    staticObstacles: [frameBottom],
  }

  it('replaces a SAFE preview environment without moving state or adding a frame loop', () => {
    const frames = nextFrameRunner()
    const schedule = vi.fn(frames.schedule)
    const runtime = new FlightRuntime({ scheduleFrame: schedule, cancelFrame: frames.cancel })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.simulation.getStaticObstacles()).toEqual([])
    const before = runtime.simulation.getState()
    const scheduledFrames = schedule.mock.calls.length
    expect(runtime.setStaticObstacles([frameBottom])).toBe(true)
    expect(runtime.simulation.getState()).toBe(before)
    expect(runtime.setStaticObstacles([{ ...frameBottom, halfExtentsM: { x: 0, y: 1, z: 1 } }])).toBe(false)
    expect(runtime.simulation.getStaticObstacles()).toEqual([frameBottom])
    expect(runtime.simulation.getState()).toBe(before)
    expect(runtime.setStaticObstacles([])).toBe(true)
    expect(schedule).toHaveBeenCalledTimes(scheduledFrames)
    expect(frames.cancel).not.toHaveBeenCalled()

    runtime.resetForTraining(obstacleSetup)
    runtime.setTrainingArmBlocked(true)
    const held = runtime.simulation.getState()
    expect(runtime.setStaticObstacles([])).toBe(true)
    expect(runtime.simulation.getState()).toBe(held)
    expect(runtime.setStaticObstacles([frameBottom])).toBe(true)
    runtime.setTrainingArmBlocked(false)
    expect(runtime.arm()).toBe(true)
    expect(runtime.setStaticObstacles([])).toBe(false)
    expect(runtime.simulation.getStaticObstacles()).toEqual([frameBottom])
    runtime.dispose()
  })

  it('reports real obstacle collisions in authoritative samples and telemetry, latches, and refuses replay mutation', () => {
    const frames = nextFrameRunner()
    let currentTime = 0
    const samples: FlightRuntimeFixedStepSample[] = []
    const runtime = new FlightRuntime({ scheduleFrame: frames.schedule, cancelFrame: frames.cancel, now: () => currentTime, onFixedStep: (sample) => samples.push(sample) })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    runtime.resetForTraining(obstacleSetup)
    expect(runtime.arm()).toBe(true)
    expect(runtime.setStaticObstacles([])).toBe(false)
    for (let frame = 1; frame <= 60; frame += 1) {
      currentTime = frame * 1_000 / 60
      frames.run(currentTime)
    }
    const collision = samples.find((sample) => sample.state.crashed)
    expect(collision).toBeDefined()
    expect(collision?.state.positionM.y).toBeGreaterThan(1)
    expect(collision?.armed).toBe(false)
    expect(collision?.state.warnings).toContain('Obstacle collision: runtime-frame-bottom; reset required.')
    expect(collision?.telemetry.warnings).toContain('Obstacle collision: runtime-frame-bottom; reset required.')
    expect(collision?.state.motors.every((motor) => motor.command === 0 && motor.actualThrustN === 0)).toBe(true)
    expect(runtime.getTelemetry().warnings).toContain('Obstacle collision: runtime-frame-bottom; reset required.')
    expect(runtime.getTelemetry().safetyReasons).toContain('Obstacle collision: runtime-frame-bottom; reset required.')
    expect(runtime.arm()).toBe(false)
    expect(runtime.getTelemetry().state.warnings).toContain('Obstacle collision: runtime-frame-bottom; reset required.')
    const position = runtime.simulation.getState().positionM
    expect(runtime.setStaticObstacles([])).toBe(true)
    currentTime = 1_000 + 1_000 / 60
    frames.run(currentTime)
    expect(runtime.simulation.getState().positionM).toEqual(position)
    expect(runtime.simulation.getState().crashed).toBe(true)
    expect(runtime.arm()).toBe(false)

    const recording = runtime.getReplayRecording()
    expect(recording?.samples.length).toBeGreaterThan(1)
    expect(runtime.setStaticObstacles([frameBottom])).toBe(true)
    expect(runtime.enterReplay(recording)).toBe(true)
    const replayLiveState = runtime.simulation.getState()
    const liveSampleCount = samples.length
    expect(runtime.setStaticObstacles([])).toBe(false)
    runtime.resetForTraining(obstacleSetup)
    expect(runtime.seekReplay(recording?.durationSeconds ?? 0)).toBe(true)
    expect(runtime.seekReplay(0)).toBe(true)
    expect(runtime.playReplay()).toBe(true)
    frames.run(2_000)
    frames.run(2_000 + 1_000 / 60)
    expect(runtime.simulation.getState()).toBe(replayLiveState)
    expect(samples).toHaveLength(liveSampleCount)
    expect(runtime.simulation.getStaticObstacles()).toEqual([frameBottom])
    expect(runtime.exitReplay()).toBe(true)
    expect(runtime.simulation.getStaticObstacles()).toEqual([])
    expect(runtime.simulation.getState().crashed).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })

  it('flies through an open physical frame using normal calibrated controller input', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({ poller, profile: handoff.profile, scheduleFrame: frames.schedule, cancelFrame: frames.cancel })
    runtime.start()
    frames.run(0)
    const pitch = -0.12
    const boxes: readonly StaticBoxCollider[] = [
      { id: 'left', centerM: { x: -2.2, y: 3, z: 0 }, halfExtentsM: { x: 0.12, y: 2.2, z: 0.15 } },
      { id: 'right', centerM: { x: 2.2, y: 3, z: 0 }, halfExtentsM: { x: 0.12, y: 2.2, z: 0.15 } },
      { id: 'top', centerM: { x: 0, y: 5.2, z: 0 }, halfExtentsM: { x: 2.32, y: 0.12, z: 0.15 } },
      { id: 'bottom', centerM: { x: 0, y: 0.8, z: 0 }, halfExtentsM: { x: 2.32, y: 0.12, z: 0.15 } },
    ]
    runtime.resetForTraining({
      ...obstacleSetup,
      spawnPositionM: { x: 0, y: 3, z: 1.5 },
      spawnOrientation: { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) },
      staticObstacles: boxes,
    })
    expect(runtime.arm()).toBe(true)
    poller.snapshot = { ...handoff.snapshot, axes: [0, 0, 0, 2 * hoverThrottle() / Math.cos(pitch) - 1] }
    for (let frame = 1; frame <= 180 && runtime.simulation.getState().positionM.z > -0.7; frame += 1) frames.run(frame * 1_000 / 60)
    expect(runtime.simulation.getState().positionM.z).toBeLessThan(-0.7)
    expect(runtime.simulation.getState().positionM.y).toBeGreaterThan(1.5)
    expect(runtime.simulation.getState().crashed).toBe(false)
    expect(runtime.simulation.isArmed()).toBe(true)
    runtime.dispose()
  })

  it('clears obstacle environments on normal reset, lesson replacement, and simulation reconfiguration', () => {
    const frames = nextFrameRunner()
    const drone = { ...DEFAULT_DRONE_CONFIG, spawnPositionM: { x: 0, y: 3, z: 0 } }
    const runtime = new FlightRuntime({ simulation: { drone }, scheduleFrame: frames.schedule, cancelFrame: frames.cancel })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    runtime.resetForTraining(obstacleSetup)
    expect(runtime.simulation.getStaticObstacles()).toEqual([frameBottom])
    runtime.reset()
    expect(runtime.simulation.getStaticObstacles()).toEqual([])
    expect(runtime.arm()).toBe(true)
    for (let frame = 1; frame <= 45 && runtime.simulation.getState().positionM.y > 0.5; frame += 1) frames.run(frame * 1_000 / 60)
    expect(runtime.simulation.getState().positionM.y).toBeLessThan(0.5)
    expect(runtime.simulation.getState().crashed).toBe(false)
    runtime.resetForTraining(obstacleSetup)
    runtime.resetForTraining({ ...obstacleSetup, staticObstacles: undefined })
    expect(runtime.simulation.getStaticObstacles()).toEqual([])
    runtime.resetForTraining(obstacleSetup)
    expect(runtime.reconfigure({ drone })).toBe(true)
    expect(runtime.simulation.getStaticObstacles()).toEqual([])
    expect(runtime.simulation.getState().stepIndex).toBe(0)
    expect(runtime.simulation.isArmed()).toBe(false)
    runtime.dispose()
  })

  it('refuses malformed training obstacles and retains a safe held preparation', () => {
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({ scheduleFrame: frames.schedule, cancelFrame: frames.cancel })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    runtime.resetForTraining({ ...obstacleSetup, staticObstacles: [{ ...frameBottom, halfExtentsM: { x: 1, y: Number.NaN, z: 1 } }] })
    expect(runtime.arm()).toBe(false)
    for (let frame = 1; frame <= 30; frame += 1) frames.run(frame * 1_000 / 60)
    expect(runtime.simulation.getState().positionM).toEqual(obstacleSetup.spawnPositionM)
    expect(runtime.getTelemetry().warnings).toContain('Training environment contains invalid obstacles; reset is required before arming.')
    runtime.resetForTraining(obstacleSetup)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })

  it('holds an airborne lesson pose for ten seconds without inventing armed samples, then releases on arm', () => {
    const frames = nextFrameRunner()
    const samples: FlightRuntimeFixedStepSample[] = []
    const runtime = new FlightRuntime({ scheduleFrame: frames.schedule, cancelFrame: frames.cancel, onFixedStep: (sample) => samples.push(sample) })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    runtime.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [], spawnPositionM: { x: 1, y: 3, z: -2 } })
    runtime.setTrainingArmBlocked(true)
    expect(runtime.arm()).toBe(false)
    for (let frame = 1; frame <= 600; frame += 1) frames.run(frame * 1_000 / 60)
    expect(runtime.simulation.getState().positionM).toEqual({ x: 1, y: 3, z: -2 })
    expect(runtime.simulation.getState().timeSeconds).toBeCloseTo(10, 8)
    expect(samples).toHaveLength(2_400)
    expect(samples.every((sample, index) => !sample.armed && sample.state.stepIndex === index + 1)).toBe(true)
    expect(runtime.replayRecorder.isFlightActive()).toBe(false)
    runtime.setTrainingArmBlocked(false)
    expect(runtime.arm()).toBe(true)
    frames.run(10_000 + 1_000 / 60)
    expect(runtime.simulation.getState().positionM.y).toBeLessThan(3)
    expect(samples.at(-1)?.armed).toBe(true)
    runtime.dispose()
  })

  it('keeps preparation after a failed device arm, while reset and reconfigure restore ordinary disarmed gravity', () => {
    const frames = nextFrameRunner()
    const drone = { ...DEFAULT_DRONE_CONFIG, spawnPositionM: { x: 0, y: 3, z: 0 } }
    const runtime = new FlightRuntime({ simulation: { drone }, scheduleFrame: frames.schedule, cancelFrame: frames.cancel })
    runtime.start()
    frames.run(0)
    runtime.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [], spawnPositionM: { x: 0, y: 5, z: 0 } })
    expect(runtime.arm()).toBe(false)
    for (let frame = 1; frame <= 60; frame += 1) frames.run(frame * 1_000 / 60)
    expect(runtime.simulation.getState().positionM.y).toBe(5)
    runtime.reset()
    frames.run(1_000 + 1_000 / 60)
    expect(runtime.simulation.getState().positionM.y).toBeLessThan(3)

    runtime.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [], spawnPositionM: { x: 0, y: 5, z: 0 } })
    expect(runtime.reconfigure({ drone })).toBe(true)
    frames.run(1_000 + 2_000 / 60)
    expect(runtime.simulation.getState().positionM.y).toBeLessThan(3)
    runtime.dispose()
  })

  it('reports actual configured ground contact and does not confuse a low hover with touchdown', () => {
    const frames = nextFrameRunner()
    const samples: FlightRuntimeFixedStepSample[] = []
    const drone = { ...DEFAULT_DRONE_CONFIG, ground: { ...DEFAULT_DRONE_CONFIG.ground, heightM: 2 }, spawnPositionM: { x: 0, y: 2, z: 0 } }
    const runtime = new FlightRuntime({ simulation: { drone }, scheduleFrame: frames.schedule, cancelFrame: frames.cancel, onFixedStep: (sample) => samples.push(sample) })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    const orientation = { x: 0, y: 0, z: Math.sin(Math.PI / 12), w: Math.cos(Math.PI / 12) }
    const support = droneGroundSupport(drone, orientation).supportOffsetM
    runtime.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [], spawnPositionM: { x: 0, y: 2, z: 0 }, spawnOrientation: orientation })
    frames.run(1_000 / 60)
    expect(samples.at(-1)?.groundContact).toEqual({ heightM: 2, supportOffsetM: support, touching: true })

    runtime.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [], spawnPositionM: { x: 0, y: 2 + support + DRONE_GROUND_CLEARANCE_M + 0.02, z: 0 }, spawnOrientation: orientation })
    frames.run(2_000 / 60)
    expect(samples.at(-1)?.groundContact?.touching).toBe(false)
    expect(samples.at(-1)?.groundContact?.supportOffsetM).toBeCloseTo(support, 12)
    runtime.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [], spawnPositionM: { x: 0, y: 5, z: 0 } })
    frames.run(3_000 / 60)
    expect(samples.at(-1)?.groundContact).toEqual({ heightM: 2, supportOffsetM: 0, touching: false })
    runtime.dispose()
  })

  it('reports solver contact before positional correction reaches minimum clearance', () => {
    const frames = nextFrameRunner()
    const samples: FlightRuntimeFixedStepSample[] = []
    const support = droneGroundSupport(DEFAULT_DRONE_CONFIG, { x: 0, y: 0, z: 0, w: 1 }).supportOffsetM
    const drone = { ...DEFAULT_DRONE_CONFIG, spawnPositionM: { x: 0, y: support + 0.0018, z: 0 } }
    const runtime = new FlightRuntime({ simulation: { drone }, scheduleFrame: frames.schedule, cancelFrame: frames.cancel, onFixedStep: (sample) => samples.push(sample) })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    frames.run(1_000 / 240)
    const contact = samples.at(-1)!
    expect(contact.state.velocityMps.y).toBe(0)
    expect(contact.state.positionM.y).toBeGreaterThan(support + DRONE_GROUND_CLEARANCE_M + 1e-5)
    expect(contact.groundContact?.touching).toBe(true)
    runtime.dispose()
  })

  it('clears a prepared hold when replay exits through the normal live reset boundary', () => {
    const frames = nextFrameRunner()
    const drone = { ...DEFAULT_DRONE_CONFIG, spawnPositionM: { x: 0, y: 3, z: 0 } }
    const runtime = new FlightRuntime({ simulation: { drone }, scheduleFrame: frames.schedule, cancelFrame: frames.cancel })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    for (let frame = 1; frame <= 6; frame += 1) frames.run(frame * 1_000 / 60)
    runtime.disarm()
    const recording = runtime.getReplayRecording()
    expect(recording?.samples.length).toBeGreaterThan(1)
    runtime.resetForTraining({ requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: [], spawnPositionM: { x: 0, y: 5, z: 0 } })
    expect(runtime.enterReplay(recording)).toBe(true)
    expect(runtime.exitReplay()).toBe(true)
    expect(runtime.simulation.getState().positionM.y).toBe(3)
    frames.run(200)
    frames.run(200 + 1_000 / 60)
    expect(runtime.simulation.getState().positionM.y).toBeLessThan(3)
    expect(runtime.getTelemetry().armed).toBe(false)
    runtime.dispose()
  })

  it.each(['controller', 'keyboard'] as const)('blocks direct %s arm requests during countdown until an explicit fresh arm', (source) => {
    const handoff = createHandoff()
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller: new FakePoller(handoff.device, handoff.snapshot),
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.setInputSource(source)
    runtime.start()
    frames.run(0)
    runtime.setTrainingArmBlocked(true)
    expect(runtime.arm()).toBe(false)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().safetyReasons.join(' ')).toMatch(/countdown/i)
    runtime.reset()
    expect(runtime.arm()).toBe(false)

    runtime.setTrainingArmBlocked(false)
    frames.run(100)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.replayRecorder.isFlightActive()).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })

  it('disarms an already flying drone when countdown locks arming and never auto-rearms on release', () => {
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({ scheduleFrame: frames.schedule, cancelFrame: frames.cancel, now: () => 100 })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    expect(runtime.replayRecorder.isFlightActive()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))

    runtime.setTrainingArmBlocked(true)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.keyboard.getInput().throttle).toBe(0)
    expect(runtime.replayRecorder.isFlightActive()).toBe(false)
    expect(runtime.arm()).toBe(false)
    runtime.setTrainingArmBlocked(false)
    expect(runtime.getTelemetry().armed).toBe(false)
    frames.run(100)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })

  it('accepts intended stick movement after a gated arm and disarms on disconnect', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })

    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    poller.snapshot = { ...handoff.snapshot, axes: [0.7, 0, 0, 1], timestamp: 2 }
    poller.state = { ...poller.state, snapshots: [poller.snapshot] }
    frames.run(100)
    expect(runtime.getTelemetry().armed).toBe(true)
    // Arm-time neutral/low-throttle conditions are not continuously reapplied.
    poller.snapshot = { ...handoff.snapshot, axes: [0.7, 0, 0, 1], timestamp: 2 }
    poller.state = { ...poller.state, snapshots: [poller.snapshot] }
    frames.run(150)
    expect(runtime.getTelemetry().armed).toBe(true)

    poller.snapshot = null
    poller.state = { ...poller.state, devices: [{ ...handoff.device, connected: false }], snapshots: [], selectedDeviceIndex: null }
    frames.run(200)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/controller|select|disconnected/i)
    runtime.dispose()
  })

  it('disarms and requires explicit rearm when the document becomes hidden', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      runtime.start()
      frames.run(0)
      expect(runtime.arm()).toBe(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(runtime.getTelemetry().armed).toBe(false)
      expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/hidden|rearm/i)
    } finally {
      if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor)
      else Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      runtime.dispose()
    }
  })

  it('requires explicit rearm when a connected controller changes session identity', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)

    const nextDevice = { ...handoff.device, connectionSession: 'session-b' }
    const nextSnapshot = { ...handoff.snapshot, ...nextDevice, timestamp: 4 }
    poller.snapshot = nextSnapshot
    poller.state = { ...poller.state, devices: [nextDevice], snapshots: [nextSnapshot] }
    frames.run(100)

    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/session|device|rearm/i)
    runtime.dispose()
  })

  it('publishes a latched crash, blocks re-arm, and clears the latch only through reset', () => {
    const runner = nextFrameRunner()
    let currentTime = 0
    const training = new TrainingSession({
      lessons: DEFAULT_LESSONS.map((lesson) => lesson.id === 'hover'
        ? { ...lesson, evaluator: () => ({ status: 'continue' as const }) }
        : lesson),
      initialLessonId: 'hover',
      countdownDurationSeconds: 0,
      sceneReferences: TRAINING_SCENE_REFERENCES,
    })
    training.start(0)
    training.tick(0)
    const runtime = new FlightRuntime({
      scheduleFrame: runner.schedule,
      cancelFrame: runner.cancel,
      now: () => currentTime,
      onFixedStep: (sample) => training.consumeSample({
        timestampSeconds: sample.timestampSeconds,
        state: sample.state,
        normalizedInput: sample.normalizedInput,
        armed: sample.armed,
      }),
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    runner.run(0)
    expect(runtime.arm()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))

    for (let time = 100; time <= 3_000 && !runtime.getTelemetry().state.crashed; time += 100) {
      currentTime = time
      runner.run(time)
    }
    expect(runtime.getTelemetry().state.crashed).toBe(true)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().safetyReasons.join(' ')).toMatch(/crash|tip-over/i)
    expect(runtime.arm()).toBe(false)
    expect(training.getState().phase).toBe('FAILED')
    expect(training.getState().result?.message).toMatch(/crashed/i)

    runtime.reset()
    expect(runtime.getTelemetry().state.crashed).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })

  it('sends keyboard input through the same rates and simulation pipeline as direct RC input', () => {
    const frames = nextFrameRunner()
    let currentTime = 0
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => currentTime,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.simulation.getState().stepIndex).toBe(0)
    expect(runtime.arm()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
    expect(runtime.keyboard.getInput()).toEqual({ roll: 1, pitch: 0, yaw: 0, throttle: 1 })
    currentTime = 100
    frames.run(100)

    const expected = new FlightSimulation()
    expected.arm()
    expected.advance(0.1, { roll: 1, pitch: 0, yaw: 0, throttle: 1 })
    const actual = runtime.simulation.getTelemetry()
    const expectedTelemetry = expected.getTelemetry()
    expect(actual.targetPilotRateRadPerSec).toEqual(expectedTelemetry.targetPilotRateRadPerSec)
    expect(actual.motors.map((motor) => motor.command)).toEqual(expectedTelemetry.motors.map((motor) => motor.command))
    runtime.dispose()
  })

  it('reconfigures only through a disarmed reset boundary', () => {
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    frames.run(16)
    frames.run(100)
    expect(runtime.simulation.getState().stepIndex).toBeGreaterThan(0)

    const defaults = createDefaultFlightControllerConfig()
    const controller = {
      ...defaults,
      rates: {
        ...defaults.rates,
        axes: {
          ...defaults.rates.axes,
          roll: { ...defaults.rates.axes.roll, centerRateDegPerSec: 120 },
        },
      },
    }
    const simulationBeforeLock = runtime.simulation
    const stateBeforeLock = runtime.simulation.getState()
    runtime.setTuningLocked(true)
    expect(runtime.reconfigure({ controller })).toBe(false)
    expect(runtime.simulation).toBe(simulationBeforeLock)
    expect(runtime.getTelemetry().armed).toBe(true)
    expect(runtime.simulation.getState()).toEqual(stateBeforeLock)

    runtime.setTuningLocked(false)
    expect(runtime.reconfigure({ controller })).toBe(true)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().warnings.join(' ')).toMatch(/settings|reset|disarmed/i)
    expect(runtime.simulation.getState().stepIndex).toBe(0)
    expect(runtime.simulation.controller.config.rates.axes.roll.centerRateDegPerSec).toBe(120)
    runtime.dispose()
  })

  it('disarms an active training reset without resetting pose and requires explicit rearm', () => {
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
    frames.run(100)

    const poseBeforeReset = runtime.simulation.getState()
    runtime.disarm('Training attempt reset; explicit rearm is required.')
    const poseAfterReset = runtime.simulation.getState()
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(poseAfterReset.positionM).toEqual(poseBeforeReset.positionM)
    expect(poseAfterReset.orientation).toEqual(poseBeforeReset.orientation)
    expect(poseAfterReset.timeSeconds).toBe(poseBeforeReset.timeSeconds)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })

  it('applies a requested training spawn/orientation only through a disarmed reset', () => {
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)

    const setup: LessonSetup = {
      requiresDisarmed: true,
      resetSimulation: true,
      sceneReferenceIds: ['split-s-reference'],
      spawnPositionM: { x: 2, y: 25, z: -3 },
      spawnOrientation: { x: 0, y: 0.70710678, z: 0, w: 0.70710678 },
    }
    runtime.resetForTraining(setup)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.simulation.getState().positionM).toEqual(setup.spawnPositionM)
    expect(runtime.simulation.getState().orientation.y).toBeCloseTo(setup.spawnOrientation?.y ?? 0)
    expect(runtime.simulation.getState().orientation.w).toBeCloseTo(setup.spawnOrientation?.w ?? 1)
    runtime.dispose()
  })

  it('requires explicit rearm after blur, invalid input, and source changes', () => {
    const handoff = createHandoff()
    const poller = new FakePoller(handoff.device, handoff.snapshot)
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      poller,
      profile: handoff.profile,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)

    window.dispatchEvent(new Event('blur'))
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.arm()).toBe(true)

    poller.snapshot = { ...handoff.snapshot, axes: [Number.NaN, 0, 0, -1], timestamp: 3, invalidAxisIndices: [0] }
    poller.state = { ...poller.state, snapshots: [poller.snapshot] }
    frames.run(100)
    expect(runtime.getTelemetry().armed).toBe(false)

    runtime.setInputSource('keyboard')
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.setInputSource('controller')
    expect(runtime.getTelemetry().armed).toBe(false)

    runtime.setInputSource('keyboard')
    expect(runtime.arm()).toBe(true)
    runtime.setControllerProfile({ ...handoff.profile, calibrationTimestamp: '2026-01-02T00:00:00.000Z' })
    expect(runtime.getTelemetry().armed).toBe(false)
    runtime.dispose()
  })

  it('disarms and blocks arm while the visible renderer is unavailable', () => {
    const frames = nextFrameRunner()
    const runtime = new FlightRuntime({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      now: () => 100,
    })
    runtime.setInputSource('keyboard')
    runtime.start()
    frames.run(0)
    expect(runtime.arm()).toBe(true)

    runtime.setRenderingAvailable(false, 'WebGL context was lost; recover the viewport before arming.')
    expect(runtime.isRenderingAvailable()).toBe(false)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.getTelemetry().safetyReasons).toContain('WebGL context was lost; recover the viewport before arming.')
    expect(runtime.arm()).toBe(false)

    runtime.setRenderingAvailable(true)
    expect(runtime.isRenderingAvailable()).toBe(true)
    expect(runtime.getTelemetry().armed).toBe(false)
    expect(runtime.arm()).toBe(true)
    runtime.dispose()
  })
})
