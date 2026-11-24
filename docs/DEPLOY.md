# Pasang JonBet di GitHub Pages

Hasil akhirnya: JonBet bisa dibuka di `https://USERNAME.github.io/jonbet/`, dipasang di iPhone dan Android, tanpa server lain dan tanpa biaya. Semuanya berjalan di GitHub.

## Cara kerjanya

GitHub Pages hanya menyajikan berkas statis dan tidak bisa menjalankan server. Karena itu JonBet versi ini bekerja begini:

```
GitHub Actions (tiap ±5 menit)           Browser kamu
  ambil jadwal, hasil, status dari ESPN    baca berkas data dari situs yang sama
  (+ TheSportsDB untuk cabang lain)
  perbarui rating Elo, hitung analisis     skor live: tanya ESPN langsung tiap ±20 detik
  tulis berkas data (JSON)                 hitung ulang peluang live, jalankan JonBet AI
  terbitkan ke GitHub Pages                simpan tebakan di perangkat
```

Yang sama dengan versi server: jadwal, prediksi, analisis, grafik, JonBet AI, PWA (bisa dipasang), mode "butuh internet".

Yang berbeda, dan perlu kamu tahu:

| | Versi GitHub Pages |
|---|---|
| Jadwal dan hasil | Disegarkan tiap ±5 menit (batas tercepat GitHub), sering telat 5 sampai 20 menit. Jam data terakhir tampil di pojok atas |
| Skor live | Untuk liga yang tersedia di ESPN: diambil langsung dari browser tiap ±20 detik (lihat "Skor live langsung" di bawah). Laga lain: ikut jadwal di atas, jadi bisa terlambat beberapa menit |
| Akun | Tidak ada akun sungguhan. "Profil" hanya nama panggilan tanpa kata sandi di browser perangkat itu |
| Komunitas | Tebakan, poin, dan peringkat hanya ada di perangkat itu. Tidak ada tebakan bersama antar pengguna |
| Cakupan data | 2 hari ke belakang sampai 5 hari ke depan. Hasil ±60 hari ke belakang (sepak bola, basket, football Amerika, baseball, hoki es) dipakai sebagai bahan belajar model |

Kalau suatu saat butuh komunitas bersama sungguhan (akun, tebakan terlihat semua orang), JonBet tetap bisa dijalankan sebagai server Node.js (`npm start`) di layanan hosting yang mendukung Node 22 dan disk persisten. Itu di luar panduan ini.

## Sumber data: dari mana liga, tim, dan skornya

Tidak ada data fiktif kecuali bila kamu sengaja memilih `demo`, atau bila build pertama gagal total (lihat di bawah). Mode bawaan `auto` memakai tiga lapis sumber (urutan prioritas ESPN, API publik, TheSportsDB):

| Sumber | Dipakai untuk | Catatan |
|---|---|---|
| **ESPN** (papan skor publik, tidak resmi) | Sepak bola di liga-liga besar dunia, basket (NBA, WNBA, NCAA), football Amerika (NFL, NCAA, CFL), baseball (MLB), hoki es (NHL), tenis (ATP dan WTA, set demi set) dan rugby (liga ditemukan otomatis): jadwal, hasil, status live | Satu permintaan per liga per build mengambil seluruh rentang tanggal, jadi datanya lengkap. Tersedia tanpa kunci |
| **API publik tanpa kunci** (OpenLigaDB, MLB Stats API, NHL) | Bundesliga 1-3 dan DFB-Pokal (OpenLigaDB), baseball bertingkat lewat MLB Stats API (MLB, MiLB Triple-A sampai Rookie, liga musim dingin, kampus, NPB, KBO, internasional), hoki es NHL | Lapisan pelengkap dan cadangan: menambah laga yang tidak ada di ESPN dan menggantikan ESPN bila ESPN gagal untuk liga itu. Tanpa kunci. Tiap sumber berdiri sendiri: satu mati tidak menggagalkan yang lain, dan statusnya tercatat di `meta.json` (`sources.public`). Sebagian besar liga ini juga ada di ESPN, jadi manfaat utamanya ketahanan, bukan banyak laga baru |
| **TheSportsDB** | Cabang yang tidak dicakup ESPN (bulu tangkis, voli, esports, MMA, futsal, serta tenis dan rugby di luar ESPN) dan liga sepak bola yang tidak ada di ESPN | Hasil kontribusi komunitas. Kunci gratis dibatasi: menurut dokumentasi pihak ketiga hanya sekitar 5 laga per hari per liga, jadi datanya tipis. Kunci premium membukanya penuh |

Laga yang sama dari beberapa sumber hanya tampil sekali (versi sumber berprioritas lebih tinggi dipakai). Bila satu sumber gagal, yang lain tetap dipakai; bila semuanya gagal, situs memakai data terakhir yang berhasil ("Data tertunda").

**Prediksi** dihitung dari rating Elo yang dibangun dari hasil nyata: build pertama mengambil ±60 hari hasil ESPN (sekitar 200 permintaan satu kali saja), lalu rating terus belajar tiap build. Model hanya memakai hasil historis, jadi tim yang jarang terlihat punya skor keyakinan rendah. Ini perkiraan statistik, bukan jaminan, dan akurasinya baru bisa dinilai setelah beberapa minggu berjalan (lihat "Rekam jejak model" di halaman Cara kerja).

**Cara memeriksa sumber mana yang bekerja** (tanpa membaca log): buka `https://USERNAME.github.io/jonbet/data/meta.json`. Bagian `sources` memuat jumlah liga ESPN yang merespons (`espn.ok` dari `espn.leagues`), daftar liga yang gagal (`espn.failed`), jumlah laga dan status tiap API publik (`public.openligadb`, `public.mlb`, `public.nhl`: `ok` atau pesan galat), dan jumlah permintaan TheSportsDB. Log build di tab Actions memuat ringkasan yang sama ("ESPN: N dari M liga merespons").

Yang perlu kamu tahu:

- **ESPN tidak menyediakan API resmi.** Penamaan liga (slug) di `public/js/static/espn.js` ditulis dari dokumentasi pihak ketiga dan hanya sebagian yang sempat saya verifikasi lewat pencarian; sisanya belum. Liga yang slug-nya salah muncul sebagai "gagal" di `meta.json` dan dilewati, tidak merusak yang lain. Periksa ketentuan penggunaan ESPN untuk pemakaian publikasimu.
- **Bentuk permintaan ke ESPN.** ESPN tidak punya dokumentasi resmi dan tidak semua bentuk permintaan diterima. Build pertama di GitHub menunjukkan `?dates=A-B&limit=1000` ditolak dengan HTTP 400 pada liga sepak bola. Karena itu pembaca ESPN mencoba tiga bentuk berurutan dan memakai yang diterima: (1) rentang tanggal + limit, (2) rentang tanpa limit, (3) satu hari per permintaan. Bentuk yang dipakai tercatat di `meta.json` (`sources.espn.mode`: `range`, `range-nolimit`, atau `days`) dan di log ("ESPN: ... beralih ke mode ..."). Bila rentang diterima tetapi hanya mengembalikan satu tanggal, jadwal diambil per hari (`rangeSuspect`).
- **Mode `days` lebih boros.** Riwayat 60 hari untuk rating menjadi ±2.500 permintaan satu kali (dilanjutkan di build berikutnya bila waktu 8 menit habis). Untuk jadwal rutin, balasan liga yang sedang libur disimpan 2 jam, jadwal 2+ hari ke depan 1 jam, dan hasil 2-4 hari lalu 12 jam, sehingga tiap build biasanya hanya menanyakan beberapa puluh permintaan, bukan ratusan.
- **Beban:** tiap build (±5 menit) membuat sekitar 40 permintaan ke ESPN dari server GitHub, ditambah sekitar 200 sekali jalan untuk riwayat. Jika ESPN membatasi, situs jatuh ke TheSportsDB dan data lama; jangan menurunkan jeda build tanpa alasan.
- **Belum diuji ke ESPN sungguhan.** Lingkungan pengembangan saya tidak punya akses internet, jadi seluruh pembacaan diuji dengan respons tiruan berbentuk JSON ESPN. Bila `espn.ok` di `meta.json` bernilai 0 setelah build pertama, kirim baris galat dari log langkah "Bangun situs".

## Skor live langsung (ESPN)

GitHub Actions tidak bisa lebih cepat dari 5 menit dan sering telat, jadi skor live tidak mungkin "tanpa terlambat" kalau hanya lewat build. Karena itu browser pengunjung menanyakan skor langsung ke ESPN, dan hanya untuk laga yang sedang atau hampir berlangsung:

1. Browser memilih laga yang live di data jadwal (atau mulai dalam 20 menit), dan liga mana yang perlu ditanya.
2. Tiap ±20 detik (hanya saat tab terlihat dan online) browser mengambil papan skor liga itu dari ESPN, lalu mencocokkan laganya lewat nama kedua tim dan jam mulai. Bila ada keraguan (dua kandidat sama baiknya), laga itu tidak ditimpa. Lebih baik tanpa skor langsung daripada salah laga.
3. Skor, menit/babak, dan status ditimpa, lalu peluang dihitung ulang di browser dengan model yang sama dengan build. JonBet AI ikut menjawab dari skor terkini.
4. Pojok atas bertuliskan "Skor langsung" bila sumbernya sehat. Di halaman tiap laga live tertulis skornya dari ESPN (dengan jam) atau dari data jadwal.

**Liga yang dicoba**: sepak bola (Liga Inggris divisi 1 sampai 4, Piala FA dan Piala Liga, Spanyol, Jerman, Italia, Prancis, Belanda, Portugal, Skotlandia, Turki, Belgia, Brasil, Argentina, Meksiko, MLS, Liga Champions, Europa, Conference, Indonesia, Australia, Jepang, Arab Saudi), basket (NBA, WNBA, NCAA), football Amerika (NFL, NCAA, CFL), baseball (MLB), hoki es (NHL). Sepak bola di liga lain dicoba lewat papan skor umum ESPN, yang belum pasti tersedia. Daftarnya ada di `public/js/static/espn.js` dan mudah ditambah.

**Tidak tercakup**: tenis, bulu tangkis, voli, esports, MMA, rugby, futsal, dan liga yang tidak dikenal ESPN. Untuk itu skornya tetap dari data jadwal, kecuali kamu memasang proxy penyedia berlisensi (bagian berikutnya).

Yang perlu kamu tahu:

- **API ESPN tidak resmi dan tidak berdokumen.** ESPN bisa mengubah atau memblokirnya kapan saja. Bila itu terjadi, situs otomatis kembali ke data jadwal (pojok atas menampilkan jam data dan keterangannya), tidak rusak. Periksa juga ketentuan penggunaan ESPN untuk pemakaian publikasimu.
- **Privasi:** browser pengunjung menghubungi `site.api.espn.com` langsung, jadi ESPN bisa melihat alamat IP pengunjung. Tidak ada kuki atau kunci yang dikirim. Karena itu alamat itu ditambahkan ke `connect-src` pada kebijakan keamanan situs, dan hanya itu.
- **Belum teruji ke ESPN sungguhan.** Lingkungan pengembangan saya tidak punya akses internet, jadi pencocokan dan pembacaan diuji dengan respons tiruan yang saya tulis mengikuti bentuk JSON publik ESPN. Slug liga yang salah atau bentuk respons yang berbeda akan tampil sebagai "laga ini belum tersedia di sumber langsung", bukan galat. Setelah dipasang, buka satu laga live dan lihat keterangannya.
- **Tiap pengunjung menghubungi ESPN sendiri-sendiri**, jadi beban tidak tertumpu di satu tempat, tetapi juga tidak ada cache bersama. Permintaan dibatasi (maksimal 6 liga per putaran, jeda bertahap bila gagal).

## Skor langsung dari server lain (opsional: proxy Cloudflare Workers + penyedia berlisensi)

ESPN gratis tetapi tidak resmi, dan tidak mencakup tenis, bulu tangkis, voli, esports, MMA, rugby, futsal, serta liga kecil. Bila kamu mau skor live dari **penyedia data berlisensi**, kuncinya tidak boleh ditaruh di situs (GitHub Pages itu publik: siapa pun bisa membacanya). Solusinya sebuah **proxy kecil di Cloudflare Workers** (ada paket gratis, tanpa kartu kredit untuk memulai):

```
browser pengunjung --(tiap ±20 dtk)--> proxy Cloudflare --(cache 15 dtk)--> penyedia berlisensi
                                       ^ kunci tersimpan di sini sebagai secret
```

- Kunci hanya ada di Cloudflare. Situs hanya tahu **alamat** proxy (`data/config.json`, `liveUrl`).
- Cache 15 detik di proxy: 1 pengunjung atau 1.000 pengunjung memakai kuota penyedia yang sama (paling banyak satu panggilan per jendela cache).
- Proxy hanya menjawab peramban dari situs kamu (CORS dikunci ke `ALLOWED_ORIGINS`); asal lain mendapat 403 tanpa menyentuh kuota.
- Di browser, proxy **ditanya berdampingan dengan ESPN** dan, untuk laga yang dikenalnya, skornya yang dipakai. Laga yang tidak dikenal proxy tetap memakai ESPN, lalu data jadwal. Bila proxy mati atau menolak, situs tidak rusak: kembali ke ESPN, dengan jeda bertahap agar proxy tidak dihantam.
- Di halaman laga tertulis sumbernya, mis. "Skor langsung dari API-Football".

### Pilih penyedia

| `LIVE_PROVIDER` | Cakupan | Catatan |
|---|---|---|
| `apifootball` | Sepak bola saja | API-Football (api-sports.io). Paket gratis dibatasi sekitar 100 permintaan per hari, cukup untuk mencoba tetapi tidak untuk situs yang dipakai seharian; periksa paket berbayarnya di situs mereka. |
| `thesportsdb` | Banyak cabang | Livescore v2 TheSportsDB (paket premium, sekitar US$9 per bulan; diperbarui tiap ±2 menit di sumbernya). Bentuk responsnya paling sedikit terdokumentasi, jadi paling mungkin perlu penyesuaian. |

Penyedia lain (Sportmonks, Goalserve, dan sejenisnya) bisa ditambahkan di `worker/live-proxy.js`: cukup satu fungsi yang mengubah responsnya ke bentuk `{id, sport, league, kickoff, home, away, hs, as, state, code, minute, period}` dan satu entri di `PROVIDERS`. Hitung kuota: dengan cache `CACHE_SECONDS` detik, panggilan ke penyedia paling banyak `86400 / CACHE_SECONDS` per hari bila situs selalu dibuka orang (15 detik = 5.760 per hari; 120 detik = 720 per hari). Atur `CACHE_SECONDS` (5 sampai 120) sesuai paket kamu.

### Langkah pasang

1. Daftar di penyedia pilihanmu dan salin **API key**-nya.
2. Daftar di [dash.cloudflare.com](https://dash.cloudflare.com) (gratis). Buka **Workers & Pages**, klik **Create**, **Create Worker**, beri nama `jonbet-live`, klik **Deploy**.
3. Klik **Edit code**. Hapus isi bawaan, tempel **seluruh isi** berkas `worker/live-proxy.js` dari repo ini, lalu **Deploy**.
4. Buka **Settings, Variables and Secrets**, tambahkan tiga entri lalu **Deploy**:
   - `LIVE_PROVIDER` (tipe **Text**): `apifootball` atau `thesportsdb`.
   - `LIVE_API_KEY` (tipe **Secret**): kunci dari penyedia.
   - `ALLOWED_ORIGINS` (tipe **Text**): asal situsmu **tanpa path**, mis. `https://NAMAKAMU.github.io`.
5. Uji: buka `https://jonbet-live.AKUNKAMU.workers.dev/health`. Harus tampil `"configured":true`. Lalu buka `.../live` (dari peramban biasa tanpa asal, ini diizinkan untuk uji): harus tampil `"ok":true` dan daftar laga yang sedang berlangsung (kosong bila tidak ada yang live). Bila tampil galat, pesannya menyebut penyebabnya (mis. "HTTP 403" = kunci/paket salah) dan tidak pernah memuat kuncimu.
6. Di repo GitHub: **Settings, Secrets and variables, Actions, tab Variables, New repository variable**. Nama `JONBET_LIVE_URL`, nilai `https://jonbet-live.AKUNKAMU.workers.dev/live`. Perbarui `.github/workflows/pages.yml` dari berkas terbaru (ada satu baris baru `JONBET_LIVE_URL`), lalu jalankan ulang alur kerja (**Actions, Run workflow**).
7. Setelah hijau, buka `.../data/config.json`: harus ada `"liveUrl"`. Buka satu laga yang sedang live; keterangan di halamannya akan menyebut nama penyedia.

### Yang perlu kamu tahu

- **Belum diuji ke penyedia dan Cloudflare sungguhan.** Lingkungan pengembangan saya tidak punya akses internet. Pembacaan respons ditulis dari dokumentasi publik masing-masing penyedia dan diuji dengan contoh buatan sendiri; proxy diuji dengan penyedia tiruan. Bila bentuk respons aslinya berbeda, laga akan tetap tampil dari ESPN/data jadwal (bukan galat), dan langkah 5 akan memperlihatkannya. Kirimkan isi `/live` kepada saya bila hasilnya kosong padahal ada laga live, supaya pembacaannya bisa disesuaikan.
- **Nama tim harus cocok.** Penyedia memakai nama sendiri; pencocokan memakai nama kedua tim dan jam mulai (dengan variasi umum seperti "Man City", "Wolves"). Bila ragu, laga itu tidak ditimpa.
- **TheSportsDB dan IP GitHub:** build GitHub mendapat HTTP 403 dari TheSportsDB. Cloudflare Workers memakai jaringan berbeda, tetapi saya tidak bisa memastikannya dari sini; langkah 5 menjawabnya.
- **Biaya dan kuota** (penyedia dan Cloudflare) ada di tangan akun kamu. Tiap pengunjung yang membuka situs dengan laga live memanggil proxy sekitar tiap 20 detik; periksa batas permintaan harian paket Workers gratis di dokumentasi Cloudflare.
- **Pemakaian dan lisensi.** Periksa ketentuan penyedia untuk menampilkan datanya secara publik. JonBet tidak menampilkan odds atau fitur taruhan.
- Ganti penyedia atau kunci kapan saja lewat Settings Worker, tanpa mengubah situs. Cabut atau hapus Worker bila tidak dipakai; situs kembali ke ESPN sendiri.

## Langkah demi langkah

### 1. Buat repo di GitHub

Di github.com klik **New repository**, beri nama `jonbet` (nama ini akan jadi bagian alamat situs), pilih **Public**.

GitHub Pages gratis hanya untuk repo publik. Repo privat butuh paket berbayar. Isi repo ini hanya kode aplikasi, tidak ada kunci rahasia.

### 2. Unggah kode

Dari folder `jonbet` di komputer kamu:

```bash
git init -b main
git add .
git commit -m "JonBet pertama"
git remote add origin https://github.com/USERNAME/jonbet.git
git push -u origin main
```

Tanpa terminal: pakai aplikasi GitHub Desktop (Add local repository, lalu Publish repository). Jangan unggah lewat browser dengan seret-lepas, karena folder `.github` (berisi alur kerja otomatis) tidak ikut terbawa.

### 3. Aktifkan GitHub Pages

Di repo: **Settings, Pages, Build and deployment, Source: GitHub Actions**. Hanya perlu dipilih sekali.

### 4. Jalankan pembangunan pertama

Buka tab **Actions**, pilih alur kerja **Pages** di kiri, klik **Run workflow**. Build pertama lebih lama (sekitar 10 sampai 15 menit) karena mengisi riwayat hasil 14 hari terakhir supaya model punya bahan belajar. Setelah itu tiap build hanya beberapa menit.

Saat selesai, alamat situs muncul di langkah **deploy**: `https://USERNAME.github.io/jonbet/`. Setelah itu build berjalan sendiri tiap ±5 menit.

Kalau build gagal mengambil data nyata, situs tetap terbit: memakai data terakhir yang berhasil (pojok atas tertulis "Data tertunda"), atau data simulasi berlabel bila belum pernah berhasil sama sekali.

### 5. Pengaturan opsional

Di repo: **Settings, Secrets and variables, Actions**.

- **Secret `THESPORTSDB_KEY`**: kunci premium TheSportsDB (sekitar US$9 per bulan). Menambah skor live di data jadwal (yang diperbarui tiap 2 menit di sumbernya) untuk laga yang tidak tercakup ESPN. Tanpa ini dipakai kunci gratis. Kunci ini hanya dipakai di build dan tidak terkirim ke browser.
- **Variable `JONBET_LIVE_URL`** (opsional): alamat proxy skor langsung Cloudflare Workers; lihat bagian "Skor langsung dari server lain".
- **Variable `JONBET_PROVIDER`**: `auto` (bawaan, ESPN + TheSportsDB), `espn` (ESPN saja), `thesportsdb` (TheSportsDB saja), atau `demo` (data simulasi: liga dan tim fiktif, berguna untuk mencoba tampilan).

### 6. Pasang di ponsel

Buka alamat situs lewat HTTPS. iPhone: Safari, Bagikan, **Tambah ke Layar Utama**. Android: Chrome, menu, **Pasang aplikasi** (atau tombol "Pasang" di header).

## Mencoba di komputer sebelum diunggah

```bash
npm run preview:pages
```

Membangun situs dengan data simulasi lalu membukanya di `http://localhost:8080/jonbet/`, persis seperti di github.io. Untuk data nyata: `PROVIDER=auto npm run preview:pages` (butuh internet, build pertama lama).

## Statistik lengkap per laga

Tab **Statistik** di halaman laga menampilkan perbandingan kedua tim, pemain kunci, serta gol dan kartu dengan nama pemain. Data diambil saat build dari sumber terbuka tanpa kunci:

| Sumber | Isi |
|---|---|
| Ringkasan laga ESPN | Laga dari ESPN: penguasaan bola, tembakan, tembakan tepat sasaran, tendangan sudut, pelanggaran, kartu, akurasi umpan (sepak bola); rebound, assist, steal, dsb. (basket); first down, yard (football); pemain kunci; gol dan kartu |
| Boxscore MLB Stats API | Pukulan, home run, RBI, walk, strikeout, dst. |
| NHL (right-rail + landing) | Tembakan, faceoff, power play, hit, giveaway, dst.; gol per babak dengan nama pencetak |
| OpenLigaDB | Gol dengan menit dan pencetak (sudah ada di data laga, tanpa permintaan tambahan) |

Cara kerjanya: tiap build mengambil statistik laga yang live (selalu diambil ulang) dan laga selesai (sekali, lalu disimpan di cache build), maksimal 60 permintaan per build (live didahulukan, lalu hasil terbaru; sisanya menyusul di build berikutnya). Statistik masuk ke berkas data tiap laga, jadi browser tidak memanggil sumber lain dan CSP tidak berubah. Ringkasan hasilnya ada di `data/meta.json` bagian `sources.stats` (`candidates`, `fetched`, `withData`, `errors`) dan di log build ("Statistik laga: ...").

Yang perlu kamu tahu:

- **Tidak detik demi detik.** Statistik hanya segar sesering build (±5–10 menit); skor dan menit tetap live dari browser, statistiknya tidak.
- **Cakupan tidak merata.** Liga kecil sering tidak punya statistik di ESPN; tabnya menampilkan "Sumber data belum menyediakan statistik" bukan angka karangan. Bulu tangkis, voli, esports, MMA, dan futsal (dari TheSportsDB) tidak punya statistik per laga di sini; tenis hanya game per set. Statistik rugby tergantung ESPN: bila tidak ada, tab berkata begitu.
- **Belum diuji ke layanan asli.** Bentuk respons ESPN, MLB, dan NHL ditulis dari pengetahuan publik dan diuji dengan respons tiruan. Pembacanya toleran (field yang tak dikenal dilewati), tetapi bila `sources.stats.withData` bernilai 0 padahal `candidates` banyak, kirim isi `errors` dari `meta.json`.
- **Mengapa bukan Google atau LiveScore.** Google tidak punya API statistik pertandingan: panel skor di pencarian adalah data berlisensi, dan mengambilnya dengan scraping melanggar ketentuan layanan serta diblokir dari GitHub Actions dan browser (CORS). LiveScore juga tidak punya API publik; satu-satunya jalan yang ada adalah scraper pihak ketiga, yang berarti mengambil data tanpa izin. Statistik yang lebih kaya untuk sepak bola (susunan pemain, xG) bisa didapat dari penyedia berlisensi seperti API-Football lewat proxy Cloudflare yang sudah ada, dengan kunci milikmu sendiri.
- Versi server (`npm start`) belum memuat statistik ini; hanya build GitHub Pages.

### Susunan pemain (sepak bola dan basket)

Tab **Susunan** di halaman laga sepak bola dan basket (dari ESPN) menampilkan:

- **Sepak bola**: formasi (mis. 4-3-3) digambar di lapangan, daftar starter dan cadangan dengan nomor punggung dan posisi, statistik individu yang bernilai (gol, assist, tembakan, tembakan tepat sasaran, penyelamatan kiper, pelanggaran, kartu), dan penanda pemain yang masuk atau diganti.
- **Basket**: tabel kotak skor per tim, starter dan cadangan, dengan menit, poin, rebound, assist, steal, blok, turnover, FG, 3PT, FT, foul, dan plus-minus. Pemain yang tidak bermain ditandai beserta alasannya.

Datanya satu paket dengan statistik laga: diambil dari ringkasan ESPN yang sama (tanpa permintaan tambahan), jadi batasnya sama: hanya laga yang sudah live atau selesai, maksimal 60 permintaan per build, dan hanya sesegar build. Jumlah laga yang berhasil dapat susunan tercatat di `meta.json` (`sources.stats.lineups`).

Yang perlu kamu tahu:

- **Belum diuji ke ESPN sungguhan.** Nama field (`rosters`, `formation`, `formationPlace`, `boxscore.players`) saya tulis dari pengetahuan tentang bentuk ESPN dan diuji dengan respons tiruan. Bila `sources.stats.lineups` bernilai 0 padahal statistik laga terisi, kirim satu contoh balasan `summary?event=...` dari liga itu supaya saya mencocokkan bacaannya.
- **Letak pemain di lapangan** dihitung dari urutan nomor posisi ESPN (`formationPlace`) dan formasinya: kiper, lalu tiap lini dari belakang ke depan. Itu konvensi yang saya andalkan, belum terbukti di data asli. Bila data tidak lengkap atau tidak cocok dengan formasi, lapangan tidak digambar dan daftar pemain tetap tampil.
- **Susunan sebelum laga tidak ditampilkan.** ESPN kadang merilisnya sekitar satu jam sebelum kick-off, tetapi build hanya mengambil laga live dan selesai. Menit pergantian pemain juga belum ditampilkan, hanya penanda masuk atau diganti.
- **Tidak detik demi detik.** Susunan dan statistik pemain baru berubah di build berikutnya. Liga kecil sering tidak punya data ini di ESPN; tabnya berkata begitu.
- **Cabang lain** (football Amerika, hoki, rugby, dan lainnya) belum punya tab ini.
- Laga selesai yang statistiknya sudah tersimpan di cache build lama diambil ulang satu kali agar susunannya ikut terisi (dibatasi 60 per build, jadi bisa butuh beberapa build).

### Tenis, rugby, baseball, dan futsal

- **Tenis** (ATP dan WTA dari ESPN): skor laga = jumlah set yang dimenangkan; tab Statistik menampilkan game per set. Saat live, browser membaca set dan game berjalan langsung dari ESPN. Bentuk data turnamen ESPN (turnamen > babak > pertandingan) ditulis dari dokumentasi pihak ketiga dan **belum diuji ke ESPN sungguhan**. Pemain yang belum ditentukan (TBD, bye, kualifikasi) dilewati.
- **Rugby**: ESPN punya banyak liga rugby dengan nomor yang tidak saya hafal dengan pasti, jadi build **menemukannya sendiri** lewat daftar liga rugby ESPN (maksimal 60 liga, sekali per build). Hasilnya tercatat di `meta.json` (`sources.espn.rugby`: `ok`, `leagues`, `found`) dan di log ("ESPN rugby: N liga ditemukan"). Bila daftar itu gagal diambil, rugby jatuh ke TheSportsDB dan alasannya tertulis di `sources.espn.rugby.error`. Menit pertandingan (babak 1/2, jeda, perpanjangan) dibaca dari jam ESPN saat live.
- **Baseball**: MLB Stats API kini menanyakan satu permintaan per tingkat (MLB, MiLB, NPB, KBO, dll.), dan tiap tingkat berdiri sendiri di `sources.public`. Hanya MLB yang di-poll live dari browser (lewat ESPN); tingkat lain **diperbarui tiap build**, bukan detik demi detik, karena akses browser langsung ke MLB Stats API belum terbukti diizinkan (CORS).
- **Futsal**: tidak ada sumber gratis. Datanya hanya dari TheSportsDB saat build (terbatas di kunci gratis), tanpa statistik per laga, dan tab Statistik berkata terus terang soal itu. Skor live futsal baru mungkin lewat kunci TheSportsDB premium yang dipasang di proxy Cloudflare (lihat bagian proxy). Saya tidak menemukan API futsal terbuka yang layak, dan tidak mau memalsukan datanya.

## Tanya AI, ikuti laga, dan notifikasi

- **Tanya AI** (tab di bilah bawah): pertanyaan lintas laga seperti "laga live sekarang", "hasil tadi malam", "laga paling ketat besok", "jadwal Arsenal", "pilihan model hari ini". Ia memahami cabang, liga, tim, dan jendela waktu (waktu Jakarta), dan mengingat konteks percakapan: "yang lain" melanjutkan daftar, "kalau tim tamu?" atau "bagaimana jika skor 2-1 menit 70?" dijawab dari model laga yang sedang dibahas. Ini mesin aturan dan statistik bawaan, **bukan model bahasa**: ia mengaku bila pertanyaannya di luar data (cedera, cuaca, berita). Tanpa kunci dan tanpa biaya; kunci Claude milik sendiri tetap opsional di halaman laga.
- **Ikuti laga**: di halaman laga yang live atau akan datang ada kotak "Ikuti laga ini". Saat aplikasi terbuka, browser mengirim notifikasi lokal untuk kick-off, gol, dan peluit akhir, dan sumber skor tetap dipoll walau tab tersembunyi (lebih jarang, tiap ±60 detik). Opsi "Jaga layar tetap menyala" memakai Wake Lock bila browser mendukungnya.
- **Batas yang jujur**: ini bukan push. Tidak ada server yang mengirim notifikasi ke ponsel yang tertutup, karena situs ini hanya GitHub Pages. Bila aplikasi atau tab ditutup, atau browser membekukan tab di latar belakang (umum di iOS dan ponsel hemat baterai), notifikasi berhenti sampai aplikasi dibuka lagi. Notifikasi sungguhan saat aplikasi tertutup butuh server push (Web Push dengan kunci VAPID), yang di luar cakupan versi tanpa server ini. Izin notifikasi baru diminta saat kamu menyalakannya.

## Batasan yang perlu kamu tahu

- **Jadwal GitHub Actions tidak tepat waktu.** Pekerjaan terjadwal bisa tertunda belasan menit saat GitHub sibuk, dan kadang terlewat. Itu sebabnya skor live memakai ESPN langsung dari browser. Untuk laga yang tidak tercakup ESPN, jangan mengandalkan situs ini untuk skor detik demi detik.
- **Skor langsung hanya jalan saat situs terbuka.** Menutup tab berarti berhenti; saat dibuka lagi, langsung menyegarkan. Tab yang tersembunyi tetap dipoll lebih jarang bila kamu mengikuti laga (lihat "Tanya AI, ikuti laga, dan notifikasi"), tetapi browser boleh membekukannya kapan saja.
- **Dimatikan otomatis setelah 60 hari tanpa aktivitas.** Di repo publik, GitHub menonaktifkan alur kerja terjadwal bila tidak ada perubahan di repo selama 60 hari. Bila itu terjadi, buka tab Actions dan klik **Enable workflow**.
- **Sumber data.** TheSportsDB adalah basis data hasil kontribusi komunitas; kunci gratisnya dibatasi sekitar 30 permintaan per menit dan jumlah laga per permintaan. Build memakai jeda dan cache agar tidak melampauinya, tetapi data TheSportsDB bisa terlambat atau kurang lengkap. Untuk liga yang ada di ESPN, datanya jauh lebih lengkap.
- **Rating belajar dari state yang disimpan di cache GitHub Actions.** Bila cache hilang (misalnya repo tidak aktif lebih dari 7 hari), model mulai lagi dari awal dan mengisi ulang riwayat.
- **Tebakan hanya di perangkat.** Menghapus data situs di browser, atau memakai browser lain, berarti tebakan hilang. Tidak ada cadangan di server.
- **Keamanan.** GitHub Pages tidak bisa memasang header keamanan, jadi kebijakan keamanan konten dipasang lewat tag `<meta>` (tanpa perlindungan `frame-ancestors`, sehingga situs bisa dibingkai halaman lain). Profil lokal tanpa kata sandi: siapa pun yang memakai browser yang sama bisa masuk sebagai profil itu.
- **Belum diuji di GitHub sungguhan.** Alur kerja (`.github/workflows/pages.yml`) sintaksnya valid, sedangkan skrip build, situs, dan uji browser sudah dijalankan berulang kali di lingkungan pengembangan dengan TheSportsDB tiruan. Ada yang mungkin baru terlihat saat build pertama di GitHub (misalnya versi aksi yang berubah atau izin Pages). Bila gagal, buka log langkah yang merah dan cari baris pertama yang bertanda galat.

## JonBet AI dan Claude (opsional)

JonBet AI bawaan bukan model bahasa: ia memahami pertanyaan dengan aturan (kata kunci, beberapa maksud sekaligus, penyebutan tim, "kenapa") dan menjawab dari angka analisis laga itu. Ia mengaku bila pertanyaannya di luar jangkauan (cuaca, cedera, berita tidak ada di datanya).

Kalau ingin jawaban yang lebih luwes, tiap pengguna bisa memasukkan **kunci API Claude miliknya sendiri**: buka laga, tab **Tanya JonBet AI**, buka **Pakai Claude sungguhan (opsional)**, tempel kunci, pilih model, Simpan. Kunci disimpan hanya di browser perangkat itu (localStorage) dan dikirim langsung ke api.anthropic.com; tidak lewat GitHub atau server lain. Claude hanya diberi angka analisis laga itu dan diinstruksikan menolak saran taruhan. Pemakaian ditagih ke akun Anthropic pemilik kunci, jadi atur batas pengeluaran di konsol Anthropic dan jangan pakai di perangkat bersama. Bila kunci ditolak atau Claude gagal, aplikasi otomatis memakai model bawaan dan memberi tahu. Fitur ini belum diuji ke API Anthropic sungguhan (hanya dengan balasan tiruan).

## Memperbarui repo yang sudah terpasang

Bila kamu sudah memasang versi sebelumnya dan ingin memakai data ESPN:

1. Unggah berkas yang berubah (di GitHub: **Add file, Upload files**, seret folder `server`, `scripts`, `public`, `test`, `docs` dan berkas `README.md`, lalu **Commit changes**). Folder `.github` tidak ikut terseret lewat browser, jadi langkah 2 dikerjakan terpisah.
2. Buka `.github/workflows/pages.yml` di repo, klik ikon pensil, dan ubah satu baris: `|| 'thesportsdb'` menjadi `|| 'auto'` (di baris `PROVIDER: ${{ vars.JONBET_PROVIDER || ... }}`). Commit.
3. Commit itu memulai build baru. Karena riwayat ESPN diambil sekali di build pertama, build ini lebih lama (±10 menit).
4. Setelah hijau, buka `.../data/meta.json` dan periksa bagian `sources` (lihat di atas).

## Bila ada masalah

| Gejala | Penyebab dan cara |
|---|---|
| Alamat situs menampilkan 404 | Pages belum diaktifkan (langkah 3) atau build pertama belum selesai (langkah 4) |
| Alur kerja Pages tidak muncul di tab Actions | Folder `.github` belum terunggah; ulangi langkah 2 |
| Langkah deploy gagal dengan pesan soal environment atau izin | Cek Settings, Pages, Source = GitHub Actions; lalu jalankan ulang |
| Situs berlabel "Data simulasi" padahal tidak memilih demo | Kedua sumber gagal pada build pertama dan belum pernah ada data nyata. Lihat log langkah **Bangun situs**; coba jalankan ulang. Cek juga bahwa variabel `JONBET_PROVIDER` tidak bernilai `demo` |
| Hanya sedikit laga yang muncul, tidak ada liga besar | ESPN sedang gagal dan hanya TheSportsDB gratis yang terpakai. Buka `data/meta.json`: bila `sources.espn.ok` bernilai 0, lihat log build untuk galatnya. Pastikan `pages.yml` memakai `'auto'`, bukan `'thesportsdb'` |
| Log build: `ESPN ... HTTP 400` pada banyak liga dan situs berlabel "Demo (sumber nyata gagal)" | Bentuk permintaan ditolak. Versi terbaru mencoba bentuk lain sendiri; bila masih gagal, kirim baris `lastError` di `data/meta.json` |
| Log build: `TheSportsDB membalas HTTP 403` | TheSportsDB menolak permintaan dari server GitHub (kunci gratis atau pembatasan alamat). Dengan ESPN yang berjalan, situs tetap memakai data nyata; hanya cabang non-ESPN yang tipis |
| Liga tertentu tidak muncul padahal liga besar lain ada | Slug ESPN liga itu mungkin salah atau berubah; liga itu tercantum di `sources.espn.failed` pada `meta.json` |
| Pojok atas "Data tertunda" | Sumber data sedang gagal; situs memakai data terakhir yang berhasil. Pulih sendiri saat build berikutnya berhasil |
| Jadwal tidak berubah | Tunggu sampai ±20 menit atau jalankan alur kerja Pages secara manual. Cek juga apakah alur kerja dinonaktifkan (lihat batasan) |
| Laga live bertuliskan "Skor dari data jadwal" | Liga itu tidak tercakup ESPN, nama tim terlalu berbeda untuk dicocokkan dengan yakin, atau ESPN sedang tidak bisa dihubungi. Pojok atas menjelaskan bila sumbernya mati |
| Konsol browser memuat galat jaringan ke `site.api.espn.com` | Wajar bila ESPN memblokir atau tidak menemukan liga itu; situs lanjut memakai data jadwal. Bila terus-menerus dan skor live tidak pernah muncul, kemungkinan ESPN mengubah API-nya |
| Tebakan hilang | Data situs di browser terhapus. Tebakan tidak tersimpan di server |
