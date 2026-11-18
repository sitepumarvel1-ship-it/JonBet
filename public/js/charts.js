// Grafik tanpa pustaka. Warna data: tuan rumah = biru, seri = teal, tamu = amber (divalidasi buta warna).
// Setiap grafik punya label teks (bukan hanya warna) dan tooltip/tabel sebagai pelengkap.
import { h } from './dom.js';
import { pct3, pctInt, num1 } from './format.js';

/* ------------------------------------------------------------ tooltip */
let tip;
export function showTip(evt, title, body) {
  if (!tip) { tip = h('div', { class: 'tooltip', role: 'tooltip' }); document.body.append(tip); }
  tip.replaceChildren(h('strong', {}, title), body || '');
  tip.hidden = false;
  const pad = 12;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  Object.assign(tip.style, { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` });
}
export function hideTip() { if (tip) tip.hidden = true; }

/* ------------------------------------------------------ bar peluang */
export function probValues(p, drawable, counts = false) {
  const raw = drawable ? [p.home, p.draw, p.away] : [p.home, p.away];
  const pc = pct3(raw);
  if (!counts) {
    // Peluang model tidak pernah ditampilkan 0% atau 100%: sisakan minimal 1% untuk kemungkinan yang belum nol.
    for (let i = 0; i < pc.length; i++) if (raw[i] > 0 && pc[i] < 1) { pc[i] = 1; const big = pc.indexOf(Math.max(...pc)); pc[big] -= 1; }
  }
  return drawable ? { h: pc[0], d: pc[1], a: pc[2] } : { h: pc[0], d: 0, a: pc[1] };
}

export function probBar(p, { drawable, names, tall = false, thin = false, legend = true, counts = false }) {
  const v = probValues(p, drawable, counts);
  const seg = (cls, val, label) => (val > 0
    ? h('span', { class: cls, style: { flex: `${val} 1 0` }, title: label }, tall && val >= 14 ? `${val}%` : null)
    : null);
  const text = `Peluang: ${names.home} ${v.h}%${drawable ? `, seri ${v.d}%` : ''}, ${names.away} ${v.a}%`;
  const bar = h('div', { class: `prob-bar${tall ? ' tall' : ''}${thin ? ' thin' : ''}`, role: 'img', 'aria-label': text },
    seg('h', v.h, `${names.home} ${v.h}%`), drawable ? seg('d', v.d, `Seri ${v.d}%`) : null, seg('a', v.a, `${names.away} ${v.a}%`));
  if (!legend) return bar;
  const item = (cls, name, val) => h('span', {}, h('i', { class: cls }), `${name} `, h('b', {}, `${val}%`));
  return h('div', { class: 'prob' }, bar, h('div', { class: 'prob-legend' },
    item('h', names.home, v.h), drawable ? item('d', 'Seri', v.d) : null, item('a', names.away, v.a)));
}

/* ---------------------------------------------------- batang jajar */
export function barList(rows) {
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return h('div', { class: 'bars' }, rows.map((r) =>
    h('div', { class: `bar-row${r.value === max ? ' best' : ''}` },
      h('span', { class: 'lab' }, r.label),
      h('span', { class: 'val' }, pctInt(r.value)),
      h('div', { class: 'track', role: 'img', 'aria-label': `${r.label}: ${pctInt(r.value)}` },
        h('div', { class: `fill ${r.cls || ''}`, style: { width: `${Math.max(1, Math.min(100, r.value * 100))}%` } })))));
}

export function marginBars(margins, match, unit) {
  const range = (m) => (m.to === null ? `${m.from}+` : m.from === m.to ? `${m.from}` : `${m.from}–${m.to}`);
  const rows = margins.map((m) => ({
    label: m.side === 'draw' ? 'Seri' : `${m.side === 'home' ? match.home.name : match.away.name} menang ${range(m)} ${unit}`,
    value: m.p,
    cls: m.side === 'home' ? 'h' : m.side === 'away' ? 'a' : 'd',
  }));
  return barList(rows);
}

export function totalsBars(totals, unit) {
  return barList(totals.map((t) => ({ label: `Total lebih dari ${num1(t.line)} ${unit}`, value: t.over })));
}

/* ------------------------------------------------------------ heatmap */
function mix(c1, c2, t) {
  const a = [parseInt(c1.slice(1, 3), 16), parseInt(c1.slice(3, 5), 16), parseInt(c1.slice(5, 7), 16)];
  const b = [parseInt(c2.slice(1, 3), 16), parseInt(c2.slice(3, 5), 16), parseInt(c2.slice(5, 7), 16)];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(',')})`;
}

export function scoreHeatmap(matrix, match) {
  const N = matrix.length;
  let max = 0, topI = 0, topJ = 0;
  matrix.forEach((row, i) => row.forEach((p, j) => { if (p > max) { max = p; topI = i; topJ = j; } }));

  const grid = h('div', { class: 'heat', role: 'img', 'aria-label': `Peta skor akhir. Paling mungkin ${topI}–${topJ} dengan peluang ${pctInt(max)}.` });
  grid.append(h('div', { class: 'ax corner' }));
  for (let j = 0; j < N; j++) grid.append(h('div', { class: 'ax' }, String(j)));
  for (let i = 0; i < N; i++) {
    grid.append(h('div', { class: 'ax' }, String(i)));
    for (let j = 0; j < N; j++) {
      const p = matrix[i][j];
      const t = max ? p / max : 0;
      const cell = h('div', {
        class: `cell${i === topI && j === topJ ? ' top' : ''}`,
        style: { background: mix('#1c2040', '#7f92ff', Math.pow(t, 0.8)), color: t > 0.55 ? '#0b0d1f' : '#b4b9dc' },
        dataset: { h: i, a: j },
      }, t >= 0.35 ? String(Math.round(p * 100)) : '');
      const tipFn = (e) => showTip(e, pctInt(p), `${match.home.name} ${i} – ${j} ${match.away.name}`);
      cell.addEventListener('pointermove', tipFn);
      cell.addEventListener('pointerleave', hideTip);
      grid.append(cell);
    }
  }

  const table = h('table', { class: 'table-view', hidden: true },
    h('caption', { class: 'sr-only' }, 'Peluang skor akhir dalam persen'),
    h('thead', {}, h('tr', {}, h('th', {}, `${match.home.short || 'T'} \\ ${match.away.short || 'M'}`), ...matrix[0].map((_, j) => h('th', {}, String(j))))),
    h('tbody', {}, matrix.map((row, i) => h('tr', {}, h('td', {}, String(i)), ...row.map((p) => h('td', {}, p >= 0.0005 ? (p * 100).toFixed(1) : '0'))))));

  const toggle = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-pressed': 'false' }, 'Lihat sebagai tabel');
  toggle.addEventListener('click', () => {
    const on = table.hidden;
    table.hidden = !on;
    grid.hidden = on;
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = on ? 'Lihat sebagai peta' : 'Lihat sebagai tabel';
  });

  return h('div', { class: 'heat-wrap' },
    grid, table,
    h('div', { class: 'heat-axis' }, h('span', {}, `Baris: ${match.home.name}`), h('span', {}, `Kolom: ${match.away.name}`)),
    toggle);
}

/* ---------------------------------------------------- form, meter, statistik */
const FORM_LABEL = { W: 'M', D: 'S', L: 'K' };
const FORM_TEXT = { W: 'Menang', D: 'Seri', L: 'Kalah' };

export function formPills(f) {
  if (!f || !f.matches.length) return h('p', { class: 'muted' }, 'Belum ada riwayat laga.');
  return h('div', { class: 'pills', role: 'list' }, f.matches.slice().reverse().map((m) =>
    h('span', {
      class: `fpill ${m.result}`, role: 'listitem',
      'aria-label': `${FORM_TEXT[m.result]} ${m.gf}-${m.ga} lawan ${m.opponent}`, title: `${FORM_TEXT[m.result]} ${m.gf}–${m.ga} vs ${m.opponent}`,
    }, FORM_LABEL[m.result])));
}

export function meter(score, label) {
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-label' }, h('span', {}, 'Keyakinan model'), h('b', {}, `${score}/100 (${label})`)),
    h('div', { class: 'meter-track', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': score, 'aria-label': 'Keyakinan model' },
      h('div', { class: 'meter-fill', style: { width: `${score}%` } })));
}

export function compareRows(stats) {
  return h('div', { class: 'bars' }, stats.map((s) => {
    const total = (s.home + s.away) || 1;
    const u = s.unit || '';
    return h('div', { class: 'stat-row' },
      h('div', { class: 'l' }, h('b', {}, `${s.home}${u}`), h('span', {}, s.label), h('b', {}, `${s.away}${u}`)),
      h('div', { class: 'stat-bar', role: 'img', 'aria-label': `${s.label}: ${s.home}${u} berbanding ${s.away}${u}` },
        h('span', { class: 'h', style: { flex: `${s.home / total || 0.0001} 1 0` } }),
        h('span', { class: 'a', style: { flex: `${s.away / total || 0.0001} 1 0` } })));
  }));
}
