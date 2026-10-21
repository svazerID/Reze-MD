// Rotasi proxy untuk VidsSave.
//
// Kenapa perlu: Cloudflare di depan vidssave.com memblokir IP datacenter di
// edge (403, body 1 byte, `cf-ray: ...-IAD`, `content-type: text/plain`).
// Blokir terjadi SEBELUM JS jalan, jadi Playwright/stealth tidak menolong —
// sudah diuji dan tetap 403. Satu-satunya jalan adalah egress IP lain.
//
// Strategi: ambil daftar proxy gratis publik, uji mana yang benar-benar
// sampai ke vidssave.com (200, bukan 403/timeout), simpan yang lolos ke cache
// di disk, lalu rotasi. Proxy gratis cepat mati, jadi cache punya TTL dan
// daftar di-refresh sendiri saat semua kandidat habis.
//
// JANGAN pakai proxy ini untuk kredensial apa pun. Ini relay pihak ketiga:
// trafiknya bisa dibaca pemilik proxy. Yang lewat sini cuma request publik
// ke vidssave (tanpa cookie, tanpa token akun).

let fs = require('fs')
let path = require('path')

const CACHE_FILE = path.join(__dirname, '..', 'tmp', 'proxy-pool.json')
const CACHE_TTL_MS = 10 * 60 * 1000     // proxy gratis cepat mati: 10 menit
const PROBE_URL = 'https://vidssave.com/'
const PROBE_TIMEOUT = 12_000
const MAX_PARALLEL = 40

// Sumber daftar proxy gratis. Beberapa sumber = kalau satu mati, masih jalan.
const SOURCES = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=5000',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

let state = { proxies: [], fetchedAt: 0, cursor: 0, dead: new Set() }

function loadCache() {
  try {
    let raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (Array.isArray(raw.proxies) && Date.now() - (raw.fetchedAt || 0) < CACHE_TTL_MS) {
      state.proxies = raw.proxies
      state.fetchedAt = raw.fetchedAt || 0
      return true
    }
  } catch {}
  return false
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ proxies: state.proxies, fetchedAt: state.fetchedAt }))
  } catch {}
}

async function fetchList() {
  let all = new Set()
  await Promise.all(SOURCES.map(async (src) => {
    try {
      let res = await fetch(src, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return
      let text = await res.text()
      for (let line of text.split('\n')) {
        let p = line.trim().replace(/\r/g, '')
        if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(p)) all.add(p)
      }
    } catch {}
  }))
  return [...all]
}

// Satu percobaan: proxy ini sampai ke vidssave.com dengan status 200, dan
// seberapa cepat? Kecepatan penting karena download audio 4-6MB lewat proxy
// gratis bisa 0.3 MB/s -> user menunggu setengah menit lebih.
// Kembalikan { ok, ms } — ms dipakai untuk mengurutkan pool.
async function probe(proxy) {
  const t0 = Date.now()
  try {
    let res = await fetch(PROBE_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      redirect: 'follow',
      // Node tidak punya opsi proxy di fetch; pakai dispatcher manual via undici
      dispatcher: await proxyDispatcher(proxy),
    })
    if (res.status !== 200) return { ok: false }
    // Body 1 byte / kosong = blokir Cloudflare yang menyamar jadi 200.
    let buf = Buffer.from(await res.arrayBuffer())
    if (buf.length <= 2000) return { ok: false }
    return { ok: true, ms: Date.now() - t0 }
  } catch {
    return { ok: false }
  }
}

// undici ProxyAgent — dibutuhkan untuk mengarahkan fetch lewat proxy HTTP.
async function proxyDispatcher(proxy) {
  let { ProxyAgent } = require('undici')
  return new ProxyAgent({ uri: `http://${proxy}`, requestTls: { rejectUnauthorized: false } })
}

async function refresh() {
  let candidates = await fetchList()
  if (!candidates.length) return state.proxies

  let good = []
  for (let i = 0; i < candidates.length; i += MAX_PARALLEL) {
    let batch = candidates.slice(i, i + MAX_PARALLEL)
    let results = await Promise.all(batch.map(async (p) => {
      let r = await probe(p)
      return r.ok ? { p, ms: r.ms } : null
    }))
    good.push(...results.filter(Boolean))
    // Cukup 12 proxy sehat; sisanya cuma buang waktu.
    if (good.length >= 12) break
  }

  // Yang tercepat dipakai lebih dulu.
  good.sort((a, b) => a.ms - b.ms)
  state.proxies = good.map((x) => x.p)
  if (state.proxies.length) saveCache()
  state.fetchedAt = Date.now()
  state.cursor = 0
  state.dead = new Set()
  return state.proxies
}

async function ensurePool() {
  let fresh = Date.now() - state.fetchedAt < CACHE_TTL_MS
  let usable = state.proxies.filter((p) => !state.dead.has(p))
  if (fresh && usable.length) return usable
  if (loadCache()) {
    let cached = state.proxies.filter((p) => !state.dead.has(p))
    if (cached.length) return cached
  }
  return refresh()
}

// Ambil proxy berikutnya secara round-robin. null = tidak ada yang tersedia.
async function nextProxy() {
  let pool = await ensurePool()
  if (!pool.length) return null
  for (let tries = 0; tries < pool.length; tries++) {
    let p = pool[state.cursor % pool.length]
    state.cursor++
    if (!state.dead.has(p)) return p
  }
  // Semua sudah ditandai mati -> paksa refresh sekali.
  state.dead = new Set()
  await refresh()
  return state.proxies[0] || null
}

// Dipanggil setelah kegagalan beruntun: buang daftar lama, uji ulang dari nol.
// Tanpa ini, cache 10 menit bisa berisi proxy yang semuanya sudah mati dan
// setiap request baru akan gagal cepat tanpa pernah mencoba yang segar.
async function forceRefresh() {
  state.dead = new Set()
  state.proxies = []
  state.fetchedAt = 0
  try { fs.unlinkSync(CACHE_FILE) } catch {}
  return refresh()
}

// Tandai proxy mati supaya tidak dipakai lagi di sesi ini.
function markDead(proxy) {
  if (proxy) state.dead.add(proxy)
}

function stats() {
  return {
    total: state.proxies.length,
    alive: state.proxies.filter((p) => !state.dead.has(p)).length,
    fetchedAt: state.fetchedAt,
  }
}

module.exports = { nextProxy, markDead, refresh, forceRefresh, stats, probe }
