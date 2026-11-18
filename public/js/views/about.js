import { h } from '../dom.js';
import { state } from '../state.js';
import { STATIC } from '../mode.js';

export function aboutView() {
  return {
    title: 'Tentang dan metode',
    el: h('div', { class: 'page' }, h('article', { class: 'about' },
      h('h1', { style: { font: '800 28px/1.2 var(--font-display)' } }, 'Cara JonBet menganalisis'),
      h('p', {}, 'JonBet menghitung peluang hasil pertandingan dari riwayat hasil, lalu menjelaskannya dalam bahasa yang mudah dibaca. JonBet tidak menyediakan taruhan, odds, atau transaksi uang.'),
      h('h2', {}, 'Model'),
      h('ul', {},
        h('li', {}, 'Tiap tim punya rating Elo yang diperbarui otomatis setiap ada hasil baru yang terlihat oleh sistem. Ini yang membuat model "belajar sendiri".'),
        h('li', {}, 'Sepak bola, futsal, dan hoki es: skor gol dimodelkan dengan distribusi Poisson dan koreksi untuk skor rendah.'),
        h('li', {}, 'Basket, football Amerika, baseball, rugby: selisih poin dimodelkan dengan distribusi normal.'),
        h('li', {}, 'Tenis, bulu tangkis, voli, esports, MMA: peluang menang dihitung dari Elo, lalu diturunkan ke peluang per set atau ronde.'),
        h('li', {}, 'Saat pertandingan berlangsung, peluang dihitung ulang dari skor dan sisa waktu.')),
      h('h2', {}, 'Keyakinan model'),
      h('p', {}, 'Angka 0 sampai 100 ini menilai seberapa cukup datanya dan seberapa tegas selisih kekuatan kedua sisi. Ini bukan jaminan hasil.'),
      h('h2', {}, 'Batasan'),
      h('ul', {},
        h('li', {}, 'Model hanya memakai hasil historis. Cedera, susunan pemain, cuaca, dan motivasi tidak ikut dihitung.'),
        h('li', {}, 'Peluang 70% berarti kira-kira 7 dari 10 laga serupa berakhir begitu, bukan bahwa hasilnya pasti.'),
        h('li', {}, 'Rekam jejak model dihitung dengan uji-mundur: tiap laga ditebak memakai data sebelum laga itu. Hasil lampau tidak menjamin hasil mendatang.')),
      h('h2', {}, 'Sumber data'),
      state.config.demo
        ? h('p', {}, STATIC
          ? 'Saat ini aplikasi memakai data simulasi (liga dan tim fiktif) karena pengambilan data nyata belum berhasil.'
          : 'Saat ini aplikasi memakai data simulasi (liga dan tim fiktif) untuk demonstrasi. Hubungkan sumber data nyata di pengaturan server.')
        : h('p', {}, 'Jadwal dan hasil berasal dari TheSportsDB, basis data olahraga hasil kontribusi komunitas, sehingga sesekali ada data yang terlambat atau kurang lengkap.'),
      STATIC ? h('p', {}, 'Pada versi ini jadwal dan hasil disegarkan otomatis oleh GitHub Actions tiap beberapa menit (jam data terakhir tampil di pojok atas). Untuk laga yang sedang berlangsung di liga yang tersedia, skor diambil langsung dari ESPN lewat browser kamu tiap sekitar 20 detik. Laga lain tetap memakai data jadwal dan bisa terlambat beberapa menit; di halaman laga tertulis skornya dari sumber yang mana. Sumber langsung itu tidak resmi dan bisa berhenti bekerja sewaktu-waktu, dan ESPN dapat melihat alamat IP kamu saat browser menghubunginya.') : null,
      h('h2', {}, 'Komunitas'),
      h('p', {}, STATIC
        ? 'Versi ini tidak punya server bersama. Kamu bisa membuat profil tanpa kata sandi dan menyimpan tebakan, tetapi semuanya hanya ada di browser perangkat ini. Aturan poin sama: benar mendapat 10 poin ditambah 2 poin per tingkat keyakinan, bonus 10 poin bila skor tepat, meleset mengurangi poin sesuai keyakinan. Poin tidak bisa ditukar dengan uang atau hadiah.'
        : 'Pengguna membagikan tebakan dan mengumpulkan poin reputasi. Benar mendapat 10 poin ditambah 2 poin per tingkat keyakinan, bonus 10 poin bila skor tepat. Meleset mengurangi poin sesuai keyakinan. Poin tidak bisa ditukar dengan uang atau hadiah.'),
      h('h2', {}, 'Penggunaan yang bijak'),
      h('p', {}, 'Gunakan JonBet untuk memahami pertandingan, bukan untuk bertaruh. Taruhan uang berisiko merugikan, dan perjudian online dilarang di Indonesia. Jika kamu merasa sulit berhenti berjudi, bicarakan dengan orang tepercaya atau tenaga profesional.'),
      h('p', { class: 'disclaimer' }, 'Font Inter berlisensi SIL Open Font License.'))),
  };
}
