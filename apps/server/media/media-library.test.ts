import { fakeMediaBytes } from "./media-test-fixtures"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MediaImportError, MediaLibrary, isTitleErrorCode } from "./media-library"
import { isValidUlid } from "../../../packages/shared/ulid"

async function withTempDirs(
  fn: (sourceDir: string, mediaDir: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "churchoverlay-media-test-"))
  try {
    const sourceDir = join(root, "source")
    const mediaDir = join(root, "media")
    await mkdir(sourceDir, { recursive: true })
    await fn(sourceDir, mediaDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("MediaLibrary: import() copies the file, assigns a fresh ULID, and resolve() returns it", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "welcome.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const library = new MediaLibrary({ mediaDir })
    const cue = await library.import(sourcePath, "Welcome Slide", "image")

    assert.equal(cue.kind, "image")
    assert.equal(cue.title, "Welcome Slide")
    assert.ok(isValidUlid(cue.id))
    assert.deepEqual(library.resolve(cue.id), cue)

    // The copied media file plus the persisted metadata file (below) —
    // not just the media file alone.
    const filesInMediaDir = await readdir(mediaDir)
    assert.equal(filesInMediaDir.length, 2)
    assert.ok(filesInMediaDir.some((f) => f.startsWith(cue.id)))
    assert.ok(filesInMediaDir.includes("media-cues.json"))
  })
})

test("MediaLibrary: resolve() returns null for an unknown id, never throws", async () => {
  await withTempDirs(async (_sourceDir, mediaDir) => {
    const library = new MediaLibrary({ mediaDir })
    assert.equal(library.resolve("not-a-real-id"), null)
  })
})

test("MediaLibrary: resolveFilePath() returns the real stored path for a known id, null otherwise", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "clip.mp4")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const library = new MediaLibrary({ mediaDir })
    const cue = await library.import(sourcePath, "Intro Clip", "video")

    const storedPath = library.resolveFilePath(cue.id)
    assert.ok(storedPath)
    assert.ok(storedPath?.startsWith(mediaDir))
    assert.equal(library.resolveFilePath("unknown-id"), null)
  })
})

test("MediaLibrary: import() rejects a disallowed extension for the given kind", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "malware.exe")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const library = new MediaLibrary({ mediaDir })
    await assert.rejects(() => library.import(sourcePath, "Sketchy File", "image"))
  })
})

test("MediaLibrary: import() rejects a duplicate title, case-insensitively and whitespace-insensitively", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const first = join(sourceDir, "a.png")
    const second = join(sourceDir, "b.png")
    await writeFile(first, fakeMediaBytes(first))
    await writeFile(second, fakeMediaBytes(second))

    const library = new MediaLibrary({ mediaDir })
    await library.import(first, "Welcome Slide", "image")

    await assert.rejects(() => library.import(second, "welcome   slide", "image"))
  })
})

// Regression coverage for the audit finding: an empty/whitespace-only
// title normalizes to "", and "".includes("") is always true, so
// MediaCueDetector's substring check would fire on every single
// transcript for the rest of the service.
test("MediaLibrary: import() rejects an empty or whitespace-only title", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const library = new MediaLibrary({ mediaDir })

    const empty = join(sourceDir, "a.png")
    await writeFile(empty, fakeMediaBytes(empty))
    await assert.rejects(() => library.import(empty, "", "image"))

    const whitespace = join(sourceDir, "b.png")
    await writeFile(whitespace, fakeMediaBytes(whitespace))
    await assert.rejects(() => library.import(whitespace, "   ", "image"))
  })
})

test("MediaLibrary: findByTitle() matches case-insensitively and returns null for no match", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "a.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const library = new MediaLibrary({ mediaDir })
    const cue = await library.import(sourcePath, "Welcome Slide", "image")

    assert.deepEqual(library.findByTitle("WELCOME SLIDE"), cue)
    assert.deepEqual(library.findByTitle("  welcome slide  "), cue)
    assert.equal(library.findByTitle("Something Else"), null)
  })
})

test("MediaLibrary: list() returns every imported cue", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const first = join(sourceDir, "a.png")
    const second = join(sourceDir, "b.mp3")
    await writeFile(first, fakeMediaBytes(first))
    await writeFile(second, fakeMediaBytes(second))

    const library = new MediaLibrary({ mediaDir })
    const cueA = await library.import(first, "Slide A", "image")
    const cueB = await library.import(second, "Song B", "audio")

    assert.deepEqual(
      library.list().map((c) => c.id).sort(),
      [cueA.id, cueB.id].sort()
    )
  })
})

// Regression coverage for the production bug found post-launch: imported
// cues were held in memory only, so every app restart silently lost them
// even though the copied media files themselves remained on disk.
test("MediaLibrary: a cue imported by one instance is visible to a fresh instance after load() — survives a restart", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "welcome.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const firstInstance = new MediaLibrary({ mediaDir })
    await firstInstance.load() // no metadata file yet — must be a no-op, not a throw
    const cue = await firstInstance.import(sourcePath, "Welcome Slide", "image")

    // A brand-new instance, simulating the app restarting — nothing
    // carries over except what's on disk.
    const secondInstance = new MediaLibrary({ mediaDir })
    assert.equal(secondInstance.resolve(cue.id), null, "before load(), a fresh instance has nothing")

    await secondInstance.load()
    assert.deepEqual(secondInstance.resolve(cue.id), cue)
    assert.deepEqual(secondInstance.list(), [cue])
    assert.equal(secondInstance.resolveFilePath(cue.id), firstInstance.resolveFilePath(cue.id))
  })
})

test("MediaLibrary: load() with no metadata file yet is a no-op, not an error (first run)", async () => {
  await withTempDirs(async (_sourceDir, mediaDir) => {
    const library = new MediaLibrary({ mediaDir })
    await assert.doesNotReject(() => library.load())
    assert.deepEqual(library.list(), [])
  })
})

test("MediaLibrary: load() with a corrupt metadata file does not throw — starts as an empty library instead", async () => {
  await withTempDirs(async (_sourceDir, mediaDir) => {
    await mkdir(mediaDir, { recursive: true })
    await writeFile(join(mediaDir, "media-cues.json"), "{ not valid json", "utf8")

    const library = new MediaLibrary({ mediaDir })
    await assert.doesNotReject(() => library.load())
    assert.deepEqual(library.list(), [])
  })
})

test("MediaLibrary: multiple imports across restarts all survive — persistence isn't a one-shot overwrite", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const first = join(sourceDir, "a.png")
    const second = join(sourceDir, "b.png")
    await writeFile(first, fakeMediaBytes(first))
    await writeFile(second, fakeMediaBytes(second))

    const instance1 = new MediaLibrary({ mediaDir })
    const cueA = await instance1.import(first, "Slide A", "image")

    const instance2 = new MediaLibrary({ mediaDir })
    await instance2.load()
    const cueB = await instance2.import(second, "Slide B", "image")

    const instance3 = new MediaLibrary({ mediaDir })
    await instance3.load()
    assert.deepEqual(
      instance3.list().map((c) => c.id).sort(),
      [cueA.id, cueB.id].sort()
    )
  })
})

// ARCHITECTURE.md production audit (section 74): an operator who
// imported the wrong file, or typo'd a title, had no fix short of
// restarting and hoping the mistake didn't survive. rename()/remove()
// let it be corrected directly.

test("MediaLibrary: rename() updates the title and persists it across a restart", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "welcome.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const library = new MediaLibrary({ mediaDir })
    const cue = await library.import(sourcePath, "Welcom Slied", "image")

    const renamed = await library.rename(cue.id, "Welcome Slide")
    assert.equal(renamed.id, cue.id)
    assert.equal(renamed.title, "Welcome Slide")
    assert.equal(library.resolve(cue.id)?.title, "Welcome Slide")

    const reloaded = new MediaLibrary({ mediaDir })
    await reloaded.load()
    assert.equal(reloaded.resolve(cue.id)?.title, "Welcome Slide")
  })
})

test("MediaLibrary: rename() rejects an empty title or a title colliding with a different cue", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const a = join(sourceDir, "a.png")
    const b = join(sourceDir, "b.png")
    await writeFile(a, fakeMediaBytes(a))
    await writeFile(b, fakeMediaBytes(b))

    const library = new MediaLibrary({ mediaDir })
    const cueA = await library.import(a, "Slide A", "image")
    const cueB = await library.import(b, "Slide B", "image")

    await assert.rejects(() => library.rename(cueA.id, "   "))
    await assert.rejects(() => library.rename(cueA.id, "slide b")) // case-insensitive collision with cueB
    // Renaming to its own current title (a no-op edit) must NOT be
    // rejected as colliding with "itself".
    const unchanged = await library.rename(cueB.id, "Slide B")
    assert.equal(unchanged.title, "Slide B")
  })
})

test("MediaLibrary: rename() throws for an unknown id", async () => {
  await withTempDirs(async (_sourceDir, mediaDir) => {
    const library = new MediaLibrary({ mediaDir })
    await assert.rejects(() => library.rename("unknown-id", "New Title"))
  })
})

test("MediaLibrary: remove() deletes the stored file and the metadata, and survives a restart", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "welcome.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const library = new MediaLibrary({ mediaDir })
    const cue = await library.import(sourcePath, "Welcome Slide", "image")
    const storedPath = library.resolveFilePath(cue.id) as string

    const removed = await library.remove(cue.id)
    assert.equal(removed, true)
    assert.equal(library.resolve(cue.id), null)
    await assert.rejects(() => stat(storedPath)) // the copied file is actually gone, not just the metadata entry

    const reloaded = new MediaLibrary({ mediaDir })
    await reloaded.load()
    assert.equal(reloaded.resolve(cue.id), null)
  })
})

test("MediaLibrary: remove() with an unknown id is a no-op that returns false, not an error", async () => {
  await withTempDirs(async (_sourceDir, mediaDir) => {
    const library = new MediaLibrary({ mediaDir })
    assert.equal(await library.remove("unknown-id"), false)
  })

})

test("MediaLibrary: per-media auto-clear duration persists across restart and can be cleared", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "timer.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))
    const first = new MediaLibrary({ mediaDir })
    const cue = await first.import(sourcePath, "Timed Slide", "image")
    const updated = await first.setAutoClearDuration(cue.id, 120000)
    assert.equal(updated.autoClearMs, 120000)

    const restarted = new MediaLibrary({ mediaDir })
    await restarted.load()
    assert.equal(restarted.resolve(cue.id)?.autoClearMs, 120000)
    const cleared = await restarted.setAutoClearDuration(cue.id, null)
    assert.equal(cleared.autoClearMs, null)
  })
})

// ---- Hardening (ARCHITECTURE.md section 112) ------------------------------

function isImportError(code: string) {
  return (err: unknown) => err instanceof MediaImportError && err.code === code
}

test("MediaLibrary: import() rejects a file whose content does not match its extension", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "slide.png")
    await writeFile(sourcePath, "MZ this is really an executable")

    const library = new MediaLibrary({ mediaDir })
    await assert.rejects(() => library.import(sourcePath, "Slide", "image"), isImportError("content-mismatch"))
    assert.deepEqual(library.list(), [])
  })
})

test("MediaLibrary: import() rejects an empty file, a directory, and a missing file", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const empty = join(sourceDir, "empty.png")
    await writeFile(empty, "")
    const folder = join(sourceDir, "folder.png")
    await mkdir(folder)

    const library = new MediaLibrary({ mediaDir })
    await assert.rejects(() => library.import(empty, "Empty", "image"), isImportError("empty-file"))
    await assert.rejects(() => library.import(folder, "Folder", "image"), isImportError("not-a-file"))
    await assert.rejects(() => library.import(join(sourceDir, "gone.png"), "Gone", "image"), isImportError("not-a-file"))
  })
})

test("MediaLibrary: import() rejects an overlong title and stores the title trimmed", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "a.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))

    const library = new MediaLibrary({ mediaDir })
    await assert.rejects(() => library.import(sourcePath, "x".repeat(121), "image"), isImportError("title-too-long"))
    const cue = await library.import(sourcePath, "  Welcome  ", "image")
    assert.equal(cue.title, "Welcome")
  })
})

test("MediaLibrary: two concurrent imports with the same title cannot both succeed", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const first = join(sourceDir, "first.png")
    const second = join(sourceDir, "second.png")
    await writeFile(first, fakeMediaBytes(first))
    await writeFile(second, fakeMediaBytes(second))

    const library = new MediaLibrary({ mediaDir })
    const results = await Promise.allSettled([
      library.import(first, "Welcome", "image"),
      library.import(second, "welcome", "image"),
    ])
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
    assert.equal(library.list().length, 1)

    const reloaded = new MediaLibrary({ mediaDir })
    await reloaded.load()
    assert.equal(reloaded.list().length, 1)
  })
})

test("MediaLibrary: many concurrent imports all persist, with no lost writes or temp debris", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const library = new MediaLibrary({ mediaDir })
    const imports = []
    for (let i = 0; i < 12; i++) {
      const path = join(sourceDir, `slide-${i}.jpg`)
      await writeFile(path, fakeMediaBytes(path))
      imports.push(library.import(path, `Slide ${i}`, "image"))
    }
    await Promise.all(imports)

    const reloaded = new MediaLibrary({ mediaDir })
    const report = await reloaded.load()
    assert.equal(report.loaded, 12)
    const leftovers = (await readdir(mediaDir)).filter((f) => f.endsWith(".tmp"))
    assert.deepEqual(leftovers, [])
  })
})

test("MediaLibrary: load() quarantines a corrupt metadata file so a later import cannot overwrite it", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    await mkdir(mediaDir, { recursive: true })
    await writeFile(join(mediaDir, "media-cues.json"), "{ not valid json", "utf8")

    const library = new MediaLibrary({ mediaDir })
    const report = await library.load()
    assert.ok(report.quarantinedPath)
    assert.equal(await readFile(report.quarantinedPath as string, "utf8"), "{ not valid json")

    const sourcePath = join(sourceDir, "a.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))
    await library.import(sourcePath, "Fresh", "image")
    assert.equal(await readFile(report.quarantinedPath as string, "utf8"), "{ not valid json")
  })
})

test("MediaLibrary: load() drops entries whose stored filename could escape the media directory", async () => {
  await withTempDirs(async (_sourceDir, mediaDir) => {
    await mkdir(mediaDir, { recursive: true })
    const goodId = "01J9ZK8B1Q5V6W7X8Y9Z0A1B2C"
    const entries = [
      { id: goodId, kind: "image", title: "Good", storedFilename: goodId + ".png" },
      { id: "01J9ZK8B1Q5V6W7X8Y9Z0A1B2D", kind: "image", title: "Traversal", storedFilename: "..\\..\\secrets.png" },
      { id: "01J9ZK8B1Q5V6W7X8Y9Z0A1B2E", kind: "image", title: "Wrong ext", storedFilename: "01J9ZK8B1Q5V6W7X8Y9Z0A1B2E.exe" },
      { id: "../escape", kind: "image", title: "Bad id", storedFilename: "../escape.png" },
      { id: goodId, kind: "image", title: "Duplicate id", storedFilename: goodId + ".png" },
    ]
    await writeFile(join(mediaDir, "media-cues.json"), JSON.stringify(entries), "utf8")

    const library = new MediaLibrary({ mediaDir })
    const report = await library.load()
    assert.deepEqual(report, { loaded: 1, skipped: 4, quarantinedPath: null })
    assert.deepEqual(library.list().map((c) => c.title), ["Good"])
    assert.equal(library.resolveFilePath("01J9ZK8B1Q5V6W7X8Y9Z0A1B2D"), null)
  })
})

test("MediaLibrary: a failed metadata write rolls the import back and deletes the copied file", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "a.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))
    const library = new MediaLibrary({ mediaDir })
    await library.import(sourcePath, "First", "image")

    // Replace the metadata file with a non-empty directory: the atomic
    // rename over it fails on every platform.
    await rm(join(mediaDir, "media-cues.json"))
    await mkdir(join(mediaDir, "media-cues.json"))
    await writeFile(join(mediaDir, "media-cues.json", "blocker"), "x")

    const second = join(sourceDir, "b.png")
    await writeFile(second, fakeMediaBytes(second))
    await assert.rejects(() => library.import(second, "Second", "image"))
    assert.deepEqual(library.list().map((c) => c.title), ["First"])
    const files = await readdir(mediaDir)
    assert.equal(files.filter((f) => f.endsWith(".png")).length, 1)
    assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0)
  })
})

test("MediaLibrary: a failed metadata write leaves a removed cue in place, file included", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "a.png")
    await writeFile(sourcePath, fakeMediaBytes(sourcePath))
    const library = new MediaLibrary({ mediaDir })
    const cue = await library.import(sourcePath, "Keep", "image")

    await rm(join(mediaDir, "media-cues.json"))
    await mkdir(join(mediaDir, "media-cues.json"))
    await writeFile(join(mediaDir, "media-cues.json", "blocker"), "x")

    await assert.rejects(() => library.remove(cue.id))
    assert.ok(library.resolve(cue.id))
    await assert.doesNotReject(() => stat(library.resolveFilePath(cue.id) as string))
  })
})

test("isTitleErrorCode: only title problems are retryable by editing the title", () => {
  for (const code of ["empty-title", "title-too-long", "duplicate-title"] as const) assert.equal(isTitleErrorCode(code), true, code)
  for (const code of ["unsupported-type", "not-a-file", "empty-file", "too-large", "content-mismatch", "unknown-cue"] as const) {
    assert.equal(isTitleErrorCode(code), false, code)
  }
})

test("MediaLibrary: after a duplicate-title rejection the same file imports under a new title", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const first = join(sourceDir, "a.png")
    const second = join(sourceDir, "b.png")
    await writeFile(first, fakeMediaBytes(first))
    await writeFile(second, fakeMediaBytes(second))
    const library = new MediaLibrary({ mediaDir })
    await library.import(first, "Welcome", "image")
    await assert.rejects(() => library.import(second, "Welcome", "image"), isImportError("duplicate-title"))
    const cue = await library.import(second, "Welcome 2", "image")
    assert.equal(cue.title, "Welcome 2")
    assert.equal(library.list().length, 2)
  })
})
