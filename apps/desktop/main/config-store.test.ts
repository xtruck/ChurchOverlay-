import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
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
  microphoneId: "default-mic",
  operatorToken: "operator-token-value",
  viewerToken: "viewer-token-value",
  displayMode: "bilingual",
  uiLanguage: "fr",
  allowPhoneRemote: true,
  verseConfirmationMode: "review",
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
