import type { DisplayMode, VerseConfirmationMode } from "../../packages/contracts"

/**
 * The operator/setup interface's display-language union. Deliberately
 * re-declared rather than imported from `apps/desktop/main/config-store.ts`:
 * this module belongs to Web Server Mode, which must never pull an
 * Electron-only module into its process (ARCHITECTURE.md section 80) — the
 * same no-build-step duplication precedent section 68.3 already records for
 * `computeRmsInt16()` / `float32ToInt16()`.
 */
export type UiLanguage = "en" | "fr"

/** Runtime guards for values arriving over HTTP — the same sets /api/mode and /api/language accept. */
export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "english" || value === "french" || value === "bilingual"
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "en" || value === "fr"
}

/**
 * The one place the page URLs Web Server Mode advertises are built
 * (ARCHITECTURE.md section 106, SECURITY.md item 13).
 *
 * Role assignment here must match what the WS handshake itself enforces
 * (`apps/server/ws/server.ts`): every read-only page gets the VIEWER token,
 * and only the phone remote gets the operator token. A viewer page handed
 * the operator token would turn a screen that merely displays verses into a
 * client allowed to issue `mic:start`/`verse:clear` — the exact escalation
 * AGENTS.md section 20 forbids for the overlay.
 */
export type WebPageUrls = {
  readonly overlay: string
  readonly remote: string
  readonly stage: string
  readonly live: string
}

export function buildPageUrls(tokens: {
  readonly port: number
  readonly operatorToken: string
  readonly viewerToken: string
}): WebPageUrls {
  // Every page needs wsPort explicitly: a page opened from another machine
  // on the LAN (or from a file:// window) cannot infer the WS port from its
  // own URL (ARCHITECTURE.md section 65.6).
  //
  // The token rides in the URL FRAGMENT (#token=...), which a browser never
  // sends to the server, so it stays out of access logs, proxies and the
  // Referer header. The pages still accept the old ?token= form, so a link
  // already pasted into OBS keeps working.
  const wsPort = `?wsPort=${tokens.port}`
  return {
    overlay: `/overlay/index.html${wsPort}#token=${tokens.viewerToken}`,
    remote: `/remote/index.html${wsPort}#token=${tokens.operatorToken}`,
    stage: `/stage/index.html${wsPort}#token=${tokens.viewerToken}`,
    live: `/live/index.html${wsPort}#token=${tokens.viewerToken}`,
  }
}

/**
 * Exactly the body `/api/status` and `/api/setup` already returned, plus the
 * Stage Display and Live Companion viewer URLs. Extracted into this module
 * (rather than left inline in `apps/web/index.ts`) so this URL/token contract
 * is unit-testable without booting a real server — importing `index.ts`
 * would run `main()`.
 */
export type WebStatusPayload = {
  readonly ready: true
  readonly hasGroqKey: boolean
  readonly port: number
  readonly token: string
  readonly viewerToken: string
  readonly displayMode: DisplayMode
  readonly uiLanguage: UiLanguage
  readonly verseConfirmationMode: VerseConfirmationMode
  readonly enableSermonNotes: boolean
  readonly allowPhoneRemote: boolean
  readonly overlayUrl: string
  readonly remoteUrl: string
  readonly stageUrl: string
  readonly liveUrl: string
}

export type WebStatusPayloadInput = {
  readonly port: number
  readonly operatorToken: string
  readonly viewerToken: string
  readonly hasGroqKey: boolean
  readonly displayMode: DisplayMode
  readonly uiLanguage: UiLanguage
  readonly verseConfirmationMode: VerseConfirmationMode
  readonly enableSermonNotes: boolean
  readonly allowPhoneRemote: boolean
}

export function buildStatusPayload(input: WebStatusPayloadInput): WebStatusPayload {
  const urls = buildPageUrls(input)
  return {
    ready: true,
    hasGroqKey: input.hasGroqKey,
    port: input.port,
    token: input.operatorToken,
    viewerToken: input.viewerToken,
    displayMode: input.displayMode,
    uiLanguage: input.uiLanguage,
    verseConfirmationMode: input.verseConfirmationMode,
    enableSermonNotes: input.enableSermonNotes,
    allowPhoneRemote: input.allowPhoneRemote,
    overlayUrl: urls.overlay,
    remoteUrl: urls.remote,
    stageUrl: urls.stage,
    liveUrl: urls.live,
  }
}
