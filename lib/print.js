const chalk = require('chalk')

/**
 * Format nomor telepon jadi format internasional.
 * contoh: 6285815061014 → +62 858-1506-1014
 */
function safePhone(num) {
  if (!num || !/^\d{10,15}$/.test(num)) return null
  if (num.startsWith('62')) {
    let local = num.slice(2)
    if (local.length >= 9) {
      return '+62 ' + local.slice(0, 3) + '-' + local.slice(3, 7) + '-' + local.slice(7)
    }
  }
  return '+' + num
}

async function resolvePhoneFromJid(jid) {
  if (!jid) return null
  // Strip device ID (:xx) lalu ambil nomor sebelum @
  let num = jid.split(':')[0].split('@')[0]

  // Coba cache LID → phone (jika jid adalah LID)
  if (jid.endsWith('@lid')) {
    const lidKey = num
    if (global.lidCache && global.lidCache[lidKey]) {
      let phone = global.lidCache[lidKey]
      let formatted = safePhone(phone)
      if (formatted) return formatted
    }
    // Jika tidak ada di cache, abaikan LID
    return null
  }

  // Jika jid adalah JID biasa, gunakan langsung
  let formatted = safePhone(num)
  if (formatted) return formatted

  // Coba contact store (async)
  try {
    let store = global.conn?.stores?.contacts
    if (store) {
      let contact = await store.getByJid(jid)
      if (contact?.phoneNumber) {
        let formatted = safePhone(contact.phoneNumber.split(':')[0].split('@')[0])
        if (formatted) return formatted
      }
    }
  } catch {}

  return safePhone(num)
}

async function getPushName(jid) {
  if (!jid) return null
  try {
    let store = global.conn?.stores?.contacts
    if (store) {
      let contact = await store.getByJid(jid)
      if (contact?.pushName) return contact.pushName
      if (contact?.displayName) return contact.displayName
    }
  } catch {}
  return null
}

function getMtype(message) {
  if (!message) return 'empty'
  // Prioritas: kalau ada extendedText, tampilkan extendedTextMessage
  if (message.extendedTextMessage) return 'extendedTextMessage'
  if (message.conversation) return 'conversation'
  if (message.imageMessage) return 'imageMessage'
  if (message.videoMessage) return 'videoMessage'
  if (message.audioMessage) return message.audioMessage.ptt ? 'pttMessage' : 'audioMessage'
  if (message.stickerMessage) return 'stickerMessage'
  if (message.documentMessage) return 'documentMessage'
  if (message.contactMessage) return 'contactMessage'
  if (message.contactsArrayMessage) return 'contactsArrayMessage'
  if (message.locationMessage) return 'locationMessage'
  if (message.interactiveMessage) return 'interactiveMessage'
  if (message.templateMessage) return 'templateMessage'
  if (message.protocolMessage) return 'protocolMessage'
  if (message.reactionMessage) return 'reactionMessage'
  if (message.ephemeralMessage) return 'ephemeralMessage'
  // Fallback: tampilkan key pertama yang ada
  let keys = Object.keys(message).filter(k => k.endsWith('Message') || k === 'conversation')
  return keys[0] || 'unknown'
}

function formatSize(bytes) {
  if (!bytes) return '0 B'
  let units = ['B', 'KB', 'MB', 'GB']
  let i = Math.floor(Math.log(bytes) / Math.log(1000))
  return (bytes / Math.pow(1000, i)).toFixed(1) + ' ' + units[i]
}

/**
 * Format display: "+62 xxx ~pushName" atau raw jid
 */
async function formatSender(jid) {
  // Jika jid adalah LID, coba resolve ke JID
  if (jid?.endsWith('@lid')) {
    const lidKey = jid.split('@')[0].split(':')[0]
    const resolvedJid = global.lidCache?.[lidKey]
    if (resolvedJid) jid = `${resolvedJid}@s.whatsapp.net`
    else return '?' // Jika tidak bisa resolve, gunakan '?'
  }
  let phone = await resolvePhoneFromJid(jid)
  let name = await getPushName(jid)
  if (phone && name) return phone + ' ~' + name
  if (phone) return phone
  if (name) return name
  return jid?.split('@')[0] || '?'
}

async function printMessage(m, conn) {
  try {
    let sender = m.sender || ''
    let chat = m.chat || ''
    let mtype = getMtype(m.message)

    let ts = m.messageTimestamp
      ? new Date(1000 * (m.messageTimestamp.low || m.messageTimestamp))
      : new Date()
    let time = ts.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })

    let msg = m.message || {}
    let extMsg = msg.extendedTextMessage || {}
    let mediaMsg = msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.documentMessage || msg.stickerMessage || {}
    let filesize = mediaMsg.fileLength
      ? (mediaMsg.fileLength.low || mediaMsg.fileLength)
      : (m.text || '').length

    let meJid = conn.getCredentials()?.meJid || ''
    let meDisplay = await formatSender(meJid)
    let senderDisplay = await formatSender(sender)

    // Chat display: full JID untuk grup
    let chatDisplay = chat
    let groupName = ''
    if (chat.endsWith('@g.us')) {
      groupName = await getPushName(chat) || ''
      // Kalau tidak ada di contacts, coba resolve dari group metadata
      if (!groupName) {
        try {
          let meta = await conn.group.queryGroupMetadata(chat)
          groupName = meta?.subject || ''
        } catch {}
      }
    }

    let mentioned = extMsg.contextInfo?.mentionedJid || []

    // Format output — box style seperti banner
    let isGroup = chat.endsWith('@g.us')
    let chatIcon = isGroup ? '👥' : '💬'
    let typeIcon = {
      'conversation': '💬', 'extendedTextMessage': '💬',
      'imageMessage': '🖼️', 'videoMessage': '🎬',
      'audioMessage': '🎵', 'pttMessage': '🎤',
      'stickerMessage': '🎨', 'documentMessage': '📄',
      'contactMessage': '👤', 'contactsArrayMessage': '👥',
      'locationMessage': '📍', 'interactiveMessage': '🔘',
      'templateMessage': '📋', 'protocolMessage': '⚙️',
      'reactionMessage': '❤️', 'ephemeralMessage': '👻'
    }[mtype] || '📨'

    let lines = [
      chalk.gray('╭───────···'),
      chalk.gray('│') + chalk.redBright('👤 ') + chalk.white(meDisplay),
      chalk.gray('│') + chalk.green('⏰ ') + chalk.black(chalk.bgYellow(time)),
      chalk.gray('│') + chalk.green('📤 ') + chalk.bold.green(senderDisplay),
      chalk.gray('│') + chalk.green(chatIcon + ' ') + chalk.cyan(chatDisplay) + (groupName ? chalk.yellow(' ~' + groupName) : ''),
      chalk.gray('│') + chalk.green(typeIcon + ' ') + chalk.white(mtype) + chalk.gray(' • ') + chalk.magenta(formatSize(filesize)),
    ]

    console.log(lines.join('\n'))

    // Log text/command
    if (m.text) {
      let log = m.text.replace(/\u200e+/g, '')
      if (m.isCommand) {
        console.log(chalk.gray('│') + chalk.yellow('  → ' + log))
      } else if (m.error) {
        console.log(chalk.gray('│') + chalk.red('  → ' + log))
      } else {
        console.log(chalk.gray('│') + chalk.white('  → ' + log))
      }
    }

    // Log mentions
    if (mentioned.length) {
      let names = await Promise.all(mentioned.map(jid => formatSender(jid)))
      console.log(chalk.gray('│') + chalk.blueBright('  @' + names.join(' @')))
    }

    // Log media info
    if (mtype === 'Audio') {
      let dur = msg.audioMessage?.seconds || 0
      let mm = String(Math.floor(dur / 60)).padStart(2, '0')
      let ss = String(dur % 60).padStart(2, '0')
      console.log(chalk.gray('│') + chalk.gray(`  🎵 ${msg.audioMessage?.ptt ? 'PTT' : 'AUDIO'} ${mm}:${ss}`))
    } else if (mtype === 'Document') {
      console.log(chalk.gray('│') + chalk.gray(`  🗂️ ${msg.documentMessage?.fileName || 'Document'}`))
    } else if (mtype === 'Sticker') {
      console.log(chalk.gray('│') + chalk.gray('  🎨 Sticker'))
    }

    console.log(chalk.gray('╰──────────────────────'))
  } catch (e) {
    console.log(chalk.gray('[print error]') + ' ' + (e.message || e))
  }
}

module.exports = { printMessage }
