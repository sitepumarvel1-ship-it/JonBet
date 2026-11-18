# JonBet

Analisis dan prediksi pertandingan untuk 12 cabang olahraga (sepak bola, futsal, basket, football Amerika, baseball, rugby, hoki es, tenis, bulu tangkis, voli, esports, MMA), baik yang akan datang maupun yang sedang live. Aplikasi web progresif (PWA): bisa dipasang di iPhone dan Android, dan hanya berjalan saat online.

Ada dua cara menjalankannya:

- **GitHub Pages (tanpa server, gratis)**: seluruhnya di GitHub. Jadwal disegarkan GitHub Actions tiap ±5 menit, skor live diambil langsung dari ESPN oleh browser tiap ±20 detik (bila liganya tersedia); model dan JonBet AI berjalan di browser; tebakan tersimpan di perangkat. Panduan: [docs/DEPLOY.md](docs/DEPLOY.md).
- **Server Node.js**: akun sungguhan dan komunitas bersama, butuh hosting Node 22 dengan disk persisten.

Tidak ada taruhan, odds, atau uang di JonBet. Poin komunitas hanya reputasi.

## Menjalankan

Butuh Node.js 22.13 atau lebih baru. Tanpa dependensi npm.

```bash
npm run preview:pages  # versi GitHub Pages, data simulasi: http://localhost:8080/jonbet/
npm run demo           # versi server, data simulasi: http://localhost:3000
npm start              # versi server, data nyata dari ESPN + TheSportsDB (lihat "Sumber data")
npm test               # 146 tes: backend, model, keamanan, build Pages, sumber data ESPN, skor langsung, fuzz
npm run check          # periksa sintaks semua berkas JS
npm run test:ui        # uji browser versi server; butuh Google Chrome dan: npm i --no-save playwright-core
npm run test:ui:static # uji browser versi GitHub Pages di subfolder /jonbet/
npm run build:pages    # bangun situs statis ke dist/ (dipakai alur kerja Pages)
```

`npm run demo` dan `preview:pages` jalan di Windows, macOS, dan Linux. Untuk uji UI, bila Chrome tidak di `/usr/bin/google-chrome`, set `CHROME_PATH`.

Tes bisa dijalankan dengan jam palsu untuk menangkap bug yang bergantung waktu: `JB_NOW=2026-12-31T23:59:30Z npm test`.

## Memasang di ponsel

PWA hanya bisa dipasang lewat **HTTPS** (kecuali `localhost`). Setelah diterbitkan:

- iPhone: buka di Safari, Bagikan, **Tambah ke Layar Utama**.
- Android: buka di Chrome, menu, **Pasang aplikasi** (atau tombol "Pasang" di header).

## Versi GitHub Pages

- `.github/workflows/pages.yml`: tiap ±5 menit dan tiap push ke `main`, menjalankan `scripts/build-pages.mjs`: mengambil jadwal dan hasil, memperbarui rating Elo, menghitung analisis tiap laga, menulis berkas `data/*.json`, lalu menerbitkan ke GitHub Pages. State (database rating, cache permintaan, data terakhir) dibawa antar build lewat cache Actions.
- Di browser: `public/js/static/` membaca berkas data itu, menyaring daftar laga, menjalankan JonBet AI (`server/ai/explainer.js` disalin ke build), dan menyimpan tebakan di `localStorage`. Mode statis aktif hanya bila `index.html` hasil build memuat `<meta name="jonbet-mode" content="static">`.
- Skor langsung: `public/js/static/espn.js` (peta liga ke papan skor ESPN, pencocokan nama tim, jam/babak per cabang) dan `live.js` (pemantau: memilih laga, bertanya tiap ±20 detik hanya saat tab terlihat, mundur bertahap bila gagal, menimpa skor dan menghitung ulang peluang dengan `js/shared/model`). Laga yang tidak ditemukan di ESPN tetap dari snapshot dan ditandai begitu di halaman laga. CSP hanya mengizinkan `site.api.espn.com` untuk koneksi keluar, dan hanya pada build Pages.
- Semua alamat relatif, sehingga jalan di subfolder (`github.io/nama-repo/`).
- Bila pengambilan data gagal, situs memakai data terakhir yang berhasil dan menandainya "Data tertunda"; bila belum pernah berhasil, data simulasi berlabel jelas.
- Komunitas lokal: tanpa server dan tanpa kata sandi. Aturan poin sama dengan versi server (diuji dengan 600 kasus acak yang dibandingkan langsung dengan kode server).

Panduan langkah demi langkah, pengaturan opsional, dan batasannya: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Konfigurasi versi server (variabel lingkungan)

| Variabel | Bawaan | Fungsi |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Alamat server |
| `DB_PATH` | `data/jonbet.db` | Berkas SQLite (akun, tebakan, rating model). Taruh di disk yang awet |
| `PROVIDER` | `auto` | `auto` (ESPN + TheSportsDB), `espn`, `thesportsdb`, atau `demo` (juga dibaca `build:pages`) |
| `THESPORTSDB_KEY` | `3` | Kunci gratis (`3`). Kunci premium membuka skor live (juga dibaca `build:pages`) |
| `FALLBACK_DEMO` | `true` | Bila sumber nyata gagal total dan belum ada data, tampilkan data demo (dengan label jelas) |
| `ANTHROPIC_API_KEY` | kosong | Opsional. Bila diisi, JonBet AI dijawab Claude dari data analisis. Tidak tersedia di versi GitHub Pages (kunci tidak bisa dirahasiakan di situs statis) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model untuk Claude |
| `ALLOWED_ORIGINS` | kosong | Daftar asal tambahan (dipisah koma) yang boleh mengirim permintaan penulisan, bila tampilan disajikan dari domain lain daripada server |
| `TRUST_PROXY` | `false` | `true` bila di belakang proxy/CDN (membaca `X-Forwarded-*`) |
| `COOKIE_SECURE` | `false` | `true` di produksi HTTPS (otomatis aktif lewat `X-Forwarded-Proto: https` bila `TRUST_PROXY=true`) |
| `RATE_LIMIT`, `AUTH_RATE_LIMIT`, `AI_RATE_LIMIT` | `240`, `12`, `20` | Batas permintaan per menit per IP |

Menjalankan sebagai server sungguhan:

```bash
PROVIDER=auto TRUST_PROXY=true COOKIE_SECURE=true DB_PATH=/data/jonbet.db PORT=8080 npm start
```

Taruh di belakang HTTPS. Jalankan satu instance saja: pembatas laju dan penguncian login disimpan di memori proses, dan SQLite butuh disk yang awet.

## Sumber data

- **ESPN** (papan skor publik, tidak resmi; `server/providers/espn.js`): jadwal, hasil, dan status live liga-liga besar sepak bola, basket, football Amerika, baseball, hoki es. Satu permintaan rentang tanggal per liga, tanpa kunci. Sumber utama pada mode `auto`.
- **TheSportsDB** (`server/providers/thesportsdb.js`): pelengkap untuk cabang yang tidak dicakup ESPN. Kunci gratis dibatasi (menurut dokumentasi pihak ketiga hanya ±5 laga per hari per liga) dan status "live" bisa terlambat; kunci premium (`THESPORTSDB_KEY`) membukanya. Data hasil kontribusi komunitas, sertakan atribusi bila dipublikasikan.
- **Gabungan** (`server/providers/composite.js`): laga yang sama dari dua sumber hanya tampil sekali (versi ESPN). Satu sumber gagal, yang lain tetap dipakai.
- Rating Elo dibangun dari ±60 hari hasil ESPN pada build pertama, lalu terus belajar. Laga yang sama dari dua sumber tidak dihitung dua kali.
- **Demo**: liga dan tim fiktif yang dibangkitkan deterministik, selalu ada laga live. Dipakai untuk mencoba aplikasi dan untuk tes.
- Bila sumber nyata gagal: tampil data terakhir yang berhasil (ditandai "Data tertunda"), lalu data demo bila belum ada apa pun (ditandai di header).

## Cara kerja model

Setiap tim punya rating Elo yang belajar dari hasil pertandingan (idempoten, per cabang). Tiga keluarga model:

- **Poisson + koreksi Dixon-Coles** untuk olahraga berskor rendah (sepak bola, futsal, hoki es): matriks skor, over/under, kedua tim mencetak gol.
- **Selisih poin (normal)** untuk olahraga berskor tinggi (basket, football Amerika, baseball, rugby).
- **Versus / best-of-N** untuk tenis, bulu tangkis, voli, esports, MMA: peluang set dari peluang laga, lalu distribusi skor set.

Untuk laga live, peluang dihitung ulang dari skor dan sisa waktu. Skor keyakinan menggabungkan kecukupan data dan kejelasan selisih. Rekam jejak model (akurasi, Brier) dicatat dengan uji walk-forward dan ditampilkan di halaman "Cara kerja dan batasan".

## Keamanan

Versi server: kata sandi di-hash scrypt; token sesi disimpan sebagai SHA-256 dalam cookie `HttpOnly` + `SameSite=Lax`; pemeriksaan `Origin` untuk semua permintaan yang mengubah data; CSP ketat lewat header (tanpa inline script/style); batas laju per IP; batas ukuran isi.

Versi GitHub Pages: tidak ada akun dan tidak ada data pengguna di server. CSP yang sama dipasang lewat `<meta>` (tanpa `frame-ancestors`, karena Pages tidak bisa memasang header). Profil lokal tanpa kata sandi.

Di kedua versi, semua teks dari pengguna dan sumber luar dirender sebagai teks, bukan HTML.

## Batasan yang jujur

- Adapter ESPN dan TheSportsDB **belum diuji terhadap layanan aslinya** (lingkungan pengembangan tidak punya akses ke sana). Diuji dengan fixture berbentuk JSON kedua layanan dan simulasi gangguan. Daftar liga ESPN (`public/js/static/espn.js`) ditulis dari dokumentasi pihak ketiga; hanya sebagian slug yang sempat diverifikasi. Setelah build pertama, periksa `data/meta.json` (bagian `sources`): jumlah liga yang merespons dan yang gagal.
- Alur kerja GitHub Actions dan penerbitan ke GitHub Pages **belum pernah dijalankan di GitHub sungguhan**. Skrip build, situs, dan uji browser di subfolder sudah diuji berulang dengan sumber data tiruan.
- Versi GitHub Pages tidak seketika: jadwal disegarkan berkala oleh Actions (paling cepat 5 menit, sering telat; dimatikan GitHub setelah 60 hari tanpa aktivitas). Skor live langsung dari ESPN hanya untuk liga yang tersedia di sana, hanya saat situs terbuka, dan bergantung pada API ESPN yang tidak resmi. Laga lain bisa terlambat beberapa menit. Tebakan hanya di perangkat.
- Pencocokan ESPN **belum diuji ke ESPN sungguhan** (tanpa akses internet di lingkungan pengembangan): diuji dengan respons tiruan berbentuk JSON ESPN, dan dengan pasangan nama tim yang umum. Nama tim yang sangat berbeda tidak dicocokkan, dengan sengaja.
- Data demo adalah simulasi. Akurasi model pada data demo bersifat sirkular dan diberi label "data simulasi". Akurasi pada data nyata baru terlihat setelah aplikasi berjalan beberapa waktu.
- Model memberi **peluang, bukan jaminan**. Cedera, susunan pemain, cuaca, dan motivasi tidak dihitung.
- JonBet AI bawaan menjelaskan angka model dengan aturan tetap (bukan model bahasa). Claude hanya dipakai di versi server bila `ANTHROPIC_API_KEY` diisi, dan hanya diberi data analisis.
- Tes otomatis banyak dan berulang, tetapi tidak ada yang bisa menjamin nol bug.
- Judi online dilarang di Indonesia; JonBet sengaja tidak memiliki fitur taruhan.
