// Penyedia data DEMO: jadwal, skor live, dan hasil simulasi yang deterministik.
// Semua liga dan tim di sini fiktif. Dipakai untuk mencoba aplikasi tanpa API key
// dan sebagai cadangan bila sumber data nyata tidak tersedia. UI selalu melabelinya "Data simulasi".

import { SPORTS_BY_ID } from '../sports.js';
import { eloExpected, solveSetProb } from '../model/model.js';
import { gauss, hash32, poissonSample, rng } from '../util.js';

const MIN = 60_000;

const LEAGUES = [
  { id: 'lnp', sport: 'football', name: 'Liga Nusantara Premier', slot: 240, per: 2, stagger: 60, real: 105,
    teams: ['Garuda Selatan FC', 'Komodo United', 'Rajawali Utara', 'Harimau Barat FC', 'Banteng Timur', 'Cenderawasih FC', 'Naga Biru', 'Elang Pasir FC', 'Badak Hitam', 'Macan Kumbang FC'] },
  { id: 'psm', sport: 'football', name: 'Piala Samudra', slot: 360, per: 1, stagger: 0, real: 105,
    teams: ['Pelaut Merah', 'Karang Putih FC', 'Ombak Emas', 'Tiram Perak', 'Hiu Kelabu FC', 'Lumba Biru', 'Paus Jingga', 'Cumi Ungu FC'] },
  { id: 'lfg', sport: 'futsal', name: 'Liga Futsal Garuda', slot: 240, per: 1, stagger: 0, real: 55,
    teams: ['Api Muda', 'Badai Kota', 'Cahaya Pantai', 'Dewa Lapangan', 'Elang Gesit', 'Fajar Timur', 'Gema Rimba', 'Halilintar FS'] },
  { id: 'lbp', sport: 'basketball', name: 'Liga Basket Pasifik', slot: 300, per: 1, stagger: 0, real: 125,
    teams: ['Sriwijaya Titan', 'Majapahit Kings', 'Mataram Storm', 'Singasari Flames', 'Kutai Wolves', 'Tarumanegara Hawks', 'Pasai Orcas', 'Galuh Panthers'] },
  { id: 'lga', sport: 'americanfootball', name: 'Liga Gridiron Asia', slot: 720, per: 1, stagger: 0, real: 190,
    teams: ['Borneo Ironclads', 'Sumatra Stampede', 'Jawa Thunder', 'Bali Reapers', 'Celebes Raiders', 'Papua Titans', 'Maluku Surge', 'Lombok Falcons'] },
  { id: 'ldn', sport: 'baseball', name: 'Liga Diamond Nusantara', slot: 420, per: 1, stagger: 0, real: 170,
    teams: ['Tangkas Red Fox', 'Bintang Utara', 'Pelangi Biru', 'Kilau Emas', 'Samudra Tigers', 'Kabut Putih', 'Rimba Hijau', 'Senja Ungu'] },
  { id: 'srk', sport: 'rugby', name: 'Seri Rugby Khatulistiwa', slot: 720, per: 1, stagger: 0, real: 100,
    teams: ['Kalimantan Bulls', 'Flores Warriors', 'Timor Sharks', 'Sulawesi Lions', 'Natuna Eagles', 'Halmahera Crocs', 'Sumba Stallions', 'Anambas Rhinos'] },
  { id: 'lek', sport: 'icehockey', name: 'Liga Es Kutub', slot: 360, per: 1, stagger: 0, real: 150,
    teams: ['Kutub Beruang', 'Salju Serigala', 'Embun Rusa', 'Kristal Elang', 'Badai Salju', 'Gletser Paus', 'Beku Harimau', 'Aurora Lynx'] },
  { id: 'tpt', sport: 'tennis', name: 'Turnamen Pelita Terbuka', slot: 150, per: 1, stagger: 0, real: 130,
    teams: ['Arka Wiradana', 'Lior Tamarin', 'Bayu Sentosa', 'Kenzo Hartawan', 'Dimas Prakoso', 'Rafael Suteja', 'Teguh Maheswara', 'Nolan Pradipta', 'Gilang Wicaksana', 'Evan Mahendra', 'Satria Kusuma', 'Jovan Adiputra'] },
  { id: 'btk', sport: 'badminton', name: 'Kejuaraan Tunggal Khatulistiwa', slot: 120, per: 1, stagger: 0, real: 60,
    teams: ['Anindya Larasati', 'Citra Wulandari', 'Dewi Maharani', 'Salsa Paramita', 'Nadia Kusumawati', 'Putri Ananta', 'Kirana Sekar', 'Laras Pertiwi', 'Maya Indrastuti', 'Wulan Cahyani', 'Sekar Ayu', 'Tiara Kencana'] },
  { id: 'lvp', sport: 'volleyball', name: 'Liga Voli Pertiwi', slot: 360, per: 1, stagger: 0, real: 105,
    teams: ['Pertiwi Merah', 'Nusa Biru', 'Bahari Putih', 'Cakrawala', 'Dirgantara', 'Fajar Kencana', 'Gemilang Pratama', 'Harapan Jaya'] },
  { id: 'lce', sport: 'esports', name: 'Liga Cakra Esports', slot: 180, per: 1, stagger: 0, real: 95,
    teams: ['Tim Cakra', 'Naga Digital', 'Pixel Garuda', 'Rift Nusantara', 'Elang Siber', 'Kilat Gaming', 'Rimba Esports', 'Zenith Jaya'] },
  { id: 'kag', sport: 'mma', name: 'Kartu Arena Garuda', slot: 600, per: 2, stagger: 30, real: 25,
    teams: ['Bima Santoso', 'Rakha Mahardika', 'Ilham Kusumo', 'Vero Haryanto', 'Dante Gunadi', 'Ozan Wibisono', 'Raka Pamungkas', 'Fikri Aditama', 'Yoga Perkasa', 'Zaki Mulyadi', 'Hasta Dirgantara', 'Tirta Sanjaya'] },
];

const LEAGUES_BY_ID = Object.fromEntries(LEAGUES.map((l) => [l.id, l]));
const SD_ELO = 110;

/** Geser jadwal tiap liga (menit bulat) supaya kickoff antar liga tidak serempak. */
const slotOffset = (L) => (hash32(L.id) % L.slot) * MIN;

const strength = (sport, name) => gauss(rng(`str|${sport}|${name}`)) * SD_ELO;

function shortName(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

/** Hasil akhir deterministik sebuah pertandingan (tidak bergantung waktu sekarang). */
function simulateOutcome(L, cfg, home, away, rand) {
  const dElo = strength(L.sport, home) + cfg.homeAdv - strength(L.sport, away);

  if (cfg.model === 'poisson') {
    const T = cfg.baseTotal;
    const s = dElo / cfg.eloScale;
    const hs = poissonSample((T / 2) * Math.exp(s), rand);
    const as = poissonSample((T / 2) * Math.exp(-s), rand);
    let hMin = Array.from({ length: hs }, () => 1 + Math.floor(rand() * cfg.duration)).sort((a, b) => a - b);
    let aMin = Array.from({ length: as }, () => 1 + Math.floor(rand() * cfg.duration)).sort((a, b) => a - b);
    let h = hs, a = as;
    // Hoki es tidak boleh seri: pemenang ditentukan di perpanjangan waktu.
    if (!cfg.drawable && h === a) {
      if (rand() < 1 / (1 + Math.exp(-dElo / 400 * 2))) { h++; hMin = [...hMin, cfg.duration]; } else { a++; aMin = [...aMin, cfg.duration]; }
    }
    return { kind: 'goals', hs: h, as: a, hMin, aMin, dElo };
  }

  if (cfg.model === 'points') {
    const margin = dElo * cfg.eloToMargin + gauss(rand) * cfg.sd;
    const total = Math.max(cfg.baseTotal * 0.6, cfg.baseTotal + gauss(rand) * cfg.sd * 1.4);
    let hs = Math.max(0, Math.round((total + margin) / 2));
    let as = Math.max(0, Math.round((total - margin) / 2));
    if (hs === as) { if (margin >= 0) hs++; else as++; }
    return { kind: 'points', hs, as, dElo };
  }

  // versus: urutan pemenang set
  const k = Math.ceil(cfg.bestOf / 2);
  const ps = solveSetProb(eloExpected(dElo), k);
  const seq = [];
  let h = 0, a = 0;
  while (h < k && a < k) {
    if (rand() < ps) { h++; seq.push('H'); } else { a++; seq.push('A'); }
  }
  return { kind: 'sets', hs: h, as: a, seq, dElo };
}

function periodLabel(sportId, progress, state) {
  switch (sportId) {
    case 'basketball': case 'americanfootball': return `Q${Math.min(4, Math.max(1, Math.ceil(progress * 4)))}`;
    case 'icehockey': return `P${Math.min(3, Math.max(1, Math.ceil(progress * 3)))}`;
    case 'baseball': return `Inning ${Math.min(9, Math.max(1, Math.ceil(progress * 9)))}`;
    case 'rugby': case 'futsal': return progress < 0.5 ? 'Babak 1' : 'Babak 2';
    case 'mma': return `Ronde ${Math.min(3, Math.max(1, Math.ceil(progress * 3)))}`;
    case 'esports': return `Map ${state.h + state.a + 1}`;
    default: return `Set ${state.h + state.a + 1}`;
  }
}

function demoStats(sportId, progress, dElo, rand) {
  if (sportId !== 'football' && sportId !== 'basketball') return null;
  const lean = Math.max(-0.25, Math.min(0.25, dElo / 900));
  const split = (total, share) => {
    const h = Math.round(total * share);
    return [h, Math.round(total) - h];
  };
  if (sportId === 'football') {
    const pos = Math.round(50 + lean * 100);
    const shots = split((8 + rand() * 10) * 2 * progress, 0.5 + lean);
    const onT = [Math.round(shots[0] * 0.38), Math.round(shots[1] * 0.38)];
    const corners = split((4 + rand() * 6) * 2 * progress, 0.5 + lean * 0.6);
    const fouls = split((9 + rand() * 6) * 2 * progress, 0.5 - lean * 0.3);
    return [
      { key: 'possession', label: 'Penguasaan bola', home: pos, away: 100 - pos, unit: '%' },
      { key: 'shots', label: 'Tembakan', home: shots[0], away: shots[1] },
      { key: 'sot', label: 'Tembakan tepat sasaran', home: onT[0], away: onT[1] },
      { key: 'corners', label: 'Sepak pojok', home: corners[0], away: corners[1] },
      { key: 'fouls', label: 'Pelanggaran', home: fouls[0], away: fouls[1] },
    ];
  }
  const fg = [Math.round(44 + lean * 30 + rand() * 4), Math.round(44 - lean * 30 + rand() * 4)];
  const reb = split((40 + rand() * 10) * 2 * progress, 0.5 + lean * 0.5);
  const ast = split((20 + rand() * 8) * 2 * progress, 0.5 + lean * 0.6);
  const tov = split((11 + rand() * 5) * 2 * progress, 0.5 - lean * 0.4);
  return [
    { key: 'fg', label: 'Akurasi tembakan', home: fg[0], away: fg[1], unit: '%' },
    { key: 'reb', label: 'Rebound', home: reb[0], away: reb[1] },
    { key: 'ast', label: 'Assist', home: ast[0], away: ast[1] },
    { key: 'tov', label: 'Turnover', home: tov[0], away: tov[1] },
  ];
}

/**
 * Jadwal round-robin (metode lingkaran): tiap tim bertemu semua lawan sekali per putaran,
 * sehingga pasangan yang sama tidak muncul berulang dalam waktu dekat. g = nomor laga liga (boleh negatif).
 */
function pairing(T, g) {
  const half = T / 2, rounds = T - 1, per = half * rounds;
  const idx = ((g % per) + per) % per;
  const leg = Math.floor(g / per);
  const r = Math.floor(idx / half), p = idx % half;
  let a, b;
  if (p === 0) { a = T - 1; b = r % rounds; } else {
    a = (r + p) % rounds;
    b = (((r - p) % rounds) + rounds) % rounds;
  }
  const flip = (r + p + leg) % 2 === 1;
  return flip ? [b, a] : [a, b];
}

function buildMatch(L, k, n, now) {
  const cfg = SPORTS_BY_ID[L.sport];
  const id = `demo:${L.id}-${k}-${n}`;
  const rand = rng(`m|${L.id}|${k}|${n}`);
  const [hi, ai] = pairing(L.teams.length, k * L.per + n);
  const home = L.teams[hi];
  const away = L.teams[ai];
  const kickoffMs = k * L.slot * MIN + slotOffset(L) + n * L.stagger * MIN;
  const out = simulateOutcome(L, cfg, home, away, rand);
  const elapsed = (now - kickoffMs) / MIN;

  let status = 'upcoming';
  if (elapsed >= L.real) status = 'finished';
  else if (elapsed >= 0) status = 'live';

  const m = {
    id, sport: L.sport, league: L.name, leagueId: L.id,
    home: { name: home, short: shortName(home) },
    away: { name: away, short: shortName(away) },
    kickoff: new Date(kickoffMs).toISOString(),
    status, minute: null, period: null, progress: status === 'finished' ? 1 : 0,
    score: null, stats: null, events: [], venue: null, source: 'demo',
  };

  if (status === 'upcoming') return m;
  if (status === 'finished') {
    m.score = { home: out.hs, away: out.as };
    m.period = 'Selesai';
    if (out.kind === 'goals') {
      m.events = [...out.hMin.map((min) => ({ type: 'goal', minute: min, side: 'home' })), ...out.aMin.map((min) => ({ type: 'goal', minute: min, side: 'away' }))].sort((a, b) => a.minute - b.minute);
    }
    m.stats = demoStats(L.sport, 1, out.dElo, rng(`st|${id}`));
    return m;
  }

  // Sedang berlangsung
  let progress;
  let minute;
  if (L.sport === 'football') {
    if (elapsed < 45) { minute = Math.floor(elapsed); m.period = '1H'; }
    else if (elapsed < 60) { minute = 45; m.period = 'Turun minum'; }
    else { minute = 45 + Math.floor(elapsed - 60); m.period = '2H'; }
    minute = Math.min(90, Math.max(1, minute));
    progress = minute / 90;
  } else {
    progress = Math.min(0.999, elapsed / L.real);
    minute = Math.max(1, Math.round(progress * cfg.duration));
  }
  m.progress = progress;
  m.minute = minute;

  if (out.kind === 'goals') {
    const gm = progress * cfg.duration;
    const h = out.hMin.filter((x) => x <= gm).length;
    const a = out.aMin.filter((x) => x <= gm).length;
    m.score = { home: h, away: a };
    m.events = [
      ...out.hMin.filter((x) => x <= gm).map((min) => ({ type: 'goal', minute: min, side: 'home' })),
      ...out.aMin.filter((x) => x <= gm).map((min) => ({ type: 'goal', minute: min, side: 'away' })),
    ].sort((x, y) => x.minute - y.minute);
    m.period = m.period || periodLabel(L.sport, progress, { h, a });
  } else if (out.kind === 'points') {
    const h = Math.floor(out.hs * progress);
    const a = Math.floor(out.as * progress);
    m.score = { home: h, away: a };
    m.period = periodLabel(L.sport, progress, { h, a });
  } else {
    const done = Math.floor(progress * out.seq.length);
    const h = out.seq.slice(0, done).filter((x) => x === 'H').length;
    const a = done - h;
    m.score = { home: h, away: a };
    m.period = periodLabel(L.sport, progress, { h, a });
  }
  m.stats = demoStats(L.sport, Math.max(progress, 0.05), out.dElo, rng(`st|${id}|${Math.floor(progress * 20)}`));
  return m;
}

export function createDemoProvider({ now = () => Date.now() } = {}) {
  function matchesBetween(fromMs, toMs, sportIds) {
    const t = now();
    const out = [];
    for (const L of LEAGUES) {
      if (sportIds && !sportIds.includes(L.sport)) continue;
      const slotMs = L.slot * MIN;
      const off = slotOffset(L);
      const first = Math.floor((fromMs - off - L.per * L.stagger * MIN) / slotMs) - 1;
      const last = Math.ceil((toMs - off) / slotMs) + 1;
      for (let k = first; k <= last; k++) {
        for (let n = 0; n < L.per; n++) {
          const m = buildMatch(L, k, n, t);
          const ko = Date.parse(m.kickoff);
          if (ko >= fromMs && ko <= toMs) out.push(m);
        }
      }
    }
    return out;
  }

  return {
    name: 'demo',
    isDemo: true,
    async listMatches({ from, to, sports = null }) {
      return matchesBetween(from, to, sports);
    },
    async getMatch(id) {
      const mm = /^demo:([a-z0-9]+)-(-?\d+)-(\d+)$/.exec(String(id));
      if (!mm) return null;
      const L = LEAGUES_BY_ID[mm[1]];
      if (!L) return null;
      const n = Number(mm[3]);
      if (n >= L.per) return null;
      const k = Number(mm[2]);
      // Hanya laga di sekitar "sekarang" yang ada: mencegah id karangan (jauh di masa depan/lalu) dianggap laga sungguhan.
      const kickoff = k * L.slot * MIN + slotOffset(L) + n * L.stagger * MIN;
      if (!Number.isSafeInteger(k) || kickoff < now() - 60 * 24 * 60 * MIN || kickoff > now() + 30 * 24 * 60 * MIN) return null;
      return buildMatch(L, k, n, now());
    },
    /** Pertandingan selesai selama `days` hari ke belakang, untuk menghangatkan rating. */
    history(days = 30) {
      const t = now();
      return matchesBetween(t - days * 24 * 60 * MIN, t, null).filter((m) => m.status === 'finished');
    },
    leagues: LEAGUES.map(({ id, sport, name }) => ({ id, sport, name })),
  };
}
