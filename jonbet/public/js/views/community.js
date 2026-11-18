import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { state, on } from '../state.js';
import { emptyBox, errorBox, loadingBox, localNotice, predCard, sectionHead } from '../components.js';
import { pctInt } from '../format.js';
import { setQuery } from '../router.js';

export function rankTable(rows) {
  if (!rows.length) return emptyBox('Peringkat masih kosong', 'Poin muncul setelah tebakan dinilai. Benar +10 sampai +20 poin (bonus skor tepat +10), meleset mengurangi poin sesuai keyakinan.');
  return h('div', { class: 'card' }, h('table', { class: 'rank-table' },
    h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Pengguna'), h('th', { class: 'r' }, 'Poin'), h('th', { class: 'r' }, 'Akurasi'), h('th', { class: 'r' }, 'Laga'))),
    h('tbody', {}, rows.map((r) => h('tr', { class: r.rank === 1 ? 'top1' : '' },
      h('td', { class: 'n' }, String(r.rank)),
      h('td', {}, h('a', { href: `#/u/${encodeURIComponent(r.username)}` }, r.username)),
      h('td', { class: 'r' }, String(r.points)),
      h('td', { class: 'r' }, r.accuracy === null ? '-' : pctInt(r.accuracy)),
      h('td', { class: 'r' }, String(r.settled)))))));
}

export function communityView({ query }) {
  const f = { tab: query.tab === 'peringkat' ? 'peringkat' : 'feed', sort: query.sort === 'top' ? 'top' : 'new', sport: state.config.sports.some((s) => s.id === query.sport) ? query.sport : '', period: query.period === 'all' ? 'all' : 'week' };
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'section' }, loadingBox());
  const controls = h('div', { class: 'filter-row' });
  let reqId = 0;
  let has = false;

  function drawControls() {
    const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Bagian komunitas' },
      h('button', { type: 'button', 'aria-pressed': String(f.tab === 'feed'), onclick: () => { f.tab = 'feed'; persist(); drawControls(); load(); } }, 'Tebakan'),
      h('button', { type: 'button', 'aria-pressed': String(f.tab === 'peringkat'), onclick: () => { f.tab = 'peringkat'; persist(); drawControls(); load(); } }, 'Peringkat'));
    let sub;
    if (f.tab === 'feed') {
      const sel = h('select', { class: 'input', 'aria-label': 'Filter cabang olahraga', style: { width: 'auto', minHeight: '40px' } },
        h('option', { value: '' }, 'Semua olahraga'), state.config.sports.map((s) => h('option', { value: s.id, selected: s.id === f.sport }, s.name)));
      sel.addEventListener('change', () => { f.sport = sel.value; persist(); load(); });
      sub = [h('div', { class: 'seg', role: 'group', 'aria-label': 'Urutan' },
        h('button', { type: 'button', 'aria-pressed': String(f.sort === 'new'), onclick: () => { f.sort = 'new'; persist(); drawControls(); load(); } }, 'Terbaru'),
        h('button', { type: 'button', 'aria-pressed': String(f.sort === 'top'), onclick: () => { f.sort = 'top'; persist(); drawControls(); load(); } }, 'Terpopuler')), sel];
    } else {
      sub = [h('div', { class: 'seg', role: 'group', 'aria-label': 'Periode' },
        h('button', { type: 'button', 'aria-pressed': String(f.period === 'week'), onclick: () => { f.period = 'week'; persist(); drawControls(); load(); } }, 'Minggu ini'),
        h('button', { type: 'button', 'aria-pressed': String(f.period === 'all'), onclick: () => { f.period = 'all'; persist(); drawControls(); load(); } }, 'Sepanjang waktu'))];
    }
    mount(controls, tabs, ...sub);
  }

  const persist = () => setQuery({ tab: f.tab === 'feed' ? '' : f.tab, sort: f.sort === 'new' ? '' : f.sort, sport: f.sport, period: f.period === 'week' ? '' : f.period });

  async function load() {
    const my = ++reqId;
    if (has) body.classList.add('is-refreshing');
    try {
      if (f.tab === 'feed') {
        const p = new URLSearchParams({ sort: f.sort, limit: '40' });
        if (f.sport) p.set('sport', f.sport);
        const r = await api(`/api/feed?${p}`);
        if (my !== reqId) return;
        mount(body, r.items.length ? r.items.map((x) => predCard(x)) : emptyBox('Belum ada tebakan', 'Buka pertandingan yang belum mulai, lalu bagikan tebakanmu di tab Komunitas.', h('a', { class: 'btn btn-sm', href: '#/matches?status=upcoming' }, 'Pilih pertandingan')));
      } else {
        const r = await api(`/api/leaderboard?period=${f.period}&limit=50`);
        if (my !== reqId) return;
        mount(body, rankTable(r.rows), h('p', { class: 'disclaimer' }, 'Poin hanya reputasi di JonBet. Tidak ada uang atau hadiah taruhan.'));
      }
      has = true;
      body.classList.remove('is-refreshing');
    } catch (e) {
      if (my !== reqId) return;
      body.classList.remove('is-refreshing');
      if (!has) mount(body, errorBox(e, load));
    }
  }

  drawControls();
  mount(root, sectionHead('Komunitas'), localNotice(), controls, body);
  let off = null;
  return {
    el: root,
    init: () => { off = on('user', () => load()); return load(); },
    refresh: load,
    destroy: () => off?.(),
    title: 'Komunitas',
  };
}
