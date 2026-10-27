const { extractText } = require('../lib/simple')
const airich = require('../lib/airich')

// Sama seperti contextInfo pada BotForwardedMessage.js.
const FORWARDED = {
  mentionedJid: [],
  groupMentions: [],
  statusAttributions: [],
  forwardingScore: 1,
  isForwarded: true,
  forwardOrigin: 4
}

function stripFence(code) {
  let match = code.trim().match(/^```[\w-]*\n([\s\S]*?)\n```$/)
  return match ? match[1] : code
}

// Buang prefix + nama command yang ikut tertempel di payload (mis. ".tocjs .tocjs import ...").
function stripLeadingCommand(code) {
  let text = code.trimStart()
  for (let i = 0; i < 3; i++) {
    let prefix = (text.match(global.prefix) || [''])[0]
    let rest = text.slice(prefix.length)
    let match = rest.match(/^(toesm|tocjs)\b\s*/i)
    if (!match) break
    text = rest.slice(match[0].length).trimStart()
  }
  return text
}

const JS_KEYWORDS = new Set((
  'async await break case catch class const continue debugger default delete do else export extends ' +
  'false finally for from function if import in instanceof let new null of return static super switch ' +
  'this throw true try typeof undefined var void while yield require module exports process console'
).split(' '))

// Pecah kode jadi blok ber-highlight supaya client merendernya sebagai code JS, bukan teks polos.
function highlightJS(code) {
  let re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|((?:[^\w"'`\/]|\/(?![\/*]))+)/g
  let blocks = []
  let match
  while ((match = re.exec(code))) {
    let [raw, comment, string, number, word] = match
    let type = airich.CODE.DEFAULT
    if (comment) type = airich.CODE.COMMENT
    else if (string) type = airich.CODE.STRING
    else if (number) type = airich.CODE.NUMBER
    else if (word) {
      if (JS_KEYWORDS.has(word)) type = airich.CODE.KEYWORD
      else if (/^\s*\(/.test(code.slice(re.lastIndex))) type = airich.CODE.METHOD
    }
    blocks.push({ highlightType: type, codeContent: raw })
  }
  return blocks.length ? blocks : [{ highlightType: airich.CODE.DEFAULT, codeContent: code }]
}

// --- Fungsi Helper ---

function convertCJSToESM(code) {
  return code
    // 1. Handle Destructuring: const { a, b } = require('c') -> import { a, b } from 'c'
    .replace(/(?:const|let|var)\s+\{\s*([\w\s,]+)\s*\}\s*=\s*require\(['"](.+?)['"]\);?/g, (_, names, mod) => `import { ${names.trim()} } from '${mod}';`)

    // 2. Handle Simple: const a = require('b') -> import a from 'b'
    .replace(/(?:const|let|var)\s+(\w+)\s*=\s*require\(['"](.+?)['"]\);?/g, (_, name, mod) => `import ${name} from '${mod}';`)

    // 3. module.exports -> export default
    .replace(/module\.exports\s*=\s*(.*?);?$/gm, (_, value) => `export default ${value.trim()};`)

    // 4. exports.nama -> export const nama
    .replace(/exports\.(\w+)\s*=\s*(.*?);/g, (_, name, value) => `export const ${name} = ${value.trim()};`)
}

function convertESMToCJS(code) {
  return code
    // 1. import { a, b } from 'c' -> const { a, b } = require('c')
    .replace(/import\s+\{\s*([^}]+)\s*\}\s+from\s+['"](.+?)['"];?/g, (_, names, mod) => `const { ${names.trim()} } = require('${mod}');`)

    // 2. import a from 'b' -> const a = require('b')
    .replace(/import\s+(\w+)\s+from\s+['"](.+?)['"];?/g, (_, name, mod) => `const ${name} = require('${mod}');`)

    // 3. import * as a from 'b' -> const a = require('b')
    .replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"](.+?)['"];?/g, (_, name, mod) => `const ${name} = require('${mod}');`)

    // 4. export default a -> module.exports = a
    .replace(/export\s+default\s+(.*?);?$/gm, (_, value) => `module.exports = ${value.trim()};`)

    // 5. export const a = b -> exports.a = b
    .replace(/export\s+const\s+(\w+)\s*=\s*(.*?);/g, (_, name, value) => `exports.${name} = ${value.trim()};`)
}

async function run(m, { conn, text, command }) {
  let codeToConvert = text?.trim() || (m.quoted ? extractText(m.quoted.message) : '')
  if (!codeToConvert) return m.reply('❌ Masukkan atau reply kode yang ingin diubah.')

  let result, label
  if (command === 'toesm') {
    result = convertCJSToESM(stripFence(stripLeadingCommand(codeToConvert)))
    label = 'CJS → ESM'
  } else if (command === 'tocjs') {
    result = convertESMToCJS(stripFence(stripLeadingCommand(codeToConvert)))
    label = 'ESM → CJS'
  } else {
    return m.reply('❌ Perintah tidak dikenal.')
  }

  try {
    await airich.send(conn, m.chat, [
      airich.text(`# 🔄 ${label}`),
      airich.code(highlightJS(result), 'javascript')
    ], { quote: m, contextInfo: FORWARDED })
  } catch (e) {
    // AIRich tidak selalu dirender semua client — tetap kirim hasilnya sebagai teks.
    await m.reply(`🔄 *${label}*\n\n\`\`\`javascript\n${result}\n\`\`\``)
  }
}

module.exports = {
  name: 'toesm',
  description: 'Convert CJS ↔ ESM, hasil dikirim sebagai AIRich.',
  aliases: ['tocjs'],
  tags: ['tools'],
  permissions: {},
  command: /^(toesm|tocjs)$/i,
  run
}

module.exports._test = { convertCJSToESM, convertESMToCJS, stripFence, stripLeadingCommand, highlightJS }
