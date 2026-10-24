// Auto buka/tutup grup terjadwal. Command + tick scheduler (setInterval) di file
// yang sama, tanpa dependensi luar (node-schedule/moment-timezone tidak ada di
// package.json repo ini).

const TZ = 'Asia/Jakarta' // WIB, tanpa DST — offset tetap UTC+7
const TICK_MS = 30 * 1000

// --- Waktu WIB manual (Date native tidak bisa format timezone lain) ---
const pad2 = n => String(Math.floor(n)).padStart(2, '0')

// Clock bisa diganti saat test: handler.setClock(() => fakeMs)
let clock = () => Date.now()

function nowWib(date) {
  if (!date) date = new Date(clock())
  let shifted = new Date(date.getTime() + 7 * 3600 * 1000) // geser ke UTC+7
  let day = shifted.getUTCDay()
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    hhmm: `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    label: `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())} WIB`,
    day
  }
}

const DAYS = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu']
// Alias hari — jangan pakai prefix guess: 'minggu' tidak diawali 'mgg', dan
// 'min' ambigu (bisa minggu). Jadi tabel alias eksplisit saja.
const DAY_ALIAS = {
  minggu: 0, ming: 0, mgg: 0, mg: 0, min: 0, ahad: 0, sun: 0,
  senin: 1, sen: 1, mon: 1,
  selasa: 2, sel: 2, tue: 2,
  rabu: 3, rab: 3, wed: 3,
  kamis: 4, kam: 4, thu: 4,
  jumat: 5, jum: 5, jm: 5, fri: 5,
  sabtu: 6, sab: 6, sat: 6
}

// --- Parser jam: "21", "21:30", "05.00", "0500", "senin 22:00" ---
function parseTime(raw, { allow24 = true } = {}) {
  let s = String(raw ?? '').trim().toLowerCase().replace(/[.:]/g, ':').replace(/wib$/g, '').trim()
  if (!s) return null
  let m = /^([a-z]{3,})?(.*)$/.exec(s)
  let dayToken = m?.[1] || ''
  s = (m?.[2] || '').trim()

  let hour, minute
  if (/^\d{1,2}$/.test(s)) {
    hour = parseInt(s, 10); minute = 0
  } else if (/^\d{1,2}:\d{1,2}$/.test(s)) {
    [hour, minute] = s.split(':').map(n => parseInt(n, 10))
  } else if (/^\d{3,4}$/.test(s)) {
    hour = parseInt(s.slice(0, -2), 10); minute = parseInt(s.slice(-2), 10)
  } else {
    return null
  }
  if (allow24 && hour === 24 && minute === 0) hour = 0
  if (isNaN(hour) || isNaN(minute) || hour > 23 || minute > 59) return null

  let day = null
  if (dayToken) {
    if (!(dayToken in DAY_ALIAS)) return null
    day = DAY_ALIAS[dayToken]
  }
  return { hour, minute, minutes: hour * 60 + minute, day, raw: String(raw) }
}

const fmt = t => `${pad2(t.hour)}:${pad2(t.minute)}`
const fmtFull = t => `${t.day !== null && t.day !== undefined ? DAYS[t.day] + ' ' : ''}${fmt(t)} WIB`

// --- Config per grup: global.db.data.chats[<jid>].autoGc ---
// { close: {hour,minute,day}, open: {...}, enabled, status: 'none'|'closed'|'opened', lastChangeAt }
function getChat(groupJid) {
  let chats = global.db?.data?.chats
  if (!chats || !groupJid) return null
  let chat = chats[groupJid]
  if (typeof chat !== 'object' || chat === null) chats[groupJid] = chat = {}
  return chat
}

// --- Ambil semua koneksi aktif: bot utama + jadibot ---
// lib/jadibot menyimpan Map<ownerJid, {client, phone, status}>, bukan global.jadibots.
function activeConns() {
  let list = []
  if (global.conn) list.push({ tag: 'utama', conn: global.conn, ready: true })
  try {
    let jadibot = require('../lib/jadibot')
    for (let [ownerJid, s] of jadibot.sessions || []) {
      if (!s?.client) continue
      list.push({
        tag: `jadibot ${ownerJid.split('@')[0]}`,
        conn: s.client,
        ready: s.status === 'online' || s.status === 'paired'
      })
    }
  } catch (e) {
    // lib/jadibot belum siap (startup) — cukup pakai bot utama.
  }
  return list
}

// --- Perubahan setting grup. zapo: conn.group.setSetting(jid, 'announcement', bool) ---
async function applySetting(conn, groupJid, closed) {
  await conn.group.setSetting(groupJid, 'announcement', closed)
}

// Pastikan setting grup sesuai status di DB (idempotent). Dipakai saat mengaktifkan
// fitur dan saat tick gagal di putaran sebelumnya.
async function ensureApplied(groupJid, chat) {
  let cfg = chat.autoGc
  let want = cfg.status
  if (want !== 'closed' && want !== 'opened') return { ok: false, reason: 'status belum jelas' }
  let closed = want === 'closed'
  for (let { conn, ready } of activeConns()) {
    if (!ready) continue
    try {
      await applySetting(conn, groupJid, closed)
      return { ok: true }
    } catch (e) {
      // coba koneksi berikutnya (bot utama bisa saja bukan admin di grup ini)
    }
  }
  return { ok: false, reason: 'tidak ada koneksi yang bisa mengubah grup (bot admin?)' }
}

// Menit sejak kemunculan TERAKHIR sebuah titik jadwal (selalu <= 0).
// - jadwal harian: siklus 24 jam
// - jadwal mingguan: siklus 7 hari, jadi "senin 22:00" hari ini dan hari itu
//   minggu depan menghasilkan nilai berbeda (yang lama lebih negatif).
function sinceLast(t, now) {
  let target = t.hour * 60 + t.minute
  let cycle, dayDelta
  if (t.day === null || t.day === undefined) {
    cycle = 1440
    dayDelta = 0
  } else {
    cycle = 7 * 1440
    dayDelta = (t.day - now.day + 7) % 7
  }
  let d = dayDelta * 1440 + target - now.minutes
  if (d > 0) d -= cycle   // belum tiba di siklus ini → mundur satu siklus
  return d
}

// Status yang seharusnya berlaku SEKARANG: 'closed' | 'opened'.
//
// Cara berpikirnya: tutup terakhir dan buka terakhir sama-sama "sudah lewat
// berapa menit". Kalau buka terakhir LEBIH LAMA daripada tutup terakhir,
// berarti jendela tutup yang sekarang belum ditutup oleh jadwal buka → masih
// tertutup. Sebaliknya, kalau buka terakhir lebih baru, jendela sudah selesai.
//
// Jangan diganti jadi sekadar membandingkan jam (tanpa hari): untuk jadwal
// mingguan lintas hari, Senin 06:00 harus 'opened' walau jadwal tutupnya
// Senin 22:00 (jendela belum mulai), sementara Senin 23:00 harus 'closed'.
//
// Sudah diuji untuk: harian 21→5, harian 22→6, jendela lewat tengah malam,
// mingguan Senin 22:00→Selasa 06:00, dan mingguan Jumat 22:00→Senin 06:00.
function desiredStatus(now, cfg) {
  let sinceClose = sinceLast(cfg.close, now)   // selalu <= 0
  let sinceOpen = sinceLast(cfg.open, now)     // selalu <= 0
  // Lebih negatif = lebih lama lalu.
  return sinceOpen < sinceClose ? 'closed' : 'opened'
}

function inClosedWindow(now, cfg) {
  return desiredStatus(now, cfg) === 'closed'
}

// --- Tick: cek tiap TICK_MS ---
async function checkGroups() {
  if (!global.db?.data?.chats) return
  let now = nowWib()
  let conns = activeConns()
  if (!conns.length) return

  for (let groupJid of Object.keys(global.db.data.chats)) {
    if (!groupJid.endsWith('@g.us')) continue
    let chat = global.db.data.chats[groupJid]
    let cfg = chat?.autoGc
    if (!cfg?.close || !cfg.open || cfg.enabled === false) continue

    // Status yang seharusnya SEKARANG. desiredStatus cuma minta perubahan kalau
    // titik jadwalnya memang sudah lewat, jadi tidak perlu guard tambahan.
    let target = desiredStatus(now, cfg)
    if (cfg.status === target) continue          // sudah sesuai, tidak ada kerjaan

    // Status disimpan HANYA setelah setSetting berhasil. Kalau ditandai di awal,
    // kegagalan (bot bukan admin / tidak ada koneksi) akan terbaca "sudah
    // selesai" dan grup tidak pernah disusulkan sampai besok.
    let closed = target === 'closed'
    let ok = false
    for (let { conn, ready } of conns) {
      if (!ready) continue
      try {
        await applySetting(conn, groupJid, closed)
        ok = true
        await conn.message.send(groupJid, [
          closed ? '⛔ *GRUP DITUTUP* (otomatis)' : '✅ *GRUP DIBUKA* (otomatis)',
          '',
          closed
            ? `Jadwal buka: *${fmtFull(cfg.open)}* — sekarang hanya admin yang bisa kirim pesan.`
            : `Jadwal tutup: *${fmtFull(cfg.close)}* — sekarang semua member bisa kirim pesan.`
        ].join('\n')).catch(() => {})
        break
      } catch (e) {
        // gagal di koneksi ini → coba koneksi berikutnya
      }
    }
    if (ok) {
      cfg.status = target
      cfg.lastChangeAt = Date.now()
      delete cfg.lastError
      global.db.write()
    } else {
      cfg.lastError = `gagal ${target} @ ${now.label}`
      cfg.lastErrorAt = Date.now()
      global.db.write()
      console.error(`[autogc] gagal ${target} grup ${groupJid} (${now.label}): tidak ada koneksi yang bisa mengubah setting. Dicoba lagi tiap ${TICK_MS / 1000}s.`)
    }
  }
}

// --- Command ---
const plugin = {
  name: 'autogc',
  description: 'Auto tutup/buka grup terjadwal (jam tutup + jam buka, WIB).',
  aliases: ['autogrup', 'autotutup'],
  tags: ['group'],
  permissions: { groupOnly: true, adminOnly: true, botAdmin: true },
  command: /^(autogc|autogrup|autotutup)$/i,
  run: async (m, { conn, args, usedPrefix, command }) => {
    let chat = getChat(m.chat)
    if (!chat) return m.reply('❌ Gagal akses database chat.')
    let sub = (args[0] || '').toLowerCase()
    let cfg = chat.autoGc
    let base = `${usedPrefix}${command}`

    // --- tanpa argumen: help ---
    if (!args.length) {
      return m.reply([
        '*⏰ AUTO GRUP (BUKA/TUTUP)*',
        '',
        `*${base} <jamTutup> <jamBuka>*`,
        `Contoh: *${base} 21 5* → tutup *21:00 WIB*, buka *05:00 WIB*`,
        '',
        'Format jam: `21` · `21:30` · `2100`',
        'Mingguan (opsional): `senin 22:00`',
        '',
        `*${base} on|off* — aktif/nonaktif, jadwal tetap disimpan`,
        `*${base} close|open* — tutup/buka grup sekarang juga`,
        `*${base} hapus* — hapus jadwal sama sekali`,
        `*${base} status* — lihat status jadwal`,
        '',
        'Zona waktu: *WIB (Asia/Jakarta)*. Cek tiap 30 detik.'
      ].join('\n'))
    }

    // --- status ---
    if (sub === 'status') {
      if (!cfg?.close) return m.reply(`⏰ Auto grup *belum diaktifkan*.\nContoh: *${base} 21 5*`)
      return m.reply([
        '*⏰ STATUS AUTO GRUP*',
        `Master: ${cfg.enabled === false ? 'OFF 🔕' : 'ON ✅'}`,
        `🔒 Tutup: *${fmtFull(cfg.close)}*`,
        `🔓 Buka: *${fmtFull(cfg.open)}*`,
        `Status grup: ${cfg.status === 'closed' ? '🔒 tertutup' : cfg.status === 'opened' ? '🔓 terbuka' : '— belum pernah diubah otomatis'}`,
        `🕒 Sekarang: ${nowWib().label}`
      ].join('\n'))
    }

    // --- on / off (tanpa hapus jadwal) ---
    if (sub === 'on' || sub === 'off') {
      if (!cfg?.close) return m.reply(`❌ Belum ada jadwal. Set dulu: *${base} 21 5*`)
      cfg.enabled = sub === 'on'
      global.db.write()
      return m.reply(cfg.enabled
        ? `✅ Auto grup *diaktifkan*.\n🔒 Tutup ${fmtFull(cfg.close)} · 🔓 Buka ${fmtFull(cfg.open)}`
        : '🔕 Auto grup *dimatikan* (jadwal masih tersimpan).')
    }

    // --- hapus jadwal ---
    if (sub === 'hapus' || sub === 'delete' || sub === 'reset') {
      if (!cfg) return m.reply('ℹ️ Tidak ada jadwal untuk dihapus.')
      delete chat.autoGc
      global.db.write()
      return m.reply('❌ Jadwal auto grup *dihapus*.')
    }

    // --- close / open sekarang ---
    if (sub === 'close' || sub === 'tutup' || sub === 'open' || sub === 'buka') {
      let closed = sub === 'close' || sub === 'tutup'
      try {
        await applySetting(conn, m.chat, closed)
      } catch (e) {
        return m.reply('❌ Gagal: ' + (e.message || e))
      }
      if (cfg) { cfg.status = closed ? 'closed' : 'opened'; cfg.lastChangeAt = Date.now(); global.db.write() }
      return m.reply(closed
        ? '🔒 Grup *ditutup* sekarang. Jadwal otomatis tetap berjalan.'
        : '🔓 Grup *dibuka* sekarang. Jadwal otomatis tetap berjalan.')
    }

    if (sub === 'cek' || sub === 'test') {
      await m.reply('⏳ Menjalankan pengecekan manual...')
      let res = await ensureApplied(m.chat, chat)
      return m.reply(res.ok ? '✅ Pengecekan selesai — setting grup sudah diselaraskan.' : `⚠️ ${res.reason}`)
    }

    // --- set jadwal ---
    let close = parseTime(args[0])
    let open = parseTime(args[1])
    if (args.length !== 2 || !close || !open) {
      return m.reply(`❌ Format: *${base} <jamTutup> <jamBuka>*\nContoh: *${base} 21 5* · *${base} 21:30 05:00*`)
    }
    if (close.minutes === open.minutes && close.day === open.day) {
      return m.reply('❌ Jam tutup dan jam buka tidak boleh sama!')
    }

    chat.autoGc = {
      close: { hour: close.hour, minute: close.minute, day: close.day },
      open: { hour: open.hour, minute: open.minute, day: open.day },
      enabled: true,
      status: 'none',
      updatedAt: Date.now()
    }

    // Kalau sekarang berada di dalam jendela tutup/buka, langsung selaraskan.
    let now = nowWib()
    let wantClosed = inClosedWindow(now, chat.autoGc)
    let applied = null
    if (wantClosed !== null) {
      chat.autoGc.status = wantClosed ? 'closed' : 'opened'
      applied = await ensureApplied(m.chat, chat)
    }
    global.db.write()

    let lines = [
      '✅ *Auto grup diaktifkan!*',
      `🔒 Tutup: *${fmtFull(close)}*`,
      `🔓 Buka:  *${fmtFull(open)}*`,
      `🕒 Sekarang: ${now.label}`
    ]
    if (applied?.ok) lines.push(wantClosed ? '→ Grup langsung *ditutup* sekarang.' : '→ Grup langsung *dibuka* sekarang.')
    else if (applied && !applied.ok) lines.push(`⚠️ Jadwal disimpan, tapi gagal menyetel grup sekarang (${applied.reason}).`)
    lines.push('', `Matikan: *${base} off* · Hapus jadwal: *${base} hapus*`)
    return m.reply(lines.join('\n'))
  }
}

plugin.help = ['autogc <jamTutup> <jamBuka>', 'autogc on|off|close|open|hapus|status']

// Ekspor internal untuk test (tidak dibaca loader, hanya dipakai file test).
plugin.checkGroups = checkGroups
plugin.nowWib = nowWib
plugin.parseTime = parseTime
plugin.inClosedWindow = inClosedWindow
plugin.DAYS = DAYS
plugin.DAY_ALIAS = DAY_ALIAS
plugin.setClock = fn => { clock = fn || (() => Date.now()) }
plugin.desiredStatus = desiredStatus
plugin.sinceLast = sinceLast

module.exports = plugin

// Bersihkan interval lama kalau plugin di-reload (mencegah timer numpuk)
if (global.autoGcTimer) clearInterval(global.autoGcTimer)
global.autoGcTimer = setInterval(() => {
  checkGroups().catch(e => console.error('[autogc]', e.message || e))
}, TICK_MS)
global.autoGcTimer.unref?.()
