// Upload file ke Google Drive (resumable, chunked) — tanpa batas ext.
// Logika sama dengan data/drive-upload.js, tapi dipindah ke lib/ supaya bisa
// dipakai plugin dan tidak bergantung pada folder data/ yang di-gitignore.
//
// Credential dibaca dari (urutan pertama yang ada):
//   1. env GOOGLE_TOKEN_PATH / GOOGLE_SECRET_PATH
//   2. <repo>/data/google_token.json + google_client_secret.json
//   3. ~/data/google_token.json + google_client_secret.json
// Kalau nggak ada, return null (bukan throw) — caller bisa fallback ke CDN.

let fs = require('fs')
let path = require('path')

let CHUNK = 16 * 1024 * 1024 // 16 MiB, harus kelipatan 256 KiB

// fetch() di Node cuma bilang "fetch failed"; sebab aslinya (DNS, reset, dsb)
// ada di e.cause. Tanpa ini log produksi tidak bisa dibedakan penyebabnya.
function errInfo(e) {
  let c = e?.cause
  let parts = []
  for (let v of [e?.code, c?.code, c?.message]) {
    if (v && !parts.includes(String(v))) parts.push(String(v))
  }
  let head = e?.message || String(e)
  return parts.length ? `${head} (${parts.join(', ')})` : head
}

function isTransient(e) {
  let s = `${e?.message || ''} ${e?.code || ''} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`
  return /transient|fetch failed|network|timeout|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|UND_ERR/i.test(s)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// Request kecil tanpa body stream (token, init): retry kalau jaringan gagal.
async function request(url, opts, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, opts)
    } catch (e) {
      if (i >= tries || !isTransient(e)) throw new Error(errInfo(e))
      let delay = 2 ** i * 1000
      console.error(`drive-request retry ${i}/${tries} in ${delay / 1000}s (${errInfo(e)})`)
      await sleep(delay)
    }
  }
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4',
  mkv: 'video/x-matroska', mp3: 'audio/mpeg', zip: 'application/zip',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  apk: 'application/vnd.android.package-archive'
}

function guessMime(filename) {
  let ext = String(filename || '').split('.').pop().toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

function locate(name) {
  let home = process.env.HOME || ''
  let repoData = path.join(__dirname, '..', 'data', name)
  let homeData = home ? path.join(home, 'data', name) : null
  let candidates = [
    process.env[name === 'google_token.json' ? 'GOOGLE_TOKEN_PATH' : 'GOOGLE_SECRET_PATH'],
    repoData,
    homeData
  ].filter(Boolean)
  return candidates.find(p => {
    try { return fs.existsSync(p) } catch { return false }
  }) || null
}

async function getAccessToken() {
  let tokenPath = locate('google_token.json')
  let secretPath = locate('google_client_secret.json')
  if (!tokenPath || !secretPath) return null

  let tok = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
  let sec = JSON.parse(fs.readFileSync(secretPath, 'utf8')).installed
  if (!tok.refresh_token || !sec?.client_id) return null

  let res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: sec.client_id,
      client_secret: sec.client_secret,
      refresh_token: tok.refresh_token,
      grant_type: 'refresh_token'
    })
  })
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).access_token
}

// PUT satu chunk; retry error transien (5xx / 429 / network).
// Resumable upload idempoten per range, jadi retry dari offset yg sama aman.
// Jangan set Content-Length manual: kalau ada lib lain yang require('undici'),
// globalThis.fetch diganti fetch undici 8 yang menolak header itu
// (UND_ERR_INVALID_ARG "invalid content-length header"). Buffer body otomatis
// dihitung panjangnya oleh fetch.
async function putChunk(url, headers, body, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      let res = await fetch(url, { method: 'PUT', headers, body })
      if (res.status === 308 || res.ok) return res
      if (res.status >= 500 || res.status === 429) throw new Error(`transient ${res.status}`)
      throw new Error(`upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    } catch (e) {
      if (i >= tries || !isTransient(e)) throw new Error(errInfo(e))
      let delay = 2 ** i * 1000
      console.error(`drive-upload retry ${i}/${tries} in ${delay / 1000}s (${errInfo(e)})`)
      await sleep(delay)
    }
  }
}

/**
 * Upload Buffer ke Google Drive.
 * @returns {Promise<{url:string,id:string,name:string,size:number,mimetype:string}|null>}
 *   null kalau credential Google tidak tersedia (bukan error).
 */
async function upload(input, filename, mimetype) {
  let buffer = Buffer.isBuffer(input)
    ? input
    : (typeof input === 'string' && fs.existsSync(input) ? fs.readFileSync(input) : null)
  if (!buffer) throw new Error('Input harus Buffer atau path file yang valid')

  let name = filename || 'file'
  let mime = mimetype || guessMime(name)
  let total = buffer.length
  if (total === 0) return null

  let token = await getAccessToken()
  if (!token) return null

  // 1. buka sesi resumable
  let init = await request(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(total)
      },
      body: JSON.stringify({ name })
    }
  )
  if (!init.ok) throw new Error(`init failed: ${init.status} ${(await init.text()).slice(0, 200)}`)
  let sessionUrl = init.headers.get('location')
  if (!sessionUrl) throw new Error('tidak dapat sessionUrl dari Google')

  // 2. kirim per chunk
  let offset = 0
  let lastProgress = -1
  let fileId = null
  while (offset < total) {
    let end = Math.min(offset + CHUNK, total) - 1
    let chunk = buffer.subarray(offset, end + 1)
    let res = await putChunk(sessionUrl, {
      'Content-Range': `bytes ${offset}-${end}/${total}`
    }, chunk)
    if (res.ok) {
      let out = await res.json()
      fileId = out.id
      break
    }
    offset = end + 1
    let pct = Math.round((offset / total) * 100)
    if (pct !== lastProgress) {
      lastProgress = pct
      console.error(`drive-upload ${pct}%`)
    }
  }
  if (!fileId) return null

  // 3. sharing: file default-nya private, jadi link cuma bisa dibuka sama akun
  // yang login. Set anyone-reader supaya penerima bisa buka tanpa login.
  // Gagal di sini bukan fatal — link tetap dikembalikan, cuma butuh auth.
  try {
    let perm = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      }
    )
    if (!perm.ok) console.error(`drive: gagal set permission (${perm.status}), link butuh login`)
  } catch (e) {
    console.error('drive: gagal set permission:', e.message)
  }

  let out = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,webViewLink`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.ok ? r.json() : null).catch(() => null)

  return {
    url: out?.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
    id: fileId,
    name: out?.name || name,
    size: total,
    mimetype: mime
  }
}

module.exports = { upload, guessMime }