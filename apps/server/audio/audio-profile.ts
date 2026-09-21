export type AudioProfile = "responsive" | "balanced" | "robust"

export type AudioProfileSettings = {
  readonly chunkDurationMs: number
  readonly silenceThreshold: number
}

export const AUDIO_PROFILE_SETTINGS: Record<AudioProfile, AudioProfileSettings> = {
  responsive: { chunkDurationMs: 1200, silenceThreshold: 120 },
  balanced: { chunkDurationMs: 2000, silenceThreshold: 150 },
  robust: { chunkDurationMs: 3500, silenceThreshold: 220 },
}

export function getAudioProfileSettings(profile: AudioProfile | undefined): AudioProfileSettings {
  return AUDIO_PROFILE_SETTINGS[profile ?? "balanced"]
}
