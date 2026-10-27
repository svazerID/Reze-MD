# Plugin `tozapo` — konverter Baileys → zapo (design singkat)

Tanggal: 2026-10-27

## Niat

User sering butuh menerjemahkan snippet bot WhatsApp yang ditulis dengan
Baileys menjadi kode zapo. Melakukannya manual (ganti nama API, lalu
sesuaikan model event dan payload) rawan salah dan memakan waktu.

`tozapo` mengonversi **teks kode** dari Baileys ke zapo langsung di chat:
kirim snippet atau reply pesan berisi snippet, bot membalas kode hasil
konversi yang sudah di-highlight.

## Kenapa

- Reze-MD sudah sepenuhnya di zapo, sisa snippet Baileys dari internet /
  project lain masih sering muncul.
- Pola `plugins/toesm.js` (CJS↔ESM) sudah terbukti jalan: regex + AIRich
  + fallback teks. `tozapo` mengikuti pola yang sama supaya konsisten dan
  tidak menambah beban.

## Tujuan

- Command eksplisit `.tozapo` (bukan auto-detect), satu arah: Baileys → zapo.
- Menangani kode gaya **CJS dan ESM** sekaligus — Baileys sendiri bisa
  ditulis dua-duanya, dan user mengirim apa saja.
- Mengonversi pola yang **aman dipetakan** secara otomatis.
- Menandai pola yang **tidak bisa** dipetakan dengan `// TODO(zapo):` dan
  merangkumnya di akhir output, supaya hasil tidak terlihat "sudah jalan"
  padahal belum.
- Hasil dikirim lewat AIRich (`airich.code` + `highlightJS`), fallback ke
  teks berkode kalau AIRich tidak dirender.
- `module.exports._test` mengekspos fungsi murni untuk diuji.

## Non-tujuan

- **Bukan** konversi sempurna. Perbedaan model event dan payload tidak bisa
  diselesaikan oleh regex.
- Tidak mengonversi arah balik (zapo → Baileys). Bisa ditambah nanti sebagai
  `.tobaileys` dengan pola yang sama.
- Tidak menjalankan, mem-parse-semantik, atau memvalidasi hasil konversi.
  Bot hanya mengubah teks.
- Tidak menangani plugin Reze-MD itu sendiri (sudah zapo).

## Anti-tujuan

- Menghasilkan kode yang tampak benar tapi diam-diam rusak tanpa penanda.
  Lebih baik jujur "bagian ini belum didukung" daripada mengubah sebagian
  lalu sisanya dibiarkan lolos.
- Menambah dependency baru (parser AST) hanya untuk fitur chat.

## Batasan

- Bot berjalan di Termux; hindari dependency berat.
- `toesm.js` memakai `async` di helper AIRich; `tozapo` mengikuti.
- Input bisa datang sebagai `text` atau isi pesan yang di-reply
  (`extractText`).
- Prefix global bisa berubah; `stripLeadingCommand` harus mengenali nama
  command baru.
- Gaya project: CJS, tanpa semicolon di banyak tempat, komentar bahasa
  Indonesia, pesan error beremoji.

## Pendekatan yang dipertimbangkan

1. **Regex berlapis** — cepat, tapi tidak bisa mengubah isi callback dan
   rawan salah pada kode bersarang.
2. **Parser + AST** — paling akurat, tapi menambah dependency dan berat
   untuk fitur chat.
3. **Regex aman + verdict jujur** — regex hanya untuk penggantian yang
   pasti aman, pola yang tidak dikenal dideteksi dan dilaporkan.

**Dipilih: opsi 3.** Konsisten dengan `toesm.js`, tanpa dependency baru,
dan tetap memberi user gambaran bagian mana yang perlu dicek manual.

## Bagian yang diputuskan

- **Nama command:** `tozapo`, prefix mengikuti `global.prefix`. Alias tidak
  ditambahkan dulu supaya permukaan command tetap kecil.
- **Gaya kode input:** dideteksi per baris, tidak perlu user menyebut CJS
  atau ESM. Kedua gaya bisa muncul berdampingan dalam satu snippet.
- **Penanda:** `// TODO(zapo): <alasan>` ditulis di tempat pola tidak
  dikenali, dan ringkasannya dikumpulkan ke daftar peringatan di bawah
  blok kode.
- **Format balasan:** judul `# 🔄 Baileys → zapo`, blok kode ber-highlight,
  lalu daftar peringatan (kalau ada) sebagai teks biasa.
- **Fallback:** kalau `airich.send` gagal, kirim teks dengan fenced code
  block, sama seperti `toesm.js`.

## Peta konversi (inti)

Pemetaan pasti (aman diganti otomatis):

| Baileys | zapo |
| --- | --- |
| `makeWASocket(...)` | `new WaClient(...)` |
| `useMultiFileAuthState(...)` | penanda TODO — zapo pakai SQLite store |
| `sock.sendMessage(jid, { text: x })` | `client.message.send(jid, x)` |
| `sock.sendMessage(jid, { image: ... })` | `client.message.send(jid, { type: 'image', ... })` |
| `sock.sendMessage(jid, { video: ... })` | `client.message.send(jid, { type: 'video', ... })` |
| `sock.sendMessage(jid, { document: ... })` | `client.message.send(jid, { type: 'document', ... })` |
| `sock.sendMessage(jid, { audio: ... })` | `client.message.send(jid, { type: 'audio', ... })` |
| `sock.ev.on('messages.upsert', cb)` | `client.on('message', cb)` + TODO (payload beda) |
| `sock.ev.on('connection.update', cb)` | `client.on('connection', cb)` + TODO |
| `sock.ev.on('creds.update', cb)` | penanda TODO — dikelola store |
| `sock.sendPresenceUpdate(x, jid)` | `client.message.sendPresence?` → TODO, path belum pasti |
| `sock.groupMetadata(jid)` | TODO — perlu path zapo yang setara |
| `downloadMediaMessage(msg, ...)` | TODO — zapo pakai media processor |
| `m.key.remoteJid` | `m.chat` (dengan TODO; konteks event berbeda) |
| `getContentType(msg.message)` | tidak dikenal → TODO |

Setiap pemetaan yang ditandai TODO **tetap** menghasilkan komentar di
tempatnya; kode aslinya tidak dihapus supaya user masih bisa melihat
apa yang dimaksud.

## Yang diserahkan ke builder

- Susunan fungsi persis (mis. `convertBaileysToZapo`, `detectStyle`,
  `collectTodos`) dan batas antarnya.
- Detail regex: urutan penerapan penting — konversi `sendMessage` harus
  mendahului penggantian nama variabel `sock` → `client`.
- Cara mendeteksi CJS vs ESM tanpa mengacaukan snippet campuran.
- Format teks ringkasan peringatan.
- Pemilihan nama file plugin dan entri `module.exports._test`.

## Verifikasi yang diharapkan

- `node --check plugins/tozapo.js` lolos.
- Uji `_test` pada snippet contoh CJS dan ESM: pemetaan pasti terganti,
  pola tak dikenal menghasilkan TODO.
- Uji `stripFence` dan `stripLeadingCommand` dengan payload yang ikut
  tertempel (mis. `.tozapo .tozapo const ...`).
- Bot hot-reload plugin tanpa error.
