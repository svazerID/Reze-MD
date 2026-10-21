// Request VidsSave lewat proxy rotasi. Dipakai play.js (dan bisa dipakai
// plugin lain). Lihat lib/proxyPool.js untuk alasan kenapa proxy diperlukan.
let pool = require('./proxyPool')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const PARSE_URL = 'https://api.vidssave.com/api/contentsite_api/media/parse'
const MAX_TRIES = 6

// undici ProxyAgent, di-cache per proxy supaya tidak bikin koneksi baru tiap request.
let agentCache = new Map()
function agentFor(proxy) {
  let a = agentCache.get(proxy)
  if (!a) {
    let { ProxyAgent } = require('undici')
    a = new ProxyAgent({ uri: `http://${proxy}` })
    agentCache.set(proxy, a)
  }
  return a
}

function parsePayload(link) {
  return new URLSearchParams({
    hostname: 'vidssave.com',
    auth: '4c9b7d21',
    domain: 'api-ak.vidssave.com',
    origin: 'cache',
    link,
  }).toString()
}

// POST ke endpoint parse lewat proxy yang berganti-ganti sampai dapat status 1.
// Kembalikan { ok, data, proxy } atau { ok:false, message }.
async function parseVia(link) {
  let lastMsg = 'tidak ada proxy yang tersedia'
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let proxy = await pool.nextProxy()
    if (!proxy) return { ok: false, message: lastMsg }

    try {
      let res = await fetch(PARSE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Origin: 'https://vidssave.com',
          Referer: 'https://vidssave.com/',
          Accept: 'application/json, text/plain, */*',
        },
        body: parsePayload(link),
        signal: AbortSignal.timeout(30_000),
        dispatcher: agentFor(proxy),
      })
      if (!res.ok) {
        // 403 = proxy ini sudah kena blokir Cloudflare juga.
        pool.markDead(proxy)
        lastMsg = `proxy HTTP ${res.status}`
        continue
      }
      let data = await res.json()
      if (data && data.status === 1) return { ok: true, data, proxy }
      // analyze_risk = proxy-nya masih IP yang di-flag, coba proxy lain.
      lastMsg = data?.status_code || data?.msg || 'parse gagal'
      if (data?.status_code === 'analyze_risk') { pool.markDead(proxy); continue }
      return { ok: false, message: lastMsg }
    } catch (e) {
      pool.markDead(proxy)
      lastMsg = e.message || String(e)
    }
  }
  // Semua percobaan gagal: pool kemungkinan besar sudah basi. Refresh sekali
  // lalu coba lagi, supaya request berikutnya tidak ikut gagal.
  await pool.forceRefresh().catch(() => {})
  return { ok: false, message: lastMsg }
}

// Download file lewat proxy. Proxy yang berhasil parse dicoba dulu, tapi TIDAK
// diandalkan: proxy yang lolos parse tetap bisa 403 atau sangat lambat saat
// ambil file 4-6MB (diukur 0.3-0.7 MB/s, dan satu percobaan makan 42 detik
// sebelum 403). Jadi timeout per percobaan dibuat pendek dan proxy lain
// langsung dicoba, bukan menunggu satu proxy selesai.
async function downloadVia(url, proxy, { timeoutMs = 45_000, maxTries = 6 } = {}) {
  let first = proxy
  let lastErr = null
  for (let attempt = 0; attempt < maxTries; attempt++) {
    let p = attempt === 0 && first ? first : await pool.nextProxy()
    if (!p) { lastErr = lastErr || new Error('tidak ada proxy tersedia'); break }
    try {
      let res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://vidssave.com/' },
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: agentFor(p),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error('file kosong')
      return buf
    } catch (e) {
      lastErr = e
      pool.markDead(p)
    }
  }
  await pool.forceRefresh().catch(() => {})
  throw lastErr || new Error('download gagal')
}

module.exports = { parseVia, downloadVia, agentFor }
