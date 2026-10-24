// Sistem peringatan (warn) member grup. Data disimpan di
// global.db.data.settings['warn:<groupJid>'] → { <nomor>: { count, lastAt, by, reasons: [] } }
// Kunci memakai nomor HP (bukan LID) supaya stabil walau addressing mode grup LID.

const DEFAULT_MAX = 5
const MAX_REASONS = 5
const MAX_REASON_LEN = 120

// Normalisasi JID ke nomor tanpa device/domain — aman bandingkan PN vs LID
const normalize = jid => (jid || '').split('@')[0].split(':')[0]

function cfgKey(chat) {
  return `warn:${chat}`
}

function getStore(chat) {
  let all = global.db?.data?.settings
  if (!all) return null
  let key = cfgKey(chat)
  let store = all[key]
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    store = {}
    all[key] = store
  }
  return store
}

// Nomor HP untuk entri penyimpanan. LID dicoba resolve lewat lidCache dulu.
//
// Kalau LID tidak ada di cache (cache hanya hidup di memori, kosong lagi
// setelah restart), JANGAN buang member-nya: pakai LID sebagai kunci. Entri
// tetap tercatat dan kick tetap bisa menargetkan LID tersebut — jauh lebih baik
// daripada warn hilang / crash. Konsekuensinya: kalau nomor yang sama pernah
// di-warn sebagai PN dan sebagai LID yang tidak ter-resolve, dua entri terpisah
// (masing-masing tetap dihitung; bisa digabung nanti lewat delwarn).
function phoneOf(jid) {
  let n = normalize(jid)
  if (!n) return null
  if (String(jid).endsWith('@lid') && global.lidCache) {
    let resolved = global.lidCache[n]
    if (resolved) return normalize(resolved) || resolved
  }
  return n
}

// Domain JID asli dari sebuah JID ("6281@s.whatsapp.net" -> "s.whatsapp.net",
// "9988@lid" -> "lid"). Kalau LID berhasil di-resolve, hasilnya nomor HP.
function domainOf(jid) {
  let s = String(jid || '')
  let n = normalize(s)
  if (s.endsWith('@lid') && global.lidCache?.[n]) return 's.whatsapp.net'
  let at = s.split('@')[1]
  return at ? at.split(':')[0] : 's.whatsapp.net'
}

// JID yang layak dipakai untuk mention/kick.
// Jangan menebak dari panjang angka: LID bisa pendek (8 digit) dan tidak bisa
// dibedakan dari nomor HP. Simpan domain aslinya saat warn dibuat.
function jidOf(key, domain) {
  if (!key) return null
  let s = String(key)
  if (s.includes('@')) return s
  return `${s}@${domain || 's.whatsapp.net'}`
}

// Cari wakil "nomor" untuk tiap JID di grup (PN, jid, lid semuanya dianggap satu orang)
function jidsFor(entry, participants) {
  if (!participants?.length) return []
  return participants
    .filter(p => [p.phoneNumber, p.jid, p.lid].some(j => j && phoneOf(j) === entry))
    .flatMap(p => [p.phoneNumber, p.jid, p.lid])
    .filter(Boolean)
}

// Target: mention > reply > nomor di args
function resolveTargets(m, args) {
  if (m.mentionedJid?.length) return [...m.mentionedJid]
  if (m.quotedSender) return [m.quotedSender]
  let num = (args[0] || '').replace(/[^0-9]/g, '')
  if (num.length >= 10) return [`${num}@s.whatsapp.net`]
  return []
}

function formatDate(ms) {
  if (!ms) return '-'
  let d = new Date(ms + 7 * 3600 * 1000)
  let p = n => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} WIB`
}

module.exports = {
  name: 'warn',
  description: 'Beri peringatan ke member. 5× warn = auto kick dari grup.',
  aliases: ['warning', 'peringatan', 'delwarn', 'hapuswarn', 'listwarn', 'daftarwarn'],
  tags: ['group'],
  permissions: { groupOnly: true, adminOnly: true, botAdmin: true },
  command: /^(warn|warning|peringatan|delwarn|hapuswarn|listwarn|daftarwarn)$/i,
  run: async (m, { conn, args, command, groupMetadata, participants, isOwner }) => {
    let cmd = String(command || '').toLowerCase()
    let store = getStore(m.chat)
    if (!store) return m.reply('❌ Gagal akses database.')

    let me = normalize(conn.getCredentials()?.meJid)
    let owners = (global.owner || []).map(o => normalize(Array.isArray(o) ? o[0] : o))

    // ---------- listwarn ----------
    if (cmd === 'listwarn' || cmd === 'daftarwarn') {
      let entries = Object.entries(store).filter(([, v]) => v && v.count > 0)
      if (!entries.length) return m.reply('✅ Tidak ada member yang kena warn di grup ini.')
      entries.sort((a, b) => b[1].count - a[1].count || (b[1].lastAt || 0) - (a[1].lastAt || 0))

      // Ambil nama dari metadata grup kalau ada
      let nameOf = new Map()
      for (let p of participants || []) {
        let num = phoneOf(p.phoneNumber || p.jid || p.lid)
        if (num) nameOf.set(num, p.displayName || '')
      }

      let lines = [`*⚠️ DAFTAR WARN* (${entries.length} member)`, '']
      for (let [num, v] of entries.slice(0, 30)) {
        let nm = nameOf.get(num)
        lines.push(`• ${nm ? nm + ' — ' : ''}@${num}`)
        lines.push(`   Warn: *${v.count}* · terakhir: ${formatDate(v.lastAt)}`)
        if (v.reasons?.length) lines.push(`   Alasan: ${v.reasons.slice(-1)[0]}`)
      }
      if (entries.length > 30) lines.push('', `…dan ${entries.length - 30} member lainnya.`)
      lines.push('', `Hapus: *!delwarn @member* · Batas kick: *${DEFAULT_MAX}× warn*`)

      return conn.message.send(m.chat, lines.join('\n'), {
        quote: m,
        mentions: entries.slice(0, 30).map(([num]) => `${num}@s.whatsapp.net`)
      })
    }

    // ---------- delwarn ----------
    if (cmd === 'delwarn' || cmd === 'hapuswarn') {
      let targets = resolveTargets(m, args)
      if (!targets.length) {
        return m.reply('Tag, reply, atau tulis nomor member yang mau dihapus warn-nya.\nContoh: *!delwarn @628xxx*')
      }
      let done = [], missing = []
      for (let t of targets) {
        let num = phoneOf(t)
        if (!num) { missing.push(normalize(t)); continue }
        if (store[num]) {
          let old = store[num].count
          delete store[num]
          done.push({ num, old })
        } else {
          missing.push(num)
        }
      }
      global.db.write()
      let lines = []
      if (done.length) {
        lines.push(`✅ Warn dihapus: ${done.map(d => `@${d.num}`).join(', ')}`)
        let detail = done.filter(d => d.old).map(d => `${d.num}: ${d.old} → 0`)
        if (detail.length) lines.push(detail.join('\n'))
      }
      if (missing.length) lines.push(`ℹ️ Tidak ada warn: ${missing.join(', ')}`)
      if (!lines.length) return m.reply('ℹ️ Tidak ada yang dihapus.')
      return conn.message.send(m.chat, lines.join('\n'), {
        quote: m,
        mentions: done.map(d => `${d.num}@s.whatsapp.net`)
      })
    }

    // ---------- warn ----------
    let targets = resolveTargets(m, args)
    // Alasan = sisa args kalau target diambil dari nomor, atau semua args kalau via mention/reply
    let reason
    if (m.mentionedJid?.length || m.quotedSender) reason = args.join(' ').trim()
    else reason = args.slice(1).join(' ').trim()

    if (!targets.length) {
      return m.reply([
        '*⚠️ CARA PAKAI WARN*',
        '',
        '• *!warn @member [alasan]*',
        '• *!warn* (reply pesan member)',
        '• *!warn 628xxx [alasan]*',
        '',
        '*!delwarn @member* — hapus warn',
        '*!listwarn* — lihat semua yang kena warn',
        '',
        `Member dengan *${DEFAULT_MAX}× warn* otomatis di-kick dari grup.`
      ].join('\n'))
    }

    let results = []
    for (let t of targets) {
      let num = phoneOf(t)
      if (!num) continue

      // Proteksi: bot sendiri, owner, dan admin grup tidak bisa di-warn
      if (num === me) { results.push({ num, skip: 'bot sendiri' }); continue }
      if (owners.includes(num)) { results.push({ num, skip: 'owner bot' }); continue }
      let isTargetAdmin = (participants || []).some(p =>
        p.isAdmin && [p.phoneNumber, p.jid, p.lid].some(j => j && phoneOf(j) === num))
      if (isTargetAdmin) { results.push({ num, skip: 'admin grup' }); continue }

      let entry = store[num]
      if (!entry || typeof entry !== 'object') entry = { count: 0, reasons: [] }
      if (!Array.isArray(entry.reasons)) entry.reasons = []

      entry.count = (Number(entry.count) || 0) + 1
      entry.lastAt = Date.now()
      entry.by = m.sender || null
      if (reason) {
        entry.reasons.push(reason.slice(0, MAX_REASON_LEN))
        if (entry.reasons.length > MAX_REASONS) entry.reasons = entry.reasons.slice(-MAX_REASONS)
      }
      store[num] = entry
      results.push({ num, phone: num, domain: domainOf(t), entry })
    }

    global.db.write()

    // Laporkan yang dilewati
    let skipped = results.filter(r => r.skip)
    let scored = results.filter(r => r.entry)
    if (skipped.length) {
      await m.reply(`⚠️ Dilewati: ${skipped.map(s => `@${s.num} (${s.skip})`).join(', ')}`).catch(() => {})
    }
    if (!scored.length) return

    // Kick yang mencapai batas
    let kicked = []
    for (let r of scored.filter(r => r.entry.count >= DEFAULT_MAX)) {
      let jids = jidsFor(r.num, participants)
      // Sertakan JID target asli sebagai cadangan, lalu JID dari kuncinya sendiri
      // (penting saat kunci berupa LID yang tidak ter-resolve ke nomor).
      let targetJids = [...new Set([
        ...jids,
        ...targets.filter(t => phoneOf(t) === r.num),
        jidOf(r.phone || r.num, r.domain)
      ])].filter(Boolean)
      if (!targetJids.length) continue
      try {
        let outcomes = await conn.group.removeParticipants(m.chat, targetJids)
        let ok = outcomes.some(o => o.status === 'ok')
        if (ok) {
          kicked.push(r.num)
          delete store[r.num]
        } else {
          r.kickError = `code ${outcomes?.[0]?.code ?? '?'}`
        }
      } catch (e) {
        r.kickError = e.message || String(e)
      }
    }
    global.db.write()

    let lines = []
    for (let r of scored) {
      if (kicked.includes(r.num)) {
        lines.push(`⛔ @${r.num} di-*kick* — sudah *${r.entry.count}/${DEFAULT_MAX}* warn.`)
      } else {
        let sisa = Math.max(0, DEFAULT_MAX - r.entry.count)
        lines.push(`⚠️ @${r.num} — warn *${r.entry.count}/${DEFAULT_MAX}*${reason ? `\n   Alasan: ${reason}` : ''}`)
        if (sisa > 0) lines.push(`   Sisa ${sisa}× lagi → auto kick.`)
        else if (r.kickError) lines.push(`   ❌ Gagal kick: ${r.kickError} (jadikan bot admin)`)
      }
    }
    if (kicked.length) lines.push('', 'Gunakan *!listwarn* untuk melihat daftar.')

    return conn.message.send(m.chat, lines.join('\n'), {
      quote: m,
      mentions: scored.map(r => `${r.num}@s.whatsapp.net`)
    })
  }
}

// --- Ekspor internal untuk test (tidak dibaca loader) ---
const plugin = module.exports
plugin.getStore = getStore
plugin.phoneOf = phoneOf
plugin.jidOf = jidOf
plugin.domainOf = domainOf
plugin.resolveTargets = resolveTargets
plugin.jidsFor = jidsFor
plugin.DEFAULT_MAX = DEFAULT_MAX
