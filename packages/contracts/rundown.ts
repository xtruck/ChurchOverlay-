import type { VerseReference } from "./verse"

/**
 * A single positioned element on a canvas scene's stage (ARCHITECTURE.md
 * section 66.3). Coordinates and sizes are percentages of a fixed 16:9
 * stage (0-100), not pixels, so a layout means the same thing in the
 * dashboard editor, its live preview, and the real overlay regardless of
 * each surface's actual pixel size.
 */
export type CanvasLayerBase = {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly zIndex: number
}

export type CanvasTextLayer = CanvasLayerBase & {
  readonly kind: "text"
  readonly text: string
  readonly fontFamily: "serif" | "sans" | "mono"
  readonly fontSizePx: number
  readonly color: string
  readonly align: "left" | "center" | "right"
}

export type CanvasImageLayer = CanvasLayerBase & {
  readonly kind: "image"
  readonly mediaCueId: string
}

export type CanvasBackgroundLayer = CanvasLayerBase & {
  readonly kind: "background"
  readonly color: string | null
  readonly mediaCueId: string | null
}

export type CanvasLayer = CanvasTextLayer | CanvasImageLayer | CanvasBackgroundLayer

/**
 * Phase 2-canvas (ARCHITECTURE.md section 66). A free-form scene: an
 * ordered list of layers rendered by z-index. Every layer is operator-
 * authored only in this phase (invariant 23) — never derived from ASR
 * transcript text or voice navigation.
 */
export type CanvasSceneData = {
  readonly layers: readonly CanvasLayer[]
}

/** Payload for the "canvas:show" WS event (ARCHITECTURE.md section 66.4). */
export type CanvasShowPayload = CanvasSceneData

/**
 * Phase 2 (ARCHITECTURE.md section 64.1) for the first four kinds — not a
 * general slide/layout editor. The `canvas` kind (ARCHITECTURE.md section
 * 66) explicitly supersedes that framing for itself only; the first four
 * kinds' own fixed-template rendering is unchanged.
 */
export type RundownScene =
  | { readonly kind: "verse"; readonly reference: VerseReference }
  | { readonly kind: "media"; readonly mediaCueId: string }
  | { readonly kind: "announcement"; readonly title: string; readonly body: string }
  | { readonly kind: "blank" }
  | { readonly kind: "canvas"; readonly canvas: CanvasSceneData }

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
