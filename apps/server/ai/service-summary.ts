import type { SessionEntry } from "../core/session-recorder"
import { BOOK_CATALOG } from "../verse/book-catalog"

export const SERVICE_SUMMARY_SYSTEM_PROMPT =
  "You write a short, warm 2-4 sentence recap of a church service for the pastor/operator's own records, given the exact Bible verses shown on screen (already verified) and the sermon notes already generated during the service. Do not invent any Bible verse, reference, or quote beyond what is explicitly listed below — if nothing was shown or noted, say so briefly. Write in the same language as the sermon notes text (or the verse text if there are no notes). Output plain prose, no headers, no bullet lists."

export function buildServiceSummaryInput(entries: readonly SessionEntry[], sermonNotesText: string): string {
  const versesSection =
    entries.length > 0
      ? "Verses shown during the service:\n" +
        entries.map((entry) => `- ${entry.reference.book} ${entry.reference.chapter}:${entry.reference.verse}: "${entry.text}"`).join("\n")
      : "No verses were shown during this service."

  const trimmedNotes = sermonNotesText.trim()
  const notesSection = trimmedNotes
    ? "Sermon notes generated during the service:\n" + trimmedNotes
    : "No sermon notes were generated during this service."

  return `${versesSection}\n\n${notesSection}`
}

/**
 * Builds structured YouTube timestamps & video description from service entries.
 */
export function buildYouTubeDescription(entries: readonly SessionEntry[], sermonTitle = "Sunday Live Service"): string {
  let text = `✝️ ${sermonTitle}\n\n📖 SCRIPTURE TIMESTAMPS:\n`
  if (entries.length === 0) {
    text += "00:00 - Service Start\n"
    return text
  }

  const startTimestamp = entries[0]?.timestamp ?? Date.now()
  text += "00:00 - Service Start\n"

  for (const entry of entries) {
    const elapsedSeconds = Math.max(0, Math.floor((entry.timestamp - startTimestamp) / 1000))
    const minutes = Math.floor(elapsedSeconds / 60)
    const seconds = elapsedSeconds % 60
    const timeCode = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    const capBook = entry.reference.book.charAt(0).toUpperCase() + entry.reference.book.slice(1)
    text += `${timeCode} - Scripture: ${capBook} ${entry.reference.chapter}:${entry.reference.verse}\n`
  }

  text += "\nRecorded with ChurchOverlay Live System."
  return text
}

export type PreachingAnalytics = {
  readonly totalVerses: number
  readonly uniqueBooksCount: number
  readonly oldTestamentCount: number
  readonly newTestamentCount: number
  readonly oldTestamentRatio: number
  readonly newTestamentRatio: number
  readonly topBooks: readonly { readonly book: string; readonly count: number }[]
}

const OLD_TESTAMENT_IDS = new Set(BOOK_CATALOG.slice(0, 39).map((b) => b.id))

export function generatePreachingAnalytics(entries: readonly SessionEntry[]): PreachingAnalytics {
  const total = entries.length
  if (total === 0) {
    return {
      totalVerses: 0,
      uniqueBooksCount: 0,
      oldTestamentCount: 0,
      newTestamentCount: 0,
      oldTestamentRatio: 0,
      newTestamentRatio: 0,
      topBooks: [],
    }
  }

  let otCount = 0
  let ntCount = 0
  const bookCounts = new Map<string, number>()

  for (const e of entries) {
    const b = e.reference.book.toLowerCase()
    bookCounts.set(b, (bookCounts.get(b) ?? 0) + 1)
    if (OLD_TESTAMENT_IDS.has(b)) {
      otCount++
    } else {
      ntCount++
    }
  }

  const sortedBooks = [...bookCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([book, count]) => ({ book, count }))

  return {
    totalVerses: total,
    uniqueBooksCount: bookCounts.size,
    oldTestamentCount: otCount,
    newTestamentCount: ntCount,
    oldTestamentRatio: Number((otCount / total).toFixed(2)),
    newTestamentRatio: Number((ntCount / total).toFixed(2)),
    topBooks: sortedBooks.slice(0, 5),
  }
}

/**
 * Generates an SVG Social Media Quote Card (1080x1080) for Instagram & Facebook.
 */
export function generateSocialQuoteCardSvg(verseText: string, reference: string, churchName = "ChurchOverlay"): string {
  const cleanText = verseText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const cleanRef = reference.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const cleanChurch = churchName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="50%" stop-color="#1e1b4b"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#fbbf24"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#bg)"/>
  <circle cx="900" cy="150" r="300" fill="#3b82f6" opacity="0.08" filter="blur(60px)"/>
  <circle cx="150" cy="900" r="250" fill="#f59e0b" opacity="0.08" filter="blur(60px)"/>

  <!-- Top Badge -->
  <rect x="100" y="100" width="220" height="50" rx="25" fill="rgba(255,255,255,0.08)"/>
  <text x="210" y="132" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="20" font-weight="700" fill="#94a3b8" text-anchor="middle" letter-spacing="2">SCRIPTURE</text>

  <!-- Church Name -->
  <text x="980" y="132" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="22" font-weight="600" fill="#64748b" text-anchor="end">${cleanChurch}</text>

  <!-- Quote Mark -->
  <text x="100" y="320" font-family="Georgia, serif" font-size="140" fill="#f59e0b" opacity="0.4">“</text>

  <!-- Verse Text -->
  <foreignObject x="100" y="340" width="880" height="460">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Georgia, serif; font-size: 42px; line-height: 1.5; color: #f8fafc; display: flex; align-items: center; height: 100%;">
      ${cleanText}
    </div>
  </foreignObject>

  <!-- Reference Pill -->
  <rect x="100" y="860" width="880" height="2" fill="rgba(255,255,255,0.12)"/>
  <text x="100" y="930" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="38" font-weight="800" fill="url(#gold)">${cleanRef}</text>
</svg>`
}
