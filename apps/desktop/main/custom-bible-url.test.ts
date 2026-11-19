import { test } from "node:test"
import assert from "node:assert/strict"
import { validateCustomBibleApiUrl } from "./custom-bible-url"

test("validateCustomBibleApiUrl: accepts a public https URL and strips the trailing slash", () => {
  assert.deepEqual(validateCustomBibleApiUrl("https://bible.example.org/api/"), { ok: true, url: "https://bible.example.org/api" })
})

test("validateCustomBibleApiUrl: rejects non-https, credentials, query and fragment", () => {
  for (const bad of [
    "http://bible.example.org",
    "https://user:pw@bible.example.org",
    "https://bible.example.org/?key=1",
    "https://bible.example.org/#x",
    "not a url",
    "",
  ]) {
    assert.equal(validateCustomBibleApiUrl(bad).ok, false, bad)
  }
})

test("validateCustomBibleApiUrl: rejects loopback, private and link-local targets", () => {
  for (const bad of [
    "https://localhost",
    "https://app.localhost",
    "https://printer.local",
    "https://intranet",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://172.16.4.1",
    "https://192.168.1.10",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
  ]) {
    assert.equal(validateCustomBibleApiUrl(bad).ok, false, bad)
  }
})
