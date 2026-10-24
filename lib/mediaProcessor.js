let sharp

try { sharp = require('sharp') } catch { sharp = null }

async function generateImageThumbnail(input, maxEdge) {
  if (!sharp) return null
  let buffer = await readInput(input)
  let pipeline = sharp(buffer).rotate().resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
  let meta = await pipeline.metadata().catch(() => ({}))
  let jpegThumbnail = await pipeline.jpeg({ quality: 75 }).toBuffer()
  return {
    jpegThumbnail: new Uint8Array(jpegThumbnail),
    width: meta.width || 0,
    height: meta.height || 0
  }
}

// Batas ffmpeg paralel. Tiap ffmpeg spawn banyak thread; di container dengan
// cpu.max=2, 4 proses paralel bikin stalling (proses nge-spin tanpa keluar).
// Antre aja biar nggak rebut CPU.
const MAX_FFMPEG_CONCURRENT = 2
let ffmpegQueue = 0
let ffmpegWaiters = []

function acquireFfmpegSlot() {
  return new Promise(resolve => {
    if (ffmpegQueue < MAX_FFMPEG_CONCURRENT) {
      ffmpegQueue++
      return resolve(releaseFfmpegSlot)
    }
    ffmpegWaiters.push(() => {
      ffmpegQueue++
      resolve(releaseFfmpegSlot)
    })
  })
}

function releaseFfmpegSlot() {
  ffmpegQueue--
  let next = ffmpegWaiters.shift()
  if (next) next()
}

async function readInput(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (typeof input === 'string') {
    let fs = require('fs')
    return fs.promises.readFile(input)
  }
  // stream
  let chunks = []
  for await (let c of input) chunks.push(c)
  return Buffer.concat(chunks)
}

// Download media pesan + ambil Buffer-nya. Timeout default zapo 30s terlalu
// pendek di koneksi lambat (sticker/video sering "transfer timed out") — naikkan.
async function downloadMedia(message, { timeoutMs = 120000 } = {}) {
  let { downloadMediaMessage } = require('zapo-js')
  let stream = await downloadMediaMessage(message, { downloadNativeClock: false, timeoutMs })
  if (!stream) return null
  return readInput(stream)
}

module.exports = {
  generateImageThumbnail,
  readInput,
  downloadMedia,
  acquireFfmpegSlot
}
