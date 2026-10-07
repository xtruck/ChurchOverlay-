import { normalizeOverlayStyleSettings } from "../../server/overlay/overlay-style"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigStore, type SecretCodec } from "./config-store"
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

test("ConfigStore: load() throws on a present but invalid organizationName/accentColor (real corruption)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ ...baseStored, organizationName: 42 }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid organizationName/)
    await writeFile(path, JSON.stringify({ ...baseStored, accentColor: 42 }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid accentColor/)
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

test("ConfigStore: load() throws on a present but invalid displayMode or uiLanguage (real corruption, not an old file)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")

    await writeFile(path, JSON.stringify({ ...baseStored, displayMode: "spanish" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid displayMode/)

    await writeFile(path, JSON.stringify({ ...baseStored, uiLanguage: "de" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid uiLanguage/)
  })
})

// ARCHITECTURE.md section 65.6: allowPhoneRemote was added after this
// file format already existed — same backward-compatible defaulting
// (to false, the confirmed opt-in-only default) as displayMode/uiLanguage.
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

test("ConfigStore: load() throws on a present but non-boolean allowPhoneRemote (real corruption, not an old file)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ ...baseStored, allowPhoneRemote: "yes" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid allowPhoneRemote/)
  })
})

// ARCHITECTURE.md section 65.3: verseConfirmationMode was added after this
// file format already existed — same backward-compatible defaulting (to
// "auto", the confirmed unchanged-behavior default) as the others above.
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

test("ConfigStore: load() throws on a present but invalid verseConfirmationMode (real corruption, not an old file)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ ...baseStored, verseConfirmationMode: "sometimes" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid verseConfirmationMode/)
  })
})

// ARCHITECTURE.md section 65.7: enableSermonNotes was added after this
// file format already existed — same backward-compatible defaulting (to
// false, the confirmed opt-in-for-cost default) as allowPhoneRemote above.
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

test("ConfigStore: load() throws on a present but invalid verseLayout (real corruption, not an old file)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ ...baseStored, verseLayout: "sidebar" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid verseLayout/)
  })
})

// ARCHITECTURE.md section 107: frenchTranslation was added after this file
// format already existed — same backward-compatible defaulting (to
// "ls1910", the sole translation every existing install already has) as
// verseLayout above.
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

test("ConfigStore: load() throws on a present but invalid frenchTranslation (real corruption, not an old file)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ ...baseStored, frenchTranslation: "niv" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid frenchTranslation/)
  })
})

// ARCHITECTURE.md section 108: overlayTemplate, same backward-compatible
// defaulting shape (to "classic", the overlay's one and only look before
// this existed).
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

test("ConfigStore: load() throws on a present but invalid overlayTemplate (real corruption, not an old file)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ ...baseStored, overlayTemplate: "holographic" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid overlayTemplate/)
  })
})

test("ConfigStore: load() throws on a present but non-boolean enableSermonNotes (real corruption, not an old file)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json")
    const codec = new FakeSecretCodec()
    const baseStored = {
      groqApiKeyEncrypted: codec.encrypt(SAMPLE_CONFIG.groqApiKey).toString("base64"),
      microphoneId: SAMPLE_CONFIG.microphoneId,
      operatorTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.operatorToken).toString("base64"),
      viewerTokenEncrypted: codec.encrypt(SAMPLE_CONFIG.viewerToken).toString("base64"),
    }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify({ ...baseStored, enableSermonNotes: "yes" }), "utf8")
    await assert.rejects(() => new ConfigStore(path, codec).load(), /invalid enableSermonNotes/)
  })
})

// ARCHITECTURE.md section 110: overlayStyle is optional and self-healing.
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
    assert.deepEqual(await readdir(dir), ["config.json"])
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

test("ConfigStore: an unknown localAsrEngine is rejected on load, not silently defaulted", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json")
    const store = new ConfigStore(file, new FakeSecretCodec())
    await store.save({ ...SAMPLE_CONFIG, localAsrEngine: "faster-whisper" })
    const raw = JSON.parse(await readFile(file, "utf8"))
    raw.localAsrEngine = "mystery"
    await writeFile(file, JSON.stringify(raw))
    await assert.rejects(store.load(), /invalid localAsrEngine/)
  })
})
