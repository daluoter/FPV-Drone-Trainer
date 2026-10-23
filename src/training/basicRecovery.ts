import { DRONE_GROUND_CLEARANCE_M, isFiniteDroneState, type DroneState } from '../drone'
import { inverseRotateVectorByQuaternion, rotateVectorByQuaternion } from '../math/quaternion'
import { isFiniteVector3 } from '../math/vector'
import type { LessonLearningContent } from './catalog'
import type { LessonDefinition, LessonEvaluatorContract, TrainingEvaluation, TrainingEvaluationContext, TrainingSample } from './types'

export const BASIC_RECOVERY_TIME_LIMIT_SECONDS = 300
export const BASIC_RECOVERY_TARGET_HEIGHT_M = 4
export const BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M = 3
export const BASIC_RECOVERY_MIN_HEIGHT_M = 1
export const BASIC_RECOVERY_SINK_ONSET_MIN_HEIGHT_M = 2.5
export const BASIC_RECOVERY_AREA_RADIUS_M = 40
export const BASIC_RECOVERY_HOLD_SECONDS = 0.25
export const BASIC_RECOVERY_PREPARATION_SECONDS = 0.1
export const BASIC_RECOVERY_PREPARATION_VERTICAL_MPS = 1.5
export const BASIC_RECOVERY_PREPARATION_HORIZONTAL_MPS = 3
export const BASIC_RECOVERY_DRIFT_PREPARATION_MPS = 0.8
export const BASIC_RECOVERY_TILT_ONSET_DEGREES = 15
export const BASIC_RECOVERY_LEVEL_DEGREES = 12
export const BASIC_RECOVERY_SINK_LEVEL_DEGREES = 25
export const BASIC_RECOVERY_DRIFT_LEVEL_DEGREES = 20
export const BASIC_RECOVERY_MAX_BODY_RATE_DEGREES = 90
export const BASIC_RECOVERY_SINK_ONSET_MPS = 0.5
/** Maximum remaining descent; a modest upward correction is also accepted. */
export const BASIC_RECOVERY_SINK_STOP_MPS = 0.2
export const BASIC_RECOVERY_SINK_CLIMB_MPS = 2
export const BASIC_RECOVERY_DRIFT_ONSET_MPS = 1.2
export const BASIC_RECOVERY_DRIFT_STOP_MPS = 1
export const BASIC_RECOVERY_DRIFT_VERTICAL_MPS = 2
export const BASIC_RECOVERY_PHASE_IDS = Object.freeze([
  'recovery-ground', 'recovery-liftoff', 'recovery-tilt-onset', 'recovery-tilt-level',
  'recovery-sink-onset', 'recovery-sink-stop', 'recovery-drift-onset', 'recovery-drift-stop',
] as const)

/** Actual state observations; the evaluator never infers recovery from stick inputs. */
export function measureBasicRecoveryMotion(state: Pick<DroneState, 'orientation' | 'velocityMps' | 'angularVelocityBodyRadPerSec'>) {
  const up = rotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const worldUpInBody = inverseRotateVectorByQuaternion(state.orientation, { x: 0, y: 1, z: 0 })
  const bodyVelocity = inverseRotateVectorByQuaternion(state.orientation, state.velocityMps)
  const degrees = 180 / Math.PI
  return {
    tiltDegrees: Math.acos(Math.max(-1, Math.min(1, up.y))) * degrees,
    // Positive roll is right bank; positive pitch is nose up in the pilot convention.
    rollDegrees: Math.atan2(-worldUpInBody.x, worldUpInBody.y) * degrees,
    pitchDegrees: Math.atan2(-worldUpInBody.z, worldUpInBody.y) * degrees,
    bodyRateDegreesPerSecond: Math.hypot(state.angularVelocityBodyRadPerSec.x, state.angularVelocityBodyRadPerSec.y, state.angularVelocityBodyRadPerSec.z) * degrees,
    verticalSpeedMps: state.velocityMps.y,
    horizontalSpeedMps: Math.hypot(state.velocityMps.x, state.velocityMps.z),
    bodyRightSpeedMps: bodyVelocity.x,
    bodyForwardSpeedMps: -bodyVelocity.z,
  }
}

function terminal(message: string, metrics: Readonly<Record<string, number>> = {}): TrainingEvaluation {
  return { status: 'failure', metrics, message, hint: '本次練習已結束；重試會清空本次步驟，從地面自行起飛後重新練習。' }
}

function previousMetric(context: TrainingEvaluationContext, phase: number, key: string): number {
  const metrics = context.previousEvaluation?.metrics
  const value = metrics?.[key]
  return metrics?.recoveryPhase === phase && typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function phaseMetrics(phase: number): Record<string, number> {
  return {
    recoveryPhase: phase,
    recoveryExercise: phase < 2 ? 0 : phase < 4 ? 1 : phase < 6 ? 2 : phase < 8 ? 3 : 4,
    exercisesCompleted: phase >= 8 ? 3 : phase >= 6 ? 2 : phase >= 4 ? 1 : 0,
    exerciseReady: 0, preparationDwellSeconds: 0, preparationQualifying: 0,
    recoveryDwellSeconds: 0, recoveryQualifying: 0, currentEpisodeValid: 0, episodeInterrupted: 0,
  }
}

function exerciseHint(phase: number, metrics: Readonly<Record<string, number>>): string {
  if (phase === 8) return '已完成傾斜、下沉與漂移恢復；不需要回到原位置或降落，現在可以 Disarm。'
  if (phase === 0) return '請先在起飛區實際接地，不能從空中跳過地面開始。'
  if (phase === 1) return '自行加油門起飛至 3 m 以上，建議約 4 m；不用先精準懸停。'
  if (metrics.insideRecoveryArea < 0.5) return '目前超出練習區；先回到起飛點周圍 40 m 內，再繼續本段。已完成的步驟會保留。'
  const waitingForOnset = phase % 2 === 0 || metrics.currentEpisodeValid < 0.5
  if (waitingForOnset && metrics.exerciseReady < 0.5) return `${metrics.episodeInterrupted > 0.5 ? '本次偏差恢復已中斷，需重新產生偏差；' : ''}先自行升至至少 3 m，依本段提示稍微減少對應的偏差，短暫準備 0.1 秒。傾斜段允許水平漂移，下沉段不要求停在原位置。`
  if (waitingForOnset) return phase <= 3
    ? '準備完成；輕推 Roll 或 Pitch 產生約 15° 傾斜，看到「已偵測偏差」後主動修回水平。'
    : phase <= 5 ? '準備完成；稍收油門，實際下降速度達 0.5 m/s 後，立即補回推力止住下降。'
      : '準備完成；小量 Pitch 或 Roll 建立前進或側移，實際水平速度達 1.2 m/s 後，再反向傾斜減速。'
  return phase === 3
    ? '已偵測傾斜；主動帶回 12° 內並減緩旋轉，維持 0.25 秒。Acro 回中只停止旋轉，不會自動回平。'
    : phase === 5 ? '已偵測下沉；調整姿態與油門，把下降速度減少到 0.2 m/s 內，允許以 2 m/s 內向上修正；保持空中與至少 1 m 高度，維持 0.25 秒。'
      : '已偵測漂移；朝移動反方向適度傾斜減速，再主動帶回接近水平，把水平速度降至 1.0 m/s 內並維持 0.25 秒。'
}

function evaluateBasicRecovery(sample: TrainingSample, context: TrainingEvaluationContext): TrainingEvaluation {
  if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds < 0 || !Number.isFinite(context.elapsedSeconds)
    || context.elapsedSeconds < 0 || !isFiniteDroneState(sample.state)) return terminal('失誤恢復停止：時間或飛行狀態含無效數值。')
  if (sample.state.crashed) return terminal('失誤恢復停止：機體已墜毀，請重設後重試。')
  if (sample.armed === false) return terminal('失誤恢復停止：已解除解鎖或失去焦點。')
  if (sample.armed !== true) return { status: 'continue', metrics: {}, message: '等待實際解鎖後的飛行資料。' }
  const launch = context.sceneReferences.find(({ id }) => id === 'training-launch')
  const surface = context.sceneReferences.find(({ id }) => id === 'landing-surface')
  if (!launch || !surface || !isFiniteVector3(launch.positionM) || !isFiniteVector3(surface.positionM)) return terminal('失誤恢復缺少有效的起飛點或地面參考，請重設訓練場。')
  const contact = sample.groundContact
  if (!contact || typeof contact.touching !== 'boolean' || !Number.isFinite(contact.heightM) || !Number.isFinite(contact.supportOffsetM)
    || contact.supportOffsetM < 0 || Math.abs(contact.heightM - surface.positionM.y) > 1e-5) return terminal('失誤恢復停止：缺少有效的地面接觸資料。')
  const position = sample.state.positionM
  const clearance = position.y - contact.heightM - contact.supportOffsetM - DRONE_GROUND_CLEARANCE_M
  if (clearance < -0.003 || (contact.touching && Math.abs(clearance) > 0.003)) return terminal('失誤恢復停止：接地標記與機體支撐高度不一致。')
  let phase = 0
  while (phase < BASIC_RECOVERY_PHASE_IDS.length && context.checkpoints[BASIC_RECOVERY_PHASE_IDS[phase]]?.completed) phase += 1
  const motion = measureBasicRecoveryMotion(sample.state)
  const altitudeM = position.y - contact.heightM
  const launchDistanceM = Math.hypot(position.x - launch.positionM.x, position.z - launch.positionM.z)
  const airborne = !contact.touching && clearance >= 0.15
  const inside = launchDistanceM <= BASIC_RECOVERY_AREA_RADIUS_M
  const metrics: Record<string, number> = {
    ...motion, ...phaseMetrics(phase), altitudeM, groundClearanceM: clearance, launchDistanceM,
    groundTouching: contact.touching ? 1 : 0, insideRecoveryArea: inside ? 1 : 0,
    targetAltitudeM: BASIC_RECOVERY_TARGET_HEIGHT_M,
  }
  const previous = context.previousFlightSample ?? context.previousSample
  let delta = 0
  if (previous) {
    delta = sample.timestampSeconds - previous.timestampSeconds
    const physicsDelta = sample.state.timeSeconds - previous.state.timeSeconds
    if (!isFiniteDroneState(previous.state) || !Number.isFinite(delta) || delta <= 0 || delta > 0.35 || physicsDelta <= 0
      || Math.abs(physicsDelta - delta) > 1e-6 || sample.state.stepIndex <= previous.state.stepIndex) return terminal('失誤恢復停止：資料中斷、時間倒退或模擬被重設。', metrics)
    const velocity = sample.state.velocityMps
    const beforeVelocity = previous.state.velocityMps
    metrics.velocityConsistencyErrorM = Math.hypot(
      position.x - previous.state.positionM.x - (velocity.x + beforeVelocity.x) * 0.5 * delta,
      position.y - previous.state.positionM.y - (velocity.y + beforeVelocity.y) * 0.5 * delta,
      position.z - previous.state.positionM.z - (velocity.z + beforeVelocity.z) * 0.5 * delta,
    )
    metrics.integrationToleranceM = 0.04 + 10 * delta * delta
    if (metrics.velocityConsistencyErrorM > metrics.integrationToleranceM) return terminal('失誤恢復停止：位置跳躍與速度不一致，不能跳過恢復過程。', metrics)
  }
  if (context.mode !== 'practice' && context.elapsedSeconds > BASIC_RECOVERY_TIME_LIMIT_SECONDS) return terminal('失誤恢復挑戰逾時：尚未完成三種實際偏差與恢復。', metrics)
  const continuing = (): TrainingEvaluation => ({ status: 'continue', metrics, hint: exerciseHint(phase, metrics) })
  const advance = (): TrainingEvaluation => {
    const id = BASIC_RECOVERY_PHASE_IDS[phase]
    phase += 1
    Object.assign(metrics, phaseMetrics(phase))
    if (phase === 3 || phase === 5 || phase === 7) metrics.currentEpisodeValid = 1
    return phase === 8
      ? { status: 'success', checkpointIds: [id], score: 100, metrics, message: '已從地面自行起飛，完成傾斜、下沉及漂移的實際偏差與恢復。', hint: exerciseHint(phase, metrics) }
      : { status: 'continue', checkpointIds: [id], metrics, hint: exerciseHint(phase, metrics) }
  }
  if (phase === 8) return { status: 'success', score: 100, metrics, message: '已完成三種失誤恢復。', hint: exerciseHint(phase, metrics) }
  if (phase === 0) return contact.touching && launchDistanceM <= 1.9 ? advance() : continuing()
  if (phase === 1) return airborne && inside && altitudeM >= BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M ? advance() : continuing()

  const recovering = phase % 2 === 1
  let episodeValid = recovering && previousMetric(context, phase, 'currentEpisodeValid') > 0.5
  let interrupted = previousMetric(context, phase, 'episodeInterrupted') > 0.5
  const wasReady = previousMetric(context, phase, 'exerciseReady') > 0.5
  let ready = wasReady
  const sufficientlyHigh = airborne && altitudeM >= BASIC_RECOVERY_MIN_HEIGHT_M
  if (!sufficientlyHigh) {
    metrics.episodeInterrupted = 1
    return continuing()
  }
  if (recovering && episodeValid) {
    metrics.currentEpisodeValid = 1
    if (!inside) return continuing()
    const levelLimit = phase === 3 ? BASIC_RECOVERY_LEVEL_DEGREES
      : phase === 5 ? BASIC_RECOVERY_SINK_LEVEL_DEGREES : BASIC_RECOVERY_DRIFT_LEVEL_DEGREES
    const level = motion.tiltDegrees <= levelLimit + 1e-8 && motion.bodyRateDegreesPerSecond <= BASIC_RECOVERY_MAX_BODY_RATE_DEGREES
    const correctVerticalSpeed = phase === 5 ? motion.verticalSpeedMps >= -BASIC_RECOVERY_SINK_STOP_MPS && motion.verticalSpeedMps <= BASIC_RECOVERY_SINK_CLIMB_MPS
      : phase === 7 ? Math.abs(motion.verticalSpeedMps) <= BASIC_RECOVERY_DRIFT_VERTICAL_MPS : true
    const correctHorizontalSpeed = phase !== 7 || motion.horizontalSpeedMps <= BASIC_RECOVERY_DRIFT_STOP_MPS
    const recovered = level && correctVerticalSpeed && correctHorizontalSpeed
    metrics.recoveryQualifying = recovered ? 1 : 0
    metrics.recoveryDwellSeconds = recovered && previousMetric(context, phase, 'recoveryQualifying') > 0.5
      ? Math.min(BASIC_RECOVERY_HOLD_SECONDS, previousMetric(context, phase, 'recoveryDwellSeconds') + delta) : 0
    if (metrics.recoveryDwellSeconds + 1e-8 >= BASIC_RECOVERY_HOLD_SECONDS) return advance()
    return continuing()
  }
  // A ground return or low-altitude excursion invalidates only this episode.
  // Its onset checkpoint stays historical; a fresh baseline and onset are needed.
  if (!inside || ((phase === 4 || phase === 5) && altitudeM < BASIC_RECOVERY_SINK_ONSET_MIN_HEIGHT_M)) {
    metrics.episodeInterrupted = interrupted ? 1 : 0
    return continuing()
  }
  // Preparation is specific to the next exercise, rather than requiring an
  // all-axis hover before each attempt. Each onset still has a distinct gap
  // from its preparation range and must follow readiness on an earlier sample.
  const preparationLevel = phase <= 3 ? BASIC_RECOVERY_LEVEL_DEGREES
    : phase <= 5 ? BASIC_RECOVERY_SINK_LEVEL_DEGREES : BASIC_RECOVERY_DRIFT_LEVEL_DEGREES
  const preparationVertical = phase >= 4 && phase <= 5
    ? motion.verticalSpeedMps >= -BASIC_RECOVERY_SINK_STOP_MPS && motion.verticalSpeedMps <= BASIC_RECOVERY_PREPARATION_VERTICAL_MPS
    : Math.abs(motion.verticalSpeedMps) <= BASIC_RECOVERY_PREPARATION_VERTICAL_MPS
  const preparationHorizontal = phase <= 3 || motion.horizontalSpeedMps <= (phase <= 5
    ? BASIC_RECOVERY_PREPARATION_HORIZONTAL_MPS : BASIC_RECOVERY_DRIFT_PREPARATION_MPS)
  const baseline = altitudeM >= BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M
    && motion.tiltDegrees <= preparationLevel + 1e-8
    && motion.bodyRateDegreesPerSecond <= BASIC_RECOVERY_MAX_BODY_RATE_DEGREES
    && preparationVertical && preparationHorizontal
  const preparation = baseline && previousMetric(context, phase, 'preparationQualifying') > 0.5
    ? Math.min(BASIC_RECOVERY_PREPARATION_SECONDS, previousMetric(context, phase, 'preparationDwellSeconds') + delta) : 0
  ready = ready || preparation + 1e-8 >= BASIC_RECOVERY_PREPARATION_SECONDS
  metrics.preparationQualifying = baseline ? 1 : 0
  metrics.preparationDwellSeconds = ready ? BASIC_RECOVERY_PREPARATION_SECONDS : preparation
  metrics.exerciseReady = ready ? 1 : 0
  metrics.episodeInterrupted = interrupted ? 1 : 0
  const onset = phase <= 3 ? motion.tiltDegrees + 1e-8 >= BASIC_RECOVERY_TILT_ONSET_DEGREES
    : phase <= 5 ? motion.verticalSpeedMps <= -BASIC_RECOVERY_SINK_ONSET_MPS
      : motion.horizontalSpeedMps >= BASIC_RECOVERY_DRIFT_ONSET_MPS
  if (wasReady && onset) {
    if (!recovering) return advance()
    episodeValid = true
    interrupted = false
    metrics.currentEpisodeValid = episodeValid ? 1 : 0
    metrics.episodeInterrupted = interrupted ? 1 : 0
    metrics.exerciseReady = 0
    metrics.preparationDwellSeconds = 0
    metrics.preparationQualifying = 0
  }
  return continuing()
}

export const basicRecoveryEvaluator: LessonEvaluatorContract = { evaluate: evaluateBasicRecovery }

export const BASIC_RECOVERY_LESSON: LessonDefinition = {
  id: 'basic-recovery', priority: 2.7, title: '基礎失誤恢復', availability: 'available', available: true,
  description: '從地面自行起飛，依提示產生小幅傾斜、下沉與漂移，再親手恢復控制。',
  objectives: ['依提示主動產生可觀察的小偏差，確認後再修正。', '完成傾斜回平、止住下沉與漂移減速，各短暫保持 0.25 秒。', '保留離地餘裕，不要求回到原位置、精準懸停或降落。'],
  setup: { requiresDisarmed: true, resetSimulation: true, sceneReferenceIds: ['training-launch', 'landing-surface'], spawnOrientation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'recovery-ground', title: '地面開始', description: '在起飛區實際接地開始。' },
    { id: 'recovery-liftoff', title: '自行起飛至練習高度', description: '自行起飛至至少 3 m，建議約 4 m。' },
    { id: 'recovery-tilt-onset', title: '產生小幅傾斜', description: '先準備，再主動產生至少 15° 的實際傾斜。' },
    { id: 'recovery-tilt-level', title: '主動修回水平', description: '回到 12° 內並減緩旋轉，短暫維持 0.25 秒。' },
    { id: 'recovery-sink-onset', title: '產生小幅下沉', description: '重新準備，稍收油門使實際下降速度達 0.5 m/s。' },
    { id: 'recovery-sink-stop', title: '止住下沉', description: '留在空中，把下降速度減至 0.2 m/s 內，允許溫和爬升，短暫維持 0.25 秒。' },
    { id: 'recovery-drift-onset', title: '建立前進或側移', description: '重新準備，再建立至少 1.2 m/s 的實際水平移動。' },
    { id: 'recovery-drift-stop', title: '減速並恢復控制', description: '水平速度降至 1.0 m/s 內，機身接近水平並短暫維持 0.25 秒。' },
  ],
  success: { title: '基礎失誤恢復完成', description: '已觀察到三種真實偏差及其後的主動恢復。', criteria: ['實際地面自行起飛', '先產生偏差，再恢復', '空中與足夠高度下短暫確認恢復'] },
  failure: { title: '基礎失誤恢復尚未完成', description: '一般偏離可續練；墜毀、解除解鎖或無效資料需要重試。', criteria: ['地面停住不能代替空中恢復', '重設或示範不能代替親手修正'] },
  scoring: { maxScore: 100, minimumPassingScore: 70, minimumActiveSeconds: 0, metricLabels: ['tiltDegrees', 'verticalSpeedMps', 'horizontalSpeedMps', 'recoveryDwellSeconds'] },
  hints: ['先準備再製造小偏差，看到已偵測偏差後立即修正。Acro 回中只停止旋轉，回平需要主動修正。'],
  evaluator: basicRecoveryEvaluator,
}

export const BASIC_RECOVERY_LEARNING_CONTENT: LessonLearningContent = {
  code: 'L10', title: '基礎失誤恢復', level: '基礎航線', prerequisiteIds: ['wide-gate'],
  objectives: ['理解姿態、旋轉與移動速度的差別。', '在足夠離地高度下，完成小幅傾斜、下沉與漂移的主動恢復。'],
  steps: ['從地面自行起飛，建議高度約 4 m；練習範圍為起飛點周圍 40 m。', '每段先升到至少 3 m，依該段目標稍微準備 0.1 秒；傾斜段允許水平漂移，下沉段允許少量漂移，不必先精準懸停。', '輕推 Roll 或 Pitch 讓機身傾斜超過約 15°，看到偏差確認後主動修回 12° 內並減緩旋轉，維持 0.25 秒。', '重新準備後稍收油門，下降速度達 0.5 m/s 即補回推力；下降減至 0.2 m/s 內或以 2 m/s 內向上修正，維持 0.25 秒。', '重新準備後建立前進或側移，速度達 1.2 m/s 後反向傾斜減速，再回到接近水平與 1.0 m/s 內，維持 0.25 秒。', '恢復確認需留在空中且高度至少 1 m；接地或高度不足會中斷本次偏差，重新準備並再次產生偏差後才能完成。'],
  commonMistakes: ['把搖桿回中當成回平；Acro 需要主動帶回水平。', '只看位置，忽略飛機已水平但仍在滑動；反向傾斜減速後還要主動回平。', '下沉後接地才停住；本課要在空中保留高度並恢復控制。', '尚未準備完成就製造偏差，或越過提示後持續加大操作；先看目前階段與實際數值。'],
}
