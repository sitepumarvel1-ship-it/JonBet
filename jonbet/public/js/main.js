import { h, mount } from './dom.js';
import { api } from './api.js';
import { state, setUser, on } from './state.js';
import { STATIC } from './mode.js';
import { logoMark } from './logo.js';
import { icon } from './icons.js';
import { route, start, parseHash } from './router.js';
import { initAuth, openAuth } from './auth.js';
import { liveCard, matchRow, emptyBox } from './components.js';
import { homeView } from './views/home.js';
import { matchesView } from './views/matches.js';
import { matchView } from './views/match.js';
import { communityView } from './views/community.js';
import { profileView } from './views/profile.js';
import { aboutView } from './views/about.js';

const NAV = [
  ['/', 'Beranda', 'home'],
  ['/matches', 'Pertandingan', 'list'],
  ['/community', 'Komunitas', 'people'],
  ['/me', 'Profil', 'user'],
];

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; document.dispatchEvent(new CustomEvent('jb:installable')); });

function renderFatal(err) {
  mount(document.getElementById('app'),
    h('div', { class: 'gate' }, h('div', { class: 'gate-box' }, logoMark('logo'),
      h('h2', {}, err?.status === 0 ? 'JonBet butuh internet' : 'JonBet belum bisa dibuka'),
      h('p', {}, err?.status === 0 ? 'Aplikasi ini hanya berjalan saat kamu online, supaya jadwal dan skor selalu terbaru. Periksa koneksi lalu coba lagi.' : (err?.message || 'Terjadi kesalahan.')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, 'Coba lagi'))));
}

/* ------------------------------------------------------------ gerbang offline */

function setupOfflineGate() {
  let gate = null;
  const show = () => {
    if (gate) return;
    gate = h('div', { class: 'gate', role: 'alertdialog', 'aria-labelledby': 'gate-title', 'aria-describedby': 'gate-desc' },
      h('div', { class: 'gate-box' }, logoMark('logo'),
        h('h2', { id: 'gate-title' }, 'JonBet butuh internet'),
        h('p', { id: 'gate-desc' }, 'Aplikasi ini hanya berjalan saat kamu online, supaya jadwal, skor, dan analisis selalu terbaru.'),
        h('button', { class: 'btn btn-primary', type: 'button', id: 'gate-retry', onclick: retry }, icon('refresh', { size: 18 }), 'Coba lagi')));
    document.body.append(gate);
    gate.querySelector('#gate-retry').focus();
  };
  const hide = () => { gate?.remove(); gate = null; };
  async function retry() {
    try { await api('/api/health'); hide(); document.dispatchEvent(new CustomEvent('jb:refresh')); } catch { /* tetap tampil */ }
  }
  on('offline', (off) => (off ? show() : hide()));
  window.addEventListener('offline', () => { state.offline = true; show(); });
  window.addEventListener('online', retry);
  if (!navigator.onLine) show();
}

/* ----------------------------------------------------------------- kerangka */

function statusChip() {
  const el = h('span', { class: 'status-chip', role: 'status' }, h('i'), h('span'));
  const draw = () => {
    const c = state.config;
    el.classList.toggle('is-demo', !!c.demo);
    if (STATIC && !c.demo) {
      // Versi GitHub Pages: data disegarkan berkala oleh GitHub Actions, jadi tampilkan jam datanya, bukan "langsung".
      const t = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
      if (c.live?.state === 'live') {
        el.classList.remove('is-stale');
        el.lastChild.textContent = 'Skor langsung';
        el.title = `Skor live diambil langsung dari ESPN tiap ±20 detik untuk ${c.live.covered} laga. Laga lain memakai data jadwal (${t}) yang disegarkan tiap beberapa menit.`;
        return;
      }
      el.classList.toggle('is-stale', !!c.stale || c.live?.state === 'down');
      el.lastChild.textContent = c.stale ? 'Data tertunda' : `Data ${t}`.trim();
      el.title = c.live?.state === 'down'
        ? 'Sumber skor langsung sedang tidak bisa dihubungi, jadi skor live memakai data jadwal dan bisa terlambat beberapa menit.'
        : 'Jadwal dan skor disegarkan otomatis tiap beberapa menit; skor live bisa terlambat dari pertandingan sebenarnya.';
      return;
    }
    el.lastChild.textContent = c.demo ? (c.fallbackActive ? 'Demo (sumber nyata gagal)' : 'Data simulasi') : 'Data langsung';
    el.title = c.demo ? 'Liga dan skor fiktif untuk mencoba aplikasi' : 'Jadwal dan skor dari sumber data olahraga';
  };
  draw();
  const sync = async () => {
    if (document.visibilityState !== 'visible') return;
    try { state.config = { ...state.config, ...(await api('/api/config')) }; draw(); } catch { /* abaikan */ }
  };
  setInterval(sync, 60000);
  if (STATIC) document.addEventListener('jb:live', sync);
  return el;
}

function userButton() {
  const el = h('span');
  const draw = () => {
    const u = state.user;
    mount(el, u
      ? h('a', { class: 'btn btn-ghost btn-sm', href: '#/me', 'aria-label': `Profil ${u.username}` }, icon('user', { size: 18 }), h('span', { class: 'uname' }, u.username))
      : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openAuth('login') }, 'Masuk'));
  };
  draw();
  on('user', draw);
  return el;
}

function installButton() {
  const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', hidden: true, onclick: async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; btn.hidden = true; } }, 'Pasang');
  const upd = () => { btn.hidden = !deferredInstall || window.matchMedia('(display-mode: standalone)').matches; };
  document.addEventListener('jb:installable', upd);
  upd();
  return btn;
}

function navItems(cls) {
  return NAV.map(([href, label, ic]) => h('a', { class: 'tab', href: `#${href}`, dataset: { path: href } }, icon(ic), h('span', {}, label)));
}

function sidePanel() {
  const body = h('div', { class: 'section' });
  async function load() {
    if (!matchMedia('(min-width: 1320px)').matches) return;
    try {
      const r = await api('/api/matches?status=live&limit=8');
      mount(body, h('div', { class: 'section-head' }, h('h2', {}, 'Live sekarang')),
        r.matches.length ? h('div', { class: 'rows' }, r.matches.map(matchRow)) : emptyBox('Belum ada laga live'));
    } catch { /* biarkan isi terakhir */ }
  }
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 20000);
  document.addEventListener('jb:refresh', load);
  if (STATIC) document.addEventListener('jb:live', load);
  return body;
}

function buildShell() {
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Navigasi utama' }, ...navItems(),
    h('div', { class: 'nav-foot' }, h('a', { href: '#/about' }, 'Cara kerja dan batasan'), h('span', {}, 'Bukan saran bertaruh.')));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Navigasi utama' }, ...navItems());

  const app = h('div', { class: 'app' },
    h('a', { class: 'sr-only', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'Lewati ke konten'),
    h('header', { class: 'header' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'JonBet, ke beranda' }, logoMark(), h('span', { class: 'wordmark' }, 'Jon', h('b', {}, 'Bet'))),
      h('span', { class: 'header-gap' }), statusChip(), installButton(), userButton()),
    nav, main,
    h('aside', { class: 'side', 'aria-label': 'Panel samping' }, sidePanel()),
    tabbar);
  mount(document.getElementById('app'), app);

  const mark = () => {
    const { path } = parseHash();
    for (const a of document.querySelectorAll('.tab')) {
      const p = a.dataset.path;
      const on = p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`) || (p === '/matches' && path.startsWith('/match/')) || (p === '/me' && path.startsWith('/u/'));
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
  };
  document.addEventListener('jb:route', mark);
  return main;
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  let config, me;
  try {
    [config, me] = await Promise.all([api('/api/config'), api('/api/me')]);
  } catch (err) { renderFatal(err); return; }
  state.config = config;
  state.user = me.user;

  const main = buildShell();
  initAuth();
  setupOfflineGate();

  route('/', homeView);
  route('/matches', matchesView);
  route('/match/:id', matchView);
  route('/community', communityView);
  route('/me', profileView);
  route('/u/:name', profileView);
  route('/about', aboutView);
  route('/404', () => ({ el: h('div', { class: 'page' }, emptyBox('Halaman tidak ditemukan', 'Alamat yang kamu buka tidak ada di JonBet.', h('a', { class: 'btn btn-sm', href: '#/' }, 'Ke beranda'))), title: 'Tidak ditemukan' }));
  start(main);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* PWA opsional */ });
  }
}

boot();
