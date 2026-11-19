import { test } from "node:test"
import assert from "node:assert/strict"
import { redactToken, redactUrl } from "./redact-url"

test("redactUrl: the fragment token is masked to a 4-char fingerprint", () => {
  const url = redactUrl("http://192.168.1.20:3000/remote/index.html?wsPort=3000#token=abcdef1234567890")
  assert.ok(!url.includes("abcdef1234567890"), "the full token must never survive")
  assert.ok(url.includes("#token=abcd…"))
  assert.ok(url.includes("wsPort=3000"), "the non-secret parameters stay untouched")
  assert.ok(url.startsWith("http://192.168.1.20:3000/remote/index.html"))
})

test("redactUrl: the legacy query form is masked too, both forms in one URL", () => {
  const both = redactUrl("http://h:3000/p?token=0123456789abcdef&wsPort=5#token=fedcba9876543210")
  assert.ok(!both.includes("0123456789abcdef"))
  assert.ok(!both.includes("fedcba9876543210"))
  assert.ok(both.includes("?token=0123…"))
  assert.ok(both.includes("#token=fedc…"))
  assert.ok(both.includes("wsPort=5"))
})

test("redactUrl: a URL without a token passes through byte for byte", () => {
  const plain = "http://127.0.0.1:3000/healthz?x=1&y=2"
  assert.equal(redactUrl(plain), plain)
  assert.equal(redactUrl(""), "")
})

test("redactUrl: short tokens mask to a bare ellipsis (never a usable prefix)", () => {
  assert.ok(!redactUrl("http://h/p#token=abc").includes("abc"))
  assert.ok(redactUrl("http://h/p#token=abc").includes("#token=…"))
  assert.ok(!redactUrl("http://h/p?token=xyz&b=1").includes("xyz"))
})

test("redactToken: boundary values", () => {
  assert.equal(redactToken("abcdef123456"), "abcd…")
  assert.equal(redactToken("abcd"), "…")
  assert.equal(redactToken("abc"), "…")
})

test("redactUrl: a full startup block masks every token at once", () => {
  const operator = "e3b0c44298fc1c149afbf4c8996fb924"
  const viewer = "27ae41e4649b934ca495991b7852b855"
  const lines = [
    `Overlay URL: http://192.168.1.20:3000/overlay/index.html?wsPort=3000#token=${viewer}`,
    `Remote URL: http://192.168.1.20:3000/remote/index.html?wsPort=3000#token=${operator}`,
  ].map(redactUrl)
  const joined = lines.join("\n")
  assert.ok(!joined.includes(operator))
  assert.ok(!joined.includes(viewer))
  assert.ok(joined.includes("#token=27ae…"))
  assert.ok(joined.includes("#token=e3b0…"))
})
