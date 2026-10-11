const { writeExif } = require('../lib/exif')
const { downloadMedia, acquireFfmpegSlot } = require('../lib/mediaProcessor')
const { webpAnimToMp4 } = require('../lib/webpAnim')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const TMP = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

let handler = async (m, { conn, args, command, usedPrefix }) => {
  // --- STICKER ---
  if (/^(sticker|s|swm)$/i.test(command)) {
    let msg = m.quoted ? m.quoted : m
    let mediaType = getMediaType(msg.message)
    if (!mediaType || mediaType === 'audio' || mediaType === 'document') {
      return m.reply(`Reply atau kirim gambar/video dengan caption *${usedPrefix}${command}*\n\n` +
        `Custom nama pack:\n${usedPrefix}${command} Nama Pack | Publisher\n${usedPrefix}${command} alfi`)
    }

    // Default (tanpa args): packName "Created by", publisher = pushname + tanggal.
    // Dengan args: "Nama | Publisher" → persis, "Nama" → cuma nama (publisher kosong).
    let packName = global.packname || 'Sticker'
    let packPublish = global.author || 'Bot'
    let raw = args.join(' ').trim()
    if (raw) {
      let [n, p] = raw.split('|')
      if (p === undefined) {
        packName = n.trim() || packName
        packPublish = ''
      } else {
        if (n?.trim()) packName = n.trim()
        if (p?.trim()) packPublish = p.trim()
      }
    } else {
      let date = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' })
      packName = 'Created by'
      packPublish = m.pushname ? `${m.pushname}\n${date}` : date
    }

    let buffer = await downloadMedia(m.quoted?.message || m.message)
    if (!buffer) return m.reply('Gagal download media.')

    let ext = mediaType === 'image' ? 'png' : mediaType === 'video' ? 'mp4' : 'webp'
    let mimetype = msg.message?.imageMessage?.mimetype
      || msg.message?.videoMessage?.mimetype
      || msg.message?.stickerMessage?.mimetype
      || `image/${ext}`

    // Convert + exif. Webp pass-through di writeExif (cuma ditempeli exif),
    // jadi sticker tetap dapat packName/packPublish custom.
    let webpBuf = await writeExif(
      { data: buffer, mimetype, ext },
      { packName, packPublish }
    )

    if (!webpBuf) return m.reply('Gagal buat sticker.')
    let tmpFile = path.join(TMP, `stk_${Date.now()}.webp`)
    fs.writeFileSync(tmpFile, webpBuf)
    try {
      await conn.message.send(m.chat, {
        type: 'sticker',
        media: tmpFile,
        mimetype: 'image/webp'
      }, { quote: m })
    } finally {
      fs.unlinkSync(tmpFile)
    }
    return
  }

  // --- TOIMG ---
  if (/^(toimg|toimage)$/i.test(command)) {
    let msg = m.quoted ? m.quoted : m
    if (!m.quoted) return m.reply('Reply sticker yang mau dijadikan gambar.')
    if (getMediaType(msg.message) !== 'sticker') return m.reply('Itu bukan sticker.')

    let buffer = await downloadMedia(m.quoted?.message || msg.message)
    if (!buffer) return m.reply('Gagal download sticker.')

    let tmpFile = path.join(TMP, `toimg_${Date.now()}.webp`)
    fs.writeFileSync(tmpFile, buffer)
    try {
      await conn.message.send(m.chat, {
        type: 'image',
        media: tmpFile,
        mimetype: 'image/webp',
        caption: ''
      }, { quote: m })
    } finally {
      fs.unlinkSync(tmpFile)
    }
    return
  }

  // --- TOVIDEO ---
  if (/^(tovideo|tovid|tomp4)$/i.test(command)) {
    let msg = m.quoted ? m.quoted : m
    if (!m.quoted) return m.reply('Reply sticker yang mau dijadikan video.')
    if (getMediaType(msg.message) !== 'sticker') return m.reply('Itu bukan sticker.')

    let buffer = await downloadMedia(m.quoted?.message || msg.message)
    if (!buffer) return m.reply('Gagal download sticker.')

    let release = await acquireFfmpegSlot()
    let mp4Buffer
    try {
      mp4Buffer = await webpAnimToMp4(buffer)
      if (!mp4Buffer) throw new Error('No MP4 data')
    } catch (e) {
      mp4Buffer = null
      m.reply('❌ Gagal convert: ' + (e.message || e)).catch(() => {})
    } finally {
      release()
    }
    if (!mp4Buffer) return m.reply('❌ Sticker ini bukan animasi — cuma bisa jadi gambar (*!toimg*).')

    let tmpFile = path.join(TMP, `tovid_${Date.now()}.mp4`)
    fs.writeFileSync(tmpFile, mp4Buffer)
    try {
      await conn.message.send(m.chat, {
        type: 'video',
        media: tmpFile,
        mimetype: 'video/mp4',
        caption: ''
      }, { quote: m })
    } finally {
      fs.unlinkSync(tmpFile)
    }
    return
  }
}

function getMediaType(message) {
  if (!message) return null
  if (message.stickerMessage) return 'sticker'
  if (message.imageMessage) return 'image'
  if (message.videoMessage) return 'video'
  if (message.audioMessage) return 'audio'
  if (message.documentMessage) return 'document'
  return null
}

handler.description = "Buat sticker dari gambar/video (nama pack custom), atau ubah sticker jadi gambar/video."
handler.help = ['sticker', 'swm', 'toimg', 'tovideo']
handler.tags = ['tools']
handler.command = /^(sticker|s|swm|toimg|toimage|tovideo|tovid|tomp4)$/i

module.exports = handler

// --- WEBP TO MP4 HELPER ---
async function webp2mp4(source) {
  let form = new FormData()
  let isUrl = typeof source === 'string' && /https?:\/\//.test(source)
  form.append('new-image-url', isUrl ? source : '')
  form.append('new-image', isUrl ? '' : source, 'image.webp')
  let res = await fetch('https://ezgif.com/webp-to-mp4', {
    method: 'POST',
    body: form
  })
  let html = await res.text()
  let { document } = new JSDOM(html).window
  let form2 = new FormData()
  let obj = {}
  for (let input of document.querySelectorAll('form input[name]')) {
    obj[input.name] = input.value
    form2.append(input.name, input.value)
  }
  let res2 = await fetch('https://ezgif.com/webp-to-mp4/' + obj.file, {
    method: 'POST',
    body: form2
  })
  let html2 = await res2.text()
  let { document: document2 } = new JSDOM(html2).window
  return new URL(document2.querySelector('div#output > p.outfile > video > source').src, res2.url).toString()
}
