const handler = async (m, { conn, args, usedPrefix, command }) => {
  let meJid = conn.getCredentials()?.meJid || ''
  let setting = global.db.data.settings[meJid]
  if (typeof setting !== 'object') global.db.data.settings[meJid] = setting = {}

  let opt = (args[0] || '').toLowerCase()
  if (opt !== 'on' && opt !== 'off') {
    return m.reply(`Mode *Anticall*: ${setting.anticall ? 'ON' : 'OFF'}\n\nContoh:\n${usedPrefix}${command} on\n${usedPrefix}${command} off`)
  }

  setting.anticall = opt === 'on'
  global.db.write()

  await m.reply(setting.anticall
    ? '✅ Mode *Anticall* aktif. Semua panggilan masuk akan otomatis ditolak.'
    : '✅ Mode *Anticall* nonaktif. Panggilan masuk dibiarkan berdering.')
}

module.exports = {
  name: 'anticall',
  description: 'Tolak otomatis panggilan masuk (voice/video).',
  aliases: ['acall'],
  tags: ['owner'],
  permissions: { ownerOnly: true },
  command: /^(anticall|acall)$/i,
  run: handler
}
