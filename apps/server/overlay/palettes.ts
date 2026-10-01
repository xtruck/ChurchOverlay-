import type { OverlayColors, OverlayPaletteGroup } from "../../../packages/contracts/overlay-style"

/** ARCHITECTURE.md section 110.3. Pure data and WCAG helpers: no I/O. */
export interface PaletteDefinition {
  id: string
  group: OverlayPaletteGroup
  label: { en: string; fr: string }
  colors: OverlayColors
}

export const DEFAULT_PALETTE_ID = "gilt-night"

const p = (
  id: string,
  group: OverlayPaletteGroup,
  en: string,
  fr: string,
  backdrop: string,
  card: string,
  cardOpacity: number,
  text: string,
  textSecondary: string,
  accent: string,
  border: string,
): PaletteDefinition => ({ id, group, label: { en, fr }, colors: { backdrop, card, cardOpacity, text, textSecondary, accent, border } })

/** The default reproduces the pre-section-110 overlay exactly (see overlay-style.test.ts). */
export const PALETTES: readonly PaletteDefinition[] = [
  // Classic
  p("gilt-night", "classic", "Gilt Night", "Nuit dorée", "#0c1320", "#06070a", 0.62, "#ffffff", "#f2f4f7", "#e6c27a", "#2a2d33"),
  p("midnight-blue", "classic", "Midnight Blue", "Bleu minuit", "#0a1426", "#07101f", 0.74, "#f4f7fb", "#c5d0e0", "#7fb2ff", "#27395a"),
  p("charcoal", "classic", "Charcoal", "Anthracite", "#16181c", "#0e0f12", 0.74, "#f5f5f5", "#cfd2d6", "#ffd166", "#34373d"),
  p("deep-forest", "classic", "Deep Forest", "Forêt profonde", "#0b1a14", "#07120d", 0.74, "#f2f8f4", "#c4d6cb", "#9be3b0", "#26463a"),
  // Light
  p("parchment", "light", "Parchment", "Parchemin", "#f6efe0", "#fffaf0", 0.9, "#2b2118", "#5a4a3a", "#8a5a12", "#d8c8a6"),
  p("ivory", "light", "Ivory", "Ivoire", "#f7f5ef", "#ffffff", 0.92, "#1c1c1f", "#4c4c52", "#7a4e00", "#d9d5c8"),
  p("morning-sky", "light", "Morning Sky", "Ciel du matin", "#e8f1fb", "#ffffff", 0.9, "#10243d", "#3e5470", "#0b5cad", "#bcd3ec"),
  p("soft-rose", "light", "Soft Rose", "Rose tendre", "#fbeef0", "#fffafa", 0.9, "#3a1620", "#6a3a47", "#a3243f", "#ecc8cf"),
  // Liturgical
  p("advent", "liturgical", "Advent", "Avent", "#1b1236", "#120b27", 0.74, "#f7f3ff", "#d4c9ee", "#c9a8ff", "#3c2d6b"),
  p("christmas", "liturgical", "Christmas", "Noël", "#0f2a1c", "#0a1d13", 0.74, "#fffdf6", "#d8e6dc", "#ff8a8a", "#7a2230"),
  p("lent", "liturgical", "Lent", "Carême", "#1e1630", "#150f23", 0.74, "#f3eefb", "#cdc3de", "#b794f4", "#43335f"),
  p("easter", "liturgical", "Easter", "Pâques", "#fffbea", "#ffffff", 0.74, "#2a2410", "#4e4410", "#7a5c00", "#e6dcae"),
  p("pentecost", "liturgical", "Pentecost", "Pentecôte", "#2a0c0c", "#1d0707", 0.74, "#fff6f2", "#f0cfc6", "#ff9a5c", "#6b2a22"),
  p("ordinary-time", "liturgical", "Ordinary Time", "Temps ordinaire", "#0d2217", "#08170f", 0.74, "#f3faf5", "#c6dccd", "#8fd9a3", "#28503a"),
  // Bold
  p("royal-purple", "bold", "Royal Purple", "Pourpre royal", "#2b1055", "#1d0a3c", 0.74, "#ffffff", "#e0d2f5", "#ffd86b", "#5b34a0"),
  p("crimson", "bold", "Crimson", "Cramoisi", "#4a0f1c", "#33090f", 0.74, "#ffffff", "#f3d3d8", "#ffc857", "#8a2335"),
  p("ocean", "bold", "Ocean", "Océan", "#06364d", "#042636", 0.74, "#ffffff", "#cfe6f2", "#5fe0d0", "#1e6a8a"),
  p("sunrise", "bold", "Sunrise", "Aurore", "#5a2a0a", "#3d1c06", 0.74, "#fffaf2", "#f6dcc0", "#ffc15e", "#a65a1c"),
  // High contrast
  p("hc-white-on-black", "high-contrast", "White on Black", "Blanc sur noir", "#000000", "#000000", 0.92, "#ffffff", "#e6e6e6", "#ffe600", "#ffffff"),
  p("hc-yellow-on-black", "high-contrast", "Yellow on Black", "Jaune sur noir", "#000000", "#000000", 0.92, "#ffe600", "#fff3a0", "#ffffff", "#ffe600"),
  p("hc-black-on-white", "high-contrast", "Black on White", "Noir sur blanc", "#ffffff", "#ffffff", 0.95, "#000000", "#1a1a1a", "#0036a3", "#000000"),
  // Clear text (no card: text only, legibility comes from the shadow)
  p("clear-white", "clear-text", "Clear White", "Texte blanc", "#0c1320", "#000000", 0, "#ffffff", "#e8e8e8", "#e6c27a", "#000000"),
  p("clear-gold", "clear-text", "Clear Gold", "Texte or", "#0c1320", "#000000", 0, "#fff3d1", "#f0e0b8", "#ffd166", "#000000"),
  p("clear-mint", "clear-text", "Clear Mint", "Texte menthe", "#0b1a14", "#000000", 0, "#eafff3", "#cfeedd", "#7ff0b0", "#000000"),
]

export function findPalette(id: string): PaletteDefinition | undefined {
  return PALETTES.find((x) => x.id === id)
}

/** `#rrggbb` only: the single colour syntax accepted anywhere (section 110.5). */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function parseHex(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex: string): number {
  const lin = parseHex(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0)
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Source-over of `fg` at `alpha` onto `bg`, as `#rrggbb`. */
export function compositeHex(fg: string, alpha: number, bg: string): string {
  const f = parseHex(fg)
  const b = parseHex(bg)
  const mix = (i: number): string =>
    Math.round((f[i] ?? 0) * alpha + (b[i] ?? 0) * (1 - alpha)).toString(16).padStart(2, "0")
  return `#${mix(0)}${mix(1)}${mix(2)}`
}

/**
 * Worst-case contrast of a text colour on a palette's card: a translucent card
 * is composited over both black and white video and the lower ratio wins.
 */
export function worstCaseCardContrast(colors: OverlayColors, fg: string): number {
  const overBlack = compositeHex(colors.card, colors.cardOpacity, "#000000")
  const overWhite = compositeHex(colors.card, colors.cardOpacity, "#ffffff")
  return Math.min(contrastRatio(fg, overBlack), contrastRatio(fg, overWhite))
}
