const API = 'https://alsya.svazer.eu.cc/api/search/lyrics'
const MAX_CHARS = 3500

module.exports = {
  name: 'lyrics',
  description: 'Cari lirik lagu.',
  aliases: ['lirik'],
  tags: ['search'],
  permissions: {},
  command: /^(lyrics|lirik)$/i,
  run: async (m, { text, usedPrefix, command }) => {
    let query = (text || '').trim()
    if (!query) return m.reply(`Contoh: ${usedPrefix}${command} runtuh`)

    await m.reply('🔎 Mencari lirik...')
    try {
      let url = new URL(API)
      url.searchParams.set('q', query)
      let res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let data = await res.json()
      if (!data.status || !data.result?.length) return m.reply(`❌ Lirik "${query}" tidak ditemukan.`)

      let song = data.result[0]
      let lyrics = String(song.plainLyrics || '').trim()
      if (!lyrics) return m.reply('❌ Lirik tidak tersedia untuk hasil ini.')

      let heading = `🎵 *${song.track || query}*\n👤 ${song.artist || 'Artis tidak diketahui'}${song.album ? `\n💿 ${song.album}` : ''}\n\n`
      let chunks = []
      while (lyrics.length) {
        let limit = Math.max(1, MAX_CHARS - (chunks.length ? 0 : heading.length))
        let cut = lyrics.length > limit ? lyrics.lastIndexOf('\n', limit) : lyrics.length
        if (cut <= 0) cut = limit
        chunks.push(lyrics.slice(0, cut).trim())
        lyrics = lyrics.slice(cut).trimStart()
      }
      for (let i = 0; i < chunks.length; i++) {
        await m.reply((i === 0 ? heading : `🎵 *${song.track || query} (lanjutan)*\n\n`) + chunks[i])
      }
    } catch (e) {
      m.reply(`❌ Gagal mencari lirik: ${e.message || e}`)
    }
  }
}
