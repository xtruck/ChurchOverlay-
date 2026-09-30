import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPageUrls, buildStatusPayload } from "./status-payload"

const TOKENS = {
  port: 3000,
  operatorToken: "operator-token-value",
  viewerToken: "viewer-token-value",
}

const INPUT = {
  ...TOKENS,
  hasGroqKey: true,
  displayMode: "bilingual" as const,
  uiLanguage: "fr" as const,
  verseConfirmationMode: "auto" as const,
  enableSermonNotes: false,
  allowPhoneRemote: true,
}

test("buildPageUrls: read-only pages carry the viewer token, the phone remote carries the operator token", () => {
  const urls = buildPageUrls(TOKENS)

  assert.match(urls.overlay, /token=viewer-token-value/)
  assert.match(urls.stage, /token=viewer-token-value/)
  assert.match(urls.live, /token=viewer-token-value/)
  assert.match(urls.remote, /token=operator-token-value/)
})

test("buildPageUrls: no viewer page is ever handed the operator token", () => {
  // The escalation this guards against: a page that only DISPLAYS verse text
  // must not hold the credential that can issue mic:start/verse:clear
  // (AGENTS.md section 20). One wrong template literal here would do it.
  const urls = buildPageUrls(TOKENS)

  for (const [name, url] of Object.entries(urls)) {
    if (name === "remote") continue
    assert.doesNotMatch(url, /operator-token-value/, `${name} URL leaks the operator token`)
  }
})

test("buildPageUrls: every page URL carries wsPort, and points at an index.html on its own static mount", () => {
  const urls = buildPageUrls(TOKENS)

  assert.deepEqual(urls, {
    overlay: "/overlay/index.html?token=viewer-token-value&wsPort=3000",
    remote: "/remote/index.html?token=operator-token-value&wsPort=3000",
    stage: "/stage/index.html?token=viewer-token-value&wsPort=3000",
    live: "/live/index.html?token=viewer-token-value&wsPort=3000",
  })
})

test("buildStatusPayload: exposes the stage and live viewer URLs alongside the pre-existing overlay/remote ones", () => {
  // The regression this exists for: /api/status and /api/setup published only
  // overlayUrl/remoteUrl, so the Stage Display Monitor and the Live
  // Congregation Companion had no discoverable, token-bearing link at all.
  const payload = buildStatusPayload(INPUT)

  assert.equal(payload.stageUrl, "/stage/index.html?token=viewer-token-value&wsPort=3000")
  assert.equal(payload.liveUrl, "/live/index.html?token=viewer-token-value&wsPort=3000")
  assert.equal(payload.overlayUrl, "/overlay/index.html?token=viewer-token-value&wsPort=3000")
  assert.equal(payload.remoteUrl, "/remote/index.html?token=operator-token-value&wsPort=3000")
})

test("buildStatusPayload: passes the live settings through unchanged and still reports ready", () => {
  const payload = buildStatusPayload(INPUT)

  assert.equal(payload.ready, true)
  assert.equal(payload.hasGroqKey, true)
  assert.equal(payload.port, 3000)
  assert.equal(payload.token, TOKENS.operatorToken)
  assert.equal(payload.viewerToken, TOKENS.viewerToken)
  assert.equal(payload.displayMode, "bilingual")
  assert.equal(payload.uiLanguage, "fr")
  assert.equal(payload.verseConfirmationMode, "auto")
  assert.equal(payload.enableSermonNotes, false)
  assert.equal(payload.allowPhoneRemote, true)
})
