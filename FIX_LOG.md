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
