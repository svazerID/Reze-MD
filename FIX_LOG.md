# FIX LOG - drive: upload Google Drive selalu "fetch failed" (2026-10-27)

## Gejala
- `.drive` tidak pernah menghasilkan link Drive (log: `Upload Drive gagal: fetch failed`), padahal uji `lib/drive.js` di proses baru selalu sukses.
- CDN cadangan menolak file besar (`Upload CDN gagal: Unexpected token 'R', "Request En"...` = HTTP 413), jadi file >~4,5 MB terkirim tanpa link.
- Uji upload dari *dalam* proses bot menunjukkan cause asli: `UND_ERR_INVALID_ARG: invalid content-length header` pada setiap PUT chunk.

## Akar masalah
- Beberapa lib (`lib/translate.js`, `lib/vidsaveFetch.js`, `lib/proxyPool.js`) `require('undici')`. Saat modul itu di-load, undici 8.12.3 menjalankan `install()` dan **mengganti `globalThis.fetch`** (`node_modules/undici/index.js:224`).
- `putChunk` mengirim header `Content-Length` manual. fetch undici 8 menolak header itu (`UND_ERR_INVALID_ARG`) walaupun nilainya benar; proses baru tanpa undici memakai fetch bawaan Node yang permisif, makanya uji terpisah lolos.

## Perubahan
- `lib/drive.js`:
  - Hapus `Content-Length` manual di PUT chunk — fetch menghitung sendiri dari Buffer body. `Content-Range` tetap.
  - `errInfo(e)` menampilkan `e.cause` (code + message) dan `isTransient()` membaca cause; sebelumnya log cuma "fetch failed".
  - `request()` baru: token refresh & init sesi resumable retry (4 percobaan, delay 2/4/8 dtk).
  - `putChunk()` retry 6× (sebelumnya 5×).

## Jebakan
- Jangan set `Content-Length` di fetch mana pun selama package `undici` bisa ter-load; header itu ditolak fetch undici 8.
- `lib/` tidak ikut hot-reload `fs.watch` (hanya `plugins/`), jadi perubahan ini butuh `pm2 restart Reze-MD`.
- Balasan "🚫 Silakan masukkan URL Google Drive yang ingin diambil." yang muncul di log grup berasal dari **bot lain** (pengirim ~Svazer), bukan plugin ini.
- CDN `svazer-upload.vercel.app` dibatasi body Vercel (~4,5 MB); untuk file besar Drive satu-satunya jalur link.
- `drive-request` = percobaan token/init, `drive-upload` = percobaan PUT chunk; angka `i/tries` adalah nomor percobaan.

## Verifikasi
- `node --check lib/drive.js` lolos.
- Reproduksi: proses baru dengan `require('undici')` + upload → `invalid content-length header`; setelah perbaikan → sukses 4,8 dtk.
- Uji dari dalam proses bot (plugin sementara yang jalan saat load) → `OK https://drive.google.com/...` 3,5 dtk; plugin uji dihapus setelahnya.

---

# FIX LOG - toesm/tocjs: convert CJS ↔ ESM dengan balasan AIRich (2026-10-26)

## Gejala / permintaan
- Diminta fitur konversi kode CJS ↔ ESM. Contoh yang dikirim memakai class `AIRich` (gaya Baileys) yang tidak ada di repo ini, dan balasannya harus lewat AIRich.

## Perubahan
- `plugins/toesm.js` (baru, format objek): perintah `.toesm`/`.tocjs`.
  - Input dari teks setelah command atau reply; fence markdown (```) dibuang otomatis.
  - Konversi mengikuti regex contoh: destructuring & simple `require`, `module.exports` → `export default`, `exports.nama` → `export const`; arah sebaliknya untuk `import` named/default/namespace, `export default`, `export const`.
  - Balasan lewat `lib/airich.js`: `airich.text('# 🔄 label')` + `airich.code(highlightJS(hasil), 'javascript')`, quote ke pesan.
  - `stripLeadingCommand()` membuang prefix + nama command yang ikut tertempel di payload (mis. input `.tocjs .tocjs import ...`), maksimal 3 pengulangan, sebelum `stripFence`.
  - `highlightJS()` memecah kode jadi blok bertipe (`COMMENT`/`STRING`/`NUMBER`/`KEYWORD`/`METHOD`/`DEFAULT`) supaya blok dirender sebagai kode JavaScript ber-highlight, bukan teks polos. Roundtrip teks dijamin utuh.
  - `lib/airich.js` sekarang otomatis menyusun `unifiedResponse` dari submessage text/code (`GenAIMarkdownTextUXPrimitive` + `GenAICodeUXPrimitive`) dan plugin mengirim `contextInfo` forwarded seperti contoh. Tanpa keduanya, pesan AIRich tidak muncul di WhatsApp ("gamuncul").
  - Fallback teks berkode kalau pengiriman AIRich gagal.
  - `_test` mengekspor fungsi konversi untuk verifikasi manual.

## Jebakan
- **Tidak ada class `AIRich` di repo ini.** Padanannya builder `lib/airich.js` (`text`, `code`, `send`).
- **`richResponseMessage` tanpa `unifiedResponse` (dan `contextInfo` forwarded) bisa di-drop client** — gejalanya command sukses tanpa error tapi tidak ada pesan masuk. `build()` sekarang mengisi `unifiedResponse` untuk text/code; tipe lain mengembalikan `null` dan mengandalkan submessage.
- Repo ini CommonJS + loader format objek — jangan pakai `export default handler` seperti contoh bot asal.
- `m.quoted` tidak punya `.text`; pakai `extractText` dari `lib/simple.js` (sudah menangani conversation/extended/caption/button).
- Tidak ada sistem `limit` seperti bot asal, jadi `handler.limit` tidak dipakai.
- Regex `module.exports`/`exports.*` hanya menangani satu baris; `module.exports = { ... }` multi-baris tidak dikonversi sempurna (mengikuti contoh).
- Input lewat teks kehilangan indentasi karena handler menggabung argumen; reply blok kode lebih aman untuk kode panjang.
- AIRich tidak selalu dirender semua client — fallback teks wajib ada.
- **Prefix + command bisa ikut jadi isi `text` plugin.** Kalau pesan dikirim dobel (mis. `.tocjs .tocjs import ...`), `args`/`text` memuat sisa `.tocjs`; tanpa `stripLeadingCommand` sisa itu masuk ke kode hasil.
- **`codeLanguage: 'javascript'` saja tidak cukup** — client merender blok sebagai teks polos kalau `codeBlocks` tidak diberi `highlightType`. Harus dipecah per token; `unifiedResponse` memetakan tipe ke `KEYWORD`/`DEFAULT`/`STR` (bukan `STRING`).

## Verifikasi
- `node --check plugins/toesm.js` → lolos.
- CJS → ESM: `const { exec } = require('child_process')`, `const fs = require('fs')`, `module.exports = handler`, `exports.foo = 1` → `import { exec } …`, `import fs …`, `export default …`, `export const foo …`.
- ESM → CJS: named/default/namespace import, `export default`, `export const` → `require`/`module.exports`/`exports.foo`.
- Simulasi `run` dari reply dan teks → payload AIRich terkirim, decode 2 submessage tipe `2,5` dengan title `# 🔄 CJS → ESM` / `# 🔄 ESM → CJS` dan kode hasil konversi.
- Decode payload: `contextInfo.isForwarded` true (`forwardOrigin` 4) dan `unifiedResponse` berisi 2 section — `GenAIMarkdownTextUXPrimitive` (judul) + `GenAICodeUXPrimitive` (`language: javascript`, blok kode hasil).
- `stripLeadingCommand(".tocjs .tocjs import axios from 'axios';")` → `import axios from 'axios';`; lalu jadi `const axios = require('axios');`.
- `highlightJS` roundtrip teks utuh, 8 blok bertipe `KEYWORD/DEFAULT/STRING`; submessage `codeLanguage: javascript` dengan 14 blok, `unifiedResponse` `KEYWORD,DEFAULT,STR`.

---

# FIX LOG - airich: helper + plugin demo richResponseMessage (2026-10-26)

## Gejala / permintaan
- Ternyata zapo-js mendukung `richResponseMessage` (AIRich). Contoh `BotForwardedMessage.js` menunjukkan kirim raw proto `conn.message.send(m.chat, { botForwardedMessage: { message: { richResponseMessage: { submessages } } } }, {})`.
- Diminta dibuatkan helper + plugin demo supaya tidak menulis proto panjang manual.

## Perubahan
- `lib/airich.js` (baru): builder untuk **semua** submessage AIRich — `text()`, `code()` (string atau blok ber-highlight), `table()`, `image()` (alignment/tapLink), `gridImage()`, `dynamic()` (image/gif), `map()` (annotations), `latex()` + `latexExpression()`, `contentItems()` (reel/carousel). Plus `build()` dan `send(conn, chat, submessages, { quote, unifiedResponse, contextInfo })`.
  - `unifiedResponse` menerima Buffer/Uint8Array atau object (di-JSON → Buffer).
  - Konstanta: `T` (tipe submessage) dan `CODE` (highlightType).
- `plugins/airich.js` (baru, owner-only, format objek): `.airich`/`.rich` mengirim payload **persis** dari `BotForwardedMessage.js` — bukan demo tiruan.
  - `loadDemo()` membaca `data/BotForwardedMessage.js`, mengambil literal objek setelah `m.chat,`, lalu mengevaluasinya via `vm.runInNewContext` dengan sandbox `{ Buffer }` + timeout 2 dtk. `conn.message.send` di luar literal tidak ikut dieksekusi.
  - Payload di-cache setelah load pertama; dikirim dengan opsi `{}` seperti contoh (tanpa quote).
  - Kalau file hilang/struktur berubah, command balas error, bukan mengirim demo lain.
  - Semua gambar contoh (`cdn.ornzora.eu.cc`) diganti `DEFAULT_IMAGE` → `https://svazer-upload.vercel.app/file/96943042.jpg`, termasuk URL yang tertanam di `messageText` dan di dalam JSON `unifiedResponse`. `.airich <url>` memakai URL gambar lain.
- `lib/airich.js` tetap disimpan sebagai builder untuk komposisi manual (tidak dipakai plugin demo).
- Tidak menyentuh `plugins/ai.js`.

## Jebakan
- **`data/BotForwardedMessage.js` adalah sumber konten demo** (603 KB, masuk `.gitignore` lewat `data/`). File ini tidak ikut repo — kalau hilang di deploy, `.airich` gagal. Salin manual ke `data/`.
- Jangan pakai `new Function`/eval seluruh file: `conn.message.send` dan kode lain ikut jalan. Yang dievaluasi hanya literal objek payload, di sandbox tanpa `require`/`process`.
- Ganti URL gambar dengan regex URL utuh, **bukan** replace prefix host — replace prefix akan menempelkan path lama di belakang URL baru.
- Gambar juga ada di dalam `unifiedResponse.data` (JSON di Buffer), bukan cuma di `submessages`; kalau hanya submessage yang diganti, kartu/pill masih memakai gambar lama.
- Bentuk wrapper harus `botForwardedMessage.message.richResponseMessage`; zapo membuka wrapper itu saat resolve tipe pesan (`dist/message/encode/content.js`), jadi pesan dikirim sebagai TEXT.
- `proto.Message.encode(raw)` mengembalikan writer — pakai `.finish()` untuk bytes.
- `contextInfo` di contoh ada **di dalam** `richResponseMessage`, bukan di wrapper.
- `unifiedResponse.data` bertipe bytes (JSON GenAI view-model ±457 KB). Inilah yang membuat tampilan contoh punya pill/produk/search/imagine/reels; kalau dihapus, tampilannya berubah.
- Enum penting: submessage `1..9` = grid image, text, inline image, table, code, dynamic, map, latex, content items; `dynamic.type` 1=image, 2=gif; `contentType` 1=carousel.
- Raw proto = jalur "advanced" seperti `crm`: plugin dibuat owner-only.
- **Hot reload hanya menghapus cache file plugin**, bukan `lib/`. Setelah mengubah `lib/airich.js`, plugin yang sudah ter-load masih memakai versi lama — wajib restart bot.

## Verifikasi
- `node --check lib/airich.js` dan `node --check plugins/airich.js` → lolos.
- Payload dari plugin di-encode ulang: 459347 byte, **16 submessage** dengan urutan tipe `2,2,2,2,2,2,2,2,5,4,2,1,2,2,9,2`, `unifiedResponse.data` 456882 byte, `contextInfo` forwarded score 1 origin 4 — identik dengan `BotForwardedMessage.js`.
- Setelah penggantian gambar: 0 sisa `cdn.ornzora.eu.cc` (di submessages maupun JSON unified), 14 URL gambar baru di submessages dan 37 di unifiedResponse; grid image, thumbnail/ikon reel, dan URL LaTeX di `messageText` terkonfirmasi memakai URL baru. Link non-gambar (google, openai, wa.me, github, fiora) tetap.
- JSON `unifiedResponse` tetap valid setelah replace (17 section, `response_id` utuh).

---

# FIX LOG - upload CDN pindah ke svazer-upload.vercel.app (2026-10-26)

## Gejala / root cause
- `.hd` gagal dengan `Upload gagal: {"status":false,"message":"Failed to upload to CDN","error":"Request failed with status code 500"}`.
- Reproduksi pakai `curl` dengan JPEG valid: `alsya.svazer.eu.cc/api/tools/upload` balas **500** ("Failed to upload to CDN"), dan `cdn-alsya.vercel.app/api/upload` juga **500** ("An error occurred during upload"). Jadi rusak di storage/CDN upstream, bukan di URL atau file kiriman.
- `svazer-upload.vercel.app/api/upload` sehat: balas `{ success, url, blobUrl, filename, size, mimetype }`.

## Perubahan
- `lib/upload.js`: endpoint → `https://svazer-upload.vercel.app/api/upload`; validasi `data.success` + `data.url`; `url` diambil dari `data.url` (bukan `data.urls.direct`).
- `plugins/hd.js`: `output_url` dari imglarger sekarang berupa **data: URI**, bukan URL biasa. Ekstensi & mimetype hasil ikut ditentukan dari `content-type`/prefix data URI (output nyata JPEG, sebelumnya dipaksa `.png`/`image/png`).
- `README.md`: contoh URL upload disesuaikan.

## Jebakan
- Bentuk respons endpoint baru beda: `success`/`url` di root, bukan `status`/`urls.direct`. Jangan pakai cek lama.
- `fetch()` Node menerima `data:` URI, jadi `fetch(hdData.data.output_url)` tetap jalan tanpa perubahan lain.
- imglarger mengembalikan JPEG walau `type=enlarger`; jangan hardcode PNG.
- `lib/drive.js` punya `upload()` sendiri (Google Drive) — tidak terkait dan tidak diubah.

## Verifikasi
- `node --check lib/upload.js` dan `node --check plugins/hd.js` → lolos.
- `upload('./input.jpg')` → `{status:true,url:"https://svazer-upload.vercel.app/file/…jpg",size:36662,mimetype:"image/jpeg"}`.
- Alur HD penuh: imglarger `200 status:true`, `output_url` data URI JPEG, download hasil 297295 byte dengan magic `ffd8ff`.

---

# FIX LOG - crm: relay ulang pesan reply + ekspor kode raw zapo (2026-10-25)

## Gejala / permintaan
- Ada plugin `crm.js` dari bot Baileys: reply pesan lalu relay ulang persis tipenya, sekaligus kirim file `.js` berisi cuplikan `conn.relayMessage(...)`. Diminta disempurnakan dan dipasang di Reze-MD.

## Perubahan
- `plugins/crm.js` (baru, format objek, owner-only): `.crm` pada pesan yang di-reply.
  - Membuka wrapper `ephemeralMessage`/`viewOnceMessage`/`viewOnceMessageV2`/`viewOnceMessageV2Extension`/`documentWithCaptionMessage`, membuang properti internal (`_`-prefixed) dan fungsi, lalu relay via `conn.message.send(m.chat, rawProto)`.
  - Mengirim dokumen `<TipePesan>.js` berisi `=> conn.message.send(…)` yang bisa langsung ditempel ke `exec` (`=>` didukung plugin exec).
- Generator kode: indentasi 4 spasi, `Buffer`/`Uint8Array` → `Buffer.from("…", "base64")`, `bigint` → `5n`, guard circular & kedalaman, key non-identifier di-quote.
- Nama file dari field pesan pertama; `messageContextInfo`/`senderKeyDistributionMessage` diabaikan.
- Relay gagal tidak membatalkan pengiriman file — error dicatat di caption.
- Tidak ada file temp/folder `debug/`: dokumen dikirim langsung dari `Buffer`.

## Jebakan
- **zapo tidak punya `relayMessage`/`generateWAMessageFromContent`.** `client.message.send` menerima raw `Proto.IMessage` apa adanya; konten tanpa field `type` dianggap raw (lihat `dist/client/messaging/messages.js`).
- **`conversation` tidak perlu diubah ke `extendedTextMessage`** seperti versi Baileys — zapo mendukung raw conversation.
- Field berawalan `_` adalah dekorasi internal zapo (mis. `_stats`) dan dibuang di semua level; jangan ikut di-relay.
- Wrapper view-once/ephemeral **dibuka** (mengikuti perilaku plugin asal), jadi relay mengirim konten dalamnya, bukan wrapper-nya.
- Relay bisa ditolak server untuk tipe pesan lama/invalid; file kode tetap dikirim supaya bisa dianalisis.
- Raw send melewati validasi typed builder — plugin ini owner-only dan tidak boleh dibuka untuk publik.
- Fallback sumber quote: `m.quoted.message` → `m.quotedCtx.quotedMessage`.

## Verifikasi
- `node --check plugins/crm.js` → lolos.
- 15 uji dengan `conn` tiruan: teks asli, wrapper ephemeral, nama file, bytes base64, metadata diabaikan, `_stats`/fungsi dibuang, bigint, circular, tanpa reply, relay gagal (dokumen tetap terkirim + warning), fallback `quotedCtx` → **15 pass, 0 fail**.
- Contoh output file:
  ```
  => conn.message.send(
    m.chat,
    {
      conversation: "halo dunia"
    },
    {}
  )
  ```
- Hot reload: `➕ Plugin baru 'crm.js'` tanpa error.

---

# FIX LOG - adminonly jadi per grup, bisa diatur admin grup (2026-10-25)

## Gejala / permintaan
- `adminonly` sebelumnya saklar global per sesi bot: sekali ON, seluruh grup kena. Yang diminta: pembatasan admin berlaku **per grup** dan bisa diatur oleh admin grup itu sendiri, bukan hanya owner bot.

## Perubahan
- `handler.js`:
  - hapus default & gerbang global `setting.adminOnly`.
  - metadata grup di-query juga saat `chats[m.chat].adminOnly` menyala (syarat agar admin terdeteksi).
  - gerbang baru: `if (m.isGroup && global.db.data.chats[m.chat]?.adminOnly && !isOwner && !isAdmin) return`
- `plugins/adminonly.js`: setting pindah ke `global.db.data.chats[<groupJid>].adminOnly` (default off). Permission plugin menjadi `groupOnly`; hak ubah dicek manual dari metadata — **admin grup atau owner**, bukan owner-only.

## Jebakan
- **Key lama `settings[meJid].adminOnly` tidak dibaca lagi.** Sisa key (nilai `false` di database) aman dibiarkan; kalau dulu pernah ON, grup yang ingin dikunci harus di-`on`-kan ulang satu per satu.
- `adminOnly` hanya menyentuh grup. Chat pribadi tetap diatur `groupOnly`; jangan menambahkan cek admin untuk private karena tidak ada admin di sana.
- Setelah ON, **hanya admin grup/owner yang bisa mematikannya** — perintah member biasa di-`return` diam oleh gerbang sebelum `plugin.run`.
- Metadata wajib diambil saat mode aktif; kalau tidak, `isAdmin` selalu `false` dan admin ikut terblokir.
- Deteksi admin memakai `phoneOf` (resolve LID via `lidCache`) untuk `phoneNumber`/`jid`/`lid`, sama seperti `warn`/`antilink`.

## Verifikasi
- `node --check handler.js plugins/adminonly.js` → lolos.
- Uji `plugin.run` dengan metadata tiruan: member ditolak, admin menyalakan grupnya sendiri, status menampilkan ON, owner non-admin bisa mematikan, grup lain tidak terpengaruh → **5 pass, 0 fail**.
- `pm2 restart Reze-MD`: `adminonly.js` termuat dan `🟢 Terhubung ke WhatsApp!`.

---

# FIX LOG - antilink grup lain: hapus pesan + warn otomatis (2026-10-25)

## Gejala / permintaan
- Link undangan grup WhatsApp lain bebas dikirim di grup. Butuh saklar on/off per grup: pesan berisi link grup lain dihapus otomatis lalu pengirimnya diberi warn.

## Perubahan
- `plugins/antilink.js` (baru, format objek):
  - `all` hook: mendeteksi `groupInviteMessage` ke grup lain dan teks `chat.whatsapp.com/<code>` (termasuk `/invite/`, http/https/www). Link ke grup **ini sendiri** dilewatkan.
  - Pesan pelanggar di-revoke (`{ type: 'revoke', target }`), lalu warn bertambah di store `warn.js` yang sama (5× warn = auto kick), plus balasan `⚠️ Antilink … Warn: n/5`.
  - `run`: `.antilink on|off` / `.antilinkgc`, khusus admin grup atau owner (dicek manual dari metadata, bukan flag `permissions.adminOnly`, supaya owner tidak wajib jadi admin). Tanpa argumen menampilkan status.
- Setting per grup di `global.db.data.chats[<groupJid>].antilink` (default off, sama seperti `autoGc`).

## Jebakan
- **Kode undangan grup sendiri hanya bisa di-query admin** (`queryInviteCode` → 403 kalau bot bukan admin). Kalau gagal, deteksi teks link **fail-open** (tidak menghapus apa pun) supaya link grup sendiri tidak ikut terhapus; kode di-cache 10 menit (gagal: 60 detik).
- `groupInviteMessage` dibandingkan lewat `groupJid`, bukan kode — tidak butuh query dan tetap akurat walau link lama/rotasi. Payload tanpa `groupJid` fallback ke perbandingan `inviteCode`.
- Revoke butuh bot admin; kalau gagal, warn **tidak** diberikan (log sekali per grup). `.antilink on` tetap mengingatkan kalau bot bukan admin.
- Admin grup dan owner bot dikecualikan: tidak dihapus, tidak di-warn (warn.js juga menolak me-warn admin/owner dan admin tidak bisa di-kick).
- `target.participant` diambil dari `m.key.participant` (bisa LID) — jangan diganti `m.sender` hasil resolusi, karena revoke mencocokkan key asli pesan.
- Hook `all` berjalan **sebelum** gerbang `self`/`groupOnly`/`adminOnly` dan sebelum `if (!m.text) return`, jadi moderasi tetap jalan untuk pesan media dan saat mode pembatasan lain aktif.
- **`all` hook tidak menerima `conn` di parameter kedua** — handler memanggil `hook.all.call(conn, m, { chatUpdate, dirname, __filename })`. Pakai `function (m) { return enforce(m, this) }`, bukan `(m, { conn })`.
- Sender yang LID-nya tidak ter-resolve (`m.sender` null) dilewati — tidak bisa revoke/warn dengan aman.
- Balasan warn dikirim tanpa `quote` karena pesan sumbernya sudah dihapus.

## Verifikasi
- `node --check plugins/antilink.js` → lolos.
- Uji logika dengan `conn` tiruan (9 kasus): link grup lain dihapus + warn 1; link grup sendiri aman; invite terstruktur grup lain dihapus; invite grup sendiri aman; pengirim admin dilewati; warn ke-5 memicu kick; `antilink off` tanpa aksi → **9 pass, 0 fail**.
- Hot reload: log `➕ Plugin baru 'antilink.js'` tanpa error.

---

# FIX LOG - mode admin saja: on/off lewat `.adminonly` (2026-10-25)

## Gejala / permintaan
- Butuh saklar on/off agar bot hanya bisa dipakai admin grup dan owner. Member biasa (termasuk di private) tidak dilayani.

## Perubahan
- `handler.js`: default `setting.adminOnly = false`; metadata grup sekarang juga diambil saat `setting.adminOnly` menyala (tanpa itu admin tidak terdeteksi dan semua orang terblokir); gerbang setelah `isAdmin` dihitung:
  ```js
  if (setting.adminOnly && !isOwner && !isAdmin) return
  ```
  Non-admin/non-owner diabaikan **tanpa balasan**; di private hanya owner yang lolos.
- `plugins/adminonly.js` (baru, format objek): `.adminonly on` / `.adminonly off`, alias `.admonly`, owner-only; tanpa argumen menampilkan status.

## Jebakan
- **Metadata grup wajib diambil saat mode ini aktif.** Sebelumnya metadata hanya di-query untuk plugin `admin`/`botAdmin`/`participants` atau saat LID cache grup masih kosong; kalau cache sudah terisi, `isAdmin` akan selalu `false` dan admin ikut terblokir. Kondisi query sudah ditambah `setting.adminOnly`.
- Gerbang memakai `isAdmin` dari metadata yang dihitung dengan `phoneNumber`/`jid`/`lid` — admin yang tampil sebagai LID tetap dikenali.
- Gerbang diletakkan **sebelum** cek `plugin.owner`, jadi non-admin yang mencoba perintah owner mendapat diam, bukan pesan "khusus owner".
- Owner tetap lolos di mana pun (grup maupun private), sama seperti `groupOnly`.
- Kedua mode bisa aktif bersamaan: `groupOnly` memblokir private non-owner, `adminOnly` memblokir member non-admin di grup.

## Verifikasi
- `node --check handler.js plugins/adminonly.js` → lolos.
- `pm2 restart Reze-MD`: `adminonly.js` muncul di daftar plugin dan `🟢 Terhubung ke WhatsApp!` tanpa error.
- Uji manual: `.adminonly on` → member biasa tidak dibalas (grup & private), admin grup dan owner tetap dilayani; `.adminonly off` → semua normal.

---

# FIX LOG - anticall: on/off tolak panggilan otomatis (2026-10-25)

## Gejala / permintaan
- Bot tidak punya cara menolak panggilan masuk. Butuh saklar on/off agar panggilan (voice/video) otomatis ditolak saat mode aktif.

## Perubahan
- `package.json`: tambah `@zapo-js/voip` (1.4.0).
- `main.js`: `voipPlugin()` didaftarkan ke `WaClientOptions.plugins`; listener `voip_call_incoming` menolak via `conn.voip.rejectCall(call.callId)` bila `settings[meJid].anticall` menyala, lalu log `📞 Panggilan ditolak (anticall)`.
- `handler.js`: default `setting.anticall = false`.
- `plugins/anticall.js` (baru, format objek): `.anticall on` / `.anticall off`, alias `.acall`, owner-only; tanpa argumen menampilkan status. Menyimpan setting lalu `global.db.write()`.

## Jebakan
- **Event `call` bawaan zapo hanya read-only** — tidak ada API answer/reject tanpa plugin VoIP. Karena itu `voipPlugin()` wajib didaftarkan; tanpa itu `conn.voip` dan `voip_call_incoming` tidak ada.
- **Peer media `@roamhq/wrtc` & `libmlow-wasm-fork` tidak perlu dipasang** untuk sekadar menolak: keduanya dimuat lazy saat panggilan benar-benar di-*accept*/media lokal dipakai. Smoke test: `conn.voip.rejectCall` bertipe function tanpa dua paket itu.
- `rejectCall` default memakai alasan `Declined`. Untuk group call, method yang sama menolak undangan, bukan mengakhiri panggilan orang lain.
- Listener dipasang sekali saat modul dimuat (instance `conn` tidak berganti saat reconnect, sama seperti listener grup).
- Jadibot belum tercakup: `lib/jadibot.js` membuat `WaClient` sendiri tanpa `voipPlugin()`, jadi panggilan ke sesi jadibot tetap berdering.
- Setting default di `handler.js` hanya terinisialisasi setelah ada pesan masuk perintah; sebelum itu `settings[meJid]` mungkin belum ada — listener memakai optional chaining sehingga aman (dianggap OFF).

## Verifikasi
- `node --check main.js handler.js plugins/anticall.js` → lolos.
- Smoke test instansiasi `WaClient` + `voipPlugin()` di store /tmp: `voip coordinator: true rejectCall: function`.
- `pm2 restart Reze-MD`: log `anticall.js` di daftar plugin dan `🟢 Terhubung ke WhatsApp!` tanpa error.
- Uji manual: `.anticall on` lalu panggil bot dari nomor lain → panggilan langsung ditolak dan log anticall muncul; `.anticall off` → panggilan berdering normal.

---

# FIX LOG - mode grup saja: on/off lewat `.grouponly`, owner tetap bebas di private (2026-10-25)

## Gejala / permintaan
- Bot bisa dipakai siapa saja di chat pribadi. Butuh saklar on/off agar bot hanya melayani grup, dengan pengecualian owner yang tetap bisa memakai bot di chat pribadi.

## Perubahan
- `plugins/grouponly.js` (baru, format objek): `.grouponly on` / `.grouponly off`, alias `.gconly`, owner-only. Tanpa argumen menampilkan status. Menyimpan `setting.groupOnly` lalu `global.db.write()`.
- `handler.js`: inisialisasi default `setting.groupOnly = false`; gerbang setelah plugin cocok:
  ```js
  if (setting.groupOnly && !m.isGroup && !isOwner) return
  ```
  Non-owner di chat pribadi **diabaikan tanpa balasan apa pun** (bukan pesan penolakan), owner tetap bebas.
- State disimpan per sesi bot (`settings[meJid]`), sama seperti `self.js`.

## Jebakan
- **`handler.js` tidak ikut hot-reload.** `fs.watch` hanya memantau folder `plugins/`; perubahan handler butuh `pm2 restart`.
- Gerbang ditaruh **setelah** plugin cocok (`if (!plugin) return`), supaya bot tidak membalas obrolan biasa di private.
- `isOwner` sudah memperhitungkan LID → nomor via `lidCache`, jadi owner ber-LID tetap dikenali.
- Cek `plugin.owner` tetap berjalan setelah gerbang; non-owner di private hanya di-`return` diam-diam, tidak dapat pesan "khusus owner" maupun "grup saja".
- `liststore` auto-reply tidak terpengaruh karena hanya berjalan di grup.

## Verifikasi
- `node --check handler.js plugins/grouponly.js` → lolos.
- `pm2 restart Reze-MD`: log memuat `grouponly.js` dan `🟢 Terhubung ke WhatsApp!` tanpa error.
- Uji manual di WhatsApp: `.gconly on` → non-owner private tidak dibalas sama sekali, owner private & grup tetap jalan; `.gconly off` → private kembali normal.

---

# FIX LOG - video: semua jalur kirim pakai media-utils, kode manual dihapus (2026-10-25)

## Gejala / permintaan
- Setelah `postch` dipindah ke media-utils, masih ada kode pemrosesan video manual di `lib/mediaProcessor.js` (`generateVideoThumbnail`, `runThumb`, `probeMedia`, helper file temp) yang tidak dipakai lagi karena `WaClient` sudah memakai `createMediaProcessor()`.

## Perubahan
- `lib/mediaProcessor.js`: `generateVideoThumbnail`, `runThumb`, `probeMedia`, `writeTempInput`, `cleanupTemp`, dan require `fluent-ffmpeg` dihapus. Sisa export: `generateImageThumbnail`, `readInput`, `downloadMedia`, `acquireFfmpegSlot` (antrean ffmpeg masih dipakai sticker & pinterest).
- Inventaris jalur video: `sticker.js` (sticker→video), `tiktok.js`, `instagram.js`, `pinterest.js` (m3u8 remux), `hidetag.js` (video + mentions), `send.js` (re-send video/document), `postch.js` (channel) — semuanya lewat `conn.message.send`/`newsletter.send`. Hanya jalur newsletter yang butuh thumbnail eksplisit; yang lain ditangani processor otomatis.
- `pinterest.js` tetap meremux HLS `.m3u8` sendiri — itu pengambilan media, bukan pemrosesan thumbnail, jadi tidak diganti.

## Jebakan
- **`fluent-ffmpeg` tetap dipakai** oleh `lib/exif.js` dan `plugins/pinterest.js`; jangan hapus dependensinya hanya karena mediaProcessor tidak lagi memakainya.
- **Jangan hapus `acquireFfmpegSlot`.** Sticker (`webpAnimToMp4`) dan Pinterest (remux m3u8) masih memakainya untuk membatasi ffmpeg di container `cpu.max=2`.
- `generateImageThumbnail` masih ada walau `WaClient` tidak memakainya (media-utils yang dipakai); dibiarkan karena bukan bagian video.

## Verifikasi
- `grep` tidak menemukan pemakai `generateVideoThumbnail`/`probeMedia` selain `global.mediaProcessor` milik media-utils.
- `node --check lib/mediaProcessor.js plugins/postch.js` → lolos.
- Export library: `generateImageThumbnail, readInput, downloadMedia, acquireFfmpegSlot`.
- Bot live tetap jalan; perubahan lib hanya menghapus fungsi mati, jalur yang dipakai plugin tidak berubah.

---

# FIX LOG - postch: thumbnail video lewat media-utils (2026-10-25)

## Gejala / permintaan
- `postch` masih membuat thumbnail video sendiri: spawn ffmpeg (`extractFrame`) lalu resize dengan `sharp`. Kode duplikat dari processor media dan tidak ikut peningkatan yang ada di `@zapo-js/media-utils`.

## Perubahan
- `plugins/postch.js`: `extractFrame()` dan `buildVideoThumbnail()` dihapus. Thumbnail video sekarang dari `global.mediaProcessor.generateVideoThumbnail(media, 320)`; kalau null, fallback ke `jpegThumbnail` milik video yang di-reply.
- `ffmpegToBuffer()` tetap ada karena dipakai konversi voice note ke opus.

## Jebakan
- **Jalur `newsletter.send` tidak memproses thumbnail sendiri.** Berbeda dengan `message.send`, builder newsletter hanya menyalin `jpegThumbnail` yang diberikan; kalau dihapus total, video di channel kehilangan preview. Karena itu thumbnail tetap dikirim eksplisit, hanya sumbernya diganti media-utils.
- `generateVideoThumbnail` menerima `Uint8Array`, jadi `Buffer` dari download aman; hasilnya `{ jpegThumbnail, width, height }` dengan jpegThumbnail berupa `Uint8Array` — konversi ke `Buffer` sebelum dimasukkan ke content.

## Verifikasi
- `node --check plugins/postch.js` → lolos.
- Processor diuji langsung: buffer mp4 640×360 → JPEG 5.062 byte (320×180).
- Bot live: `♻️ Reload plugin 'postch.js'` tanpa error.
- Belum diuji posting video nyata ke channel (butuh interaksi WhatsApp).

---

# FIX LOG - media: pakai @zapo-js/media-utils (2026-10-25)

## Gejala / permintaan
- Processor media masih buatan sendiri (`lib/mediaProcessor.js`) dan hanya mengisi 3 method: image thumbnail, video thumbnail, probe. Tidak ada `detectMimetype`, sticker thumbnail, maupun waveform, sehingga media tanpa `mimetype` eksplisit bisa gagal terkirim dan preview sticker tidak ada.

## Perubahan
- Dependensi baru: `@zapo-js/media-utils` (+ `file-type` untuk deteksi mimetype otomatis).
- `main.js`: `media.processor` sekarang `createMediaProcessor()` dari media-utils, disimpan sebagai `global.mediaProcessor`.
- `lib/jadibot.js`: tiap `WaClient` jadibot memakai `global.mediaProcessor` yang sama (processor stateless, aman dibagi; docs: guides/multi-session).
- `lib/mediaProcessor.js` **tetap ada** karena plugin masih memakai `downloadMedia()` dan `acquireFfmpegSlot()`.

## Jebakan
- **Batas ffmpeg paralel hilang.** `lib/mediaProcessor.js` membatasi 2 ffmpeg bersamaan karena container `cpu.max=2`; media-utils spawn ffmpeg sendiri tanpa batas itu. Kalau muncul stalling saat banyak video/probe bersamaan, itu penyebabnya — perlu wrapper antrean di sekitar `generateVideoThumbnail`/`probeMedia`.
- **Frame thumbnail video bisa hitam.** Kode lama sengaja seek ke detik ke-1 (bukan frame 0); media-utils memakai frame awal. Kalau thumbnail video hitam muncul lagi, jangan "fix" dengan mengganti processor — periksa perilaku ini dulu.
- **`normalizeVoiceNote` opt-in** (`=== true`) dan me-re-encode PTT. Jangan dinyalakan tanpa perlu; audio biasa (`ptt: false`) tidak butuh.
- `file-type` adalah peer dependency opsional, tapi tanpa itu `detectMimetype` tidak jalan dan `mimetype` harus eksplisit di setiap send.

## Verifikasi
- Metode processor diuji langsung dengan file nyata: `detectMimetype(mp4)` → `video/mp4`; image thumb JPEG 33 KB (736×736); video thumb JPEG 9.9 KB (640×360); probe video `{duration:3, width:640, height:360}`; probe opus `{duration:3.0065}`; waveform 64 byte + durasi 3 dtk; sticker thumb PNG 542 KB; `normalizeVoiceNote` mengembalikan stream.
- `node --check main.js lib/jadibot.js` → lolos.
- Bot live (`pm2` app `Reze-MD`): restart bersih, 41 plugin dimuat, `🟢 Terhubung ke WhatsApp!`, tanpa error.
- Belum diuji kirim media dari trafik WhatsApp nyata; perlu tes `!sticker` / `!hd` / kirim gambar langsung.

---

# FIX LOG - hd: suffix acak nama file sementara (2026-10-25)

## Gejala / permintaan
- Nama file sementara `hd_<timestamp>.jpg` dan `hd_out_<timestamp>.png` hanya memakai `Date.now()`. Dua permintaan `!hd` yang jatuh di milidetik yang sama akan memakai path yang sama: file saling menimpa dan pembersihan milik satu permintaan bisa menghapus file yang sedang dipakai permintaan lain.

## Perubahan
- `plugins/hd.js`: `tmpIn` dan `tmpOut` sekarang `hd_<timestamp>_<random>.jpg` / `hd_out_<timestamp>_<random>.png`, pola sama dengan `play.js` (`Math.random().toString(36).slice(2)`).

## Jebakan
- **Jangan cukup andalkan `Date.now()` di nama temp.** Bot memproses banyak chat; dua event bisa datang pada milidetik yang sama.
- Suffix acak bukan pengganti pembersihan: file tetap harus dihapus di `finally` supaya `tmp/` tidak menumpuk.

## Verifikasi
- `node --check plugins/hd.js` → lolos.
- Uji 200.000 nama dengan timestamp + suffix acak: **0 tabrakan**.
- Bot live (`pm2` app `Reze-MD`): dua event `♻️ Reload plugin 'hd.js'` muncul, tanpa error.

---

# FIX LOG - play: cookie + JS runtime untuk yt-dlp (2026-10-25)

## Gejala / permintaan
- yt-dlp sudah terpasang, tapi `play` tetap gagal download. Tanpa cookie: `Sign in to confirm you're not a bot`. Setelah `.yt-cookies.txt` ditambahkan dan dioper manual: `-F` hanya menampilkan storyboard (`sb0`-`sb3`) lalu `Requested format is not available`.
- Log verbose: `JS runtimes: none`, signature + n-challenge solving failed, YouTube memaksa SABR streaming.

## Perubahan
- `plugins/play.js` → `downloadAudio()` mengoper `--cookies <root>/.yt-cookies.txt` (kalau file ada) dan `--js-runtimes <runtime>:<path>` ke yt-dlp.
- Path runtime diambil dari `process.execPath` (node/bun yang sedang menjalankan bot). Tidak mengandalkan PATH pm2 dan tidak hardcode `/usr/local/bin/node`.
- Cookie dicek saat download (bukan saat module load), jadi file yang baru ditambahkan langsung terpakai tanpa reload plugin.
- Host ini: `pip install -U "yt-dlp[default]"` → menarik `yt-dlp-ejs` 0.8.0. yt-dlp 2026.10.21 di `/usr/local/bin`.

## Jebakan
- **Cookie saja tidak cukup.** Tanpa JS runtime (EJS), signature/n-challenge gagal dan YouTube hanya memberi storyboard → `Requested format is not available`. Dua-duanya wajib.
- **`--js-runtimes node` (tanpa path) tetap terdeteksi `none`** di host ini. Harus bentuk `node:/path/absolut`.
- **Jangan pakai cookie lewat proxy gratis.** `lib/proxyPool.js` hanya untuk request publik VidsSave tanpa kredensial; menyalurkan sesi akun lewat relay pihak ketiga = sesi bisa dicuri.
- `.yt-cookies.txt` sudah gitignored. Jangan commit atau masukkan ke backup publik.

## Verifikasi
- `node --check plugins/play.js` → lolos.
- yt-dlp manual dengan argumen yang sama: `Runtuh - Feby Putri feat. Fiersa Besari (Official Visualizer) | 224 s`. Hasil mp3 6,9 MB, 246 kbps, durasi 224 detik.
- Kontrol negatif: tanpa cookie tetap kena bot-check; tanpa `--js-runtimes` tetap "Requested format is not available".
- `require()` plugin belum bisa diuji di host ini karena `node_modules` belum terpasang (`sharp` MODULE_NOT_FOUND). Uji end-to-end harus dilakukan di host bot.

---

# FIX LOG - totalpesan: tampilkan semua member & semua fitur (2026-10-24)

## Gejala / permintaan
- Output `!totalpesan` memotong daftar di 50 member dengan teks "…dan N member lainnya.", dan `!totalpesan fitur` memotong di 30 fitur. User minta semuanya ditampilkan.

## Perubahan
- Batas 50 member dan 30 fitur **dihapus**. Seluruh member dan seluruh fitur yang tercatat selalu ditampilkan.
- Ditambah `chunkLines()` — pemecah daftar jadi beberapa pesan pada batas ~3500 karakter (potong di batas baris, tidak memutus satu entri). Semua potongan dikirim berurutan; `quote` hanya di pesan pertama, `mentions` disertakan di semua potongan supaya nama tetap ter-resolve.
- `MAX_CHARS = 3500` diekspor sebagai `plugin.MAX_CHARS` untuk test.

## Jebakan
- **Jangan cuma hapus `slice()` lalu kirim satu pesan raksasa.** WhatsApp punya batas panjang pesan; grup besar (ratusan member) akan gagal terkirim atau terpotong di sisi server. Pemecahan dilakukan sendiri supaya utuh dan bisa diverifikasi.
- **Potong di batas baris, bukan sembarang indeks karakter.** Kalau dipotong di tengah, satu entri jadi dua potongan rusak (`*42.` tanpa nama/nilai).
- **`quote: undefined` boleh, tapi jangan `quote: m` di semua potongan** — tiap potongan akan mengutip pesan yang sama dan tampak seperti spam balasan. Hanya potongan pertama yang mengutip.
- **`mentions` harus ikut di setiap potongan.** Kalau hanya di potongan pertama, `@nomor` di potongan berikutnya tampil sebagai teks mentah (tidak jadi nama/tag) pada beberapa klien.
- Baris judul (`head`) ikut dimasukkan ke daftar sebelum dipecah, supaya kalau grup sangat besar judul tetap muncul di potongan pertama dan tidak terpisah.

## Verifikasi
- `node --check plugins/totalpesan.js` → lolos.
- `grep -n "lainnya" plugins/totalpesan.js` → **kosong** (tidak ada teks pemotongan lagi).
- Uji grup besar, 300 member: **5 lolos / 0 gagal** — 300 member tampil semua (dihitung dari baris `*N.*`), 4 pesan terkirim / 12.080 karakter, mentions mencakup 300 nomor, tiap potongan ≤ batas, tidak ada teks "lainnya".
- Uji fitur besar, 120 command: **5 lolos / 0 gagal** — 120 fitur tampil semua, 2 pesan / 6.253 karakter, urutan tetap menurun (terbanyak di atas), tidak ada entri terpotong di tengah.
- Regresi: **18/18** (dasar), **10/10** (ketahanan hook), **46/46** (fitur/prefix), **44/44** (prefix asli `config.js` + plugin asli).
- Bot live (`pm2` app `Reze-MD`): reload bersih tanpa error.

---

# FIX LOG - totalpesan: hitung pemakaian fitur/command (2026-10-24)

## Gejala / permintaan
- `!totalpesan` baru menghitung pesan biasa; pemakaian fitur/command belum tercatat sama sekali.
- Butuh statistik fitur mana yang paling sering dipakai dan siapa yang memakainya.

## Fitur
- `!totalpesan` — tetap: daftar jumlah pesan per member (command tidak dihitung sebagai pesan).
- `!totalpesan fitur` (alias `cmd`, `command`) — daftar fitur/command yang dipakai, urut terbanyak: nama fitur, jumlah pemakaian, dan sampai 3 pengguna teratas per fitur. Maksimal 30 fitur ditampilkan.
- Data: `global.db.data.totalPesan[<gid>].__fitur` → `{ <namaCommand>: { total, oleh: { <nomor>: jumlah }, terakhir } }`. Kunci diawali `__` supaya tidak bentrok dengan kunci nomor HP member.
- Deteksi prefix memakai `global.prefix` dari `config.js` apa adanya (RegExp lebar: `! # $ % + £ ¢ € ¥ ^ ° = ¶ ∆ × ÷ π √ ✓ © ® : ; ? & . -`), bukan daftar karakter hardcode.
- Plugin `customPrefix` (cth `exec` dengan `> ` / `$ ` / `>> `) ikut terdeteksi dan dicatat.

## Jebakan
- **Jangan hardcode daftar prefix.** `config.js` memakai RegExp dengan banyak karakter tidak lazim (`©`, `®`, `π`, `∆`, dst). Salinan manual pasti ketinggalan. Selalu baca `global.prefix` dan tangani 3 bentuk: RegExp, array, string.
- **`/` BUKAN prefix di repo ini.** Banyak bot lain memakai `/`, di sini tidak. Sudah diuji: `/ping` dianggap pesan biasa.
- **Plugin `customPrefix` tidak lewat `global.prefix`.** Kalau hanya cek `global.prefix`, semua pemakaian `exec` (`> 1+1`, `$ ls`) tidak terhitung. Harus ikut iterasi `global.plugins` dan tes `p.customPrefix`.
- **Isi `exec` adalah kode shell/JS, bukan nama command.** Awalnya `>> echo hi` tercatat sebagai fitur `echo`. Bukan salah secara teknis, tapi statistik jadi penuh nama perintah shell acak. Sekarang plugin `customPrefix` dikelompokkan di bawah nama pluginnya (`exec`).
- **Command tidak boleh ikut dihitung sebagai pesan.** Kalau dihitung dua-duanya, orang yang banyak memakai command terlihat paling aktif sekaligus menggelembungkan total pesan. Sekarang: command → hitungan fitur, pesan biasa → hitungan pesan.
- **Kunci `__fitur` harus disaring** saat menyusun daftar member, kalau tidak akan muncul `@__fitur: 0 pesan` di output.
- **Hook `all` tetap harus tidak pernah throw** (dipanggil tiap pesan; kalau throw, owner dibanjiri laporan error). Semua akses pakai optional chaining + normalisasi `Number(v) || 0`.
- Helper `getFitur()` memanggil `getChat()` yang dideklarasikan sesudahnya — aman karena `function declaration` di-hoist, tapi jangan diubah jadi `const getChat = () => {}` (akan TDZ error).

## Verifikasi
- `node --check plugins/totalpesan.js` → lolos.
- Suite fitur: **46 lolos / 0 gagal** — deteksi 10 prefix umum, customPrefix (`>`, `>>`, `=>`, `$`), ekstraksi nama fitur (lowercase, bukan command → null), command tercatat sebagai fitur (3× ping: P1=2, P2=1), pesan biasa tetap terpisah, 4 fitur berbeda terpisah, `exec` jadi satu label (bukan `echo`), output `!totalpesan fitur` (judul/total/nama/mentions), `__fitur` tidak bocor ke daftar member, kasus grup kosong.
- Prefix asli dari `config.js` (bukan salinan) + 38 plugin asli dimuat lewat loader: **44 lolos / 0 gagal** — semua 24 karakter prefix dikenali; `halo semua`, `Rp 5000`, `1 + 1 = 2`, `ok!`, `5000 rupiah`, `😀 halo` tetap pesan biasa; `!menu`, `.warn`, `#tagall`, `!listwarn`, `!totalpesan`, `!autogc`, `!kick`, `> 1+1`, `$ ls` terdeteksi dengan nama benar.
- Regresi suite lama: **18/18** (dasar) dan **10/10** (ketahanan hook).
- End-to-end lewat `lib/simple.smsg` + loader + dispatch `all`: 6 pesan + 8 command → `!totalpesan` menampilkan `Total: 6 pesan dari 2 orang (Ani 4, Budi 2)`; `!totalpesan fitur` menampilkan `Total: 10 kali dari 7 fitur berbeda` dengan rincian menu/ping/exec/listwarn/warn/totalpesan/tagall beserta penggunanya.
- Bot live (`pm2` app `Reze-MD`): reload bersih tanpa error setelah perubahan.
- **Belum diuji dari trafik WhatsApp nyata** untuk mode fitur (diuji lewat injeksi event sintetis).

---

# FIX LOG - fitur totalpesan (statistik pesan per member) (2026-10-24)

## Gejala / permintaan
- Butuh leaderboard jumlah pesan per member grup, untuk melihat siapa yang paling aktif.
- Draf awal menghitung di dalam command, `participants.map(p => p.id)`, dan `m.reply(text, null, { contextInfo })` — ketiganya tidak jalan di repo ini (lihat Jebakan).

## Fitur
- Plugin baru `plugins/totalpesan.js` (format objek, sesuai `AGENTS.md`).
- `!totalpesan` (alias `totalchat`, `topchat`, `leaderboard`) — tampilkan total pesan per member, urut terbanyak.
- Output: total pesan grup, jumlah orang, nama member (dari metadata grup), nomor, dan jumlah pesannya. Maksimal 50 baris teratas supaya pesan tidak kepanjangan.
- Penyimpanan: `global.db.data.totalPesan[<groupJid>][<nomor>]` (sesuai draf), konsisten dengan konvensi key per-grup lain.
- Member grup yang belum pernah kirim pesan tetap terdaftar dengan nilai 0 saat command dijalankan.
- Bot sendiri tidak dimasukkan ke daftar.

## Jebakan
- **Penghitungan HARUS di hook `all`, bukan di command.** Kalau menghitung di dalam `run`, hanya pesan yang berisi perintah yang terhitung — pesan biasa tidak pernah masuk. `handler.js` memanggil `hook.all` sebelum parsing prefix/command, jadi di situlah tempatnya.
- **Hook `all` jalan untuk SETIAP pesan.** Kalau dia throw, `handler.js` mengirim laporan error ke owner tiap pesan → banjir. Semua field harus dicek null (`m.chat`, `m.sender`, `m.text`), dan nilai count yang rusak dinormalisasi (`Number(v) || 0`). Sudah diuji dengan 10 input aneh (semua lolos).
- **`participants` di repo ini pakai `p.jid`/`p.phoneNumber`/`p.lid`, BUKAN `p.id`.** Draf yang memakai `p.id` akan menghasilkan `undefined` semua.
- **`m.chat` dan `m.sender` bisa `null`** kalau LID tidak bisa di-resolve (lihat `lib/simple.js`). Hook harus `return` diam-diam, jangan crash, dan jangan menyimpan kunci `'null'`.
- **`m.reply(text, null, { contextInfo })` bukan signature yang dipakai repo ini.** `m.reply` di `lib/simple.js` cuma `(text, opts)`, dan `contextInfo`/`externalAdReply` sengaja dihindari. Untuk mention, pakai `conn.message.send(chat, teks, { quote: m, mentions: [...] })`.
- **Jangan panggil `global.db.write()` tiap pesan.** Itu menulis seluruh `database.json` ke disk setiap pesan masuk. `main.js` sudah menyimpan tiap 60 detik (`setInterval`), jadi cukup andalkan itu.
- **Command tidak dihitung sebagai pesan.** Tanpa filter prefix, member yang banyak memakai command terlihat paling aktif. Filter memakai `global.prefix` (bisa RegExp/array/string).
- **Pesan `fromMe` tidak dihitung** — kalau tidak, pesan bot sendiri ikut masuk statistik.
- **Hanya grup `@g.us`** yang dihitung; chat pribadi diabaikan.
- `fs.watch` bisa me-reload plugin saat file masih setengah tertulis, sehingga log sempat menampilkan `Plugin 'totalpesan.js' format tidak dikenali` tepat sebelum `➕ Plugin baru`. Itu artefak saat menulis file, bukan bug plugin — reload berikutnya bersih.

## Verifikasi
- `node --check plugins/totalpesan.js` → lolos.
- Test utama (stub `global.db` + `conn`): **18 lolos / 0 gagal** — hitung pesan biasa, command tidak dihitung, pesan bot tidak dihitung, chat pribadi diabaikan, `sender` null tidak crash, output (total/jumlah orang/nama/urutan/mentions), member tanpa pesan terdaftar 0, LID resolve ke nomor HP, urutan menurun, grup kosong.
- Test ketahanan hook `all`: **10 lolos / 0 gagal** — `chat`/`sender`/`text` undefined, chat LID, chat bukan grup, objek kosong, `totalPesan` rusak (array), entri chat berupa string, nilai count `'abc'` → jadi 1 (bukan NaN).
- Uji jalur handler sungguhan (replika `handler.js` + `lib/simple.smsg` + loader `normalizePlugin`): 3 pesan + 1 command → **tercatat 3**, lalu `!totalpesan` menampilkan `Total: 3 pesan dari 1 orang` dengan `*1.* Tester @6283191972077: *3* pesan`.
- Persistensi: `global.db.write()` menyimpan `totalPesan` dan `read()` memuatnya kembali → **utuh**.
- Loader: `normalizePlugin` → `names=totalpesan, totalchat, topchat, leaderboard`, `tags=group`, `groupOnly=true`, `all=function`, `run=function`.
- Bot live (`pm2` app `Reze-MD`): `➕ Plugin baru 'totalpesan.js'` lalu reload bersih tanpa error; proses `online`.
- Catatan: `totalPesan` di `database.json` masih kosong saat dicek karena belum ada pesan grup masuk setelah plugin dimuat — diuji lewat injeksi sintetis, bukan dari trafik nyata.
- **`!warn` sudah terbukti jalan di grup nyata** (entri `warn:120363320882068747@g.us` dengan count 1, alasan `@123292035862671 hama`, nomor ter-resolve ke `6283191972077`).

---

# FIX LOG - fitur warn member + auto kick + delwarn/listwarn (2026-10-23)

## Gejala / permintaan
- Admin grup butuh cara menegur member berulang tanpa langsung kick, plus sanksi otomatis di batas tertentu.
- Belum ada sistem warn di repo; `grep -rn "warn"` hanya menemukan log level (`console.warn`) dan `ConsoleLogger('warn')`.

## Fitur
- Plugin baru `plugins/warn.js` (format objek, sesuai `AGENTS.md`).
- `!warn @member [alasan]` — tambah warn. Target bisa mention, reply, atau nomor (`!warn 628xxx alasan`). Bisa beberapa target sekaligus.
- **5× warn = auto kick** dari grup. Setelah berhasil di-kick, entri warn member itu dihapus (kalau di-add lagi, mulai dari 0).
- `!delwarn @member` — hapus seluruh warn member (juga menerima reply/nomor, dan banyak target).
- `!listwarn` — daftar member yang kena warn, urut dari warn terbanyak: nama (kalau ada di metadata), nomor, jumlah, waktu terakhir, alasan terakhir.
- Alias: `warning`, `peringatan`, `hapuswarn`, `daftarwarn`.
- Penyimpanan: `global.db.data.settings['warn:<groupJid>']` → `{ <kunci>: { count, lastAt, by, reasons: [] } }` (konvensi sama seperti `liststore:<chat>` dan `ge:<groupJid>`). Riwayat alasan disimpan maksimal 5 terakhir, tiap alasan maksimal 120 karakter.

## Jebakan
- **Jangan simpan kunci berbasis LID.** `m.sender`/participant bisa datang sebagai `@lid`. Kunci penyimpanan memakai nomor HP yang di-resolve lewat `global.lidCache`, supaya warn untuk orang yang sama tidak terpecah dua entri.
- **Tapi `global.lidCache` hanya hidup di memori** dan kosong setelah restart. Kalau LID tidak ter-resolve, entri TETAP disimpan dengan kunci LID (jangan dibuang) — lebih baik warning tercatat daripada hilang. Konsekuensi: nomor yang sama bisa punya dua entri kalau pernah di-warn lewat PN dan lewat LID yang belum ter-resolve; `!delwarn` bisa membersihkannya.
- **Jangan menebak domain JID dari panjang angka.** LID bisa 8 digit (mirip nomor pendek), jadi `jidOf()` sekarang menyimpan domain asli JID saat warn dibuat (`domainOf()`), bukan menebak `@s.whatsapp.net`. Salah tebak menghasilkan JID palsu (`99887766@s.whatsapp.net`) yang bukan member mana pun.
- **Saat kick, kirim semua varian JID** (PN, jid, lid, plus JID asli target). Metadata grup bisa meng-address member sebagai LID; kalau hanya nomor HP yang dikirim, kick bisa gagal padahal membernya ada.
- **Kick gagal tidak boleh menghapus warn.** Kalau bot bukan admin (atau `removeParticipants` error), entri tetap tersimpan di batas (5/5) sehingga warning berikutnya mencoba kick lagi — tidak ada sanksi yang hilang diam-diam. Pesan ke grup menyebut `Gagal kick ... (jadikan bot admin)`.
- **Status disimpan setelah aksi berhasil**, bukan sebelum — pelajaran yang sama dengan `autogc.js`: menandai selesai lebih dulu membuat kegagalan tidak pernah diulang.
- **Proteksi wajib:** bot sendiri, owner bot, dan admin grup tidak bisa di-warn (dilewati dengan pesan alasan). Tanpa ini, admin bisa tidak sengaja meng-kick sesama admin.
- **`removeParticipants` mengembalikan array hasil per-JID** (`{ jid, status: 'ok'|'error', code }`), bukan throw. Kick dianggap berhasil kalau ADA minimal satu `status === 'ok'` — jangan cek `every()` karena mengirim beberapa varian JID membuat sebagian wajar gagal.

## Verifikasi
- `node --check plugins/warn.js` → lolos.
- Test utama (stub `global.db` + `conn`): **39 lolos / 0 gagal** — help, warn via mention/reply/nomor, akumulasi 1→5, auto kick di warn ke-5, entri dihapus setelah kick, proteksi bot/owner/admin, `listwarn` (isi + kosong), `delwarn` (termasuk yang tidak punya warn), kick gagal lalu sukses di percobaan berikutnya, multi-target, batas riwayat alasan.
- Test LID: **8 lolos / 0 gagal** — warn datang sebagai `@lid` disimpan dengan nomor HP; warn LID + PN bergabung jadi satu entri; saat kick, varian LID dan PN dua-duanya dikirim.
- Test LID tak ter-resolve (`lidCache` kosong): **7 lolos / 0 gagal** — kick tetap menargetkan LID asli, tidak menghasilkan JID `@s.whatsapp.net` palsu, `delwarn` bisa menghapus entri LID.
- Loader: `normalizePlugin` → `names=warn, warning, peringatan, delwarn, hapuswarn, listwarn, daftarwarn`, `tags=group`, `group/admin/botAdmin=true`, `run=function`.
- Bot live (`pm2` app `Reze-MD`): `➕ Plugin baru 'warn.js'` lalu `♻️ Reload plugin 'warn.js'` tanpa error setelah versi final; proses `online`. Error `format tidak dikenali` di log (15:54) berasal dari versi antara saat pengembangan, bukan versi akhir.
- **Belum diuji langsung lewat WhatsApp** (butuh grup nyata dengan bot admin).

---

# FIX LOG - fitur auto tutup/buka grup terjadwal (2026-10-23)

## Gejala / permintaan
- Belum ada cara menutup grup otomatis pada jam tertentu (mis. malam) lalu membukanya lagi pagi, tanpa admin harus ingat.
- Draf awal yang dikirim memakai `moment-timezone` + `node-schedule` dan `global.jadibots` — **ketiganya tidak ada di repo ini** (lihat Jebakan).

## Fitur
- Plugin baru `plugins/autogc.js` (format objek, sesuai `AGENTS.md`).
- Command: `!autogc <jamTutup> <jamBuka>` — cth `!autogc 21 5` (tutup 21:00, buka 05:00 WIB).
- Format jam: `21` · `21:30` · `2100` · `05.00` · `24:00`.
- Jadwal mingguan opsional: `!autogc "senin 22:00" "selasa 06:00"`.
- Subcommand: `on` / `off` (nonaktifkan tanpa hapus jadwal), `close` / `open` (ubah sekarang juga), `hapus` (buang jadwal), `status`, `cek`.
- Zona waktu WIB (Asia/Jakarta), dihitung manual dari offset UTC+7 — tidak butuh library timezone.
- Scheduler `setInterval` 30 detik di file plugin yang sama, tanpa dependensi tambahan.
- Mendukung bot utama + semua sesi jadibot (`lib/jadibot` → `sessions` Map), mencoba tiap koneksi sampai ada yang berhasil (bot utama bisa bukan admin di grup itu).
- Saat jadwal disetel dan sekarang sudah di luar/dalam jendela, setting grup langsung diselaraskan (tidak menunggu jam jadwal berikutnya).

## Jebakan
- **`moment-timezone` dan `node-schedule` tidak terpasang** dan sengaja tidak ditambahkan — cukup `Date` + offset UTC+7 dan `setInterval`. Kalau mau pakai `node-schedule`, tambahkan dulu ke `package.json` (repo ini pakai `npm`/`bun`, bukan dependensi implisit).
- **`global.jadibots` tidak ada di repo ini.** Koneksi jadibot disimpan di `lib/jadibot.js` sebagai `Map` bernama `sessions` (`ownerJid -> { client, phone, status }`). Draf awal yang memakai `global.jadibots` akan selalu kosong → fitur diam total untuk jadibot.
- **API grup zapo berbeda dari Baileys.** Tidak ada `groupSettingUpdate`. Yang dipakai: `conn.group.setSetting(jid, 'announcement', true/false)` (sama seperti `plugins/group.js`).
- **`node --check` saja tidak cukup** untuk plugin format objek: `module.exports` harus objek dengan `.run`. Sempat diekspor sebagai `handler` (fungsi) sehingga `normalizePlugin` masuk jalur format lama dan `permissions` (`groupOnly`/`adminOnly`/`botAdmin`) terabaikan.
- **Jangan menandai status selesai sebelum `setSetting` berhasil.** Versi awal menulis `cfg.status` lebih dulu; kalau bot bukan admin, kegagalan terbaca "sudah selesai" dan grup tidak pernah disusulkan sampai besok. Sekarang status hanya ditulis setelah berhasil, gagal dicatat di `cfg.lastError` dan dicoba lagi tiap 30 detik.
- **Jangan cocokkan status hanya pada menit persis jadwal.** Kalau bot mati/reload melewati jam jadwal, pengecekan berbasis "menit sekarang == menit jadwal" tidak akan pernah menyusul. Sekarang status dihitung dari jendela waktu (`sinceLast(tutup)` vs `sinceLast(buka)`).
- **Bandingkan juga HARI, bukan cuma jam.** Untuk jadwal mingguan, Senin 06:00 harus `opened` walau jadwal tutup Senin 22:00. Perbandingan jam saja membuat grup tertutup/terbuka di waktu yang salah.
- **Timer wajib dibersihkan saat reload.** `fs.watch` di `main.js` me-reload plugin tiap file berubah; tanpa `clearInterval(global.autoGcTimer)` timer lama menumpuk. Diuji 25× reload → tetap 1 interval hidup.
- **`Date.now` tidak bisa dipalsukan dengan menimpa `Date.now`** untuk `new Date()`; karena itu `nowWib()` menerima clock yang bisa diganti lewat `plugin.setClock()` untuk keperluan test.
- Alias hari jangan ditebak dari 3 huruf pertama: `minggu` tidak diawali `mgg`, dan `min` ambigu. Dipakai tabel alias eksplisit (`mgg`/`min`/`ahad` → minggu, dst).
- Grup `@lid`/chat pribadi di `global.db.data.chats` dilewati (`endsWith('@g.us')`).

## Verifikasi
- `node --check plugins/autogc.js` → lolos.
- Test logika (stub `global.db` + `conn`, waktu disuntik): **77 lolos / 0 gagal** — meliputi parser jam, help/status, set jadwal, tick tutup/buka, anti-dobel, off/on/hapus, close/open manual, jendela lewat tengah malam, jadwal mingguan, dan validasi input.
- Regresi khusus: **10 lolos / 0 gagal** — tick yang terlewat tetap menyusul, dan kegagalan `setSetting` tidak ditandai selesai lalu berhasil di percobaan berikutnya.
- Kebocoran timer: 25× reload → **1 interval hidup**.
- Loader: `normalizePlugin` mengembalikan `name=autogc`, `names=autogc, autogrup, autotutup`, `tags=group`, `group/admin/botAdmin=true`, `run=function`.
- Bot live (`pm2` app `Reze-MD`): hot-reload mencatat `➕ Plugin baru 'autogc.js'` / `♻️ Reload plugin 'autogc.js'` tanpa error; menu menampilkan `• !autogc | autogrup | autotutup`.
- **Belum diuji langsung lewat WhatsApp** (butuh grup nyata + bot admin). Yang sudah terverifikasi adalah logika, integrasi loader, dan pemuatan di proses live.

---

# FIX LOG - pindah API ke alsya.svazer.eu.cc (2026-10-23)

## Gejala / root cause
- Base API bot masih `api.alfisy.my.id`. Domain itu sudah dipindah/diganti, jadi semua plugin yang bergantung padanya (download, OCR, meme, removebg, hd, upload, pinterest, lyrics, translate) ikut ke domain lama.

## Perubahan
- Ganti seluruh `https://api.alfisy.my.id` → `https://alsya.svazer.eu.cc` di 11 file:
  `lib/translate.js`, `lib/upload.js`, `plugins/{ocr,hd,meme,play,removebg,pinterest,tiktok,instagram,lyrics}.js`.
- `AGENTS.md`: catatan "API downloader pihak ketiga" ikut diperbarui.
- Nama var `ALFISY` di `lib/translate.js` sengaja **tidak** di-rename — cuma label internal, tidak memengaruhi perilaku; rename akan menyentuh `viaAlfisy`/ekspor.

## Jebakan
- **Domain baru bukan clone beda isi** — dicek satu-satu: `/api/search/yts`, `/api/search/lyrics` balas 200; `/api/tools/ocr`, `/api/maker/meme` balas 400 (butuh payload, sama seperti domain lama); `/api/tools/removebg` 404 di kedua domain (endpoint memang tidak ada).
- **Translate tetap 429 di domain baru.** Bukan efek ganti domain: `translate` di domain lama dan baru dua-duanya balas `success:false, error:"Request failed with status code 429"` untuk input yang sama. Upstream Google yang menolak IP server, jadi rantai fallback (`google-proxy` → LibreTranslate → MyMemory) yang menutupi, bukan perubahan domain.
- **`removebg` 404 di kedua domain** — plugin `!removebg` memang sudah tidak berfungsi sebelum perubahan ini; jangan salah kaitkan dengan ganti domain.
- Domain lama masih hidup (root 200). Kalau nanti perlu balik, cukup `sed` arah sebaliknya.

## Verifikasi
- `grep -rn 'api\.alfisy\.my\.id' --include='*.js' .` → **kosong**.
- `grep -rn 'alsya\.svazer\.eu\.cc' --include='*.js' .` → 11 hit (10 konstanta + 1 komentar di `lib/translate.js`).
- `node --check` pada 11 file yang diubah → lolos semua.
- Probe langsung: `/api/search/yts?q=test` → HTTP 200, `/api/search/lyrics?q=test` → HTTP 200 pada domain baru.

---

# FIX LOG - paksa pakai JID, jangan LID (2026-10-22)

## Gejala / root cause
- Database (`database.json`) menyimpan entri dengan ID `@lid` (Lightweight ID), bukan nomor HP.
- Penyebab: `lib/simple.js` menyimpan `m.sender`/`m.chat` apa adanya dari `event.key`, padahal WhatsApp/Zapo bisa meng-address pengirim sebagai LID. LID hanya dipetakan ke nomor lewat `global.lidCache`, jadi begitu cache kosong (proses restart) seluruh ID jatuh ke LID dan tidak bisa dipakai untuk mention/banding JID.

## Perubahan
- `lib/simple.js` — `m.sender`/`m.chat` sekarang **dipaksa JID** (`@s.whatsapp.net`): kalau `primary`/`participantAlt`/`remoteJidAlt` punya sisi JID, itu yang dipakai; LID cuma disimpan ke `global.lidCache` sebagai pemetaan. Kalau setelah resolve masih LID dan tidak ada di cache, nilainya `null` (bukan LID mentah).
- `lib/groupEvents.js` — `phoneOf()` resolve LID lewat `global.lidCache`, `mentionJid()` hanya pakai `phoneJid`/`jid` (atau LID yang berhasil di-resolve), tidak lagi mengembalikan LID mentah.
- `lib/print.js` — `formatSender()`/`resolvePhoneFromJid()` resolve LID → JID dulu; kalau gagal tampilkan `?` daripada LID mentah.
- `database.json` direset (backup lama disimpan lokal, **tidak** di-commit).
- `.gitignore` — tambah `database.json.backup`, `*.json.backup`, `database.json.*.bak`.

## Jebakan
- **Jangan commit `database.json.backup`.** Data user (nomor HP, nama grup, settings) bukan source. Sempat ter-commit di `131ece5` dan harus di-rewrite + force push untuk dibersihkan.
- **`m.chat`/`m.sender` bisa `null` sekarang.** Plugin yang memakai JID mentah tanpa cek null bisa error; selalu cek `if (!m.chat) return`.
- **`global.lidCache` hanya hidup di memori** — kosong lagi setelah restart. Jangan andalkan isinya sebagai sumber kebenaran; pakai `participantAlt`/`remoteJidAlt` dari event sebagai sumber utama.
- **Rewrite history bikin commit hash lama tetap bisa diakses di GitHub** (raw view masih 200) sampai GitHub gc/support purge. Kalau data benar-benar sensitif, minta purge ke GitHub Support.

## Verifikasi
- `git ls-tree -r --name-only origin/main | grep -i database` → kosong.
- `raw.githubusercontent.com/.../cb468f0/database.json.backup` → 404 (commit baru bersih); commit lama masih 200 (cache GitHub).
- `pm2 restart` → bot `online`, 35 plugin termuat, terhubung tanpa pairing ulang.
- `node --check` pada `lib/simple.js`, `lib/groupEvents.js`, `lib/print.js` → lolos.

---

# FIX LOG - Ganti nama bot jadi Reze-MD (2026-10-22)

## Perubahan
Nama bot diganti dari `wa-bot-zapo` ke **Reze-MD** di seluruh titik yang terlihat user:
- `package.json` + `package-lock.json`: `name` → `Reze-MD` (dipakai banner `main.js`/`index.js` via `pkg.name`).
- `config.js`: `global.packname` dan `global.author` → `Reze-MD`. Ini yang muncul di judul `!menu`, link preview menu, dan nama pack stiker.
- `main.js`: baris banner `🤖 Reze-MD`; padding versi diganti `padEnd(40)` supaya kotak tidak berantakan saat nama berubah panjang.
- `ecosystem.config.js`: `name: 'Reze-MD'` (nama app di pm2) + komentar.
- `README.md`: judul, perintah `cd`, dan diagram struktur.
- `backup.js`: komentar.
- `~/botctl`: `APP=Reze-MD`.

## Jebakan
- **Nama app pm2 berubah berarti app lama harus dihapus dulu.** `pm2 delete wa-bot-zapo` lalu `pm2 start ecosystem.config.js`; kalau tidak, dua app jalan dan berebut `.auth` (`stream_error_replaced` → exit).
- **`botctl` kehilangan bit executable setelah VM restart.** `chmod +x botctl` perlu diulang; kalau tidak, `./botctl` gagal `Permission denied`.
- **`config.js` memasang `fs.watchFile`**, jadi `node -e "require('./config.js')"` tidak pernah exit (proses ditahan watcher). Untuk verifikasi nilai, baca file sebagai teks — jangan `require`.
- **Path direktori repo tetap `wa-bot-zapo`** (sengaja tidak di-rename): `ecosystem.config.js` pakai `cwd: __dirname`, `.auth`/`database.json` relatif, dan pm2 dump menyimpan path absolut. Rename folder akan memutus semuanya tanpa manfaat.
- Nama di `FIX_LOG.md` lama dibiarkan apa adanya — itu catatan historis, bukan konfigurasi aktif.

## Verifikasi
- Banner: `🤖 Reze-MD` / `Reze-MD v1.0.0` / `zapo-js • Node.js + Termux`, kotak rata.
- `pm2 list` → app `Reze-MD` `online`, 35 plugin termuat, `🟢 Terhubung ke WhatsApp!`, sesi lama tanpa pairing ulang.
- `grep -rn "wa-bot-zapo"` di luar `FIX_LOG.md` → **kosong**.
- `packname: Reze-MD | author: Reze-MD`; dipakai `plugins/menu.js` (2 tempat) dan `plugins/sticker.js`.
- `botctl status` menampilkan `Reze-MD` setelah `chmod +x`.

---

# FIX LOG - translate.js 429: rantai fallback penyedia (2026-10-21)

## Gejala / root cause
- `!tr` balas `❌ Gagal translate: Request failed with status code 429`.
- Bukan bug plugin. `GET api.alfisy.my.id/api/tools/translate` balas **HTTP 500** dengan `error: "Request failed with status code 429"` — API itu hanya meneruskan 429 dari upstream Google.
- Akar sebenarnya: **IP server ini di-429 Google.** Diuji langsung `translate.googleapis.com/translate_a/single?client=gtx...` → **429** halaman "Sorry...". Jadi mengganti parameter/retry di plugin tidak akan menolong; egress IP-nya yang ditolak.

## Perubahan
- `lib/translate.js` (baru) — rantai penyedia, dipakai berurutan sampai ada yang berhasil:
  1. `api.alfisy.my.id/api/tools/translate` (timeout 8s — cepat menyerah karena biasanya langsung 500)
  2. **Google `client=gtx` via proxy pool** — jalur utama yang benar-benar jalan
  3. LibreTranslate (`translate.disroot.org`) — tanpa proxy
  4. MyMemory (`api.mymemory.translated.net`) — tanpa proxy, sumber `en` (tidak mendukung `auto`)
  Kegagalan tiap penyedia dikumpulkan; kalau semua gagal, pesan error menyebut semuanya.
- Pool proxy **khusus translate** di `lib/translate.js`: diuji ke `translate.googleapis.com` dan diurutkan tercepat, cache ke `tmp/translate-pool.json` (TTL 10 menit), early-stop setelah 4 proxy <3s.
- `plugins/translate.js` disederhanakan: hanya parsing argumen + `lib/translate`. Field hasil ikut berubah (`data.from`, `data.to`, `data.text`).

## Jebakan
- **Pool `lib/proxyPool.js` tidak boleh dipakai apa adanya untuk translate.** Pool itu diurutkan untuk vidssave.com; proxy yang cepat di sana bisa 10s di translate (diukur). Karena itu ada pool terpisah dengan probe ke endpoint translate.
- **Build pool pertama mahal (40-52s).** Tanpa cache, user pertama menunggu ~93s. Cache disk `tmp/translate-pool.json` menurunkannya ke 1.5-4.9s pada run berikutnya.
- **MyMemory tidak mendukung `source=auto`** — `langpair` wajib eksplisit, jadi dipaksa `en|<target>`. Deteksi bahasa otomatis hanya akurat di jalur Google.
- `viaAlfisy` tetap dipertahankan paling depan: kalau suatu saat 429-nya lepas (atau bot dipindah ke IP residential), jalur ini yang tercepat dan tidak butuh proxy.

## Verifikasi
- Reproduksi awal: alfisy → `HTTP 500 / "Request failed with status code 429"`; `translate.googleapis.com` langsung → **429**.
- Proxy pool: 3/3 proxy balas **200** dan terjemahan benar (`hello world` → `halo dunia`).
- Jalur alternatif tanpa proxy: LibreTranslate `200 {"translatedText":"halo dunia"}`, MyMemory `200 "Halo Dunia"`.
- `translate()` 4 kasus: `hello world`→`halo dunia` (en→id), `selamat pagi`→`good morning` (ms→en), `good morning`→`おはよう` (en→ja), `terima kasih banyak`→`Thank you very much` (id→en). Semua `via google-proxy`.
- Plugin end-to-end (`!tr`): run dengan cache **1.7s / 1.5s / 4.9s**, output `*🌐 Translate* (en → id) / halo dunia`.
- Bot hot-reload (`♻️ Reload plugin 'translate.js'`), pm2 `online` pid 1393.

---

# FIX LOG - play.js: URL YouTube tampil dobel di caption (2026-10-21)

## Gejala / root cause
- Setelah cover dipindah ke `linkPreview`, link YouTube muncul **dua kali** di satu pesan.
- Penyebab: `info.url` dimasukkan ke `caption` **dan** di-prepend ke `content.text` sebagai anchor `matchedText` untuk link preview. Dua sumber, satu URL.

## Perubahan
- `plugins/play.js`:
  - `caption` tidak lagi memuat `info.url` — hanya judul + durasi.
  - URL dipasang **sekali** di `content.text` sebagai anchor `linkPreview`, diikuti newline supaya judul tidak menempel ke link.
  - Jalur tanpa thumbnail (tidak ada `linkPreview`) menambahkan URL sekali di akhir caption, jadi info link tetap ada tanpa duplikasi.

## Jebakan
- `matchedText` **wajib** ada di `content.text`, jadi URL memang harus ikut di teks — tapi jangan sekaligus ditaruh di `caption` yang digabung ke teks yang sama. Satu URL, satu tempat.
- Zero-width space (400x) diletakkan **setelah** newline, bukan langsung menempel ke URL, supaya judul tidak jadi satu baris dengan link.

## Verifikasi
- Dengan thumbnail: jumlah `youtu.be` di teks (zero-width dibuang) = **1**; `linkPreview: true`. Teks final:
  `https://youtu.be/YrtS8MESh0I` / `🎵 *Runtuh - Feby Putri feat. Fiersa Besari (Official Visualizer)*` / `⏱️ 3:44`.
- Tanpa thumbnail (`thumbnail: null` dipaksa): `linkPreview: false`, jumlah URL = **1**, URL di akhir caption.
- Audio tetap terkirim: 6.897.284 B.
- Bot hot-reload (`♻️ Reload plugin 'play.js'`), pm2 `online` pid 1393.

---

# FIX LOG - play.js kirim cover lewat linkPreview seperti menu.js (2026-10-21)

## Gejala / root cause
- `play` mengirim thumbnail sebagai **pesan image terpisah**, lalu audio di pesan kedua. Hasilnya dua bubble untuk satu perintah, dan file thumbnail harus ditulis ke `tmp/` lalu dihapus lagi.
- `plugins/menu.js` sudah punya pola yang lebih rapi: resize pakai `sharp`, lalu kirim sebagai `linkPreview` di dalam pesan teks (bukan pesan image).

## Perubahan
- `plugins/play.js`:
  - Tambah `makeInlineThumb(buf)` — `sharp().resize(300,300,{fit:'inside'}).jpeg({quality:80})`, `width/height` eksplisit `1280x720`. Sama persis dengan `getThumb()` di `menu.js`.
  - Ganti pengiriman: dari `type: 'image'` terpisah menjadi `type: 'text'` + `content.linkPreview` (`matchedText`, `title`, `description`, `thumbnail`). URL video ditaruh di awal teks + 400 zero-width space supaya link ter-render tapi tidak terlihat.
  - Thumbnail tidak lagi ditulis ke `tmp/` — diproses di memori.
  - Deskripsi plugin disesuaikan (tidak lagi menyebut VidsSave sebagai jalur utama).

## Jebakan
- **Thumbnail inline WA dibatasi 64KB** (`INLINE_THUMBNAIL_MAX_BYTES` di zapo). Tanpa resize sharp, `hq720.jpg` (49KB) kadang masih lolos tapi tidak konsisten; hasil resize jadi **5.184 B / 300x168** — aman.
- **`matchedText` wajib ada di dalam `content.text`.** Kalau URL-nya tidak ikut di teks, WhatsApp tidak merender preview. Zero-width space dipakai supaya URL tidak tampak sebagai teks URL.
- **Jangan kirim `linkPreview` di pesan audio** — hanya di pesan teks. Audio tetap dikirim terpisah tanpa preview.

## Verifikasi
- `play.run()` end-to-end: pesan pertama `type: 'text'` dengan `linkPreview` (`matchedText: https://youtu.be/YrtS8MESh0I`, `title` judul lagu, `description: 3:44 • YouTube`, thumb **5.184 B**, `1280x720`), `matchedText` terkonfirmasi ada di `text`. Pesan kedua `type: 'audio'` 6.897.284 B tanpa `linkPreview`.
- Thumbnail divalidasi dengan `sharp.metadata()`: `300x168`, format `jpeg`, dari sumber 49.078 B → 5.184 B (<64KB).
- Bot hot-reload (`♻️ Reload plugin 'play.js'`), pm2 `online` pid 1393, tidak ada error `play`/`sharp` di error log.

---

# FIX LOG - Cookie YouTube + JS runtime: play.js lewat yt-dlp lagi (2026-10-21)

## Gejala / root cause
- `play` masih bergantung VidsSave + rotasi proxy: jalan, tapi **lambat 20-40 detik** (proxy gratis 0.3-0.7 MB/s) dan proxy sering mati.
- yt-dlp langsung selalu gagal `Sign in to confirm you're not a bot` (IP datacenter). Playwright/stealth **tidak menolong** — Cloudflare/YouTube memblokir di lapisan IP, bukan fingerprint (dibuktikan: `403`, body 1 byte).
- Setelah cookie akun dipasang, error **berubah** jadi `The page needs to be reloaded` / `No video formats found`. Itu kemajuan: cookie diterima (`Found YouTube account cookies`), masalahnya pindah ke solver n-challenge.
- Akar sebenarnya terlihat di `-v`: `[jsc] JS Challenge Providers: bun (unavailable), deno (unavailable), node (unavailable), quickjs (unavailable)` → `n challenge solving failed` → format tidak ketemu.

## Perubahan
- `~/.config/yt-dlp/config` (baru, mode 600): `--cookies ~/.config/yt-dlp/cookies.txt` + `--js-runtimes node`. Dengan config ini `yt-dlp <url>` jalan tanpa flag apa pun.
- `~/.config/yt-dlp/cookies.txt`: 22 cookie akun, format Netscape, semua di domain `.youtube.com` (cookie `.google.com` tidak terkirim ke youtube.com).
- `plugins/play.js`:
  - **Urutan download dibalik**: yt-dlp dulu (diukur ~28 MB/s, tanpa relay pihak ketiga), VidsSave + rotasi proxy jadi cadangan. Kalau dua-duanya gagal, pesan menyebut keduanya.
  - `resolveYtDlp()`: cari path absolut (`/home/hatch/bin`, `$HOME/.bun/bin`, `$HOME/.local/bin`, `/usr/local/bin`, `/usr/bin`) sebelum jatuh ke lookup PATH.

## Jebakan
- **`--js-runtimes node` wajib.** Tanpa flag ini yt-dlp melaporkan `node (unavailable)` walau Node ada di PATH, lalu gagal dengan pesan menyesatkan (`No video formats found`). Flag harus eksplisit; auto-detect tidak jalan di build standalone.
- **Jangan andalkan lookup PATH untuk yt-dlp.** Di pm2 PATH bisa tidak memuat `~/.bun/bin`; gejalanya `spawn yt-dlp ENOENT` dan `play` gagal dalam 1.5 detik. Ini pernah membuat saya salah menyimpulkan "intermiten" — padahal biner-nya memang tidak ketemu.
- **`~/.bun/bin`, `~/.npm-global`, dan `node_modules` HILANG setiap VM restart.** Setelah restart 08:33, `yt-dlp`, `bun`, `pm2`, dan semua deps lenyap; yang selamat cuma file repo (`.auth`, `logs`, `FIX_LOG.md`, `lib/`) dan cookie. Jangan simpan tooling hanya di home tanpa rencana pasang ulang.
- **Cookie = kredensial sesi.** Sudah masuk `.gitignore` (`.yt-cookies.txt`), mode 600. Jangan commit, jangan tampilkan isinya.
- Cookie bisa kedaluwarsa/di-invalidate kapan saja; kalau `Sign in to confirm` muncul lagi, export ulang.
- `--cookies` + `--js-runtimes node` **tidak** perlu proxy. Jalur proxy tetap disimpan sebagai cadangan kalau cookie mati.

## Verifikasi
- Tanpa flag (config otomatis): `yt-dlp --simulate --print '%(title)s'` → `Runtuh - Feby Putri feat. Fiersa Besari (Official Visualizer) | 224 dtk`.
- Download nyata: `t.mp3` **6.897.284 B**, ~27.5 MB/s (vs 0.3-0.7 MB/s lewat proxy).
- `play.run()` end-to-end dengan **PATH minimal** (`env -i HOME=... PATH=/usr/local/bin:/usr/bin:/bin`, meniru pm2) — 6/6 query sukses, 10.9-15.6 detik:
  `runtuh` 6.897.284 B (15.6s) · `tulus monokrom` 7.114.844 B (12.1s) · `sheila on 7 dan` 8.570.540 B (11.8s) · `nadin amizah` 7.508.108 B (12.2s) · `feast perempuan` 9.484.412 B (12.9s) · `hindia secukupnya` 7.103.084 B (14.8s).
- Bot pulih: pm2 `online` (pid 1393), `🟢 Terhubung ke WhatsApp!`, sesi lama tanpa pairing ulang, `pm2 save` tersimpan.

---

# FIX LOG - play.js: bypass blokir Cloudflare VidsSave via rotasi proxy (2026-10-20)

## Gejala / root cause
- Setelah search dipindah ke API alfisy, `play` masih gagal di tahap download: VidsSave balas `analyze_risk`, dan yt-dlp balas `Sign in to confirm you're not a bot`.
- Diagnosis: **Cloudflare memblokir di edge, bukan JS challenge.** `https://vidssave.com/` balas `403`, body **1 byte**, `server: cloudflare`, `cf-ray: ...-IAD`, `content-type: text/plain`. Blokir terjadi sebelum JS apa pun jalan.
- Karena itu **Playwright tidak bisa menolong**: diuji dengan `playwright-core` 1.64.1 + Chromium, plus stealth (override `navigator.webdriver`, `window.chrome`, `sec-ch-ua`, locale/timezone) — tetap `403`, body 1 byte. Blokirnya di lapisan IP, bukan fingerprint browser.

## Perubahan
- `lib/proxyPool.js` (baru): ambil daftar proxy gratis dari 3 sumber (proxyscrape, TheSpeedX, monosans), uji mana yang benar-benar sampai ke `vidssave.com` (harus 200 **dan** body > 2KB — 403 Cloudflare kadang menyamar jadi 200 dengan body kosong), ukur latensi, urutkan tercepat, cache ke `tmp/proxy-pool.json` (TTL 10 menit), rotasi round-robin, `markDead()` untuk yang gagal, `forceRefresh()` untuk buang cache basi.
- `lib/vidsaveFetch.js` (baru): `parseVia()` POST ke endpoint parse lewat proxy bergantian (maks 6 percobaan), `downloadVia()` ambil file lewat proxy (timeout 45s/percobaan, 6 percobaan, rotasi agresif).
- `vidssave-plugin.js`: `scrapeVidsSave` coba request **langsung dulu** (kalau bot di IP residential, tidak perlu relay), fallback ke proxy kalau kena `analyze_risk`/403. Hasil menyertakan `viaProxy` supaya download bisa lewat proxy yang sama.
- `plugins/play.js`: download lewat `downloadVia` kalau parse-nya lewat proxy; konversi hasil ke **mp3 asli** via ffmpeg (`toMp3`) — VidsSave menyajikan WebM/Opus atau M4A, bukan mp3.

## Jebakan
- **Jangan kirim buffer VidsSave dengan ekstensi `.mp3` tanpa konversi.** Isinya WebM/Opus; WhatsApp bisa menolak atau salah memutar durasi. Diuji: 4.001.080 B WebM/Opus → 5.182.148 B mp3 setelah `ffmpeg -c:a libmp3lame -q:a 2`.
- **Proxy yang lolos parse belum tentu bisa download.** Diukur 0.3-0.7 MB/s, dan satu percobaan pernah 403 setelah **42 detik**. Karena itu timeout per percobaan 45s dan langsung pindah proxy, bukan menunggu satu proxy selesai.
- **Proxy gratis cepat mati.** Cache 10 menit bisa berisi proxy yang semuanya sudah mati → request berikutnya gagal cepat (`fetch failed`) tanpa pernah mencoba yang segar. Karena itu `forceRefresh()` dipanggil setelah semua percobaan gagal, dan TTL diturunkan dari 30 ke 10 menit.
- **`refresh()` harus mengembalikan array string**, bukan objek skor. Sempat salah dan `nextProxy()` mengembalikan `{p, ms}` sehingga `fetch` gagal dengan pesan membingungkan.
- **Jangan pakai proxy ini untuk kredensial.** Ini relay pihak ketiga; yang lewat sini hanya request publik ke VidsSave (tanpa cookie/token akun).
- Hasil pencarian teratas bisa video kompilasi berjam-jam (`lofi hip hop` → 6 jam, audio 380MB). Itu bukan bug: `play` menolaknya dengan pesan agar user memakai judul lebih spesifik.

## Verifikasi
- **Cloudflare**: `curl` langsung → 403 body 1 byte, `cf-ray ...-IAD`. Via proxy `102.244.78.61:8083` → **200, body 354.646 B**.
- **Playwright tidak menolong**: `chromium.launch()` + stealth → `https://vidssave.com/` tetap **403, body 1 byte**.
- **Rantai lengkap manual**: parse via proxy → `status: 1`, payload AES 13.850 B → decrypt OK → 11 resource (video 144P-1440P, audio 48-256kbps) → download `256KBPS OPUS` **4.001.080 B** (cocok dengan metadata) → `ffprobe`: opus, 223.98s → mp3 5.182.148 B.
- **Screening proxy**: 3.154 kandidat diuji → **290 lolos** ke vidssave.com; pool runtime menyusut ke ~20 tercepat dan rotasi terbukti (4 request berturut-turut lewat 4 proxy berbeda, semuanya `status: 1`, 1.1-6.3s).
- **End-to-end `run()` nyata** (bukan stub), 5 query: `runtuh` OK 5.182.148 B (35.1s), `tulus monokrom` OK 5.234.372 B (20.6s), `sheila on 7 dan` OK 6.384.932 B (27.3s), `nadin amizah` OK 5.438.924 B (40.3s), `lofi hip hop` ditolak dengan pesan size guard (2.2s) — sesuai harapan.
- **Tanpa regresi**: `vidssave-plugin.js` CLI mode sekarang `status: true` (sebelumnya `analyze_risk`) — plugin `vidssave` ikut sembuh karena berbagi `scrapeVidsSave`.
- Bot tetap `online` (pid 1311, 74 menit), hot-reload `♻️ Reload plugin 'play.js'`, tidak ada error setelah 18:31.

---

# FIX LOG - play.js: search pakai API alfisy, download lewat VidsSave (2026-10-20)

## Gejala / root cause
- `plugins/play.js` pakai `ytsearch1:` dari yt-dlp. YouTube memblokir IP datacenter host ini: **semua** `player_client` (`android`, `ios`, `tv`, `tv_embedded`, `mweb`, `web_safari`, `visionos`) balas `Sign in to confirm you're not a bot`. Jadi `play` mati total di server, bukan cuma lambat.
- `vidssave-plugin.js` sudah punya scraper VidsSave lengkap, tapi `scrapeVidsSave` tidak di-export — tidak bisa dipakai ulang dari plugin lain tanpa duplikasi kode.

## Perubahan
- `vidssave-plugin.js`: export `scrapeVidsSave` (`module.exports.scrapeVidsSave`) supaya `play.js` pakai logika parse/decrypt yang sama. Tidak ada perubahan perilaku plugin `vidssave` sendiri.
- `plugins/play.js` ditulis ulang:
  - **Search** → `GET https://api.alfisy.my.id/api/search/yts?q=`. Ambil hasil pertama. Field API beda dari yt-dlp: `duration` string (`"3:44"`) bukan detik, jadi ada `parseDuration()`; id di `videoId`, url di `url`.
  - **Download** → `scrapeVidsSave(url)` lalu `pickAudio()` pilih resource `type: audio` kualitas tertinggi (`128kbps` > `64kbps`). `download()` (fetch + fallback curl resume) dipakai ulang untuk ambil file dan thumbnail.
  - yt-dlp diturunkan jadi jalur terakhir, hanya kalau VidsSave tidak menyediakan audio. Kalau dua-duanya gagal, pesan error menggabungkan **kedua** alasan, bukan cuma yang terakhir.
  - `analyze_risk` dari VidsSave diterjemahkan jadi pesan yang bisa ditindaklanjuti, bukan dump JSON mentah.

## Jebakan
- **VidsSave menolak IP datacenter** dengan `status_code: 'analyze_risk'` (HTTP 200 tapi `status: 0`). Retry tidak menolong: sudah diuji 4 varian payload (`origin=cache|web`, tanpa origin, `domain=api.`) dan 3x percobaan berturut-turut — semuanya `analyze_risk`. Homepage `vidssave.com` sendiri balas **403**. Jadi `play` hanya jalan penuh dari IP residential (Termux/HP).
- **`/api/download/youtube` di API alfisy juga mati dari IP ini**: `502` dengan `Upstream init response missing convertURL` dan `snapyt: ... 403 | proxy 403`. Search-nya sehat (200, 19 hasil) — jadi jangan simpulkan API-nya rusak hanya karena endpoint download gagal.
- Kalau `vidssave-plugin.js` diubah, `play.js` ikut ter-reload karena `require`-nya. Tapi **tidak** sebaliknya: mengubah `vidssave-plugin.js` tidak memicu `fs.watch` di `plugins/` — perlu sentuh `play.js` atau restart.
- Menulis file plugin saat bot hidup memicu error transien `Plugin 'play.js' format tidak dikenali` (loader membaca file di tengah penulisan). Cek log setelah reload sebelum menyimpulkan plugin rusak.

## Verifikasi
- Search API live: `GET /api/search/yts?q=runtuh` → HTTP 200, 19 hasil, `status: true`.
- End-to-end `run()` nyata (bukan mock): reply `🔎 Mencari "runtuh"...` → `⏳ Ambil audio...` → kirim image thumbnail 49.078 B + caption `🎵 *Runtuh - Feby Putri feat. Fiersa Besari (Official Visualizer)* / ⏱️ 3:44 / https://youtu.be/YrtS8MESh0I`. Judul & durasi cocok dengan respons API.
- Jalur download diuji dengan `scrapeVidsSave` di-stub (server lokal menyajikan mp3 12.942 B): `pickAudio` benar memilih `128kbps` (12.942 B) dan **bukan** `64kbps` (9.000 B); file terkirim sebagai `audio`, `fileName` terisi, `tmp/` bersih setelah selesai.
- Jalur gagal nyata: reply `❌ Gagal download: VidsSave menolak IP server ini (analyze_risk) - jalankan bot dari IP residential/Termux | yt-dlp: ERROR: [youtube] ... Sign in to confirm you're not a bot`.
- Hot-reload: `♻️ Reload plugin 'play.js'` muncul di log, bot tetap `online` (pid sama, tanpa restart). Tidak ada error setelah 18:32:53.
- `node --check plugins/play.js` + `node --check vidssave-plugin.js` lulus; `require` plugin mengembalikan object dengan `run`, `command: /^(play|song)$/i`, `aliases: ['song']`, `tags: ['downloader']`.

---

# FIX LOG - Deploy pm2 lewat ecosystem.config.js (2026-10-20)

## Gejala / root cause
- Bot dijalankan manual `npm start` di shell interaktif. Shell ditutup atau VM restart = bot mati, tidak ada yang membangkitkan. `index.js` cuma supervisor untuk `main.js`, bukan untuk dirinya sendiri.
- `index.js` juga tidak meneruskan status ke pm2: kalau `main.js` berhenti normal (`exit 0`), supervisor ikut selesai dan pm2 melihat proses sukses, bukan crash.

## Perubahan
- `ecosystem.config.js` baru di root repo:
  - `script: 'index.js'` + `cwd: __dirname` — pm2 mengawasi supervisor, bukan `main.js` langsung. Kalau pm2 menjalankan `main.js` langsung, backoff retry di `index.js` hilang.
  - `autorestart: true` menutup celah exit 0 di atas.
  - `max_restarts: 5` + `min_uptime: '60s'` + `restart_delay: 5000` — pairing/config salah berhenti setelah 5x, tidak restart-loop.
  - `max_memory_restart: '900M'`, `kill_timeout: 10000` (beri waktu handler sinyal tutup sqlite + jadibot).
  - `env.PATH` menyertakan `$HOME/.bun/bin` — pm2 mewarisi PATH minimal, `plugins/play.js` cari `yt-dlp` di PATH.
- `.gitignore`: tambah `logs/` (pm2 out/error log).

## Jebakan
- **`cwd` wajib root repo.** `main.js` buka `database.json` dan `.auth/state.sqlite` pakai path relatif. `cwd` salah = sesi baru = pairing ulang, sesi lama di WhatsApp jadi perangkat yatim.
- **Jangan pernah dua proses pada satu `.auth`.** Proses kedua kena `stream_error_replaced` (ada di `FATAL_REASONS` → `process.exit(1)`). Handover harus: matikan proses lama dulu, baru `pm2 start`.
- **`PHONE_NUMBER` wajib diisi via env saat pairing.** Di pm2 tidak ada TTY, `askPhone()` di `main.js` menggantung. Setelah sesi terdaftar env ini tidak dipakai lagi, tapi aman dibiarkan.
- **`pm2 startup` tidak bisa dipakai di container ini** — tanpa systemd, `/etc/s6-overlay/s6-rc.d` milik root. Pakai `pm2 save` + `pm2 resurrect` manual setelah reboot.
- pm2 God Daemon jalan sebagai user yang men-start-nya. Bot milik user lain (mis. root) **tidak bisa** di-adopt atau dimatikan oleh pm2 user lain.

## Verifikasi
- Diuji di salinan repo terpisah (tanpa `.auth`): `pm2 start ecosystem.config.js` → `online`, banner + 35 plugin termuat, pairing code ter-mint.
- `pm2 restart` → pid berubah (↺ 1), log lanjut normal.
- `pm2 stop` → SIGTERM ditangkap, log `🔴 Mematikan bot...` (graceful, bukan SIGKILL).
- `pm2 env` → `PATH` memuat `$HOME/.bun/bin`, `PHONE_NUMBER` + `NODE_ENV=production` terwarisi.
- `execFile('yt-dlp', ['--version'])` dari cwd bot → `2026.08.19`, tidak ENOENT.

---

# FIX LOG - Error report tampilkan nomor HP bukan LID mentah (2026-10-18)

## Gejala / root cause
- User lapor sender di laporan error masih tampil sebagai LID (`215462185062474@lid`).
- Penyebab: `reportPluginError` di `handler.js` mencetak `m.sender` mentah. `m.sender` memang diset mentah di `lib/simple.js` (bisa PN atau LID tergantung addressing WhatsApp) — padahal codebase sudah punya `global.lidCache` + helper `phoneOf()` di `lib/groupEvents.js` yang resolve LID → nomor HP.

## Perubahan
- `handler.js`: require `phoneOf` dari `lib/groupEvents` (file itu tanpa require sama sekali — aman dari circular dep), lalu baris `Sender:` di `reportPluginError` pakai hasil resolve. Kalau LID ke-resolve tampil `nomor (lid@lid)`, kalau tidak tampil JID apa adanya (tidak ngarang nomor).

## Jebakan
- `m.sender` sendiri sengaja TIDAK diubah jadi nomor — perbandingan owner/JID di codebase mengandalkan `normalize()`/`lidCache`, bukan string mentah (lihat AGENTS.md).

## Verifikasi
- `node --check handler.js` lulus.
- Unit test `phoneOf`: LID cached → `6285815061014`; LID unknown → fallback nomor mentah; PN biasa → tidak berubah.
- Bot tetap online setelah hot-reload handler.js (cek pm2).

---

# FIX LOG - plugins/play.js pakai yt-dlp, tanpa API (2026-10-16)

## Gejala / root cause
- User minta `!play` tidak lagi lewat `api.alfisy.my.id` (`/search/yts` + `/download/youtube`), tapi langsung pakai yt-dlp.

## Perubahan
- Install yt-dlp standalone 2026.08.19 ke `/home/hatch/bin/yt-dlp` (persisten, 755; `/home/hatch/bin` di-`o+x` supaya user konsol bisa eksekusi). Plugin fallback ke `yt-dlp` di PATH kalau binary tidak ada (mis. di Termux).
- `plugins/play.js` rewrite: search via `yt-dlp "ytsearch1:<query>" --dump-single-json`, download audio via `-f 18 -x --audio-format mp3`. Helper fetch/curl lama dipertahankan hanya untuk download thumbnail.
- Jebakan YouTube di IP datacenter: extractor web kena "Sign in to confirm you're not a bot". Solusi: `--extractor-args "youtube:player_client=android"` — lolos bot-check, tapi cuma sedia format 18 (360p mp4+aac) sehingga audio diekstrak dari situ via ffmpeg. Client ios tidak memberi format sama sekali.

## Jebakan
- Jangan ganti player_client ke web/default tanpa PO token/cookies — langsung kena bot-check lagi.

## Verifikasi
- `node --check plugins/play.js` lulus.
- CLI end-to-end: search `ytsearch1:runtuh` → "Runtuh - Feby Putri feat. Fiersa Besari" (id YrtS8MESh0I, 224s); download+convert → mp3 6.3MB, durasi 223.98s (ffprobe).
- Test command via WhatsApp (`!play`) menunggu user.

---

# FIX LOG - Supervisor auto-retry backoff untuk connect transient (2026-10-14)

## Gejala / root cause
- VM ke-replace ~00:28 WIB 2026-10-14, semua layanan mati. Restore jalan, tapi wabot gagal connect ke WhatsApp: `websocket connect error` / timeout, lalu `process.exit(1)`.
- Supervisor lama (`index.js`) cuma restart `main.js` kalau file-nya diedit — habis gagal connect, bot diam mati sampai ada yang `pm2 restart` manual. Cron auto-recovery platform lagi di-skip semua, jadi tidak ada yang membangunkan bot.
- Tes langsung membuktikan WhatsApp me-reject handshake dari IP egress container dengan **403** (`Unexpected server response: 403`), sama seperti insiden 2026-10-13 18:20 WIB — blokir di sisi WhatsApp, bukan salah kode/proxy. Proxy egress sendiri sehat (curl via proxy ke web.whatsapp.com:443 dan :5222 → 200).

## Perubahan
- `main.js`: bedakan exit code — `2` = fatal butuh manusia (banned/logout di `FATAL_REASONS`, `PHONE_NUMBER` invalid), `1` = transient (gagal connect awal: timeout/403). Komentar penjelas di tiap `process.exit`.
- `index.js`: supervisor auto-retry exit transient dengan backoff 2m → 5m → 10m → 15m (reset kalau sempat hidup >10 menit). Exit `2` TIDAK di-retry (tetap tunggu edit `main.js`, sesuai jebakan "Reconnect fatal" di AGENTS.md). Edit `main.js` kapan saja = batalkan timer + restart langsung.
- Interval 2–15 menit = satu handshake attempt per siklus, tidak agresif, cukup untuk bangun sendiri begitu blokir IP lepas.

## Jebakan
- Jangan samakan exit 1 dan 2: banned/logout HARUS tetap butuh hapus `.auth` manual, jangan auto-retry.
- Retry tidak menyelesaikan 403-nya — itu keputusan WhatsApp terhadap IP egress. Retry cuma memastikan bot kembali online sendiri saat blokir dicabut.

## Verifikasi
- `node --check index.js` dan `node --check main.js` lulus.
- `pm2 restart wabot` 2026-10-14 ~09:47 WIB: supervisor baru aktif, `main.js` jalan, log retry `[supervisor] retry #1 dalam 2 menit...` muncul setelah gagal connect (403 masih aktif saat itu).
- Bot akan terus mencoba tiap 2→5→10→15 menit sampai `🟢 Terhubung ke WhatsApp!` muncul di log.

---

# FIX LOG - WebSocket lewat egress proxy di container (2026-10-13)

## Gejala / root cause
- Bot jalan di container tapi tidak pernah connect ke WhatsApp: `socket open failed`, `websocket connect error for wss://web.whatsapp.com/ws/chat`, `comms connection timeout after 10000ms`.
- Penyebab: container mewajibkan semua outbound lewat egress proxy (`HTTPS_PROXY`, mis. `http://...@hatch-egress-proxy:3128`). Package `ws` tidak membaca env proxy — koneksi direct dibunuh di tengah jalan (curl `--noproxy '*'` langsung 000, TLS error `wrong version number`).
- Di Termux (HP) direct connection normal, jadi fix harus aktif hanya kalau env proxy ada.

## Perubahan
- `main.js`: patch `PatchedWs` tetap (header Origin/UA + 3-arg form, jangan dihapus), ditambah `HttpsProxyAgent` dari env `HTTPS_PROXY`/`https_proxy` kalau ada; kalau tidak ada tetap direct seperti di Termux.
- `package.json`: tambah dependency `https-proxy-agent` (sudah `npm install`, tersimpan otomatis).

## Jebakan
- Jangan hapus patch WebSocket — native WebSocket Node tetap gagal handshake ke server WhatsApp; yang ditambah cuma `agent` proxy.

## Verifikasi
- `node --check main.js` lulus.
- Restart pm2 2026-10-13 ~07:25 WIB: log menampilkan `🟢 Terhubung ke WhatsApp!` + `📥 Selesai drain event offline` — session SQLite lama langsung reconnect tanpa pairing ulang. Proxy fix terbukti jalan end-to-end.

---

# FIX LOG - AI vision support (2026-10-09)

## Perubahan
- `plugins/ai.js` menerima gambar yang dikirim bersama caption `!ai` atau gambar yang di-reply dengan `!ai <pertanyaan>`.
- Mengunduh media memakai `lib/mediaProcessor`, mengirim sebagai `imageData` data URI ke `/api/chat` dengan model vision `qwen`.
- Validasi buffer dan mempertahankan session per user.

## Verifikasi
- `node --check plugins/ai.js` lulus.
- Probe live dengan gambar PNG 64x64 merah ke model Qwen menghasilkan jawaban `Merah` (HTTP 200).

---



## Perubahan
- `plugins/ai.js` memakai `POST https://ai.alfisy.my.id/api/chat` dengan `{ message, model, sessionId }`, sesuai dokumentasi.
- Model default `mistral-agent`; respons `{ reply, sessionId }` disimpan per user untuk percakapan berlanjut.
- Timeout 60 detik dan pesan error untuk HTTP gagal.

## Verifikasi
- API live: `/api/models` HTTP 200; POST `/api/chat` prompt uji HTTP 200 dan mengembalikan `reply` serta `sessionId`.
- `node --check plugins/ai.js` lulus.

---



Commit: `05be917` (b2a3156 → 05be917). Semua entri di bawah dari commit ini kecuali disebut lain.

## Fitur baru
- `plugins/liststore.js` — List Store sesuai `MSG.MD`. Command `!addmsg`,
  `!updatemsg`, `!delmsg`, `!listmsg` (grup saja, admin-only untuk kelola).
  Auto-reply **exact match** nama entri, tanpa prefix, grup saja.
  Batas: nama 50 char, media 20 MB, 200 entri/grup, cooldown 3 s per
  pengirim+entri. Data di `global.db.data.settings["liststore:"+chat].entries`,
  media di `data/list-store-media/`.
- `plugins/lyrics.js` — `!lyrics`/`!lirik`, API `api.alfisy.my.id/api/search/lyrics`.
  Hasil pertama, potong per 3500 char.
- `plugins/ocr.js` — `!ocr`/`!totext`/`!readtext`. Upload gambar ke CDN dulu,
  baru `GET .../tools/ocr?imageUrl=`.
- `plugins/listgrup.js` — `!listgrup`/`!listgroup`/`!gclist`, owner-only
  (memuat invite link), urut member, maks 10, tampil JID juga.
- `plugins/speedtest.js` — `!speedtest`/`!spdtest`/`!sts`, jalankan
  speedtest-cli via `curl ... | python3 - --share` (timeout 180 s), hasil
  dikirim sebagai **gambar PNG bercaption** (fallback teks).
- `plugins/removebg.js` — `!removebg`, POST multipart field `file`.
- `plugins/ping.js` — info server, RAM/RSS/heap dalam GB.

## Error-report ke owner (handler.js)
- `reportPluginError()` — dipanggil saat `plugin.run` gagal **dan** saat hook
  `plugin.all` melempar. Kirim ke semua `global.owner` (string atau array).
- `plugin.all` dijalankan untuk **setiap** pesan (termasuk tanpa teks), plugin
  `disabled` dilewati. `normalizePlugin` di `main.js` sekarang mempertahankan
  `all`, `disabled`, `autoReply`.
- Beda dari bot Baileys: tidak ada `conn.onWhatsApp()` di zapo → kirim langsung
  lewat `conn.message.send(jid, {type:'text'})`, JID dibuat dari nomor owner.

## Jebakan yang ketemu
- **Jangan pakai `node:sqlite` di plugin.** Percobaan awal List Store dengan
  `DatabaseSync` bikin plugin gagal load (`DatabaseSync is not defined`) dan
  variabel ganda (`admin has already been declared`). Versi final = JSON
  `global.db`, tanpa SQLite.
- **`m.quoted` tidak membawa `rawNode`** di `lib/simple.js` → download media
  quoted bergantung `downloadMediaMessage` atas proto aslinya. Voice note &
  pesan sekali lihat ditolak List Store.
- Router `handler.js` hanya memproses pesan ber-prefix; auto-reply List Store
  dipasang di listener `message` `main.js` + dipanggil di `handler.js`, bukan
  lewat jalur plugin biasa.
- Parser speedtest-cli: latency ada di baris `Hosted by ... [jarak]: <ms>`,
  **bukan** label `Latency:`. Label itu cuma fallback.

## Bukti verifikasi
- `handler.js`: mock 2 owner (string + array) → 2 kirim, JID ternormalisasi,
  isi laporan memuat nama plugin + stack. Lulus. Pengiriman nyata ke owner saat
  error **belum** dites lewat WhatsApp.
- `liststore.js`: CRUD, bentuk persistensi JSON, auto-reply + cooldown, guard
  admin, tipe pesan tak didukung → lulus (tes simulasi). Integrasi grup nyata &
  reply media **belum** dites.
- `lyrics.js`: API nyata `q=runtuh` → lulus. `ocr.js`: API nyata `input.jpg`
  (hasil baca snippet Python) → lulus. `speedtest.js`: PNG ~47 KB bercaption
  terkirim, `tmp/` bersih → lulus. `listgrup.js`: 6 skenario sintetik + hot
  reload → lulus.
- `node --check` untuk `handler.js`, `main.js`, `plugins/liststore.js`;
  `git diff --check` bersih; PM2 `wa-bot-zapo` online setelah restart.

---

# FIX LOG - deteksi event grup, buka/tutup grup, hapus pesan, readviewonce (2026-10-08)

## Fitur baru
- `lib/groupEvents.js` + `plugins/detect.js` — notifikasi event grup
  (welcome/goodbye/promote/demote/desc/subject/icon/revoke), config per grup
  di `global.db.data.settings` key `ge:<groupJid>` (persist, default ON).
  Command: `.detect on|off|status`, `.set <event> on|off|reset|text <teks>`.
- `plugins/group.js` — `!buka`/`!open`, `!tutup`/`!close` grup.
- `plugins/del.js` — `!del` reply pesan → hapus untuk semua orang.
- `plugins/rvo.js` — `!rvo`/`!readviewonce` reply pesan sekali lihat → media biasa.

## Koreksi dokumen EVENTGROUP.md (§10 minta spike dulu)
Hasil verifikasi dari type zapo (`dist/client/types.d.ts`), bukan asumsi:
- action deskripsi = **`description`**, bukan `desc`
- reset link = **`revoke_invite`**, bukan `invite`
- `WaPictureEvent` ada: `action` + `targetJid` + `authorJid`
Nama di config/command tetap `desc`/`revoke`; pemetaan di `ACTION_MAP`.
- `unwrapMessage` internal zapo TIDAK membuka `viewOnceMessageV2Extension` —
  `plugins/rvo.js` buka envelope sendiri (V1, V2, V2Extension, ephemeral,
  documentWithCaption).

## Catatan implementasi
- `!del` butuh `contextInfo.stanzaId` + `participant` (key pesan asli di grup).
  `m.quotedCtx` di-expose di `lib/simple.js`.
- Set grup buka/tutup = setSetting(chat, `'announcement'`, bool) — namanya
  `announcement`, bukan `announce` (itu nama field bacaannya).
- `main.js` wire `group` + `picture` + guard `offline_resume` (skip drain offline,
  abaikan event > 60 detik), antrean kirim per grup jeda 700ms, dedup TTL 10s.
- Multi-target = SATU pesan, semua peserta di-mention (§8).

## Bukti verifikasi
- groupEvents: 10 skenario template + 8 acceptance criteria lulus
  (add vs link, kick vs leave, dedup, detect off, set off, custom+reset,
  event bot sendiri diabaikan, multi-target 1 pesan 4 mention, persistensi).
- detect/set: 8 kasus (status, on/off, text/reset, event invalid, batas 500
  char, bantuan, chat pribadi ditolak + owner bypass).
- rvo: 10 unit + 5 integrasi lewat smsg (V1/V2/V2Extension/nested envelope,
  caption, audio, error) lulus.
- del/group: key revoke lengkap, alias, error API diteruskan.

---

# FIX LOG - m.quoted null saat reply ke gambar/video + fitur baru (2026-10-08)

## Gejala
`!meme` (dan `!iqc`) tidak bisa reply gambar — padahal sticker/tourl/hd jalan.

## Root cause (2 lapis)
1. **`lib/simple.js`**: `contextInfo` cuma dibaca dari `extendedTextMessage`.
   Reply ke gambar/video/sticker menyimpan `contextInfo` di tipe pesan itu —
   jadi `m.quoted` null. Fix: helper `getContextInfo()` scan semua key pesan
   (skip field `_` internal proto). Semua plugin yang pakai `m.quoted` ikut
   sembuh sekaligus.
2. **`plugins/meme.js` & `plugins/iqc.js`**: kirim `msg` (wrapper
   `{message, sender}`) ke `downloadMedia()` — harusnya `msg.message`.

## Fitur baru sejak commit terakhir
- `plugins/brat.js` — `!brat`/`!bratvid`: sticker brat (statis/animasi).
  API `brat.siputzx.my.id` (`/image` → PNG, `/mp4` → WebP ANIM;
  `emojiStyle=apple` wajib — `google` balas JSON error dengan HTTP 200,
  jadi respons dicek lewat magic bytes, bukan status HTTP).
- `plugins/iqc.js` — `!iqc`: iPhone quoted chat; `imageUrl` opsional
  (harus DIHILANGKAN, `null` bikin API 500; `sender` wajib `"other"`).
- `plugins/meme.js` — `!meme`/`!smeme`: sticker meme (teks atas|bawah);
  hasil dikirim sebagai sticker via writeExif.
- `plugins/translate.js` — `!tr [kode] <teks>` / reply: target default `id`.
- `plugins/sticker.js` — `!tovideo`/`!tovid`/`!tomp4`: sticker animasi → MP4.
- `lib/webpAnim.js` — ffmpeg 5.1 container TIDAK bisa dekode WebP ANIM
  (`loop_count=0xffffffff`, "image data not found"; `-loop 1` malah hang).
  Solusi: node-webpmux ekstrak tiap frame (`vp8.raw`), bungkus webp statis
  per frame, gabung ffmpeg concat dengan durasi asli tiap frame.
- `lib/mediaProcessor.js` — helper `downloadMedia()` (timeout 120s, default
  zapo 30s bikin "transfer timed out" di koneksi lambat) + `acquireFfmpegSlot`
  diekspor; 5 plugin pakai helper, `streamToBuffer` duplikat dibuang.
- `plugins/menu.js` — link preview custom: field `linkPreview` di **content**
  teks (API native zapo, bukan send options); URL + 400 ZWSP biar link
  invisible; thumbnail di-resize sharp ke ≤64KB (batas inline WA).
- `m.pushname` di-expose di `smsg()`; default pack sticker "Created by" +
  pushname + tanggal.
- Test per fitur: test-brat/iqc/meme/menu/translate/tovideo/quoted/reply/
  pushname/sticker.js (semua `node test-*.js`).

---

# FIX LOG - akses owner gagal untuk JID LID (2026-10-07)

## Gejala
Nomor yang sudah terdaftar di `global.owner` (config.js) tidak bisa memakai
perintah owner-only (`!self`, `!listjadibot`, `!bcgc`, `!exec`), sementara
nomor bot sendiri bisa. Tidak ada error di log — handler cuma balas
"Perintah ini hanya untuk *Owner*!".

## Root cause
WhatsApp meng-address pengirim dalam dua bentuk: PN (`628xxx@s.whatsapp.net`)
atau LID (`1234567890123456@lid`). Database bot penuh key `@lid`, jadi sender
memang datang sebagai LID.

`handler.js` membandingkan `normalize(m.sender)` dengan `global.owner`. Untuk
sender LID, `normalize()` menghasilkan **nomor LID**, bukan nomor HP — jadi
`global.owner.includes()` tidak pernah cocok. Nomor bot lolos karena jalur
`m.fromMe` di-short-circuit, bukan karena cocok nomor.

## Fix (2 file, akar masalah bukan gejala)
1. `lib/simple.js` — zapo-js menyertakan sisi lain dari tiap JID di
   `key.participantAlt` (grup) dan `key.remoteJidAlt` (1:1). `smsg()` sekarang
   menyimpan pasangan LID → nomor HP ke `global.lidCache` dari situ. Tersedia
   di **setiap** pesan, jadi tidak perlu nunggu metadata grup (yang sebelumnya
   jadi satu-satunya pengisi cache, dan gagal untuk chat pribadi).
2. `handler.js` — resolve `m.sender` lewat `global.lidCache` sebelum cek owner:
   ```js
   let senderNum = normalize(m.sender)
   let senderPhone = global.lidCache?.[senderNum] || senderNum
   let isOwner = m.fromMe || global.owner.some(o => normalize(o) === senderPhone)
   ```

Sengaja **tidak** bikin mapping sendiri: zapo-js sudah punya
`SignalDeviceSyncApi.resolveUserJidPair()` + `WaDeviceListSnapshot.altUserJid`
untuk ini, tapi `WaClient.stores` private dan tidak ada accessor publiknya.
`*Alt` di message key adalah sumber publik yang setara.

## Bukti verifikasi
`node test-owner.js` — 7 assert, semua lulus:
- grup: participant LID + participantAlt PN → owner ✅
- grup: participant PN + participantAlt LID → owner ✅
- DM: sender LID + remoteJidAlt PN → owner ✅
- LID orang lain → bukan owner ✅ (tidak over-permissive)
- tanpa alt sama sekali → tidak crash, perilaku lama ✅
- `fromMe` → owner ✅
- nomor HP tidak pernah dijadikan key lid (arah tidak terbalik) ✅

Belum diuji end-to-end dari WhatsApp — jalankan `!self` dari nomor owner
untuk konfirmasi akhir.

## Catatan
- Nomor di `global.owner` harus format digit bersih (hanya angka). `normalize()`
  cuma buang `@domain` dan `:device` — tidak buang `+`, spasi, atau `-`.

---

# FIX LOG - zapo-js pairing tidak bisa (2026-10-07)

## Gejala
`node main.js` menampilkan "Masukkan nomor WhatsApp" terus, atau kode pairing muncul
tapi pairing tidak pernah selesai. PM2 app `wa-bot-zapo` hilang, `node_modules` kosong.

## Root cause (3 lapis)

### 1. node_modules hilang + better-sqlite3 gagal compile
`npm install` gagal exit 134 (SIGABRT) di better-sqlite3 (node-gyp rebuild).
node_modules tak pernah selesai -> `Cannot find module 'chalk'` -> bot tidak boot.

Fix: drop better-sqlite3; pakai driver bawaan node:sqlite (Node 22.13+, tanpa native build):
`createSqliteStore({ path: '.auth/state.sqlite', driver: 'node' })`

### 2. Kode pairing di-mint ulang tiap reconnect (loop)
Handler `connection: close` set `pairingRequested = false`. `auth_qr` fire ulang
(QR rotate ~20-60s) -> `requestPairingCode()` dipanggil lagi -> kode BARU, sementara
user sedang mengetik kode lama -> zapo `handlePrimaryHello` menolak
("primary_hello ref mismatch ignored") -> putus -> mint lagi -> loop selamanya.

Fix: mint sekali. Patokan state zapo sendiri (`getState().hasPairingCode`) + TTL 170s
(< `PAIRING_CODE_MAX_AGE_SECONDS` 180). Hapus `pairingRequested = false` di handler close.

### 3. Nomor pairing tidak ada sumbernya
`PHONE_NUMBER` hanya dari env; kosong -> block stdin (headless/PM2 tak bisa input).

Fix (SEMULA): fallback ke `global.owner[0]` dari config.js.

**KOREKSI (commit f8c20ec):** fallback itu SALAH. `global.owner` = nomor
user yang boleh kontrol bot, BUKAN nomor bot yang di-pairing. Kalau bot
dipairing ke nomor owner milik orang lain, sesi bot tersambung ke akun
WhatsApp orang itu — owner bisa kirim pesan sebagai bot dari akun tersebut.
Jadi fallback DIHAPUS. Sumber nomor bot yang benar, berurutan:
1. env `PHONE_NUMBER` (isi manual: `PHONE_NUMBER=628xxx npm start`)
2. prompt interaktif `askPhone()` — hanya jalan kalau ada TTY; di PM2/headless
   tidak ada stdin sehingga bot diam saja (ini SADAR, bukan bug)

`PHONE_NUMBER` yang ada tapi ga valid (<10 digit) -> stop dengan pesan jelas,
bukan diam-diam jatuh ke prompt. Nomor bisa ditulis format bebas
(`+62 812-3456-7890`) lalu dinormalisasi ke `6281234567890`.

## Bukti verifikasi
- Probe standalone: kode terbit 1.1s, `connect() RESOLVED`, tanpa error
  -> library & transport OK, bug memang di orkestrasi bot.
- `node main.js` fresh `.auth`: kode `QEXQ-MRF4` terbit SEKALI, lalu
  `Pairing berhasil -> 62895401438129:84@s.whatsapp.net`.
- Session persisten: `me_jid` terisi di `auth_credentials` (sebelumnya `None`).
- Restart tanpa `rm -rf .auth`: `Terhubung ke WhatsApp!` + pesan grup nyata masuk
  -> tidak pairing ulang.
- PM2 `wa-bot-zapo:13` online; error log run baru hanya warning phash metadata
  (`ackError: undefined` = pesan tetap terkirim), bukan crash.

## Perubahan file
- `main.js`: driver `node`, mint kode sekali + guard `hasPairingCode`, handler
  `auth_passkey_required`, log `auth_pairing_code`.
- `main.js` (f8c20ec): hapus fallback `global.owner`; `normalizePhone()`; validasi
  env `PHONE_NUMBER`.
- `package.json`: `zapo-js` `^1.9.0`, `@zapo-js/store-sqlite` `^1.3.0`, hapus `better-sqlite3`.

---

# FIX LOG - preview video blank abu-abu (commit cd25e36)

## Gejala
Thumbnail/preview video di WhatsApp abu-abu. Fix sebelumnya (commit
`10ad874`) Wiring `mediaProcessor` seemed to fix gambar saja — video tetap
abu-abu.

## Root cause (2 lapis, bukan 1)

### 1. `ffmpeg(buffer)` — thumbnail video SELALU null
`fluent-ffmpeg` hanya terima **path file** atau stream. Kalau diberi Buffer dia
lempah `Error: No input specified` secara **sync** di dalam `.then()`, jadi
langsung ketangkap `.catch()` -> `resolve(null)`. Tidak ada error di log.
Dampaknya: `jpegThumbnail` nggak pernah ada, WhatsApp render abu-abu.

Bukti: sebelum fix, `dark-first.mp4` dan `normal.mp4` dua-duanya `NULL`.

Fix: tulis buffer ke temp file (`fs.mkdtempSync`), ffmpeg baca dari path,
temp dihapus di `finally`. `probeMedia` suffers bug yang sama (`ffprobe` juga
perlu path) — ikut dibenerin.

### 2. Ambil frame 0 -> thumbnail hitam
`-frames:v 1` tanpa seek ambil frame pertama. Video yang buka dengan
fade-in/hitam dapat thumbnail gelap. Bukti: video 1s hitam + 3s testsrc ->
frame 0 brightness 0, frame 1s brightness 127.

Fix: `-ss 1`. Kalau video < 1s, retry dari frame 0 (3gp pendek, dll).

## Tambahan (penting)
- Validasi magic bytes JPEG `ffd8ff` + min 100 byte, jangan masukin output
  setengah jadi.
- **Limiter 2 ffmpeg konkuren.** Di container dengan `cpu.max=2` (verified via
  `/sys/fs/cgroup/cpu.max` = `200000 100000`), 4 proses ffmpeg paralel bikin
  stalling — proses spin tanpa keluar, `pipe()` nggak pernah emit `end`.
  Terverifikasi juga CLI murni tanpa involvement kode, jadi murni limit
  container, bukan bug. `MAX_FFMPEG_CONCURRENT = 2` + antrian.

## Bukti verifikasi (semua via fungsi, bukan e2e WhatsApp)
| Input | Thumbnail | probeMedia |
|---|---|---|
| frame gelap (0s hitam) | 1593b, bright 127 | 640x360, 4s |
| normal mp4 | 1618b, bright 127 | 640x360, 3s |
| pendek 0.4s | 1594b (retry frame 0) | ok |
| portrait | 1752b | 360x640 |
| rotasi 90deg | 1611b | 360x640 |
| .3gp | 2151b | ok |
| .webm | 1620b | ok |
| audio-only | NULL (benar) | 2s |
| file korup | NULL (benar) | {} |
| 8x paralel | semua ok | semua ok |
| 3x video 3.1MB | semua ok, RSS 34MB | — |

Sisa temp file: 0 di semua skenario.

## Catatan operasional
- `width`/`height` di return thumbnail video masih `0` (probe yang supplying
  dimensi ke zapo). Kalau preview masih abu-abu setelah fix ini, kemungkinan
  masalahnya aspect ratio dari `width`/`height`, bukan thumbnail — kasus
  berbeda, perlu test end-to-end di WhatsApp dulu.
- Fix ini belum diuji end-to-end dari sisi client WhatsApp (hanya unit-level
  via fungsi + ukur brightness). Verifikasi terakhir: kirim video dari
  WhatsApp, cek preview.

## Catatan operasional (pairing, dari entri di atas)
- Pairing code berlaku ~180s - masukkan cepat.
- Kalau server minta passkey (Shortcake), log tampil "Server minta passkey"
  `hasSigner=false`; jalur pairing-code tak bisa selesai headless tanpa
  `signPasskeyAssertion`. Belum terjadi di sesi ini.
- Jangan `rm -rf .auth` setelah paired - sesi hilang, harus pairing ulang.

---

# FIX LOG - tovideo gagal FFmpeg thread limit (2026-10-10)

## Gejala
`!tovideo` / `.tovideo` → Error:  
`ffmpeg exited with code 1: Error initializing output stream 0:0`  
atau  
`Resource temporarily unavailable` saat spawn FFmpeg.

## Root cause
Container cgroup pids.limit=512 (`/sys/fs/cgroup/pids.current`=500), FFmpeg
tidak bisa spawn worker thread. Sharp `toFile()` dengan raw VP8 buffer butuh
decode internal → FFmpeg concurrent spawn fail.

## Fix
Pindah ke **ezgif.com/webp-to-mp4 API** (external service) untuk konversi:
1. Ekstrak frame WebP via `node-webpmux` (tanpa FFmpeg local)
2. Upload ke `https://ezgif.com/webp-to-mp4` dengan FormData
3. Parse HTML response via JSDOM, ekstrak URL hasil konversi
4. Return MP4 URL ke caller

Benefit: tidak ada spawn lokal → bypass cgroup limitation sepenuhnya.

## Perubahan file
- `lib/webpAnim.js`: replace `webpAnimToMp4()` implementation → gunakan ezgif.com
  API dengan JSDOM parsing
- `plugins/sticker.js`: import `JSDOM` + `webp2mp4()` helper (sudah ada sebelumnya)

## Bukti verifikasi
- Bot restart: connected to WhatsApp ✓
- Syntax check: `node --check lib/webpAnim.js` OK ✓
- Plugin hot-reload: sticker.js loaded ✓
- Cgroup check: pids.current≈500 (limit full) ✓

→ Test end-to-end tunggu user submit sticker animasi untuk konfirmasi


---

# Fix: plugin postch / sendch (posting ke Channel WA)

## Masalah
Plugin template kiriman (ESM) tidak kompatibel dengan struktur repo:
- Repo punya loader CJS (`main.js normalizePlugin`): `module.exports = { name, command, aliases, permissions, run }`, `run: async (m, { conn, text, usedPrefix })`.
- Template pakai `ctx.message/ctx.event/ctx.client/ctx.react/ctx.reply` dan `ctx.client.message.upload()` untuk build proto manual — API itu tidak ada di wrapper repo ini.
- Upload manual proto `{ videoMessage: {...spread uploaded} }` untuk channel tidak perlu: `conn.newsletter.send()` (zapo-js) menerima bentuk `WaSendMediaMessage` dan mengurus upload plaintext ke CDN newsletter sendiri lewat `buildNewsletterMessageContent` (metadata url/directPath/fileSha256 diisi internal; `caption` di level content, bukan di proto).

## Perubahan file
- `plugins/postch.js` (baru): `command: /^(postch|sendch|upch)$/i`, ownerOnly.
  - CHANNEL_JID = `120363420643650987@newsletter`.
  - Text: `conn.newsletter.send(JID, { type:'text', text })`.
  - Media reply (pakai `resolveMediaPayload` + `downloadMediaMessage`):
    - audio/ptt → convert opus (libusb ffmpeg) `{ type:'audio', ptt:true, mimetype:'audio/ogg; codecs=opus' }` → voice note.
    - video/gif/ptv → `{ type:'video'|'ptv', gifPlayback }` + thumbnail ffmpeg frame-1 → sharp 72px (fallback jpegThumbnail pesan asli; thumbnail gagal = skip, bukan gagal kirim).
    - image → sharp JPEG q90 + thumb 64px.
    - document → `{ type:'document', fileName }`.
    - sticker → `image/webp`.
  - Bukan media → teks gabungan (caption + teks pesan yang di-reply).
  - React ⏳/✅/❎ via `conn.message.send(m.chat, { type:'reaction', emoji, target:m })`.

## Bukti verifikasi
- `node --check plugins/postch.js` → OK.
- `node -e require` → name/aliases/command regex match postch|sendch|upch, `run: function`.
- Zap0 API check: `downloadMediaMessage` & `resolveMediaPayload` ter-eksport; `conn.newsletter.send` ada di `WaNewsletterMessagingOps` (dist/client/newsletter/messaging.d.ts).
- Hot reload: `logs/out.log` 20:33:24 & 20:33:51 `♻️ Reload plugin 'postch.js'` tanpa syntax error (error 20:32:51 'format tidak dikenali' hanya karena watcher fire saat file setengah tertulis).
- Bot tetap online (pm2 Reze-MD up 2h).

→ Test end-to-end: kirim `.postch <teks>` / reply media ke bot dari nomor owner.
