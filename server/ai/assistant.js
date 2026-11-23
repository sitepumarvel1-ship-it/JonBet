// Asisten JonBet lintas laga: menjawab pertanyaan seperti "laga live sekarang", "favorit malam ini", "jadwal Arsenal",
// "hasil basket kemarin", "paling ketat besok" dari daftar laga (yang sudah memuat prakiraan model).
// Murni: tanpa jaringan dan tanpa DOM, jadi dipakai sama oleh server dan browser, dan mudah diuji.
// Bukan model bahasa: ia memahami pertanyaan dengan aturan (cabang, liga, tim, waktu, jenis permintaan), mengingat
// konteks percakapan sebelumnya, lalu menyusun jawaban dari angka. Ia mengaku bila tidak mengerti atau datanya kosong.
// Tidak menyebut odds dan tidak memberi saran bertaruh.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WIB = 7 * HOUR; // Asia/Jakarta tidak memakai waktu musim panas
const MAX_LIST = 6;

const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const P = (x) => `${Math.round(x * 100)}%`;
const dayStart = (t) => Math.floor((t + WIB) / DAY) * DAY - WIB;
const GENERIC = new Set(['fc', 'sc', 'cf', 'ac', 'as', 'the', 'de', 'del', 'la', 'le', 'el', 'club', 'team', 'tim', 'sport', 'sports', 'afc', 'bk', 'fk', 'sk', 'if', 'cd', 'ud', 'city', 'united', 'real', 'sporting', 'athletic', 'atletico', 'olympique', 'inter', 'borussia', 'new', 'los', 'san']);
const LEAGUE_GENERIC = new Set(['league', 'liga', 'division', 'cup', 'the', 'of', 'de', 'la', 'championship', 'series', 'tour']);

const fmtWhen = (t) => {
  try {
    return `${new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).replace(/\./g, ':')} WIB`;
  } catch { return new Date(t).toISOString(); }
};

/* ------------------------------------------------------------------ cabang */

const SPORT_WORDS = [
  ['volleyball', /\b(bola voli|voli|volley|volleyball)\b/],
  ['americanfootball', /\b(football amerika|american football|nfl|sepak bola amerika)\b/],
  ['football', /\b(sepak bola|sepakbola|soccer|bola|football|liga inggris|liga champions|bundesliga|la liga|serie a)\b/],
  ['futsal', /\b(futsal)\b/],
  ['basketball', /\b(basket|basketball|nba|wnba)\b/],
  ['baseball', /\b(baseball|mlb|bisbol)\b/],
  ['rugby', /\b(rugby)\b/],
  ['icehockey', /\b(hoki es|hoki|hockey|nhl)\b/],
  ['tennis', /\b(tenis|tennis|atp|wta)\b/],
  ['badminton', /\b(bulu tangkis|bulutangkis|badminton)\b/],
  ['esports', /\b(esports?|e sports?|game online)\b/],
  ['mma', /\b(mma|ufc|tinju|bela diri)\b/],
];

function sportsIn(q, known) {
  const hits = [];
  for (const [id, re] of SPORT_WORDS) if (re.test(q) && (!known || known.has(id))) hits.push(id);
  // "bola voli" sudah menang atas "bola"; "football amerika" atas "football".
  if (hits.includes('volleyball')) return hits.filter((x) => x !== 'football');
  if (hits.includes('americanfootball')) return hits.filter((x) => x !== 'football');
  return hits;
}

/* ------------------------------------------------------------------ waktu */

/** @returns {{from:number,to:number,label:string,explicit:boolean}|null} */
function windowIn(q, now) {
  const d0 = dayStart(now);
  let base = null;
  let label = '';
  if (/\bkemarin\b/.test(q)) { base = d0 - DAY; label = 'kemarin'; }
  else if (/\blusa\b/.test(q)) { base = d0 + 2 * DAY; label = 'lusa'; }
  else if (/\bbesok\b/.test(q)) { base = d0 + DAY; label = 'besok'; }
  else if (/\b(hari ini|malam ini|pagi ini|siang ini|sore ini|tadi malam|tadi pagi|tadi)\b/.test(q)) { base = d0; label = 'hari ini'; }
  if (/\bminggu ini|pekan ini|seminggu\b/.test(q)) return { from: now - 2 * DAY, to: now + 7 * DAY, label: 'pekan ini', explicit: true };
  if (base === null) return null;
  let from = base;
  let to = base + DAY;
  if (/\btadi malam\b/.test(q)) { from = d0 - 6 * HOUR; to = d0 + 6 * HOUR; label = 'tadi malam'; }
  else if (/\bmalam\b/.test(q)) { from = base + 18 * HOUR; to = base + DAY + 6 * HOUR; label = `${label === 'hari ini' ? 'malam ini' : `${label} malam`}`; }
  else if (/\bpagi\b/.test(q)) { from = base + 4 * HOUR; to = base + 11 * HOUR; label = `${label} pagi`; }
  else if (/\bsiang\b/.test(q)) { from = base + 11 * HOUR; to = base + 15 * HOUR; label = `${label} siang`; }
  else if (/\bsore\b/.test(q)) { from = base + 15 * HOUR; to = base + 18 * HOUR; label = `${label} sore`; }
  return { from, to, label, explicit: true };
}

/* ------------------------------------------------------------------ liga dan tim */

const LEAGUE_ALIAS = [
  [/\b(liga inggris|epl|premier league)\b/, /premier|english/],
  [/\b(la liga|laliga|liga spanyol)\b/, /la liga|spanish/],
  [/\b(serie a|liga italia)\b/, /serie a|italian/],
  [/\b(bundesliga|liga jerman)\b/, /bundesliga|german/],
  [/\b(ligue 1|liga prancis)\b/, /ligue 1|french/],
  [/\b(liga champions|champions league|ucl)\b/, /champions/],
  [/\b(liga europa|europa league)\b/, /europa league/],
  [/\b(liga indonesia|liga 1 indonesia|bri liga)\b/, /indonesia/],
];

function leaguesIn(q, matches) {
  const names = [...new Set(matches.map((m) => m.league).filter(Boolean))];
  const hit = new Set();
  for (const [ask, want] of LEAGUE_ALIAS) if (ask.test(q)) for (const n of names) if (want.test(norm(n))) hit.add(n);
  if (hit.size) return [...hit];
  for (const n of names) {
    const nn = norm(n);
    if (nn.length >= 3 && ` ${q} `.includes(` ${nn} `)) { hit.add(n); continue; }
    const toks = nn.split(' ').filter((w) => w.length >= 3 && !LEAGUE_GENERIC.has(w));
    if (!toks.length) continue;
    const have = toks.filter((w) => q.split(' ').includes(w)).length;
    if (have >= Math.max(1, Math.ceil(toks.length / 2)) && toks.some((w) => w.length >= 4 && q.split(' ').includes(w))) hit.add(n);
  }
  return [...hit];
}

/** Tim yang disebut: semua kata pembeda nama tim ada di pertanyaan, atau satu kata yang hanya dimiliki satu tim. */
function teamsIn(q, matches) {
  const words = new Set(q.split(' '));
  const teams = new Map(); // nama -> kata pembeda
  for (const m of matches) for (const t of [m.home?.name, m.away?.name]) if (t && !teams.has(t)) teams.set(t, [...new Set(norm(t).split(' ').filter((w) => w.length >= 3 && !GENERIC.has(w)))]);
  const owners = new Map(); // kata -> jumlah tim yang memilikinya
  for (const toks of teams.values()) for (const w of toks) owners.set(w, (owners.get(w) || 0) + 1);
  const hit = [];
  for (const [name, toks] of teams) {
    if (!toks.length) continue;
    const full = toks.every((w) => words.has(w));
    const unique = toks.some((w) => words.has(w) && owners.get(w) === 1);
    if (full || unique) hit.push(name);
  }
  return hit;
}

/* ------------------------------------------------------------------ jenis permintaan */

const KINDS = [
  ['count', /\b(berapa|jumlah|banyak)\b.*\b(laga|pertandingan|match|game)\b/],
  ['live', /\b(live|langsung|sedang (main|bermain|berlangsung|bertanding)|lagi (main|berlangsung)|berlangsung|skor (sekarang|terkini|live))\b/],
  ['results', /\b(hasil|selesai|skor akhir|sudah (main|selesai))\b/],
  ['close', /\b(ketat|seimbang|sengit|kejutan|upset|underdog|imbang)\b/],
  ['picks', /\b(favorit|jagoan|prediksi|ramalan|tebakan|unggulan|rekomendasi|terbaik|paling (yakin|pasti|berpeluang|aman|kuat)|menang)\b/],
  ['schedule', /\b(jadwal|kapan|jam berapa|main|bermain|bertanding|akan|nanti|mendatang|siapa)\b/],
];
const MORE = /\b(lagi|lainnya|yang lain|selanjutnya|berikutnya|lanjut|sisanya)\b/;

const BET = /\b(taruh|taruhan|bet|betting|odds?|judi|bandar|cuan|profit|handicap|parlay|togel|kalah menang uang)\b/;
const OUTSIDE = /\b(cuaca|cedera|injury|susunan pemain|lineup|kartu|wasit|berita|transfer|pelatih|suporter|motivasi|gaji|harga)\b/;
const GREET = /^(halo|hai|hi|hello|selamat|pagi|siang|malam|test|tes|p)\b/;
const THANKS = /\b(terima kasih|makasih|thanks|thx)\b/;
const HELP = /\b(bisa apa|apa saja|bantu|bantuan|fitur|help|fungsi|cara pakai|cara menggunakan)\b/;

const nameOf = (m, side) => (side === 'H' ? m.home.name : side === 'A' ? m.away.name : 'Seri');

function line(m) {
  const f = m.forecast;
  const lg = m.league ? `, ${m.league}` : '';
  if (m.status === 'live' || m.status === 'finished') {
    const sc = m.score ? `${m.score.home}–${m.score.away}` : '?–?';
    const state = m.status === 'finished' ? 'selesai' : Number.isFinite(m.minute) && ['football', 'futsal', 'icehockey'].includes(m.sport) ? `menit ${m.minute}` : m.period || 'live';
    const lead = f && m.status === 'live' ? `; peluang ${nameOf(m, f.pick)} ${P(f.pickP)}` : '';
    return `${m.home.name} ${sc} ${m.away.name} (${state}${lg})${lead}`;
  }
  const pick = f ? `; model memilih ${nameOf(m, f.pick)} ${P(f.pickP)}` : '';
  return `${m.home.name} vs ${m.away.name} (${fmtWhen(Date.parse(m.kickoff))}${lg})${pick}`;
}

const spread = (m) => (m.forecast ? Math.abs(m.forecast.home - m.forecast.away) : 1);
const strength = (m) => (m.forecast ? m.forecast.pickP * (0.5 + m.forecast.confidence / 200) : 0);

export function suggestAssistant(ctx = null) {
  const base = ['Laga live sekarang', 'Favorit malam ini', 'Jadwal besok', 'Hasil kemarin', 'Laga paling ketat hari ini'];
  if (ctx?.sportName) return [`Laga live ${ctx.sportName}`, `Jadwal ${ctx.sportName} besok`, ...base.slice(0, 3)];
  return base;
}

/**
 * @param {{question: string, matches: object[], sports?: {id:string,name:string}[], now?: number, context?: object|null}} args
 * @returns {{reply: string, matchIds: string[], suggestions: string[], context: object|null}}
 */
export function answerGlobal({ question, matches = [], sports = [], now = Date.now(), context = null }) {
  const raw = String(question || '');
  const q = norm(raw);
  const sportName = (id) => sports.find((s) => s.id === id)?.name?.toLowerCase() || id;
  const done = (reply, ids = [], ctx = null) => ({ reply, matchIds: ids.slice(0, MAX_LIST), suggestions: suggestAssistant(ctx), context: ctx });

  if (BET.test(q)) return done('Saya tidak memberi saran bertaruh dan JonBet tidak menyediakan odds atau taruhan. Saya hanya merangkum jadwal, skor, dan peluang statistik. Perjudian online dilarang di Indonesia dan berisiko merugikan. Coba tanyakan misalnya "laga live sekarang" atau "favorit malam ini".');
  if (!q) return done('Tulis pertanyaannya, misalnya "laga live sekarang" atau "jadwal basket besok".');
  if (THANKS.test(q)) return done('Sama-sama. Mau lihat laga lain?', [], context);
  if (HELP.test(q) || (GREET.test(q) && q.length < 25)) {
    return done('Halo! Saya JonBet AI. Saya bisa merangkum semua laga di JonBet: yang sedang live, jadwal (per cabang, liga, atau tim), hasil, favorit menurut model, dan laga yang paling ketat. Sebut waktunya ("hari ini", "besok malam", "kemarin") dan saya ingat topik sebelumnya, jadi boleh menyambung: "kalau basket?". Untuk analisis mendalam satu laga, buka halaman laganya lalu tanya di sana.');
  }
  if (OUTSIDE.test(q) && !sportsIn(q, null).length && !teamsIn(q, matches).length) {
    return done('Itu tidak ada di data JonBet (cedera, susunan pemain, cuaca, wasit, dan berita tidak dihitung). Yang bisa saya jawab: laga live, jadwal, hasil, favorit menurut model, dan laga paling ketat.', [], context);
  }

  /* ---- baca pertanyaan ---- */
  const fSports = sportsIn(q, null); // cabang yang disebut tetap dihormati walau belum ada lajanya: jawabannya "tidak ada", bukan semua cabang
  const fLeagues = leaguesIn(q, matches);
  const fTeams = teamsIn(q, matches);
  const win = windowIn(q, now);
  let kind = KINDS.find(([, re]) => re.test(q))?.[0] || null;
  const hasFilter = !!(fSports.length || fLeagues.length || fTeams.length || win);

  let eff = { sports: fSports, leagues: fLeagues, teams: fTeams, win };
  let offset = 0;
  if (!kind && context?.kind) {
    if (MORE.test(q) && !hasFilter) { kind = context.kind; eff = { sports: context.sports || [], leagues: context.leagues || [], teams: context.teams || [], win: context.win || null }; offset = (context.offset || 0) + MAX_LIST; }
    else if (hasFilter) { // sambungan: "kalau basket?", "besok?", "Arsenal?"
      kind = context.kind;
      eff = {
        sports: fSports.length ? fSports : fLeagues.length || fTeams.length ? [] : context.sports || [],
        leagues: fLeagues.length ? fLeagues : fSports.length || fTeams.length ? [] : context.leagues || [],
        teams: fTeams.length ? fTeams : [],
        win: win || context.win || null,
      };
    }
  }
  // Kata waktu saja ("besok", "kemarin") tanpa konteks: laga yang sudah lewat = hasil, selebihnya = jadwal.
  if (!kind && fTeams.length) kind = 'team';
  if (!kind && (fSports.length || fLeagues.length || win)) kind = win && win.to <= now ? 'results' : 'schedule';
  if (!kind) {
    return done('Saya belum menangkap maksudnya. Saya bisa menjawab hal seperti: "laga live sekarang", "favorit malam ini", "jadwal basket besok", "hasil kemarin", "kapan Arsenal main", atau "laga paling ketat hari ini". Untuk analisis satu laga, buka halaman laganya lalu tanya di sana.', [], context);
  }

  /* ---- saring laga ---- */
  const ctxOut = {
    kind, sports: eff.sports, leagues: eff.leagues, teams: eff.teams, win: eff.win, offset,
    sportName: eff.sports.length === 1 ? sportName(eff.sports[0]) : null,
  };
  const scope = [
    eff.sports.length ? eff.sports.map(sportName).join(' dan ') : null,
    eff.leagues.length ? (eff.leagues.length > 2 ? `${eff.leagues.length} liga` : eff.leagues.join(' dan ')) : null,
    eff.teams.length ? eff.teams.join(' dan ') : null,
  ].filter(Boolean).join(', ');
  const inScope = (m) => (!eff.sports.length || eff.sports.includes(m.sport))
    && (!eff.leagues.length || eff.leagues.includes(m.league))
    && (!eff.teams.length || eff.teams.includes(m.home?.name) || eff.teams.includes(m.away?.name));
  const base = matches.filter(inScope);
  const kick = (m) => Date.parse(m.kickoff);
  const tail = (list, shown, note = '') => {
    const more = list.length - shown.length - offset;
    return `${more > 0 ? `\n…dan ${more} lainnya (tulis "yang lain" untuk melanjutkan).` : ''}${note}`;
  };
  const page = (list) => list.slice(offset, offset + MAX_LIST);
  const bullets = (list) => list.map((m) => `• ${line(m)}`).join('\n');
  const noBet = '\n\nIni peluang statistik, bukan kepastian dan bukan saran bertaruh.';
  const where = scope ? ` untuk ${scope}` : '';

  if (kind === 'count') {
    const t = base.filter((m) => !eff.win || (kick(m) >= eff.win.from && kick(m) < eff.win.to));
    const by = (s) => t.filter((m) => m.status === s).length;
    return done(`${eff.win ? `Untuk ${eff.win.label}` : 'Dalam data JonBet'}${where}: ${t.length} laga (${by('live')} live, ${by('upcoming')} akan datang, ${by('finished')} selesai).`, [], ctxOut);
  }

  if (kind === 'live') {
    const list = base.filter((m) => m.status === 'live').sort((a, b) => kick(a) - kick(b));
    if (!list.length) {
      const next = base.filter((m) => m.status === 'upcoming' && kick(m) > now).sort((a, b) => kick(a) - kick(b))[0];
      return done(`Tidak ada laga live${where} saat ini di data JonBet.${next ? ` Berikutnya: ${line(next)}.` : ''}`, next ? [next.id] : [], ctxOut);
    }
    const shown = page(list);
    return done(`${list.length} laga live${where}:\n${bullets(shown)}${tail(list, shown)}`, shown.map((m) => m.id), ctxOut);
  }

  if (kind === 'results') {
    const w = eff.win || { from: now - 36 * HOUR, to: now + HOUR, label: '36 jam terakhir' };
    const list = base.filter((m) => m.status === 'finished' && kick(m) >= w.from - 3 * HOUR && kick(m) < w.to).sort((a, b) => kick(b) - kick(a));
    ctxOut.win = w;
    if (!list.length) return done(`Belum ada hasil laga selesai${where} untuk ${w.label} di data JonBet.`, [], ctxOut);
    const shown = page(list);
    return done(`${list.length} hasil${where} (${w.label}):\n${bullets(shown)}${tail(list, shown)}`, shown.map((m) => m.id), ctxOut);
  }

  const w = eff.win || { from: now - HOUR, to: now + 48 * HOUR, label: '48 jam ke depan' };
  ctxOut.win = w;
  const upcoming = base.filter((m) => m.status === 'upcoming' && kick(m) >= w.from && kick(m) < w.to);

  if (kind === 'close') {
    const list = upcoming.filter((m) => m.forecast).sort((a, b) => spread(a) - spread(b));
    if (!list.length) return done(`Tidak ada laga yang akan datang${where} untuk ${w.label} di data JonBet.`, [], ctxOut);
    const shown = page(list);
    const text = shown.map((m) => `• ${m.home.name} vs ${m.away.name} (${fmtWhen(kick(m))}): ${P(m.forecast.home)} lawan ${P(m.forecast.away)}${m.forecast.draw ? `, seri ${P(m.forecast.draw)}` : ''}`).join('\n');
    return done(`Laga paling ketat${where} (${w.label}), selisih peluang terkecil:\n${text}${tail(list, shown)}${noBet}`, shown.map((m) => m.id), ctxOut);
  }

  if (kind === 'picks') {
    const list = upcoming.filter((m) => m.forecast).sort((a, b) => strength(b) - strength(a));
    if (!list.length) return done(`Tidak ada laga yang akan datang${where} untuk ${w.label} di data JonBet.`, [], ctxOut);
    const shown = page(list);
    const text = shown.map((m) => `• ${m.home.name} vs ${m.away.name} (${fmtWhen(kick(m))}): ${nameOf(m, m.forecast.pick)} ${P(m.forecast.pickP)}, keyakinan model ${m.forecast.confidence}/100`).join('\n');
    return done(`Pilihan model yang paling kuat${where} (${w.label}):\n${text}${tail(list, shown)}${noBet}`, shown.map((m) => m.id), ctxOut);
  }

  if (kind === 'team') {
    const mine = base.filter((m) => kick(m) >= now - 3 * DAY && kick(m) < now + 10 * DAY);
    if (!mine.length) return done(`Saya tidak menemukan laga ${eff.teams.join(' / ')} dalam beberapa hari ke depan atau ke belakang di data JonBet.`, [], ctxOut);
    const order = { live: 0, upcoming: 1, finished: 2 };
    mine.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (a.status === 'finished' ? kick(b) - kick(a) : kick(a) - kick(b)));
    const shown = mine.slice(0, MAX_LIST);
    return done(`Laga ${eff.teams.join(' / ')}:\n${bullets(shown)}${noBet}`, shown.map((m) => m.id), ctxOut);
  }

  // jadwal
  // Laga yang sudah berjalan ikut hanya bila jendelanya mencakup saat ini.
  const list = base.filter((m) => (m.status === 'live' ? now >= w.from && now < w.to : m.status === 'upcoming' && kick(m) >= w.from && kick(m) < w.to)).sort((a, b) => kick(a) - kick(b));
  if (!list.length) {
    const next = base.filter((m) => m.status === 'upcoming' && kick(m) >= w.to).sort((a, b) => kick(a) - kick(b))[0];
    return done(`Tidak ada jadwal${where} untuk ${w.label} di data JonBet.${next ? ` Laga terdekat setelah itu: ${line(next)}.` : ''}`, next ? [next.id] : [], ctxOut);
  }
  const shown = page(list);
  return done(`${list.length} laga${where} (${w.label}):\n${bullets(shown)}${tail(list, shown)}`, shown.map((m) => m.id), ctxOut);
}

/* ------------------------------------------------------------------ konteks dari klien */

const KIND_OK = new Set(['count', 'live', 'results', 'close', 'picks', 'schedule', 'team']);
const strList = (x, max, len) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string').slice(0, max).map((v) => v.slice(0, len)) : []);

/**
 * Konteks percakapan datang dari klien, jadi tidak dipercaya: hanya kunci yang dikenal, tipe dan ukuran dibatasi.
 * Berlaku untuk asisten lintas laga maupun tanya jawab satu laga ({ids, side}).
 */
export function cleanContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (KIND_OK.has(raw.kind)) out.kind = raw.kind;
  out.sports = strList(raw.sports, 12, 24);
  out.leagues = strList(raw.leagues, 10, 80);
  out.teams = strList(raw.teams, 6, 80);
  out.ids = strList(raw.ids, 3, 16);
  if (raw.side === 'H' || raw.side === 'A') out.side = raw.side;
  if (Number.isInteger(raw.offset) && raw.offset >= 0 && raw.offset < 500) out.offset = raw.offset;
  if (typeof raw.sportName === 'string') out.sportName = raw.sportName.slice(0, 30);
  const w = raw.win;
  if (w && Number.isFinite(w.from) && Number.isFinite(w.to) && w.to > w.from && w.to - w.from <= 30 * DAY) out.win = { from: w.from, to: w.to, label: String(w.label || '').slice(0, 30), explicit: !!w.explicit };
  return out;
}
