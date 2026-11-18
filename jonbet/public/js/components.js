import { h } from './dom.js';
import { icon, sportIcon } from './icons.js';
import { state, sportOf } from './state.js';
import { pctInt, clock, initials, longWhen, relative, sameDay, shortDate, untilKickoff } from './format.js';
import { probBar } from './charts.js';
import { api } from './api.js';
import { emit } from './state.js';
import { STATIC } from './mode.js';

/* ------------------------------------------------------------- dasar */

export function emblem(team, side, big = false) {
  const cls = `emblem${side ? ` ${side}` : ''}${big ? ' lg' : ''}`;
  const wrap = h('span', { class: cls, 'aria-hidden': 'true' });
  const fallback = () => wrap.replaceChildren(initials(team.name));
  if (team.badge) {
    const img = h('img', { src: team.badge, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', fallback);
    wrap.append(img);
  } else fallback();
  return wrap;
}

export function sectionHead(title, more) {
  return h('div', { class: 'section-head' }, h('h2', {}, title),
    more ? h('a', { class: 'more', href: more.href }, more.text) : null);
}

export function emptyBox(title, text, action) {
  return h('div', { class: 'card empty' }, h('strong', {}, title), text ? h('p', {}, text) : null, action || null);
}

export function errorBox(err, retry) {
  return h('div', { class: 'error-box', role: 'alert' },
    h('strong', {}, err?.status === 0 ? 'Tidak ada koneksi' : 'Data belum bisa dimuat'),
    h('p', { class: 'text-2' }, err?.message || 'Terjadi kesalahan.'),
    retry ? h('button', { class: 'btn btn-sm', type: 'button', onclick: retry }, 'Coba lagi') : null);
}

export const loadingBox = (text = 'Memuat…') => h('div', { class: 'loading', role: 'status' }, text);

/* -------------------------------------------------------------- toast */

let host;
export function toast(message, kind = 'info') {
  if (!host) { host = h('div', { class: 'toast-host', 'aria-live': 'polite' }); document.body.append(host); }
  const t = h('div', { class: `toast${kind === 'error' ? ' error' : ''}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(t);
  setTimeout(() => t.remove(), 3600);
}

/* ------------------------------------------------------ teks status */

const MINUTE_SPORTS = new Set(['football', 'futsal', 'icehockey']);

export function liveLabel(m) {
  if (MINUTE_SPORTS.has(m.sport) && Number.isFinite(m.minute)) {
    return m.period === 'Turun minum' ? 'Turun minum' : `${m.minute}'`;
  }
  return m.period || 'Live';
}

export function statusLabel(m) {
  switch (m.status) {
    case 'live': return liveLabel(m);
    case 'finished': return 'Selesai';
    case 'postponed': return 'Ditunda';
    case 'cancelled': return 'Batal';
    default: return clock(m.kickoff);
  }
}

/** Keterangan sumber skor untuk laga live (hanya mode statis, tempat sumbernya bisa berbeda per laga). */
export function liveNote(m) {
  if (!STATIC || m.status !== 'live') return null;
  if (m.liveSrc) {
    const t = new Date(m.liveSrc.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return h('p', { class: 'live-note', role: 'note' }, `Skor langsung dari ${m.liveSrc.name}, diperbarui ${t}.`);
  }
  return h('p', { class: 'live-note is-delayed', role: 'note' }, 'Skor dari data jadwal. Laga ini belum tersedia di sumber langsung, jadi bisa terlambat beberapa menit.');
}

export const livePill = (m) => h('span', { class: 'live-pill' }, h('i'), liveLabel(m));

export function teamNames(m) { return { home: m.home.name, away: m.away.name }; }

export function pickText(m) {
  const f = m.forecast;
  if (!f) return '';
  const names = { H: m.home.name, A: m.away.name, D: 'Seri' };
  return `${names[f.pick]} ${pctInt(f.pickP)}`;
}

/* ----------------------------------------------------------- kartu */

export function matchRow(m) {
  const f = m.forecast;
  const sport = sportOf(m.sport);
  const hasScore = !!m.score;
  const hw = hasScore && m.score.home > m.score.away;
  const aw = hasScore && m.score.away > m.score.home;
  return h('a', { class: 'row', href: `#/match/${encodeURIComponent(m.id)}`, 'aria-label': `${m.home.name} lawan ${m.away.name}, ${statusLabel(m)}` },
    h('div', { class: 'when' },
      m.status === 'live' ? h('strong', { class: 'live' }, liveLabel(m))
        : m.status === 'upcoming' ? h('strong', {}, clock(m.kickoff))
          : h('strong', {}, statusLabel(m)),
      m.status === 'live' ? h('span', {}, 'live') : (m.status === 'upcoming' && !sameDay(new Date(m.kickoff), new Date()) ? h('span', {}, shortDate(m.kickoff)) : null)),
    h('div', { class: 'teams' },
      h('div', { class: `t${hw ? ' lead' : ''}` }, h('span', {}, m.home.name), hasScore ? h('span', { class: 's' }, String(m.score.home)) : null),
      h('div', { class: `t${aw ? ' lead' : ''}` }, h('span', {}, m.away.name), hasScore ? h('span', { class: 's' }, String(m.score.away)) : null)),
    f ? h('div', { class: 'fc' },
      probBar({ home: f.home, draw: f.draw, away: f.away }, { drawable: !!sport?.drawable, names: teamNames(m), thin: true, legend: false }),
      h('span', {}, pickText(m))) : h('span'));
}

export function liveCard(m) {
  const f = m.forecast;
  const sport = sportOf(m.sport);
  const line = (team, side, score, lead) => h('div', { class: 'team-line' },
    emblem(team, side), h('span', { class: 'name' }, team.name), h('span', { class: 'score', style: { opacity: lead ? 1 : 0.8 } }, score === null ? '-' : String(score)));
  const sc = m.score;
  return h('a', { class: 'live-card', href: `#/match/${encodeURIComponent(m.id)}`, 'aria-label': `Live: ${m.home.name} ${sc ? sc.home : ''} lawan ${m.away.name} ${sc ? sc.away : ''}` },
    h('div', { class: 'top' }, h('span', { class: 'lg' }, `${sport?.short || ''} ${m.league}`.trim()), livePill(m)),
    h('div', { class: 'teams' },
      line(m.home, 'home', sc ? sc.home : null, sc && sc.home >= sc.away),
      line(m.away, 'away', sc ? sc.away : null, sc && sc.away >= sc.home)),
    f ? probBar({ home: f.home, draw: f.draw, away: f.away }, { drawable: !!sport?.drawable, names: teamNames(m), thin: true, legend: false }) : null,
    h('div', { class: 'foot' }, f ? `Model: ${pickText(m)}` : ''));
}

export function predCard(p, { onChange, showMatch = true } = {}) {
  const sport = sportOf(p.match.sport);
  const names = { H: p.match.home, A: p.match.away, D: 'Seri' };
  const status = { pending: 'Menunggu', won: `Benar +${p.points}`, lost: `Meleset ${p.points}`, void: 'Dibatalkan' }[p.status];
  const likeBtn = h('button', {
    class: 'like', type: 'button', 'aria-pressed': String(p.liked), 'aria-label': `Suka, ${p.likes} suka`,
    disabled: p.mine,
  }, icon('heart'), h('span', {}, String(p.likes)));
  likeBtn.addEventListener('click', async () => {
    if (!state.user) { emit('need-auth', 'login'); return; }
    try {
      const r = await api(`/api/predictions/${p.id}/like`, { method: 'POST' });
      p.liked = r.liked; p.likes = r.likes;
      likeBtn.setAttribute('aria-pressed', String(r.liked));
      likeBtn.setAttribute('aria-label', `Suka, ${r.likes} suka`);
      likeBtn.lastChild.textContent = String(r.likes);
      onChange?.();
    } catch (e) { toast(e.message, 'error'); }
  });
  return h('article', { class: 'pred' },
    h('div', { class: 'who' }, h('a', { href: `#/u/${encodeURIComponent(p.user.username)}` }, p.user.username), h('span', { class: `badge ${p.status}` }, status)),
    h('div', { class: 'what' },
      `Pilih ${names[p.pick]}${p.scoreHome !== null ? `, skor ${p.scoreHome}–${p.scoreAway}` : ''}`,
      showMatch ? h('small', {}, h('a', { href: `#/match/${encodeURIComponent(p.match.id)}` }, `${p.match.home} lawan ${p.match.away}`), ` · ${sport?.name || ''}`) : null),
    p.note ? h('p', { class: 'note' }, p.note) : null,
    h('div', { class: 'foot' }, h('span', {}, `Yakin ${p.confidence}/5 · ${relative(p.createdAt)}`), likeBtn));
}

export function demoNotice() {
  return h('div', { class: 'notice', role: 'note' }, icon('info', { size: 18 }),
    h('p', {}, h('strong', {}, 'Data simulasi. '), STATIC
      ? (state.config?.fallbackActive
        ? 'Liga, tim, dan skor di bawah ini fiktif. Pembaruan terakhir belum berhasil mengambil data nyata; coba lagi setelah pembaruan berikutnya.'
        : 'Liga, tim, dan skor di bawah ini fiktif karena situs ini dibangun dalam mode demo.')
      : 'Liga, tim, dan skor di bawah ini fiktif untuk mencoba aplikasi. Hubungkan sumber data nyata di pengaturan server untuk pertandingan sungguhan.'));
}

/** Pengingat bahwa komunitas pada versi GitHub Pages hanya ada di perangkat ini. Kosong di versi server. */
export function localNotice() {
  if (!STATIC) return null;
  return h('div', { class: 'notice', role: 'note' }, icon('info', { size: 18 }),
    h('p', {}, h('strong', {}, 'Hanya di perangkat ini. '), 'Versi ini tidak punya server bersama, jadi tebakan, poin, dan peringkat tersimpan di browser ini saja dan tidak terlihat orang lain. Menghapus data situs di browser juga menghapusnya.'));
}

export { sportIcon, icon, longWhen, untilKickoff };
