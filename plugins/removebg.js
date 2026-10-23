const fs = require('fs')
const path = require('path')
const { downloadMedia } = require('../lib/mediaProcessor')

const TMP = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

const API = 'https://alsya.svazer.eu.cc/api/tools/removebg'

// ponytail: field wajib 'file' (bukan 'image'/'img' → 400 "Unexpected field"),
// hanya JPG/PNG/WEBP. Hasil = PNG ber-alpha. Error datang sebagai JSON,
// jadi hasil dicek lewat magic bytes PNG, bukan content-type.
async function removeBg(buffer, mimetype) {
  let ext = /png/.test(mimetype) ? 'png' : /webp/.test(mimetype) ? 'webp' : 'jpg'
  let form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype || 'image/jpeg' }), `input.${ext}`)

  let res = await fetch(API, { method: 'POST', body: form })
  let buf = Buffer.from(await res.arrayBuffer())
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    let msg = buf.slice(0, 200).toString().replace(/[^\x20-\x7e\n]/g, '').trim()
    throw new Error(msg || `respons bukan gambar (HTTP ${res.status})`)
  }
  return buf
}

let handler = async (m, { conn, usedPrefix, command }) => {
  let msg = m.quoted ? m.quoted : m
  if (!msg.message?.imageMessage) {
    return m.reply(`Reply atau kirim gambar dengan caption *${usedPrefix}${command}*`)
  }

  await m.reply('⏳ Menghapus background...')

  let buffer
  try {
    buffer = await downloadMedia(msg.message)
  } catch (e) {
    return m.reply('❌ Gagal download gambar: ' + (e.message || e))
  }
  if (!buffer) return m.reply('❌ Gagal download gambar.')

  let hasil
  try {
    hasil = await removeBg(buffer, msg.message.imageMessage.mimetype)
  } catch (e) {
    return m.reply('❌ Gagal: ' + (e.message || e))
  }

  let tmpFile = path.join(TMP, `nobg_${Date.now()}.png`)
  fs.writeFileSync(tmpFile, hasil)
  try {
    await conn.message.send(m.chat, {
      type: 'image',
      media: tmpFile,
      mimetype: 'image/png',
      caption: ''
    }, { quote: m })
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
}

handler.description = "Hapus background gambar (hasil PNG transparan)."
handler.help = ['removebg']
handler.tags = ['tools']
handler.command = /^(removebg|rbg|nobg)$/i

module.exports = handler
