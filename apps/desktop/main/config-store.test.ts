import { normalizeOverlayStyleSettings } from "../../server/overlay/overlay-style"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_SCHEMA_VERSION, ConfigStore, type SecretCodec } from "./config-store"
import type { AppConfig } from "./config-store"

/** Named per AGENTS.md section 45 — a reversible test double, not real encryption. */
class FakeSecretCodec implements SecretCodec {
  encrypt(plaintext: string): Buffer {
    return Buffer.from(`FAKE-ENCRYPTED(${plaintext})`, "utf8")
  }
  decrypt(ciphertext: Buffer): string {
    const text = ciphertext.toString("utf8")
    const match = /^FAKE-ENCRYPTED\((.*)\)$/s.exec(text)
    if (!match) throw new Error("FakeSecretCodec: not a value it encrypted")
    return match[1] as string
  }
}

const SAMPLE_CONFIG: AppConfig = {
  groqApiKey: "gsk_super_secret_value",
  deepgramApiKey: "deepgram_secret_value",
  anthropicApiKey: "sk-ant-secret-value",
  microphoneId: "default-mic",
  operatorToken: "operator-token-value",
  viewerToken: "viewer-token-value",
  displayMode: "bilingual",
  uiLanguage: "fr",
  allowPhoneRemote: true,
  verseConfirmationMode: "review",
  enableSermonNotes: true,
  verseLayout: "lower-third",
  frenchTranslation: "darby",
  overlayTemplate: "banner",
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "churchoverlay-config-test-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("ConfigStore: save() then load() round-trips the config exactly", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    const loaded = await store.load()
    assert.deepEqual(loaded, SAMPLE_CONFIG)
  })
})

// ARCHITECTURE.md section 92: plain, non-secret display strings — no
// encryption, unlike the API keys/tokens SAMPLE_CONFIG already covers.
test("ConfigStore: organizationName and accentColor round-trip when present", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save({ ...SAMPLE_CONFIG, organizationName: "Grace Community Church", accentColor: "#3b82f6" })
    const loaded = await store.load()
    assert.equal(loaded?.organizationName, "Grace Community Church")
    assert.equal(loaded?.accentColor, "#3b82f6")
  })
})

test("ConfigStore: organizationName and accentColor are absent (not defaulted) when never set — the app's own neutral default applies, not a stored one", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    const loaded = await store.load()
    assert.equal(loaded?.organizationName, undefined)
    assert.equal(loaded?.accentColor, undefined)
  })
})

test("ConfigStore: microphoneId round-trips correctly when null", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save({ ...SAMPLE_CONFIG, microphoneId: null })
    const loaded = await store.load()
    assert.equal(loaded?.microphoneId, null)
  })
})

test("ConfigStore: load() on a file that doesn't exist yet returns null, not an error", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "nonexistent.json"), new FakeSecretCodec())
    assert.equal(await store.load(), null)
  })
})

test("ConfigStore: creates the target directory if it doesn't exist yet", async () => {
  await withTempDir(async (dir) => {
    const nestedPath = join(dir, "nested", "sub", "config.json")
    const store = new ConfigStore(nestedPath, new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    assert.deepEqual(await store.load(), SAMPLE_CONFIG)
  })
})

test("ConfigStore: leaves no temp file behind after a successful save", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    const files = await readdir(dir)
    assert.deepEqual(files, ["config.json"])
  })
})

// The actual security property this class exists for: secrets must not
// be recoverable by just reading the file on disk.
test("ConfigStore: the optional anthropicApiKey round-trips, is encrypted at rest, and is absent when never set", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    assert.equal((await store.load())?.anthropicApiKey, SAMPLE_CONFIG.anthropicApiKey)
    const raw = await readFile(path, "utf8")
    assert.equal(raw.includes(SAMPLE_CONFIG.anthropicApiKey as string), false)
    assert.equal(raw.includes("anthropicApiKeyEncrypted"), true)

    const { anthropicApiKey: _omit, ...withoutKey } = SAMPLE_CONFIG
    await store.save(withoutKey)
    const reloaded = await store.load()
    assert.equal(reloaded?.anthropicApiKey, undefined)
    assert.equal("anthropicApiKey" in (reloaded ?? {}), false)
    assert.equal((await readFile(path, "utf8")).includes("anthropicApiKeyEncrypted"), false)
  })
})

test("ConfigStore: secrets are genuinely encrypted at rest — the raw file never contains the plaintext", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)

    const raw = await readFile(path, "utf8")
    assert.equal(raw.includes(SAMPLE_CONFIG.groqApiKey), false)
    assert.equal(raw.includes(SAMPLE_CONFIG.operatorToken), false)
    assert.equal(raw.includes(SAMPLE_CONFIG.viewerToken), false)
  })
})

test("ConfigStore: load() throws a clear error on invalid JSON rather than silently returning garbage", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG) // create the directory structure honestly first
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, "not json at all", "utf8")

    await assert.rejects(() => store.load(), /invalid JSON/)
  })
})

test("ConfigStore: an unreadable config is moved aside so the next save cannot destroy it", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await writeFile(path, "{ broken", "utf8")

    await assert.rejects(() => store.load(), /invalid JSON/)
    const files = await readdir(dir)
    assert.equal(files.includes("config.json"), false)
    const aside = files.find((name) => name.startsWith("config.json.corrupt-"))
    assert.ok(aside, "the corrupt file is kept for recovery")
    assert.equal(await readFile(join(dir, aside), "utf8"), "{ broken")
  })
})

test("ConfigStore: a save keeps the previous good config as config.json.bak", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await store.save({ ...SAMPLE_CONFIG, organizationName: "First" })
    await store.save({ ...SAMPLE_CONFIG, organizationName: "Second" })

    const backup = new ConfigStore(`${path}.bak`, new FakeSecretCodec())
    assert.equal((await backup.load())?.organizationName, "First")
    assert.equal((await store.load())?.organizationName, "Second")
  })
})

test("ConfigStore: load() throws a clear error when required fields are missing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ microphoneId: null }), "utf8")

    const store = new ConfigStore(path, new FakeSecretCodec())
    await assert.rejects(() => store.load(), /missing required encrypted fields/)
  })
})

test("ConfigStore: a second save() overwrites the first cleanly", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    const updated = { ...SAMPLE_CONFIG, microphoneId: "a-different-mic" }
    await store.save(updated)
    assert.deepEqual(await store.load(), updated)
  })
})

// ARCHITECTURE.md section 63.2/63.5: displayMode/uiLanguage were added
// after this file format already existed — a config saved by an older
// version of the app must still load, defaulting rather than failing.
test("ConfigStore: a config saved before displayMode/uiLanguage existed loads with defaults, not an error", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const legacyStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      // no displayMode, no uiLanguage — exactly what an old file looks like
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(legacyStored), "utf8")

    const store = new ConfigStore(path, codec)
    const loaded = await store.load()
    assert.equal(loaded?.displayMode, "english")
    assert.equal(loaded?.uiLanguage, "en")
  })

})

test("ConfigStore: a config saved before allowPhoneRemote existed loads with allowPhoneRemote defaulting to false", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const legacyStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      displayMode: "english",
      uiLanguage: "en",
      // no allowPhoneRemote — exactly what a pre-section-65.6 file looks like
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(legacyStored), "utf8")

    const store = new ConfigStore(path, codec)
    const loaded = await store.load()
    assert.equal(loaded?.allowPhoneRemote, false)
  })
})

test("ConfigStore: a config saved before verseConfirmationMode existed loads with it defaulting to 'auto'", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const legacyStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      displayMode: "english",
      uiLanguage: "en",
      allowPhoneRemote: false,
      // no verseConfirmationMode — exactly what a pre-section-65.3 file looks like
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(legacyStored), "utf8")

    const store = new ConfigStore(path, codec)
    const loaded = await store.load()
    assert.equal(loaded?.verseConfirmationMode, "auto")
  })
})

test("ConfigStore: a config saved before enableSermonNotes existed loads with it defaulting to false", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const legacyStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      displayMode: "english",
      uiLanguage: "en",
      allowPhoneRemote: false,
      verseConfirmationMode: "auto",
      // no enableSermonNotes — exactly what a pre-section-65.7 file looks like
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(legacyStored), "utf8")

    const store = new ConfigStore(path, codec)
    const loaded = await store.load()
    assert.equal(loaded?.enableSermonNotes, false)
  })
})

// ARCHITECTURE.md section 82: verseLayout was added after this file format
// already existed — same backward-compatible defaulting (to "fullscreen",
// the confirmed default) as the others above.
test("ConfigStore: a config saved before verseLayout existed loads with it defaulting to 'fullscreen'", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const legacyStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      displayMode: "english",
      uiLanguage: "en",
      allowPhoneRemote: false,
      verseConfirmationMode: "auto",
      enableSermonNotes: false,
      // no verseLayout — exactly what a pre-section-82 file looks like
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(legacyStored), "utf8")

    const store = new ConfigStore(path, codec)
    const loaded = await store.load()
    assert.equal(loaded?.verseLayout, "fullscreen")
  })
})

test("ConfigStore: a config saved before frenchTranslation existed loads with it defaulting to 'ls1910'", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const legacyStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      // no frenchTranslation — exactly what a pre-section-107 file looks like
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(legacyStored), "utf8")

    const store = new ConfigStore(path, codec)
    const loaded = await store.load()
    assert.equal(loaded?.frenchTranslation, "ls1910")
  })
})

test("ConfigStore: a config saved before overlayTemplate existed loads with it defaulting to 'classic'", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const legacyStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      // no overlayTemplate — exactly what a pre-section-108 file looks like
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(legacyStored), "utf8")

    const store = new ConfigStore(path, codec)
    const loaded = await store.load()
    assert.equal(loaded?.overlayTemplate, "classic")
  })
})

test("ConfigStore: overlayStyle round-trips normalized, and a pre-section-110 file loads without one", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    const style = normalizeOverlayStyleSettings({ paletteId: "ocean", card: "glass", brand: { name: { text: "Grace", visible: true, x: 40 } } })
    await store.save({ ...SAMPLE_CONFIG, overlayStyle: style })
    assert.deepEqual((await store.load())?.overlayStyle, style)
    await store.save(SAMPLE_CONFIG)
    assert.equal((await store.load())?.overlayStyle, undefined)
  })
})

test("ConfigStore: a corrupt stored overlayStyle degrades field-by-field instead of failing the load", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const stored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: null,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
      overlayStyle: { paletteId: "gone", card: "elegant", brand: { name: { text: "Kept", size: "huge", x: 25 }, logo: 9 } },
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(stored), "utf8")
    const loaded = await new ConfigStore(path, codec).load()
    const s = loaded?.overlayStyle
    assert.equal(s?.paletteId, "gilt-night") // bad field -> default
    assert.equal(s?.card, "elegant") // good field kept
    assert.equal(s?.brand.name.text, "Kept")
    assert.equal(s?.brand.name.x, 25)
    assert.equal(s?.brand.name.size, 28) // bad type -> default
    assert.equal(s?.brand.logo.version, 0)
  })
})

test("ConfigStore: concurrent saves in the same millisecond all succeed and the last one wins", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    const saves = []
    for (let i = 0; i < 20; i++) saves.push(store.save({ ...SAMPLE_CONFIG, organizationName: `Church ${i}` }))
    await Promise.all(saves)

    assert.equal((await store.load())?.organizationName, "Church 19")
    assert.deepEqual((await readdir(dir)).sort(), ["config.json", "config.json.bak"])
  })
})

test("ConfigStore: update() calls in parallel each keep their own field (no lost update)", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    await Promise.all([
      store.update((c) => ({ ...c, displayMode: "french" })),
      store.update((c) => ({ ...c, uiLanguage: "fr" })),
      store.update((c) => ({ ...c, verseConfirmationMode: "review" })),
      store.update((c) => ({ ...c, organizationName: "Grace" })),
    ])
    const loaded = await store.load()
    assert.equal(loaded?.displayMode, "french")
    assert.equal(loaded?.uiLanguage, "fr")
    assert.equal(loaded?.verseConfirmationMode, "review")
    assert.equal(loaded?.organizationName, "Grace")
  })
})

test("ConfigStore: update() on a missing config returns null and creates nothing", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    assert.equal(await store.update((c) => c), null)
    assert.deepEqual(await readdir(dir), [])
  })
})

// ARCHITECTURE.md section 113: which offline engine backs the chain.
test("ConfigStore: local ASR engine, model and enabled flag round-trip", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    const config: AppConfig = { ...SAMPLE_CONFIG, localAsrEnabled: true, localAsrModel: "small", localAsrEngine: "faster-whisper" }
    await store.save(config)
    assert.deepEqual(await store.load(), config)
  })
})

test("ConfigStore: AI feature toggles round-trip, and an older file loads with none of them set (= off)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const store = new ConfigStore(path, codec)
    await store.save({ ...SAMPLE_CONFIG, aiTranscriptCleanup: true, aiSemanticDetection: false, aiSermonCopilot: true })
    const loaded = await store.load()
    assert.equal(loaded?.aiTranscriptCleanup, true)
    assert.equal(loaded?.aiSemanticDetection, false)
    assert.equal(loaded?.aiSermonCopilot, true)

    await store.save(SAMPLE_CONFIG)
    const older = await store.load()
    assert.equal(older?.aiTranscriptCleanup, undefined)
    assert.equal(older?.aiSemanticDetection, undefined)
    assert.equal(older?.aiSermonCopilot, undefined)
  })
})

test("ConfigStore: aiProvider round-trips, an older file loads without it, and an an unknown value falls back to absent", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const store = new ConfigStore(path, codec)
    await store.save({ ...SAMPLE_CONFIG, aiProvider: "groq" })
    assert.equal((await store.load())?.aiProvider, "groq")

    await store.save(SAMPLE_CONFIG)
    assert.equal((await store.load())?.aiProvider, undefined)

    const { readFile, writeFile } = await import("node:fs/promises")
    const raw = JSON.parse(await readFile(path, "utf8"))
    raw.aiProvider = "openai"
    await writeFile(path, JSON.stringify(raw))
    assert.equal((await store.load())?.aiProvider, undefined) // unknown value falls back (B6), see tolerance test
  })
})

test("ConfigStore: customBibleApiUrl round-trips when present and valid HTTPS URL", async () => {
  await withTempDir(async (dir) => {
    const store = new ConfigStore(join(dir, "config.json"), new FakeSecretCodec())
    await store.save({ ...SAMPLE_CONFIG, customBibleApiUrl: "https://my-bible-server.internal" })
    const loaded = await store.load()
    assert.equal(loaded?.customBibleApiUrl, "https://my-bible-server.internal")
  })
})

// ---------------------------------------------------------------------------
// B6 (audit REPORT.md): tolerant load. One bad optional field, an unknown enum
// value (downgrade/rollback) or one undecryptable secret must never take the
// whole config (keys, tokens) down with it.
// ---------------------------------------------------------------------------

type StoredBase = Record<string, unknown>

function storedBase(codec: SecretCodec): StoredBase {
  return {
    groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
    deepgramApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.deepgramApiKey as string).toString("base64"),
    anthropicApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.anthropicApiKey as string).toString("base64"),
    microphoneId: SAMPLE_CONFIG.microphoneId,
    operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
    viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
  }
}

const TOLERANCE_CASES: ReadonlyArray<readonly [field: string, bad: unknown, read: (c: AppConfig) => unknown, expected: unknown]> = [
  ["organizationName", 42, (c) => c.organizationName, undefined],
  ["accentColor", 42, (c) => c.accentColor, undefined],
  ["displayMode", "spanish", (c) => c.displayMode, "english"],
  ["uiLanguage", "de", (c) => c.uiLanguage, "en"],
  ["allowPhoneRemote", "yes", (c) => c.allowPhoneRemote, false],
  ["verseConfirmationMode", "sometimes", (c) => c.verseConfirmationMode, "auto"],
  ["enableSermonNotes", "yes", (c) => c.enableSermonNotes, false],
  ["verseLayout", "sidebar", (c) => c.verseLayout, "fullscreen"],
  ["frenchTranslation", "niv", (c) => c.frenchTranslation, "ls1910"],
  ["overlayTemplate", "holographic", (c) => c.overlayTemplate, "classic"],
  ["localAsrEngine", "mystery", (c) => c.localAsrEngine, undefined],
  ["localAsrModel", "huge", (c) => c.localAsrModel, undefined],
  ["localAsrEnabled", "yes", (c) => c.localAsrEnabled, undefined],
  ["audioProfile", "turbo", (c) => c.audioProfile, undefined],
  ["asrStrategy", "quantum", (c) => c.asrStrategy, undefined],
  ["aiProvider", "openai", (c) => c.aiProvider, undefined],
  ["autoGain", "yes", (c) => c.autoGain, undefined],
  ["ndiEnabled", "yes", (c) => c.ndiEnabled, undefined],
  ["aiTranscriptCleanup", "yes", (c) => c.aiTranscriptCleanup, undefined],
  ["aiSemanticDetection", "yes", (c) => c.aiSemanticDetection, undefined],
  ["aiSermonCopilot", "yes", (c) => c.aiSermonCopilot, undefined],
  ["noiseMode", "deafening", (c) => c.noiseMode, undefined],
  ["customBibleApiUrl", 12345, (c) => c.customBibleApiUrl, undefined],
  ["customBibleApiUrl", "http://insecure-bible.com", (c) => c.customBibleApiUrl, undefined],
  ["microphoneId", 7, (c) => c.microphoneId, null],
]

test("ConfigStore: ONE invalid optional field / unknown enum falls back to its default; keys, tokens and other fields survive and nothing is quarantined", async () => {
  for (const [field, bad, read, expected] of TOLERANCE_CASES) {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json")
      const codec = new FakeSecretCodec()
      await writeFile(path, JSON.stringify({ ...storedBase(codec), organizationName: "Grace", [field]: bad }), "utf8")
      const warnings: string[] = []
      const store = new ConfigStore(path, codec, { warn: (f) => warnings.push(`${f.event}:${String(f.metadata?.field)}`) })

      const loaded = await store.load()
      assert.ok(loaded, `${field}: config must load`)
      assert.equal(read(loaded), expected, `${field}: falls back`)
      assert.equal(loaded.groqApiKey, SAMPLE_CONFIG.groqApiKey, `${field}: groq key kept`)
      assert.equal(loaded.deepgramApiKey, SAMPLE_CONFIG.deepgramApiKey, `${field}: deepgram key kept`)
      assert.equal(loaded.anthropicApiKey, SAMPLE_CONFIG.anthropicApiKey, `${field}: anthropic key kept`)
      assert.equal(loaded.operatorToken, SAMPLE_CONFIG.operatorToken, `${field}: tokens kept`)
      if (field !== "organizationName") assert.equal(loaded.organizationName, "Grace", `${field}: other fields kept`)
      assert.ok(warnings.some((w) => w.endsWith(`:${field}`)), `${field}: a warning was logged`)
      assert.deepEqual((await readdir(dir)).sort(), ["config.json"], `${field}: file not quarantined`)
      assert.deepEqual(store.getRecovery(), [], `${field}: not reported as a recovery`)
    })
  }
})

test("ConfigStore: one undecryptable secret does not discard the others or the rest of the config, and is reported by name", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const stored = { ...storedBase(codec), deepgramApiKeyEncrypted: Buffer.from("garbage").toString("base64"), organizationName: "Grace" }
    await writeFile(path, JSON.stringify(stored), "utf8")
    const warnings: string[] = []
    const store = new ConfigStore(path, codec, { warn: (f) => warnings.push(JSON.stringify(f)) })

    const loaded = await store.load()
    assert.ok(loaded)
    assert.equal(loaded.groqApiKey, SAMPLE_CONFIG.groqApiKey)
    assert.equal(loaded.anthropicApiKey, SAMPLE_CONFIG.anthropicApiKey)
    assert.equal(loaded.deepgramApiKey, undefined)
    assert.equal(loaded.operatorToken, SAMPLE_CONFIG.operatorToken)
    assert.equal(loaded.viewerToken, SAMPLE_CONFIG.viewerToken)
    assert.equal(loaded.organizationName, "Grace")
    assert.deepEqual(store.getRecovery(), ["key-unreadable:deepgram"])
    assert.deepEqual((await readdir(dir)).sort(), ["config.json"], "never quarantined")
    assert.ok(warnings.length > 0, "the failure is logged")
    for (const line of warnings) {
      for (const secret of [SAMPLE_CONFIG.groqApiKey, SAMPLE_CONFIG.anthropicApiKey as string, SAMPLE_CONFIG.operatorToken]) {
        assert.equal(line.includes(secret), false, "no secret in logs")
      }
    }
  })
})

test("ConfigStore: an unreadable Groq key is reported; a later save keeps the raw blob until the operator re-enters it, then the report clears", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const garbage = Buffer.from("garbage").toString("base64")
    await writeFile(path, JSON.stringify({ ...storedBase(codec), groqApiKeyEncrypted: garbage }), "utf8")
    const store = new ConfigStore(path, codec)

    const loaded = await store.load()
    assert.equal(loaded?.groqApiKey, "")
    assert.equal(loaded?.deepgramApiKey, SAMPLE_CONFIG.deepgramApiKey)
    assert.deepEqual(store.getRecovery(), ["key-unreadable:groq"])

    await store.update((c) => ({ ...c, organizationName: "Grace" }))
    assert.equal(JSON.parse(await readFile(path, "utf8")).groqApiKeyEncrypted, garbage, "unreadable blob is not destroyed")

    await store.update((c) => ({ ...c, groqApiKey: "gsk_new_key" }))
    assert.deepEqual(store.getRecovery(), [])
    assert.equal((await store.load())?.groqApiKey, "gsk_new_key")
  })
})

test("ConfigStore: schemaVersion is always written, and a file without one loads fine", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await store.save(SAMPLE_CONFIG)
    assert.equal(typeof JSON.parse(await readFile(path, "utf8")).schemaVersion, "number")
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, CONFIG_SCHEMA_VERSION)

    const legacy = storedBase(new FakeSecretCodec())
    await writeFile(path, JSON.stringify(legacy), "utf8")
    assert.equal((await store.load())?.groqApiKey, SAMPLE_CONFIG.groqApiKey)
  })
})

test("ConfigStore: a NEWER schemaVersion loads tolerantly and is not downgraded destructively", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const future = { ...storedBase(codec), schemaVersion: CONFIG_SCHEMA_VERSION + 1, displayMode: "klingon", futureFeature: { on: true } }
    const original = JSON.stringify(future)
    await writeFile(path, original, "utf8")
    const store = new ConfigStore(path, codec)

    const loaded = await store.load()
    assert.equal(loaded?.groqApiKey, SAMPLE_CONFIG.groqApiKey)
    assert.equal(loaded?.displayMode, "english")
    assert.deepEqual(await readdir(dir), ["config.json"], "loading alone writes nothing")

    await store.update((c) => ({ ...c, organizationName: "Grace" }))
    const after = JSON.parse(await readFile(path, "utf8"))
    assert.equal(after.schemaVersion, CONFIG_SCHEMA_VERSION + 1, "version is not lowered")
    assert.deepEqual(after.futureFeature, { on: true }, "unknown fields are carried through")
    const files = await readdir(dir)
    const keep = files.find((name) => name.includes(`schema-v${CONFIG_SCHEMA_VERSION + 1}`))
    assert.ok(keep, "the original newer-version file is kept before it is first rewritten")
    assert.equal(await readFile(join(dir, keep), "utf8"), original)
  })
})

test("ConfigStore: a truly unparseable main file is restored from config.json.bak before anything is quarantined, and the damaged copy is kept", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await store.save({ ...SAMPLE_CONFIG, organizationName: "First" })
    await store.save({ ...SAMPLE_CONFIG, organizationName: "Second" })
    await writeFile(path, "{ truncated", "utf8")

    const loaded = await store.load()
    assert.equal(loaded?.organizationName, "First", "the backup (previous good save) is used")
    assert.equal(loaded?.operatorToken, SAMPLE_CONFIG.operatorToken, "tokens unchanged")
    assert.deepEqual(store.getRecovery(), ["bak"])
    const files = await readdir(dir)
    const aside = files.find((name) => name.startsWith("config.json.corrupt-"))
    assert.ok(aside, "damaged copy kept")
    assert.equal(await readFile(join(dir, aside), "utf8"), "{ truncated")
    assert.equal((await new ConfigStore(path, new FakeSecretCodec()).load())?.organizationName, "First", "main is valid again")
  })
})

test("ConfigStore: when both main and backup are unusable it quarantines, reports it and throws", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await writeFile(path, "{ broken", "utf8")
    await writeFile(`${path}.bak`, "also broken", "utf8")

    await assert.rejects(() => store.load(), /invalid JSON/)
    assert.deepEqual(store.getRecovery(), ["quarantined"])
    const files = await readdir(dir)
    assert.equal(files.includes("config.json"), false)
    assert.ok(files.some((name) => name.startsWith("config.json.corrupt-")))
  })
})

test("ConfigStore: concurrent loads are serialized - one quarantine, one restore, every caller gets the config", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const store = new ConfigStore(path, new FakeSecretCodec())
    await store.save({ ...SAMPLE_CONFIG, organizationName: "First" })
    await store.save({ ...SAMPLE_CONFIG, organizationName: "Second" })
    await writeFile(path, "{ truncated", "utf8")

    const results = await Promise.all([store.load(), store.load(), store.load()])
    for (const r of results) assert.equal(r?.organizationName, "First")
    const asides = (await readdir(dir)).filter((name) => name.startsWith("config.json.corrupt-"))
    assert.equal(asides.length, 1, "double-quarantine is impossible")
  })
})
