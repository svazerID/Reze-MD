let handler = async (m, { conn, text, participants }) => {
  if (!participants?.length) return m.reply('Gagal mengambil daftar member.')

  let users = participants.map(p => p.jid).filter(Boolean)
  let pesan = text ? `*Pesan:* ${text}\n\n` : ''
  let body = users.map(jid => '@' + jid.split('@')[0]).join(' ')

  await conn.message.send(m.chat, {
    type: 'text',
    text: `${pesan}👥 *Tag All* (${users.length} member)\n\n${body}`
  }, {
    quote: m,
    mentions: users
  })
}
handler.description = "Tag semua member grup sekaligus, opsional dengan pesan."
handler.help = ['tagall <pesan>']
handler.tags = ['group']
handler.command = /^(tagall|tagsemua)$/i
handler.group = true
handler.admin = true
handler.botAdmin = true
handler.participants = true

module.exports = handler
