// Translate dengan rantai fallback.
//
// Kenapa perlu berlapis: endpoint Google (baik lewat api.alfisy.my.id maupun
// translate.googleapis.com langsung) membalas 429 dari IP datacenter ini.
// Diuji: `translate.googleapis.com` -> 429 "Sorry..." dan API alfisy cuma
// meneruskan error itu (`Request failed with status code 429`). Jadi satu
// jalur saja tidak cukup.
//
// Urutan: alfisy (paling cepat & sudah dipakai bot) -> Google via proxy pool
// (pool sudah lolos Cloudflare, terbukti 3/3 balas 200) -> LibreTranslate ->
// MyMemory. Yang pertama berhasil dipakai; kegagalan dicatat untuk pesan error.

const ALFISY = 'https://api.alfisy.my.id/api/tools/translate'
const GOOGLE = 'https://translate.googleapis.com/translate_a/single'
const LIBRE = 'https://translate.disroot.org/translate'
const MYMEMORY = 'https://api.mymemory.translated.net/get'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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

// Pool proxy yang diuji khusus ke translate.googleapis.com, diurutkan tercepat.
// Pool di lib/proxyPool.js diurutkan untuk vidssave.com, dan proxy yang cepat
// di sana belum tentu cepat di sini (diukur 0.9-10s untuk endpoint yang sama).
let tPool = { list: [], at: 0, cursor: 0, dead: new Set() }
const T_POOL_TTL = 10 * 60 * 1000
const T_POOL_FILE = require('path').join(__dirname, '..', 'tmp', 'translate-pool.json')

function loadTPool() {
  try {
    let raw = JSON.parse(require('fs').readFileSync(T_POOL_FILE, 'utf8'))
    if (Array.isArray(raw.list) && raw.list.length && Date.now() - (raw.at || 0) < T_POOL_TTL) {
      tPool = { list: raw.list, at: raw.at, cursor: 0, dead: new Set() }
      return true
    }
  } catch {}
  return false
}

function saveTPool() {
  try {
    let fs = require('fs')
    fs.mkdirSync(require('path').dirname(T_POOL_FILE), { recursive: true })
    fs.writeFileSync(T_POOL_FILE, JSON.stringify({ list: tPool.list, at: tPool.at }))
  } catch {}
}

async function probeTranslate(proxy) {
  const t0 = Date.now()
  try {
    let res = await fetch(`${GOOGLE}?client=gtx&sl=auto&tl=id&dt=t&q=ok`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8_000),
      dispatcher: agentFor(proxy),
    })
    if (!res.ok) return null
    let txt = await res.text()
    if (!txt.includes('[[')) return null
    return Date.now() - t0
  } catch {
    return null
  }
}

async function refreshTranslatePool() {
  let base = require('./proxyPool')
  let candidates = []
  let seen = new Set()
  // Ambil kandidat dari pool vidssave (sudah tersaring) + refresh kalau kosong.
  for (let i = 0; i < 40 && candidates.length < 24; i++) {
    let p = await base.nextProxy()
    if (!p || seen.has(p)) break
    seen.add(p)
    candidates.push(p)
  }
  let scored = []
  for (let i = 0; i < candidates.length; i += 8) {
    let batch = candidates.slice(i, i + 8)
    let r = await Promise.all(batch.map(async (p) => {
      let ms = await probeTranslate(p)
      return ms === null ? null : { p, ms }
    }))
    scored.push(...r.filter(Boolean))
    // Berhenti begitu ada cukup proxy cepat; tidak perlu menyapu semua.
    if (scored.filter((x) => x.ms < 3000).length >= 4) break
  }
  scored.sort((a, b) => a.ms - b.ms)
  tPool = { list: scored.map((x) => x.p), at: Date.now(), cursor: 0, dead: new Set() }
  if (tPool.list.length) saveTPool()
  return tPool.list
}

async function nextTranslateProxy() {
  let fresh = Date.now() - tPool.at < T_POOL_TTL
  if ((!fresh || !tPool.list.length) && loadTPool()) {
    fresh = true
  }
  if (!fresh || !tPool.list.length) {
    await refreshTranslatePool().catch(() => {})
  }
  let alive = tPool.list.filter((p) => !tPool.dead.has(p))
  if (!alive.length) {
    await refreshTranslatePool().catch(() => {})
    alive = tPool.list.filter((p) => !tPool.dead.has(p))
  }
  if (!alive.length) return null
  let p = alive[tPool.cursor % alive.length]
  tPool.cursor++
  return p
}

function markTranslateDead(p) { if (p) tPool.dead.add(p) }

async function viaAlfisy(text, target) {
  // Timeout pendek: kalau upstream-nya 429, API ini balas cepat (500). Kalau
  // lambat, lebih baik cepat menyerah dan pindah jalur daripada user menunggu.
  let url = `${ALFISY}?text=${encodeURIComponent(text)}&target=${encodeURIComponent(target)}`
  let res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
  let data = await res.json()
  if (!data.success) throw new Error(data.error || 'translate gagal')
  return { text: data.translatedText, from: data.sourceLanguage, to: data.targetLanguage, via: 'alfisy' }
}

// Endpoint publik Google (client=gtx) — tanpa API key, tapi wajib lewat proxy
// karena IP server ini di-429.
async function viaGoogleProxy(text, target) {
  let lastErr = null
  for (let i = 0; i < 4; i++) {
    let proxy = await nextTranslateProxy()
    if (!proxy) break
    try {
      let url = `${GOOGLE}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`
      let res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(12_000),
        dispatcher: agentFor(proxy),
      })
      if (!res.ok) { lastErr = new Error(`google HTTP ${res.status}`); markTranslateDead(proxy); continue }
      let data = await res.json()
      // Format: [[[translated, original, ...], ...], ...]
      let parts = (data?.[0] || []).map((seg) => seg?.[0]).filter(Boolean)
      if (!parts.length) throw new Error('google: hasil kosong')
      return { text: parts.join(''), from: data?.[2] || 'auto', to: target, via: 'google-proxy' }
    } catch (e) {
      lastErr = e
      markTranslateDead(proxy)
    }
  }
  throw lastErr || new Error('google: tidak ada proxy tersedia')
}

async function viaLibre(text, target) {
  let res = await fetch(LIBRE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ q: text, source: 'auto', target, format: 'text' }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) throw new Error(`libre HTTP ${res.status}`)
  let data = await res.json()
  if (!data.translatedText) throw new Error('libre: hasil kosong')
  return { text: data.translatedText, from: 'auto', to: target, via: 'libretranslate' }
}

async function viaMyMemory(text, target) {
  // MyMemory butuh kode sumber eksplisit; 'auto' tidak didukung -> pakai en.
  let url = `${MYMEMORY}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent('en|' + target)}`
  let res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25_000) })
  if (!res.ok) throw new Error(`mymemory HTTP ${res.status}`)
  let data = await res.json()
  let out = data?.responseData?.translatedText
  if (!out) throw new Error('mymemory: hasil kosong')
  return { text: out, from: 'en', to: target, via: 'mymemory' }
}

// Coba tiap penyedia berurutan; kumpulkan alasan gagal kalau semua gagal.
async function translate(text, target = 'id') {
  let errors = []
  for (let fn of [viaAlfisy, viaGoogleProxy, viaLibre, viaMyMemory]) {
    try {
      let r = await fn(text, target)
      if (r && r.text) return r
      errors.push(`${fn.name}: kosong`)
    } catch (e) {
      errors.push(`${fn.name}: ${e.message || e}`)
    }
  }
  throw new Error(errors.join(' | '))
}

module.exports = { translate, viaAlfisy, viaGoogleProxy, viaLibre, viaMyMemory, refreshTranslatePool }
