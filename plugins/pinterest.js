let fs = require('fs')
let path = require('path')
let { acquireFfmpegSlot } = require('../lib/mediaProcessor')

const API = 'https://alsya.svazer.eu.cc/api'
const TMP = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function apiGet(p, params) {
  let url = new URL(API + p)
  for (let [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  let res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

// Ambal file (gambar). curl resume seperti play.js kalau fetch kena terminated.
async function unduh(url) {
  let res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  let buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('file kosong')
  return buf
}

// Video Pinterest datang sebagai HLS .m3u8 — remux ke mp4 (copy, tanpa re-encode).
// ffmpeg dibatasi lewat slot biar tidak rebut CPU.
function m3u8KeMp4(url) {
  let ff = require('fluent-ffmpeg')
  return new Promise(async (resolve, reject) => {
    let release = await acquireFfmpegSlot()
    let out = path.join(TMP, `pin_${Date.now()}.mp4`)
    ff(url)
      .inputOptions(['-user_agent', UA])
      .outputOptions(['-c copy', '-bsf:a aac_adtstoasc', '-movflags +faststart'])
      .on('error', (e) => { release(); reject(e) })
      .on('end', () => { release(); resolve(out) })
      .save(out)
  })
}

function pilihMedia(media) {
  if (!Array.isArray(media) || !media.length) return null
  // Video menang kalau ada (pin video biasanya cuma punya 1 entri).
  let video = media.find(m => m.type === 'video')
  if (video) return video
  // Gambar: ambil kualitas terbaik yang tersedia.
  let urutan = ['Original', 'Large', 'Medium', 'Small']
  for (let q of urutan) {
    let m = media.find(x => x.type === 'image' && x.quality === q)
    if (m) return m
  }
  return media[0]
}

function bersihJudul(t, max = 90) {
  let s = String(t || 'Tanpa judul').replace(/[|*_~`]/g, '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

async function kirimHasilSearch(m, conn, query) {
  let json = await apiGet('/search/pinterest', { q: query })
  if (!json.status) throw new Error(json.message || 'search gagal')
  let hasil = json.result || []
  if (!hasil.length) return m.reply(`❌ Nggak nemu "${query}".`)

  await m.reply(`*📌 Pinterest — ${query}* (${hasil.length} gambar)`)

  // Kirim gambarnya langsung — tidak perlu pilih nomor.
  for (let i = 0; i < Math.min(hasil.length, 5); i++) {
    let r = hasil[i]
    if (!r.image) continue
    try {
      let buf = await unduh(r.image)
      let f = path.join(TMP, `pin_s_${Date.now()}_${i}.jpg`)
      fs.writeFileSync(f, buf)
      try {
        await conn.message.send(m.chat, {
          type: 'image',
          media: f,
          mimetype: 'image/jpeg',
          caption: bersihJudul(r.title, 120)
        }, { quote: m })
      } finally {
        fs.unlinkSync(f)
      }
    } catch (e) {
      console.error('Thumbnail pinterest gagal:', e.message || e)
    }
  }
}

async function kirimDownload(m, conn, url) {
  let json = await apiGet('/download/pinterest', { url })
  if (!json.status) throw new Error(json.message || 'download gagal')

  let data = json.data || {}
  let media = pilihMedia(data.media)
  if (!media?.url) throw new Error('tidak ada media di pin tersebut')

  let judul = bersihJudul(data.title || 'Pinterest')
  let isVideo = media.type === 'video' || /\.m3u8/.test(media.url)

  if (isVideo) {
    let out
    try {
      out = await m3u8KeMp4(media.url)
    } catch (e) {
      throw new Error('gagal ambil video: ' + (e.message || e))
    }
    try {
      await conn.message.send(m.chat, {
        type: 'video',
        media: out,
        mimetype: 'video/mp4',
        caption: judul
      }, { quote: m })
    } finally {
      try { fs.unlinkSync(out) } catch {}
    }
    return
  }

  let buf = await unduh(media.url)
  let ext = media.extension || 'jpg'
  let f = path.join(TMP, `pin_${Date.now()}.${ext}`)
  fs.writeFileSync(f, buf)
  try {
    await conn.message.send(m.chat, {
      type: 'image',
      media: f,
      mimetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      caption: judul
    }, { quote: m })
  } finally {
    fs.unlinkSync(f)
  }
}

module.exports = {
  name: 'pinterest',
  description: 'Cari gambar Pinterest, lalu download (kirim nomor atau link pin).',
  aliases: ['pin', 'pindl'],
  tags: ['downloader'],
  permissions: {},
  command: /^(pinterest|pin|pindl)$/i,
  run: async (m, { conn, args, text, usedPrefix, command }) => {
    let input = (text || '').trim()
    if (!input) {
      return m.reply(`Contoh:\n` +
        `${usedPrefix}${command} kucing — cari gambar\n` +
        `${usedPrefix}${command} https://pin.it/xxxx — download link pin`)
    }

    // 1. Link pin → langsung download
    if (/^https?:\/\//i.test(input)) {
      if (!/pinterest\.|pin\.it/i.test(input)) return m.reply('❌ URL harus link Pinterest.')
      await m.reply('⏳ Mengambil pin...')
      try {
        await kirimDownload(m, conn, input)
      } catch (e) {
        return m.reply('❌ Gagal: ' + (e.message || e))
      }
      return
    }

    // 2. Teks → search (kirim gambarnya langsung)
    await m.reply(`🔎 Mencari "${input}"...`)
    try {
      await kirimHasilSearch(m, conn, input)
    } catch (e) {
      return m.reply('❌ Gagal searching: ' + (e.message || e))
    }
  }
}
