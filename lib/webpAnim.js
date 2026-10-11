// WebP animasi → MP4 via ezgif.com API (bypass local ffmpeg thread limit).
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

function extractFrames(webpBuffer) {
  // Bukan RIFF/WEBP (mis. PNG hasil /image) → bukan animasi
  if (webpBuffer.slice(0, 4).toString('latin1') !== 'RIFF' ||
      webpBuffer.slice(8, 12).toString('latin1') !== 'WEBP') return null

  const { Image } = require('node-webpmux')
  let img = new Image()
  try {
    img.loadSync(webpBuffer)
  } catch (e) {
    return null
  }
  if (!img.frames?.length) return null
  return img.frames.map(f => ({ vp8: f.vp8?.raw, delay: f.delay || 100 }))
}

/**
 * WebP animasi → MP4 via ezgif.com/webp-to-mp4 API.
 * Bypass local FFmpeg cgroup pids.limit (Resource temporarily unavailable).
 * Returns **buffer**, not URL.
 */
async function webpAnimToMp4(webpBuffer) {
  const form = new FormData()
  const blob = new Blob([webpBuffer])
  form.append('new-image', blob, 'image.webp')
  
  const res = await fetch('https://ezgif.com/webp-to-mp4', {
    method: 'POST',
    body: form
  })
  const html = await res.text()
  const { document } = new JSDOM(html).window
  
  const form2 = new FormData()
  const obj = {}
  for (let input of document.querySelectorAll('form input[name]')) {
    obj[input.name] = input.value
    form2.append(input.name, input.value)
  }
  
  const res2 = await fetch('https://ezgif.com/webp-to-mp4/' + obj.file, {
    method: 'POST',
    body: form2
  })
  const html2 = await res2.text()
  const { document: document2 } = new JSDOM(html2).window
  const url = document2.querySelector('div#output > p.outfile > video > source')?.src
  if (!url) throw new Error('No output URL from ezgif')
  const mp4Url = new URL(url, res2.url).toString()
  
  // Download MP4 → buffer
  const res3 = await fetch(mp4Url)
  if (!res3.ok) throw new Error('Failed to download MP4: ' + res3.status)
  const arrayBuffer = await res3.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

module.exports = { extractFrames, webpAnimToMp4 }

// --- self-check ---
if (require.main === module) {
  ;(async () => {
    try {
      const buf = fs.readFileSync(process.argv[2] || '/tmp/t2.webp')
      const frames = extractFrames(buf)
      console.log('frames:', frames?.length || 0)
      if (frames && frames.length > 0) {
        for (let i = 0; i < frames.length; i++) {
          console.log(`  f${i}: ${frames[i].vp8?.length || 0} bytes, delay ${frames[i].delay}ms`)
        }
        // Test conversion
        const mp4Url = await webpAnimToMp4(buf)
        console.log('MP4 URL:', mp4Url)
      }
    } catch (e) {
      console.error('Test failed:', e.message)
    }
  })()
}
