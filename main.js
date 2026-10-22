const chalk = require('chalk')

// --- Banner ---
const pkg = require('./package.json')
console.log(chalk.cyan('╭──────────────────────────────────────╮'))
console.log(chalk.cyan('│') + chalk.bold.white('  🤖 Reze-MD                            '))
console.log(chalk.cyan('│') + chalk.gray(`  ${pkg.name} v${pkg.version}`.padEnd(40) + ' '))
console.log(chalk.cyan('│') + chalk.gray('  zapo-js • Node.js + Termux            '))
console.log(chalk.cyan('╰──────────────────────────────────────╯'))
console.log()
require('./config.js')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('readline')
// Native WebSocket Node 26 gagal handshake ke server WhatsApp (HTTP/2 experimental),
// pakai package ws yang sudah terbukti connect.
// Inject headers Origin + User-Agent supaya server tidak reject dengan HTTP 200.
const Ws = require('ws')
// Container: semua outbound WAJIB lewat egress proxy (env HTTPS_PROXY/https_proxy),
// direct connection dibunuh di tengah jalan (TLS wrong version). Di Termux env
// itu tidak ada jadi tetap direct. Patch WebSocket-nya tetap, cuma tambah agent.
let proxyAgent
try {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxyUrl) {
    const { HttpsProxyAgent } = require('https-proxy-agent')
    proxyAgent = new HttpsProxyAgent(proxyUrl)
  }
} catch (e) { /* tanpa proxy = direct seperti di Termux */ }
globalThis.WebSocket = function PatchedWs(url, protocols, opts) {
  // zapo-js calls: new WebSocket(url, { protocols, headers })
  // ws v8 needs:    new Ws(url, protocols, options)
  if (typeof protocols === 'object' && protocols !== null && !Array.isArray(protocols)) {
    opts = protocols
    protocols = undefined
  }
  opts = Object.assign({
    headers: {
      Origin: 'https://web.whatsapp.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  }, opts || {})
  // Always use 3-arg form so ws parses headers correctly
  if (proxyAgent && !opts.agent) opts.agent = proxyAgent
  return new Ws(url, protocols || [], opts)
}
Object.assign(globalThis.WebSocket, Ws)
for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) globalThis.WebSocket[k] = Ws[k]
const { ConsoleLogger, createStore, WaClient } = require('zapo-js')
const { createSqliteStore } = require('@zapo-js/store-sqlite')

function normalizePhone(num) {
  return String(num || '').replace(/[^0-9]/g, '')
}

// Nomor bot yang mau di-pairing. Prioritas: env PHONE_NUMBER, kalau kosong
// baru prompt interaktif (askPhone).
// JANGAN fallback ke global.owner — itu nomor owner/user, BUKAN nomor bot.
// Kalau bot milik orang lain, pairing ke nomor owner bikin sesi tersambung
// ke akun yang bukan miliknya.
const PHONE_NUMBER = normalizePhone(process.env.PHONE_NUMBER) || null

// Env PHONE_NUMBER yang dikasih tapi ga valid, lebih baik stop sekalian
// daripada diam-diam fallback ke prompt.
if (process.env.PHONE_NUMBER && (!PHONE_NUMBER || PHONE_NUMBER.length < 10)) {
  console.error(chalk.red(`❌ PHONE_NUMBER tidak valid: ${JSON.stringify(process.env.PHONE_NUMBER)}`))
  console.error(chalk.gray('PHONE_NUMBER harus angka saja, contoh: 6281234567890'))
  // exit 2 = fatal butuh campur tangan manusia (supervisor TIDAK auto-retry)
  process.exit(2)
}

global.timestamp = { start: new Date() }
global.lidCache = {} // LID → phone number cache, populate dari group metadata

// --- Database JSON ---
const DB_FILE = 'database.json'
global.db = {
  data: null,
  read() {
    try { this.data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) } catch { this.data = {} }
    this.data = { users: {}, chats: {}, stats: {}, msgs: {}, settings: {}, jadibot: {}, ...(this.data || {}) }
  },
  write() {
    fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2))
  }
}
global.db.read()
setInterval(() => global.db.write(), 60 * 1000) // save tiap menit

// --- Store & client zapo ---
// driver 'node' = node:sqlite bawaan Node 22.13+ (tanpa native build).
// better-sqlite3 butuh node-gyp; di host ini compile-nya SIGABRT (exit 134).
fs.mkdirSync('.auth', { recursive: true })
global.store = createStore({
  backends: { sqlite: createSqliteStore({ path: '.auth/state.sqlite', driver: 'node' }) },
  providers: {
    auth: 'sqlite', signal: 'sqlite', preKey: 'sqlite', session: 'sqlite',
    identity: 'sqlite', senderKey: 'sqlite', appState: 'sqlite', privacyToken: 'sqlite',
    messages: 'none', threads: 'none', contacts: 'sqlite'
  }
})
let mediaProcessor = require('./lib/mediaProcessor')
global.conn = new WaClient(
  {
    store: global.store,
    sessionId: 'default',
    recoverFromClientTooOld: true,
    media: {
      processor: {
        generateImageThumbnail: mediaProcessor.generateImageThumbnail,
        generateVideoThumbnail: mediaProcessor.generateVideoThumbnail,
        probeMedia: mediaProcessor.probeMedia
      }
    }
  },
  new ConsoleLogger('warn')
)

// --- Pairing code ---
// Kode pairing WA berlaku ~180s (PAIRING_CODE_MAX_AGE_SECONDS di zapo).
// Mint SEKALI; jangan mint ulang tiap reconnect/QR-rotate — kalau mint ulang,
// kode yang sedang diketik user jadi invalid dan pairing loop selamanya.
let pairingRequested = false
let pairingCodeAt = 0
const PAIRING_CODE_TTL_MS = 170_000
async function requestPairing(tag) {
  if (conn.getState?.().registered) return
  // zapo menyimpan sesi pairing di memori; hilang saat disconnect. Jadi patokan
  // utamanya hasPairingCode, bukan flag lokal — kalau sesi masih hidup, JANGAN
  // mint ulang (kode yang diketik user jadi invalid). TTL sebagai jaring kedua.
  const alive = conn.getState?.().hasPairingCode && Date.now() - pairingCodeAt < PAIRING_CODE_TTL_MS
  if (alive) return
  pairingRequested = true
  pairingCodeAt = Date.now()
  let phoneNumber = PHONE_NUMBER
  if (!phoneNumber) {
    phoneNumber = await askPhone()
  }
  if (!phoneNumber) {
    pairingRequested = false
    return
  }
  try {
    const code = await conn.auth.requestPairingCode(phoneNumber)
    console.log()
    console.log(chalk.green('╭──────────────────────────────────────╮'))
    console.log(chalk.green('│') + chalk.bold.white('  📱 KODE PAIRING                       '))
    console.log(chalk.green('│') + chalk.yellow(`  ${code.match(/.{1,4}/g).join('-')}`))
    console.log(chalk.green('│'))
    console.log(chalk.green('│') + chalk.gray('  Buka WhatsApp → Perangkat tertaut'))
    console.log(chalk.green('│') + chalk.gray('  → Tautkan dengan nomor telepon'))
    console.log(chalk.green('│') + chalk.gray('  → Masukkan kode di atas (berlaku ~3 menit)'))
    console.log(chalk.green('╰──────────────────────────────────────╯'))
    console.log()
  } catch (err) {
    pairingRequested = false
    console.error(`Gagal meminta pairing code (${tag || 'event'}):`, err.message)
  }
}

function askPhone() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question('Masukkan nomor WhatsApp (cth: 6281234567890): ', answer => {
      rl.close()
      let num = normalizePhone(answer)
      if (num.length < 10) {
        console.error('Nomor terlalu pendek, coba lagi.')
        return resolve(askPhone())
      }
      resolve(num)
    })
  })
}
conn.on('auth_qr', () => requestPairing('auth_qr'))
conn.on('auth_pairing_required', () => requestPairing('auth_pairing_required'))
conn.on('auth_pairing_code', ({ code }) => {
  console.log(chalk.cyan('🔑 Kode pairing (refresh):') + ' ' + chalk.bold.yellow(String(code).match(/.{1,4}/g).join('-')))
})
conn.on('auth_paired', ({ credentials }) => {
  pairingRequested = true // sudah paired, jangan mint kode lagi
  console.log(chalk.green('✅ Pairing berhasil') + chalk.gray(` → ${credentials.meJid}`))
  global.timestamp.connect = new Date()
})

// --- Reconnect: exponential backoff, skip reason fatal ---
const FATAL_REASONS = new Set([
  'stream_error_replaced', 'stream_error_device_removed', 'stream_error_force_logout',
  'failure_not_authorized', 'failure_banned', 'failure_locked',
  'failure_bad_user_agent', 'primary_identity_key_change'
])
let reconnectAttempt = 0
let reconnectScheduled = false
let shuttingDown = false

function scheduleReconnect() {
  if (reconnectScheduled) return
  reconnectScheduled = true
  const delayMs = Math.min(30_000, 1_000 * 2 ** reconnectAttempt)
  reconnectAttempt += 1
  console.log(chalk.yellow(`🔄 Reconnect dalam ${delayMs / 1000} detik`) + chalk.gray(` (percobaan ${reconnectAttempt})...`))
  setTimeout(() => {
    reconnectScheduled = false
    conn.connect().catch(err => {
      console.error('Reconnect gagal:', err.message)
      scheduleReconnect()
    })
  }, delayMs)
}

conn.on('auth_passkey_required', ({ hasSigner }) => {
  console.error(chalk.red('🔐 Server minta passkey (Shortcake).') + chalk.gray(` hasSigner=${hasSigner}`))
  if (!hasSigner) console.error(chalk.gray('   → Pairing code TIDAK akan selesai tanpa signPasskeyAssertion. Coba lagi / pakai QR.'))
})

conn.on('connection', (event) => {
  if (event.status === 'open') {
    reconnectAttempt = 0
    console.log(chalk.green('🟢 Terhubung ke WhatsApp!'))
    return
  }
  if (event.isLogout || FATAL_REASONS.has(event.reason)) {
    console.error(chalk.red(`🔴 Putus fatal (${event.reason})`) + chalk.gray(' — hapus folder .auth lalu pairing ulang.'))
    // exit 2 = fatal (banned/logout) butuh campur tangan manusia: hapus .auth dulu.
    // Supervisor sengaja TIDAK auto-retry kode ini.
    process.exit(2)
  }
  if (shuttingDown || event.reason === 'client_disconnected') return
  console.log(chalk.yellow(`⚠️  Koneksi terputus (${event.reason})`))
  scheduleReconnect()
})

// --- Plugin loader + hot reload ---
let pluginFolder = path.join(__dirname, 'plugins')
let pluginFilter = filename => /\.js$/.test(filename)
function normalizePlugin(p) {
  if (typeof p === 'function') {
    // Format lama: module.exports = async (m, ctx) => {...} dengan properti command/tags/etc
    let fn = p
    let names = []
    if (fn.command instanceof RegExp) {
      names.push(...(fn.command.source.match(/([a-z]+)/gi) || []))
    } else if (typeof fn.command === 'string') {
      names.push(fn.command.toLowerCase())
    }
    return {
      name: names[0] || fn.name || fn.help || 'anonymous',
      names,
      description: fn.description || '',
      command: fn.command,
      customPrefix: fn.customPrefix,
      tags: fn.tags || [],
      owner: !!fn.owner,
      group: !!fn.group,
      private: !!fn.private,
      admin: !!fn.admin,
      botAdmin: !!fn.botAdmin,
      run: fn
    }
  }
  if (p && typeof p === 'object' && typeof p.run === 'function') {
    // Format baru: { name, description, aliases, tags, permissions, run }
    let perm = p.permissions || {}
    let cmd = p.command || (Array.isArray(p.aliases) && p.aliases.length ? p.aliases[0] : null)
    let names = []
    if (cmd instanceof RegExp) {
      names.push(...(cmd.source.match(/([a-z]+)/gi) || []))
    } else if (typeof cmd === 'string') {
      names.push(cmd.toLowerCase())
    }
    if (Array.isArray(p.aliases)) names.push(...p.aliases.filter(a => !names.includes(a)))
    return {
      name: names[0] || p.name || 'anonymous',
      names,
      description: p.description || '',
      command: cmd instanceof RegExp ? cmd : (typeof cmd === 'string' ? cmd.toLowerCase() : null),
      autoReply: p.autoReply || null,
      all: typeof p.all === 'function' ? p.all : null,
      disabled: !!p.disabled,
      customPrefix: p.customPrefix || null,
      tags: p.tags || [],
      owner: !!perm.ownerOnly,
      group: !!perm.groupOnly,
      private: !!perm.privateOnly,
      admin: !!perm.adminOnly,
      botAdmin: !!perm.botAdmin,
      run: p.run
    }
  }
  return null
}

global.plugins = {}
for (let filename of fs.readdirSync(pluginFolder).filter(pluginFilter)) {
  try {
    let raw = require(path.join(pluginFolder, filename))
    let plugin = normalizePlugin(raw)
    if (!plugin) {
      console.error(chalk.red(`❌ Plugin '${filename}' format tidak dikenali`))
      continue
    }
    global.plugins[filename] = plugin
  } catch (e) {
      console.error(chalk.red(`❌ Gagal load plugin '${filename}':`) + ' ' + e.message)
    delete global.plugins[filename]
  }
}
console.log(chalk.cyan('📦 Plugin dimuat:') + ' ' + Object.keys(global.plugins).join(', '))

global.reload = (_event, filename) => {
  if (!pluginFilter(filename)) return
  let dir = path.join(pluginFolder, filename)
  if (dir in require.cache) {
    delete require.cache[dir]
    if (!fs.existsSync(dir)) {
      console.warn(chalk.red(`🗑️  Plugin dihapus: '${filename}'`))
      return delete global.plugins[filename]
    }
    console.log(chalk.gray(`♻️  Reload plugin '${filename}'`))
  } else console.log(chalk.gray(`➕ Plugin baru '${filename}'`))
  try {
    let raw = require(dir)
    let plugin = normalizePlugin(raw)
    if (!plugin) {
      console.error(chalk.red(`❌ Plugin '${filename}' format tidak dikenali`))
      return delete global.plugins[filename]
    }
    global.plugins[filename] = plugin
  } catch (e) {
    console.error(chalk.red(`❌ Syntax error plugin '${filename}':`) + ' ' + e.message)
  }
}
fs.watch(pluginFolder, global.reload)

// --- Handler ---
let isInit = true
global.reloadHandler = function () {
  let handler = require('./handler')
  if (!isInit) conn.off('message', conn.handler)
  conn.handler = handler.handler
  conn.on('message', conn.handler)
  isInit = false
  return true
}
global.reloadHandler()

// --- Deteksi event grup → notifikasi ---
// Config per grup di global.db.data.settings (`ge:<groupJid>`).
// Handler dipasang ulang tiap reconnect? Tidak perlu: zapo tidak auto-reconnect
// dan instance conn tetap dipakai. Cukup pasang sekali di sini.
// List Store auto-reply: plugin hook runs on exact text matches only.
conn.on('message', async event => {
  if (event.key?.fromMe || !event.key?.isGroup || event.key?.isBroadcast) return
  try {
    let plugin = global.plugins['liststore.js']
    if (!plugin?.autoReply) return
    let m = require('./lib/simple').smsg(conn, event)
    if (global.db.data.users[m.sender]?.banned || global.db.data.chats[m.chat]?.isBanned) return
    await plugin.autoReply(m, conn)
  } catch (e) {
    console.error('[liststore] event error:', e.message || e)
  }
})

let groupEvents = require('./lib/groupEvents')
let offlineResuming = false
conn.on('offline_resume', (event) => {
  // Jangan proses event lama hasil drain antrean offline — bikin spam notifikasi.
  offlineResuming = event?.status === 'resuming'
  if (!offlineResuming) console.log(chalk.gray('📥 Selesai drain event offline, deteksi grup aktif lagi.'))
})
conn.on('group', (event) => {
  if (offlineResuming) return
  // Abaikan event lama (> 60 dtk) — mis. sisa antrean setelah reconnect.
  let ts = event.timestampSeconds
  if (ts && Date.now() / 1000 - ts > 60) return
  groupEvents.handleGroupEvent(conn, event).catch(e => console.error('[groupEvent]', e.message))
})
conn.on('picture', (event) => {
  if (offlineResuming) return
  let ts = event.timestampSeconds
  if (ts && Date.now() / 1000 - ts > 60) return
  groupEvents.handlePictureEvent(conn, event).catch(e => console.error('[groupEvent]', e.message))
})

// --- Graceful shutdown ---
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log(chalk.red('\n🔴 Mematikan bot...'))
  global.db.write()
  // Stop semua session jadibot dulu
  let jadibot = require('./lib/jadibot')
  for (let [ownerJid] of [...jadibot.sessions]) {
    await jadibot.stopSession(ownerJid).catch(() => {})
  }
  await conn.disconnect().catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', console.error)

conn.connect().then(() => {
  // Restore session jadibot yang tersimpan di database
  let jadibot = require('./lib/jadibot')
  let saved = global.db.data.jadibot || {}
  let count = Object.keys(saved).length
  if (count) {
    console.log(chalk.cyan(`🔄 Restore ${count} session jadibot...`))
    for (let [ownerJid, phone] of Object.entries(saved)) {
      jadibot.createSession({ ownerJid, phone }).catch(err => {
        console.error(`Gagal restore jadibot ${ownerJid}:`, err.message)
      })
    }
  }
}).catch(err => {
  console.error(chalk.red('❌ Gagal connect:') + ' ' + err.message)
  // exit 1 = transient (timeout/403 IP-block/dll) → supervisor auto-retry dengan backoff.
  // Beda dengan exit 2 (fatal: banned/logout/PHONE_NUMBER invalid) yang butuh manusia.
  process.exit(1)
})