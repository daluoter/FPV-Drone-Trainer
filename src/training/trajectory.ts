import type { TrainingSample } from './types'

/** Maximum number of samples exposed by a training path snapshot. */
export const TRAINING_TRAJECTORY_MAX_POINTS = 1_200
/** Retain one path point for every four fixed-step samples after warm-up. */
export const TRAINING_TRAJECTORY_SAMPLE_STRIDE = 4
/** Publish renderer/UI path snapshots at most ten times per second. */
export const TRAINING_TRAJECTORY_SNAPSHOT_INTERVAL_SECONDS = 0.1
/** Keep the first two samples responsive for small/evaluator-only sessions. */
export const TRAINING_TRAJECTORY_WARMUP_SAMPLES = 2

function appendSnapshotPoint(
  path: readonly TrainingSample[],
  sample: TrainingSample,
): readonly TrainingSample[] {
  const next = [...path, sample]
  if (next.length <= TRAINING_TRAJECTORY_MAX_POINTS) return Object.freeze(next)
  return Object.freeze(next.slice(next.length - TRAINING_TRAJECTORY_MAX_POINTS))
}

/**
 * Bounded fixed-capacity path storage used by the high-frequency session. The
 * ring receives only decimated samples; `latest` preserves the current endpoint
 * for snapshots without making the evaluator or renderer retain every sample.
 */
export class TrainingTrajectoryBuffer {
  private readonly ring: Array<TrainingSample | undefined> = new Array(TRAINING_TRAJECTORY_MAX_POINTS)
  private start = 0
  private size = 0
  private latest: TrainingSample | null = null
  private lastSnapshotTimestampSeconds: number | null = null

  public clear(): void {
    this.ring.fill(undefined)
    this.start = 0
    this.size = 0
    this.latest = null
    this.lastSnapshotTimestampSeconds = null
  }

  /** O(1): no path array is copied while a fixed-step sample is ingested. */
  public append(sample: TrainingSample, sampleCount: number): void {
    this.latest = sample
    if (sampleCount > TRAINING_TRAJECTORY_WARMUP_SAMPLES
      && sampleCount % TRAINING_TRAJECTORY_SAMPLE_STRIDE !== 0) return
    const index = (this.start + this.size) % TRAINING_TRAJECTORY_MAX_POINTS
    this.ring[index] = sample
    if (this.size < TRAINING_TRAJECTORY_MAX_POINTS) {
      this.size += 1
      return
    }
    this.start = (this.start + 1) % TRAINING_TRAJECTORY_MAX_POINTS
  }

  public shouldPublish(sampleCount: number, timestampSeconds: number): boolean {
    if (this.lastSnapshotTimestampSeconds === null) return true
    if (sampleCount <= TRAINING_TRAJECTORY_WARMUP_SAMPLES) return true
    return timestampSeconds - this.lastSnapshotTimestampSeconds >= TRAINING_TRAJECTORY_SNAPSHOT_INTERVAL_SECONDS
  }

  /** O(capacity), called only for bounded UI/evaluator snapshots. */
  public snapshot(timestampSeconds?: number): readonly TrainingSample[] {
    const path: TrainingSample[] = []
    for (let offset = 0; offset < this.size; offset += 1) {
      const sample = this.ring[(this.start + offset) % TRAINING_TRAJECTORY_MAX_POINTS]
      if (sample) path.push(sample)
    }
    if (this.latest && path[path.length - 1] !== this.latest) {
      if (path.length >= TRAINING_TRAJECTORY_MAX_POINTS) path.shift()
      path.push(this.latest)
    }
    if (timestampSeconds !== undefined) this.lastSnapshotTimestampSeconds = timestampSeconds
    return Object.freeze(path)
  }

  public get retainedPointCount(): number {
    return this.size
  }
}

/**
 * Pure-reducer fallback. The state reducer has no mutable ring, so it keeps a
 * bounded immutable snapshot. TrainingSession uses TrainingTrajectoryBuffer to
 * avoid this array copy on the 240 Hz path.
 */
export function appendBoundedTrajectorySnapshot(
  path: readonly TrainingSample[],
  sample: TrainingSample,
  sampleCount: number,
): readonly TrainingSample[] {
  if (sampleCount <= TRAINING_TRAJECTORY_WARMUP_SAMPLES
    || sampleCount % TRAINING_TRAJECTORY_SAMPLE_STRIDE === 0) {
    return appendSnapshotPoint(path, sample)
  }
  return path
}
