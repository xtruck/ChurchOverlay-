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

    const filesInMediaDir = await readdir(mediaDir)
    assert.equal(filesInMediaDir.length, 1)
    assert.ok(filesInMediaDir[0]?.startsWith(cue.id))
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
