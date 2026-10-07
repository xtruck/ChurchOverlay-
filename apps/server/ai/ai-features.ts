/**
 * The optional Anthropic-backed features that have their own live toggle
 * (ARCHITECTURE.md sections 123-125). All default to OFF and are inert without
 * an Anthropic key. Post-service extras (section 126) are a one-shot button,
 * not a running feature, so they have no toggle.
 */
export const AI_FEATURES = ["transcriptCleanup", "semanticDetection", "sermonCopilot"] as const
export type AiFeature = (typeof AI_FEATURES)[number]
export type AiFeatureFlags = Readonly<Record<AiFeature, boolean>>

export const DEFAULT_AI_FEATURES: AiFeatureFlags = {
  transcriptCleanup: false,
  semanticDetection: false,
  sermonCopilot: false,
}

export function isAiFeature(value: unknown): value is AiFeature {
  return typeof value === "string" && (AI_FEATURES as readonly string[]).includes(value)
}
