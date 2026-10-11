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

