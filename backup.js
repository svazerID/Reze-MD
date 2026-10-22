#!/usr/bin/env node
// Backup repo Reze-MD ke backup.zip.
//
// Kenapa bukan `ls` + `zip -r`: (1) `ls` tanpa -A menyembunyikan dotfile, jadi
// .auth/ (sesi WhatsApp) dan .gitignore ikut hilang -> restore harus pairing
// ulang; (2) binary `zip` tidak tersedia di host ini. Pakai fs + zipfile
// (python) supaya daftar file eksplisit dan dotfile ikut.
//
// Yang SENGAJA dikecualikan:
//   node_modules/  -> 82MB, bisa dipasang ulang (npm install / bun install)
//   tmp/           -> file sementara, isinya cache proxy
//   logs/          -> log pm2, tidak perlu dibawa
//   backup.zip     -> jangan masukkan hasil backup ke dirinya sendiri
//
// Yang IKUT (penting untuk restore):
//   .auth/         -> sesi WhatsApp; tanpa ini pairing ulang dari nol
//   .git/          -> history
//   .yt-cookies.txt-> cookie YouTube (rahasia, tapi perlu untuk play)
//   data/          -> kredensial Google (rahasia)
//   database.json  -> state bot (users/chats/settings)

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = __dirname
const OUT = path.join(ROOT, 'backup.zip')
const EXCLUDE = new Set(['node_modules', 'tmp', 'logs', 'backup.zip', '.git/index.lock'])

function walk(dir, rel = '') {
  let out = []
  for (let e of fs.readdirSync(dir, { withFileTypes: true })) {
    let relPath = rel ? path.join(rel, e.name) : e.name
    if (EXCLUDE.has(relPath) || EXCLUDE.has(e.name)) continue
    let abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(abs, relPath))
    else if (e.isFile()) out.push(relPath)
  }
  return out
}

const files = walk(ROOT)
console.log(`📦 ${files.length} file akan dibackup`)

// Python zipfile: tidak butuh binary zip, dan bisa set mode file.
const script = `
import sys, zipfile, os
files = sys.argv[1:]
out = sys.argv[1] if False else None
`
// Tulis daftar file ke stdin python supaya tidak kena batas argumen.
const py = `
import sys, zipfile, os
root = sys.argv[1]
out = sys.argv[2]
files = [l.rstrip('\\n') for l in sys.stdin if l.strip()]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for f in files:
        p = os.path.join(root, f)
        try:
            z.write(p, f)
        except Exception as e:
            sys.stderr.write('skip %s: %s\\n' % (f, e))
print('OK', len(files))
`
try {
  const res = execFileSync('python3', ['-c', py, ROOT, OUT], {
    input: files.join('\n'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  console.log(res.trim())
} catch (e) {
  console.error('❌ gagal:', e.message)
  process.exit(1)
}

const size = fs.statSync(OUT).size
console.log(`✅ backup.zip: ${(size / 1024 / 1024).toFixed(1)} MB`)
