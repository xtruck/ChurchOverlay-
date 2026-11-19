import { redactInlineSecrets, scrubSecrets, type LogFields } from "../../../packages/shared/logger"

/**
 * Pure, Electron-free building blocks for the desktop main process' failure
 * handling (audit B1): process-level error guards, operator notices, bounded
 * window reloads, a bounded shutdown wait and the bilingual text of the
 * native startup dialogs. index.ts wires them to Electron; everything here is
 * unit-tested without it.
 */

// ---------------------------------------------------------------- notices --

export type MainNoticeLevel = "info" | "warn" | "error" | "fatal"

/**
 * A non-blocking message from the main process to the operator dashboard.
 * `code` is a stable identifier the renderer maps to its own EN/FR text
 * (main never sends operator prose); `detail` is secret-scrubbed technical
 * context.
 */
export type MainNotice = {
  readonly id: number
  readonly at: number
  readonly level: MainNoticeLevel
  readonly code: string
  readonly detail?: string
  /** One-shot: the dashboard was reloaded after a crash and should restart the mic if the operator had it on. */
  readonly resumeMic?: boolean
}

export type NewNotice = Omit<MainNotice, "id" | "at">

/**
 * Bounded history of notices. Live ones are pushed to the renderer through
 * `send` (which returns false when no loaded dashboard can take them); a
 * freshly loaded dashboard reads snapshot() instead, so a notice raised while
 * the page was reloading or before it existed is never lost.
 */
export class NoticeBoard {
  private readonly history: MainNotice[] = []
  private nextId = 1

  constructor(
    private readonly send: (notice: MainNotice) => boolean,
    private readonly capacity: number = 20,
    private readonly now: () => number = Date.now
  ) {}

  push(notice: NewNotice): MainNotice {
    const stored: MainNotice = { ...notice, id: this.nextId++, at: this.now() }
    this.history.push(stored)
    if (this.history.length > this.capacity) this.history.splice(0, this.history.length - this.capacity)
    try {
      this.send(stored)
    } catch {
      // The dashboard may be mid-reload or destroyed; snapshot() still has it.
    }
    return stored
  }

  /** What a newly loaded dashboard should show. `resumeMic` is handed out once. */
  snapshot(): MainNotice[] {
    const result = this.history.map((notice) => ({ ...notice }))
    for (let index = 0; index < this.history.length; index++) {
      const notice = this.history[index] as MainNotice
      if (notice.resumeMic) {
        const { resumeMic: _consumed, ...rest } = notice
        this.history[index] = rest
      }
    }
    return result
  }
}

// ------------------------------------------------------ process-level guards --

type ProcessLike = {
  on(event: "uncaughtException", listener: (error: Error, origin?: string) => void): unknown
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown
  off(event: "uncaughtException", listener: (error: Error, origin?: string) => void): unknown
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown
}

export type GuardLogger = {
  error(fields: LogFields): void
}

export type ProcessGuardOptions = {
  readonly proc: ProcessLike
  readonly logger: GuardLogger
  readonly notify: (notice: NewNotice) => void
  /** True until startup finished: an exception then is a fatal startup failure. */
  readonly isStarting: () => boolean
  readonly onFatalStartup: (error: unknown) => void
  /** Persist buffered log lines synchronously (best effort). */
  readonly flushLogs?: () => void
  readonly now?: () => number
  /** More than this many errors inside windowMs are counted, not re-reported. */
  readonly maxPerWindow?: number
  readonly windowMs?: number
}

export type ProcessGuards = {
  readonly uninstall: () => void
  readonly suppressedCount: () => number
}

const MAX_STACK_CHARS = 4000

export function describeError(error: unknown): { message: string; stack: string | undefined } {
  if (error instanceof Error) {
    return {
      message: scrubSecrets(error.message),
      stack: error.stack ? redactInlineSecrets(error.stack).slice(0, MAX_STACK_CHARS) : undefined,
    }
  }
  return { message: scrubSecrets(String(error)), stack: undefined }
}

/**
 * uncaughtException / unhandledRejection handlers for the Electron main
 * process. Installing a listener replaces Electron's default modal error
 * box, so these MUST do the reporting themselves: log with the stack, tell
 * the dashboard (non-blocking), and only treat the error as fatal while the
 * app is still starting. They never exit the process on their own, never
 * swallow an error unseen, and cannot loop: a re-entrant error raised while
 * reporting is ignored, and an error storm is rate limited (the first
 * overflow is itself logged, the rest only counted).
 */
export function installProcessGuards(options: ProcessGuardOptions): ProcessGuards {
  const now = options.now ?? Date.now
  const maxPerWindow = options.maxPerWindow ?? 10
  const windowMs = options.windowMs ?? 60_000
  let windowStart = now()
  let inWindow = 0
  let suppressed = 0
  let reporting = false

  const report = (kind: "uncaught-exception" | "unhandled-rejection", error: unknown, origin?: string): void => {
    if (reporting) {
      suppressed++
      return
    }
    reporting = true
    try {
      const current = now()
      if (current - windowStart >= windowMs) {
        windowStart = current
        inWindow = 0
      }
      inWindow++
      if (inWindow > maxPerWindow) {
        suppressed++
        if (inWindow === maxPerWindow + 1) {
          options.logger.error({ component: "main", event: "process.errors-suppressed", metadata: { limit: maxPerWindow, windowMs } })
        }
        return
      }
      const { message, stack } = describeError(error)
      const starting = options.isStarting()
      options.logger.error({
        component: "main",
        event: `process.${kind}`,
        error: message,
        metadata: { fatal: starting, ...(origin ? { origin } : {}), ...(stack ? { stack } : {}) },
      })
      options.notify({ level: starting ? "fatal" : "error", code: kind, detail: message })
      if (starting) options.onFatalStartup(error)
      options.flushLogs?.()
    } catch {
      // Reporting must never throw out of a process-level handler; the log
      // file (if any) already received the first line.
    } finally {
      reporting = false
    }
  }

  const onException = (error: Error, origin?: string) => report("uncaught-exception", error, origin)
  const onRejection = (reason: unknown) => report("unhandled-rejection", reason)
  options.proc.on("uncaughtException", onException)
  options.proc.on("unhandledRejection", onRejection)
  return {
    uninstall() {
      options.proc.off("uncaughtException", onException)
      options.proc.off("unhandledRejection", onRejection)
    },
    suppressedCount: () => suppressed,
  }
}

// ------------------------------------------------------- bounded reloading --

export type ReloadDecision =
  | { readonly allowed: true; readonly delayMs: number; readonly attempt: number }
  | { readonly allowed: false; readonly attempts: number }

/**
 * Bounded retry for reloading a crashed/failed dashboard: at most
 * `maxAttempts` reloads inside `windowMs`, with exponential backoff. A window
 * that then stays healthy for `windowMs` earns a fresh budget.
 */
export class ReloadBudget {
  private readonly attempts: number[] = []

  constructor(
    private readonly maxAttempts: number = 3,
    private readonly windowMs: number = 120_000,
    private readonly baseDelayMs: number = 1000,
    private readonly now: () => number = Date.now
  ) {}

  next(): ReloadDecision {
    const current = this.now()
    while (this.attempts.length > 0 && current - (this.attempts[0] as number) >= this.windowMs) this.attempts.shift()
    if (this.attempts.length >= this.maxAttempts) return { allowed: false, attempts: this.attempts.length }
    this.attempts.push(current)
    return { allowed: true, attempt: this.attempts.length, delayMs: Math.min(this.baseDelayMs * 2 ** (this.attempts.length - 1), 8000) }
  }
}

/** render-process-gone reasons that are a normal exit, not a failure. */
export function isBenignRendererExit(reason: string): boolean {
  return reason === "clean-exit"
}

/** did-fail-load error codes that are not failures (-3 = navigation aborted by a newer one). */
export function isIgnorableLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return !isMainFrame || errorCode === -3
}

// ------------------------------------------------------- bounded shutdown --

/**
 * Waits for `work`, but never longer than `ms`. Never rejects: a failing or
 * hanging shutdown must not keep the app from quitting.
 */
export async function awaitWithTimeout(work: Promise<unknown>, ms: number): Promise<"done" | "timeout" | "failed"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  try {
    return await Promise.race([work.then(() => "done" as const), timeout])
  } catch {
    // Reported by the caller's own logging of the shutdown steps.
    return "failed"
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ------------------------------------------------- native dialog wording --

export type DialogLanguage = "en" | "fr"

export function pickDialogLanguage(locale: string | undefined): DialogLanguage {
  return typeof locale === "string" && locale.toLowerCase().startsWith("fr") ? "fr" : "en"
}

type DialogText = { readonly title: string; readonly body: string }

export const STARTUP_DIALOGS = {
  safeStorageUnavailable: {
    en: {
      title: "ChurchOverlay cannot start",
      body:
        "Secure storage is not available on this computer, so ChurchOverlay cannot keep your API keys safe and will not run without it.\n\n" +
        "What to do: sign in to a normal Windows/macOS user account (not a restricted or temporary one), make sure the system keychain / credential store is unlocked, then start ChurchOverlay again. On Linux install and unlock a keyring (for example gnome-keyring).",
    },
    fr: {
      title: "ChurchOverlay ne peut pas démarrer",
      body:
        "Le stockage sécurisé n’est pas disponible sur cet ordinateur : ChurchOverlay ne peut donc pas protéger vos clés API et refuse de fonctionner sans lui.\n\n" +
        "À faire : ouvrez une session utilisateur normale Windows/macOS (pas un compte restreint ou temporaire), vérifiez que le trousseau / gestionnaire d’identifiants du système est déverrouillé, puis relancez ChurchOverlay. Sous Linux, installez et déverrouillez un trousseau (par exemple gnome-keyring).",
    },
  },
  startupFailed: {
    en: {
      title: "ChurchOverlay cannot start",
      body: "An unexpected error stopped ChurchOverlay from starting:\n\n{detail}\n\nClose and reopen the app. If it keeps happening, use “Open logs folder” (or look in the logs folder of the app data directory) and send the newest log file to support.",
    },
    fr: {
      title: "ChurchOverlay ne peut pas démarrer",
      body: "Une erreur inattendue a empêché le démarrage de ChurchOverlay :\n\n{detail}\n\nFermez puis rouvrez l’application. Si cela se reproduit, utilisez « Ouvrir le dossier des journaux » (ou ouvrez le dossier logs du répertoire de données de l’application) et envoyez le journal le plus récent au support.",
    },
  },
  dashboardUnrecoverable: {
    en: {
      title: "ChurchOverlay window stopped working",
      body: "The operator window crashed and could not be restarted automatically ({detail}). Microphone capture has stopped.\n\nThe overlay in OBS may still show the last verse. Close ChurchOverlay and open it again to resume.",
    },
    fr: {
      title: "La fenêtre de ChurchOverlay ne répond plus",
      body: "La fenêtre de l’opérateur a planté et n’a pas pu être relancée automatiquement ({detail}). La capture du micro est arrêtée.\n\nL’overlay dans OBS peut encore afficher le dernier verset. Fermez ChurchOverlay puis rouvrez-le pour reprendre.",
    },
  },
} as const satisfies Record<string, Record<DialogLanguage, DialogText>>

export type StartupDialogKey = keyof typeof STARTUP_DIALOGS

export function startupDialogText(key: StartupDialogKey, locale: string | undefined, detail = ""): DialogText {
  const text: DialogText = STARTUP_DIALOGS[key][pickDialogLanguage(locale)]
  return { title: text.title, body: text.body.replace("{detail}", scrubSecrets(detail)) }
}
