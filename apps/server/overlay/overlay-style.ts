import {
  CUSTOM_PALETTE_ID,
  OVERLAY_BRAND_FONTS,
  OVERLAY_CARD_DESIGNS,
  type OverlayBrandFont,
  type OverlayBrandLogo,
  type OverlayBrandName,
  type OverlayCardDesign,
  type OverlayColors,
  type OverlayPlacement,
  type OverlayStyle,
  type OverlayStyleSettings,
} from "../../../packages/contracts/overlay-style"
import { DEFAULT_PALETTE_ID, HEX_COLOR, findPalette } from "./palettes"

/**
 * ARCHITECTURE.md section 110.5. Everything here treats its input as untrusted:
 * unknown keys are dropped, enums are checked against closed lists, numbers are
 * clamped, text is capped and stripped of control characters, and colours are
 * accepted only as #rrggbb so no value can ever inject CSS. Pure and deterministic.
 */

export const BRAND_TEXT_MAX = 60
export const BRAND_NAME_SIZE = { min: 12, max: 160 } as const
export const BRAND_SCALE = { min: 0.25, max: 4 } as const

const DEFAULT_COLORS = findPalette(DEFAULT_PALETTE_ID)!.colors

const DEFAULT_NAME_PLACEMENT: OverlayPlacement = { x: 90, y: 5, scale: 1, rotation: 0, opacity: 0.85 }
const DEFAULT_LOGO_PLACEMENT: OverlayPlacement = { x: 6, y: 9, scale: 1, rotation: 0, opacity: 1 }

export function defaultOverlayStyleSettings(): OverlayStyleSettings {
  return {
    paletteId: DEFAULT_PALETTE_ID,
    card: "classic",
    brand: {
      name: { visible: false, text: "", font: "sans", size: 28, weight: 600, plate: true, ...DEFAULT_NAME_PLACEMENT },
      logo: { visible: false, version: 0, ...DEFAULT_LOGO_PLACEMENT },
    },
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

function hex(v: unknown, fallback: string): string
function hex(v: unknown, fallback: undefined): string | undefined
function hex(v: unknown, fallback: string | undefined): string | undefined {
  return typeof v === "string" && HEX_COLOR.test(v) ? v.toLowerCase() : fallback
}

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback
}

function cleanText(v: unknown): string {
  if (typeof v !== "string") return ""
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, BRAND_TEXT_MAX)
}

function placement(raw: Record<string, unknown>, d: OverlayPlacement): OverlayPlacement {
  return {
    x: num(raw.x, 0, 100, d.x),
    y: num(raw.y, 0, 100, d.y),
    scale: num(raw.scale, BRAND_SCALE.min, BRAND_SCALE.max, d.scale),
    rotation: num(raw.rotation, -180, 180, d.rotation),
    opacity: num(raw.opacity, 0, 1, d.opacity),
  }
}

function normalizeColors(raw: unknown, fallback: OverlayColors): OverlayColors {
  const r = isRecord(raw) ? raw : {}
  return {
    backdrop: hex(r.backdrop, fallback.backdrop),
    card: hex(r.card, fallback.card),
    cardOpacity: num(r.cardOpacity, 0, 1, fallback.cardOpacity),
    text: hex(r.text, fallback.text),
    textSecondary: hex(r.textSecondary, fallback.textSecondary),
    accent: hex(r.accent, fallback.accent),
    border: hex(r.border, fallback.border),
  }
}

function normalizeName(raw: unknown, d: OverlayBrandName): OverlayBrandName {
  const r = isRecord(raw) ? raw : {}
  const color = hex(r.color, undefined)
  const out: OverlayBrandName = {
    ...placement(r, d),
    visible: bool(r.visible, d.visible),
    text: "text" in r ? cleanText(r.text) : d.text,
    font: oneOf<OverlayBrandFont>(r.font, OVERLAY_BRAND_FONTS, d.font),
    size: Math.round(num(r.size, BRAND_NAME_SIZE.min, BRAND_NAME_SIZE.max, d.size)),
    weight: Math.round(num(r.weight, 300, 800, d.weight) / 100) * 100,
    plate: bool(r.plate, d.plate),
  }
  if (color) out.color = color
  return out
}

function normalizeLogo(raw: unknown, d: OverlayBrandLogo): OverlayBrandLogo {
  const r = isRecord(raw) ? raw : {}
  return {
    ...placement(r, d),
    visible: bool(r.visible, d.visible),
    version: Math.round(num(r.version, 0, Number.MAX_SAFE_INTEGER, d.version)),
  }
}

/** Never throws. A value that cannot be repaired field-by-field falls back to the default for that field. */
export function normalizeOverlayStyleSettings(input: unknown): OverlayStyleSettings {
  const d = defaultOverlayStyleSettings()
  const r = isRecord(input) ? input : {}
  const brand = isRecord(r.brand) ? r.brand : {}
  const paletteId =
    typeof r.paletteId === "string" && (r.paletteId === CUSTOM_PALETTE_ID || findPalette(r.paletteId)) ? r.paletteId : d.paletteId
  const out: OverlayStyleSettings = {
    paletteId,
    card: oneOf<OverlayCardDesign>(r.card, OVERLAY_CARD_DESIGNS, d.card),
    brand: { name: normalizeName(brand.name, d.brand.name), logo: normalizeLogo(brand.logo, d.brand.logo) },
  }
  if (paletteId === CUSTOM_PALETTE_ID) out.customColors = normalizeColors(r.customColors, DEFAULT_COLORS)
  return out
}

/** Settings + revision + concrete colours: the one object viewers receive. */
export function resolveOverlayStyle(settings: OverlayStyleSettings, revision: number): OverlayStyle {
  const colors =
    settings.paletteId === CUSTOM_PALETTE_ID
      ? normalizeColors(settings.customColors, DEFAULT_COLORS)
      : (findPalette(settings.paletteId)?.colors ?? DEFAULT_COLORS)
  return { ...settings, revision, colors: { ...colors } }
}

/**
 * Schema check for an `overlay:style` event payload, used by the WS action
 * registry. Stricter than normalize: a payload that needed repair is rejected.
 */
export function isOverlayStylePayload(v: unknown): v is OverlayStyle {
  if (!isRecord(v) || typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 0) return false
  if (!isRecord(v.colors)) return false
  const settings = normalizeOverlayStyleSettings(v)
  const { revision: _r, colors: _c, ...given } = v as Record<string, unknown>
  void _r
  void _c
  if (JSON.stringify(sortKeys(settings)) !== JSON.stringify(sortKeys(given))) return false
  const colors = normalizeColors(v.colors, DEFAULT_COLORS)
  return JSON.stringify(sortKeys(colors)) === JSON.stringify(sortKeys(v.colors))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (!isRecord(v)) return v
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
}
