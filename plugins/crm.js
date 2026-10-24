// crm — relay ulang pesan yang di-reply (raw Proto.IMessage) lalu kirim file .js
// berisi cuplikan `conn.message.send(...)` untuk eksperimen.
// Padanan zapo: tidak ada relayMessage/generateWAMessageFromContent —
// client.message.send menerima raw Proto.IMessage apa adanya.

const UNWRAP_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage'
]

// Metadata yang bukan tipe pesan — tidak dipakai untuk nama file.
const META_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

const isBytes = v => Buffer.isBuffer(v) || v instanceof Uint8Array

// Buka wrapper berlapis (ephemeral/view-once) sampai konten aslinya.
function unwrap(content) {
  let cur = content
  let guard = 0
  while (cur && typeof cur === 'object' && guard++ < 10) {
    let key = UNWRAP_KEYS.find(k => cur[k]?.message)
    if (!key) break
    cur = cur[key].message
  }
  return cur
}

// Buang properti internal (`_stats`, dll) dan fungsi — sisanya payload protobuf.
function cleanContent(content) {
  let out = {}
  for (let key of Object.keys(content || {})) {
    if (key.startsWith('_')) continue
    if (typeof content[key] === 'function') continue
    if (content[key] === undefined) continue
    out[key] = content[key]
  }
  return out
}

// Serialisasi nilai protobuf jadi literal JS yang bisa dieksekusi ulang.
function toJsLiteral(value, indent = 2, seen = new WeakSet(), depth = 0) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (isBytes(value)) return `Buffer.from(${JSON.stringify(Buffer.from(value).toString('base64'))}, "base64")`

  if (typeof value !== 'object') return JSON.stringify(value)
  if (depth > 40) return '"[MaxDepth]"'
  if (seen.has(value)) return '"[Circular]"'
  seen.add(value)

  const pad = ' '.repeat(indent)
  const padClose = ' '.repeat(Math.max(indent - 2, 0))

  let result
  if (Array.isArray(value)) {
    if (!value.length) result = '[]'
    else {
      const items = value.map(v => pad + toJsLiteral(v, indent + 2, seen, depth + 1))
      result = `[\n${items.join(',\n')}\n${padClose}]`
    }
  } else {
    const keys = Object.keys(value).filter(k =>
      !k.startsWith('_') && typeof value[k] !== 'function' && value[k] !== undefined)
    if (!keys.length) result = '{}'
    else {
      const lines = keys.map(k => {
        const keyStr = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)
        return `${pad}${keyStr}: ${toJsLiteral(value[k], indent + 2, seen, depth + 1)}`
      })
      result = `{\n${lines.join(',\n')}\n${padClose}}`
    }
  }

  seen.delete(value)
  return result
}

function typeName(content) {
  let key = Object.keys(content || {}).find(k => !k.startsWith('_') && !META_KEYS.has(k))
  key = key || 'UnknownMessage'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

function buildCode(content) {
  return `=> conn.message.send(\n  m.chat,\n  ${toJsLiteral(content, 4)},\n  {}\n)`
}

const handler = async (m, { conn }) => {
  let raw = m.quoted?.message || m.quotedCtx?.quotedMessage
  if (!raw) {
    return m.reply('❌ Reply pesan yang mau di-relay dulu, lalu ketik *!crm*.')
  }

  let content = unwrap(raw)
  if (!content || typeof content !== 'object' || !Object.keys(content).length) {
    return m.reply('❌ Jenis pesan ini belum didukung untuk di-relay.')
  }

  let clean = cleanContent(content)
  let filename = `${typeName(clean)}.js`
  let code = buildCode(clean)

  // Relay dulu, tapi file tetap dikirim walau relay gagal.
  let relayError = null
  try {
    await conn.message.send(m.chat, clean)
  } catch (e) {
    relayError = String(e?.message || e).slice(0, 200)
  }

  let caption = `📄 ${filename}`
  if (relayError) caption += `\n\n⚠️ Relay gagal: ${relayError}`

  await conn.message.send(m.chat, {
    type: 'document',
    media: Buffer.from(code, 'utf8'),
    fileName: filename,
    mimetype: 'text/javascript',
    caption
  }, { quote: m })
}

module.exports = {
  name: 'crm',
  description: 'Relay ulang pesan yang di-reply + kirim kode raw Proto.IMessage-nya.',
  aliases: [],
  tags: ['advanced'],
  permissions: { ownerOnly: true },
  command: /^crm$/i,
  run: handler
}

// --- Ekspor internal untuk test (tidak dibaca loader) ---
module.exports._test = { unwrap, cleanContent, toJsLiteral, typeName, buildCode }
