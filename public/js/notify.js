// Ikuti laga dan notifikasi lokal (gol, mulai, selesai) selama JonBet terbuka, termasuk saat tab ada di latar belakang.
// Tidak ada server: notifikasi dipicu dari pemantau skor langsung di browser (js/static/live.js) dan ditampilkan lewat service worker.
// Batas yang jujur: ketika aplikasi ditutup atau browser membekukan tab (layar mati lama, penghemat baterai, iPhone), pembaruan berhenti.
// Notifikasi saat aplikasi tertutup butuh server push, yang tidak ada di GitHub Pages.
const FKEY = 'jonbet.follows';
const SKEY = 'jonbet.notify';
const MAX_FOLLOWS = 50;

const store = () => { try { return window.localStorage; } catch { return null; } };
function read(key, def) {
  try { const v = JSON.parse(store()?.getItem(key) ?? 'null'); return v ?? def; } catch { return def; }
}
function write(key, value) { try { store()?.setItem(key, JSON.stringify(value)); } catch { /* penyimpanan penuh atau diblokir */ } }

export const supported = () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
export const permission = () => (supported() ? Notification.permission : 'unsupported');

export function followed() {
  const v = read(FKEY, []);
  return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_FOLLOWS) : []);
}
export const isFollowing = (id) => followed().has(id);
export function setFollow(id, on) {
  const s = followed();
  if (on) {
    if (!s.has(id) && s.size >= MAX_FOLLOWS) throw new Error(`Paling banyak ${MAX_FOLLOWS} laga yang bisa diikuti. Berhenti mengikuti sebagian dulu.`);
    s.add(id);
  } else s.delete(id);
  write(FKEY, [...s]);
  document.dispatchEvent(new CustomEvent('jb:follow'));
  syncWakeLock();
}

export const settings = () => ({ on: false, awake: false, ...(read(SKEY, {}) || {}) });
function saveSettings(patch) {
  write(SKEY, { ...settings(), ...patch });
  document.dispatchEvent(new CustomEvent('jb:follow'));
  syncWakeLock();
}

/** Harus dipanggil dari ketukan pengguna (syarat browser untuk meminta izin). */
export async function enableNotifications() {
  if (!supported()) throw new Error('Browser ini belum mendukung notifikasi. Di iPhone, tambahkan JonBet ke Layar Utama dulu (Bagikan, Tambah ke Layar Utama), lalu buka dari ikonnya.');
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p === 'denied') throw new Error('Notifikasi diblokir untuk situs ini. Izinkan lewat pengaturan situs di browser, lalu coba lagi.');
  if (p !== 'granted') throw new Error('Izin notifikasi belum diberikan.');
  saveSettings({ on: true });
}
export const disableNotifications = () => saveSettings({ on: false });
export const setKeepAwake = (awake) => saveSettings({ awake: !!awake });

/** Perlu tetap memantau walau tab tersembunyi? */
export const isActive = () => settings().on && permission() === 'granted' && followed().size > 0;

const GOAL_WORD = { football: 'Gol', futsal: 'Gol', icehockey: 'Gol', rugby: 'Poin' };
const unit = (m) => GOAL_WORD[m.sport] || 'Skor berubah';

/** Teks notifikasi untuk satu kejadian dari pemantau. */
export function textFor(e) {
  const m = e.match;
  const sc = `${m.home.name} ${e.score.home}–${e.score.away} ${m.away.name}`;
  const when = Number.isFinite(e.minute) && ['football', 'futsal', 'icehockey'].includes(m.sport) ? `, menit ${e.minute}` : e.period ? `, ${e.period}` : '';
  if (e.type === 'goal') {
    const who = e.side === 'H' ? m.home.name : e.side === 'A' ? m.away.name : '';
    return { title: `${unit(m)}${who ? `! ${who}` : ''}`, body: `${sc}${when}`, tag: `jb-${m.id}-goal-${e.score.home}-${e.score.away}` };
  }
  if (e.type === 'start') return { title: 'Pertandingan dimulai', body: `${m.home.name} lawan ${m.away.name}`, tag: `jb-${m.id}-start` };
  return { title: 'Pertandingan selesai', body: sc, tag: `jb-${m.id}-end` };
}

/** Tampilkan notifikasi bila laganya diikuti dan izin ada. @returns {Promise<boolean>} */
export async function notifyEvent(e) {
  if (!settings().on || permission() !== 'granted' || !isFollowing(e?.match?.id)) return false;
  const { title, body, tag } = textFor(e);
  const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/favicon-64.png', data: { hash: `#/match/${encodeURIComponent(e.match.id)}` } };
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg?.showNotification) await reg.showNotification(title, opts);
    else new Notification(title, opts);
    return true;
  } catch {
    return false;
  }
}

/* ---- layar tetap menyala (opsional) ---- */
let lock = null;
export async function syncWakeLock() {
  try {
    const want = settings().awake && followed().size > 0 && document.visibilityState === 'visible' && 'wakeLock' in navigator;
    if (want && !lock) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!want && lock) {
      const l = lock;
      lock = null;
      await l.release();
    }
  } catch { lock = null; /* ditolak (mis. baterai hemat): abaikan */ }
}

export function initNotify() {
  document.addEventListener('visibilitychange', () => { syncWakeLock(); });
  syncWakeLock();
  // Ketukan pada notifikasi (dari service worker) membuka laganya.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const hash = ev.data?.type === 'jb:open' ? String(ev.data.hash || '') : '';
      if (/^#\/match\/[^/?#\s]+$/.test(hash)) location.hash = hash.slice(1);
    });
  }
}
