/**
 * Which volume does "Corinthiens 5 verset 2" mean — 1 or 2?
 *
 * Preachers drop the volume constantly ("Corinthiens", "Samuel", "Rois") and
 * the detector must not guess, so a bare numbered book yields nothing. This
 * module supplies the one thing a human listener uses: CONTEXT. The volume is
 * inferred from the book currently on screen, else from the books planned in
 * the loaded rundown, and only when that context names exactly one volume of
 * that family.
 *
 * It is deliberately NOT a detector and never decides what is shown: it only
 * rewrites text ("Corinthiens 5 verset 2" -> "1 Corinthiens 5 verset 2"), the
 * result goes through the normal detector, KnownValidVerseIndex and Bible
 * source, and AppCore delivers it as a PENDING suggestion in every mode — an
 * inferred volume is a guess, so the operator confirms it.
 *
 * Only books that exist solely in numbered volumes take part. Jean and Pierre
 * are excluded (a bare "Jean" is the Gospel).
 */

/** family -> spoken forms (accent-free, lower-case), including live mishearings. */
const FAMILY_WORDS: Readonly<Record<string, readonly string[]>> = {
  corinthians: ["corinthiens", "corinthians", "corinthien", "corentin", "corentien", "corretien", "corretine", "corintien"],
  thessalonians: ["thessaloniciens", "thessalonians"],
  timothy: ["timothee", "timothy"],
  samuel: ["samuel"],
  kings: ["rois", "kings"],
  chronicles: ["chroniques", "chronicles"],
}

const FAMILY_BY_WORD: ReadonlyMap<string, string> = new Map(
  Object.entries(FAMILY_WORDS).flatMap(([family, words]) => words.map((word) => [word, family] as const)),
)

/** Tokens that already state a volume when they sit right before the book. */
const VOLUME_WORDS = new Set([
  "1", "2", "3", "i", "ii", "iii", "un", "une", "one", "deux", "two", "trois", "three",
  "premier", "premiere", "1er", "1re", "1ere", "first", "1st",
  "deuxieme", "second", "seconde", "2e", "2eme", "2nd",
  "troisieme", "third", "3e", "3eme", "3rd",
])

export type VolumeHints = ReadonlyMap<string, string>

/** Every family at one volume: the candidates to try when no context says which volume was meant. */
export function allFamiliesAtVolume(volume: "1" | "2"): VolumeHints {
  return new Map(Object.keys(FAMILY_WORDS).map((family) => [family, volume] as const))
}

/** "1 corinthians" -> { family: "corinthians", volume: "1" }; null for any other book id. */
export function volumeOfBookId(bookId: string): { family: string; volume: string } | null {
  const match = /^([123]) (\w+)$/.exec(bookId)
  if (!match) return null
  const family = match[2] as string
  return family in FAMILY_WORDS ? { family, volume: match[1] as string } : null
}

/**
 * Builds the hints: planned rundown books first (a family with two different
 * planned volumes is ambiguous and gets no hint), then the book on screen,
 * which overrides because it is the most recent evidence.
 */
export function buildVolumeHints(plannedBookIds: readonly string[], currentBookId: string | null): VolumeHints {
  const planned = new Map<string, Set<string>>()
  for (const id of plannedBookIds) {
    const parsed = volumeOfBookId(id)
    if (!parsed) continue
    const volumes = planned.get(parsed.family) ?? new Set<string>()
    volumes.add(parsed.volume)
    planned.set(parsed.family, volumes)
  }
  const hints = new Map<string, string>()
  for (const [family, volumes] of planned) {
    if (volumes.size === 1) hints.set(family, [...volumes][0] as string)
  }
  const current = currentBookId ? volumeOfBookId(currentBookId) : null
  if (current) hints.set(current.family, current.volume)
  return hints
}

function fold(word: string): string {
  return word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

/**
 * Prefixes every BARE numbered book in the text with its hinted volume.
 * Returns null when nothing changed (no bare book, no hint, or the volume was
 * already spoken), so the caller can skip the extra detection pass.
 */
export function applyVolumeHints(text: string, hints: VolumeHints): string | null {
  if (hints.size === 0) return null
  const parts = text.split(/(\s+)/) // keep the whitespace so the text is rebuilt exactly
  let changed = false
  // The last few words: "première épître aux Corinthiens" states the volume 3 words back.
  const recent: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i] as string
    const core = fold(raw.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ""))
    const family = FAMILY_BY_WORD.get(core)
    const volume = family ? hints.get(family) : undefined
    if (volume && !recent.some((word) => VOLUME_WORDS.has(word))) {
      parts[i] = `${volume} ${raw}`
      changed = true
    }
    if (core) recent.push(core)
    if (recent.length > 4) recent.shift()
  }
  return changed ? parts.join("") : null
}
