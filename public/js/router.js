// Router hash sederhana: #/path?query. Tiap rute mengembalikan {el, init?, refresh?, destroy?, title?}.
const routes = [];
let current = null;
let token = 0;
let container;
let timer = null;

export function route(pattern, factory) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:[a-z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; })}$`);
  routes.push({ re, keys, factory });
}

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { path: path || '/', query };
}

export function navigate(path) {
  if (location.hash.replace(/^#/, '') === path) render();
  else location.hash = path;
}

export function setQuery(patch) {
  const { path, query } = parseHash();
  const q = { ...query, ...patch };
  for (const k of Object.keys(q)) if (q[k] === null || q[k] === undefined || q[k] === '') delete q[k];
  const s = new URLSearchParams(q).toString();
  history.replaceState(null, '', `#${path}${s ? `?${s}` : ''}`);
}

let firstRender = true;

async function render() {
  const my = ++token;
  const { path, query } = parseHash();
  let match = null;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      try { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; } catch { match = null; } // %-escape rusak => 404
      break;
    }
  }
  if (current?.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
  current = null;
  window.scrollTo(0, 0);

  const view = match ? match.r.factory({ params: match.params, query, path }) : routes.find((r) => r.re.test('/404'))?.factory({ params: {}, query, path });
  if (my !== token) return;
  current = view;
  container.replaceChildren(view.el);
  document.title = view.title ? `${view.title} | JonBet` : 'JonBet';
  document.dispatchEvent(new CustomEvent('jb:route', { detail: { path } }));
  if (!firstRender) container.focus({ preventScroll: true }); // jangan merebut fokus saat muat awal: tautan lompat tetap yang pertama
  firstRender = false;
  if (view.init) await view.init();
}

export function start(el) {
  container = el;
  window.addEventListener('hashchange', render);
  render();
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (current?.refresh) current.refresh().catch?.(() => {});
  }, 15000);
  // Skor langsung berubah (mode statis): segarkan tampilan yang sedang dibuka, sedikit ditunda agar beruntun tidak berulang.
  let liveTimer = null;
  document.addEventListener('jb:live', () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (document.visibilityState === 'visible' && current?.refresh) current.refresh().catch?.(() => {}); }, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current?.refresh) current.refresh().catch?.(() => {});
  });
}

export const refreshCurrent = () => current?.refresh?.();
