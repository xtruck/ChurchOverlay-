import { ClaudeClient, type TextCompleter } from "./claude-client"
import { GroqTextClient } from "./groq-text-client"

/**
 * Which service runs the optional AI helpers (ARCHITECTURE.md section 128).
 * An explicit operator choice, never a silent fallback (AGENTS.md section 46):
 *
 *   - "anthropic": needs the Anthropic key;
 *   - "groq":      the free option, reuses the Groq transcription key;
 *   - absent:      "anthropic" when an Anthropic key exists (how it always behaved),
 *                  otherwise no AI at all until the operator picks one.
 *
 * A chosen provider whose key is missing yields NO completer: the helpers stay
 * inert and the dashboard says why. It never quietly switches to the other one.
 */

export const AI_PROVIDERS = ["anthropic", "groq"] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value)
}

export type AiProviderConfig = {
  readonly aiProvider?: AiProvider
  readonly anthropicApiKey?: string
  readonly groqApiKey?: string
}

/** The provider that is selected (explicitly, or by the historical default), whether or not its key is present. */
export function selectedAiProvider(config: AiProviderConfig): AiProvider | null {
  if (config.aiProvider) return config.aiProvider
  return config.anthropicApiKey ? "anthropic" : null
}

/** True when the selected provider has the key it needs. */
export function aiProviderReady(config: AiProviderConfig): boolean {
  const provider = selectedAiProvider(config)
  if (provider === "anthropic") return Boolean(config.anthropicApiKey)
  if (provider === "groq") return Boolean(config.groqApiKey)
  return false
}

/** The completer for the selected provider, or undefined (helpers inert) when none is ready. */
export function createTextCompleter(config: AiProviderConfig, fetchImpl?: typeof fetch): TextCompleter | undefined {
  if (!aiProviderReady(config)) return undefined
  if (selectedAiProvider(config) === "groq") return new GroqTextClient({ apiKey: config.groqApiKey as string, fetchImpl })
  return new ClaudeClient({ apiKey: config.anthropicApiKey as string, fetchImpl })
}
