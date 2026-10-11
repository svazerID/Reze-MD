# AGENTS.md

Bot WhatsApp berbasis [zapo-js](https://github.com/vinikjkkj/zapo), jalan di Termux (Android). Pairing via kode 8 karakter, session persisten di SQLite, plugin hot-reload. Bahasa UI & komentar: Indonesia.

## Menjalankan

```bash
npm start                        # index.js (supervisor) spawn main.js, auto-restart saat crash
PHONE_NUMBER=628xxx npm start    # skip prompt nomor saat pairing pertama
```

Butuh: Node >= 20.9, binary `ffmpeg` (sticker video, thumbnail, audio convert).

Tidak ada test framework. Verifikasi minimal: `node --check <file>` untuk syntax. Verifikasi nyata = jalankan bot dan tes command-nya lewat WhatsApp.

## Arsitektur

```
index.js    → supervisor: spawn main.js, restart saat exit != 0
main.js     → patch WebSocket, connect zapo, pairing, reconnect backoff,
              plugin loader + hot reload (fs.watch), DB JSON, graceful shutdown
handler.js  → dispatcher: parse prefix, match plugin, cek permission, panggil plugin.run
plugins/*.js→ satu file per command, auto-load & hot-reload tanpa restart
lib/        → simple.js (smsg wrapper), exif, upload CDN, jadibot, interactive, mediaProcessor, print
```

Global state (di-set di `main.js`/`config.js`, dipakai di mana-mana):
`global.conn` (WaClient), `global.store`, `global.db` (JSON: users/chats/settings/jadibot, save tiap menit), `global.plugins`, `global.owner`, `global.prefix`, `global.lidCache` (LID → nomor HP).

## Membuat plugin

Dua format didukung (`normalizePlugin` di main.js), tapi **pakai format object untuk plugin baru**:

```js
module.exports = {
  name: 'halo',
  description: 'Sapa balik',
  aliases: ['hai'],
  tags: ['main'],                 // kategori di !menu
  permissions: {},                // ownerOnly | groupOnly | privateOnly | adminOnly | botAdmin
  command: /^(halo|hai)$/i,       // regex tanpa prefix
  run: async (m, { conn, args, text, usedPrefix, command, isOwner, isAdmin, isBotAdmin }) => {
    await m.reply('Halo!')
  }
}
```

- `m.chat` JID chat, `m.sender` JID pengirim, `m.reply()` balas dengan quote, `m.isGroup`, `m.quoted`.
- Command tanpa prefix global (seperti exec `> `): pakai `customPrefix = /^([>≥][>≥]?|=>|\$) /` + `command: /(?:)/i`.
- Permission lama (`handler.owner = true` dst) hanya di format function lama; jangan tambah plugin baru format itu.
- `!menu` baca `names`/`tags` dari hasil normalisasi — pastikan `command`/`aliases` benar supaya muncul di menu.

## Mengirim pesan & media

```js
// Teks
await m.reply('teks')

// Media (file path preferred; thumbnail digenerate otomatis oleh lib/mediaProcessor)
await conn.message.send(m.chat, {
  type: 'video',            // image | video | audio | document | sticker
  media: './tmp/file.mp4',  // path, Readable stream, atau Buffer
  mimetype: 'video/mp4',
  caption: '...'
}, { quote: m })

// Download media dari pesan
const { downloadMediaMessage } = require('zapo-js')
```

- File sementara tulis ke `tmp/`, hapus setelah terkirim.
- Upload CDN: `lib/upload.js` → `upload(buffer|path, name?, mimetype?)`.
- Tombol/interactive message: pakai `lib/interactive.js` (`prepareWAMessageMedia` + raw proto `interactiveMessage`). zapo-js bisa kirim raw proto karena fallback di `buildMediaMessageContent`. **Jangan pakai `externalAdReply` di `contextInfo`** — user sudah tolak pendekatan itu.
- Button click masuk lewat `extractText` di `lib/simple.js` (4 tipe message, field-nya beda-beda — lihat komentar di sana sebelum menyentuhnya).

## Jebakan (jangan di-"perbaiki")

- **Patch WebSocket di main.js** — native WebSocket Node 26 gagal handshake ke server WhatsApp; `globalThis.WebSocket` sengaja diganti package `ws` + header Origin/UA. Jangan hapus.
- **`ws` dipanggil dengan bentuk 3-arg** di patch itu karena zapo-js panggil dengan signature beda.
- **Normalisasi JID** — WhatsApp kirim JID sebagai PN (`phoneNumber@s.whatsapp.net`) atau LID (`...@lid`). Bandingkan JID selalu lewat `normalize()` (buang `@` dan `:`) atau `global.lidCache`; jangan banding string mentah.
- **mediaProcessor di main.js** (`media: { processor }`) — tanpa ini preview gambar/video blank abu-abu di WhatsApp. Sudah di-wire, jangan dilepas.
- **better-sqlite3 di Termux** butuh patch `android_ndk_path` di cache node-gyp (lihat README). Kalau build native gagal, itu penyebabnya.
- **Reconnect fatal** — reason di `FATAL_REASONS` (banned, logout, dll) sengaja `process.exit(1)`; supervisor tidak restart tanpa hapus `.auth`.
- `config.js` dan `handler.js` hot-reload via `fs.watchFile`/`global.reloadHandler` — perubahan global owner/prefix langsung aktif.

## Konvensi kode

- **Setiap perubahan fitur/fix WAJIB menambah entri di `FIX_LOG.md`** (entri baru di paling atas, format: judul + tanggal, gejala/root cause, fitur, jebakan, bukti verifikasi). Jangan commit tanpa update FIX_LOG.
- **Pesan commit polos, tanpa prefix `feat:`/`fix:`/`docs:`** — tulis kalimat biasa seperti orang ngobrol (`fix sticker tovideo pake ezgif`, bukan `fix(sticker): ...`).
- CommonJS (`require`/`module.exports`), bukan ESM.
- Gaya santai tanpa semicolon di banyak tempat — ikuti file yang diedit.
- Pesan error user diawali emoji (❌/⏳), komentar & log console berbahasa Indonesia.
- API downloader pihak ketiga: `api.alfisy.my.id` (lihat plugins/tiktok.js, instagram.js).
- Shortcut yang disengaja ditandai komentar `ponytail:` — jangan hapus tanpa paham batasannya.
