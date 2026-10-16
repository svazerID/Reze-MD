// Plugin tes VidsSave (vidssave.com) — kandidat backend downloader YouTube/TikTok.
// Cara pakai: !vidssave <url>  → video terbaik (dengan audio)
//             !vidssave audio <url>  → audio terbaik (mp3)
// Dibuat sebagai versi plugin dari scraper TS user (2026-10-13): request API-nya
// dari container kena analyze_risk (IP datacenter di-flag), jadi tes penentunya
// harus dari IP residential (Termux / HP). Plugin ini yang dipakai buat tes itu.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const AES_KEYS = [
  '4c9b7d2e'.repeat(3) + '4c9b7d21',
  'rz18efAXUbdiaO7k',
]

function decryptVidsSavePayload(cipherTextBase64) {
  const cipherBuffer = Buffer.from(String(cipherTextBase64).trim(), 'base64')
  for (const k of AES_KEYS) {
    const keyBuf = Buffer.from(k, 'utf8')
    const ivBuf = Buffer.from(k.slice(0, 16), 'utf8')
    try {
      const algorithm = keyBuf.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc'
      const decipher = crypto.createDecipheriv(algorithm, keyBuf, ivBuf)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(cipherBuffer), decipher.final()])
      return JSON.parse(decrypted.toString('utf8').replace(/\0+$/, ''))
    } catch {}
  }
  throw new Error('gagal decrypt payload AES VidsSave')
}

function formatSize(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0, val = bytes
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++ }
  return `${val.toFixed(2)} ${units[i]}`
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00'
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function qScore(q) { // '720p' -> 720, '128kbps' -> 128
  const n = parseInt(String(q || ''), 10)
  return isNaN(n) ? 0 : n
}

async function scrapeVidsSave(mediaUrl) {
  const payload = new URLSearchParams({
    hostname: 'vidssave.com',
    auth: '4c9b7d21',
    domain: 'api-ak.vidssave.com',
    origin: 'cache',
    link: mediaUrl,
  }).toString()
  const res = await fetch('https://api.vidssave.com/api/contentsite_api/media/parse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Origin: 'https://vidssave.com',
      Referer: 'https://vidssave.com/',
      Accept: 'application/json, text/plain, */*',
    },
    body: payload,
    signal: AbortSignal.timeout(25000),
  })
  const data = await res.json()
  if (!data || data.status !== 1) {
    return { status: false, message: data?.error_msg || data?.msg || data?.status_code || 'gagal memproses media', raw: data }
  }
  let parsed = data.data
  if (typeof parsed === 'string') parsed = decryptVidsSavePayload(parsed)
  const resources = (parsed.resources || []).map((r) => ({
    resource_id: r.resource_id,
    quality: r.quality,
    format: r.format,
    type: r.type,
    size: r.size,
    download_url: r.direct_download_url || r.download_url,
    has_audio: r.has_audio ?? (r.type === 'video' ? true : undefined),
  }))
  return {
    status: true,
    title: parsed.title,
    thumbnail: parsed.thumbnail,
    duration: parsed.duration,
    resources,
    raw: parsed,
  }
}

module.exports = {
  name: 'vidssave',
  description: 'Tes downloader VidsSave (YouTube/TikTok/dll).',
  aliases: ['vs', 'vsdl'],
  tags: ['downloader'],
  permissions: {},
  command: /^(vidssave|vs|vsdl)$/i,
  run: async (m, { conn, args, usedPrefix, command }) => {
    const url = args.find((a) => /^https?:\/\//i.test(a))
    if (!url) return m.reply(`Contoh: ${usedPrefix}${command} https://youtube.com/shorts/xxxx\nAudio: ${usedPrefix}${command} audio <url>`)
    const wantAudio = args.some((a) => /^(audio|mp3|a)$/i.test(a))

    await m.reply('⏳ Ngetes VidsSave...')
    let res
    try {
      res = await scrapeVidsSave(url)
    } catch (e) {
      return m.reply('❌ Error request: ' + (e.message || e))
    }
    if (!res.status) {
      // hasil tes yang penting: lolos analyze_risk atau tidak dari IP ini
      return m.reply(`❌ VidsSave nolak: ${res.message}\n_(raw: ${JSON.stringify(res.raw).substring(0, 300)})_`)
    }

    const pool = res.resources.filter((r) => wantAudio
      ? /audio/i.test(r.type || '')
      : /video/i.test(r.type || ''))
    if (!pool.length) {
      const daftar = res.resources.map((r) => `• ${r.quality} ${r.format} (${r.type}, ${formatSize(r.size)})`).join('\n')
      return m.reply(`⚠️ Nggak ada ${wantAudio ? 'audio' : 'video'} di hasil.\n\n📝 ${(res.title || '-').substring(0, 150)}\n${daftar}`)
    }
    pool.sort((a, b) => {
      if (!wantAudio && (a.has_audio !== b.has_audio)) return (b.has_audio ? 1 : 0) - (a.has_audio ? 1 : 0)
      return qScore(b.quality) - qScore(a.quality) || (b.size || 0) - (a.size || 0)
    })
    const best = pool[0]
    if (!best.download_url) return m.reply('❌ Hasil ada tapi nggak ada download_url.')

    const caption = [
      `*📥 VidsSave ${wantAudio ? 'Audio' : 'Video'}*`,
      ``,
      `📝 ${(res.title || '-').substring(0, 200)}`,
      `⏱️ ${formatDuration(res.duration)}`,
      `🎞️ ${best.quality || '-'} ${best.format || ''} • ${formatSize(best.size)}`,
    ].join('\n')
    await m.reply(caption + '\n\n⏳ Download filenya...')

    try {
      if (best.size > 150 * 1024 * 1024) {
        return m.reply(`⚠️ File ${formatSize(best.size)} kegedean buat dikirim via WA, coba mode audio.`)
      }
      const dl = await fetch(best.download_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', Referer: 'https://vidssave.com/' },
        signal: AbortSignal.timeout(120000),
      })
      if (!dl.ok) throw new Error('download gagal: HTTP ' + dl.status)
      const tmpDir = path.join(__dirname, '..', 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      const ext = wantAudio ? 'mp3' : 'mp4'
      const tmpFile = path.join(tmpDir, `vs_${Date.now()}.${ext}`)
      fs.writeFileSync(tmpFile, Buffer.from(await dl.arrayBuffer()))
      await conn.message.send(m.chat, {
        type: wantAudio ? 'audio' : 'video',
        media: tmpFile,
        mimetype: wantAudio ? 'audio/mpeg' : 'video/mp4',
        caption: wantAudio ? undefined : caption,
      }, { quote: m })
      fs.unlinkSync(tmpFile)
    } catch (e) {
      m.reply('❌ Error kirim media: ' + (e.message || e)).catch(() => {})
    }
  }
}

// ---- CLI test mode (jalan dari Termux, IP residential): node vidssave-plugin.js <url> [audio]
if (require.main === module) {
  const url = process.argv[2]
  const wantAudio = /^(audio|mp3)$/i.test(process.argv[3] || '')
  if (!url) { console.error('Pakai: node vidssave-plugin.js <url> [audio]'); process.exit(1) }
  scrapeVidsSave(url).then((res) => {
    const slim = (res.resources || []).map((r) => ({
      quality: r.quality, format: r.format, type: r.type, size: r.size,
      has_audio: r.has_audio,
      download_url: r.download_url ? String(r.download_url).slice(0, 90) + '…' : null,
    }))
    console.log(JSON.stringify({ status: res.status, title: res.title, message: res.message, resources: slim }, null, 2))
  }).catch((e) => { console.error('FATAL:', e && e.message); process.exit(1) })
}
