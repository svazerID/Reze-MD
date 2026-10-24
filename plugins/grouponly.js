const handler = async (m, { conn, args, usedPrefix, command }) => {
  let meJid = conn.getCredentials()?.meJid || ''
  let setting = global.db.data.settings[meJid]
  if (typeof setting !== 'object') global.db.data.settings[meJid] = setting = {}

  let opt = (args[0] || '').toLowerCase()
  if (opt !== 'on' && opt !== 'off') {
    return m.reply(`Mode *Grup Saja*: ${setting.groupOnly ? 'ON' : 'OFF'}\n\nContoh:\n${usedPrefix}${command} on\n${usedPrefix}${command} off`)
  }

  setting.groupOnly = opt === 'on'
  global.db.write()

  await m.reply(setting.groupOnly
    ? '✅ Mode *Grup Saja* aktif. Bot hanya melayani grup; owner tetap bisa di chat pribadi.'
    : '✅ Mode *Grup Saja* nonaktif. Bot melayani grup dan chat pribadi.')
}

module.exports = {
  name: 'grouponly',
  description: 'Batasi bot hanya untuk grup (owner tetap bisa di chat pribadi).',
  aliases: ['gconly'],
  tags: ['owner'],
  permissions: { ownerOnly: true },
  command: /^(grouponly|gconly)$/i,
  run: handler
}
