import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { state, sportOf, emit, on } from '../state.js';
import { demoNotice, emblem, errorBox, liveLabel, livePill, liveNote, loadingBox, localNotice, predCard, toast, icon } from '../components.js';
import { STATIC } from '../mode.js';
import { barList, compareRows, formPills, marginBars, meter, probBar, scoreHeatmap, totalsBars } from '../charts.js';
import { clock, longWhen, num1, pctInt, untilKickoff } from '../format.js';
import { setQuery } from '../router.js';

const TABS = [['analisis', 'Analisis'], ['form', 'Form dan H2H'], ['statistik', 'Statistik'], ['komunitas', 'Komunitas'], ['ai', 'Tanya JonBet AI']];

const panel = (title, ...children) => h('section', { class: 'card panel' }, h('h3', {}, title), ...children);

/* ------------------------------------------------------------------ hero */

function buildHero(b) {
  const { match: m } = b;
  const sport = sportOf(m.sport);
  const sc = m.score;
  const center = sc
    ? h('div', { class: 'hero-score' },
      h('div', { class: 'big', 'aria-label': `Skor ${sc.home} lawan ${sc.away}` }, `${sc.home}–${sc.away}`),
      h('div', { class: 'sub' }, m.status === 'live' ? liveLabel(m) : m.status === 'finished' ? 'Selesai' : ''))
    : h('div', { class: 'hero-score' },
      h('div', { class: 'vs' }, 'vs'),
      h('div', { class: 'sub' }, m.status === 'upcoming' ? `${clock(m.kickoff)}, ${untilKickoff(m.kickoff)}` : m.status === 'postponed' ? 'Ditunda' : m.status === 'cancelled' ? 'Dibatalkan' : ''));
  return h('section', { class: 'hero', 'aria-label': 'Papan pertandingan' },
    h('div', { class: 'hero-meta' },
      m.status === 'live' ? livePill(m) : null,
      h('span', { class: 'pill-soft' }, `${sport?.name || ''} ${m.league}`.trim()),
      h('span', {}, longWhen(m.kickoff)),
      m.venue ? h('span', {}, m.venue) : null),
    h('div', { class: 'hero-board' },
      h('div', { class: 'hero-team' }, emblem(m.home, 'home', true), h('div', { class: 'name' }, m.home.name), h('div', { class: 'role' }, sport?.homeLabel || 'Tuan rumah')),
      center,
      h('div', { class: 'hero-team' }, emblem(m.away, 'away', true), h('div', { class: 'name' }, m.away.name), h('div', { class: 'role' }, sport?.awayLabel || 'Tamu'))),
    liveNote(m));
}

/* -------------------------------------------------------------- analisis */

const outcomeCls = (hs, as) => (hs > as ? 'h' : hs < as ? 'a' : 'd');

function analysisTab(b, goTab) {
  const { match: m, analysis: a, summary } = b;
  const sport = sportOf(m.sport);
  const cur = a.current;
  const names = { home: m.home.name, away: m.away.name };
  const live = !!a.live;
  const unit = sport.scoreUnit;

  const probPanel = panel(live ? 'Peluang saat ini' : m.status === 'finished' ? 'Peluang sebelum laga' : 'Peluang menang',
    probBar(cur.probs, { drawable: a.drawable, names, tall: true }),
    live ? h('p', { class: 'sub' }, 'Dihitung ulang dari skor dan sisa waktu pertandingan.') : null,
    live ? h('div', { class: 'prob' }, h('p', { class: 'sub' }, 'Sebelum pertandingan'), probBar(a.pre.probs, { drawable: a.drawable, names, thin: true })) : null,
    meter(a.confidence.score, a.confidence.label),
    h('p', { class: 'sub' }, a.confidence.reasons.join(' ')));

  const aiPanel = h('section', { class: 'card panel verdict' },
    h('h3', {}, 'Ringkasan JonBet AI'),
    h('p', { class: 'headline' }, summary.headline),
    summary.factors.map((f) => h('div', { class: 'factor' }, h('strong', {}, f.title), h('p', {}, f.text))),
    summary.scenario ? h('div', { class: 'factor' }, h('strong', {}, 'Skenario'), h('p', {}, summary.scenario)) : null,
    h('div', { class: 'factor' }, h('strong', {}, 'Yang perlu diwaspadai'), h('ul', { class: 'risk-list' }, summary.risks.map((r) => h('li', {}, r)))),
    h('p', { class: 'disclaimer' }, summary.disclaimer),
    h('div', { class: 'sticky-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => goTab('ai') }, icon('spark', { size: 18 }), 'Tanya JonBet AI')));

  const extra = [];
  if (cur.model === 'poisson') {
    extra.push(
      panel('Peta skor akhir',
        scoreHeatmap(cur.matrix, m),
        h('p', { class: 'sub' }, 'Makin terang, makin mungkin. Bingkai kuning menandai skor paling mungkin.')),
      panel('Skor yang paling mungkin',
        barList(cur.topScores.slice(0, 6).map((s) => ({ label: `${s.home}–${s.away}${s.home > s.away ? `, ${m.home.short || m.home.name} menang` : s.home < s.away ? `, ${m.away.short || m.away.name} menang` : ', seri'}`, value: s.p, cls: outcomeCls(s.home, s.away) }))),
        h('p', { class: 'sub' }, `Skor harapan ${num1(cur.expected.home)}–${num1(cur.expected.away)}. Peluang satu skor tertentu selalu kecil, baca polanya.`)),
      panel(`Total ${unit}`,
        totalsBars(cur.totals, unit),
        cur.btts ? barList([{ label: `Kedua tim mencetak ${unit}`, value: cur.btts.yes }, { label: `Salah satu tim tanpa ${unit}`, value: cur.btts.no }]) : null),
      panel('Selisih hasil akhir', marginBars(cur.margins, m, unit)));
  } else if (cur.model === 'points') {
    extra.push(
      panel('Selisih hasil akhir', marginBars(cur.margins, m, unit),
        h('p', { class: 'sub' }, `Selisih diharapkan ${num1(Math.abs(cur.expected.margin))} ${unit} untuk ${cur.expected.margin >= 0 ? m.home.name : m.away.name}.`)),
      panel(`Total ${unit}`, totalsBars(cur.totals, unit), h('p', { class: 'sub' }, `Total diharapkan ${num1(cur.expected.total)} ${unit} (${num1(cur.expected.home)}–${num1(cur.expected.away)}).`)));
  } else if (cur.sets && cur.sets.length) {
    extra.push(panel(`Skor ${unit}`,
      barList(cur.sets.map((s) => {
        const [x, y] = s.score.split('-').map(Number);
        return { label: `${x > y ? m.home.name : m.away.name} menang ${s.score.replace('-', '–')}`, value: s.p, cls: x > y ? 'h' : 'a' };
      })),
      h('p', { class: 'sub' }, `Peluang ${m.home.name} menang satu ${unit} sekitar ${pctInt(cur.params.setProb)}.`)));
  }

  return h('div', { class: 'grid-2' }, h('div', { class: 'section' }, probPanel, ...extra.slice(0, 1), ...extra.slice(2, 3)),
    h('div', { class: 'section' }, aiPanel, ...extra.slice(1, 2), ...extra.slice(3)));
}

/* ------------------------------------------------------------- form + h2h */

function formBlock(f, side) {
  return h('div', { class: 'form-line' },
    h('div', { class: 'who' }, f.name, h('span', {}, f.n ? `${f.w} menang, ${f.d} seri, ${f.l} kalah` : 'Belum ada riwayat')),
    formPills(f),
    f.matches.map((x) => h('div', { class: 'h2h-row' }, h('span', { class: 'd' }, new Date(x.date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })),
      h('span', {}, `${x.home ? 'vs' : 'di'} ${x.opponent}`), h('span', { class: 'sc' }, `${x.gf}–${x.ga}`))));
}

function formTab(b) {
  const { match: m, form, h2h, ratings, analysis: a } = b;
  return h('div', { class: 'grid-2' },
    h('div', { class: 'section' },
      panel('Form 5 laga terakhir', formBlock(form.home), formBlock(form.away),
        h('p', { class: 'sub' }, 'M = menang, S = seri, K = kalah. Pil paling kanan adalah laga terbaru.'))),
    h('div', { class: 'section' },
      panel('Rekor pertemuan',
        h2h.matches.length
          ? h('div', {}, h('p', { class: 'sub' }, `${m.home.name} menang ${h2h.aWins}, ${m.away.name} menang ${h2h.bWins}${a.drawable ? `, seri ${h2h.draws}` : ''}.`),
            h2h.matches.map((x) => h('div', { class: 'h2h-row' }, h('span', { class: 'd' }, new Date(x.date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' })), h('span', {}, `${x.home} lawan ${x.away}`), h('span', { class: 'sc' }, `${x.hs}–${x.as}`))))
          : h('p', { class: 'muted' }, 'Belum ada pertemuan kedua sisi dalam data yang dikumpulkan JonBet.')),
      panel('Kekuatan tim',
        compareRows([
          { label: 'Rating Elo', home: Math.round(a.elo.home), away: Math.round(a.elo.away) },
          { label: 'Laga tercatat', home: ratings.home.games, away: ratings.away.games },
        ]),
        h('p', { class: 'sub' }, 'Rating Elo dimulai dari 1500 dan naik atau turun setiap ada hasil. Selisih 100 poin kira-kira setara peluang menang 64% untuk yang lebih kuat.'))));
}

/* ------------------------------------------------------------ statistik */

function statsTab(b) {
  const { match: m } = b;
  const ev = (m.events || []).filter((e) => e.type === 'goal');
  return h('div', { class: 'grid-2' },
    panel('Statistik pertandingan',
      m.stats && m.stats.length ? compareRows(m.stats) : h('p', { class: 'muted' }, m.status === 'upcoming' ? 'Statistik tersedia setelah pertandingan dimulai.' : 'Sumber data belum menyediakan statistik untuk pertandingan ini.'),
      m.stats && m.stats.length ? h('p', { class: 'sub' }, `Biru: ${m.home.name}. Amber: ${m.away.name}.`) : null),
    panel('Jalannya pertandingan',
      ev.length ? h('div', { class: 'timeline' }, ev.map((e) => h('div', { class: 'tl' }, h('span', { class: 'm' }, `${e.minute}'`), h('span', {}, `Gol ${e.side === 'home' ? m.home.name : m.away.name}`))))
        : h('p', { class: 'muted' }, m.status === 'upcoming' ? 'Belum dimulai.' : 'Belum ada gol tercatat.')));
}

/* ------------------------------------------------------------- komunitas */

function communityTab(getBundle, matchId) {
  const el = h('div', { class: 'grid-2' });
  let data = null;
  let draft = { pick: '', confidence: 3, scoreHome: '', scoreAway: '', note: '' };
  let draftFrom = null;

  async function load() {
    try {
      data = await api(`/api/matches/${encodeURIComponent(matchId)}/community`);
      const mine = data.items.find((p) => p.mine);
      if (mine && draftFrom !== mine.id + ':' + mine.createdAt) {
        draft = { pick: mine.pick, confidence: mine.confidence, scoreHome: mine.scoreHome ?? '', scoreAway: mine.scoreAway ?? '', note: mine.note };
        draftFrom = mine.id + ':' + mine.createdAt;
      }
      draw();
    } catch (e) { mount(el, errorBox(e, load)); }
  }

  function form(b, mine) {
    const m = b.match;
    const sport = sportOf(m.sport);
    if (m.status !== 'upcoming') return h('p', { class: 'muted' }, 'Tebakan sudah ditutup karena pertandingan telah dimulai.');
    if (!state.user) {
      return h('div', { class: 'form-box' }, h('p', { class: 'text-2' }, STATIC ? 'Buat profil untuk menyimpan tebakanmu dan mengumpulkan poin.' : 'Masuk untuk membagikan tebakanmu dan naik di peringkat.'),
        h('div', { class: 'sticky-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => emit('need-auth', STATIC ? 'register' : 'login') }, STATIC ? 'Buat profil' : 'Masuk'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => emit('need-auth', STATIC ? 'login' : 'register') }, STATIC ? 'Sudah punya profil' : 'Daftar')));
    }
    const probs = b.analysis.pre.probs;
    const opts = [['H', m.home.name, probs.home, 'h'], ...(sport.drawable ? [['D', 'Seri', probs.draw, 'd']] : []), ['A', m.away.name, probs.away, 'a']];
    const msg = h('p', { class: 'form-msg', role: 'alert' });
    const grid = h('div', { class: 'pick-grid', style: { '--cols': String(opts.length) }, role: 'group', 'aria-label': 'Pilih hasil' });
    const drawPicks = () => mount(grid, opts.map(([k, label, p, cls]) => h('button', {
      type: 'button', class: `pick-btn ${cls}`, 'aria-pressed': String(draft.pick === k),
      onclick: () => { draft.pick = k; drawPicks(); },
    }, label, h('small', {}, `Model ${pctInt(p)}`))));
    drawPicks();

    const conf = h('input', { class: 'range', type: 'range', min: 1, max: 5, step: 1, value: draft.confidence, 'aria-label': 'Tingkat keyakinan' });
    const confVal = h('b', {}, `${draft.confidence}/5`);
    conf.addEventListener('input', () => { draft.confidence = Number(conf.value); confVal.textContent = `${draft.confidence}/5`; });
    const sh = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 0, max: 99, value: draft.scoreHome, 'aria-label': `Skor ${m.home.name}`, placeholder: '-' });
    const sa = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 0, max: 99, value: draft.scoreAway, 'aria-label': `Skor ${m.away.name}`, placeholder: '-' });
    sh.addEventListener('input', () => { draft.scoreHome = sh.value; });
    sa.addEventListener('input', () => { draft.scoreAway = sa.value; });
    const note = h('textarea', { class: 'textarea', maxlength: 280, placeholder: 'Alasanmu (opsional, maksimal 280 karakter)', 'aria-label': 'Alasan tebakan' });
    note.value = draft.note;
    note.addEventListener('input', () => { draft.note = note.value; });

    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, mine ? 'Perbarui tebakan' : 'Kirim tebakan');
    const f = h('form', { class: 'form-box', novalidate: true },
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Siapa yang menang?'), grid),
      h('div', { class: 'field' }, h('label', {}, 'Keyakinan ', confVal), conf),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Skor akhir (opsional, bonus +10 poin bila tepat)'),
        h('div', { class: 'score-inputs' }, sh, h('span', {}, '–'), sa)),
      h('div', { class: 'field' }, h('label', {}, 'Alasan'), note),
      msg,
      h('div', { class: 'sticky-actions' }, submit,
        mine ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
          try { await api(`/api/predictions/${mine.id}`, { method: 'DELETE' }); draft = { pick: '', confidence: 3, scoreHome: '', scoreAway: '', note: '' }; draftFrom = null; toast('Tebakan dihapus.'); load(); } catch (e) { msg.textContent = e.message; }
        } }, 'Hapus') : null));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      if (!draft.pick) { msg.textContent = 'Pilih dulu hasil yang kamu tebak.'; return; }
      submit.disabled = true;
      try {
        const body = { pick: draft.pick, confidence: draft.confidence, note: draft.note,
          scoreHome: draft.scoreHome === '' ? null : Number(draft.scoreHome), scoreAway: draft.scoreAway === '' ? null : Number(draft.scoreAway) };
        const r = await api(`/api/matches/${encodeURIComponent(matchId)}/predictions`, { method: 'POST', body });
        toast(r.updated ? 'Tebakan diperbarui.' : 'Tebakan terkirim.');
        draftFrom = null;
        await load();
      } catch (err) { msg.textContent = err.message; } finally { submit.disabled = false; }
    });
    return f;
  }

  function draw() {
    const b = getBundle();
    const m = b.match;
    const sport = sportOf(m.sport);
    const names = { home: m.home.name, away: m.away.name };
    const mine = data.items.find((p) => p.mine) || null;
    const t = data.total;
    const left = h('div', { class: 'section' },
      localNotice(),
      panel(STATIC ? 'Tebakan di perangkat ini' : 'Pilihan komunitas',
        t ? probBar({ home: data.counts.H, draw: data.counts.D, away: data.counts.A }, { drawable: sport.drawable, names, counts: true })
          : h('p', { class: 'muted' }, 'Belum ada tebakan untuk pertandingan ini.'),
        t ? h('p', { class: 'sub' }, `${t} tebakan, keyakinan rata-rata ${num1(data.avgConfidence)}/5.`) : null,
        h('div', { class: 'prob' }, h('p', { class: 'sub' }, 'Prediksi model'), probBar(b.analysis.pre.probs, { drawable: sport.drawable, names, thin: true }))),
      panel(mine ? 'Tebakanmu' : 'Bagikan tebakanmu', form(b, mine)));
    const right = h('div', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, STATIC ? 'Tebakan tersimpan' : 'Tebakan pengguna')),
      data.items.length ? data.items.map((p) => predCard(p, { showMatch: false, onChange: () => {} })) : h('div', { class: 'card empty' }, h('strong', {}, 'Belum ada tebakan'), h('p', {}, 'Tebakanmu akan tampil di sini dan di halaman komunitas.')));
    mount(el, left, right);
  }

  // Setelah masuk/keluar, formulir dan penanda "milikku" harus mengikuti akun yang aktif.
  const off = on('user', () => { draft = { pick: '', confidence: 3, scoreHome: '', scoreAway: '', note: '' }; draftFrom = null; load(); });

  return { el, load, redraw: () => { if (data) draw(); }, off };
}

/* -------------------------------------------------------------- JonBet AI */

function aiTab(getBundle, matchId) {
  const history = [];
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Percakapan dengan JonBet AI' });
  const sugg = h('div', { class: 'sugg' });
  const input = h('input', { class: 'input', type: 'text', maxlength: 500, placeholder: 'Tanya soal pertandingan ini…', 'aria-label': 'Pertanyaan untuk JonBet AI', autocomplete: 'off' });
  const send = h('button', { class: 'btn btn-primary', type: 'submit', 'aria-label': 'Kirim' }, icon('send', { size: 18 }));
  const form = h('form', { class: 'chat-form' }, input, send);
  let busy = false;

  const bubble = (who, text, src) => {
    const b = h('div', { class: `bubble ${who}` }, text, src ? h('span', { class: 'src' }, src) : null);
    log.append(b);
    log.scrollTop = log.scrollHeight;
    return b;
  };

  function setSuggestions(list) {
    mount(sugg, list.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => ask(s) }, s)));
  }

  async function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; send.disabled = true; input.value = '';
    bubble('user', text);
    const typing = bubble('ai', 'JonBet AI sedang menulis…');
    typing.classList.add('typing');
    try {
      const r = await api(`/api/matches/${encodeURIComponent(matchId)}/ai`, { method: 'POST', body: { message: text, history: history.slice(-6) } });
      typing.remove();
      bubble('ai', r.reply, r.source === 'claude' ? 'Dijawab oleh Claude dari data analisis' : r.degraded ? 'Model bawaan JonBet (Claude sedang tidak tersedia)' : 'Model bawaan JonBet');
      history.push({ role: 'user', content: text }, { role: 'assistant', content: r.reply });
      setSuggestions(r.suggestions || []);
    } catch (e) {
      typing.remove();
      bubble('ai', e.message || 'Maaf, pertanyaan belum bisa dijawab.');
    } finally { busy = false; send.disabled = false; input.focus({ preventScroll: true }); }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });

  const el = h('div', { class: 'section' }, panel('Tanya JonBet AI',
    h('p', { class: 'sub' }, state.config.ai === 'claude'
      ? 'Jawaban disusun Claude dari angka model pertandingan ini, dengan cadangan model bawaan JonBet.'
      : 'Jawaban disusun model bawaan JonBet dari angka analisis pertandingan ini.'),
    h('div', { class: 'chat' }, log, sugg, form),
    h('p', { class: 'disclaimer' }, 'Bukan saran bertaruh. Semua angka adalah peluang statistik, bukan kepastian.')));

  function init() {
    if (log.childElementCount) return;
    const b = getBundle();
    bubble('ai', `Halo! Saya JonBet AI. Tanya apa saja soal ${b.match.home.name} lawan ${b.match.away.name}: peluang menang, skor yang mungkin, form tim, atau risikonya.`);
    setSuggestions(['Siapa yang lebih berpeluang menang?', 'Skor apa yang paling mungkin?', 'Apa risikonya?', 'Bagaimana form kedua tim?', 'Bagaimana cara model menghitung?']);
  }
  return { el, init };
}

/* ------------------------------------------------------------------ view */

export function matchView({ params, query }) {
  const id = params.id;
  const root = h('div', { class: 'page' }, loadingBox());
  let bundle = null;
  let tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'analisis';
  let heroSlot, tabsSlot, panelSlot, noticeSlot;
  let community, ai;

  const getBundle = () => bundle;

  function goTab(next) {
    tab = next;
    setQuery({ tab: next === 'analisis' ? '' : next });
    drawTabs();
    drawPanel();
  }

  function drawTabs() {
    mount(tabsSlot, TABS.map(([k, label]) => h('button', {
      type: 'button', role: 'tab', id: `tab-${k}`, 'aria-selected': String(tab === k), 'aria-controls': 'tabpanel',
      onclick: () => goTab(k),
    }, label)));
  }

  function drawPanel() {
    panelSlot.setAttribute('aria-labelledby', `tab-${tab}`);
    if (tab === 'analisis') mount(panelSlot, analysisTab(bundle, goTab));
    else if (tab === 'form') mount(panelSlot, formTab(bundle));
    else if (tab === 'statistik') mount(panelSlot, statsTab(bundle));
    else if (tab === 'komunitas') { mount(panelSlot, community.el); community.load(); }
    else { mount(panelSlot, ai.el); ai.init(); }
  }

  async function load(initial) {
    try {
      const b = await api(`/api/matches/${encodeURIComponent(id)}/analysis`);
      const prevStatus = bundle?.match?.status;
      bundle = b;
      if (initial) {
        community = communityTab(getBundle, id);
        ai = aiTab(getBundle, id);
        heroSlot = h('div');
        noticeSlot = h('div');
        tabsSlot = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Bagian analisis' });
        panelSlot = h('div', { id: 'tabpanel', role: 'tabpanel' });
        mount(root, noticeSlot, heroSlot, tabsSlot, panelSlot);
        drawTabs();
      }
      mount(noticeSlot, b.meta.demo ? demoNotice() : null);
      mount(heroSlot, buildHero(b));
      document.title = `${b.match.home.name} vs ${b.match.away.name} | JonBet`;
      if (initial) drawPanel();
      else if (tab === 'analisis' || tab === 'form' || tab === 'statistik') drawPanel();
      else if (tab === 'komunitas' && prevStatus !== b.match.status) community.redraw(); // jangan merombak formulir yang sedang diisi
    } catch (err) {
      if (!bundle) mount(root, errorBox(err, () => { mount(root, loadingBox()); load(true); }), h('a', { class: 'btn btn-sm', href: '#/matches' }, 'Kembali ke jadwal'));
      else throw err;
    }
  }

  return {
    el: root,
    init: () => load(true),
    refresh: () => (bundle && (bundle.match.status === 'live' || Date.parse(bundle.match.kickoff) - Date.now() < 3600_000) ? load(false) : Promise.resolve()),
    destroy: () => community?.off?.(),
    title: 'Pertandingan',
  };
}
