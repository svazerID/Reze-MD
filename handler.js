let simple = require('./lib/simple')
let { printMessage } = require('./lib/print')
let { phoneOf } = require('./lib/groupEvents')
let path = require('node:path')

async function reportPluginError(conn, m, plugin, command, error) {
  let owners = (global.owner || []).map(owner => Array.isArray(owner) ? owner[0] : owner).filter(Boolean)
  // Sender bisa berupa LID (@lid) — resolve ke nomor HP via lidCache biar
  // kebaca manusia. Kalau tidak ke-resolve, tampilkan JID apa adanya.
  let senderNum = phoneOf(m.sender)
  let senderShown = senderNum && senderNum !== m.sender ? `${senderNum} (${m.sender})` : m.sender
  let text = `⚠️ *Plugin error: ${plugin?.name || command || 'unknown'}*\nSender: ${senderShown}\nChat: ${m.chat}\nCommand: ${m.text || '-'}\n\n\`${String(error?.stack || error).slice(0, 2500)}\``
  for (let owner of owners) {
    try {
      let jid = String(owner).includes('@') ? owner : `${String(owner).replace(/\D/g, '')}@s.whatsapp.net`
      await conn.message.send(jid, { type: 'text', text })
    } catch (sendError) {
      console.error('[plugin-error-report] gagal kirim ke owner:', sendError.message || sendError)
    }
  }
}


const isNumber = x => typeof x === 'number' && !isNaN(x)
// Normalisasi JID: buang device ID & domain — aman bandingkan PN vs LID
const normalize = jid => (jid || '').split('@')[0].split(':')[0]

module.exports = {
  async handler(event) {
    let m = simple.smsg(this, event)
    await printMessage(m, this)
    for (let [name, hook] of Object.entries(global.plugins || {})) {
      if (!hook || hook.disabled || typeof hook.all !== 'function') continue
      try {
        await hook.all.call(this, m, {
          chatUpdate: event,
          dirname: path.join(__dirname, 'plugins'),
          __filename: path.join(__dirname, 'plugins', name)
        })
      } catch (e) {
        console.error(`Plugin all error [${name}]:`, e)
        await reportPluginError(this, m, hook, '', e)
      }
    }
    if (!m.text) return

    let meJid = this.getCredentials()?.meJid || 'bot'
    try {
      // --- Init database users / chats / settings ---
      let user = global.db.data.users[m.sender]
      if (typeof user !== 'object') global.db.data.users[m.sender] = user = {}
      if (!isNumber(user.exp)) user.exp = 0
      if (!('name' in user)) user.name = event.pushName || ''
      if (!('banned' in user)) user.banned = false

      let chat = global.db.data.chats[m.chat]
      if (typeof chat !== 'object') global.db.data.chats[m.chat] = chat = {}
      if (!('isBanned' in chat)) chat.isBanned = false

      let setting = global.db.data.settings[meJid]
      if (typeof setting !== 'object') global.db.data.settings[meJid] = setting = {}
      if (!('self' in setting)) setting.self = false
    } catch (e) {
      console.error(e)
    }

    let setting = global.db.data.settings[meJid] || {}
    if (!m.fromMe && setting.self) return
    if (global.db.data.users[m.sender]?.banned) return
    if (global.db.data.chats[m.chat]?.isBanned) return
    let storePlugin = global.plugins['liststore.js']
    if (storePlugin && m.isGroup && m.text && !m.fromMe) {
      let rawPlugin = require('./plugins/liststore')
      if (await rawPlugin.autoReply(m, this)) return
    }

    // Sender bisa datang sebagai PN (nomor HP) atau LID — resolve LID ke nomor
    // lewat lidCache, kalau tidak nomor owner di config.js tidak pernah cocok.
    let senderNum = normalize(m.sender)
    let senderPhone = global.lidCache?.[senderNum] || senderNum
    let isOwner = m.fromMe || global.owner.some(o => normalize(o) === senderPhone)

    // --- Cari plugin yang cocok ---
    let plugin, usedPrefix = '', command = '', args = [], text = '', noPrefix = ''

    // 1. Plugin dengan customPrefix (cth: exec '> ', '=> ', '$ ') — dites ke teks penuh
    outer: for (let name of Object.keys(global.plugins)) {
      let p = global.plugins[name]
      if (!(p.customPrefix instanceof RegExp)) continue
      let match = p.customPrefix.exec(m.text)
      if (!match) continue
      usedPrefix = match[0]
      noPrefix = m.text.slice(usedPrefix.length).trim()
      ;[command, ...args] = noPrefix.split(/ +/)
      command = (command || '').toLowerCase()
      text = noPrefix // seluruh sisa teks = payload (penting untuk exec)
      let cmdOk = p.command instanceof RegExp
        ? p.command.test(command)
        : (p.command === command || p.command === undefined)
      if (cmdOk) { plugin = p; break outer }
    }

    // 2. Plugin dengan prefix global (!, #, dll) — skip plugin customPrefix biar tidak dibajak
    if (!plugin) {
      usedPrefix = (m.text.match(global.prefix) || [''])[0]
      if (!usedPrefix) return
      noPrefix = m.text.replace(usedPrefix, '').trim()
      command = noPrefix.split(/ +/).shift().toLowerCase()
      args = m.text.trim().split(/ +/).slice(1)
      text = args.join(' ')
      for (let name of Object.keys(global.plugins)) {
        let p = global.plugins[name]
        if (!p.command || p.customPrefix) continue
        let match = p.command instanceof RegExp ? p.command.exec(command) : p.command === command
        if (match) { plugin = p; break }
      }
    }
    if (!plugin) return

    // --- Cek permission ---
    let metadata
    if (m.isGroup && (plugin.admin || plugin.botAdmin || plugin.participants)) {
      metadata = await this.group.queryGroupMetadata(m.chat).catch(() => null)
    } else if (m.isGroup && !global.lidCache[m.chat]) {
      // ponytail: query metadata sekali per grup untuk populate LID cache
      metadata = await this.group.queryGroupMetadata(m.chat).catch(() => null)
    }
    // Populate LID → phone cache dari participant data
    if (metadata?.participants && m.chat) {
      if (!global.lidCache) global.lidCache = {}
      for (let p of metadata.participants) {
        let phone = p.phoneNumber?.split('@')[0]?.split(':')?.pop()
        if (phone && /^\d{10,}$/.test(phone)) {
          if (p.lid) global.lidCache[p.lid.split('@')[0]] = phone
          if (p.jid && p.jid !== p.phoneNumber) global.lidCache[p.jid.split('@')[0].split(':').pop()] = phone
        }
      }
    }
    let normMe = normalize(meJid)
    let normSender = normalize(m.sender)
    // Cek semua kemungkinan format JID: phoneNumber (PN), jid (primary), lid
    let matchJid = (p, normTarget) =>
      [p.phoneNumber, p.jid, p.lid].some(j => j && normalize(j) === normTarget)
    let isAdmin = m.isGroup && metadata?.participants.some(p => matchJid(p, normSender) && p.isAdmin)
    let isBotAdmin = m.isGroup && metadata?.participants.some(p => matchJid(p, normMe) && p.isAdmin)

    if (plugin.owner && !isOwner) return dfail('owner', m)
    if (plugin.group && !m.isGroup) return dfail('group', m)
    if (plugin.private && m.isGroup) return dfail('private', m)
    if (plugin.admin && !isAdmin) return dfail('admin', m)
    if (plugin.botAdmin && !isBotAdmin) return dfail('botAdmin', m)

    // List Store auto-reply: runs even when m.text is an exact entry name.
    if (m.isGroup) {
      let listStore = global.plugins['liststore.js']
      if (listStore?.autoReply) {
        await listStore.autoReply(m, this, {
          banned: !!global.db.data.users[m.sender]?.banned,
          chatBanned: !!global.db.data.chats[m.chat]?.isBanned
        })
      }
    }

    try {
      await plugin.run(m, {
        conn: this,
        args,
        text,
        noPrefix,
        usedPrefix,
        command,
        isOwner,
        isAdmin,
        isBotAdmin,
        participants: metadata?.participants,
        groupMetadata: metadata
      })
      global.db.data.users[m.sender].exp += 1
    } catch (e) {
      console.error(`Plugin error [${command}]:`, e)
      m.reply('Error: ' + (e.message || e)).catch(() => {})
      await reportPluginError(this, m, plugin, command, e)
    }
  }
}

async function dfail(type, m) {
  let msg = {
    owner: 'Perintah ini hanya untuk *Owner*!',
    group: 'Perintah ini hanya bisa dipakai di *grup*!',
    private: 'Perintah ini hanya bisa dipakai di *chat pribadi*!',
    admin: 'Perintah ini hanya untuk *admin grup*!',
    botAdmin: 'Jadikan bot sebagai *admin* untuk memakai perintah ini!'
  }[type]
  if (msg) await m.reply(msg).catch(() => {})
}
