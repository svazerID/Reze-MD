const fs = require('fs')
const path = require('path')
const { downloadMedia } = require('../lib/mediaProcessor')
const { upload } = require('../lib/upload')
const { writeExif } = require('../lib/exif')

const TMP = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

const API = 'https://alsya.svazer.eu.cc/api/maker/meme'

// ponytail: API wajib punya minimal satu dari atas/bawah (kalau dua-duanya
// kosong → HTTP 400), makanya default diisi ' '. Error datang sebagai JSON,
// jadi hasil dicek lewat magic bytes PNG, bukan status HTTP.
async function buildMeme({ imageUrl, atas, bawah }) {
  let url = `${API}?image=${encodeURIComponent(imageUrl)}` +
    `&atas=${encodeURIComponent(atas || ' ')}` +
    `&bawah=${encodeURIComponent(bawah || ' ')}` +
    `&fontSize=150&strokeWidth=15&width=1080&height=1080&format=png&quality=90`
  let res = await fetch(url)
  let buf = Buffer.from(await res.arrayBuffer())
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    let msg = buf.slice(0, 200).toString().replace(/[^\x20-\x7e\n]/g, '').trim()
    throw new Error(msg || `respons bukan gambar (HTTP ${res.status})`)
  }
  return buf
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
  let msg = m.quoted ? m.quoted : m
  let isImage = !!msg.message?.imageMessage
  if (!isImage) {
    return m.reply(`Reply atau kirim gambar dengan caption *${usedPrefix}${command} teks atas | teks bawah*\n\n` +
      `Contoh:\n${usedPrefix}${command} halo | dunia\n${usedPrefix}${command} cuma atas`)
  }

  // "atas | bawah"; tanpa "|" → semua jadi teks atas
  let [atas, bawah] = text ? text.split('|') : ['']
  if (!atas?.trim() && !bawah?.trim()) {
    return m.reply(`Kasih teksnya: *${usedPrefix}${command} teks atas | teks bawah*`)
  }

  await m.reply('⏳ Membuat meme...')

  let buffer
  try {
    buffer = await downloadMedia(msg.message)
  } catch (e) {
    return m.reply('❌ Gagal download gambar: ' + (e.message || e))
  }
  if (!buffer) return m.reply('❌ Gagal download gambar.')

  let imageUrl
  try {
    imageUrl = (await upload(buffer, `meme_${Date.now()}.jpg`, msg.message.imageMessage.mimetype || 'image/jpeg')).url
  } catch (e) {
    return m.reply('❌ Gagal upload gambar: ' + (e.message || e))
  }

  let meme
  try {
    meme = await buildMeme({ imageUrl, atas, bawah })
  } catch (e) {
    return m.reply('❌ Gagal buat meme: ' + (e.message || e))
  }

  let webp
  try {
    webp = await writeExif(
      { data: meme, mimetype: 'image/png', ext: 'png' },
      { packName: 'Created by', packPublish: m.pushname || 'Bot' }
    )
  } catch (e) {
    return m.reply('❌ Gagal jadi sticker: ' + (e.message || e))
  }
  if (!webp) return m.reply('❌ Gagal jadi sticker.')

  let tmpFile = path.join(TMP, `meme_${Date.now()}.webp`)
  fs.writeFileSync(tmpFile, webp)
  try {
    await conn.message.send(m.chat, {
      type: 'sticker',
      media: tmpFile,
      mimetype: 'image/webp'
    }, { quote: m })
  } finally {
    fs.unlinkSync(tmpFile)
  }
}

module.exports = handler

handler.description = "Buat sticker meme dari gambar yang di-reply (teks atas | teks bawah)."
handler.help = ['meme <atas> | <bawah>', 'smeme']
handler.tags = ['tools']
handler.command = /^(meme|memegen|smeme)$/i
