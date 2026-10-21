// Translate plugin. Logika penyedia + fallback ada di lib/translate.js
// (api.alfisy -> Google via proxy -> LibreTranslate -> MyMemory), karena
// endpoint Google membalas 429 dari IP datacenter ini.
let { translate } = require('../lib/translate')

let handler = async (m, { conn, text, args, usedPrefix, command }) => {
  // Tanpa teks → translate isi pesan yang di-reply (kalau ada)
  if (!text && m.quoted) {
    text = (m.quoted.message?.conversation ??
      m.quoted.message?.extendedTextMessage?.text ??
      m.quoted.message?.imageMessage?.caption ?? '').trim()
  }
  if (!text) {
    return m.reply(`Contoh: ${usedPrefix}${command} hello world\n` +
      `Ganti bahasa target: ${usedPrefix}${command} en selamat pagi\n` +
      `Atau reply pesan dengan *${usedPrefix}${command}*`)
  }

  // "!tr en halo" → target=en, sisanya teks. Kata pertama yang panjangnya 2
  // dan cuma huruf dianggap kode bahasa.
  let target = 'id', teks = text
  let first = args[0] || ''
  if (/^[a-z]{2}$/i.test(first) && args.length > 1) {
    target = first.toLowerCase()
    teks = text.slice(first.length).trim()
  }

  let data
  try {
    data = await translate(teks, target)
  } catch (e) {
    return m.reply('❌ Gagal translate: ' + (e.message || e))
  }

  await m.reply(
    `*🌐 Translate* (${data.from} → ${data.to})\n\n` +
    `${data.text}`
  )
}

module.exports = handler

handler.description = "Translate teks ke bahasa lain (default: Indonesia)."
handler.help = ['tr <teks>', 'tr <kode> <teks>']
handler.tags = ['tools']
handler.command = /^(tr|translate)$/i
