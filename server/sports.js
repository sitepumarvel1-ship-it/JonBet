// Daftar cabang olahraga dan parameter model per cabang.
//
// model:
//   poisson : olahraga skor rendah (gol), tim A vs tim B, bisa seri
//   points  : olahraga skor tinggi (poin), selisih mendekati distribusi normal
//   versus  : adu langsung (tidak ada skor gol), pemenang ditentukan lewat set/ronde

export const SPORTS = [
  {
    id: 'football', name: 'Sepak bola', short: 'Bola', tsdb: 'Soccer', model: 'poisson',
    duration: 90, baseTotal: 2.7, homeAdv: 65, k: 20, eloScale: 750, drawable: true,
    totalLines: [0.5, 1.5, 2.5, 3.5, 4.5], btts: true, scoreUnit: 'gol', homeLabel: 'Tuan rumah', awayLabel: 'Tamu',
  },
  {
    id: 'futsal', name: 'Futsal', short: 'Futsal', tsdb: 'Futsal', model: 'poisson',
    duration: 40, baseTotal: 6.4, homeAdv: 40, k: 22, eloScale: 520, drawable: true,
    totalLines: [4.5, 5.5, 6.5, 7.5, 8.5], btts: true, scoreUnit: 'gol', homeLabel: 'Tuan rumah', awayLabel: 'Tamu',
  },
  {
    id: 'basketball', name: 'Basket', short: 'Basket', tsdb: 'Basketball', model: 'points',
    duration: 48, baseTotal: 218, sd: 12, eloToMargin: 0.035, homeAdv: 70, k: 20, drawable: false,
    bands: [5, 12], scoreUnit: 'poin', homeLabel: 'Tuan rumah', awayLabel: 'Tamu', totalStep: 5,
  },
  {
    id: 'americanfootball', name: 'Football Amerika', short: 'Football', tsdb: 'American Football', model: 'points',
    duration: 60, baseTotal: 46, sd: 13.5, eloToMargin: 0.04, homeAdv: 48, k: 20, drawable: false,
    bands: [3, 10], scoreUnit: 'poin', homeLabel: 'Tuan rumah', awayLabel: 'Tamu', totalStep: 3,
  },
  {
    id: 'baseball', name: 'Baseball', short: 'Baseball', tsdb: 'Baseball', model: 'points',
    duration: 9, baseTotal: 8.8, sd: 4.3, eloToMargin: 0.007, homeAdv: 24, k: 8, drawable: false,
    bands: [1, 3], scoreUnit: 'run', homeLabel: 'Tuan rumah', awayLabel: 'Tamu', totalStep: 1,
  },
  {
    id: 'rugby', name: 'Rugby', short: 'Rugby', tsdb: 'Rugby', model: 'points',
    duration: 80, baseTotal: 42, sd: 15, eloToMargin: 0.05, homeAdv: 55, k: 20, drawable: false,
    bands: [7, 14], scoreUnit: 'poin', homeLabel: 'Tuan rumah', awayLabel: 'Tamu', totalStep: 3,
  },
  {
    id: 'icehockey', name: 'Hoki es', short: 'Hoki es', tsdb: 'Ice Hockey', model: 'poisson',
    duration: 60, baseTotal: 6.0, homeAdv: 35, k: 18, eloScale: 650, drawable: false,
    totalLines: [4.5, 5.5, 6.5, 7.5], btts: false, scoreUnit: 'gol', homeLabel: 'Tuan rumah', awayLabel: 'Tamu',
  },
  {
    id: 'tennis', name: 'Tenis', short: 'Tenis', tsdb: 'Tennis', model: 'versus',
    duration: 120, bestOf: 3, homeAdv: 0, k: 24, drawable: false, scoreUnit: 'set', homeLabel: 'Pemain 1', awayLabel: 'Pemain 2',
  },
  {
    id: 'badminton', name: 'Bulu tangkis', short: 'Badminton', tsdb: 'Badminton', model: 'versus',
    duration: 60, bestOf: 3, homeAdv: 0, k: 24, drawable: false, scoreUnit: 'gim', homeLabel: 'Pemain 1', awayLabel: 'Pemain 2',
  },
  {
    id: 'volleyball', name: 'Bola voli', short: 'Voli', tsdb: 'Volleyball', model: 'versus',
    duration: 100, bestOf: 5, homeAdv: 30, k: 22, drawable: false, scoreUnit: 'set', homeLabel: 'Tuan rumah', awayLabel: 'Tamu',
  },
  {
    id: 'esports', name: 'Esports', short: 'Esports', tsdb: 'ESports', model: 'versus',
    duration: 90, bestOf: 3, homeAdv: 0, k: 24, drawable: false, scoreUnit: 'map', homeLabel: 'Tim 1', awayLabel: 'Tim 2',
  },
  {
    id: 'mma', name: 'MMA', short: 'MMA', tsdb: 'Fighting', model: 'versus',
    duration: 25, bestOf: 1, homeAdv: 0, k: 28, drawable: false, scoreUnit: 'ronde', homeLabel: 'Petarung 1', awayLabel: 'Petarung 2',
  },
];

export const SPORTS_BY_ID = Object.freeze(Object.fromEntries(SPORTS.map((s) => [s.id, s])));
export const SPORTS_BY_TSDB = Object.freeze(Object.fromEntries(SPORTS.map((s) => [s.tsdb.toLowerCase(), s])));

export const isSport = (id) => Object.prototype.hasOwnProperty.call(SPORTS_BY_ID, id);

/** Bagian konfigurasi cabang yang aman dan perlu dikirim ke klien. */
export const publicSport = (s) => ({
  id: s.id, name: s.name, short: s.short, model: s.model, drawable: s.drawable,
  scoreUnit: s.scoreUnit, homeLabel: s.homeLabel, awayLabel: s.awayLabel, duration: s.duration,
});
