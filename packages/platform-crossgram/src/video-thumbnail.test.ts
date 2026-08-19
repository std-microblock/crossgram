import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { extractVideoThumbnail } from './client.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true, force: true,
  })))
})

describe('outbound QQ video thumbnails', () => {
  it('extracts and letterboxes the first MP4 frame as a 320x180 JPEG', async () => {
    try {
      await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'])
    } catch {
      return
    }
    const directory = await mkdtemp(join(tmpdir(), 'crossgram-video-thumbnail-'))
    temporaryDirectories.push(directory)
    const videoPath = join(directory, 'source.mp4')
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=0.2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath,
    ])
    const size = (await stat(videoPath)).size
    let streams = 0

    const thumbnail = await extractVideoThumbnail({
      size,
      stream() {
        streams++
        return createReadStream(videoPath)
      },
    })
    const metadata = await sharp(thumbnail.bytes).metadata()

    expect(streams).toBe(1)
    expect(thumbnail).toMatchObject({ width: 320, height: 180 })
    expect(metadata).toMatchObject({ format: 'jpeg', width: 320, height: 180 })
  })
})
