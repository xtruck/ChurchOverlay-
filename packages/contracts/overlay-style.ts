/**
 * ARCHITECTURE.md section 110: types and closed enum lists for the overlay
 * style system. Types only: no behaviour lives in contracts.
 */

export const OVERLAY_CARD_DESIGNS = ["classic", "banner", "minimal", "elegant", "glass", "ribbon"] as const
export type OverlayCardDesign = (typeof OVERLAY_CARD_DESIGNS)[number]

/**
 * ARCHITECTURE.md section 129: an animated, procedurally drawn backdrop behind the verse in the
 * full-screen layout. A closed list: the overlay only ever draws a name from it, and the
 * default "none" leaves every existing install looking exactly as before.
 */
export const OVERLAY_BACKGROUNDS = ["none", "fire"] as const
export type OverlayBackground = (typeof OVERLAY_BACKGROUNDS)[number]

export const OVERLAY_BRAND_FONTS =["serif", "sans", "mono"] as const
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
  /** Animated backdrop (full-screen layout only); "none" by default. */
  background: OverlayBackground
  brand: { name: OverlayBrandName; logo: OverlayBrandLogo }
}

/** What viewers receive on `overlay:style`: settings plus ordering and resolved colours. */
export interface OverlayStyle extends OverlayStyleSettings {
  revision: number
  colors: OverlayColors
}
