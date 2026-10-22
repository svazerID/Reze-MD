// postch / sendch / upch — posting pesan atau media ke Channel (newsletter) WA
//
// Format plugin: sama seperti plugin lain di repo ini (CJS, module.exports,
// m = pesan hasil smsg(), conn = client zapo).
// Zap0 path: conn.newsletter.send(jid, content) — content pakai bentuk
// WaSendMediaMessage ({ type, media, mimetype, caption, ... }), upload ke CDN
// channel dilakukan internal oleh buildNewsletterMessageContent.
//
// Pakai:
//   .postch teks                       -> kirim teks ke channel
//   .postch caption + reply foto/video -> kirim media + caption
//   Reply audio -> voice note (opus), reply document -> document

const { spawn } = require('node:child_process')
const { downloadMediaMessage, resolveMediaPayload } = require('zapo-js')
const { extractText } = require('../lib/simple')

const CHANNEL_JID = '120363420643650987@newsletter'
const AUTO_CAPTION = 'Satu %s mendarat dengan mulus di channel ini! 🚀\n\n> _*✨ Powered by Reze-MD*_'

// kind -> label buat auto-caption
const KIND_LABEL = { image: 'Gambar', video: 'Video', gif: 'Video', ptv: 'Video' }

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function ffmpegToBuffer(args, input) {
  return new Promise((resolve, reject) => {
    const bufs = []
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'ignore'] })
    ff.stdout.on('data', c => bufs.push(c))
    ff.on('error', reject)
    ff.on('close', code => {
      if (code === 0 && bufs.length) resolve(Buffer.concat(bufs))
      else reject(new Error('ffmpeg exit ' + code))
    })
    ff.stdin.write(input)
    ff.stdin.end()
  })
}

// audio apa pun -> ogg/opus biar jalan sebagai voice note
function toOpus(buffer) {
  return ffmpegToBuffer(['-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-f', 'ogg', 'pipe:1'], buffer)
}

// ambil 1 frame video buat thumbnail (2 percobaan: offset 0.7s, lalu frame 1)
function extractFrame(buffer) {
  return ffmpegToBuffer(['-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], buffer)
}

async function buildVideoThumbnail(videoBuf, fallbackThumb) {
  try {
    let raw = await extractFrame(videoBuf).catch(() => null)
    if (!raw && fallbackThumb) {
      return Buffer.isBuffer(fallbackThumb) ? fallbackThumb : Buffer.from(fallbackThumb)
    }
    if (!raw) return null
    const sharp = (await import('sharp')).default
    return await sharp(raw).resize({ width: 72 }).jpeg({ quality: 60 }).toBuffer()
  } catch {
    return null
  }
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
  let caption = (text || '').trim()
  let quoted = m.quoted?.message || null

  if (!quoted && !caption) {
    return m.reply(`⚠️ Reply pesan/media yang mau dikirim ke channel, atau ketik teksnya langsung.\n\nContoh: ${usedPrefix}${command} halo semua`)
  }

  const react = emoji => conn.message.send(m.chat, { type: 'reaction', emoji, target: m }).catch(() => {})
  await react('⏳')

  try {
    let content = null

    if (quoted) {
      // payload bisa null (pesan teks) — resolveMediaPayload tetap dipanggil
      // karena ia unwrap view-once/ephemeral.
      let payload = null
      try { payload = resolveMediaPayload(quoted) } catch {}
      let quotedCaption = extractText(quoted) || ''

      if (payload) {
        let media = await streamToBuffer(await downloadMediaMessage(quoted))
        let kind = payload.mediaType // image | video | gif | audio | ptt | document | sticker | ptv

        let finalCaption = caption || quotedCaption
        if (!finalCaption && (kind === 'image' || kind === 'video' || kind === 'gif' || kind === 'ptv')) {
          finalCaption = AUTO_CAPTION.replace('%s', KIND_LABEL[kind] || 'Media')
        }

        if (kind === 'audio' || kind === 'ptt') {
          // voice note: convert ke opus, biar tampil sebagai VN di channel
          try { media = await toOpus(media) } catch {}
          content = { type: 'audio', media, mimetype: 'audio/ogg; codecs=opus', ptt: true }
        } else if (kind === 'video' || kind === 'gif' || kind === 'ptv') {
          let orig = quoted.videoMessage || {}
          let thumb = await buildVideoThumbnail(media, orig.jpegThumbnail)
          content = {
            type: kind === 'ptv' ? 'ptv' : 'video',
            media,
            mimetype: payload.mimetype || 'video/mp4',
            caption: finalCaption,
            gifPlayback: kind === 'gif' || !!orig.gifPlayback,
            ...(thumb ? { jpegThumbnail: thumb } : {})
          }
        } else if (kind === 'document') {
          let doc = quoted.documentMessage || {}
          content = {
            type: 'document',
            media,
            mimetype: payload.mimetype || doc.mimetype || 'application/octet-stream',
            fileName: doc.fileName || doc.title || 'file_' + Date.now(),
            caption: finalCaption
          }
        } else if (kind === 'sticker') {
          content = { type: 'sticker', media, mimetype: payload.mimetype || 'image/webp' }
        } else {
          // image (dan sisanya diperlakukan sebagai foto)
          try {
            const sharp = (await import('sharp')).default
            media = await sharp(media).jpeg({ quality: 90 }).toBuffer()
          } catch {}
          let thumb = null
          try {
            const sharp = (await import('sharp')).default
            thumb = await sharp(media).resize({ width: 64 }).jpeg({ quality: 50 }).toBuffer()
          } catch {}
          content = { type: 'image', media, mimetype: payload.mimetype || 'image/jpeg', caption: finalCaption }
          if (thumb) content.jpegThumbnail = thumb
        }
      } else {
        // pesan yang di-reply bukan media -> gabung teks quote + caption
        let gabung = [caption, quotedCaption].filter(Boolean).join('\n\n')
        if (!gabung) return m.reply('❌ Pesan yang di-reply tidak punya teks/media yang bisa dikirim.')
        content = { type: 'text', text: gabung }
      }
    } else {
      content = { type: 'text', text: caption }
    }

    await conn.newsletter.send(CHANNEL_JID, content)
    await react('✅')
    return m.reply('✅ Berhasil diposting ke Channel!')
  } catch (e) {
    await react('❎')
    return m.reply('❌ Gagal kirim ke channel: ' + String(e?.message || e).slice(0, 200))
  }
}

module.exports = {
  name: 'postch',
  description: 'Posting pesan atau media (audio/video/gambar/dokumen) ke Channel WA.',
  aliases: ['sendch', 'upch'],
  tags: ['owner'],
  permissions: { ownerOnly: true },
  command: /^(postch|sendch|upch)$/i,
  run: handler
}
