// Statistik lengkap per pertandingan dari sumber terbuka tanpa kunci: ringkasan laga ESPN (boxscore, pemain kunci, jalannya laga),
// boxscore MLB Stats API, dan NHL (right-rail + landing). Hasilnya dinormalkan ke bentuk yang dipakai tampilan:
//   stats:   [{ label, home, away, unit? }]        angka saja (untuk grafik batang perbandingan)
//   events:  [{ type: 'goal'|'yellow'|'red', side, minute, clock, player }]
//   leaders: [{ label, home: {player, value}|null, away: {...}|null }]
//
// Catatan jujur: bentuk respons ditulis dari dokumentasi/pengetahuan publik, tanpa akses ke layanan aslinya dari lingkungan
// pengembangan. Pembaca sengaja toleran: field yang tidak ada dilewati, bukan melempar galat, dan kegagalan satu laga tidak
// menggagalkan yang lain.

const str = (x, n = 60) => String(x ?? '').trim().slice(0, n);
const FEED_RE = /^[a-z]+\/[a-z0-9._-]{1,40}$/i;
const NUM_ID_RE = /^[0-9]{1,12}$/;
const MAX_ROWS = 14;
const USER_AGENT = 'JonBet/1.0 (aplikasi prediksi olahraga nirlaba; pembaca data publik)';

/** "55.2" -> 55.2, "12" -> 12, "62%" -> {n:62, unit:'%'}, "3-7" -> {n:3, made:true}; selain itu null. */
export function parseStatValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { n: v } : null;
  const s = String(v ?? '').trim();
  let m = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (m) return { n: Number(m[1]), unit: '%' };
  m = /^(-?\d+(?:\.\d+)?)$/.exec(s);
  if (m) return { n: Number(m[1]) };
  m = /^(\d+)\s*[-/]\s*(\d+)$/.exec(s);
  if (m) return { n: Number(m[1]), made: true };
  return null;
}

const round1 = (x) => Math.round(x * 10) / 10;

// Nama statistik ESPN -> label Indonesia. Yang tidak dikenal dipakai apa adanya dari `label` ESPN (Inggris).
const ID_LABELS = {
  possessionPct: 'Penguasaan bola', totalShots: 'Tembakan', shotsOnTarget: 'Tembakan tepat sasaran', blockedShots: 'Tembakan diblok',
  wonCorners: 'Tendangan sudut', foulsCommitted: 'Pelanggaran', yellowCards: 'Kartu kuning', redCards: 'Kartu merah', saves: 'Penyelamatan',
  offsides: 'Offside', accuratePasses: 'Umpan akurat', totalPasses: 'Total umpan', passPct: 'Akurasi umpan', effectiveTackles: 'Tekel berhasil',
  totalTackles: 'Tekel', interceptions: 'Intersep', totalClearance: 'Sapuan', longBalls: 'Umpan panjang', accurateCrosses: 'Umpan silang akurat',
  totalCrosses: 'Umpan silang', penaltyKickGoals: 'Gol penalti',
  fieldGoalsMade: 'Field goal berhasil', fieldGoalPct: 'Persentase field goal', threePointFieldGoalPct: 'Persentase tripoin', freeThrowPct: 'Persentase lemparan bebas',
  totalRebounds: 'Rebound', assists: 'Assist', steals: 'Steal', blocks: 'Blok', turnovers: 'Turnover', fouls: 'Pelanggaran', pointsInPaint: 'Poin di area cat',
  fastBreakPoints: 'Poin serangan balik', offensiveRebounds: 'Rebound ofensif', defensiveRebounds: 'Rebound defensif',
  firstDowns: 'First down', totalYards: 'Total yard', netPassingYards: 'Yard operan', rushingYards: 'Yard lari', penalties: 'Penalti',
  hits: 'Hit', shotsTotal: 'Tembakan', powerPlayGoals: 'Gol power play', takeaways: 'Takeaway', giveaways: 'Giveaway',
};

function sideOfTeam(t, header) {
  const ha = str(t?.homeAway, 6).toLowerCase();
  if (ha === 'home' || ha === 'away') return ha;
  const id = str(t?.team?.id, 20);
  const comp = header?.competitions?.[0]?.competitors;
  const c = Array.isArray(comp) ? comp.find((x) => str(x?.team?.id ?? x?.id, 20) === id) : null;
  const h = str(c?.homeAway, 6).toLowerCase();
  return h === 'home' || h === 'away' ? h : null;
}

/** Bandingkan dua daftar statistik {name,label,displayValue} per nama. */
function pairStats(homeList, awayList) {
  const rows = [];
  const awayBy = new Map((Array.isArray(awayList) ? awayList : []).map((s) => [str(s?.name, 40), s]));
  for (const s of Array.isArray(homeList) ? homeList : []) {
    const name = str(s?.name, 40);
    const o = awayBy.get(name);
    if (!name || !o) continue;
    const a = parseStatValue(s.displayValue ?? s.value);
    const b = parseStatValue(o.displayValue ?? o.value);
    if (!a || !b) continue;
    const base = ID_LABELS[name] || str(s.label || s.name, 40);
    if (!base) continue;
    const made = a.made || b.made;
    // Selaraskan: dua sisi harus sejenis (angka biasa, persen, atau "berhasil-percobaan")
    if (!!a.made !== !!b.made) continue;
    // Nama berakhiran "Pct" adalah persentase; sebagian laga memberi pecahan 0-1 (0.78), sebagian 0-100 (58.5).
    const pct = !made && /Pct$/.test(name);
    const unit = a.unit || b.unit || (pct ? '%' : undefined);
    const k = pct && !a.unit && !b.unit && a.n <= 1 && b.n <= 1 && (a.n > 0 || b.n > 0) ? 100 : 1;
    rows.push({ label: made ? `${base} (berhasil)` : base, home: round1(a.n * k), away: round1(b.n * k), ...(unit ? { unit } : {}) });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

const clockMinute = (txt) => {
  const m = /^(\d{1,3})\s*'?(?:\s*\+\s*(\d{1,2}))?/.exec(str(txt, 12));
  return m ? Math.min(150, Number(m[1]) + (m[2] ? Number(m[2]) : 0)) : null;
};

function eventType(text, scoring) {
  const t = String(text || '').toLowerCase();
  if (scoring || /\bgoal\b/.test(t) && !/disallowed|no goal/.test(t)) return 'goal';
  if (/red card|second yellow/.test(t)) return 'red';
  if (/yellow card/.test(t)) return 'yellow';
  return null;
}

function parseEspnEvents(json, ids) {
  const list = Array.isArray(json?.keyEvents) && json.keyEvents.length ? json.keyEvents : Array.isArray(json?.header?.competitions?.[0]?.details) ? json.header.competitions[0].details : [];
  const out = [];
  for (const e of list) {
    const type = eventType(e?.type?.text ?? e?.type?.type, e?.scoringPlay === true);
    if (!type) continue;
    const side = ids.get(str(e?.team?.id, 20));
    if (!side) continue;
    const clock = str(e?.clock?.displayValue ?? e?.time?.displayValue, 12);
    const p = e?.participants?.[0]?.athlete?.displayName ?? e?.athletesInvolved?.[0]?.displayName ?? null;
    out.push({ type, side, minute: clockMinute(clock), clock, player: p ? str(p, 40) : null });
    if (out.length >= 40) break;
  }
  return out;
}

function parseEspnLeaders(json, ids) {
  const byCat = new Map();
  for (const t of Array.isArray(json?.leaders) ? json.leaders : []) {
    const side = ids.get(str(t?.team?.id, 20));
    if (!side) continue;
    for (const c of Array.isArray(t?.leaders) ? t.leaders : []) {
      const cat = str(c?.displayName || c?.name, 40);
      const top = c?.leaders?.[0];
      const player = str(top?.athlete?.displayName ?? top?.athlete?.shortName, 40);
      if (!cat || !player) continue;
      const row = byCat.get(cat) || { label: cat, home: null, away: null };
      row[side] = { player, value: str(top?.displayValue ?? top?.value, 40) };
      byCat.set(cat, row);
    }
  }
  return [...byCat.values()].slice(0, 8);
}

/** Ringkasan laga ESPN -> { stats, events, leaders }. */
export function parseEspnSummary(json) {
  const teams = Array.isArray(json?.boxscore?.teams) ? json.boxscore.teams : [];
  const ids = new Map();
  const bySide = {};
  for (const t of teams) {
    const side = sideOfTeam(t, json?.header);
    const id = str(t?.team?.id, 20);
    if (side && id) { ids.set(id, side); bySide[side] = t; }
  }
  // Tim hanya ada di header/leaders (mis. tanpa boxscore): ambil peta id dari header
  for (const c of Array.isArray(json?.header?.competitions?.[0]?.competitors) ? json.header.competitions[0].competitors : []) {
    const id = str(c?.team?.id ?? c?.id, 20);
    const h = str(c?.homeAway, 6).toLowerCase();
    if (id && (h === 'home' || h === 'away') && !ids.has(id)) ids.set(id, h);
  }
  return {
    stats: bySide.home && bySide.away ? pairStats(bySide.home.statistics, bySide.away.statistics) : [],
    events: parseEspnEvents(json, ids),
    leaders: parseEspnLeaders(json, ids),
  };
}

const MLB_BAT = [['hits', 'Hit'], ['doubles', 'Double'], ['triples', 'Triple'], ['homeRuns', 'Home run'], ['rbi', 'RBI'], ['baseOnBalls', 'Walk'], ['strikeOuts', 'Strikeout'], ['leftOnBase', 'Pemain tertinggal di base'], ['stolenBases', 'Curian base']];

/** Boxscore MLB -> { stats }. */
export function parseMlbBoxscore(json) {
  const h = json?.teams?.home?.teamStats?.batting;
  const a = json?.teams?.away?.teamStats?.batting;
  const stats = [];
  if (h && a) {
    for (const [k, label] of MLB_BAT) {
      const x = h[k];
      const y = a[k];
      if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== null && y !== null && x !== '' && y !== '') stats.push({ label, home: Number(x), away: Number(y) });
    }
  }
  return { stats, events: [], leaders: [] };
}

const NHL_LABELS = { sog: 'Tembakan on goal', faceoffWinningPctg: 'Menang faceoff', powerPlay: 'Power play', powerPlayPctg: 'Efisiensi power play', pim: 'Menit penalti', hits: 'Hit', blockedShots: 'Tembakan diblok', giveaways: 'Giveaway', takeaways: 'Takeaway' };

/** Right-rail NHL -> { stats }. Nilai pecahan 0-1 pada kategori ...Pctg diubah ke persen. */
export function parseNhlRightRail(json) {
  const stats = [];
  for (const r of Array.isArray(json?.teamGameStats) ? json.teamGameStats : []) {
    const cat = str(r?.category, 40);
    const label = NHL_LABELS[cat];
    if (!label) continue;
    let a = parseStatValue(r.homeValue);
    let b = parseStatValue(r.awayValue);
    if (!a || !b || !!a.made !== !!b.made) continue;
    const pct = /Pctg$/.test(cat);
    const unit = pct ? '%' : a.unit || b.unit;
    const k = pct && a.n <= 1 && b.n <= 1 ? 100 : 1;
    stats.push({ label: a.made ? `${label} (berhasil)` : label, home: round1(a.n * k), away: round1(b.n * k), ...(unit ? { unit } : {}) });
  }
  return { stats, events: [], leaders: [] };
}

/** Landing NHL -> { events } (gol per babak; tim ditentukan dari singkatan tim). */
export function parseNhlLanding(json) {
  const home = str(json?.homeTeam?.abbrev, 5).toUpperCase();
  const away = str(json?.awayTeam?.abbrev, 5).toUpperCase();
  const events = [];
  for (const p of Array.isArray(json?.summary?.scoring) ? json.summary.scoring : []) {
    const n = Number(p?.periodDescriptor?.number);
    for (const g of Array.isArray(p?.goals) ? p.goals : []) {
      const ab = str(g?.teamAbbrev?.default ?? g?.teamAbbrev, 5).toUpperCase();
      const side = ab && ab === home ? 'home' : ab && ab === away ? 'away' : null;
      if (!side) continue;
      const time = str(g?.timeInPeriod, 6);
      const m = /^(\d{1,2}):(\d{2})$/.exec(time);
      const per = n >= 1 && n <= 3 ? n : null;
      events.push({
        type: 'goal', side,
        minute: m && per ? (per - 1) * 20 + Number(m[1]) + (Number(m[2]) > 0 ? 1 : 0) : null,
        clock: per ? `B${per} ${time}` : n ? `${p?.periodDescriptor?.periodType === 'SO' ? 'SO' : 'OT'} ${time}` : time,
        player: str(g?.name?.default ?? g?.firstName?.default, 40) || null,
      });
      if (events.length >= 40) return { stats: [], events, leaders: [] };
    }
  }
  return { stats: [], events, leaders: [] };
}

/* ------------------------------------------------------------------ penyedia */

export function createStatsProvider({ fetchImpl = globalThis.fetch, timeoutMs = 15_000, log = () => {} } = {}) {
  const report = { tried: 0, ok: 0, failed: [], bySource: {} };

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  /** Alamat-alamat yang perlu diambil untuk satu laga; [] bila laga ini tidak punya sumber statistik. */
  function plan(m) {
    const id = String(m?.id || '');
    if (!['live', 'finished'].includes(m?.status)) return null;
    if (id.startsWith('espn:') && FEED_RE.test(String(m.feed || '')) && NUM_ID_RE.test(String(m.espnId || id.slice(5)))) {
      return { source: 'espn', calls: [[`https://site.api.espn.com/apis/site/v2/sports/${m.feed}/summary?event=${m.espnId || id.slice(5)}`, parseEspnSummary]] };
    }
    let r = /^pub:mlb-(\d{1,10})$/.exec(id);
    if (r) return { source: 'mlb', calls: [[`https://statsapi.mlb.com/api/v1/game/${r[1]}/boxscore`, parseMlbBoxscore]] };
    r = /^pub:nhl-(\d{1,10})$/.exec(id);
    if (r) return { source: 'nhl', calls: [[`https://api-web.nhle.com/v1/gamecenter/${r[1]}/right-rail`, parseNhlRightRail], [`https://api-web.nhle.com/v1/gamecenter/${r[1]}/landing`, parseNhlLanding]] };
    return null;
  }

  return {
    name: 'matchstats',
    report,
    supports: (m) => !!plan(m),

    /** @returns {Promise<{stats, events, leaders}|null>} null bila laga tidak punya sumber atau semua panggilan gagal. */
    async fetchFor(m) {
      const p = plan(m);
      if (!p) return null;
      report.tried++;
      const per = (report.bySource[p.source] ||= { ok: 0, failed: 0, empty: 0 });
      const parts = await Promise.allSettled(p.calls.map(async ([url, parse]) => parse(await getJson(url))));
      const okParts = parts.filter((x) => x.status === 'fulfilled').map((x) => x.value);
      if (!okParts.length) {
        per.failed++;
        const why = String(parts[0].reason?.message || parts[0].reason).slice(0, 100);
        if (report.failed.length < 20) report.failed.push({ id: m.id, error: why });
        log(`statistik ${m.id} gagal: ${why}`);
        return null;
      }
      const out = { stats: [], events: [], leaders: [] };
      for (const x of okParts) { out.stats.push(...x.stats); out.events.push(...x.events); out.leaders.push(...x.leaders); }
      report.ok++;
      if (!out.stats.length && !out.events.length && !out.leaders.length) per.empty++; else per.ok++;
      return out;
    },
  };
}
