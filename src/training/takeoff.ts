import { isFiniteDroneState } from '../drone'
import { rotateVectorByQuaternion } from '../math/quaternion'
import type {
  LessonEvaluatorContract,
  TrainingEvaluation,
  TrainingEvaluationContext,
  TrainingSample,
} from './types'

/** Prototype training tolerances, not validated real-flight limits. */
export const TAKEOFF_TARGET_HEIGHT_M = 2
export const TAKEOFF_SETTLED_DWELL_SECONDS = 1.5

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function failure(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return {
    status: 'failure',
    metrics,
    message,
    hint: '解除解鎖並重試，從起飛墊緩慢加油門，保持機身水平。',
  }
}

function evaluateTakeoff(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !isFiniteDroneState(sample.state)) {
    return failure('起飛測驗停止：飛行狀態包含無效或非有限數值。')
  }
  if (sample.state.crashed) return failure('起飛測驗停止：機體墜毀，請重設後重試。')
  if (sample.armed === false) return failure('起飛測驗停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) {
    return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  }

  const pad = context.sceneReferences.find((reference) => reference.id === 'takeoff-pad')
  if (!pad || !Object.values(pad.positionM).every(Number.isFinite)) {
    return failure('無法取得起飛墊參考位置，請重設訓練場。')
  }
  const position = sample.state.positionM
  const velocity = sample.state.velocityMps
  const relativeAltitude = position.y - pad.positionM.y
  const targetAltitude = pad.positionM.y + TAKEOFF_TARGET_HEIGHT_M
  const altitudeError = Math.abs(position.y - targetAltitude)
  const horizontalDrift = Math.hypot(position.x - pad.positionM.x, position.z - pad.positionM.z)
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
  const verticalSpeed = Math.abs(velocity.y)
  const up = rotateVectorByQuaternion(sample.state.orientation, { x: 0, y: 1, z: 0 })
  const tilt = Math.acos(Math.min(1, Math.max(-1, up.y))) * 180 / Math.PI
  const metrics: Record<string, number> = {
    altitudeM: relativeAltitude,
    targetAltitudeM: TAKEOFF_TARGET_HEIGHT_M,
    altitudeErrorM: altitudeError,
    horizontalDriftM: horizontalDrift,
    horizontalSpeedMps: horizontalSpeed,
    verticalSpeedMps: verticalSpeed,
    maxTiltDegrees: tilt,
    contiguousDwellSeconds: 0,
    settled: 0,
  }

  const previous = context.previousSample
  const delta = previous ? sample.timestampSeconds - previous.timestampSeconds : 0
  if (previous) {
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35
      || sample.state.stepIndex < previous.state.stepIndex) {
      return failure('起飛測驗停止：飛行資料中斷、時間倒退或模擬被重設。', metrics)
    }
    const displacement = {
      x: position.x - previous.state.positionM.x,
      y: position.y - previous.state.positionM.y,
      z: position.z - previous.state.positionM.z,
    }
    const previousVelocity = previous.state.velocityMps
    const consistencyError = Math.hypot(
      displacement.x - (velocity.x + previousVelocity.x) * 0.5 * delta,
      displacement.y - (velocity.y + previousVelocity.y) * 0.5 * delta,
      displacement.z - (velocity.z + previousVelocity.z) * 0.5 * delta,
    )
    const tolerance = 0.04 + 10 * delta * delta
    metrics.velocityConsistencyErrorM = consistencyError
    metrics.integrationToleranceM = tolerance
    if (consistencyError > tolerance || Math.hypot(displacement.x, displacement.y, displacement.z) / delta > 6) {
      return failure('起飛測驗停止：位置跳躍與實際速度不一致，無法計入起飛。', metrics)
    }
  }

  if (horizontalDrift > 4 || relativeAltitude > 6 || relativeAltitude < -0.55
    || horizontalSpeed > 4 || verticalSpeed > 3.5 || tilt > 45) {
    return failure('起飛超出安全練習範圍：偏離、速度、高度或傾角過大。', metrics)
  }

  const ready = context.checkpoints['takeoff-ready']?.completed === true
  const lifted = context.checkpoints['takeoff-liftoff']?.completed === true
  const padReady = horizontalDrift <= 0.8 && relativeAltitude >= -0.5 && relativeAltitude <= 0.35
    && horizontalSpeed <= 0.6 && verticalSpeed <= 0.8 && tilt <= 12
  if (!ready && !padReady) {
    return failure('必須從起飛墊附近的低高度水平狀態開始，不能在空中跳過起飛。', metrics)
  }
  if (lifted && relativeAltitude < 0.15) {
    return failure('離地後落回起飛墊，請重新起飛並在目標高度穩住。', metrics)
  }

  const liftoff = ready && relativeAltitude >= 0.6
  const settled = (lifted || liftoff) && altitudeError <= 0.35 && horizontalDrift <= 1.2
    && horizontalSpeed <= 0.6 && verticalSpeed <= 0.6 && tilt <= 12
  const dwell = settled && metric(context, 'settled') === 1
    ? metric(context, 'contiguousDwellSeconds') + delta
    : 0
  metrics.settled = settled ? 1 : 0
  metrics.contiguousDwellSeconds = dwell
  const checkpointIds = [
    ...(!ready && padReady ? ['takeoff-ready'] : []),
    ...(liftoff ? ['takeoff-liftoff'] : []),
    ...(settled && dwell >= TAKEOFF_SETTLED_DWELL_SECONDS ? ['takeoff-settle'] : []),
  ]
  const score = Math.max(0, Math.min(100,
    100 - altitudeError * 15 - horizontalDrift * 8 - horizontalSpeed * 5 - verticalSpeed * 5 - tilt * 0.5,
  ))
  if (context.elapsedSeconds > 25) {
    return { ...failure('起飛測驗逾時：尚未完成連續穩定停留。', metrics), checkpointIds, score }
  }
  if (settled && dwell >= TAKEOFF_SETTLED_DWELL_SECONDS && context.elapsedSeconds >= 3) {
    return {
      status: 'success', metrics, checkpointIds, score,
      message: '已從起飛墊離地，並在目標高度連續穩住。',
    }
  }
  return {
    status: 'continue', metrics, checkpointIds, score,
    hint: !ready ? '先保持水平、確認起飛墊位置，再緩慢加油門。'
      : !liftoff && !lifted ? '緩慢增加油門，垂直離地；避免同時大幅推動其他軸。'
        : settled ? '保持小幅修正，在目標高度穩住 1.5 秒。'
          : '靠近起飛墊上方 2 公尺的目標高度，先減少上升或下降速度。',
  }
}

export const takeoffEvaluator: LessonEvaluatorContract = { evaluate: evaluateTakeoff }
