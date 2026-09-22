import { interpolateReplayRecording } from './interpolation'
import type {
  ReplayGhostState,
  ReplayPlaybackState,
  ReplayRecording,
  ReplaySpeed,
} from './types'
import { REPLAY_SPEEDS } from './types'

function isReplaySpeed(value: number): value is ReplaySpeed {
  return REPLAY_SPEEDS.includes(value as ReplaySpeed)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Stateful playback clock for the independent replay ghost. */
export class ReplayPlayback {
  public readonly recording: ReplayRecording
  private currentTimeSeconds = 0
  private speed: ReplaySpeed = 1
  private playing = false

  public constructor(recording: ReplayRecording) {
    this.recording = recording
  }

  public get durationSeconds(): number {
    return this.recording.durationSeconds
  }

  public get currentTime(): number {
    return this.currentTimeSeconds
  }

  public get playbackSpeed(): ReplaySpeed {
    return this.speed
  }

  public isPlaying(): boolean {
    return this.playing
  }

  public play(): void {
    if (this.recording.samples.length === 0) return
    if (this.currentTimeSeconds >= this.durationSeconds) this.currentTimeSeconds = 0
    this.playing = true
  }

  public pause(): void {
    this.playing = false
  }

  public toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  public setSpeed(speed: number): boolean {
    if (!isReplaySpeed(speed)) return false
    this.speed = speed
    return true
  }

  /** Seek in seconds relative to the first retained sample. Invalid input is ignored. */
  public seek(seconds: number): boolean {
    if (!Number.isFinite(seconds)) return false
    this.currentTimeSeconds = clamp(seconds, 0, this.durationSeconds)
    return true
  }

  /** Advance only the ghost clock; no live simulation or training sample is touched. */
  public advance(realDeltaSeconds: number): ReplayGhostState | null {
    if (!Number.isFinite(realDeltaSeconds) || realDeltaSeconds < 0) return this.getGhostState()
    if (this.playing) {
      this.currentTimeSeconds = clamp(
        this.currentTimeSeconds + realDeltaSeconds * this.speed,
        0,
        this.durationSeconds,
      )
      if (this.currentTimeSeconds >= this.durationSeconds) this.playing = false
    }
    return this.getGhostState()
  }

  public getGhostState(): ReplayGhostState | null {
    return interpolateReplayRecording(this.recording, this.currentTimeSeconds)
  }

  public getState(): ReplayPlaybackState {
    return Object.freeze({
      playing: this.playing,
      currentTimeSeconds: this.currentTimeSeconds,
      durationSeconds: this.durationSeconds,
      speed: this.speed,
      ghost: this.getGhostState(),
    })
  }
}

export const ReplayController = ReplayPlayback
