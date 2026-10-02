import { extname } from "node:path"

/**
 * Test-only: the smallest bytes that pass MediaLibrary's content check for
 * a given file path's extension (see media-signature.ts). Not a playable
 * file. Unknown extensions get plain text, which no check accepts.
 */
export function fakeMediaBytes(filePath: string): Buffer {
  const pad = Buffer.alloc(32, 0)
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad])
    case ".jpg":
    case ".jpeg":
      return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])
    case ".webp":
      return Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), pad])
    case ".wav":
      return Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"), pad])
    case ".mp4":
    case ".m4a":
      return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), pad])
    case ".webm":
      return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), pad])
    case ".mp3":
      return Buffer.concat([Buffer.from("ID3\x04\0\0", "latin1"), pad])
    default:
      return Buffer.from("not a media file")
  }
}
