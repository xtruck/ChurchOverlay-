/**
 * ARCHITECTURE.md section 110: types and closed enum lists for the overlay
 * style system. Types only: no behaviour lives in contracts.
 */

/** Section 133 appended cinema..bold; order is the dashboard picker's order. */
export const OVERLAY_CARD_DESIGNS = [
  "classic",
  "banner",
  "minimal",
  "elegant",
  "glass",
  "ribbon",
  "cinema",
  "manuscript",
  "stained",
  "poster",
  "split",
  "bold",
] as const
export type OverlayCardDesign = (typeof OVERLAY_CARD_DESIGNS)[number]

/**
 * Section 133: how verse cards move. "cinematic" = each design's own
 * choreography (the default), "gentle" = a short plain fade, "cut" = no motion.
 * Mirrored by VerseMotion.TRANSITIONS in apps/overlay/public/verse-motion.js.
 */
export const OVERLAY_TRANSITIONS = ["cinematic", "gentle", "cut"] as const
export type OverlayTransition = (typeof OVERLAY_TRANSITIONS)[number]

export const OVERLAY_BRAND_FONTS = ["serif", "sans", "mono"] as const
export type OverlayBrandFont = (typeof OVERLAY_BRAND_FONTS)[number]

export const OVERLAY_PALETTE_GROUPS = ["classic", "light", "liturgical", "bold", "high-contrast", "clear-text"] as const
export type OverlayPaletteGroup = (typeof OVERLAY_PALETTE_GROUPS)[number]

export const CUSTOM_PALETTE_ID = "custom"

/** The seven colour roles. All values are `#rrggbb` except `cardOpacity` (0-1). */
export interface OverlayColors {
  backdrop: string
  card: string
  cardOpacity: number
  text: string
  textSecondary: string
  accent: string
  border: string
}

/** Where and how a brand item sits. x/y are percent of the frame, the item centre. */
export interface OverlayPlacement {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}

export interface OverlayBrandName extends OverlayPlacement {
  visible: boolean
  text: string
  font: OverlayBrandFont
  /** px at 1080p */
  size: number
  weight: number
  /** `#rrggbb`; absent means the palette's text colour. */
  color?: string
  plate: boolean
}

export interface OverlayBrandLogo extends OverlayPlacement {
  visible: boolean
  /** 0 = no logo stored; every change bumps it so viewers cache-bust the image. */
  version: number
}

export interface OverlayStyleSettings {
  paletteId: string
  customColors?: OverlayColors
  card: OverlayCardDesign
  /** Section 133. Absent in settings stored before it existed: normalizes to "cinematic". */
  transition: OverlayTransition
  brand: { name: OverlayBrandName; logo: OverlayBrandLogo }
}

/** What viewers receive on `overlay:style`: settings plus ordering and resolved colours. */
export interface OverlayStyle extends OverlayStyleSettings {
  revision: number
  colors: OverlayColors
}
