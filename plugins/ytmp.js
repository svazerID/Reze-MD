// Download YouTube lewat API downloader Svazer (lib/svazerDl.js).
//
//   .ytmp3 <url>            -> audio mp3
//   .ytmp4 [kualitas] <url> -> video mp4 (1080/720/480/360)
//
// Server yang menjalankan yt-dlp, bot cuma mengambil link filenya lalu
// mengunduh. Tidak butuh cookie, JS runtime, maupun proxy — beda dari .play
// yang menjalankan yt-dlp lokal dan memakai API ini hanya sebagai cadangan.

const fs = require('fs')
const path = require('path')
const svazer = require('../lib/svazerDl')
const { extractText } = require('../lib/simple')

const TMP = path.join(__dirname, '..', 'tmp')
fs.mkdirSync(TMP, { recursive: true })

// Batas video WhatsApp ±64 MB. Diukur 2026-10-30: video 3:44 mp4 "best"
// = 43.8 MB, jadi video lebih panjang gampang lewat. Karena itu kualitas
// default 720 (12 MB untuk video yang sama), dan kalau tetap kegedean bot
// turun kualitas sendiri daripada menyerahkan error ke user.
const MAX_VIDEO = 60 * 1024 * 1024

const VIDEO_QUALS = ['1080', '720', '480', '360']
const DEFAULT_QUALITY = '720'

// Tangga turun kalau hasil kegedean. 1080 langsung ke 480: bedanya di bawah
// itu jarang menyelamatkan apa pun, jadi tidak perlu dicoba satu-satu.
const DOWNGRADE = { 1080: '480', 720: '360', 480: '360', 360: null }

const URL_RE = /https?:\/\/[^\s<>"']+/i
const YT_RE = /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i

// `chain` kualitas yang akan dicoba berurutan.
function videoChain(quality) {
  let chain = [quality]
  let cur = quality
  while (DOWNGRADE[cur]) {
    cur = DOWNGRADE[cur]
    if (!chain.includes(cur)) chain.push(cur)
  }
  return chain
}

// Pisahkan kualitas dan URL dari argumen. `args` = kata-kata setelah command.
function parseArgs(args) {
  let quality = null
  let url = ''
  for (const a of args || []) {
    if (!quality && VIDEO_QUALS.includes(a)) { quality = a; continue }
    if (!url && URL_RE.test(a)) url = a.match(URL_RE)[0]
  }
  return { url, quality }
}

// URL boleh dari argumen atau dari teks pesan yang di-reply.
function findUrl(args, text, quotedText) {
  let fromArgs = parseArgs(args)
  if (fromArgs.url) return fromArgs
  let hay = `${text || ''} ${quotedText || ''}`
  let m = hay.match(URL_RE)
  return { url: m ? m[0] : '', quality: fromArgs.quality }
}

function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0)
  if (!sec) return '-'
  let h = Math.floor(sec / 3600)
  let m = Math.floor((sec % 3600) / 60)
  let s = sec % 60
  return (h ? `${h}:` : '') + `${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`
}

async function fetchToFile(url, file) {
  let res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`gagal mengunduh file (HTTP ${res.status})`)
  let buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('file kosong dari server')
  fs.writeFileSync(file, buf)
  return buf.length
}

async function run(m, { conn, args, text, usedPrefix, command }) {
  let isAudio = /^(ytmp3|yta|ytaudio)$/i.test(command)

  let quotedText = m.quoted ? (extractText(m.quoted.message) || '') : ''
  let { url, quality } = findUrl(args, text, quotedText)

  if (!url) {
    return m.reply(
      `🎬 *${command}* mengunduh dari YouTube.\n\n` +
      `Contoh:\n` +
      `• *${usedPrefix}${command}${isAudio ? '' : ' 720'} https://youtu.be/YrtS8MESh0I*\n` +
      (isAudio ? '' : `• Kualitas: 1080, 720 (default), 480, 360\n`) +
      `• Atau reply pesan yang berisi link YouTube dengan *${usedPrefix}${command}*`
    )
  }
  if (!YT_RE.test(url)) {
    return m.reply('❌ Link-nya bukan YouTube. Kirim link youtube.com atau youtu.be.')
  }

  await m.reply(isAudio ? '⏳ Mengunduh audio…' : '⏳ Mengunduh video…')

  let result = isAudio
    ? await svazer.download(url, { format: 'mp3' })
    : await downloadVideoWithFallback(url, quality || DEFAULT_QUALITY)

  if (!result.ok) {
    if (result.tooLong) {
      return m.reply(`❌ Videonya lebih dari ${Math.round(svazer.MAX_DURATION / 60)} menit — server menolak yang sepanjang itu.`)
    }
    return m.reply('❌ Gagal mengunduh: ' + result.message)
  }

  let ext = result.ext || (isAudio ? 'mp3' : 'mp4')
  let file = path.join(TMP, `ytmp_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`)

  try {
    await fetchToFile(result.url, file)

    let caption = [
      `🎵 *${result.title || 'YouTube'}*`,
      result.duration ? `⏱️ ${fmtDuration(result.duration)}` : null,
      !isAudio && result.quality ? `📺 ${result.quality}p` : null
    ].filter(Boolean).join('\n')

    if (isAudio) {
      await conn.message.send(m.chat, {
        type: 'audio',
        media: file,
        mimetype: 'audio/mpeg',
        caption
      }, { quote: m })
    } else {
      await conn.message.send(m.chat, {
        type: 'video',
        media: file,
        mimetype: 'video/mp4',
        caption
      }, { quote: m })
    }

    // Kalau bot turun kualitas, sebutkan supaya user tidak bingung kenapa
    // gambarnya lebih buram dari yang diminta.
    if (!isAudio && result.downgradedFrom) {
      await m.reply(`ℹ️ Kualitas diturunkan ke *${result.quality}p* karena ${result.downgradedFrom}p (${result.downgradedSize} MB) kegedean buat WhatsApp.`)
    }
  } catch (e) {
    await m.reply('❌ Gagal mengirim: ' + (e.message || e))
  } finally {
    try { fs.unlinkSync(file) } catch {}
  }
}

// Coba kualitas yang diminta; kalau hasilnya di atas batas WA, turun satu
// langkah dan coba lagi. Berhenti di kualitas terendah, gagal dengan jelas.
// `fetchDownload` bisa diganti saat test supaya jalur turun-kualitas teruji
// tanpa harus mencari video yang kebetulan berukuran >60 MB.
async function downloadVideoWithFallback(url, quality, fetchDownload = svazer.download) {
  let chain = videoChain(quality)
  let firstSize = null
  let tried = []
  for (const q of chain) {
    tried.push(q)
    let r = await fetchDownload(url, { format: 'mp4', quality: q })
    if (!r.ok) return r
    if (!r.size || r.size <= MAX_VIDEO) {
      if (q !== quality && firstSize) {
        r.downgradedFrom = quality
        r.downgradedSize = Math.round(firstSize / 1024 / 1024)
      }
      return r
    }
    if (firstSize === null) firstSize = r.size
  }
  return {
    ok: false,
    message: `walau di kualitas terendah (${tried.join('→')}), videonya masih ${Math.round((firstSize || 0) / 1024 / 1024)} MB`
  }
}

module.exports = {
  name: 'ytmp',
  description: 'Download video atau audio YouTube lewat API downloader Svazer.',
  aliases: ['yta', 'ytv', 'ytaudio', 'ytvideo'],
  tags: ['downloader'],
  permissions: {},
  command: /^(ytmp3|ytmp4|yta|ytv|ytaudio|ytvideo)$/i,
  run
}

// ---------------------------------------------------------------------------
// Driver test mandiri: node plugins/ytmp.js --test
// Bagian ini tidak menyentuh jaringan sama sekali — yang diuji hanya logika
// yang mudah salah (pemilihan kualitas dan pembacaan URL).
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert')
  const results = []
  const pending = []
  global.__pending = pending
  const check = (name, fn) => {
    try {
      const r = fn()
      if (r && typeof r.then === 'function') {
        pending.push(r.then(
          () => results.push(['ok', name]),
          e => results.push(['err', name, e.message])
        ))
      } else {
        results.push(['ok', name])
      }
    } catch (e) { results.push(['err', name, e.message]) }
  }

  check('parseArgs: kualitas + url', () => {
    let r = parseArgs(['1080', 'https://youtu.be/abc'])
    assert.strictEqual(r.quality, '1080')
    assert.strictEqual(r.url, 'https://youtu.be/abc')
  })

  check('parseArgs: kualitas setelah url tetap terbaca', () => {
    let r = parseArgs(['https://youtu.be/abc', '480'])
    assert.strictEqual(r.quality, '480')
    assert.strictEqual(r.url, 'https://youtu.be/abc')
  })

  check('parseArgs: url saja -> kualitas null (diputuskan pemanggil)', () => {
    let r = parseArgs(['https://youtu.be/abc'])
    assert.strictEqual(r.quality, null)
    assert.strictEqual(r.url, 'https://youtu.be/abc')
  })

  check('parseArgs: kata biasa tidak jadi url', () => {
    let r = parseArgs(['halo', 'dunia'])
    assert.strictEqual(r.url, '')
    assert.strictEqual(r.quality, null)
  })

  check('findUrl: ambil dari teks reply', () => {
    let r = findUrl([], '', 'ini lagunya https://youtube.com/watch?v=1 ya')
    assert.strictEqual(r.url, 'https://youtube.com/watch?v=1')
  })

  check('videoChain: 1080 turun ke 480 lalu 360', () => {
    assert.deepStrictEqual(videoChain('1080'), ['1080', '480', '360'])
    assert.deepStrictEqual(videoChain('720'), ['720', '360'])
    assert.deepStrictEqual(videoChain('360'), ['360'])
  })

  check('fmtDuration', () => {
    assert.strictEqual(fmtDuration(224), '3:44')
    assert.strictEqual(fmtDuration(3725), '1:02:05')
    assert.strictEqual(fmtDuration(0), '-')
  })

  check('deteksi link YouTube', () => {
    assert.strictEqual(YT_RE.test('https://youtu.be/x'), true)
    assert.strictEqual(YT_RE.test('https://www.youtube.com/watch?v=x'), true)
    assert.strictEqual(YT_RE.test('https://tiktok.com/x'), false)
  })

  check('auto-turun: 1080 kegedean -> 480 dipakai', () => {
    const MB = 1024 * 1024
    const fake = async (url, o) => o.quality === '1080'
      ? { ok: true, size: 120 * MB, quality: '1080' }
      : { ok: true, size: 20 * MB, quality: o.quality }
    return downloadVideoWithFallback('u', '1080', fake).then(r => {
      assert.strictEqual(r.ok, true)
      assert.strictEqual(r.quality, '480')
      assert.strictEqual(r.downgradedFrom, '1080')
      assert.strictEqual(r.downgradedSize, 120)
    })
  })

  check('auto-turun: semua kualitas kegedean -> gagal jelas', () => {
    const MB = 1024 * 1024
    const fake = async () => ({ ok: true, size: 200 * MB, quality: 'x' })
    return downloadVideoWithFallback('u', '720', fake).then(r => {
      assert.strictEqual(r.ok, false)
      assert.match(r.message, /kualitas terendah/)
    })
  })

  check('auto-turun: ukuran pas -> tidak turun', () => {
    const MB = 1024 * 1024
    const fake = async (url, o) => ({ ok: true, size: 10 * MB, quality: o.quality })
    return downloadVideoWithFallback('u', '1080', fake).then(r => {
      assert.strictEqual(r.ok, true)
      assert.strictEqual(r.quality, '1080')
      assert.strictEqual(r.downgradedFrom, undefined)
    })
  })

  const report = () => {
    for (const [s, n, msg] of results) {
      console.log((s === 'ok' ? '✅ ' : '❌ ') + n + (msg ? ` — ${msg}` : ''))
    }
    const bad = results.filter(s => s[0] === 'err').length
    console.log(bad ? `${bad} gagal` : 'semua test lolos')
    process.exit(bad ? 1 : 0)
  }

  // `check` menerima fungsi async (tes auto-turun) maupun sync.
  Promise.all((global.__pending || [])).then(report)
}
