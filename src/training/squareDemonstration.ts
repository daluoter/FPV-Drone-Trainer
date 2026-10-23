import { bodyAngularRateToPilotAxes, FlightSimulation, type NormalizedRcInput } from '../flight-controller'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { crossVector3, type Vector3 } from '../math/vector'
import type { RateAxis } from '../rates'
import { FlightReplayRecorder, type ReplayRecording } from '../replay'
import type { TuningSettings } from '../tuning/config'
import { createSquareRouteTargets } from './squareRoute'
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

/** Generate bounded physical RC flight for playback, never for the live runtime. */
export function recordSquareDemonstration(
  simulation: FlightSimulation,
  settings: TuningSettings,
  stickForRate: (settings: TuningSettings, axis: RateAxis, desiredDegrees: number) => number,
  collectiveThrottle: (simulation: FlightSimulation, altitudeM: number, maximumVerticalSpeed?: number) => number,
): { readonly recording: ReplayRecording; readonly cues: readonly TeachingCue[] } {
  const { launch } = createTrainingFieldAnchors(settings.drone)
  const targets = createSquareRouteTargets(launch, settings.drone.ground.heightM)
  const altitude = targets[0].positionM.y
  simulation.resetAt(launch)
  simulation.arm()
  const recorder = new FlightReplayRecorder({ capacity: CAPACITY, decimation: 4 })
  recorder.beginFlight()
  const cues: TeachingCue[] = [{
    timeSeconds: 0,
    text: '從地面自行起飛，依序飛完四段方形航線，再回到起點上方；這是實際物理模擬錄製，示範不算通關。',
    targetReferenceId: targets[0].id,
  }]
  const descriptions = [
    '第一段向原場地前方直飛；用小量 Pitch 建立前進，油門修正高度，先通過亮起的直線目標。',
    '接近第一個角落，小量 Roll 右傾並配合 Yaw 向右轉頭；看向下一段，不要求在角落停穩。',
    '第二段沿新機頭方向直飛，朝原場地右側前進；逐步修正 Roll 回正，油門維持高度。',
    '接近第二個角落，再用小量 Roll 與 Yaw 右轉；讓實際路線一起轉向，回中不會自動回平。',
    '第三段朝原場地後方直飛；機身前方已與起飛時相反，固定 XYZ 不會隨機頭旋轉。',
    '接近第三個角落，配合傾斜、轉頭與前進再次右轉；留意高度，準備第四段回程。',
    '第四段朝原場地左側前進；依目前機頭看前方目標，不用轉回起飛時的朝向。',
    '沿第四段飛回起點上方的綠色終點；保持在空中飛入即可，不要求降落或停穩。',
  ]
  let targetIndex = -1
  let finished = false

  const inputAt = (time: number): NormalizedRcInput => {
    const state = simulation.getState()
    const target = targetIndex >= 0 ? targets[targetIndex] : null
    const destination = target?.positionM ?? { ...launch, y: altitude }
    const velocity = state.velocityMps
    const desiredVelocityX = clamp((destination.x - state.positionM.x) * 0.65, -1.3, 1.3)
    const desiredVelocityZ = clamp((destination.z - state.positionM.z) * 0.65, -1.3, 1.3)
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
      throttle: collectiveThrottle(simulation, time < 0.5 ? launch.y : altitude),
    }
  }
  const initialInput = inputAt(0)
  recorder.record({ timestampSeconds: 0, state: simulation.getState(), normalizedInput: initialInput, armed: true, telemetry: simulation.getTelemetry() })
  for (let index = 0; index < MAXIMUM_DURATION_SECONDS / STEP_SECONDS; index += 1) {
    const time = index * STEP_SECONDS
    const input = inputAt(time)
    const step = simulation.step(input, STEP_SECONDS)
    if (step.state.crashed || step.reset || !step.telemetry.armed) {
      throw new RangeError('目前設定無法完成方形航線模擬示範，請採用新手或一般預設後重試。')
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
    // Continue through the route without a stationary dwell at its waypoints.
    // Only retained real frames may switch the visible target or end caption.
    if (!retained || error >= 0.4 || headingError >= 0.25) continue
    targetIndex += 1
    if (targetIndex === targets.length) {
      cues.push({ timeSeconds: state.timeSeconds, text: '已完成四段方形航線並回到起點上方；真人練習依序飛入目標即可，不要求精準速度、停留或降落。', targetReferenceId: target.id })
      finished = true
      break
    }
    cues.push({ timeSeconds: state.timeSeconds, text: descriptions[targetIndex], targetReferenceId: targets[targetIndex].id })
  }
  if (!finished) throw new RangeError('目前設定無法在錄影容量內完成方形航線示範，請採用新手或一般預設後重試。')
  return {
    recording: recorder.endFlight(),
    cues: Object.freeze(cues.map((cue) => Object.freeze(cue))),
  }
}
