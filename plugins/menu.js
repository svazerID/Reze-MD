const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const THUMB = path.join(__dirname, '..', 'input.jpg')
const URL_REPO = 'https://takina.svazer.eu.cc'

// Thumbnail inline WA dibatasi 64KB (INLINE_THUMBNAIL_MAX_BYTES zapo) — resize
// biar pasti masuk + width/height di-set eksplisit seperti snippet Baileys.
async function getThumb() {
    if (!fs.existsSync(THUMB)) return null
    try {
        let bytes = await sharp(THUMB).resize(300, 300, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()
        return { bytes, width: 1280, height: 720 }
    } catch {
        return null
    }
}

module.exports = {
    name: 'menu',
    description: 'Tampilkan semua perintah yang tersedia.',
    aliases: ['help'],
    tags: ['info'],
    permissions: {},
    command: /^(menu|help)$/i,
    run: async (m, { conn, usedPrefix }) => {
        let byTag = {}
        for (let name of Object.keys(global.plugins).sort()) {
            let p = global.plugins[name]
            if (!p.tags?.length || !p.names?.length) continue
            for (let tag of p.tags) (byTag[tag] ??= []).push(p)
        }
        let lines = [`${global.packname || 'Bot'}`, '']
        let total = 0
        for (let [tag, plugins] of Object.entries(byTag)) {
            lines.push(`── *${tag.toUpperCase()}* ──`)
            for (let p of plugins) {
                total += p.names.length
                lines.push(`• ${usedPrefix}${p.names.join(' | ')}`)
                if (p.description) lines.push(`> ${p.description}`)
            }
            lines.push('')
        }
        lines.push(`Total: ${total} perintah`)

        // Link preview custom via API native zapo (linkPreview di content teks).
        // URL di awal teks + 400 zero-width space → link ke-repo tapi tidak
        // terlihat sebagai URL. matchedText = URL itu (wajib ada di teks).
        let thumb = await getThumb()
        let text = lines.join('\n')
        let content = { type: 'text', text }
        if (thumb) {
            const invisible = '\u200B'.repeat(400)
            content.text = `${URL_REPO}${invisible}${text}`
            content.linkPreview = {
                matchedText: URL_REPO,
                title: global.packname || 'Bot',
                description: 'WhatsApp Multi Device Bot',
                thumbnail: { bytes: new Uint8Array(thumb.bytes), width: thumb.width, height: thumb.height }
            }
        }
        await conn.message.send(m.chat, content, { quote: m })
    }
};