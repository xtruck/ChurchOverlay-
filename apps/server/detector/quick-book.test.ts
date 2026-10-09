import test from "node:test"
import assert from "node:assert/strict"
import { resolveQuickBook } from "./quick-book"
import { BOOK_CATALOG } from "../verse/book-catalog"

test("resolveQuickBook: abbreviations, French names and numbered books resolve", () => {
  const cases: Record<string, string> = {
    jn: "john", "Jn.": "john", Jean: "john", "1co": "1 corinthians", "2 co": "2 corinthians", gen: "genesis",
    ps: "psalm", psaumes: "psalm", "1 jn": "1 john", "1 jean": "1 john", rev: "revelation", apo: "revelation",
  }
  for (const [typed, id] of Object.entries(cases)) assert.equal(resolveQuickBook(typed), id, typed)
})

test("resolveQuickBook: ambiguous prefixes use the preference list, unknown input is null", () => {
  assert.equal(resolveQuickBook("jo"), "john")
  assert.equal(resolveQuickBook("ma"), "matthew")
  for (const typed of ["go", "xyz", "1", ""]) assert.equal(resolveQuickBook(typed), null, typed)
})

test("resolveQuickBook: every full catalog id resolves to itself", () => {
  for (const book of BOOK_CATALOG) assert.equal(resolveQuickBook(book.id), book.id)
})
