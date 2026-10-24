// Hitung jumlah pesan per member per grup.
// Data: global.db.data.totalPesan[<groupJid>] = { <nomor>: jumlah }
//
// Penghitungan dilakukan di hook `all` (dipanggil handler.js untuk SETIAP pesan,
// bukan cuma command), karena plugin command saja tidak akan pernah menghitung
// pesan biasa.

const normalize = jid => (jid || '').split('@')[0].split(':')[0]

// Jangan hitung perintah (diawali prefix global) sebagai "pesan" — kalau tidak,
// member yang banyak memakai command terlihat paling aktif.
// `global.prefix` di config.js berupa RegExp lebar (! # $ % + ... . -), jadi
// jangan hardcode daftar karakternya di sini — pakai nilai global apa adanya.
function prefixRegex() {
  let prefix = global.prefix
  if (prefix instanceof RegExp) return prefix
  if (Array.isArray(prefix)) return new RegExp('^(' + prefix.map(escapeRe).join('|') + ')')
  if (typeof prefix === 'string' && prefix) return new RegExp('^(' + escapeRe(prefix) + ')')
  return /^[!#$%+£¢€¥^°=¶∆×÷π√✓©®:;?&.\-]/
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isCommand(text) {
  if (!text) return false
  if (prefixRegex().test(text)) return true
  // Plugin customPrefix (cth exec `> `) tidak lewat global.prefix.
  for (let name of Object.keys(global.plugins || {})) {
    let p = global.plugins[name]
    if (p?.customPrefix instanceof RegExp && p.customPrefix.test(text)) return true
  }
  return false
}

// Nama fitur dari teks command, mengikuti urutan pencocokan handler.js:
// customPrefix dulu, lalu prefix global. Mengembalikan null kalau bukan command.
function commandName(text) {
  if (!text) return null
  // 1. customPrefix
  for (let name of Object.keys(global.plugins || {})) {
    let p = global.plugins[name]
    if (!(p?.customPrefix instanceof RegExp)) continue
    let match = p.customPrefix.exec(text)
    if (!match) continue
    // Plugin customPrefix (cth `plugins/exec.js`) menerima KODE/PERINTAH shell
    // sebagai isinya, bukan nama command — `>> echo hi` bukan fitur "echo".
    // Kelompokkan semuanya di bawah nama plugin supaya statistik tidak penuh
    // nama perintah shell acak.
    return (p.name || name.replace(/\.js$/, '')).toLowerCase()
  }
  // 2. prefix global
  let usedPrefix = (text.match(prefixRegex()) || [''])[0]
  if (!usedPrefix) return null
  let cmd = text.replace(usedPrefix, '').trim().split(/ +/)[0].toLowerCase()
  return cmd || null
}

// Nomor HP pengirim. LID di-resolve lewat lidCache kalau bisa; kalau tidak,
// pakai LID apa adanya supaya pesan tetap terhitung (bukan hilang / crash).
function phoneOf(jid) {
  let n = normalize(jid)
  if (!n) return null
  if (String(jid).endsWith('@lid') && global.lidCache?.[n]) return normalize(global.lidCache[n])
  return n
}

// Statistik pemakaian fitur: global.db.data.totalPesan[gid].__fitur
//   { <namaCommand>: { total, oleh: { <nomor>: jumlah }, terakhir } }
// Kunci diawali '__' supaya tidak tertukar dengan nomor HP member.
const FITUR_KEY = '__fitur'

function getFitur(gid) {
  let chat = getChat(gid)
  if (!chat) return null
  let f = chat[FITUR_KEY]
  if (!f || typeof f !== 'object' || Array.isArray(f)) f = chat[FITUR_KEY] = {}
  return f
}

function getChat(gid) {
  let all = global.db?.data
  if (!all) return null
  let db = all.totalPesan
  if (!db || typeof db !== 'object' || Array.isArray(db)) db = all.totalPesan = {}
  let chat = db[gid]
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) chat = db[gid] = {}
  return chat
}

// Pecah daftar baris jadi beberapa pesan kalau kepanjangan.
// WhatsApp punya batas panjang pesan; tanpa ini, grup besar gagal terkirim.
// Potong di batas baris supaya tidak memutus satu entri.
const MAX_CHARS = 3500

function chunkLines(lines, max = MAX_CHARS) {
  let chunks = []
  let cur = ''
  for (let line of lines) {
    // Satu baris sendiri sudah kepanjangan -> kirim apa adanya
    if (line.length > max) {
      if (cur) { chunks.push(cur); cur = '' }
      chunks.push(line)
      continue
    }
    if (cur && (cur.length + 1 + line.length) > max) {
      chunks.push(cur)
      cur = line
    } else {
      cur = cur ? cur + '\n' + line : line
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

// Label yang enak dibaca + JID untuk mention
function jidFor(key, domain) {
  if (!key) return null
  let s = String(key)
  if (s.includes('@')) return s
  return `${s}@${domain || 's.whatsapp.net'}`
}

const plugin = {
  name: 'totalpesan',
  description: 'Lihat jumlah pesan tiap member di grup ini.',
  aliases: ['totalchat', 'topchat', 'leaderboard'],
  tags: ['group'],
  permissions: { groupOnly: true },
  command: /^(totalpesan|totalchat|topchat|leaderboard)$/i,

  // --- Hitung tiap pesan masuk + pemakaian fitur ---
  all: async (m) => {
    if (!m.isGroup || !m.chat) return
    if (!m.chat.endsWith('@g.us')) return
    if (m.fromMe) return                       // pesan bot sendiri tidak dihitung
    if (!m.sender) return                      // LID tak ter-resolve (lihat lib/simple.js)
    let key = phoneOf(m.sender)
    if (!key) return

    let chat = getChat(m.chat)
    if (!chat) return

    // Command dicatat sebagai PEMAKAIAN FITUR, bukan sebagai "pesan".
    let cmd = commandName(m.text)
    if (cmd || isCommand(m.text)) {
      if (!cmd) return                         // command tanpa nama (exec) -> abaikan
      let fitur = getFitur(m.chat)
      if (!fitur) return
      let f = fitur[cmd]
      if (!f || typeof f !== 'object' || Array.isArray(f)) f = { total: 0, oleh: {} }
      if (!f.oleh || typeof f.oleh !== 'object' || Array.isArray(f.oleh)) f.oleh = {}
      f.total = (Number(f.total) || 0) + 1
      f.oleh[key] = (Number(f.oleh[key]) || 0) + 1
      f.terakhir = Date.now()
      fitur[cmd] = f
      // Tidak panggil global.db.write() tiap pesan: DB disimpan tiap menit oleh
      // main.js (setInterval), cukup andalkan itu supaya tidak hammer disk.
      return
    }

    chat[key] = (Number(chat[key]) || 0) + 1
  },

  run: async (m, { conn, participants, args }) => {
    let chat = getChat(m.chat)
    if (!chat) return m.reply('❌ Gagal akses database.')

    let sub = (args?.[0] || '').toLowerCase()

    // ---------- mode fitur: !totalpesan fitur ----------
    if (sub === 'fitur' || sub === 'cmd' || sub === 'command') {
      let fitur = getFitur(m.chat)
      let entries = Object.entries(fitur || {}).filter(([, v]) => v && Number(v.total) > 0)
      if (!entries.length) {
        return m.reply('Belum ada pemakaian fitur/command yang tercatat di grup ini.')
      }
      entries.sort((a, b) => (Number(b[1].total) || 0) - (Number(a[1].total) || 0))

      // Peta nomor -> nama dari metadata grup
      let parts = participants
      if (!parts?.length) parts = await conn.group.queryGroupMetadata(m.chat).then(r => r?.participants).catch(() => [])
      let nameOf = new Map()
      for (let p of parts || []) {
        let num = phoneOf(p.phoneNumber || p.jid || p.lid)
        if (!num) continue
        let name = p.displayName || p.username || ''
        if (name) nameOf.set(num, name)
      }

      let totalAll = entries.reduce((a, [, v]) => a + (Number(v.total) || 0), 0)
      let lines = [
        '*🔧 Pemakaian Fitur/Command*',
        '',
        `*Total*: *${totalAll}* kali dari *${entries.length}* fitur berbeda`,
        ''
      ]
      // Semua fitur ditampilkan (tidak dipotong).
      for (let [nama, v] of entries) {
        lines.push(`*${nama}*: *${v.total}* kali`)
        // pengguna teratas untuk fitur ini (maks 3)
        let users = Object.entries(v.oleh || {})
          .map(([k, n]) => [k, Number(n) || 0])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
        if (users.length) {
          lines.push('   ' + users.map(([k, n]) => {
            let nm = nameOf.get(k)
            return `${nm ? nm + ' ' : ''}@${k} (${n})`
          }).join(', '))
        }
      }

      let mention = new Set()
      for (let [, v] of entries) {
        for (let [k] of Object.entries(v.oleh || {})) mention.add(jidFor(k))
      }
      lines.push('', `Lihat pesan member: *!totalpesan*`)

      // Kirim per potongan; mention hanya di pesan pertama cukup, tapi
      // sertakan di semua potongan supaya nama tetap ter-resolve.
      let fiturChunks = chunkLines(lines)
      for (let i = 0; i < fiturChunks.length; i++) {
        await conn.message.send(m.chat, fiturChunks[i], {
          quote: i === 0 ? m : undefined,
          mentions: [...mention]
        })
      }
      return
    }

    // Pastikan semua member terdaftar (nilai 0 kalau belum pernah kirim pesan).
    // Ambil metadata sendiri kalau ctx tidak membawanya (plugin ini tidak
    // mendeklarasikan `participants: true` supaya tidak query tiap pesan).
    let parts = participants
    if (!parts?.length) parts = await conn.group.queryGroupMetadata(m.chat).then(r => r?.participants).catch(() => [])

    let me = phoneOf(conn.getCredentials()?.meJid)
    let nameOf = new Map()
    for (let p of parts || []) {
      let num = phoneOf(p.phoneNumber || p.jid || p.lid)
      if (!num) continue
      if (num === me) continue          // bot sendiri tidak perlu masuk daftar (selalu 0)
      if (!chat[num]) chat[num] = 0
      let name = p.displayName || p.username || ''
      if (name) nameOf.set(num, name)
    }

    let sorted = Object.entries(chat)
      .filter(([k]) => k !== FITUR_KEY)          // __fitur bukan member
      .map(([k, v]) => [k, Number(v) || 0])
      .filter(([, v]) => v >= 0)
      .sort((a, b) => b[1] - a[1])

    if (!sorted.length) return m.reply('Belum ada pesan yang tercatat di grup ini.')

    let totalM = sorted.reduce((acc, [, v]) => acc + v, 0)
    let aktif = sorted.filter(([, v]) => v > 0).length

    let lines = sorted.map(([key, total], i) => {
      let nm = nameOf.get(key)
      return `*${i + 1}.* ${nm ? nm + ' ' : ''}@${key}: *${total}* pesan`
    })

    let head = `*📊 Total Pesan Grup*\n\n*Total*: *${totalM}* pesan dari *${sorted.length}* orang` +
      (aktif !== sorted.length ? ` (${aktif} aktif)` : '')

    // Semua member ditampilkan (tidak dipotong), dipecah per pesan kalau panjang.
    let chunks = chunkLines([head, '', ...lines])
    let mentions = sorted.map(([key]) => jidFor(key)).filter(Boolean)
    for (let i = 0; i < chunks.length; i++) {
      await conn.message.send(m.chat, chunks[i], {
        quote: i === 0 ? m : undefined,
        mentions
      })
    }
    return
  }
}

plugin.help = ['totalpesan', 'totalpesan fitur']

module.exports = plugin

// --- Ekspor internal untuk test ---
plugin.getChat = getChat
plugin.phoneOf = phoneOf
plugin.isCommand = isCommand
plugin.commandName = commandName
plugin.getFitur = getFitur
plugin.chunkLines = chunkLines
plugin.MAX_CHARS = MAX_CHARS
plugin.FITUR_KEY = FITUR_KEY
plugin.prefixRegex = prefixRegex
plugin.jidFor = jidFor
