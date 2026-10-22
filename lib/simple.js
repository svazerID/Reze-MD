// Wrapper pesan 

function extractText(message) {
  // Plain text / formatted text / media captions
  let text =
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption ??
    undefined

  // Button clicks — native flow (quick_reply, cta_copy, cta_url)
  if (!text && message?.interactiveResponseMessage) {
    let resp = message.interactiveResponseMessage
    try {
      let params = JSON.parse(resp.nativeFlowResponseMessage?.paramsJson || '{}')
      text = params.id || resp.body?.text || ''
    } catch {
      text = resp.body?.text || ''
    }
  }

  // List selection
  if (!text && message?.listResponseMessage) {
    text = message.listResponseMessage.singleSelectReply?.selectedRowId || message.listResponseMessage.title || ''
  }

  // Legacy template button reply
  if (!text && message?.templateButtonReplyMessage) {
    text = message.templateButtonReplyMessage.selectedId || ''
  }

  // Legacy buttons response
  if (!text && message?.buttonsResponseMessage) {
    text = message.buttonsResponseMessage.selectedId || ''
  }

  return text || undefined
}

/**
 * Hiasi event message zapo jadi objek m.
 * @param {import('zapo-js').WaClient} client
 * @param {object} event WaIncomingMessageEvent
 */
function smsg(client, event) {
  let m = event
  m.chat = event.key.remoteJid
  m.sender = event.key.participant ?? event.key.remoteJid
  m.fromMe = event.key.fromMe
  // Selalu gunakan JID (nomor telepon), abaikan LID
  if (!global.lidCache) global.lidCache = {}
  for (let [primary, alt] of [
    [m.sender, event.key.participantAlt],
    [m.chat, event.key.remoteJidAlt]
  ]) {
    if (!alt) continue
    let jid = primary.endsWith('@s.whatsapp.net') ? primary : (alt.endsWith('@s.whatsapp.net') ? alt : null)
    let lid = primary.endsWith('@lid') ? primary : (alt.endsWith('@lid') ? alt : null)
    if (lid && jid && /\d{10,}/.test(jid.split('@')[0])) global.lidCache[lid.split('@')[0].split(':')[0]] = jid.split('@')[0]
    // Jika primary/alt adalah LID tanpa JID, set m.sender/m.chat ke null untuk menghindari penggunaan LID
    if (primary.endsWith('@lid') && !jid) {
      if (primary === m.sender) m.sender = null
      if (primary === m.chat) m.chat = null
    }
  }
  // Jika m.sender masih LID, coba resolve dari cache
  if (m.sender?.endsWith('@lid')) {
    const lidKey = m.sender.split('@')[0].split(':')[0]
    const resolvedJid = global.lidCache?.[lidKey]
    if (resolvedJid) m.sender = `${resolvedJid}@s.whatsapp.net`
    else m.sender = null // Jika tidak bisa resolve, set ke null
  }
  // Jika m.chat masih LID, coba resolve dari cache
  if (m.chat?.endsWith('@lid')) {
    const lidKey = m.chat.split('@')[0].split(':')[0]
    const resolvedJid = global.lidCache?.[lidKey]
    if (resolvedJid) m.chat = `${resolvedJid}@s.whatsapp.net`
    else m.chat = null // Jika tidak bisa resolve, set ke null
  }
  m.isGroup = event.key.isGroup ?? m.chat?.endsWith('@g.us')
  m.pushname = event.pushName || ''
  m.timestamp = event.timestampSeconds ? event.timestampSeconds * 1000 : Date.now()
  m.text = extractText(event.message) ?? ''
  m.isButton = !!(event.message?.interactiveResponseMessage ||
    event.message?.listResponseMessage ||
    event.message?.templateButtonReplyMessage ||
    event.message?.buttonsResponseMessage)
  // contextInfo bisa nempel di tipe pesan mana pun (extendedText, image, video,
  // sticker, document, audio...). Kalau cuma baca extendedTextMessage, reply ke
  // gambar/video jadi null dan plugin yang butuh m.quoted gagal.
  let ctxInfo = getContextInfo(event.message)
  m.mentionedJid = ctxInfo?.mentionedJid ?? []
  m.quotedSender = ctxInfo?.participant ?? null
  m.quotedCtx = ctxInfo ?? null
  m.quoted = ctxInfo?.quotedMessage
    ? { message: ctxInfo.quotedMessage, sender: ctxInfo.participant }
    : null
  m.reply = (text, opts = {}) =>
    client.message.send(m.chat, text, { quote: event, ...opts })
  return m
}

// Ambil contextInfo dari tipe pesan apa pun yang bisa membawanya.
function getContextInfo(message) {
  if (!message) return null
  for (let key of Object.keys(message)) {
    // _-prefixed = field internal proto (mis. _stats), bukan message
    if (key.startsWith('_')) continue
    let ctx = message[key]?.contextInfo
    if (ctx) return ctx
  }
  return null
}

module.exports = { smsg, extractText }
