// Mode admin saja PER GRUP. Setting: global.db.data.chats[<groupJid>].adminOnly
// Admin grup atau owner bot boleh mengubah; command hanya bisa dipakai di grup.

const warn = require('./warn.js')

const participantMatches = (p, num) =>
  [p.phoneNumber, p.jid, p.lid].some(j => j && warn.phoneOf(j) === num)

const handler = async (m, { conn, args, usedPrefix, command, isOwner }) => {
  let metadata = await conn.group.queryGroupMetadata(m.chat).catch(() => null)
  let participants = metadata?.participants || []
  let senderNum = warn.phoneOf(m.sender)
  let isAdmin = !!senderNum && participants.some(p => p.isAdmin && participantMatches(p, senderNum))
  if (!isAdmin && !isOwner) {
    return m.reply('❌ Perintah ini hanya untuk *admin grup* atau owner bot.')
  }

  let chats = global.db.data.chats
  let chat = chats[m.chat]
  if (typeof chat !== 'object' || chat === null) chats[m.chat] = chat = {}

  let opt = (args[0] || '').toLowerCase()
  if (opt !== 'on' && opt !== 'off') {
    return m.reply(`Mode *Admin Saja* di grup ini: ${chat.adminOnly ? 'ON' : 'OFF'}\n\nContoh:\n${usedPrefix}${command} on\n${usedPrefix}${command} off`)
  }

  chat.adminOnly = opt === 'on'
  global.db.write()

  await m.reply(chat.adminOnly
    ? '✅ Mode *Admin Saja* aktif di grup ini. Hanya admin grup dan owner yang dilayani.'
    : '✅ Mode *Admin Saja* nonaktif di grup ini. Semua member dilayani lagi.')
}

module.exports = {
  name: 'adminonly',
  description: 'Batasi bot hanya untuk admin grup ini dan owner.',
  aliases: ['admonly'],
  tags: ['group'],
  permissions: { groupOnly: true },
  command: /^(adminonly|admonly)$/i,
  run: handler
}

// --- Ekspor internal untuk test (tidak dibaca loader) ---
module.exports._test = { participantMatches }
