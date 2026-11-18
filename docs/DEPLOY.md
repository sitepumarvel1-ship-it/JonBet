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

Tidak ada data fiktif kecuali bila kamu sengaja memilih `demo`, atau bila build pertama gagal total (lihat di bawah). Mode bawaan `auto` memakai dua sumber:

| Sumber | Dipakai untuk | Catatan |
|---|---|---|
| **ESPN** (papan skor publik, tidak resmi) | Sepak bola di liga-liga besar dunia, basket (NBA, WNBA, NCAA), football Amerika (NFL, NCAA, CFL), baseball (MLB), hoki es (NHL): jadwal, hasil, status live | Satu permintaan per liga per build mengambil seluruh rentang tanggal, jadi datanya lengkap. Tersedia tanpa kunci |
| **TheSportsDB** | Cabang yang tidak dicakup ESPN (tenis, bulu tangkis, voli, esports, MMA, rugby, futsal) dan liga sepak bola yang tidak ada di ESPN | Hasil kontribusi komunitas. Kunci gratis dibatasi: menurut dokumentasi pihak ketiga hanya sekitar 5 laga per hari per liga, jadi datanya tipis. Kunci premium membukanya penuh |

Laga yang sama dari kedua sumber hanya tampil sekali (versi ESPN dipakai). Bila satu sumber gagal, yang lain tetap dipakai; bila keduanya gagal, situs memakai data terakhir yang berhasil ("Data tertunda").

**Prediksi** dihitung dari rating Elo yang dibangun dari hasil nyata: build pertama mengambil ±60 hari hasil ESPN (sekitar 200 permintaan satu kali saja), lalu rating terus belajar tiap build. Model hanya memakai hasil historis, jadi tim yang jarang terlihat punya skor keyakinan rendah. Ini perkiraan statistik, bukan jaminan, dan akurasinya baru bisa dinilai setelah beberapa minggu berjalan (lihat "Rekam jejak model" di halaman Cara kerja).

**Cara memeriksa sumber mana yang bekerja** (tanpa membaca log): buka `https://USERNAME.github.io/jonbet/data/meta.json`. Bagian `sources` memuat jumlah liga ESPN yang merespons (`espn.ok` dari `espn.leagues`), daftar liga yang gagal (`espn.failed`), dan jumlah permintaan TheSportsDB. Log build di tab Actions memuat ringkasan yang sama ("ESPN: N dari M liga merespons").

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

**Tidak tercakup**: tenis, bulu tangkis, voli, esports, MMA, rugby, futsal, dan liga yang tidak dikenal ESPN. Untuk itu skornya tetap dari data jadwal.

Yang perlu kamu tahu:

- **API ESPN tidak resmi dan tidak berdokumen.** ESPN bisa mengubah atau memblokirnya kapan saja. Bila itu terjadi, situs otomatis kembali ke data jadwal (pojok atas menampilkan jam data dan keterangannya), tidak rusak. Periksa juga ketentuan penggunaan ESPN untuk pemakaian publikasimu.
- **Privasi:** browser pengunjung menghubungi `site.api.espn.com` langsung, jadi ESPN bisa melihat alamat IP pengunjung. Tidak ada kuki atau kunci yang dikirim. Karena itu alamat itu ditambahkan ke `connect-src` pada kebijakan keamanan situs, dan hanya itu.
- **Belum teruji ke ESPN sungguhan.** Lingkungan pengembangan saya tidak punya akses internet, jadi pencocokan dan pembacaan diuji dengan respons tiruan yang saya tulis mengikuti bentuk JSON publik ESPN. Slug liga yang salah atau bentuk respons yang berbeda akan tampil sebagai "laga ini belum tersedia di sumber langsung", bukan galat. Setelah dipasang, buka satu laga live dan lihat keterangannya.
- **Tiap pengunjung menghubungi ESPN sendiri-sendiri**, jadi beban tidak tertumpu di satu tempat, tetapi juga tidak ada cache bersama. Permintaan dibatasi (maksimal 6 liga per putaran, jeda bertahap bila gagal).

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
- **Variable `JONBET_PROVIDER`**: `auto` (bawaan, ESPN + TheSportsDB), `espn` (ESPN saja), `thesportsdb` (TheSportsDB saja), atau `demo` (data simulasi: liga dan tim fiktif, berguna untuk mencoba tampilan).

### 6. Pasang di ponsel

Buka alamat situs lewat HTTPS. iPhone: Safari, Bagikan, **Tambah ke Layar Utama**. Android: Chrome, menu, **Pasang aplikasi** (atau tombol "Pasang" di header).

## Mencoba di komputer sebelum diunggah

```bash
npm run preview:pages
```

Membangun situs dengan data simulasi lalu membukanya di `http://localhost:8080/jonbet/`, persis seperti di github.io. Untuk data nyata: `PROVIDER=auto npm run preview:pages` (butuh internet, build pertama lama).

## Batasan yang perlu kamu tahu

- **Jadwal GitHub Actions tidak tepat waktu.** Pekerjaan terjadwal bisa tertunda belasan menit saat GitHub sibuk, dan kadang terlewat. Itu sebabnya skor live memakai ESPN langsung dari browser. Untuk laga yang tidak tercakup ESPN, jangan mengandalkan situs ini untuk skor detik demi detik.
- **Skor langsung hanya jalan saat situs terbuka.** Browser hanya bertanya saat tab terlihat dan online. Menutup tab berarti berhenti; saat dibuka lagi, langsung menyegarkan.
- **Dimatikan otomatis setelah 60 hari tanpa aktivitas.** Di repo publik, GitHub menonaktifkan alur kerja terjadwal bila tidak ada perubahan di repo selama 60 hari. Bila itu terjadi, buka tab Actions dan klik **Enable workflow**.
- **Sumber data.** TheSportsDB adalah basis data hasil kontribusi komunitas; kunci gratisnya dibatasi sekitar 30 permintaan per menit dan jumlah laga per permintaan. Build memakai jeda dan cache agar tidak melampauinya, tetapi data TheSportsDB bisa terlambat atau kurang lengkap. Untuk liga yang ada di ESPN, datanya jauh lebih lengkap.
- **Rating belajar dari state yang disimpan di cache GitHub Actions.** Bila cache hilang (misalnya repo tidak aktif lebih dari 7 hari), model mulai lagi dari awal dan mengisi ulang riwayat.
- **Tebakan hanya di perangkat.** Menghapus data situs di browser, atau memakai browser lain, berarti tebakan hilang. Tidak ada cadangan di server.
- **Keamanan.** GitHub Pages tidak bisa memasang header keamanan, jadi kebijakan keamanan konten dipasang lewat tag `<meta>` (tanpa perlindungan `frame-ancestors`, sehingga situs bisa dibingkai halaman lain). Profil lokal tanpa kata sandi: siapa pun yang memakai browser yang sama bisa masuk sebagai profil itu.
- **Belum diuji di GitHub sungguhan.** Alur kerja (`.github/workflows/pages.yml`) sintaksnya valid, sedangkan skrip build, situs, dan uji browser sudah dijalankan berulang kali di lingkungan pengembangan dengan TheSportsDB tiruan. Ada yang mungkin baru terlihat saat build pertama di GitHub (misalnya versi aksi yang berubah atau izin Pages). Bila gagal, buka log langkah yang merah dan cari baris pertama yang bertanda galat.

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
