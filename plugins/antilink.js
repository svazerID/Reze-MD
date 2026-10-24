// Antilink grup lain: hapus pesan berisi undangan grup WhatsApp lain
// (chat.whatsapp.com/<code> atau groupInviteMessage) lalu beri warn.
// Setting per grup: global.db.data.chats[<groupJid>].antilink
// Warn memakai store warn.js yang sama (5× warn = auto kick).

const warn = require('./warn.js')

// Cache kode undangan grup sendiri → pembeda "link grup lain" vs "link grup ini".
const ownCodeCache = new Map() // chat -> { code, at }
const OWN_CODE_TTL = 10 * 60 * 1000
const OWN_CODE_FAIL_TTL = 60 * 1000
const revokeFailedNotified = new Set()

const norm = jid => (jid || '').split('@')[0].split(':')[0]
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{5,})/gi

function getChat(jid) {
  let chats = global.db?.data?.chats
  if (!chats || !jid) return null
  let chat = chats[jid]
  if (typeof chat !== 'object' || chat === null) chats[jid] = chat = {}
  return chat
}

// Kode undangan grup ini. Hanya admin yang boleh query (403 kalau bot bukan admin).
async function ownInviteCode(conn, chat) {
  let hit = ownCodeCache.get(chat)
  let ttl = hit?.code ? OWN_CODE_TTL : OWN_CODE_FAIL_TTL
  if (hit && Date.now() - hit.at < ttl) return hit.code
  try {
    let code = await conn.group.queryInviteCode(chat)
    ownCodeCache.set(chat, { code: code || null, at: Date.now() })
    return code || null
  } catch {
    ownCodeCache.set(chat, { code: null, at: Date.now() })
    return null
  }
}

// true = link mengarah ke grup LAIN.
async function isOtherGroupInvite(conn, m) {
  let invite = m.message?.groupInviteMessage
  if (invite) {
    let target = norm(invite.groupJid)
    if (target) return target !== norm(m.chat)
    // Payload lama tanpa groupJid: bandingkan kodenya dengan kode grup ini.
    let own = await ownInviteCode(conn, m.chat)
    return !(own && invite.inviteCode && invite.inviteCode === own)
  }

  let codes = []
  INVITE_RE.lastIndex = 0
  let match
  while ((match = INVITE_RE.exec(m.text || ''))) codes.push(match[1])
  if (!codes.length) return false

  // Tanpa kode grup sendiri link tidak bisa diverifikasi — fail-open supaya
  // link grup ini sendiri tidak ikut terhapus.
  let own = await ownInviteCode(conn, m.chat)
  if (!own) return false
  return codes.some(code => code !== own)
}

const participantMatches = (p, num) =>
  [p.phoneNumber, p.jid, p.lid].some(j => j && norm(j) === num)

async function enforce(m, conn) {
  if (!m.isGroup || !m.chat || !m.chat.endsWith('@g.us')) return
  if (m.fromMe || !m.sender) return

  let chat = getChat(m.chat)
  if (!chat?.antilink) return
  if (!(await isOtherGroupInvite(conn, m))) return

  let metadata = await conn.group.queryGroupMetadata(m.chat).catch(() => null)
  let participants = metadata?.participants || []

  let senderNum = warn.phoneOf(m.sender)
  if (!senderNum) return

  // Admin grup & owner bot dianggap tepercaya (dan admin tidak bisa di-kick).
  let meNum = norm(conn.getCredentials()?.meJid)
  if (senderNum === meNum) return
  let owners = (global.owner || []).map(o => norm(Array.isArray(o) ? o[0] : o))
  if (owners.includes(senderNum)) return
  if (participants.some(p => p.isAdmin && participantMatches(p, senderNum))) return

  let target = { remoteJid: m.chat, id: m.key?.id, fromMe: false }
  if (m.key?.participant) target.participant = m.key.participant
  try {
    await conn.message.send(m.chat, { type: 'revoke', target })
  } catch (e) {
    if (!revokeFailedNotified.has(m.chat)) {
      revokeFailedNotified.add(m.chat)
      console.error(`[antilink] gagal hapus pesan di ${m.chat} (bot admin?):`, e.message || e)
    }
    return
  }

  let store = warn.getStore(m.chat)
  if (!store) return
  let entry = store[senderNum]
  if (!entry || typeof entry !== 'object') entry = { count: 0, reasons: [] }
  if (!Array.isArray(entry.reasons)) entry.reasons = []
  entry.count = (Number(entry.count) || 0) + 1
  entry.lastAt = Date.now()
  entry.by = m.sender
  entry.reasons.push('Link grup lain')
  if (entry.reasons.length > 5) entry.reasons = entry.reasons.slice(-5)
  store[senderNum] = entry
  global.db.write()

  let max = warn.DEFAULT_MAX
  let kicked = false
  if (entry.count >= max) {
    let targetJids = [...new Set([
      ...warn.jidsFor(senderNum, participants),
      warn.jidOf(senderNum, warn.domainOf(m.sender))
    ])].filter(Boolean)
    try {
      let outcomes = await conn.group.removeParticipants(m.chat, targetJids)
      kicked = !!outcomes?.some(o => o.status === 'ok')
    } catch {}
    if (kicked) delete store[senderNum]
    global.db.write()
  }

  let mentionJid = warn.jidOf(senderNum, warn.domainOf(m.sender))
  let lines = [`⚠️ *Antilink*: link grup lain dari @${senderNum} dihapus.`]
  if (kicked) lines.push(`⛔ @${senderNum} di-*kick* — ${entry.count}/${max} warn.`)
  else {
    lines.push(`Warn: *${entry.count}/${max}*`)
    if (entry.count >= max) lines.push('   ❌ Gagal kick (jadikan bot admin).')
  }
  await conn.message.send(m.chat, lines.join('\n'), { mentions: [mentionJid] }).catch(() => {})
}

const run = async (m, { conn, args, usedPrefix, command, isOwner }) => {
  let metadata = await conn.group.queryGroupMetadata(m.chat).catch(() => null)
  let participants = metadata?.participants || []
  let senderNum = warn.phoneOf(m.sender)
  let isAdmin = !!senderNum && participants.some(p => p.isAdmin && participantMatches(p, senderNum))
  if (!isAdmin && !isOwner) {
    return m.reply('❌ Perintah ini hanya untuk *admin grup* atau owner bot.')
  }

  let chat = getChat(m.chat)
  let opt = (args[0] || '').toLowerCase()
  if (opt !== 'on' && opt !== 'off') {
    return m.reply(`Mode *Antilink Grup Lain*: ${chat.antilink ? 'ON' : 'OFF'}\n\nContoh:\n${usedPrefix}${command} on\n${usedPrefix}${command} off`)
  }

  chat.antilink = opt === 'on'
  global.db.write()

  let meNum = norm(conn.getCredentials()?.meJid)
  let botAdmin = participants.some(p => p.isAdmin && participantMatches(p, meNum))
  if (chat.antilink && !botAdmin) {
    return m.reply('✅ Antilink aktif, tapi bot *bukan admin* grup — link belum bisa dihapus. Jadikan bot admin.')
  }
  await m.reply(chat.antilink
    ? '✅ *Antilink Grup Lain* aktif. Link undangan grup lain otomatis dihapus + warn.'
    : '✅ *Antilink Grup Lain* nonaktif.')
}

module.exports = {
  name: 'antilink',
  description: 'Hapus link undangan grup lain + warn otomatis.',
  aliases: ['antilinkgc'],
  tags: ['group'],
  permissions: { groupOnly: true },
  command: /^(antilink|antilinkgc)$/i,
  // handler memanggil all.call(conn, m, {...}) — conn datang lewat `this`.
  all: function (m) {
    return enforce(m, this)
  },
  run
}

// --- Ekspor internal untuk test (tidak dibaca loader) ---
module.exports._test = { isOtherGroupInvite, ownInviteCode, getChat, enforce }
