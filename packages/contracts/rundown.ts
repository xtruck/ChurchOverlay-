import type { VerseReference } from "./verse"

/** Phase 2 (ARCHITECTURE.md section 64.1). Not a general slide/layout editor. */
export type RundownScene =
  | { readonly kind: "verse"; readonly reference: VerseReference }
  | { readonly kind: "media"; readonly mediaCueId: string }
  | { readonly kind: "announcement"; readonly title: string; readonly body: string }
  | { readonly kind: "blank" }

export type Rundown = {
  readonly id: string
  readonly title: string
  readonly scenes: readonly RundownScene[]
}

/** Payload for the "announcement:show" WS event (ARCHITECTURE.md section 64.4). */
export type AnnouncementShowPayload = {
  readonly title: string
  readonly body: string
}

/**
 * Phase 2 (ARCHITECTURE.md section 64.3). Broadcast alongside the existing
 * verse:show/media:clear events so the dashboard can render "which scene is
 * active" without re-deriving it. `interrupted: true` means a live-detected,
 * overridden, or navigated verse is currently overlaying on top of the
 * rundown (section 64.2) — the scene shown here is the paused one, not what
 * is actually on screen right now.
 */
export type RundownStatePayload = {
  readonly rundownId: string
  readonly cursor: number
  readonly scene: RundownScene
  readonly interrupted: boolean
}
