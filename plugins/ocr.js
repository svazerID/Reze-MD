const { downloadMedia } = require('../lib/mediaProcessor')
const { upload } = require('../lib/upload')

const API = 'https://alsya.svazer.eu.cc/api/tools/ocr'

// OCR: GET ?imageUrl=<url publik>. Jalur base64 tidak dipakai karena API ini
// cuma terima GET (POST 404) dan URL-nya pecah untuk payload besar.
async function ocr(imageUrl) {
  let url = `${API}?imageUrl=${encodeURIComponent(imageUrl)}`
  let res = await fetch(url)
  let data = await res.json().catch(() => { throw new Error(`respons bukan JSON (HTTP ${res.status})`) })
  if (!data.success) throw new Error(data.error || 'OCR gagal')
  return data
}

let handler = async (m, { conn, usedPrefix, command }) => {
  let msg = m.quoted ? m.quoted : m
  if (!msg.message?.imageMessage) {
    return m.reply(`Reply atau kirim gambar dengan caption *${usedPrefix}${command}*`)
  }

  await m.reply('⏳ Membaca teks dari gambar...')

  let buffer
  try {
    buffer = await downloadMedia(msg.message)
  } catch (e) {
    return m.reply('❌ Gagal download gambar: ' + (e.message || e))
  }
  if (!buffer) return m.reply('❌ Gagal download gambar.')

  let imageUrl
  try {
    imageUrl = (await upload(buffer, `ocr_${Date.now()}.jpg`, msg.message.imageMessage.mimetype || 'image/jpeg')).url
  } catch (e) {
    return m.reply('❌ Gagal upload gambar: ' + (e.message || e))
  }

  let data
  try {
    data = await ocr(imageUrl)
  } catch (e) {
    return m.reply('❌ Gagal OCR: ' + (e.message || e))
  }

  let teks = (data.text || '').trim()
  if (!teks) return m.reply('❌ Tidak ada teks yang terbaca di gambar itu.')

  await m.reply(`📝 *Hasil OCR*\n\n${teks}`)
}

handler.description = "Baca teks dari gambar (OCR)."
handler.help = ['ocr']
handler.tags = ['tools']
handler.command = /^(ocr|totext|readtext)$/i

module.exports = handler
