import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MediaLibrary } from "./media-library"
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
    await writeFile(sourcePath, "fake png bytes")

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
    await writeFile(sourcePath, "fake mp4 bytes")

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
    await writeFile(sourcePath, "not actually an image")

    const library = new MediaLibrary({ mediaDir })
    await assert.rejects(() => library.import(sourcePath, "Sketchy File", "image"))
  })
})

test("MediaLibrary: import() rejects a duplicate title, case-insensitively and whitespace-insensitively", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const first = join(sourceDir, "a.png")
    const second = join(sourceDir, "b.png")
    await writeFile(first, "a")
    await writeFile(second, "b")

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
    await writeFile(empty, "a")
    await assert.rejects(() => library.import(empty, "", "image"))

    const whitespace = join(sourceDir, "b.png")
    await writeFile(whitespace, "b")
    await assert.rejects(() => library.import(whitespace, "   ", "image"))
  })
})

test("MediaLibrary: findByTitle() matches case-insensitively and returns null for no match", async () => {
  await withTempDirs(async (sourceDir, mediaDir) => {
    const sourcePath = join(sourceDir, "a.png")
    await writeFile(sourcePath, "a")

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
    await writeFile(first, "a")
    await writeFile(second, "b")

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
    await writeFile(sourcePath, "fake png bytes")

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
    await writeFile(first, "a")
    await writeFile(second, "b")

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
    await writeFile(sourcePath, "x")

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
    await writeFile(a, "a")
    await writeFile(b, "b")

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
    await writeFile(sourcePath, "x")

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
    await writeFile(sourcePath, "fake png bytes")
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
