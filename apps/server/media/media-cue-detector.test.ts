import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MediaLibrary } from "./media-library"
import { MediaCueDetector } from "./media-cue-detector"

async function withLibrary(fn: (library: MediaLibrary, sourceDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "churchoverlay-media-detector-test-"))
  try {
    const library = new MediaLibrary({ mediaDir: join(root, "media") })
    await fn(library, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("MediaCueDetector: matches a spoken exact title, case-insensitively", async () => {
  await withLibrary(async (library, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    const cue = await library.import(source, "Welcome Slide", "image")

    const detector = new MediaCueDetector(library)
    const result = detector.detect("Let's put up the WELCOME SLIDE now.")
    assert.deepEqual(result, [cue])
  })
})

test("MediaCueDetector: a close-but-not-exact phrase does not trigger", async () => {
  await withLibrary(async (library, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    await library.import(source, "Welcome Slide", "image")

    const detector = new MediaCueDetector(library)
    assert.deepEqual(detector.detect("Let's welcome everyone to the slide show."), [])
  })
})

test("MediaCueDetector: matches multiple whitespace-normalized correctly", async () => {
  await withLibrary(async (library, dir) => {
    const source = join(dir, "welcome.png")
    await writeFile(source, "x")
    const cue = await library.import(source, "Welcome   Slide", "image")

    const detector = new MediaCueDetector(library)
    assert.deepEqual(detector.detect("Show the welcome slide please."), [cue])
  })
})

test("MediaCueDetector: returns no matches when no cues are imported", async () => {
  await withLibrary(async (library) => {
    const detector = new MediaCueDetector(library)
    assert.deepEqual(detector.detect("Show the welcome slide."), [])
  })
})

test("MediaCueDetector: matches every cue whose title appears in the transcript", async () => {
  await withLibrary(async (library, dir) => {
    const sourceA = join(dir, "a.png")
    const sourceB = join(dir, "b.mp3")
    await writeFile(sourceA, "a")
    await writeFile(sourceB, "b")
    const cueA = await library.import(sourceA, "Offering Slide", "image")
    const cueB = await library.import(sourceB, "Closing Song", "audio")

    const detector = new MediaCueDetector(library)
    const result = detector.detect("Play the closing song after the offering slide.")
    assert.deepEqual(
      result.map((c) => c.id).sort(),
      [cueA.id, cueB.id].sort()
    )
  })
})

test("MediaCueDetector: reflects newly-imported cues on the next detect() call (live, not a snapshot)", async () => {
  await withLibrary(async (library, dir) => {
    const detector = new MediaCueDetector(library)
    assert.deepEqual(detector.detect("Show the baptism video."), [])

    const source = join(dir, "baptism.mp4")
    await writeFile(source, "x")
    const cue = await library.import(source, "Baptism Video", "video")

    assert.deepEqual(detector.detect("Show the baptism video."), [cue])
  })
})
