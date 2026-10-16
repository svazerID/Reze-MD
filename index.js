// Supervisor 
console.log('Starting...')
let { spawn } = require('child_process')
let path = require('path')
let fs = require('fs')
let pkg = require('./package.json')

console.log(`\n  ${pkg.name} v${pkg.version} — WhatsApp Bot (zapo-js)\n`)

var isRunning = false
// Auto-retry dengan backoff untuk exit transient (kode 1: timeout/403 IP-block/dll).
// Exit 2 = fatal (banned/logout/PHONE_NUMBER invalid) butuh campur tangan manusia:
// TIDAK di-retry otomatis, cuma restart kalau main.js diedit (perilaku lama).
// Cron platform lagi di-skip semua, jadi retry ini satu-satunya jalan bot bangun
// sendiri begitu blokir IP WhatsApp lepas — tanpa ini bot mati diam sampai ada
// yang `pm2 restart` manual.
var failCount = 0
var retryTimer = null
var RETRY_DELAYS = [2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 15 * 60 * 1000]
function armFileWatch(file, args) {
  fs.unwatchFile(args[0])
  fs.watchFile(args[0], () => {
    fs.unwatchFile(args[0])
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    failCount = 0
    console.log('[supervisor] main.js berubah, restart sekarang')
    start(file)
  })
}
/**
 * Start a js file
 * @param {String} file `path/to/file`
 */
function start(file) {
  if (isRunning) return
  isRunning = true
  let args = [path.join(__dirname, file), ...process.argv.slice(2)]
  console.log([process.argv[0], ...args].join(' '))
  let startedAt = Date.now()
  let p = spawn(process.argv[0], args, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  p.on('message', data => {
    console.log('[RECEIVED]', data)
    switch (data) {
      case 'reset':
        p.kill()
        isRunning = false
        start.apply(this, arguments)
        break
      case 'uptime':
        p.send(process.uptime())
        break
    }
  })
  p.on('exit', code => {
    isRunning = false
    console.error('Exited with code:', code)
    if (code === 0) { failCount = 0; return }
    if (Date.now() - startedAt > 10 * 60 * 1000) failCount = 0 // sempat hidup lama = reset backoff
    armFileWatch(file, args)
    if (code === 2) {
      console.error('[supervisor] exit fatal (2) — TIDAK auto-retry, butuh hapus .auth / benerin config dulu')
      return
    }
    let delay = RETRY_DELAYS[Math.min(failCount, RETRY_DELAYS.length - 1)]
    failCount++
    console.error(`[supervisor] retry #${failCount} dalam ${Math.round(delay / 60000)} menit...`)
    retryTimer = setTimeout(() => { retryTimer = null; start(file) }, delay)
  })
}

start('main.js')
