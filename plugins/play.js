let fs = require('fs')
let path = require('path')
let { execFile } = require('child_process')
let { scrapeVidsSave } = require('../vidssave-plugin')
let { downloadVia } = require('../lib/vidsaveFetch')
let sharp = require('sharp')
let { execFile: execFileCb } = require('child_process')

// VidsSave menyajikan audio sebagai WebM/Opus atau M4A, BUKAN mp3. Kalau buffer
// mentahnya ditulis dengan ekstensi .mp3, WhatsApp bisa menolak atau memutar
// durasi salah. Konversi dulu lewat ffmpeg supaya benar-benar mp3.
function toMp3(buffer, outBase) {
  let raw = outBase + '.raw'
  let mp3 = outBase + '.mp3'
  fs.writeFileSync(raw, buffer)
  return new Promise((resolve, reject) => {
    execFileCb(
      'ffmpeg',
      ['-y', '-i', raw, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3', mp3],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(raw) } catch {}
        if (err) return reject(new Error('ffmpeg: ' + ((stderr || '').trim().split('\n').pop() || err.message)))
        if (!fs.existsSync(mp3) || !fs.statSync(mp3).size) return reject(new Error('konversi mp3 gagal'))
        resolve(mp3)
      }
    )
  })
}

let TMP = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

// Search pakai API alfisy (YTS Search). Ini satu-satunya jalur yang jalan dari
// IP datacenter: yt-dlp kena "Sign in to confirm you're not a bot" di semua
// player_client, jadi ytsearch dibuang.
let SEARCH_API = 'https://alsya.svazer.eu.cc/api/search/yts'
let SEARCH_TIMEOUT_MS = 25_000

// Download audio lewat VidsSave (scraper di vidssave-plugin.js).
// CATATAN: VidsSave nolak IP datacenter dengan status_code 'analyze_risk'
// (lihat FIX_LOG). Dari Termux/IP residential lolos. Kalau kena analyze_risk,
// tidak ada retry yang menolong - pesan errornya harus jelas ke user.
let UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// yt-dlp: JANGAN andalkan lookup PATH. Di pm2, PATH bisa tidak memuat
// ~/.bun/bin (dan file di home hilang tiap VM restart), jadi `execFile('yt-dlp')`
// gagal dengan `spawn yt-dlp ENOENT`. Cari path absolut dulu, baru PATH.
function resolveYtDlp() {
  let home = process.env.HOME || '/data/.hermes/home'
  let candidates = [
    '/home/hatch/bin/yt-dlp',
    path.join(home, '.bun/bin/yt-dlp'),
    path.join(home, '.local/bin/yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ]
  for (let c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return 'yt-dlp' // terakhir: biar PATH yang menentukan (mis. Termux)
}
let YTDLP = resolveYtDlp()

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function runYtDlp(args, timeoutSec) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutSec * 1000 },
      (err, stdout, stderr) => {
        if (err) {
          let msg = (stderr || '').trim().split('\n').filter(Boolean).pop() || err.message
          return reject(new Error(msg))
        }
        resolve(stdout)
      }
    )
  })
}

// "3:44" / "1:02:03" -> detik. API balikin string, bukan angka seperti yt-dlp.
function parseDuration(str) {
  if (typeof str === 'number') return str
  let parts = String(str || '').trim().split(':').map(Number)
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

// Cari via API alfisy, bukan yt-dlp lagi.
async function searchYoutube(query) {
  let url = `${SEARCH_API}?q=${encodeURIComponent(query)}`
  let res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`API search HTTP ${res.status}`)
  let data = await res.json()
  if (!data || data.status === false) {
    throw new Error(data?.message || 'API search menolak permintaan')
  }
  let list = Array.isArray(data.result) ? data.result : []
  let e = list[0]
  if (!e) throw new Error(`Nggak nemu "${query}".`)

  return {
    title: e.title,
    id: e.videoId,
    duration: parseDuration(e.duration),
    durationText: e.duration,        // sudah diformat API ("3:44")
    url: e.url || `https://youtu.be/${e.videoId}`,
    thumbnail: e.thumbnail,
    uploaded: e.uploaded,
    views: e.views
  }
}

// Ambil resource audio terbaik dari hasil VidsSave. Kualitas '128kbps' > '64kbps'.
function pickAudio(resources) {
  let pool = (resources || []).filter(r => /audio/i.test(r.type || '') && r.download_url)
  if (!pool.length) return null
  pool.sort((a, b) => {
    let qa = parseInt(String(a.quality || ''), 10) || 0
    let qb = parseInt(String(b.quality || ''), 10) || 0
    return qb - qa || (b.size || 0) - (a.size || 0)
  })
  return pool[0]
}

function runCurlOnce(url, outFile, timeoutSec) {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      [
        '-L', '-sS', '--fail',
        '--http1.1',          // paksa HTTP/1.1: beberapa CDN bermasalah di HTTP/2
        '-C', '-',            // RESUME: lanjutkan dari byte terakhir file yang sudah ada
        '--max-time', String(timeoutSec),
        '-A', UA,
        '-o', outFile,
        url,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || '').trim() || err.message))
        resolve()
      }
    )
  })
}

// Fallback curl dengan resume otomatis: koneksi diputus -> lanjut dari byte terakhir
async function downloadWithCurl(url, { maxAttempts = 10, timeoutSec = 90 } = {}) {
  const tmpFile = path.join(TMP, `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`)
  let lastErr = null
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runCurlOnce(url, tmpFile, timeoutSec)
        let size = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0
        if (!size) throw new Error('file kosong dari server')
        return fs.readFileSync(tmpFile)
      } catch (e) {
        lastErr = e
        // Error 33 = server tidak support range -> hapus file, mulai dari awal
        if (/range/i.test(e.message)) {
          try { fs.unlinkSync(tmpFile) } catch {}
          continue
        }
        // Koneksi diputus tapi sudah ada progres -> resume di attempt berikut
        let size = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0
        if (size > 0 && attempt < maxAttempts) {
          await sleep(400 * attempt)
          continue
        }
        throw e
      }
    }
    throw lastErr || new Error('curl: percobaan habis')
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
}

async function download(url, { retries = 3 } = {}) {
  // Jalur 1: plain fetch
  let lastErr = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error('file kosong dari server')
      return buf
    } catch (e) {
      lastErr = e
      if (attempt < retries) await sleep(700 * attempt)
    }
  }

  // Jalur 2: curl resume (pengaman kalau fetch kena "terminated")
  try {
    return await downloadWithCurl(url)
  } catch (e) {
    throw new Error(lastErr ? `${lastErr.message} | ${e.message}` : e.message)
  }
}

// Download audio. Urutan: yt-dlp dulu, VidsSave+proxy sebagai cadangan.
//
// yt-dlp didahulukan karena dua alasan: (1) jauh lebih cepat - diukur ~29 MB/s
// vs 0.3-0.7 MB/s lewat proxy gratis, (2) tidak lewat relay pihak ketiga.
// Syaratnya cookie akun YouTube (lihat ~/.config/yt-dlp/config) - tanpa itu
// IP datacenter kena "Sign in to confirm you're not a bot".
async function downloadAudio(info, base) {
  let ytdlpErr = null
  try {
    await runYtDlp(
      ['-x', '--audio-format', 'mp3', '--audio-quality', '0',
       '--no-warnings', '--socket-timeout', '30', '--retries', '3',
       '-o', base + '.%(ext)s', info.url],
      300
    )
    let f = base + '.mp3'
    if (fs.existsSync(f) && fs.statSync(f).size) {
      return { file: f, via: 'yt-dlp', quality: null }
    }
    ytdlpErr = new Error('file mp3 tidak terbentuk')
  } catch (e) {
    ytdlpErr = e
  }

  // yt-dlp gagal (cookie kedaluwarsa / diblokir) -> VidsSave lewat rotasi proxy.
  let parsed
  try {
    parsed = await scrapeVidsSave(info.url)
  } catch (e) {
    parsed = { status: false, message: e.message || String(e) }
  }

  if (parsed.status) {
    let best = pickAudio(parsed.resources)
    if (best) {
      if (best.size && best.size > 60 * 1024 * 1024) {
        // Hasil pencarian teratas bisa berupa kompilasi berjam-jam (mis. "lofi
        // hip hop" -> video 6 jam, audio 380MB). Bukan error sistem: user cukup
        // diminta memakai judul yang lebih spesifik.
        throw new Error(
          `hasil teratas ${Math.round(best.size / 1024 / 1024)}MB ` +
          `(${Math.round((info.duration || 0) / 60)} menit) kegedean buat WA - ` +
          `coba judul yang lebih spesifik (tambah nama artis atau kata "official")`
        )
      }
      // Kalau parse-nya butuh proxy, CDN download-nya kemungkinan besar juga
      // memblokir IP kita -> pakai proxy yang sama. Kalau parse langsung
      // berhasil (IP residential), download langsung saja.
      let buf = parsed.viaProxy
        ? await downloadVia(best.download_url, parsed.viaProxy)
        : await download(best.download_url)
      if (!buf.length) throw new Error('file kosong dari VidsSave')
      let f = await toMp3(buf, base)
      return { file: f, via: parsed.viaProxy ? 'vidssave-proxy' : 'vidssave', quality: best.quality }
    }
  }

  // yt-dlp dan VidsSave dua-duanya gagal -> sebutkan keduanya, jangan cuma
  // yang terakhir, supaya jelas ini bukan satu jalur yang bermasalah.
  let alasan
  if (parsed.status) {
    alasan = 'VidsSave tidak menyediakan audio'
  } else if (parsed.raw?.status_code === 'analyze_risk') {
    alasan = 'VidsSave menolak semua proxy yang tersedia (analyze_risk)'
  } else {
    alasan = parsed.message || 'VidsSave gagal'
  }
  throw new Error(`yt-dlp: ${ytdlpErr?.message || 'gagal'} | ${alasan}`)
}

// Thumbnail inline WA dibatasi 64KB (INLINE_THUMBNAIL_MAX_BYTES zapo). Resize
// dulu lewat sharp biar pasti masuk, width/height di-set eksplisit seperti
// snippet Baileys. Pola ini sama dengan plugins/menu.js.
async function makeInlineThumb(buf) {
  try {
    let bytes = await sharp(buf).resize(300, 300, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()
    return { bytes, width: 1280, height: 720 }
  } catch {
    return null
  }
}

function cleanTitle(title, max = 70) {
  let t = String(title || 'tanpa judul').replace(/[|*_~`]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t
}

function fmtDuration(seconds) {
  let n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return '-'
  let m = Math.floor(n / 60), s = Math.round(n % 60)
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

module.exports = {
  name: 'play',
  description: 'Cari lagu di YouTube (API alfisy) lalu kirim info + audio (yt-dlp).',
  aliases: ['song'],
  tags: ['downloader'],
  permissions: {},
  command: /^(play|song)$/i,
  run: async (m, { conn, args, text, usedPrefix, command }) => {
    let query = args.join(' ').trim()
    if (!query) {
      return m.reply(`❌ Contoh: ${usedPrefix}${command} runtuh`)
    }

    await m.reply(`🔎 Mencari "${query}"...`)

    // 1. Cari via API alfisy
    let info
    try {
      info = await searchYoutube(query)
    } catch (e) {
      return m.reply('❌ Gagal searching: ' + (e.message || e))
    }

    await m.reply('⏳ Ambil audio...')

    let title = cleanTitle(info.title)
    let files = []
    // URL TIDAK dimasukkan ke caption: dipasang sekali di content.text sebagai
    // anchor linkPreview. Kalau dimasukkan juga di sini, link tampil dobel.
    let caption = [
      `🎵 *${title}*`,
      `⏱️ ${fmtDuration(info.duration)}`
    ].join('\n')

    // PENTING: mulai download audio SEGERA. Jangan tunggu thumbnail terkirim dulu.
    let base = path.join(TMP, `yt_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    let audioPromise = downloadAudio(info, base)

    // 2. Info + cover sebagai link preview, pola sama dengan plugins/menu.js:
    // thumbnail di-resize sharp lalu dikirim lewat linkPreview, bukan sebagai
    // pesan image terpisah. Jadi user langsung lihat cover tanpa file ekstra.
    let thumb = null
    if (info.thumbnail) {
      try {
        let buf = await download(info.thumbnail)
        thumb = await makeInlineThumb(buf)
      } catch (e) {
        console.error('Thumbnail gagal:', e.message || e)
      }
    }

    // Tanpa thumbnail tidak ada linkPreview, jadi URL ditaruh di akhir caption
    // supaya info link tetap ada — tetap hanya sekali.
    let content = { type: 'text', text: `${caption}\n\n${info.url}` }
    if (thumb) {
      // URL di awal teks + zero-width space: link tetap ter-render tapi tidak
      // terlihat sebagai URL. matchedText wajib ada di dalam teks.
      const invisible = '\u200B'.repeat(400)
      // Newline setelah URL supaya judul tidak menempel ke link.
      content.text = `${info.url}\n${invisible}${caption}`
      content.linkPreview = {
        matchedText: info.url,
        title,
        description: `${fmtDuration(info.duration)} • YouTube`,
        thumbnail: { bytes: new Uint8Array(thumb.bytes), width: thumb.width, height: thumb.height }
      }
    }
    await conn.message.send(m.chat, content, { quote: m })

    // 3. Tunggu audio yang sudah mulai didownload sejak tadi
    try {
      let hasil = await audioPromise
      files.push(hasil.file)
      await conn.message.send(m.chat, {
        type: 'audio',
        media: hasil.file,
        mimetype: 'audio/mpeg',
        fileName: `${cleanTitle(info.title, 50)}.mp3`,
        ptt: false
      }, { quote: m })
    } catch (e) {
      return m.reply('❌ Gagal download: ' + (e.message || e))
    } finally {
      for (let f of files) {
        try { fs.unlinkSync(f) } catch {}
      }
    }
  }
}
