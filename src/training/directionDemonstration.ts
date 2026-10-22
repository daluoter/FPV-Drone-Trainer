import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { crossVector3, type Vector3 } from '../math/vector'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import type { TuningSettings } from '../tuning/config'
import type { RateAxis } from '../rates'
import { createDirectionControlTargets } from './directionControl'
import { createTrainingFieldAnchors } from './field'
import type { TeachingCue } from './demonstrations'

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

/** Only generates recorded RC input; it is never installed in the live runtime. */
export function recordDirectionDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch } = createTrainingFieldAnchors(settings.drone)
  const targets = createDirectionControlTargets(launch, settings.drone.ground.heightM)
  const altitude = targets[0].positionM.y
  simulation.resetAt(launch)
  simulation.arm()
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const cues: TeachingCue[] = [{
    timeSeconds: 0,
    text: '從地面自行起飛，再練左右側移、前後移動與換向後方向感；這是模擬錄製，示範不算通關。',
    targetReferenceId: targets[0].id,
  }]
  const descriptions = [
    '機頭先保持朝前；用小量 Roll 向右側移到目標區，再反向修正減少漂移。',
    '機頭仍朝原方向，向左側移到另一側；回中不會自動消除移動速度。',
    '保持朝向，用 Pitch 向前飛到目標區，同時以油門修正高度。',
    '維持朝向，向後移回目標區；留意畫面下方的目標方向提示。',
    '在目標區附近向右偏航約九十度；轉機頭不會直接改變所在位置。',
    '換向後，機頭前方改為原場地的右邊；向目前前方飛到目標區。',
    '換向後再向目前右邊側移；場地 Z 數字會增加，已與原本機頭方向不同。',
  ]
  let targetIndex = -1
  let settledSince: number | null = null
  let finished = false

  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const target = targetIndex >= 0 ? targets[targetIndex] : null
    const destination = target?.positionM ?? { ...launch, y: altitude }
    const desiredAltitude = time < 0.5 ? launch.y : altitude
    const velocity = state.velocityMps
    const desiredVelocityX = clamp((destination.x - state.positionM.x) * 0.65, -1.2, 1.2)
    const desiredVelocityZ = clamp((destination.z - state.positionM.z) * 0.65, -1.2, 1.2)
    const accelerationX = clamp((desiredVelocityX - velocity.x) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.x * velocity.x / settings.drone.massKg, -1.5, 1.5)
    const accelerationZ = clamp((desiredVelocityZ - velocity.z) * 2.4
      + settings.drone.linearDragCoefficientNPerMps.z * velocity.z / settings.drone.massKg, -1.5, 1.5)
    const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
    const targetUp = normalized({ x: accelerationX, y: settings.drone.gravityMps2, z: accelerationZ })
    const tiltCorrection = crossVector3(up, targetUp)
    const forward = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
    const desiredForward = target?.headingForward ?? { x: 0, y: 0, z: -1 }
    const headingAngle = Math.atan2(
      forward.z * desiredForward.x - forward.x * desiredForward.z,
      forward.x * desiredForward.x + forward.z * desiredForward.z,
    )
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
      throttle: collectiveThrottle(simulation, desiredAltitude),
    }
  }
  const initialInput = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const time = index * STEP_SECONDS
    const input = inputAt(time)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError('目前設定無法完成方向感模擬示範，請採用新手或一般預設後重試。')
    }
    const retained = recorder.record({ timestampSeconds: step.state.timeSeconds, state: step.state, normalizedInput: input, armed: true, telemetry: step.telemetry })
    const state = step.state
    if (targetIndex < 0) {
      if (retained && time > 0.5 && Math.abs(state.positionM.y - altitude) < 0.2 && Math.abs(state.velocityMps.y) < 0.3) {
        targetIndex = 0
        cues.push({ timeSeconds: state.timeSeconds, text: descriptions[0], targetReferenceId: targets[0].id })
      }
      continue
    }
    const target = targets[targetIndex]
    const error = Math.hypot(state.positionM.x - target.positionM.x, state.positionM.y - target.positionM.y, state.positionM.z - target.positionM.z)
    const forward = rotateVectorByQuaternion(state.orientation, { x: 0, y: 0, z: -1 })
    const headingError = Math.acos(clamp((forward.x * target.headingForward.x + forward.z * target.headingForward.z)
      / Math.hypot(forward.x, forward.z), -1, 1))
    const settled = error < 0.35 && Math.hypot(state.velocityMps.x, state.velocityMps.z) < 0.25
      && Math.abs(state.velocityMps.y) < 0.2 && headingError < 0.08
    settledSince = settled ? settledSince ?? state.timeSeconds : null
    // Align caption/target transitions with an actually retained physical
    // frame. Otherwise a final cue can sit beyond the decimated replay tail.
    if (settledSince === null || state.timeSeconds - settledSince < 0.5 || !retained) continue
    settledSince = null
    targetIndex += 1
    if (targetIndex === targets.length) {
      cues.push({ timeSeconds: state.timeSeconds, text: '已完成側移、前後移動與換向後方向感；真人練習以依序進入目標區為主，不要求精準停留。', targetReferenceId: target.id })
      finished = true
      break
    }
    cues.push({ timeSeconds: state.timeSeconds, text: descriptions[targetIndex], targetReferenceId: targets[targetIndex].id })
  }
  if (!finished) throw new RangeError('目前設定無法在錄影容量內完成方向感示範，請採用新手或一般預設後重試。')
  return {
    recording: recorder.endFlight(),
    cues: Object.freeze(cues.map((cue) => Object.freeze(cue))),
  }
}
