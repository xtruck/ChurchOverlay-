import type { OutlineShowPayload } from "../../../packages/contracts"

/**
 * Real-time spoken sermon outline and key-point detector.
 * Identifies structural headings in pulpit speech and transforms them into
 * clean, displayable lower-third titles.
 */

const OUTLINE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp
  readonly pointNumber: number
  readonly fallbackTitle: string
}> = [
  {
    pattern: /(?:^|[\s.,!?;])(?:point\s+(?:num[ée]ro\s+)?1|premier\s+point|premi[èe]rement|first\s+point|point\s+(?:number\s+)?1)[:,\s]+([^.!?\n]{4,80})/iu,
    pointNumber: 1,
    fallbackTitle: "Point 1",
  },
  {
    pattern: /(?:^|[\s.,!?;])(?:point\s+(?:num[ée]ro\s+)?2|deuxi[èe]me\s+point|deuxi[èe]mement|second\s+point|point\s+(?:number\s+)?2)[:,\s]+([^.!?\n]{4,80})/iu,
    pointNumber: 2,
    fallbackTitle: "Point 2",
  },
  {
    pattern: /(?:^|[\s.,!?;])(?:point\s+(?:num[ée]ro\s+)?3|troisi[èe]me\s+point|troisi[èe]mement|third\s+point|point\s+(?:number\s+)?3)[:,\s]+([^.!?\n]{4,80})/iu,
    pointNumber: 3,
    fallbackTitle: "Point 3",
  },
  {
    pattern: /(?:^|[\s.,!?;])(?:point\s+(?:num[ée]ro\s+)?4|quatri[èe]me\s+point|quatri[èe]mement|fourth\s+point|point\s+(?:number\s+)?4)[:,\s]+([^.!?\n]{4,80})/iu,
    pointNumber: 4,
    fallbackTitle: "Point 4",
  },
  {
    pattern: /(?:^|[\s.,!?;])(?:en\s+conclusion|pour\s+conclure|in\s+conclusion|finally)[:,\s]+([^.!?\n]{4,80})/iu,
    pointNumber: 99,
    fallbackTitle: "Conclusion",
  },
]

export class OutlineDetector {
  detect(text: string): OutlineShowPayload | null {
    if (!text || text.trim().length < 8) return null

    for (const entry of OUTLINE_PATTERNS) {
      const match = text.match(entry.pattern)
      if (match && match[1]) {
        const rawContent = match[1].trim()
        const cleanedTitle = capitalize(cleanHeading(rawContent))
        if (cleanedTitle.length >= 3) {
          return {
            pointNumber: entry.pointNumber,
            title: entry.pointNumber === 99 ? "Conclusion" : `Point ${entry.pointNumber}`,
            text: cleanedTitle,
          }
        }
      }
    }

    return null
  }
}

function cleanHeading(raw: string): string {
  return raw
    .replace(/^c['’]est\s+/i, "")
    .replace(/^que\s+/i, "")
    .replace(/^that\s+/i, "")
    .replace(/[.,;!?]+$/, "")
    .trim()
}

function capitalize(s: string): string {
  if (!s) return ""
  return s.charAt(0).toUpperCase() + s.slice(1)
}
