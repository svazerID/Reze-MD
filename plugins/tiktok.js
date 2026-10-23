let fs = require('fs')
let path = require('path')

module.exports = {
    name: 'tiktok',
    description: 'Download video atau image slide TikTok.',
    aliases: ['tt'],
    tags: ['downloader'],
    permissions: {},
    command: /^(tiktok|tt)$/i,
    run: async (m, { conn, args, usedPrefix, command }) => {
        if (!args[0]) return m.reply(`Contoh: ${usedPrefix}${command} https://vt.tiktok.com/xxxxx/`)
        let url = args[0]
        if (!/tiktok\.com/i.test(url)) return m.reply('URL tidak valid, harus link TikTok')

        await m.reply('⏳ Mengambil konten TikTok...')
        try {
            let res = await fetch(`https://alsya.svazer.eu.cc/api/download/tiktok?url=${encodeURIComponent(url)}`)
            let json = await res.json()
            if (!json.status) return m.reply('❌ Gagal: ' + (json.message || 'unknown error'))

            let data = json.data
            let caption = [
                `${data.title || '-'}`
               /* `👤 @${data.author?.username || 'unknown'} (${data.author?.nickname || '-'})`,
                `❤️ ${(data.like || 0).toLocaleString()} likes`,
                `👁️ ${(data.views || 0).toLocaleString()} views`,
                `💬 ${(data.comment || 0).toLocaleString()} comments`,
                `⏱️ ${data.duration || '-'}` */
            ].join('\n')

            let tmpDir = path.join(__dirname, '..', 'tmp')
            fs.mkdirSync(tmpDir, { recursive: true })

            // Image slide: data.download berupa array
            if (Array.isArray(data.download) && data.download.length > 0) {
                for (let i = 0; i < data.download.length; i++) {
                    let imgUrl = data.download[i]
                    if (typeof imgUrl !== 'string' || !imgUrl) continue
                    let imgRes = await fetch(imgUrl)
                    if (!imgRes.ok) continue
                    let tmpFile = path.join(tmpDir, `tiktok_${Date.now()}_${i}.jpg`)
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
            } else {
                // Video
                let videoUrl = data.download
                if (!videoUrl) return m.reply('❌ Tidak ada konten di link tersebut')

                let videoRes = await fetch(videoUrl)
                if (!videoRes.ok) throw new Error('Download video gagal: HTTP ' + videoRes.status)
                let tmpFile = path.join(tmpDir, `tiktok_${Date.now()}.mp4`)
                let buffer = Buffer.from(await videoRes.arrayBuffer())
                fs.writeFileSync(tmpFile, buffer)

                await conn.message.send(m.chat, {
                    type: 'video',
                    media: tmpFile,
                    mimetype: 'video/mp4',
                    caption
                }, { quote: m })
                fs.unlinkSync(tmpFile)
            }

            // Selalu kirim audio
            let musicUrl = data.music?.url
            if (musicUrl) {
                let audioRes = await fetch(musicUrl)
                if (audioRes.ok) {
                    let audioFile = path.join(tmpDir, `tiktok_audio_${Date.now()}.mp3`)
                    let audioBuf = Buffer.from(await audioRes.arrayBuffer())
                    fs.writeFileSync(audioFile, audioBuf)
                    await conn.message.send(m.chat, {
                        type: 'audio',
                        media: audioFile,
                        mimetype: 'audio/mpeg',
                        ptt: false
                    }, { quote: m })
                    fs.unlinkSync(audioFile)
                }
            }
        } catch (e) {
            m.reply('❌ Error: ' + (e.message || e)).catch(() => {})
        }
    }
};
