import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { crossVector3, type Vector3 } from '../math/vector'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import type { TuningSettings } from '../tuning/config'
import { createWideGates } from '../world/wideGates'
import type { TeachingCue } from './demonstrations'
import { createTrainingFieldAnchors } from './field'

const STEP_SECONDS = 1 / 240
const MAXIMUM_DURATION_SECONDS = 95
const CAPACITY = 6_000

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalized(value: Vector3): Vector3 {
  const length = Math.hypot(value.x, value.y, value.z)
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}

/** Record real RC flight with the same solid frames used by live L09 practice. */
export function recordGateDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch } = createTrainingFieldAnchors(settings.drone)
  const gates = createWideGates(launch, settings.drone.ground.heightM)
  const altitude = gates[0].positionM.y
  simulation.resetForTraining(launch, { x: 0, y: 0, z: 0, w: 1 }, gates.flatMap((gate) => gate.colliders))
  simulation.arm()
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const cues: TeachingCue[] = [{
    timeSeconds: 0,
    text: '從地面自行起飛，對準三道寬門的開口依序穿過；門框有實際碰撞，示範不算通關。',
    targetReferenceId: gates[0].id,
  }]
  let flyingForward = false
  let nextGate = 0
  let finished = false
  const finalDestinationZ = gates[gates.length - 1].positionM.z - 2

  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const velocity = state.velocityMps
    const desiredVelocityX = clamp((launch.x - state.positionM.x) * 0.65, -1.2, 1.2)
    const destinationZ = flyingForward ? finalDestinationZ : launch.z
    const desiredVelocityZ = clamp((destinationZ - state.positionM.z) * 0.65, -1.3, 1.3)
    const accelerationX = clamp((desiredVelocityX - velocity.x) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.x * velocity.x / settings.drone.massKg, -1.5, 1.5)
    const accelerationZ = clamp((desiredVelocityZ - velocity.z) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.z * velocity.z / settings.drone.massKg, -1.5, 1.5)
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const targetUp = normalized({ x: accelerationX, y: settings.drone.gravityMps2, z: accelerationZ })
    const tiltCorrection = crossVector3(up, targetUp)
    const forward = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
    const headingAngle = Math.atan2(forward.x, -forward.z)
    const worldRate = {
      x: clamp(tiltCorrection.x * 3.5, -0.6, 0.6),
      y: clamp(headingAngle * 2, -0.5, 0.5),
      z: clamp(tiltCorrection.z * 3.5, -0.6, 0.6),
    }
    const pilotRates = bodyAngularRateToPilotAxes(inverseRotateVectorByQuaternion(state.orientation, worldRate))
    return {
      roll: stickForRate(settings, 'roll', pilotRates.roll * 180 / Math.PI),
      pitch: stickForRate(settings, 'pitch', pilotRates.pitch * 180 / Math.PI),
      yaw: stickForRate(settings, 'yaw', pilotRates.yaw * 180 / Math.PI),
      throttle: collectiveThrottle(simulation, time < 0.5 ? launch.y : altitude),
    }
  }
  const initialInput = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const input = inputAt(index * STEP_SECONDS)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError(`目前設定無法完成寬門模擬示範，請採用新手或一般預設後重試。${step.warnings.join(' ')}`)
    }
    const retained = recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })
    if (!retained) continue
    const state = step.state
    if (!flyingForward) {
      if (state.timeSeconds > 0.5 && Math.abs(state.positionM.y - altitude) < 0.2 && Math.abs(state.velocityMps.y) < 0.3) {
        flyingForward = true
        cues.push({ timeSeconds: state.timeSeconds,
          text: '已自行起飛；看向第一道門開口，以小量 Pitch 建立前進、油門維持高度，留出機身與槳葉的門框間距。',
          targetReferenceId: gates[0].id })
      }
      continue
    }
    while (nextGate < gates.length && state.positionM.z <= gates[nextGate].positionM.z) {
      nextGate += 1
      cues.push({ timeSeconds: state.timeSeconds,
        text: nextGate < gates.length
          ? `已穿過第 ${nextGate} 道門；繼續對準第 ${nextGate + 1} 道門開口，飛行路線保持在門框中間，不要求精準速度或停留。`
          : '已穿過第三道門，繼續向前離開門框；不需停穩或降落。',
        targetReferenceId: gates[Math.min(nextGate, gates.length - 1)].id })
    }
    // Keep the final cue on a retained physical frame beyond the final gate.
    if (nextGate === gates.length && state.positionM.z <= gates[gates.length - 1].positionM.z - 1) {
      cues.push({ timeSeconds: state.timeSeconds,
        text: '已依序穿過三道寬門且未碰撞門框；真人練習只需依序穿過開口，不要求精準速度、停留或降落。',
        targetReferenceId: gates[gates.length - 1].id })
      finished = true
      break
    }
  }
  if (!finished) throw new RangeError('目前設定無法在錄影容量內完成寬門示範，請採用新手或一般預設後重試。')
  return { recording: recorder.endFlight(), cues: Object.freeze(cues.map((cue) => Object.freeze(cue))) }
}
