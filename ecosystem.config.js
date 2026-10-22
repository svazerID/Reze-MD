// Konfigurasi pm2 untuk Reze-MD.
// Pakai: pm2 start ecosystem.config.js && pm2 save
//
// Catatan penting:
// - cwd WAJIB di root repo: main.js buka `database.json` dan `.auth/state.sqlite`
//   pakai path relatif. Kalau cwd salah, bot bikin sesi baru → pairing ulang.
// - index.js itu supervisor (spawn main.js + backoff retry), jadi pm2 cukup
//   mengawasi satu proses ini. Jangan start main.js langsung dari pm2.
// - autorestart: true supaya bot bangun lagi kalau supervisor sendiri mati.
module.exports = {
  apps: [
    {
      name: 'Reze-MD',
      script: 'index.js',
      cwd: __dirname,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Jangan restart-loop kalau pairing/config salah: 5x gagal lalu berhenti.
      max_restarts: 5,
      min_uptime: '60s',
      restart_delay: 5000,
      // main.js pakai node:sqlite + sharp; ~200-400MB saat aktif.
      max_memory_restart: '900M',
      kill_timeout: 10000, // beri waktu shutdown() tutup sqlite + jadibot
      env: {
        NODE_ENV: 'production',
        // Nomor bot (bukan nomor owner). Isi lewat shell, jangan hardcode di repo:
        //   PHONE_NUMBER=628xxx pm2 start ecosystem.config.js
        // Kalau kosong, bot minta input nomor di stdin -> di pm2 tidak ada TTY.
        PHONE_NUMBER: process.env.PHONE_NUMBER || '',
        // yt-dlp & bun ada di ~/.bun/bin, tidak ikut PATH default pm2.
        PATH: process.env.HOME + '/.bun/bin:' + process.env.PATH
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true
    }
  ]
}
