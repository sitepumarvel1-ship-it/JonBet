import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { sportIcon } from '../icons.js';
import { demoNotice, emptyBox, errorBox, loadingBox, matchRow } from '../components.js';
import { addDays, dayLabel, sameDay, startOfDay } from '../format.js';
import { parseHash, setQuery } from '../router.js';
import { STATIC } from '../mode.js';

const STATUSES = [['all', 'Semua'], ['live', 'Live'], ['upcoming', 'Akan datang'], ['finished', 'Selesai']];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };

export function matchesView({ query }) {
  const today = startOfDay(new Date());
  const f = {
    sport: state.config.sports.some((s) => s.id === query.sport) ? query.sport : '',
    status: STATUSES.some(([k]) => k === query.status) ? query.status : 'all',
    date: parseYmd(query.date) || today,
    q: (query.q || '').slice(0, 60),
  };

  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'section' }, loadingBox());
  let hasData = false;
  let reqId = 0;

  function persist() {
    setQuery({ sport: f.sport, status: f.status === 'all' ? '' : f.status, date: sameDay(f.date, today) ? '' : ymd(f.date), q: f.q });
  }

  /* ---- kontrol filter (satu baris di atas konten) ---- */
  const dateStrip = h('div', { class: 'date-strip', role: 'group', 'aria-label': 'Tanggal' });
  const statusSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' });
  const sportStrip = h('div', { class: 'scroller', role: 'group', 'aria-label': 'Cabang olahraga' });
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Cari tim atau liga', 'aria-label': 'Cari tim atau liga', value: f.q, maxlength: 60, autocomplete: 'off' });
  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { f.q = search.value.trim(); persist(); load(); }, 300); });

  function drawControls() {
    // Versi statis hanya menyimpan data kemarin sampai 4 hari ke depan, jadi tombol tanggal mengikutinya.
    const days = STATIC ? Array.from({ length: 6 }, (_, i) => addDays(today, i - 1)) : Array.from({ length: 9 }, (_, i) => addDays(today, i - 2));
    mount(dateStrip, days.map((d) => {
      const rel = sameDay(d, today) ? 'Hari ini' : sameDay(d, addDays(today, 1)) ? 'Besok' : sameDay(d, addDays(today, -1)) ? 'Kemarin' : dayLabel(d).split(',')[0];
      return h('button', { class: 'date-btn', type: 'button', 'aria-pressed': String(sameDay(d, f.date)), onclick: () => { f.date = d; persist(); drawControls(); load(); } },
        h('small', {}, rel), h('strong', {}, String(d.getDate())));
    }));
    mount(statusSeg, STATUSES.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(f.status === k), onclick: () => { f.status = k; persist(); drawControls(); load(); } }, label)));
    mount(sportStrip,
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(!f.sport), onclick: () => { f.sport = ''; persist(); drawControls(); load(); } }, sportIcon('all'), 'Semua'),
      state.config.sports.map((s) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.sport === s.id), onclick: () => { f.sport = s.id; persist(); drawControls(); load(); } }, sportIcon(s.id), s.name)));
  }

  /* ---- daftar ---- */
  function group(matches) {
    const by = new Map();
    for (const m of matches) {
      const key = `${m.sport}|${m.league}`;
      if (!by.has(key)) by.set(key, { sport: m.sport, league: m.league, items: [] });
      by.get(key).items.push(m);
    }
    return [...by.values()].sort((a, b) => {
      const la = a.items.some((m) => m.status === 'live') ? 0 : 1;
      const lb = b.items.some((m) => m.status === 'live') ? 0 : 1;
      return la - lb || a.league.localeCompare(b.league, 'id');
    });
  }

  async function load() {
    const my = ++reqId;
    if (hasData) body.classList.add('is-refreshing');
    const from = startOfDay(f.date).getTime();
    const to = addDays(startOfDay(f.date), 1).getTime() - 1;
    const params = new URLSearchParams({ from: String(from), to: String(to), status: f.status, limit: '400' });
    if (f.sport) params.set('sport', f.sport);
    if (f.q) params.set('q', f.q);
    try {
      const r = await api(`/api/matches?${params}`);
      if (my !== reqId) return;
      hasData = true;
      body.classList.remove('is-refreshing');
      const groups = group(r.matches);
      mount(body,
        r.meta.demo ? demoNotice() : null,
        r.meta.stale ? h('div', { class: 'notice', role: 'status' }, h('p', {}, h('strong', {}, 'Data tertunda. '), 'Sumber data sedang tidak merespons, jadi yang tampil adalah data terakhir yang berhasil diambil.')) : null,
        groups.length
          ? groups.map((g) => h('section', { class: 'league' },
            h('div', { class: 'league-head' }, sportIcon(g.sport), h('span', {}, g.league), h('span', { class: 'muted' }, `${g.items.length} laga`)),
            h('div', { class: 'rows' }, g.items.map(matchRow))))
          : emptyBox('Tidak ada pertandingan', 'Coba ganti tanggal, status, atau cabang olahraga.',
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { f.sport = ''; f.status = 'all'; f.q = ''; search.value = ''; f.date = today; persist(); drawControls(); load(); } }, 'Atur ulang filter')));
    } catch (err) {
      if (my !== reqId) return;
      body.classList.remove('is-refreshing');
      if (!hasData) mount(body, errorBox(err, load));
    }
  }

  drawControls();
  mount(root,
    h('div', { class: 'filters' }, dateStrip, h('div', { class: 'filter-row' }, statusSeg, search), sportStrip),
    body);
  void parseHash;
  return { el: root, init: load, refresh: load, title: 'Pertandingan' };
}
