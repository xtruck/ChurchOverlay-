/**
 * Quick manual entry: turns what an operator types for a book ("jn", "1co",
 * "gen", "ps", "Jean", "1 jn") into a catalog book id.
 *
 * It only chooses WHICH catalog book was meant. The result still goes through
 * the known-valid index and the verse source like any other reference
 * (AGENTS.md sections 13, 14, 50): a wrong guess can only show a real, valid
 * verse from the book that was named, never an invented one.
 *
 * Order: exact name (English or French) -> abbreviation table -> unique prefix
 * -> a short preference list for ambiguous prefixes ("jo" is John, not Job).
 * Anything else is null. Pure and deterministic.
 */

import { BOOK_CATALOG } from "../verse/book-catalog"
import { CATALOG_IDS, FRENCH_BOOK_ALIASES, normalizeBookName, stripAccents } from "./regex-detector"

/** Common French and English abbreviations. Numbered books list the bare name: "1co" is `1` + `co`. */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  gn: "genesis", gen: "genesis", ge: "genesis",
  ex: "exodus", exo: "exodus",
  lv: "leviticus", lev: "leviticus", le: "leviticus",
  nb: "numbers", nm: "numbers", num: "numbers", nu: "numbers",
  dt: "deuteronomy", deut: "deuteronomy", de: "deuteronomy",
  jos: "joshua", josh: "joshua",
  jg: "judges", jdg: "judges", jug: "judges",
  rt: "ruth", ru: "ruth",
  s: "samuel", sa: "samuel", sam: "samuel",
  r: "kings", ki: "kings", kgs: "kings", rs: "kings",
  ro: "romans",
  ch: "chronicles", chr: "chronicles", chron: "chronicles",
  esd: "ezra", ezr: "ezra",
  ne: "nehemiah", neh: "nehemiah",
  est: "esther",
  jb: "job",
  ps: "psalm", psa: "psalm", pss: "psalm", psm: "psalm",
  pr: "proverbs", prv: "proverbs", pro: "proverbs", prov: "proverbs",
  ec: "ecclesiastes", ecc: "ecclesiastes", qo: "ecclesiastes",
  ct: "song of solomon", ca: "song of solomon", sg: "song of solomon", song: "song of solomon",
  is: "isaiah", isa: "isaiah", es: "isaiah", esa: "isaiah",
  jr: "jeremiah", jer: "jeremiah",
  lm: "lamentations", lam: "lamentations",
  ez: "ezekiel", ezk: "ezekiel", eze: "ezekiel",
  dn: "daniel", dan: "daniel",
  os: "hosea", hos: "hosea",
  jl: "joel",
  am: "amos",
  ab: "obadiah", abd: "obadiah", ob: "obadiah",
  jon: "jonah", jnh: "jonah",
  mi: "micah", mic: "micah",
  na: "nahum", nah: "nahum",
  ha: "habakkuk", hab: "habakkuk",
  so: "zephaniah", sop: "zephaniah", zep: "zephaniah",
  ag: "haggai", hag: "haggai",
  za: "zechariah", zec: "zechariah", zech: "zechariah",
  ml: "malachi", mal: "malachi",
  mt: "matthew", mat: "matthew", matt: "matthew",
  mc: "mark", mk: "mark", mr: "mark",
  lc: "luke", lk: "luke", lu: "luke",
  jn: "john", joh: "john",
  ac: "acts", act: "acts",
  rm: "romans", rom: "romans",
  co: "corinthians", cor: "corinthians",
  ga: "galatians", gal: "galatians",
  ep: "ephesians", eph: "ephesians",
  ph: "philippians", php: "philippians", phil: "philippians",
  col: "colossians",
  th: "thessalonians", thes: "thessalonians", thess: "thessalonians",
  ti: "timothy", tm: "timothy", tim: "timothy",
  tt: "titus", tit: "titus",
  phm: "philemon", phlm: "philemon",
  he: "hebrews", heb: "hebrews",
  jc: "james", jas: "james", jm: "james",
  p: "peter", pe: "peter", pt: "peter", pet: "peter",
  jud: "jude", jd: "jude",
  ap: "revelation", apo: "revelation", re: "revelation", rev: "revelation",
}

/** Most-read first: breaks a tie only between genuinely ambiguous prefixes ("ma", "jo", "ph"). */
const PREFERRED: readonly string[] = [
  "john", "matthew", "mark", "luke", "acts", "romans", "genesis", "psalm", "proverbs", "isaiah", "revelation",
  "hebrews", "james", "ephesians", "philippians", "galatians", "colossians", "exodus", "daniel", "jeremiah",
  "1 corinthians", "2 corinthians", "1 john", "1 peter", "2 timothy", "1 timothy", "deuteronomy", "joshua",
]

/** catalog id -> every name it is known by (its own id, then its French aliases), accent-free. */
const NAMES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>(BOOK_CATALOG.map((book) => [book.id, [book.id]]))
  for (const [alias, id] of Object.entries(FRENCH_BOOK_ALIASES)) {
    const names = map.get(id)
    if (names && !names.includes(alias)) names.push(alias)
  }
  return map
})()

const MIN_PREFIX_LENGTH = 2

function splitNumber(key: string): { readonly num: string | null; readonly rest: string } {
  const match = /^([123])\s*(.*)$/.exec(key)
  return match ? { num: match[1] as string, rest: (match[2] as string).trim() } : { num: null, rest: key }
}

/** The catalog book id an operator meant by `raw`, or null when it is unknown or too ambiguous. */
export function resolveQuickBook(raw: string): string | null {
  const key = stripAccents(raw.toLowerCase()).replace(/[.’']/g, "").replace(/\s+/g, " ").trim()
  if (key.length === 0) return null

  const exact = normalizeBookName(key)
  if (CATALOG_IDS.has(exact)) return exact

  const { num, rest } = splitNumber(key)
  if (rest.length === 0) return null
  const withNumber = (base: string): string => (num === null ? base : `${num} ${base}`)

  const abbreviated = ABBREVIATIONS[rest.replace(/\s/g, "")]
  if (abbreviated !== undefined) {
    const id = withNumber(abbreviated)
    if (CATALOG_IDS.has(id)) return id
  }

  // "1 jean", "2 corinthiens": a full French or English base name behind the number.
  const aliased = normalizeBookName(withNumber(rest))
  if (CATALOG_IDS.has(aliased)) return aliased

  if (rest.length < MIN_PREFIX_LENGTH) return null
  const matches: string[] = []
  for (const [id, names] of NAMES) {
    const numbered = /^[123] /.test(id)
    if (numbered ? !id.startsWith(`${num ?? ""} `) : num !== null) continue
    if (names.some((name) => (numbered ? name.slice(2) : name).startsWith(rest))) matches.push(id)
  }
  if (matches.length === 1) return matches[0] as string
  return PREFERRED.find((id) => matches.includes(id)) ?? null
}
