import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { sportIcon, icon } from '../icons.js';
import { demoNotice, errorBox, liveCard, loadingBox, matchRow, predCard, sectionHead, emptyBox } from '../components.js';
import { pctInt } from '../format.js';
import { STATIC } from '../mode.js';

const HOUR = 3600_000;

function sportChips(counts) {
  const sports = state.config.sports;
  return h('div', { class: 'scroller', role: 'list', 'aria-label': 'Cabang olahraga' }, sports.map((s) => {
    const live = counts?.[s.id]?.live || 0;
    return h('a', { class: 'chip', role: 'listitem', href: `#/matches?sport=${s.id}`, 'aria-label': `${s.name}${live ? `, ${live} laga live` : ''}` },
      sportIcon(s.id), s.name, live ? h('span', { class: 'count' }, String(live)) : null);
  }));
}

function modelTile(rec) {
  const src = rec.backtest.n >= 20 ? rec.backtest : rec.live;
  const acc = src.accuracy;
  return h('div', { class: 'card card-pad hero-number' },
    h('div', { class: 'v' }, acc === null ? '-' : pctInt(acc)),
    h('div', { class: 'l' }, acc === null
      ? 'Rekam jejak model akan muncul setelah ada hasil pertandingan.'
      : `Tebakan pemenang model yang tepat, dari ${src.n} laga uji-mundur.`),
    h('p', { class: 'disclaimer' }, rec.demo
      ? 'Dihitung dari data simulasi, jadi angka ini tidak membuktikan akurasi di dunia nyata.'
      : 'Uji-mundur: tiap laga ditebak memakai data sebelum laga itu terjadi. Hasil lampau tidak menjamin hasil mendatang.'),
    h('a', { class: 'more', href: '#/about' }, 'Cara model bekerja'));
}

export function homeView() {
  const root = h('div', { class: 'page' }, loadingBox());
  let loaded = false;

  async function load() {
    const now = Date.now();
    try {
      const [live, soon, feed, lb, rec] = await Promise.all([
        api('/api/matches?status=live&limit=40'),
        api(`/api/matches?status=upcoming&from=${now}&to=${now + 24 * HOUR}&limit=80`),
        api('/api/feed?sort=top&limit=3'),
        api('/api/leaderboard?period=week&limit=5'),
        api('/api/model/record'),
      ]);
      loaded = true;

      const liveList = live.matches;
      const confident = [...soon.matches].sort((a, b) => b.forecast.confidence - a.forecast.confidence).slice(0, 5);
      const close = [...soon.matches].filter((m) => !confident.includes(m)).sort((a, b) => Math.abs(a.forecast.home - a.forecast.away) - Math.abs(b.forecast.home - b.forecast.away)).slice(0, 5);

      mount(root,
        state.config.demo ? demoNotice() : null,
        h('section', { class: 'section', 'aria-labelledby': 'h-live' },
          h('div', { class: 'section-head' }, h('h2', { id: 'h-live' }, 'Sedang berlangsung'), h('a', { class: 'more', href: '#/matches?status=live' }, 'Lihat semua')),
          liveList.length
            ? h('div', { class: 'live-strip' }, liveList.slice(0, 14).map(liveCard))
            : emptyBox('Belum ada laga yang sedang berlangsung', soon.matches[0] ? `Laga terdekat: ${soon.matches[0].home.name} lawan ${soon.matches[0].away.name}.` : 'Cek lagi nanti atau lihat jadwal hari ini.',
              h('a', { class: 'btn btn-sm', href: '#/matches' }, 'Lihat jadwal'))),
        h('section', { class: 'section' }, sectionHead('Cabang olahraga'), sportChips(live.counts)),
        h('div', { class: 'grid-2' },
          h('section', { class: 'section' }, sectionHead('Model paling yakin', { href: '#/matches?status=upcoming', text: 'Jadwal lengkap' }),
            confident.length ? h('div', { class: 'rows' }, confident.map(matchRow)) : emptyBox('Belum ada jadwal 24 jam ke depan')),
          h('section', { class: 'section' }, sectionHead('Paling ketat'),
            close.length ? h('div', { class: 'rows' }, close.map(matchRow)) : emptyBox('Belum ada jadwal 24 jam ke depan'))),
        h('div', { class: 'grid-2' },
          h('section', { class: 'section' }, sectionHead(STATIC ? 'Tebakan di perangkat ini' : 'Tebakan komunitas', { href: '#/community', text: STATIC ? 'Buka tebakan' : 'Buka komunitas' }),
            feed.items.length ? h('div', { class: 'rows' }, feed.items.map((p) => predCard(p)))
              : emptyBox('Belum ada tebakan', 'Jadilah yang pertama membagikan tebakanmu di halaman pertandingan.', h('a', { class: 'btn btn-sm', href: '#/matches?status=upcoming' }, 'Pilih pertandingan'))),
          h('div', { class: 'section' },
            h('section', { class: 'section' }, sectionHead('Peringkat minggu ini', { href: '#/community?tab=peringkat', text: 'Selengkapnya' }),
              lb.rows.length
                ? h('div', { class: 'card' }, h('table', { class: 'rank-table' }, h('tbody', {}, lb.rows.map((r) =>
                  h('tr', { class: r.rank === 1 ? 'top1' : '' }, h('td', { class: 'n' }, String(r.rank)), h('td', {}, h('a', { href: `#/u/${encodeURIComponent(r.username)}` }, r.username)), h('td', { class: 'r' }, `${r.points} poin`))))))
                : emptyBox('Peringkat masih kosong', 'Poin muncul setelah tebakan dinilai.')),
            h('section', { class: 'section' }, sectionHead('Rekam jejak model'), modelTile(rec)))));
    } catch (err) {
      if (!loaded) mount(root, errorBox(err, load));
      else throw err;
    }
  }

  return { el: root, init: load, refresh: load, title: 'Beranda' };
}
