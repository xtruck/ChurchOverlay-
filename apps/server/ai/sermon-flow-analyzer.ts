/**
 * Sermon Flow & Homiletic Progression Analyzer
 *
 * Provides real-time and post-service intelligence on sermon liturgy phases,
 * theological tone distribution, and speaker engagement transitions.
 */

export type HomileticPhase =
  | "introduction"
  | "exposition"
  | "illustration"
  | "application"
  | "altar-call-prayer"

export type TheologicalTone =
  | "praise_thanksgiving"
  | "exhortation_faith"
  | "comfort_peace"
  | "reverence_prayer"
  | "neutral_didactic"

export type SermonSegment = {
  readonly timestampMs: number
  readonly text: string
}

export type SermonPhaseSegment = {
  readonly phase: HomileticPhase
  readonly tone: TheologicalTone
  readonly startTimestampMs: number
  readonly sampleExcerpt: string
}

export type SermonFlowReport = {
  readonly totalSegments: number
  readonly primaryTone: TheologicalTone
  readonly phaseBreakdown: Record<HomileticPhase, number> // counts
  readonly tonePercentages: Record<TheologicalTone, number>
  readonly keyMilestones: SermonPhaseSegment[]
}

const PHASE_PATTERNS: Array<{ phase: HomileticPhase; regex: RegExp }> = [
  {
    phase: "altar-call-prayer",
    regex: /\b(prions|courbons nos têtes|fermons les yeux|bow our heads|let us pray|invitation|donner sa vie|venez devant|amen|bénédiction)\b/i,
  },
  {
    phase: "application",
    regex: /\b(comment appliquer|dans votre vie|cette semaine|aujourd'hui|how does this apply|take action|in your life|pratique)\b/i,
  },
  {
    phase: "illustration",
    regex: /\b(imaginez|une histoire|par exemple|illustrons|let me illustrate|for example|a story|témoignage)\b/i,
  },
  {
    phase: "exposition",
    regex: /\b(le texte dit|en grec|en hébreu|l'apôtre|verset|chapitre|context|original language|passage|saint paul)\b/i,
  },
  {
    phase: "introduction",
    regex: /\b(bienvenue|bonjour|ce matin|ce soir|ouvrons nos bibles|welcome|turn with me|opening|introduction)\b/i,
  },
]

const TONE_PATTERNS: Array<{ tone: TheologicalTone; regex: RegExp }> = [
  {
    tone: "praise_thanksgiving",
    regex: /\b(alléluia|hallelujah|gloire|rendons grâce|merci seigneur|glorify|praise the lord|thank god|magnifions)\b/i,
  },
  {
    tone: "exhortation_faith",
    regex: /\b(marchez par la foi|tenez ferme|persévérez|croyons|soyez courageux|stand firm|have faith|victory|victoire|combattre)\b/i,
  },
  {
    tone: "comfort_peace",
    regex: /\b(ne craignez rien|paix|consolation|n'ayez pas peur|god is with you|peace|comfort|rest|repos|espérance)\b/i,
  },
  {
    tone: "reverence_prayer",
    regex: /\b(saint saint saint|présence de dieu|adoration|reverence|holy|majesty|majesté|prosternons)\b/i,
  },
]

export function classifySegmentPhase(text: string): HomileticPhase {
  for (const { phase, regex } of PHASE_PATTERNS) {
    if (regex.test(text)) return phase
  }
  return "exposition"
}

export function classifySegmentTone(text: string): TheologicalTone {
  for (const { tone, regex } of TONE_PATTERNS) {
    if (regex.test(text)) return tone
  }
  return "neutral_didactic"
}

export function analyzeSermonFlow(segments: SermonSegment[]): SermonFlowReport {
  const phaseBreakdown: Record<HomileticPhase, number> = {
    introduction: 0,
    exposition: 0,
    illustration: 0,
    application: 0,
    "altar-call-prayer": 0,
  }

  const toneCounts: Record<TheologicalTone, number> = {
    praise_thanksgiving: 0,
    exhortation_faith: 0,
    comfort_peace: 0,
    reverence_prayer: 0,
    neutral_didactic: 0,
  }

  const milestones: SermonPhaseSegment[] = []
  let lastRecordedPhase: HomileticPhase | null = null

  for (const seg of segments) {
    const phase = classifySegmentPhase(seg.text)
    const tone = classifySegmentTone(seg.text)

    phaseBreakdown[phase]++
    toneCounts[tone]++

    if (phase !== lastRecordedPhase) {
      milestones.push({
        phase,
        tone,
        startTimestampMs: seg.timestampMs,
        sampleExcerpt: seg.text.slice(0, 80),
      })
      lastRecordedPhase = phase
    }
  }

  const total = segments.length || 1
  const tonePercentages: Record<TheologicalTone, number> = {
    praise_thanksgiving: Math.round((toneCounts.praise_thanksgiving / total) * 100),
    exhortation_faith: Math.round((toneCounts.exhortation_faith / total) * 100),
    comfort_peace: Math.round((toneCounts.comfort_peace / total) * 100),
    reverence_prayer: Math.round((toneCounts.reverence_prayer / total) * 100),
    neutral_didactic: Math.round((toneCounts.neutral_didactic / total) * 100),
  }

  // Determine dominant tone
  let primaryTone: TheologicalTone = "neutral_didactic"
  let maxToneCount = -1
  for (const [tone, count] of Object.entries(toneCounts)) {
    if (count > maxToneCount) {
      maxToneCount = count
      primaryTone = tone as TheologicalTone
    }
  }

  return {
    totalSegments: segments.length,
    primaryTone,
    phaseBreakdown,
    tonePercentages,
    keyMilestones: milestones,
  }
}
