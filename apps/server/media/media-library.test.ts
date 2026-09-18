import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
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
