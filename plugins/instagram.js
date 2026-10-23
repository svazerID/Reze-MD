let fs = require('fs')
let path = require('path')

module.exports = {
    name: 'instagram',
    description: 'Download video atau image dari Instagram.',
    aliases: ['ig', 'igdl'],
    tags: ['downloader'],
    permissions: {},
    command: /^(instagram|ig|igdl)$/i,
    run: async (m, { conn, args, usedPrefix, command }) => {
        if (!args[0]) return m.reply(`Contoh: ${usedPrefix}${command} https://www.instagram.com/reel/xxxxx/`)
        let url = args[0]
        if (!/instagram\.com/i.test(url)) return m.reply('URL tidak valid, harus link Instagram')

        await m.reply('⏳ Mengambil konten Instagram...')
        try {
            let res = await fetch(`https://alsya.svazer.eu.cc/api/download/aio?url=${encodeURIComponent(url)}`)
            let json = await res.json()
            if (!json.status) return m.reply('❌ Gagal: ' + (json.message || 'unknown error'))

            let result = json.result
            let data = result?.data
            if (!data) return m.reply('❌ Tidak ada data dari link tersebut')

            let caption = [
                `*📸 Instagram Downloader*`,
                ``,
                `📝 ${(data.title || '-').substring(0, 200)}`
            ].join('\n')

            let tmpDir = path.join(__dirname, '..', 'tmp')
            fs.mkdirSync(tmpDir, { recursive: true })

            // Image carousel
            if (Array.isArray(data.images) && data.images.length > 0) {
                for (let i = 0; i < data.images.length; i++) {
                    let imgUrl = typeof data.images[i] === 'string' ? data.images[i] : data.images[i].url
                    if (!imgUrl) continue
                    let imgRes = await fetch(imgUrl)
                    if (!imgRes.ok) continue
                    let tmpFile = path.join(tmpDir, `ig_${Date.now()}_${i}.jpg`)
                    let buf = Buffer.from(await imgRes.arrayBuffer())
                    fs.writeFileSync(tmpFile, buf)
                    await conn.message.send(m.chat, {
                        type: 'image',
                        media: tmpFile,
                        mimetype: 'image/jpeg',
                        caption: i === 0 ? caption : ''
                    }, { quote: m })
                    fs.unlinkSync(tmpFile)
                }
                return
            }

            // Video: ambil kualitas tertinggi
            if (Array.isArray(data.videos) && data.videos.length > 0) {
                let best = data.videos.sort((a, b) => (b.qualityScore || b.quality || 0) - (a.qualityScore || a.quality || 0))[0]
                let videoRes = await fetch(best.url)
                if (!videoRes.ok) throw new Error('Download video gagal: HTTP ' + videoRes.status)
                let tmpFile = path.join(tmpDir, `ig_${Date.now()}.mp4`)
                let buf = Buffer.from(await videoRes.arrayBuffer())
                fs.writeFileSync(tmpFile, buf)
                await conn.message.send(m.chat, {
                    type: 'video',
                    media: tmpFile,
                    mimetype: 'video/mp4',
                    caption
                }, { quote: m })
                fs.unlinkSync(tmpFile)
                return
            }

            m.reply('❌ Tidak ada konten yang bisa di-download')
        } catch (e) {
            m.reply('❌ Error: ' + (e.message || e)).catch(() => {})
        }
    }
};
