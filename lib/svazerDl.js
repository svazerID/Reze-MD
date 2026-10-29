// Client API downloader Svazer (https://download.svazer.us.ci) — pengganti VidsSave.
//
// Bedanya dengan VidsSave: API ini TIDAK memakai proxy dan TIDAK butuh API key.
// Server yang mengunduh sendiri (yt-dlp di sisi mereka), jadi bot cuma dapat
// link file. Semua request cukup fetch biasa.
//
// Alur: info() -> metadata + cek URL didukung, download() -> link file.
// Link berlaku `expires_in` detik (default 3600) lalu file dihapus server.

const BASE = 'https://download.svazer.us.ci'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

// /download bisa 10-90 detik menurut dokumentasinya. Kasih kelonggaran.
const DOWNLOAD_TIMEOUT = 150_000
const INFO_TIMEOUT = 30_000

// Batas durasi di server (413 kalau lewat). Disimpan supaya plugin bisa
// menyebut angka yang sama dengan server, bukan menebak.
const MAX_DURATION = 1200

function headers(extra = {}) {
  return { 'User-Agent': UA, Accept: 'application/json', ...extra }
}

// Ambil `detail` dari respons error supaya pesan ke user informatif,
// bukan cuma "HTTP 422".
async function detailOf(res) {
  let body = ''
  try { body = await res.text() } catch {}
  try {
    let j = JSON.parse(body)
    let d = j?.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d) && d.length) return d.map(x => x.msg || JSON.stringify(x)).join('; ')
  } catch {}
  return body.trim().slice(0, 200) || `HTTP ${res.status}`
}

/**
 * Metadata tanpa mengunduh. Cepat, dipakai untuk memastikan URL didukung.
 * @returns {Promise<{ok:true, id, title, uploader, duration, thumbnail, extractor, webpage_url}|
 *                   {ok:false, message}>}
 */
async function info(url) {
  try {
    let res = await fetch(`${BASE}/info?url=${encodeURIComponent(url)}`, {
      headers: headers(),
      signal: AbortSignal.timeout(INFO_TIMEOUT)
    })
    if (!res.ok) return { ok: false, message: await detailOf(res) }
    return { ok: true, ...(await res.json()) }
  } catch (e) {
    return { ok: false, message: e?.message || String(e) }
  }
}

/**
 * Minta server mengunduh media, lalu kembalikan link file.
 * @param {string} url halaman media
 * @param {{format?: 'best'|'video'|'audio'|'mp4'|'mp3', quality?: 'best'|'1080'|'720'|'480'|'360'}} opts
 * @returns {Promise<{ok:true, url:string, id, title, uploader, duration, filename, ext, size, size_mb, expires_in}|
 *                   {ok:false, message, tooLong?:boolean}>}
 */
async function download(url, { format = 'best', quality = 'best' } = {}) {
  try {
    let res = await fetch(`${BASE}/download`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url, format, quality }),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT)
    })
    if (!res.ok) {
      // 413 = durasi melebihi batas server, beda penanganan dari error biasa.
      return { ok: false, message: await detailOf(res), tooLong: res.status === 413 }
    }
    let j = await res.json()
    if (!j?.download_url) return { ok: false, message: 'server tidak mengembalikan download_url' }
    return { ok: true, url: j.download_url, ...j }
  } catch (e) {
    return { ok: false, message: e?.message || String(e) }
  }
}

module.exports = { info, download, MAX_DURATION, BASE }