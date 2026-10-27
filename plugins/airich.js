const fs = require('fs')
const path = require('path')
const vm = require('vm')

const EXAMPLE = path.join(__dirname, '..', 'data', 'BotForwardedMessage.js')
const DEFAULT_IMAGE = 'https://svazer-upload.vercel.app/file/96943042.jpg'
const IMAGE_HOST = 'https://cdn.ornzora.eu.cc/'
const IMAGE_URL_RE = /https:\/\/cdn\.ornzora\.eu\.cc\/[^\s)>"\\]+/g

let demo
let loaded = false

// ponytail: demo diambil apa adanya dari BotForwardedMessage.js. Yang dieksekusi
// hanya literal payload-nya (tanpa `conn.message.send`), di sandbox tanpa require/process.
function loadDemo() {
  if (loaded) return demo
  loaded = true
  try {
    let src = fs.readFileSync(EXAMPLE, 'utf8')
    let start = src.indexOf('{', src.indexOf('m.chat,'))
    let end = src.lastIndexOf('\n  {}\n)')
    if (start < 0 || end < 0) throw new Error('struktur conn.message.send tidak dikenali')

    let objectSrc = src.slice(start, end).replace(/,\s*$/, '').trim()
    let raw = vm.runInNewContext('(' + objectSrc + ')', { Buffer }, { timeout: 2000 })
    if (!raw?.botForwardedMessage) throw new Error('payload botForwardedMessage tidak ditemukan')
    demo = raw
  } catch (e) {
    console.error('airich: gagal memuat BotForwardedMessage.js:', e.message)
    demo = null
  }
  return demo
}

// Ganti semua URL gambar contoh (host ornzora) dengan gambar pilihan.
function swapImages(value, imageUrl) {
  if (typeof value === 'string') return value.includes(IMAGE_HOST) ? value.replace(IMAGE_URL_RE, imageUrl) : value
  if (Array.isArray(value)) return value.map(v => swapImages(v, imageUrl))
  if (!value || typeof value !== 'object') return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value

  let out = {}
  for (let key of Object.keys(value)) out[key] = swapImages(value[key], imageUrl)
  return out
}

// unifiedResponse.data berisi JSON; ganti URL gambarnya di teks JSON.
function swapUnifiedImages(buffer, imageUrl) {
  if (!buffer) return buffer
  let json = Buffer.from(buffer).toString().replace(/https:\/\/cdn\.ornzora\.eu\.cc\/[^"\\]+/g, imageUrl)
  return Buffer.from(json)
}

let handler = async (m, { conn, text }) => {
  let raw = loadDemo()
  if (!raw) return m.reply('❌ BotForwardedMessage.js tidak ada atau tidak valid.')

  let imageUrl = /^https?:\/\/\S+$/.test(text || '') ? text.trim() : DEFAULT_IMAGE
  let payload = swapImages(raw, imageUrl)
  let rich = payload.botForwardedMessage.message.richResponseMessage
  if (rich.unifiedResponse?.data) {
    rich.unifiedResponse.data = swapUnifiedImages(rich.unifiedResponse.data, imageUrl)
  }

  try {
    await conn.message.send(m.chat, payload, {})
  } catch (e) {
    await m.reply('❌ Gagal kirim AIRich: ' + (e.message || e))
  }
}

module.exports = {
  name: 'airich',
  description: 'Kirim payload AIRich persis dari BotForwardedMessage.js.',
  aliases: ['rich'],
  tags: ['advanced'],
  permissions: { ownerOnly: true },
  command: /^(airich|rich)$/i,
  run: handler
}
