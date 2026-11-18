import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { state, setUser, emit, on } from '../state.js';
import { emptyBox, errorBox, loadingBox, localNotice, predCard, toast } from '../components.js';
import { pctInt } from '../format.js';
import { navigate } from '../router.js';

function tiles(p) {
  const t = (label, value) => h('div', { class: 'tile' }, h('small', {}, label), h('strong', {}, value));
  return h('div', { class: 'stat-tiles' }, t('Poin', String(p.points)), t('Akurasi', p.accuracy === null ? '-' : pctInt(p.accuracy)), t('Tebakan dinilai', String(p.settled)), t('Menang beruntun', String(p.streak)));
}

export function profileView({ params }) {
  const root = h('div', { class: 'page' }, loadingBox());
  let off;

  async function show(username, mine) {
    try {
      const p = await api(`/api/users/${encodeURIComponent(username)}`);
      mount(root,
        h('div', { class: 'section-head' }, h('h2', {}, mine ? `Halo, ${p.username}` : p.username),
          mine ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); setUser(null); toast('Kamu sudah keluar.'); navigate('/'); } }, 'Keluar') : null),
        localNotice(),
        tiles(p),
        h('p', { class: 'muted' }, `${p.pending} tebakan menunggu hasil. Bergabung ${new Date(p.joinedAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}.`),
        h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', {}, 'Riwayat tebakan')),
          p.recent.length ? p.recent.map((x) => predCard(x)) : emptyBox('Belum ada tebakan', 'Pilih pertandingan yang belum mulai untuk memulai.', h('a', { class: 'btn btn-sm', href: '#/matches?status=upcoming' }, 'Lihat jadwal'))));
    } catch (e) { mount(root, errorBox(e, () => init())); }
  }

  function init() {
    if (params.name) return show(params.name, state.user?.username === params.name);
    if (!state.user) {
      mount(root, h('div', { class: 'card empty' }, h('strong', {}, 'Masuk untuk melihat profilmu'),
        h('p', {}, 'Simpan tebakan, kumpulkan poin, dan naik di peringkat komunitas.'),
        h('div', { class: 'sticky-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => emit('need-auth', 'login') }, 'Masuk'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => emit('need-auth', 'register') }, 'Daftar'))));
      off = on('user', (u) => { if (u) show(u.username, true); });
      return Promise.resolve();
    }
    return show(state.user.username, true);
  }

  return { el: root, init, refresh: null, destroy: () => off?.(), title: 'Profil' };
}
