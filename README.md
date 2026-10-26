# Reze-MD

Bot WhatsApp dengan [zapo-js](https://github.com/vinikjkkj/zapo), Pairing via **kode 8 karakter** (tanpa scan QR), session persisten di SQLite, hot reload plugin tanpa restart.

## Fitur

- 🔗 **Pairing code** — tautkan perangkat lewat kode
- 🔌 **Plugin system** — satu file per command di `plugins/`, auto-load
- 🔥 **Hot reload** — tambah/edit plugin & config langsung aktif tanpa restart
- 💾 **Session persisten** — SQLite (`.auth/`), restart tidak perlu pairing ulang
- 🔁 **Auto reconnect** — exponential backoff, deteksi reason fatal (banned/logout)
- 🤖 **AI chatbot** — Claude Opus 4.8 dengan session per-user
- 🧩 **Multi-session jadibot** — bot bisa jadi "host" untuk user lain
- 🛡️ **Self/Public mode** — batasi bot hanya merespon owner

## Persyaratan

- Node.js >= 20.9.0
- `ffmpeg` binary (untuk sticker video, audio convert)
- Package `ws` (sudah di dependencies) — native WebSocket Node 26 gagal connect ke server WhatsApp
                                                                                                ### Catatan Termux

Build native `better-sqlite3` gagal dengan error `Undefined variable android_ndk_path`. Fix satu baris — tambahkan ke blok `'variables'` di `~/.cache/node-gyp/<versi-node>/include/node/common.gypi`:

```python
'android_ndk_path%': '',
```

Patch perlu diulang setiap upgrade Node (folder cache per-versi).

## Instalasi

```bash
git clone <repo> && cd Reze-MD
npm install
```

## Konfigurasi

Edit `config.js`:

```js
global.owner = ['6285815061014'] // nomor owner (format internasional tanpa +)
global.packname = 'MyBot'       // nama pack sticker
global.author = 'Bot'           // nama author sticker
```

## Menjalankan

```bash
npm start
# atau
node index.js
```

Jika belum pernah pairing, bot akan meminta nomor WhatsApp:

```
Masukkan nomor WhatsApp (cth: 6281234567890): 6285815061014
```

Bot menampilkan kode pairing:

```
========================================
  KODE PAIRING: XXXX-XXXX
  Masukkan kode ini di WhatsApp:
  Perangkat tertaut > Tautkan dengan nomor telepon
========================================
```

Di HP: **WhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon** → masukkan kode.

Setelah paired, session tersimpan — restart cukup `npm start` tanpa pairing ulang.

> **Tip:** Bisa juga langsung set nomor tanpa prompt: `PHONE_NUMBER=6285815061014 npm start`

## Daftar Command

### General

| Command | Fungsi | Akses |
|---|---|---|
| `!ping` | Cek bot aktif | Semua |
| `!menu` / `!help` | Daftar command | Semua |
| `!owner` | Kontak owner (vCard) | Semua |

### AI

| Command | Fungsi | Akses |
|---|---|---|
| `!ai <pesan>` | Chat AI Claude Opus 4.8 (dengan session) | Semua |
| `!claude <pesan>` | Alias untuk `!ai` | Semua |
| `!bot <pesan>` | Alias untuk `!ai` | Semua |

### Tools

| Command | Fungsi | Akses |
|---|---|---|
| `!sticker` / `!s` | Gambar/video → sticker | Semua |
| `!toimg` | Sticker → gambar | Semua |
| `!hd` | Upscale gambar ke HD | Semua |
| `!tourl` | Media → URL (upload ke CDN) | Semua |
| `!fetch <url>` / `!get <url>` | Fetch URL (JSON/text/binary) | Semua |
| `!tiktok <url>` / `!tt <url>` | Download video TikTok | Semua |

### Group Admin

| Command | Fungsi | Akses |
|---|---|---|
| `!tagall <pesan>` / `!tagsemua` | Mention semua member grup | Admin grup |
| `!kick @tag` / `!tendang` | Kick member dari grup | Admin grup + Bot admin |

### Owner

| Command | Fungsi | Akses |
|---|---|---|
| `!self` | Bot hanya merespon owner | Owner |
| `!public` | Bot merespon semua orang | Owner |
| `!jadibot <nomor>` | Buat sesi jadibot baru | Owner |
| `!stopjadibot` | Hentikan sesi jadibot sendiri | Owner |
| `!listjadibot` | Lihat semua sesi jadibot aktif | Owner |
| `> <kode>` | Eval JavaScript | Owner |
| `=> <kode>` | Eval + return value | Owner |
| `$ <command>` | Jalankan shell command | Owner |

Prefix default: `! # $ % + ...` (lihat `global.prefix` di `config.js`).

## Struktur Proyek

```
Reze-MD/
├── index.js            # Supervisor: spawn main.js, auto-restart saat crash
├── main.js             # Koneksi zapo, pairing, reconnect, plugin loader + hot reload
├── config.js           # Owner, prefix, packname (hot-reload)
├── handler.js          # Dispatcher: parse prefix, match plugin, cek permission
├── lib/
│   ├── simple.js       # smsg(): wrapper event zapo → objek m
│   ├── exif.js         # imageToWebp, videoToWebp, writeExif (sticker metadata)
│   ├── upload.js       # Upload file ke CDN (all media type)
│   └── jadibot.js      # Multi-session manager
├── plugins/
│   ├── ping.js         # !ping
│   ├── menu.js         # !menu / !help
│   ├── owner.js        # !owner
│   ├── exec.js         # > / => / $ (owner only)
│   ├── ai.js           # !ai / !claude / !bot
│   ├── sticker.js      # !sticker / !s / !toimg
│   ├── hd.js           # !hd (upscale gambar)
│   ├── tourl.js        # !tourl (media → URL)
│   ├── fetch.js        # !fetch / !get (fetch URL)
│   ├── tiktok.js       # !tiktok / !tt
│   ├── tagall.js       # !tagall (mention all)
│   ├── kick.js         # !kick / !tendang
│   ├── self.js         # !self / !public
│   ├── jadibot.js      # !jadibot
│   ├── stopjadibot.js  # !stopjadibot
│   ├── listjadibot.js  # !listjadibot
│   └── hotreload-test.js
├── .auth/              # Session SQLite zapo (gitignored)
├── database.json       # DB users/chats/settings (gitignored)
└── tmp/                # File sementara media (gitignored)
```

## Membuat Plugin Baru

Buat file di `plugins/`, langsung aktif tanpa restart:

```js
let handler = async (m, { conn, args, text, usedPrefix, command, isOwner, isAdmin }) => {
  await m.reply('Halo!')
  // m.chat    — JID chat
  // m.sender  — JID pengirim
  // m.reply() — balas dengan quote otomatis
  // conn.message.send(jid, content, options) — kirim pesan/media
}
handler.help = ['halo']           // tampil di !menu
handler.tags = ['main']           // kategori di !menu
handler.command = /^(halo)$/i     // regex command (tanpa prefix)

// Permission flags (opsional):
// handler.owner = true      — hanya owner
// handler.group = true      — hanya di grup
// handler.private = true    — hanya di chat pribadi
// handler.admin = true      — hanya admin grup
// handler.botAdmin = true   — bot harus admin
// handler.participants = true — butuh data participant grup

module.exports = handler
```

### Plugin customPrefix

Untuk command tanpa prefix global (seperti exec `> `):

```js
handler.customPrefix = /^([>≥][>≥]?|=>|\$) /
handler.command = /(?:)/i
```

## Library

| Module | Fungsi |
|---|---|
| `lib/simple.js` | `smsg()` — wrapper event zapo → objek `m` yang enak dipakai plugin |
| `lib/exif.js` | `imageToWebp()`, `videoToWebp()`, `writeExif()` — konversi & metadata sticker |
| `lib/upload.js` | `upload()` — upload file ke CDN (support semua media type) |
| `lib/jadibot.js` | `createSession()`, `stopSession()`, `listSessions()` — multi-session manager |

### Mengirim Media

```js
// Video dari file path
await conn.message.send(m.chat, {
  type: 'video',          // image | video | audio | document | sticker
  media: './file.mp4',    // file path (preferred) atau Readable stream
  mimetype: 'video/mp4',
  caption: 'Deskripsi'
}, { quote: m })

// Sticker dari buffer
await conn.message.send(m.chat, {
  type: 'sticker',
  media: './sticker.webp',
  mimetype: 'image/webp'
})
```

### Upload File

```js
const { upload } = require('./lib/upload')

// Dari buffer
let result = await upload(buffer, 'photo.jpg', 'image/jpeg')
console.log(result.url) // https://svazer-upload.vercel.app/file/xxx.jpg

// Dari file path
let result = await upload('./photo.jpg')
console.log(result.url, result.size, result.mimetype)
```

### Download Media dari Pesan

```js
const { downloadMediaMessage } = require('zapo-js')

// Download dari pesan (stream → buffer)
let stream = await downloadMediaMessage(m.quoted?.message || m, { downloadNativeClock: false })
let buffer = Buffer.isBuffer(stream) ? stream : await streamToBuffer(stream)
```

## Testing

```bash
node test-exec.js   # test plugin exec (eval, return, shell, permission)
```

## Kredit

- [zapo-js](https://github.com/vinikjkkj/zapo) — WhatsApp Web protocol library
