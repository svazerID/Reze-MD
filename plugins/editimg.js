// Upload gambar ke API img2img (aiold) lalu kembalikan link hasilnya.
//
// Alur API (diuji 2026-10-29):
//   POST /api/img2img  (multipart: image, prompt, model)
//     -> 200 { success: true, imageUrl: 'https://results.deapi.ai/...png' }
//     -> 400 { error: 'Prompt wajib disediakan' }
//     -> 500 { error: 'Gagal transform image: Too Many Attempts.' }  <- rate limit
//
// Rate limit itu milik BERSAMA (semua pemakai API ini), dan saat kena API
// menolak dalam ~0.5 detik, tidak mengantre. Diukur: masih penuh setelah 30
// detik diam, pulih setelah 90 detik. Karena itu hasil edit PUBLIK tidak bisa
// diandalkan muncul dalam satu percobaan.
//
// Dua konsekuensi desain:
//   1. Retry pendek di dalam satu pemanggilan run (maks ~40 detik).
//   2. TIDAK menyimpan gambar/prompt ke mana pun. Kalau tetap penuh setelah
//      retry, user mengirim ulang sendiri. Alasannya bukan sekadar "jangan
//      simpan di db": gambar orang lain tidak pantas menumpuk, dan cache di
//      tmp/ hanya memindahkan masalah yang sama ke disk.

const sharp = require('sharp')
const { downloadMedia } = require('../lib/mediaProcessor')

const API_URL = 'https://aiold.vercel.app/api/img2img'
// Server TIDAK memvalidasi model: nama ngawur tetap dibalas "Too Many Attempts".
// Jadi jangan buka pilihan model yang belum benar-benar teruji.
const MODEL = 'Flux_2_Klein_4B_BF16'

// API selalu membalas PNG 1024x1024. Tidak perlu kirim lebih besar dari itu;
// foto 10MB dari HP cuma memperlambat upload tanpa menambah kualitas hasil.
const MAX_SIDE = 2048
// Terukur 8.7 detik saat server sehat. Kelonggaran besar untuk server sibuk.
const EDIT_TIMEOUT = 120_000
const FETCH_TIMEOUT = 60_000
// Jeda sebelum percobaan ke-2 dan ke-3. Total tunggu ~40 detik.
const RETRY_DELAYS = [15_000, 25_000]

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Perkecil sisi terpanjang ke MAX_SIDE. Gagal (mis. PNG aneh dari WA) ->
// kirim buffer asli. Resize cuma optimasi, bukan syarat, jadi jangan sampai
// menggagalkan edit yang sebetulnya bisa jalan.
async function shrink(buffer) {
  try {
    let img = sharp(buffer)
    let meta = await img.metadata()
    let side = Math.max(meta.width || 0, meta.height || 0)
    if (!side || side <= MAX_SIDE) return buffer
    return await img
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer()
  } catch {
    return buffer
  }
}

// Ambil `error` dari body JSON. Cadangan: HTTP <status>.
async function detailOf(res) {
  let body = ''
  try { body = await res.text() } catch {}
  try {
    let j = JSON.parse(body)
    if (typeof j?.error === 'string') return j.error
    if (typeof j?.message === 'string') return j.message
  } catch {}
  return body.trim().slice(0, 200) || `HTTP ${res.status}`
}

// Satu-satunya kondisi yang layak dicoba ulang. Error lain (prompt kosong,
// gambar rusak) tidak akan berubah kalau diulang, jadi percuma.
const isBusy = msg => /Too Many Attempts/i.test(String(msg || ''))

async function editOnce(buffer, prompt) {
  try {
    let form = new FormData()
    form.append('image', new Blob([buffer]), 'input.jpg')
    form.append('prompt', prompt)
    form.append('model', MODEL)

    let res = await fetch(API_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(EDIT_TIMEOUT)
    })

    if (!res.ok) {
      let message = await detailOf(res)
      return { ok: false, message, busy: isBusy(message) }
    }
    let data = await res.json()
    if (!data?.imageUrl) return { ok: false, message: 'server tidak mengembalikan imageUrl', busy: false }
    return { ok: true, url: data.imageUrl }
  } catch (e) {
    // Timeout / jaringan putus: juga layak dicoba ulang, server mungkin baru
    // selesai memproses saat koneksi kita sudah menyerah.
    return { ok: false, message: e?.message || String(e), busy: true }
  }
}

// `attempt` dan `delays` bisa diganti saat test supaya tidak benar-benar
// menunggu 40 detik. Di pemakaian normal dua-duanya pakai default.
async function editWithRetry(buffer, prompt, onRetry, attempt = editOnce, delays = RETRY_DELAYS) {
  let last = null
  for (let i = 0; i <= delays.length; i++) {
    last = await attempt(buffer, prompt)
    if (last.ok || !last.busy) return last
    if (i === delays.length) break
    if (onRetry) onRetry(i + 1, delays[i])
    await sleep(delays[i])
  }
  return last
}

async function fetchImage(url) {
  let res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (!res.ok) throw new Error(`gagal mengambil hasil (HTTP ${res.status})`)
  let buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('hasil edit kosong')
  return buf
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

async function run(m, { conn, text, command }) {
  // Gambar boleh dari reply (seperti .ai) atau dari pesan itu sendiri.
  // Cek imageMessage spesifik: m.quoted bisa berisi dokumen/audio, dan itu
  // bukan gambar yang bisa diedit.
  let msg = m.quoted?.message?.imageMessage ? m.quoted : m
  let hasImage = !!msg.message?.imageMessage
  let prompt = (text || '').trim()

  if (!hasImage) {
    return m.reply(
      `🖼️ *${command}* mengubah gambar jadi gaya baru.\n\n` +
      `Cara pakai:\n` +
      `• Reply gambar lalu kirim *${command} <prompt>*\n` +
      `• Kirim gambar dengan caption *${command} <prompt>*\n\n` +
      `Contoh: *${command} ubah menjadi gaya anime ghibli*`
    )
  }

  // Prompt wajib. Jangan mengarang prompt sendiri: hasilnya jadi gambar yang
  // tidak diminta user, dan user tidak tahu itu kesalahan siapa.
  if (!prompt) {
    return m.reply(
      `✏️ Sertakan prompt-nya.\n\n` +
      `Contoh: *${command} ubah menjadi gaya anime ghibli*`
    )
  }

  let buffer
  try {
    buffer = await downloadMedia(msg.message)
  } catch (e) {
    return m.reply('❌ Gagal mengunduh gambar: ' + (e.message || e))
  }
  if (!buffer?.length) return m.reply('❌ Gambar kosong atau gagal diunduh.')

  await m.reply(`⏳ Mengedit gambar…\n_${prompt}_`)

  let input
  try {
    input = await shrink(buffer)
  } catch {
    input = buffer
  }

  let result = await editWithRetry(input, prompt, (n, delay) =>
    // Satu pesan per percobaan ulang, bukan spam: user perlu tahu bot tidak hang.
    m.reply(`⏳ Server sedang sibuk, mencoba lagi (${n}/${RETRY_DELAYS.length}) dalam ${Math.round(delay / 1000)} detik…`)
  )

  if (!result.ok) {
    if (result.busy) {
      return m.reply(
        `⏳ *Server edit gambar sedang penuh.*\n\n` +
        `Ini bukan bot yang rusak — API publik ini dipakai bersama banyak orang.\n` +
        `Coba lagi beberapa menit lagi dengan gambar dan prompt yang sama.`
      )
    }
    return m.reply('❌ Gagal mengedit gambar: ' + result.message)
  }

  let out
  try {
    out = await fetchImage(result.url)
  } catch (e) {
    return m.reply(
      `❌ Hasil edit sudah jadi, tapi gagal diambil: ${e.message || e}\n\n` +
      `Coba kirim ulang perintahnya.`
    )
  }

  await conn.message.send(m.chat, {
    type: 'image',
    media: out,
    mimetype: 'image/png',
    caption: `✨ *${prompt}*`
  }, { quote: m })
}

module.exports = {
  name: 'editimg',
  description: 'Edit gambar jadi gaya baru lewat AI img2img (reply gambar atau caption).',
  tags: ['ai'],
  permissions: {},
  command: /^editimg$/i,
  run
}

// ---------------------------------------------------------------------------
// Driver test mandiri. Jangan memuat config.js: file itu memasang setInterval
// dan membuat proses tidak keluar. process.exit(0) di akhir wajib.
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const assert = require('assert')
    const fs = require('fs')
    const path = require('path')
    const results = []
    const check = async (name, fn) => {
      try { await fn(); results.push(['ok', name]) } catch (e) { results.push(['err', name, e.message]) }
    }

    await check('isBusy menandai rate limit, bukan error lain', () => {
      assert.strictEqual(isBusy('Gagal transform image: Too Many Attempts.'), true)
      assert.strictEqual(isBusy('Prompt wajib disediakan'), false)
    })

    await check('retry berhenti setelah maksimal 3 percobaan', async () => {
      let tries = 0
      const delays = []
      const r = await editWithRetry(
        Buffer.from('x'), 'p',
        (n, d) => delays.push(d),
        async () => { tries++; return { ok: false, message: 'Too Many Attempts', busy: true } },
        [10, 10]
      )
      assert.strictEqual(tries, 3)
      assert.strictEqual(r.busy, true)
      assert.deepStrictEqual(delays, [10, 10])
    })

    await check('error non-busy tidak di-retry', async () => {
      let tries = 0
      const r = await editWithRetry(
        Buffer.from('x'), 'p', null,
        async () => { tries++; return { ok: false, message: 'Prompt wajib disediakan', busy: false } },
        [10, 10]
      )
      assert.strictEqual(tries, 1)
      assert.strictEqual(r.busy, false)
    })

    await check('retry berhasil di percobaan kedua', async () => {
      let tries = 0
      const r = await editWithRetry(
        Buffer.from('x'), 'p', null,
        async () => ++tries === 1
          ? { ok: false, message: 'Too Many Attempts', busy: true }
          : { ok: true, url: 'https://x/y.png' },
        [10, 10]
      )
      assert.strictEqual(tries, 2)
      assert.strictEqual(r.ok, true)
    })

    await check('API asli: prompt kosong ditolak server', async () => {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'tmp', 'editimg-input.jpg'))
      const r = await editOnce(buf, '   ')
      if (r.busy) {
        // Server sedang penuh -> penolakan prompt tidak terlihat. Ini bukan
        // bukti apa pun; tandai belum terbukti, jangan anggap lolos.
        assert.fail('server masih penuh, penolakan prompt belum terbukti')
      }
      assert.strictEqual(r.ok, false)
      // Pesan server berganti bahasa dan status ("Prompt wajib disediakan"
      // 400 -> "The prompt field is required." 500), jadi jangan bergantung
      // pada bahasa maupun status. Yang penting: ada pesan, dan TIDAK di-retry.
      assert.ok(r.message && r.message.length, 'pesan error kosong')
    })

    await check('API asli: edit + ambil hasil PNG', async () => {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'tmp', 'editimg-input.jpg'))
      // Di test, tunggu lebih sabar daripada retry di bot (40 dtk): yang
      // diuji di sini adalah jalur kodenya, bukan pengalaman user.
      const r = await editWithRetry(await shrink(buf), 'ubah menjadi gaya anime ghibli', null, editOnce, [60_000, 90_000, 120_000])
      // Kalau server penuh, ini BELUM terbukti. Jangan lolos diam-diam:
      // anggap gagal supaya terlihat jelas dan dicoba lagi nanti.
      assert.ok(!(r.ok === false && r.busy), 'server masih penuh, jalur edit belum terbukti')
      assert.strictEqual(r.ok, true, r.message)
      assert.match(r.url, /^https?:\/\//)
      const img = await fetchImage(r.url)
      assert.ok(img.length > 1000, 'gambar hasil terlalu kecil')
      assert.strictEqual(img.subarray(0, 4).toString('hex'), '89504e47', 'bukan PNG')
    })

    // `run` diuji lewat handler asli dengan conn tiruan. Jalur yang tidak
    // memanggil API (instruksi & prompt kosong) bisa diuji tanpa jaringan.
    const fakeConn = { sent: [], message: { send: async (chat, payload) => { fakeConn.sent.push(payload) } } }
    const makeM = (extra = {}) => {
      const replies = []
      return { replies, chat: 'x@s.whatsapp.net', reply: async t => { replies.push(t) }, ...extra }
    }

    await check('tanpa gambar: kirim instruksi', async () => {
      const m = makeM()
      await run(m, { conn: fakeConn, text: 'gaya anime', command: 'editimg' })
      assert.match(m.replies[0], /Cara pakai/)
      assert.strictEqual(fakeConn.sent.length, 0)
    })

    await check('gambar tanpa prompt: minta prompt, tidak mengarang', async () => {
      const m = makeM({ message: { imageMessage: { mimetype: 'image/jpeg' } } })
      await run(m, { conn: fakeConn, text: '', command: 'editimg' })
      assert.match(m.replies[0], /Sertakan prompt/)
      assert.strictEqual(fakeConn.sent.length, 0)
    })

    await check('reply berisi dokumen (bukan gambar): tidak dianggap gambar', async () => {
      const m = makeM({ quoted: { message: { documentMessage: { mimetype: 'application/pdf' } } } })
      await run(m, { conn: fakeConn, text: 'ubah', command: 'editimg' })
      assert.match(m.replies[0], /Cara pakai/)
    })

    for (const [s, n, msg] of results) {
      console.log((s === 'ok' ? '✅ ' : '❌ ') + n + (msg ? ` — ${msg}` : ''))
    }
    const bad = results.filter(s => s[0] === 'err').length
    console.log(bad ? `${bad} gagal` : 'semua test lolos')
    process.exit(bad ? 1 : 0)
  })().catch(e => {
    console.error(e)
    process.exit(1)
  })
}
