let fs = require('fs')
let path = require('path')
let { execFile } = require('child_process')

let TMP = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

// yt-dlp: binary persisten di /home/hatch/bin, fallback ke PATH (mis. di Termux)
let YTDLP = fs.existsSync('/home/hatch/bin/yt-dlp') ? '/home/hatch/bin/yt-dlp' : 'yt-dlp'
// YouTube nge-block IP datacenter ("Sign in to confirm you're not a bot").
// player_client=android lolos dari bot-check, tapi cuma nyediain format 18
// (360p mp4 + audio) → audio diekstrak ke mp3 pakai ffmpeg.
let EXTRACTOR_ARGS = 'youtube:player_client=android'

// Untuk download thumbnail saja. Tanpa AbortSignal, tanpa header tambahan,
// tanpa opsi redirect — kombinasi itulah yang memicu "terminated" di undici.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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

// Cari via yt-dlp, tanpa API lagi
async function searchYoutube(query) {
  let out = await runYtDlp(
    ['ytsearch1:' + query, '--dump-single-json', '--no-playlist', '--no-warnings',
     '--socket-timeout', '25', '--retries', '3'],
    90
  )
  let data = JSON.parse(out)
  let e = (data.entries || [])[0]
  if (!e) throw new Error(`Nggak nemu "${query}".`)
  return {
    title: e.title,
    id: e.id,
    duration: e.duration,
    url: e.webpage_url,
    thumbnail: e.thumbnail
  }
}

// Download + ekstrak audio ke mp3. Hasil akhir: base.mp3
async function downloadAudio(url, base) {
  await runYtDlp(
    ['--extractor-args', EXTRACTOR_ARGS, '-f', '18',
     '-x', '--audio-format', 'mp3', '--audio-quality', '0',
     '--no-warnings', '--socket-timeout', '30', '--retries', '5',
     '-o', base + '.%(ext)s', url],
    600
  )
  let f = base + '.mp3'
  if (!fs.existsSync(f)) throw new Error('file mp3 tidak terbentuk')
  let size = fs.statSync(f).size
  if (!size) throw new Error('file kosong dari yt-dlp')
  return f
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

// Fallback curl dengan resume otomatis: koneksi diputus → lanjut dari byte terakhir
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
        // Error 33 = server tidak support range → hapus file, mulai dari awal
        if (/range/i.test(e.message)) {
          try { fs.unlinkSync(tmpFile) } catch {}
          continue
        }
        // Koneksi diputus tapi sudah ada progres → resume di attempt berikut
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
  // Jalur 1: plain fetch, IDENTIK dengan perintah fetch yang berhasil
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

  // Jalur 2: curl resume (pengaman kalau fetch tetap kena "terminated")
  try {
    return await downloadWithCurl(url)
  } catch (e) {
    throw new Error(lastErr ? `${lastErr.message} | ${e.message}` : e.message)
  }
}

function cleanTitle(title, max = 70) {
  let t = String(title || 'tanpa judul').replace(/[|*_~`]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function fmtDuration(seconds) {
  let n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return '-'
  let m = Math.floor(n / 60), s = Math.round(n % 60)
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

module.exports = {
  name: 'play',
  description: 'Cari lagu di YouTube lalu kirim thumbnail + audio (yt-dlp, tanpa API).',
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

    // 1. Cari via yt-dlp (tanpa API)
    let info
    try {
      info = await searchYoutube(query)
    } catch (e) {
      return m.reply('❌ Gagal searching: ' + (e.message || e))
    }

    await m.reply('⏳ Ambil audio...')

    let title = cleanTitle(info.title)
    let files = []
    let caption = [
      `🎵 *${title}*`,
      `⏱️ ${fmtDuration(info.duration)}`,
      '',
      info.url
    ].join('\n')

    // PENTING: mulai download audio SEGERA. Jangan tunggu thumbnail terkirim dulu.
    let base = path.join(TMP, `yt_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    let audioPromise = downloadAudio(info.url, base)

    // 2. Thumbnail + info dulu, biar user langsung lihat cover
    if (info.thumbnail) {
      try {
        let buf = await download(info.thumbnail)
        let f = path.join(TMP, `yt_thumb_${Date.now()}.jpg`)
        fs.writeFileSync(f, buf)
        files.push(f)
        await conn.message.send(m.chat, {
          type: 'image',
          media: f,
          mimetype: 'image/jpeg',
          caption
        }, { quote: m })
      } catch (e) {
        console.error('Thumbnail gagal:', e.message || e)
        await m.reply(caption).catch(() => {})
      }
    } else {
      await m.reply(caption).catch(() => {})
    }

    // 3. Tunggu audio yang sudah mulai didownload sejak tadi
    try {
      let f = await audioPromise
      files.push(f)
      await conn.message.send(m.chat, {
        type: 'audio',
        media: f,
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
