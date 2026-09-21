const BIBLE_TERM_ALIASES: Readonly<Record<string, string>> = {
  "saint-esprit": "Saint-Esprit",
  "saint esprit": "Saint-Esprit",
  "jésus": "Jésus",
  "jesus": "Jésus",
  "évangile": "Évangile",
  "evangile": "Évangile",
  "psaume": "Psaume",
}

/** Applies only exact, known term casing; it does not infer references. */
export function normalizeBibleTerms(text: string): string {
  let result = text
  for (const [alias, canonical] of Object.entries(BIBLE_TERM_ALIASES)) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi"), canonical)
  }
  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
