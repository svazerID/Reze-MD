// Pencarian YouTube dengan hasil berupa tombol (.yts / .ytsearch).
//
//   .yts multo            -> tampilkan hasil #1 + tombol Video/Audio
//   .yts -p2 multo        -> tampilkan hasil #2 (dipakai tombol Berikutnya)
//
// Tombol quick_reply mengirim id-nya sebagai pesan biasa, dan id itu berisi
// `.ytmp4 <url>` / `.ytmp3 <url>` — jadi klik tombol langsung jalan lewat
// plugins/ytmp.js yang sudah ada. Tidak ada perantara.

const SEARCH_API = 'https://alsya.svazer.eu.cc/api/search/yts'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const SEARCH_TIMEOUT = 25_000
const ROWS = 10          // baris di daftar "Hasil Lainnya"
const CACHE_TTL = 5 * 60 * 1000
const MAX_CACHE = 200

// ---------------------------------------------------------------------------
// Kenapa ada cache
// ---------------------------------------------------------------------------
// API ini TIDAK bisa diandalkan untuk navigasi berbasis nomor. Diukur
// 2026-10-31 dengan kueri sama, 5 panggilan berturut-turut:
//   - jumlah hasil selalu 19, tidak ada duplikat di dalam satu panggilan
//   - URUTAN berubah (posisi 2 dan 3 pernah tertukar)
//   - ISI juga berubah (18 dari 19 sama; satu video bisa muncul/hilang)
// Parameter halaman (page/offset/p) diabaikan server.
//
// Kalau tombol "Berikutnya" mengambil ulang hasil saat diklik, user bisa
// menekan satu judul lalu mendapat video lain. Karena itu hasil pertama
// disimpan sebentar di memori per chat, dan tombol menunjuk daftar itu.
//
// Ini BUKAN database: tidak ditulis ke disk, hilang saat bot restart.
// Isinya cuma daftar hasil pencarian publik, bukan data pribadi.
let cache = new Map()

function cacheKey(chat, query) {
  return `${chat}|${query.toLowerCase().trim()}`
}

function cacheGet(key) {
  let e = cache.get(key)
  if (!e) return null
  if (Date.now() - e.at > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return e.results
}

function cacheSet(key, results) {
  // Map menjaga urutan masuk, jadi key pertama = yang paling lama (FIFO).
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), results })
}

// ---------------------------------------------------------------------------
// Helper (murni, diuji di blok --test di bawah)
// ---------------------------------------------------------------------------

// Kueri + nomor halaman. Nomor sengaja TIDAK ditulis sebagai angka telanjang
// di akhir, karena "blink 182" dan "multo 2" adalah judul lagu yang sah.
function parseInput(raw) {
  let page = 1
  let kept = []
  for (let w of String(raw || '').trim().split(/\s+/)) {
    if (!w) continue
    let m = w.match(/^-p(\d+)$/i) || w.match(/^--page=(\d+)$/i)
    if (m) {
      page = Math.max(1, parseInt(m[1], 10) || 1)
      continue
    }
    kept.push(w)
  }
  return { query: kept.join(' ').trim(), page }
}

function ytUrl(videoId) {
  return `https://youtube.com/watch?v=${videoId}`
}

// API mengirim "249,678,219 views"; contoh yang diminta cuma angkanya.
function viewsNumber(v) {
  return String(v || '').replace(/[^\d]/g, '') || '0'
}

function cardText(r) {
  return [
    `~> *${r.title}*`,
    `~> *Link:* ${ytUrl(r.videoId)}`,
    `~> *Duration:* ${r.duration || '-'}`,
    `~> *Uploaded:* ${r.uploaded || '-'}`,
    `~> *Views:* ${viewsNumber(r.views)}`
  ].join('\n')
}

// Jendela 10 baris yang mengandung halaman sekarang, sedekat mungkin di
// tengah. Dipakai supaya user tidak perlu maju satu-satu dari hasil #1.
function rowWindow(total, page, size = ROWS) {
  let start = Math.max(1, page - Math.floor(size / 2))
  start = Math.min(start, Math.max(1, total - size + 1))
  let end = Math.min(total, start + size - 1)
  return { start, end }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function search(query) {
  let res = await fetch(`${SEARCH_API}?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  let j = await res.json()
  if (!j?.status || !Array.isArray(j.result)) throw new Error('respons server tidak dikenali')
  return j.result
}

async function run(m, { conn, text, usedPrefix, command }) {
  let { query, page } = parseInput(text)

  if (!query) {
    return m.reply(
      `🔎 *${command}* mencari video di YouTube.\n\n` +
      `Contoh: *${usedPrefix}${command} multo*\n` +
      `Kalau hasilnya kurang cocok, tambahkan kata lain — bukan angka:\n` +
      `*${usedPrefix}${command} multo cup of joe live*`
    )
  }

  let key = cacheKey(m.chat, query)
  let results = cacheGet(key)
  let dariCache = !!results

  if (!results) {
    try {
      results = await search(query)
    } catch (e) {
      return m.reply('❌ Gagal mencari: ' + (e.message || e))
    }
    if (!results.length) return m.reply(`❌ Tidak ada hasil untuk *${query}*.`)
    cacheSet(key, results)
  }

  let total = results.length
  let n = Math.min(Math.max(1, page), total)
  let r = results[n - 1]

  let url = r.videoId ? ytUrl(r.videoId) : r.url
  let buttons = [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📹 Video', id: `.ytmp4 ${url}` }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🎧 Audio', id: `.ytmp3 ${url}` }) }
  ]

  // Hasil terakhir tidak punya "berikutnya"; tampilkan "sebelumnya" supaya
  // user tidak terjebak di ujung daftar.
  if (n < total) {
    buttons.push({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Berikutnya ➡️', id: `.yts -p${n + 1} ${query}` }) })
  } else if (n > 1) {
    buttons.push({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '⬅️ Sebelumnya', id: `.yts -p${n - 1} ${query}` }) })
  }

  let { start, end } = rowWindow(total, n)
  let rows = []
  for (let i = start; i <= end; i++) {
    let v = results[i - 1]
    rows.push({
      title: `${i}. ${v.title}`,
      description: `${v.duration || '-'} | ${v.uploaded || '-'}`,
      id: `.yts -p${i} ${query}`
    })
  }
  buttons.push({
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: '🔎 Hasil Lainnya',
      sections: [{ title: 'Video Terkait', rows }]
    })
  })

  let interactiveMessage = {
    body: { text: cardText(r) },
    // Fallback supaya footer tidak pernah `{ text: undefined }` kalau plugin
    // ini dipakai di luar bot (mis. dari driver test).
    footer: { text: global.packname || 'Reze-MD' },
    nativeFlowMessage: {
      buttons,
      messageParamsJson: JSON.stringify({
        bottom_sheet: { in_thread_buttons_limit: 0, list_title: 'Hasil Pencarian', button_title: 'Opsi Video' }
      })
    },
    contextInfo: {
      mentionedJid: [m.sender],
      groupMentions: [],
      statusAttributions: [],
      forwardingScore: 1,
      isForwarded: true,
      forwardOrigin: 0
    }
  }

  await conn.message.send(m.chat, { interactiveMessage }, {})

  // Kalau hasil diambil ulang (cache kedaluwarsa / bot baru restart), nomor
  // halaman bisa menunjuk video yang berbeda. Sebutkan supaya user tidak
  // mengira tombolnya salah.
  if (page > 1 && !dariCache) {
    await m.reply('ℹ️ Daftar hasil diambil ulang, jadi nomor halaman bisa bergeser sedikit.')
  }
}

module.exports = {
  name: 'ytsearch',
  description: 'Cari video YouTube lalu kirim tombol Video/Audio siap pakai.',
  aliases: ['yts'],
  tags: ['downloader'],
  permissions: {},
  command: /^(ytsearch|yts)$/i,
  run
}

// ---------------------------------------------------------------------------
// Driver test mandiri: node plugins/ytsearch.js --test
// Tidak menyentuh jaringan — yang diuji logika yang mudah salah.
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert')
  const results = []
  const check = (name, fn) => {
    try { fn(); results.push(['ok', name]) } catch (e) { results.push(['err', name, e.message]) }
  }

  check('parseInput: kueri biasa', () => {
    assert.deepStrictEqual(parseInput('multo'), { query: 'multo', page: 1 })
    assert.deepStrictEqual(parseInput('multo cup of joe'), { query: 'multo cup of joe', page: 1 })
  })

  check('parseInput: -p2 jadi halaman, bukan kueri', () => {
    assert.deepStrictEqual(parseInput('-p2 multo'), { query: 'multo', page: 2 })
    assert.deepStrictEqual(parseInput('multo -p12'), { query: 'multo', page: 12 })
  })

  check('parseInput: angka di kueri TIDAK jadi halaman (blink 182)', () => {
    assert.deepStrictEqual(parseInput('blink 182'), { query: 'blink 182', page: 1 })
    assert.deepStrictEqual(parseInput('multo 2'), { query: 'multo 2', page: 1 })
  })

  check('parseInput: kueri kosong', () => {
    assert.deepStrictEqual(parseInput(''), { query: '', page: 1 })
    assert.deepStrictEqual(parseInput('-p3'), { query: '', page: 3 })
  })

  check('viewsNumber', () => {
    assert.strictEqual(viewsNumber('249,678,219 views'), '249678219')
    assert.strictEqual(viewsNumber('172,038,228 views'), '172038228')
    assert.strictEqual(viewsNumber(null), '0')
  })

  check('ytUrl pakai bentuk watch?v=', () => {
    assert.strictEqual(ytUrl('Rht8rS4cR1s'), 'https://youtube.com/watch?v=Rht8rS4cR1s')
  })

  check('cardText sesuai contoh', () => {
    let t = cardText({ title: 'Multo', videoId: 'X', duration: '4:01', uploaded: '2 yr ago', views: '249,678,219 views' })
    assert.strictEqual(t, [
      '~> *Multo*',
      '~> *Link:* https://youtube.com/watch?v=X',
      '~> *Duration:* 4:01',
      '~> *Uploaded:* 2 yr ago',
      '~> *Views:* 249678219'
    ].join('\n'))
  })

  check('rowWindow: halaman 1 -> baris 1-10', () => {
    assert.deepStrictEqual(rowWindow(19, 1), { start: 1, end: 10 })
  })

  check('rowWindow: halaman tengah -> halaman ikut di dalam', () => {
    let w = rowWindow(19, 12)
    assert.ok(w.start <= 12 && 12 <= w.end, 'halaman harus di dalam jendela')
    assert.strictEqual(w.end - w.start + 1, 10)
  })

  check('rowWindow: halaman terakhir -> tidak lewat total', () => {
    assert.deepStrictEqual(rowWindow(19, 19), { start: 10, end: 19 })
  })

  check('rowWindow: hasil sedikit (3) -> tidak negatif', () => {
    assert.deepStrictEqual(rowWindow(3, 2), { start: 1, end: 3 })
  })

  check('cache: simpan, ambil, kedaluwarsa', () => {
    cache.clear()
    cacheSet('c|q', [1, 2, 3])
    assert.deepStrictEqual(cacheGet('c|q'), [1, 2, 3])
    assert.strictEqual(cacheGet('c|lain'), null)
    cache.get('c|q').at = Date.now() - CACHE_TTL - 1
    assert.strictEqual(cacheGet('c|q'), null, 'entri kedaluwarsa harus hilang')
    cache.clear()
  })

  check('cache: batas ukuran (FIFO)', () => {
    cache.clear()
    for (let i = 0; i < MAX_CACHE + 5; i++) cacheSet('k' + i, [i])
    assert.strictEqual(cache.size, MAX_CACHE)
    assert.strictEqual(cacheGet('k0'), null, 'yang paling lama harus dibuang')
    cache.clear()
  })

  for (const [s, n, msg] of results) {
    console.log((s === 'ok' ? '✅ ' : '❌ ') + n + (msg ? ` — ${msg}` : ''))
  }
  const bad = results.filter(s => s[0] === 'err').length
  console.log(bad ? `${bad} gagal` : 'semua test lolos')
  process.exit(bad ? 1 : 0)
}
