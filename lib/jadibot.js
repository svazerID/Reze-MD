// Jadibot session manager: satu WaClient zapo per user, semua share satu store.
// Docs: zapo.to/en/guides/multi-session
const { ConsoleLogger, WaClient } = require('zapo-js')

const sessions = new Map() // ownerJid -> { client, phone, status }

function sessionIdFor(ownerJid) {
  return 'jadibot-' + ownerJid.replace(/[^a-zA-Z0-9]/g, '')
}

/**
 * Buat session jadibot untuk user.
 * @param {object} opts
 * @param {string} opts.ownerJid JID pemilik session (pesan status dikirim ke sini)
 * @param {string} opts.phone Nomor WA yang di-pair (digit saja, cth 628xxx)
 */
async function createSession({ ownerJid, phone }) {
  if (sessions.has(ownerJid)) return { exists: true }
  let max = global.maxJadibot || 3
  if (sessions.size >= max) return { full: true, max }

  let sessionId = sessionIdFor(ownerJid)
  let client = new WaClient(
    {
      store: global.store,
      sessionId,
      recoverFromClientTooOld: true,
      // Satu processor untuk semua sesi; stateless (docs: guides/multi-session).
      media: { processor: global.mediaProcessor }
    },
    new ConsoleLogger('warn')
  )
  let session = { client, phone, status: 'connecting' }
  sessions.set(ownerJid, session)

  // --- Pairing code ---
  let pairingRequested = false
  async function requestPairing() {
    if (pairingRequested) return
    pairingRequested = true
    try {
      let code = await client.auth.requestPairingCode(phone)
      session.status = 'waiting_pairing'
      await global.conn.message.send(ownerJid, [
        `*🤖 JADIBOT*`,
        ``,
        `Kode pairing kamu: *${code.match(/.{1,4}/g).join('-')}*`,
        ``,
        `Masukkan di WhatsApp:`,
        `*Perangkat tertaut > Tautkan dengan nomor telepon*`,
        ``,
        `Kalau kode expired, ulangi: !jadibot ${phone}`
      ].join('\n')).catch(() => {})
    } catch (err) {
      pairingRequested = false
      conn_message(ownerJid, '❌ Gagal minta kode pairing: ' + err.message)
    }
  }
  client.on('auth_qr', requestPairing)
  client.on('auth_pairing_required', requestPairing)
  client.on('auth_paired', ({ credentials }) => {
    session.status = 'paired'
    global.db.data.jadibot ??= {}
    global.db.data.jadibot[ownerJid] = phone
    conn_message(ownerJid, [
      `✅ *JADIBOT AKTIF!*`,
      `Login sebagai ${credentials.meJid}`,
      ``,
      `Bot kamu sudah online — semua command bisa dipakai dari nomor itu.`,
      `Untuk berhenti: *!stopjadibot*`
    ].join('\n'))
  })

  // --- Reconnect dengan backoff ---
  let attempt = 0
  let shuttingDown = false
  session.shutdown = async () => {
    shuttingDown = true
    await client.disconnect().catch(() => {})
  }
  client.on('connection', (event) => {
    if (event.status === 'open') { attempt = 0; session.status = 'online'; return }
    if (shuttingDown || event.reason === 'client_disconnected') return
    if (event.isLogout) {
      session.status = 'logged_out'
      sessions.delete(ownerJid)
      delete global.db.data.jadibot?.[ownerJid]
      conn_message(ownerJid, '⚠️ Session jadibot kamu di-logout dari server. Jalankan !jadibot lagi untuk pairing ulang.')
      return
    }
    let delay = Math.min(30000, 1000 * 2 ** attempt++)
    setTimeout(() => client.connect().catch(() => {}), delay)
  })

  // Handler sama dengan bot utama — jadibot = bot penuh
  client.handler = require('../handler').handler
  client.on('message', client.handler)

  client.connect().catch(err => {
    session.status = 'connect_failed'
    conn_message(ownerJid, '❌ Gagal connect: ' + err.message)
  })

  return { created: true, sessionId }
}

async function stopSession(ownerJid) {
  let session = sessions.get(ownerJid)
  if (!session) return { exists: false }
  sessions.delete(ownerJid)
  delete global.db.data.jadibot?.[ownerJid]
  await session.shutdown()
  await global.store.session(sessionIdFor(ownerJid)).destroy().catch(() => {})
  return { stopped: true }
}

function listSessions() {
  return [...sessions.entries()].map(([ownerJid, s]) => ({ ownerJid, phone: s.phone, status: s.status }))
}

function conn_message(jid, text) {
  global.conn.message.send(jid, text).catch(() => {})
}

module.exports = { createSession, stopSession, listSessions, sessions, sessionIdFor }
