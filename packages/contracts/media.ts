export type MediaCueKind = "image" | "video" | "audio"

export type MediaCue = {
  readonly kind: MediaCueKind
  readonly id: string
  /** Also the voice-trigger phrase (ARCHITECTURE.md section 60.3) — operator-assigned at import time, unique. */
  readonly title: string
}

export type MediaPlaybackState = {
  readonly state: "playing" | "paused"
  readonly positionMs: number
  /** Server clock reading when positionMs was true — see ARCHITECTURE.md section 60.5's sync model. */
  readonly asOfServerTime: number
}

export type MediaShowPayload = {
  readonly cue: MediaCue
  /** Present only for kind "video"/"audio"; omitted for "image", which has no playback concept. */
  readonly playback?: MediaPlaybackState
}

/**
 * Payload for the "poster:show" WS event (ARCHITECTURE.md section 67.3).
 * `cue.kind` is always "image" — enforced at the AppCore layer when
 * `poster:set` is handled, not re-typed here.
 */
export type PosterShowPayload = {
  readonly cue: MediaCue
}
