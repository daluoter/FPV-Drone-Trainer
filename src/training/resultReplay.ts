import type { Vector3 } from '../math/vector'
import type { ReplayRecording, ReplaySample } from '../replay'
import { DEFAULT_LESSONS } from './lessons'
import type { TrainingMachineState } from './types'

export interface ResultReplayMarker {
  readonly id: string
  readonly label: string
  readonly kind: 'checkpoint' | 'finish'
  /** Absolute simulation timestamp of the observed event. */
  readonly eventTimeSeconds: number
  /** Playback offset from the first retained sample; null means no corresponding frame. */
  readonly timeSeconds: number | null
  readonly availability: 'available' | 'nearest-end' | 'before-window' | 'after-window' | 'unavailable'
}

export interface ResultReplaySnapshot {
  readonly sessionId: string
  readonly lessonId: string
  readonly recording: ReplayRecording | null
  readonly markers: readonly ResultReplayMarker[]
  readonly notice: string | null
}

const MAXIMUM_TAIL_LAG_SECONDS = 0.05
const CLOCK_TOLERANCE_SECONDS = 1e-9

function copyVector(value: Vector3): Vector3 {
  return Object.freeze({ x: value.x, y: value.y, z: value.z })
}

function copySample(sample: ReplaySample): ReplaySample {
  const output = sample.controllerOutput
  return Object.freeze({
    timestampSeconds: sample.timestampSeconds,
    positionM: copyVector(sample.positionM),
    orientation: Object.freeze({ ...sample.orientation }),
    velocityMps: copyVector(sample.velocityMps),
    angularVelocityBodyRadPerSec: copyVector(sample.angularVelocityBodyRadPerSec),
    normalizedInput: sample.normalizedInput ? Object.freeze({ ...sample.normalizedInput }) : null,
    controllerOutput: Object.freeze({
      targetPilotRateRadPerSec: Object.freeze({ ...output.targetPilotRateRadPerSec }),
      targetBodyRateRadPerSec: copyVector(output.targetBodyRateRadPerSec),
      pidOutputTorqueBodyNm: copyVector(output.pidOutputTorqueBodyNm),
      pilotCorrections: Object.freeze({ ...output.pilotCorrections }),
      motorCommands: Object.freeze([...output.motorCommands] as [number, number, number, number]),
      mixerSaturated: output.mixerSaturated,
    }),
  })
}

function trimRecording(recording: ReplayRecording | null, start: number, finish: number): ReplayRecording | null {
  if (!recording || recording.samples.length === 0) return null
  let previousTime = -Infinity
  for (const sample of recording.samples) {
    if (!Number.isFinite(sample.timestampSeconds) || sample.timestampSeconds <= previousTime) return null
    previousTime = sample.timestampSeconds
  }
  const samples = recording.samples.filter((sample) => sample.timestampSeconds >= start && sample.timestampSeconds <= finish)
  // A post-result frame or an unrelated later flight cannot stand in for the attempt.
  if (!samples.some((sample) => sample.timestampSeconds < finish)) return null
  const copied = Object.freeze(samples.map(copySample))
  return Object.freeze({
    schemaVersion: 1,
    samples: copied,
    capacity: recording.capacity,
    decimation: recording.decimation,
    // Preserve source recorder statistics; trimming does not invent new source samples.
    totalSourceSamples: recording.totalSourceSamples,
    droppedSamples: recording.droppedSamples,
    durationSeconds: copied[copied.length - 1].timestampSeconds - copied[0].timestampSeconds,
  })
}

/**
 * Capture once at a terminal session boundary, before another flight or demo.
 * Recording timestamps alone cannot identify a later flight whose clock was reset
 * to the same range; the caller must retain this immutable session-bound snapshot.
 * Ordinary practice recoveries are not terminal events and are not markers here.
 */
export function createResultReplaySnapshot(
  state: TrainingMachineState,
  recording: ReplayRecording | null,
): ResultReplaySnapshot | null {
  const result = state.result
  if (!result) return null
  const notices = new Set<string>()
  const validWindow = Number.isFinite(result.startedAtSeconds) && Number.isFinite(result.completedAtSeconds)
    && result.startedAtSeconds >= 0 && result.completedAtSeconds >= result.startedAtSeconds
  const matchingState = state.sessionId === result.sessionId && state.lessonId === result.lessonId
  const retained = validWindow && matchingState
    ? trimRecording(recording, result.startedAtSeconds, result.completedAtSeconds) : null
  if (!retained) notices.add('本次未錄到相符的結果前片段；回放標記已停用，不會改用其他飛行錄影。')

  const events: Array<Omit<ResultReplayMarker, 'timeSeconds' | 'availability'>> = []
  const lesson = DEFAULT_LESSONS.find((candidate) => candidate.id === result.lessonId)
  for (const definition of matchingState ? lesson?.checkpoints ?? [] : []) {
    const checkpoint = state.checkpoints[definition.id]
    if (!checkpoint?.completed) continue
    const time = checkpoint.completedAtSeconds
    if (time === null || !Number.isFinite(time) || time < 0) {
      notices.add('部分已完成步驟缺少有效時間，未建立對應標記。')
      continue
    }
    events.push({ id: `checkpoint:${definition.id}`, label: definition.title, kind: 'checkpoint', eventTimeSeconds: time })
  }
  if (validWindow) events.push({
    id: 'finish', label: result.outcome === 'SUCCESS' ? '課程完成' : '練習結束',
    kind: 'finish', eventTimeSeconds: result.completedAtSeconds,
  })
  else notices.add('結果時間無效，無法建立時間標記。')

  const first = retained?.samples[0].timestampSeconds
  const last = retained?.samples[retained.samples.length - 1].timestampSeconds
  const markers = events.sort((left, right) => left.eventTimeSeconds - right.eventTimeSeconds).map((event): ResultReplayMarker => {
    if (first === undefined || last === undefined) return Object.freeze({ ...event, timeSeconds: null, availability: 'unavailable' })
    if (event.eventTimeSeconds < first - CLOCK_TOLERANCE_SECONDS) {
      notices.add(retained!.droppedSamples > 0
        ? '錄影已達容量上限；較早步驟不在目前保留片段內，無法回放。'
        : '部分步驟發生在錄影起點之前，未保留對應片段。')
      return Object.freeze({ ...event, timeSeconds: null, availability: 'before-window' })
    }
    if (event.eventTimeSeconds > last + CLOCK_TOLERANCE_SECONDS) {
      const lag = event.eventTimeSeconds - last
      if (lag <= MAXIMUM_TAIL_LAG_SECONDS + CLOCK_TOLERANCE_SECONDS) {
        notices.add('部分標記使用結束前最後影格；標記文字已註明時間差，並非事件當下的精確畫面。')
        return Object.freeze({
          ...event, label: `${event.label} · 結束前最後影格（早 ${lag.toFixed(3)} 秒）`,
          timeSeconds: last - first, availability: 'nearest-end',
        })
      }
      notices.add('部分事件晚於最後保留影格，沒有對應畫面可回放。')
      return Object.freeze({ ...event, timeSeconds: null, availability: 'after-window' })
    }
    return Object.freeze({ ...event, timeSeconds: Math.max(0, Math.min(last - first, event.eventTimeSeconds - first)), availability: 'available' })
  })
  if (retained && first! > result.startedAtSeconds + CLOCK_TOLERANCE_SECONDS) {
    notices.add('目前只保留本次練習的部分片段，播放時間從第一個保留影格起算。')
  }
  return Object.freeze({
    sessionId: result.sessionId,
    lessonId: result.lessonId,
    recording: retained,
    markers: Object.freeze(markers),
    notice: notices.size ? [...notices].join(' ') : null,
  })
}
