import { spawn } from "node:child_process"
import type { Logger } from "../../../packages/shared/logger"

/**
 * Silero VAD inside the offline whisper.cpp engine (architecture-notes/offline-vad.md).
 *
 * whisper.cpp's `whisper-server` (v1.8.0, the pinned release) accepts
 * `--vad --vad-model <path>`: before decoding, a ~0.9 MB Silero model drops the
 * non-speech parts of each request, so silence and music cost less CPU and are
 * not handed to Whisper to "transcribe" (its classic hallucination trigger).
 *
 * Opt-in, default OFF. The flags are passed ONLY when the operator enabled it,
 * the model on disk matches its pinned SHA-256, and the engine binary itself
 * reports the flags (a runtime probe of `--help`). Every other outcome is an
 * explicit, reported "unavailable" status with a reason — never a silent
 * pretend-it-is-on (AGENTS.md section 46).
 */

export const WHISPER_VAD_FLAG = "--vad"
export const WHISPER_VAD_MODEL_FLAG = "--vad-model"

/** Bound on the probe's captured help text (the real text is ~6 KB). */
const PROBE_OUTPUT_LIMIT = 64 * 1024
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

export type WhisperCppArgsInput = {
  readonly modelPath: string
  readonly port: number
  readonly threads: number
  /** Verified Silero VAD model; null/undefined = VAD off (no flag is passed). */
  readonly vadModelPath?: string | null
}

/** The whisper.cpp `whisper-server` command line. VAD flags only when a verified model path is given. */
export function buildWhisperCppServerArgs(input: WhisperCppArgsInput): string[] {
  const args = [
    "-m", input.modelPath,
    "--host", "127.0.0.1",
    "--port", String(input.port),
    "-t", String(input.threads),
    "-l", "auto",
    "-nt",
    // Silence and noise are the classic Whisper hallucination trigger;
    // suppressing non-speech tokens removes most "Merci d'avoir regardé".
    "-sns",
  ]
  if (input.vadModelPath) args.push(WHISPER_VAD_FLAG, WHISPER_VAD_MODEL_FLAG, input.vadModelPath)
  return args
}

export type VadCapability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string }

/**
 * Reads the engine's `--help` output. Both flags must appear as whole options;
 * "--vad-model" alone is not taken as proof of "--vad" (and vice versa).
 */
export function parseVadCapability(helpText: string): VadCapability {
  const hasModelFlag = /(^|\s)--vad-model(\s|$|=)/m.test(helpText)
  const hasVadFlag = /(^|\s)--vad(\s|$|=)/m.test(helpText)
  if (hasModelFlag && hasVadFlag) return { supported: true }
  if (helpText.trim() === "") return { supported: false, reason: "The engine printed no help text, so VAD support could not be confirmed." }
  return { supported: false, reason: "This engine build does not list the --vad / --vad-model options." }
}

export type ProbeOptions = {
  readonly spawnImpl?: typeof spawn
  readonly timeoutMs?: number
  readonly logger?: Logger
}

/**
 * Runs `<serverPath> --help` once, bounded in time and captured output, and
 * parses it. Never throws: a spawn failure or timeout is an explicit
 * "unsupported" with the reason, so the caller reports it.
 */
export function probeWhisperVadSupport(serverPath: string, options: ProbeOptions = {}): Promise<VadCapability> {
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    let output = ""
    let settled = false
    const finish = (result: VadCapability) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!result.supported) {
        options.logger?.warn({ component: "asr", event: "local-whisper.vad-probe-unsupported", metadata: { reason: result.reason } })
      }
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(serverPath, ["--help"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (error) {
      resolve({ supported: false, reason: `VAD probe could not start the engine: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill()
      finish({ supported: false, reason: `VAD probe timed out after ${timeoutMs} ms.` })
    }, timeoutMs)
    timer.unref?.()
    const collect = (chunk: Buffer) => {
      if (output.length < PROBE_OUTPUT_LIMIT) output = (output + chunk.toString()).slice(0, PROBE_OUTPUT_LIMIT)
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.once("error", (error) => {
      finish({ supported: false, reason: `VAD probe could not start the engine: ${error instanceof Error ? error.message : String(error)}` })
    })
    // "close" (not "exit"): all output has been read by then.
    child.once("close", () => finish(parseVadCapability(output)))
  })
}

/** What the installer knows about the VAD model file on disk. */
export type VadModelState =
  | { readonly state: "verified"; readonly path: string }
  | { readonly state: "missing" }
  | { readonly state: "corrupt"; readonly detail: string }
  /** The pinned checksum constant is not filled in: fail closed, never trust the file. */
  | { readonly state: "checksum-unpinned" }

export type LocalVadUnavailableReason =
  | "engine-unsupported"
  | "local-engine-not-ready"
  | "model-missing"
  | "model-corrupt"
  | "checksum-unpinned"
  | "binary-unsupported"

/** Reported to the dashboard as-is. */
export type LocalVadStatus =
  | { readonly state: "off" }
  | { readonly state: "active"; readonly modelPath: string }
  | { readonly state: "unavailable"; readonly reason: LocalVadUnavailableReason; readonly detail?: string }

export type ResolveLocalVadInput = {
  readonly enabled: boolean
  readonly engine: "whisper.cpp" | "faster-whisper"
  /** True when the local engine is enabled and installed (it will actually start). */
  readonly engineReady: boolean
  readonly model: () => Promise<VadModelState>
  readonly probe: () => Promise<VadCapability>
}

/**
 * Decides whether the VAD flags are passed. Cheap checks first; the model and
 * the binary probe run only when they can change the answer.
 */
export async function resolveLocalVad(input: ResolveLocalVadInput): Promise<LocalVadStatus> {
  if (!input.enabled) return { state: "off" }
  if (input.engine !== "whisper.cpp") {
    return { state: "unavailable", reason: "engine-unsupported", detail: "VAD is only wired for the whisper.cpp engine." }
  }
  if (!input.engineReady) return { state: "unavailable", reason: "local-engine-not-ready" }
  const model = await input.model()
  if (model.state === "missing") return { state: "unavailable", reason: "model-missing" }
  if (model.state === "checksum-unpinned") return { state: "unavailable", reason: "checksum-unpinned" }
  if (model.state === "corrupt") return { state: "unavailable", reason: "model-corrupt", detail: model.detail }
  const capability = await input.probe()
  if (!capability.supported) return { state: "unavailable", reason: "binary-unsupported", detail: capability.reason }
  return { state: "active", modelPath: model.path }
}
