import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState } from '../drone'
import { TRAINING_ROUTE_ALTITUDE_AGL_M } from './field'
import type { LessonLearningContent } from './catalog'
import type {
  LessonDefinition,
  LessonEvaluatorContract,
  TrainingEvaluation,
  TrainingEvaluationContext,
  TrainingSample,
} from './types'

/** The visible ring opening plus a small edge allowance for beginner practice. */
export const STRAIGHT_LINE_GATE_RADIUS_M = 1.5
export const STRAIGHT_LINE_GATE_TOLERANCE_M = 0.1
export const STRAIGHT_LINE_ROUTE_LENGTH_M = 8
export const STRAIGHT_LINE_TARGET_HEIGHT_AGL_M = TRAINING_ROUTE_ALTITUDE_AGL_M
export const STRAIGHT_LINE_TRANSIT_DISTANCE_M = 3
/** Stable reference name: the gold ring is now a passage goal, not a braking test. */
export const STRAIGHT_LINE_BRAKE_ZONE_START_M = 5

const MAXIMUM_SAMPLE_GAP_SECONDS = 0.35
const TIME_LIMIT_SECONDS = 90
const GATE_DISTANCES = [STRAIGHT_LINE_TRANSIT_DISTANCE_M, STRAIGHT_LINE_BRAKE_ZONE_START_M, STRAIGHT_LINE_ROUTE_LENGTH_M] as const
const GATE_CHECKPOINTS = ['straight-transit', 'straight-brake', 'straight-stop'] as const
const GATE_NAMES = ['藍色', '金色', '綠色終點'] as const
const ACCEPTED_RADIUS_M = STRAIGHT_LINE_GATE_RADIUS_M + STRAIGHT_LINE_GATE_TOLERANCE_M

function metric(context: TrainingEvaluationContext, name: string): number {
  const value = context.previousEvaluation?.metrics?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', metrics, message, hint: '先 Disarm 停止馬達，再重設課程並自行起飛。' }
}

function evaluateStraightLine(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0
    || !Number.isFinite(context.elapsedSeconds) || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) {
    return terminal('直線練習停止：時間或飛行狀態含無效數值。')
  }
  if (sample.state.crashed) return terminal('直線練習停止：機體已撞擊，請重設後重試。')
  if (sample.armed === false) return terminal('直線練習停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖的飛行資料。' }

  const pad = context.sceneReferences.find((reference) => reference.id === 'takeoff-pad')
  const launch = context.sceneReferences.find((reference) => reference.id === 'training-launch')
  const surface = context.sceneReferences.find((reference) => reference.id === 'landing-surface')
  if (!pad || !launch || !surface || !Object.values(pad.positionM).every(Number.isFinite)
    || !Object.values(launch.positionM).every(Number.isFinite) || !Object.values(surface.positionM).every(Number.isFinite)) {
    return terminal('直線練習無法取得有效起飛區參考，請重設訓練場。')
  }
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM)
    || !Number.isFinite(contact.supportOffsetM) || contact.supportOffsetM < 0
    || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) {
    return terminal('直線練習停止：缺少有效的地面接觸資料，不能跳過自行起飛。')
  }
  const position = sample.state.positionM
  const velocity = sample.state.velocityMps
  const groundClearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (groundClearance < -0.003 || (contact.touching && Math.abs(groundClearance) > 0.003)) {
    return terminal('直線練習停止：接地標記與機體支撐高度不一致。')
  }
  const targetAltitude = surface.positionM.y + STRAIGHT_LINE_TARGET_HEIGHT_AGL_M
  const progress = pad.positionM.z - position.z
  const launchDistance = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const groundStarted = context.checkpoints['straight-ground']?.completed === true
  let started = context.checkpoints['straight-start']?.completed === true
  let gatesPassed = 0
  while (gatesPassed < GATE_CHECKPOINTS.length && context.checkpoints[GATE_CHECKPOINTS[gatesPassed]]?.completed) gatesPassed += 1
  const metrics: Record<string, number> = {
    alongTrackM: progress,
    crossTrackErrorM: Math.abs(position.x - pad.positionM.x),
    launchDistanceM: launchDistance,
    groundClearanceM: groundClearance,
    launchHeightM: Math.max(0, position.y - launch.positionM.y),
    altitudeM: position.y - surface.positionM.y,
    targetAltitudeM: STRAIGHT_LINE_TARGET_HEIGHT_AGL_M,
    altitudeErrorM: Math.abs(position.y - targetAltitude),
    forwardSpeedMps: -velocity.z,
    horizontalSpeedMps: Math.hypot(velocity.x, velocity.z),
    verticalSpeedMps: Math.abs(velocity.y),
    stopErrorM: Math.hypot(position.x - pad.positionM.x, progress - STRAIGHT_LINE_ROUTE_LENGTH_M),
    peakForwardSpeedMps: Math.max(metric(context, 'peakForwardSpeedMps'), -velocity.z, 0),
    groundStarted: groundStarted ? 1 : 0,
    takeoffReady: started ? 1 : 0,
    gatesPassed,
    nextGateIndex: gatesPassed,
    nextGateDistanceM: gatesPassed < 3 ? GATE_DISTANCES[gatesPassed] - progress : 0,
    nextGateErrorM: Math.hypot(position.x - pad.positionM.x, position.y - targetAltitude),
    routePhase: started ? gatesPassed + 1 : 0,
  }

  // Retain integrity checks independently of teaching difficulty: physical
  // history must be continuous even when a learner misses and retries a ring.
  const previous = context.previousFlightSample ?? context.previousSample
  if (previous) {
    const delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0
      || delta > MAXIMUM_SAMPLE_GAP_SECONDS || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) {
      return terminal('直線練習停止：資料中斷、時間倒退或模擬被重設。', metrics)
    }
    const beforeVelocity = previous.state.velocityMps
    const error = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.velocityConsistencyErrorM = error
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (error > metrics.integrationToleranceM) {
      return terminal('直線練習停止：位置跳躍與速度不一致，不能跳過路線。', metrics)
    }
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > TIME_LIMIT_SECONDS) {
    return terminal('直線挑戰逾時：尚未依序通過三個圈圈。', metrics)
  }

  const checkpointIds: string[] = []
  const groundedStart = contact.touching && launchDistance <= ACCEPTED_RADIUS_M
  if (!groundStarted) {
    if (groundedStart) checkpointIds.push('straight-ground')
    metrics.groundStarted = groundedStart ? 1 : 0
    return {
      status: 'continue', checkpointIds, metrics,
      hint: groundedStart ? '地面準備完成；自行加油門起飛，再朝前方圈圈飛行。'
        : '請先回起飛區實際接地，再自行起飛；不需要重新開始整課。',
    }
  }
  if (!started) {
    // Actual liftoff is sufficient. The start marker is guidance, so diagonal
    // takeoff does not get trapped behind a hidden launch-area hover target.
    started = !contact.touching && groundClearance >= 0.15
    if (!started) {
      return {
        status: 'continue', checkpointIds, metrics,
        hint: `自行起飛後，依序穿過前方圈圈；建議高度約 ${STRAIGHT_LINE_TARGET_HEIGHT_AGL_M.toFixed(1)} m，無須先懸停。`,
      }
    }
    checkpointIds.push('straight-start')
    metrics.takeoffReady = 1
    metrics.routePhase = 1
  }

  let missedError = metric(context, 'missedGateErrorM')
  if (previous && !contact.touching) {
    const beforeProgress = pad.positionM.z - previous.state.positionM.z
    // A single continuous sample may cross several gates at speed. Evaluate
    // each segment-plane intersection in route order, not endpoint proximity.
    while (gatesPassed < GATE_DISTANCES.length) {
      const distance = GATE_DISTANCES[gatesPassed]
      if (!(progress > beforeProgress && beforeProgress <= distance && progress >= distance)) break
      const fraction = (distance - beforeProgress) / (progress - beforeProgress)
      const crossingX = previous.state.positionM.x + (position.x - previous.state.positionM.x) * fraction
      const crossingY = previous.state.positionM.y + (position.y - previous.state.positionM.y) * fraction
      const radialError = Math.hypot(crossingX - pad.positionM.x, crossingY - targetAltitude)
      metrics.lastGateCrossingErrorM = radialError
      if (radialError > ACCEPTED_RADIUS_M) {
        missedError = radialError
        break
      }
      checkpointIds.push(GATE_CHECKPOINTS[gatesPassed])
      gatesPassed += 1
      missedError = 0
    }
  }
  metrics.gatesPassed = gatesPassed
  metrics.nextGateIndex = gatesPassed
  metrics.nextGateDistanceM = gatesPassed < 3 ? GATE_DISTANCES[gatesPassed] - progress : 0
  metrics.missedGateErrorM = missedError
  metrics.routePhase = gatesPassed + 1
  if (gatesPassed === GATE_DISTANCES.length) {
    return {
      status: 'success', checkpointIds, metrics, score: 100,
      message: '已自行起飛並依序穿過藍色、金色與綠色圈圈，直線課完成。',
      hint: '本課以依序穿圈為目標，不要求減速或停穩。先 Disarm，再查看結果。',
    }
  }
  const name = GATE_NAMES[gatesPassed]
  const distance = GATE_DISTANCES[gatesPassed]
  const pastGate = progress >= distance
  return {
    status: 'continue', checkpointIds, metrics,
    hint: pastGate
      ? `尚未穿過${name}圈（前方 ${distance} m）。${missedError > 0 ? `上次穿越距圓心 ${missedError.toFixed(2)} m，容許半徑 ${ACCEPTED_RADIUS_M.toFixed(2)} m。` : ''}回到這一圈前方，再朝前穿過；已通過的圈會保留，不需回地面。`
      : `已通過 ${gatesPassed}／3 個圈。對準${name}圈（前方 ${distance} m），還有 ${(distance - progress).toFixed(1)} m；穿圈即可，不要求減速或停穩。`,
  }
}

export const straightLineEvaluator: LessonEvaluatorContract = { evaluate: evaluateStraightLine }

export const STRAIGHT_LINE_LESSON: LessonDefinition = {
  id: 'straight-line', priority: 1.5, title: 'Straight Line Through Rings',
  description: '從地面自行起飛，依序穿過藍色、金色與綠色圈圈。',
  availability: 'available', available: true,
  objectives: ['從地面自行起飛到圈圈附近。', '依序穿過三公尺藍圈、五公尺金圈與八公尺綠圈。', '通過最後一圈即完成，不要求減速或停穩。'],
  setup: {
    requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['takeoff-pad', 'training-launch', 'landing-surface'],
    spawnPositionM: { x: 0, y: 0, z: 0 }, spawnOrientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  checkpoints: [
    { id: 'straight-ground', title: '地面準備', description: '從起飛區實際地面開始。' },
    { id: 'straight-start', title: '自行起飛', description: '實際離地即可，不要求在起點懸停。' },
    { id: 'straight-transit', title: '穿過藍色圈', description: '朝前穿過三公尺藍色圈的開口。' },
    { id: 'straight-brake', title: '穿過金色圈', description: '朝前穿過五公尺金色圈，不要求減速。' },
    { id: 'straight-stop', title: '穿過綠色圈', description: '朝前穿過八公尺綠色圈即完成。' },
  ],
  success: {
    title: '直線穿圈完成', description: '已從地面自行起飛並依序穿過三個圈圈。',
    criteria: ['連續且依序的真實穿圈軌跡', '穿過圈圈開口', '無須減速比例或停點時間'],
  },
  failure: {
    title: '直線穿圈尚未完成', description: '對準尚未通過的圈，可保留前面進度繼續練習。',
    criteria: ['不能瞬移、重設或以示範取得成績', '墜毀或解除解鎖則停止', '圈外穿越不計入該圈'],
  },
  scoring: {
    maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0,
    metricLabels: ['gatesPassed', 'nextGateDistanceM', 'nextGateErrorM', 'altitudeM'],
  },
  hints: ['先以順利穿圈為主；需要回頭補圈時，先轉向繞回該圈前方，再朝路線前方穿越。'],
  evaluator: straightLineEvaluator,
}

export const STRAIGHT_LINE_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L02', title: '起飛與直線穿圈', level: '入門', prerequisiteIds: ['takeoff'],
  objectives: ['從地面自行起飛，依序穿過三個圈圈。', '通過綠色終點圈即完成，不要求減速或停穩。'],
  steps: [
    '從地面自行起飛到起點圈附近，建議高度約三公尺；不需要先懸停。',
    '朝前飛過三公尺藍圈，再飛過五公尺金圈。',
    '穿過八公尺綠色圈即完成；圈圈半徑 1.5 m，邊緣另有 0.1 m 容差。',
    '沒有穿進開口時，回到漏過的圈前方重新穿越即可，已完成的圈會保留。',
  ],
  commonMistakes: ['從圈圈外側或上方繞過不算穿圈；依藍、金、綠順序穿過開口。'],
}
