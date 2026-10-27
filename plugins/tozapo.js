const { extractText } = require('../lib/simple')
const airich = require('../lib/airich')
const { stripFence, highlightJS } = require('./toesm')._test

// Sama seperti contextInfo pada BotForwardedMessage.js (lihat plugins/toesm.js).
const FORWARDED = {
  mentionedJid: [],
  groupMentions: [],
  statusAttributions: [],
  forwardingScore: 1,
  isForwarded: true,
  forwardOrigin: 4
}

// Batas jumlah TODO yang dikumpulkan, biar balasan nggak kepanjangan.
const MAX_TODO_SCAN = 50

// Nama variabel pengirim di Baileys. Kadang `sock`, kadang `conn`/`wa`.
const SENDER = '(?:sock|conn|wa|client)'

// zapo di project ini memakai `conn`, bukan `client` (lihat handler.js yang
// memanggil plugin dengan `conn: this`). Jadi hasil konversi memakai
// `conn.message.send` / `conn.on(...)` supaya bisa ditempel langsung ke plugin.
const OUT = 'conn'

// Pemetaan pasti: [regex, pengganti]. Urutan penting — yang lebih spesifik
// (sendMessage per tipe media) harus jalan sebelum yang umum.
const EXACT = [
  // makeWASocket({...}) -> new WaClient({...})
  [/\bmakeWASocket\s*\(/g, 'new WaClient('],
  // sock.sendMessage(jid, { text: 'x' }) -> conn.message.send(jid, 'x')
  [new RegExp(`\\b${SENDER}\\.sendMessage\\s*\\(([^,]+),\\s*\\{\\s*text\\s*:\\s*([^,}]+?)\\s*\\}\\)`, 'g'), `${OUT}.message.send($1, $2)`],
  // sock.sendMessage(jid, { image|video|audio|document|sticker: x, ... }) -> payload type
  [
    new RegExp(`\\b${SENDER}\\.sendMessage\\s*\\(([^,]+),\\s*\\{\\s*(image|video|audio|document|sticker)\\s*:\\s*`, 'g'),
    (m, jid, kind) => `${OUT}.message.send(${jid}, { type: '${kind}', media: `
  ],
  // Listener event Baileys. Nama event sudah jadi placeholder karena string
  // dilindungi lebih dulu, jadi dicocokkan lewat bentuknya, bukan namanya.
  // Nama event asli dibiarkan di komentar TODO supaya user tahu harus apa.
  [/\bev\.on\s*\(\s*\u0001\d+\u0001\s*,\s+/g, '__ZAPO_EVENT__('],
  // Rapikan sisa spasi ganda setelah placeholder event diganti. Batasi ke
  // spasi di TENGAH baris (\S  ..  \S) supaya indentasi tidak ikut dirusak.
  [/(\S) {2,}(\S)/g, '$1 $2']
]

// Pola Baileys yang TIDAK bisa dipetakan otomatis. Kode aslinya dibiarkan,
// cuma ditambah penanda TODO di atas baris terkait.
const UNSUPPORTED = [
  [/\buseMultiFileAuthState\s*\(/, 'zapo pakai SQLite store, bukan folder auth'],
  [/\bsock\.ev\.on\s*\(\s*['"]creds\.update['"]/, 'kredensial dikelola store zapo'],
  [/\bgroupMetadata\s*\(/, 'cari path grup yang setara di zapo'],
  [/\bdownloadMediaMessage\s*\(/, 'zapo pakai media processor, bukan downloadMediaMessage'],
  [/\bsendPresenceUpdate\s*\(/, 'path presence zapo belum dipetakan'],
  [/\bgetContentType\s*\(/, 'cek label message di zapo'],
  [/\bmessages\[\s*\d+\s*\]/, 'payload event zapo berbeda (bukan messages[])'],
  [/\bmsg\.key\.remoteJid\b/, 'di zapo pakai m.chat'],
  [/\brelayMessage\s*\(/, 'relay message tidak tersedia di zapo'],
  [/\bprofilePictureUrl\s*\(/, 'path foto profil zapo belum dipetakan']
]

// Ganti isi string/template literal dengan placeholder sesaat supaya regex
// tidak menyentuh teks. Placeholder sengaja pakai karakter yang tidak
// pernah muncul di kode asli, dan restore() mengembalikan isi aslinya.
const MARK = '\u0001'
function protectStrings(code) {
  let saved = []
  let out = code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, hit => {
    saved.push(hit)
    return `${MARK}${saved.length - 1}${MARK}`
  })
  return {
    code: out,
    saved,
    // Tutup celah: `out` ditangkap saat dibuat, jadi restore() WAJIB memakai
    // hasil replace yang sudah jalan, bukan `out` aslinya.
    restore(current) {
      let src = typeof current === 'string' ? current : out
      return src.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => saved[Number(i)])
    }
  }
}

// Pindai pola tak didukung, kembalikan semuanya unik.
function collectTodos(code) {
  let todos = []
  for (let [re, reason] of UNSUPPORTED) {
    if (re.test(code) && !todos.includes(reason)) todos.push(reason)
    if (todos.length >= MAX_TODO_SCAN) break
  }
  return todos
}

// Tambah komentar TODO di atas baris pertama yang menyentuh pola itu.
function markTodos(code, todos) {
  if (!todos.length) return code
  let lines = code.split('\n')
  // Iterasi mundur supaya index baris yang belum disisipi tetap valid.
  for (let i = UNSUPPORTED.length - 1; i >= 0; i--) {
    let [re, reason] = UNSUPPORTED[i]
    if (!todos.includes(reason)) continue
    let idx = lines.findIndex(l => re.test(l))
    if (idx === -1) continue
    // Jangan sisipkan TODO dobel kalau baris di atasnya sudah ditandai.
    if (/^\/\/ TODO\(zapo\):/.test(lines[idx - 1] || '')) continue
    // Ikuti indentasi baris yang ditandai supaya blok kode tetap rapi.
    let indent = (lines[idx].match(/^\s*/) || [''])[0]
    lines.splice(idx, 0, `${indent}// TODO(zapo): ${reason}`)
  }
  return lines.join('\n')
}

// Baileys -> zapo. String dilindungi dulu, baru regex jalan.
function convertBaileysToZapo(code) {
  let guard = protectStrings(String(code || ''))
  let body = guard.code

  for (let [re, to] of EXACT) {
    body = body.replace(re, to)
  }

  // Placeholder event -> nama event zapo yang benar. Nama asli Baileys
  // diambil dari daftar simpanan proteksi string supaya TODO bisa menyebutnya.
  // "sock.ev.on(" sudah diganti "sock.__ZAPO_EVENT__(" — lengkapi jadi
  // "client.on('nama', " biar nama variabel ikut normal.
  body = body.replace(/\b(\w+)\.__ZAPO_EVENT__\(/g, (_, obj) => {
    let raw = guard.saved.find(s => /messages\.upsert|connection\.update|creds\.update/.test(s)) || ''
    let name = raw.replace(/^['"`]|['"`]$/g, '')
    if (/messages\.upsert/.test(name)) return `${OUT}.on('message', `
    if (/connection\.update/.test(name)) return `${OUT}.on('connection', `
    return `${OUT}.on(/* TODO(zapo): event ${name || 'tidak dikenal'} belum dipetakan */ 'message', `
  })

  body = guard.restore(body)
  let todos = collectTodos(body)
  body = markTodos(body, todos)
  return { code: body, todos }
}

// --- Driver test ringan (project ini tanpa test framework) ---

function runTest() {
  let fail = 0
  function check(name, actual, expected, contains) {
    let ok = contains ? actual.includes(expected) : actual === expected
    if (!ok) {
      fail++
      console.log(`❌ ${name}\n  expected: ${expected}\n  actual:   ${actual}`)
    } else {
      console.log(`✅ ${name}`)
    }
  }

  check('t1 text', convertBaileysToZapo("await sock.sendMessage(jid, { text: 'halo' })").code, "await conn.message.send(jid, 'halo')")
  check('t2 image', convertBaileysToZapo("await sock.sendMessage(jid, { image: buf, caption: 'x' })").code, "conn.message.send(jid, { type: 'image', media: buf, caption: 'x' })", true)
  check('t3 upsert', convertBaileysToZapo("sock.ev.on('messages.upsert', async ({ messages }) => {})").code, "conn.on('message',", true)
  check('t4 conn', convertBaileysToZapo("await conn.sendMessage(jid, { text: 'a' })").code, "await conn.message.send(jid, 'a')")
  check('t5 socket', convertBaileysToZapo('const sock = makeWASocket({ auth })').code, 'new WaClient(', true)
  check('t6 todo', convertBaileysToZapo('const md = await sock.groupMetadata(jid)').code, 'TODO(zapo)', true)
  check('t7 zapo', convertBaileysToZapo("await conn.message.send(jid, 'a')").code, "await conn.message.send(jid, 'a')")
  check('t8 string', convertBaileysToZapo("console.log('sock.sendMessage(x)')").code, "console.log('sock.sendMessage(x)')")
  check('t9 auth', convertBaileysToZapo("const { state } = await useMultiFileAuthState('auth')").code, 'useMultiFileAuthState', true)

  return fail
}

if (require.main === module && process.argv.includes('--test')) {
  let fail = runTest()
  console.log(fail ? `\n${fail} test gagal` : '\nsemua test lolos')
  process.exit(fail ? 1 : 0)
}

// Prefix global (config.js). Plugin ini dipakai lewat chat, jadi global.prefix
// selalu ada di runtime bot. Driver test tidak load config.js (file itu memasang
// fs.watchFile yang bikin proses nggak exit), jadi pakai default yang sama.
function stripPrefix(code) {
  let text = String(code || '').trimStart()
  let prefix = global.prefix || /^[!#$%+£¢€¥^°=¶∆×÷π√✓©®:;?&.\-]/
  // Payload chat bisa ikut menempel "..tozapo" dua kali.
  for (let i = 0; i < 3; i++) {
    let hit = (text.match(prefix) || [''])[0]
    let rest = text.slice(hit.length)
    let match = rest.match(/^tozapo\b\s*/i)
    if (!match) break
    text = rest.slice(match[0].length).trimStart()
  }
  return text
}

function run(m, { conn, text, command }) {
  let input = text?.trim() || (m.quoted ? extractText(m.quoted.message) : '')
  if (!input) return m.reply('❌ Masukkan atau reply kode Baileys yang ingin diubah.')

  let code = stripFence(stripPrefix(input))
  if (!code) return m.reply('❌ Kodenya kosong setelah prefix dibuang.')

  let result = convertBaileysToZapo(code)
  let label = 'Baileys → zapo'

  let submessages = [
    airich.text(`# 🔄 ${label}`),
    airich.code(highlightJS(result.code), 'javascript')
  ]
  if (result.todos.length) {
    submessages.push(airich.text(
      '⚠️ Perlu dicek manual:\n' + result.todos.map(t => `• ${t}`).join('\n')
    ))
  }

  return airich.send(conn, m.chat, submessages, { quote: m, contextInfo: FORWARDED })
    .catch(async () => {
      // AIRich tidak selalu dirender semua client — tetap kirim hasilnya sebagai teks.
      let warn = result.todos.length
        ? `\n\n⚠️ Perlu dicek manual:\n${result.todos.map(t => `• ${t}`).join('\n')}`
        : ''
      await m.reply(`🔄 *${label}*\n\n\`\`\`javascript\n${result.code}\n\`\`\`${warn}`)
    })
}

module.exports = {
  convertBaileysToZapo,
  MAX_TODO_SCAN,
  name: 'tozapo',
  description: 'Convert kode Baileys (CJS/ESM) ke zapo, pola yang belum didukung ditandai TODO.',
  tags: ['tools'],
  permissions: {},
  command: /^tozapo$/i,
  run,
  // diekspos buat driver test: node plugins/tozapo.js --test
  _test: { convertBaileysToZapo, collectTodos, markTodos, protectStrings, stripPrefix, MAX_TODO_SCAN }
}