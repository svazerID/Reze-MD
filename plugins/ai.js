const API_URL = 'https://aiold.vercel.app/api/chat'
const MODEL = 'qwen'
const { downloadMedia } = require('../lib/mediaProcessor')

let handler = async (m, { conn, args, text, command }) => {
  const msg = m.quoted?.message?.imageMessage ? m.quoted : m
  const image = msg.message?.imageMessage
  if (!text && !image) return m.reply(`Gunakan: *${command} <pesan>* atau reply/kirim gambar dengan caption *${command}*`)

  let user = global.db.data.users[m.sender]
  if (!user) global.db.data.users[m.sender] = user = {}
  let sessions = user.aiSession || {}
  let model = MODEL

  try {
    let imageData
    if (image) {
      const buffer = await downloadMedia(msg.message)
      if (!buffer?.length) throw new Error('Gambar kosong atau gagal diunduh.')
      imageData = `data:${image.mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: text || 'Jelaskan gambar ini.', model, ...(imageData ? { imageData } : {}), ...(sessions[model] ? { sessionId: sessions[model] } : {}) }),
      signal: AbortSignal.timeout(60000)
    })
    const data = await response.json()

    if (!response.ok || !data.reply) {
      return m.reply('❌ AI gagal: ' + (data.error || data.message || `HTTP ${response.status}`))
    }

    if (data.sessionId) {
      sessions[model] = data.sessionId
      user.aiSession = sessions
    }

    let reply = formatWhatsApp(data.reply)
    await m.reply(reply)
  } catch (e) {
    await m.reply('❌ Error: ' + (e.message || e))
  }
}

function formatWhatsApp(text) {
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*')
  text = text.replace(/~~(.+?)~~/g, '~$1~')
  return text
}

handler.description = "Tanya Qwen AI vision lewat teks atau gambar."
handler.help = ['ai', 'qwen'].map(v => v + ' <pesan/gambar>')
handler.tags = ['ai']
handler.command = /^(ai|qwen|bot)$/i

module.exports = handler
