// JonBet AI bawaan: menjelaskan hasil model statistik dalam bahasa Indonesia.
// Seluruh angka berasal dari model dan riwayat data; teks hanya menyusun penjelasannya.
// Tidak menyebut odds, tidak memberi saran bertaruh.

import { teamKey } from '../util.js';

const P = (x) => (x >= 0.995 && x < 1 ? 'lebih dari 99%' : x > 0 && x < 0.005 ? 'kurang dari 1%' : `${Math.round(x * 100)}%`);
const N1 = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');
const whenOf = (match) => {
  if (['football', 'futsal', 'icehockey'].includes(match.sport) && Number.isFinite(match.minute)) return ` menit ${match.minute}`;
  return match.period ? ` (${match.period})` : '';
};
const sideName = (match, side) => (side === 'H' ? match.home.name : side === 'A' ? match.away.name : 'Seri');

export const DISCLAIMER =
  'Ini analisis statistik berdasarkan hasil sebelumnya, bukan kepastian dan bukan saran bertaruh. Cedera, susunan pemain, dan kondisi lapangan tidak ikut dihitung.';

function leader(a) {
  const p = a.current.probs;
  const arr = [['H', p.home], ['A', p.away]];
  if (a.drawable) arr.push(['D', p.draw]);
  arr.sort((x, y) => y[1] - x[1]);
  return { side: arr[0][0], p: arr[0][1], second: arr[1] };
}

function headline(match, a) {
  const l = leader(a);
  const name = sideName(match, l.side);
  const sc = match.score ? `${match.score.home}–${match.score.away}` : null;

  if (match.status === 'finished' && sc) {
    const out = match.score.home > match.score.away ? 'H' : match.score.home < match.score.away ? 'A' : 'D';
    const pre = a.pick;
    const hit = pre.side === out;
    return `Selesai ${sc}. Sebelum laga, model memilih ${sideName(match, pre.side)} (${P(pre.p)}) dan ${hit ? 'tebakan itu tepat' : 'tebakan itu meleset'}.`;
  }
  if (match.status === 'live' && sc) {
    const when = whenOf(match);
    if (l.side === 'D') return `Skor ${sc}${when}. Seri paling mungkin saat ini (${P(l.p)}).`;
    return `Skor ${sc}${when}. ${name} paling berpeluang menang saat ini (${P(l.p)}).`;
  }
  if (l.side === 'D') return `Pertandingan ketat: seri sedikit lebih mungkin (${P(l.p)}) dibanding kemenangan salah satu tim.`;
  if (l.p >= 0.62) return `${name} difavoritkan kuat dengan peluang menang ${P(l.p)}.`;
  if (l.p >= 0.5 || (!a.drawable && l.p >= 0.55)) return `${name} sedikit unggul dengan peluang menang ${P(l.p)}.`;
  return `Tidak ada favorit yang jelas: ${name} hanya unggul tipis (${P(l.p)}).`;
}

function formLine(f) {
  if (!f || f.n < 2) return null;
  const seq = f.matches.map((m) => m.result).join('');
  return `${f.name}: ${seq} (${f.w}M ${f.d}S ${f.l}K), cetak ${f.gf} dan kebobolan ${f.ga} dalam ${f.n} laga terakhir.`;
}

export function explain({ match, analysis: a, form, h2h, sport }) {
  const factors = [];
  const risks = [];
  const pre = a.pre;

  // 1. Rating
  const dElo = Math.round(a.elo.diff);
  const adv = a.elo.homeAdv ? ` (termasuk keuntungan kandang ${a.elo.homeAdv} poin)` : '';
  const ratingGames = a.confidence.games;
  if (ratingGames > 0) {
    const stronger = dElo > 15 ? match.home.name : dElo < -15 ? match.away.name : null;
    factors.push({
      title: 'Kekuatan tim',
      text: `Rating Elo ${match.home.name} ${Math.round(a.elo.home)} lawan ${match.away.name} ${Math.round(a.elo.away)}. ` +
        (stronger ? `${stronger} unggul sekitar ${Math.abs(dElo)} poin${adv}${a.elo.homeAdv ? ` (selisih rating murni ${Math.round(a.elo.home - a.elo.away)} poin)` : ''}.` : `Selisihnya kecil${adv}, jadi kekuatan kedua sisi hampir sama.`),
    });
  } else {
    factors.push({ title: 'Kekuatan tim', text: 'Model belum punya riwayat hasil kedua sisi, jadi keduanya dianggap setara dengan sedikit keuntungan kandang.' });
  }

  // 2. Form
  const fh = formLine(form?.home);
  const fa = formLine(form?.away);
  if (fh || fa) factors.push({ title: 'Form terakhir', text: [fh, fa].filter(Boolean).join(' ') });

  // 3. H2H
  if (h2h && h2h.matches.length >= 2) {
    factors.push({
      title: 'Rekor pertemuan',
      text: `Dalam ${h2h.matches.length} pertemuan terakhir: ${match.home.name} menang ${h2h.aWins}, ${match.away.name} menang ${h2h.bWins}${a.drawable ? `, seri ${h2h.draws}` : ''}.`,
    });
  }

  // 4. Skor / poin / set
  const cur = a.current;
  if (cur.model === 'poisson') {
    const line = cur.totals.reduce((best, t) => (Math.abs(t.over - 0.5) < Math.abs(best.over - 0.5) ? t : best), cur.totals[0]);
    factors.push({
      title: 'Perkiraan skor',
      text: `Skor harapan ${N1(cur.expected.home)}–${N1(cur.expected.away)} (total ${N1(cur.expected.total)} ${sport.scoreUnit}). ` +
        `Peluang total lebih dari ${N1(line.line)} ${sport.scoreUnit} sebesar ${P(line.over)}.` +
        (cur.btts ? ` Kedua tim mencetak ${sport.scoreUnit} berpeluang ${P(cur.btts.yes)}.` : ''),
    });
  } else if (cur.model === 'points') {
    const m = cur.expected.margin;
    const who = m >= 0 ? match.home.name : match.away.name;
    factors.push({
      title: 'Perkiraan skor',
      text: `Selisih ${sport.scoreUnit} yang diharapkan sekitar ${N1(Math.abs(m))} untuk ${who}, dengan total ${N1(cur.expected.total)} ${sport.scoreUnit}.`,
    });
  } else if (cur.sets && cur.sets.length) {
    const top = cur.sets[0];
    factors.push({
      title: 'Perkiraan hasil',
      text: `Skor ${sport.scoreUnit} yang paling mungkin ${top.score.replace('-', '–')} (${P(top.p)}). Peluang menang per ${sport.scoreUnit} sekitar ${P(cur.params.setProb)} untuk ${match.home.name}.`,
    });
  } else {
    factors.push({ title: 'Perkiraan hasil', text: `Ini adu langsung satu ronde: peluang ${match.home.name} ${P(cur.probs.home)} dan ${match.away.name} ${P(cur.probs.away)}.` });
  }

  // Risiko
  if (a.confidence.games < 5) risks.push('Data riwayat kedua sisi masih sedikit, jadi rating belum stabil dan peluang bisa bergeser cukup jauh setelah beberapa laga.');
  const l = leader(a);
  if (l.p < 0.45 || (!a.drawable && l.p < 0.55)) risks.push('Selisih kekuatan kecil: satu kejadian (kartu merah, cedera, gol cepat) bisa mengubah arah pertandingan.');
  if (a.drawable && cur.probs.draw > 0.28) risks.push(`Peluang seri cukup besar (${P(cur.probs.draw)}), jadi hasil imbang bukan skenario yang boleh diabaikan.`);
  if (match.status === 'live' && a.live) risks.push('Peluang langsung dihitung ulang dari skor dan sisa waktu. Kejadian di lapangan seperti kartu merah atau pergantian pemain belum ikut terbaca.');
  risks.push('Model hanya memakai hasil historis. Cedera, susunan pemain, cuaca, dan motivasi tidak ikut dihitung.');

  // Skenario
  let scenario = null;
  if (pre.topScores && pre.topScores.length >= 3 && match.status !== 'finished') {
    const t = (cur.topScores.length ? cur.topScores : pre.topScores).slice(0, 3).map((s) => `${s.home}–${s.away} (${P(s.p)})`).join(', ');
    scenario = `Skor akhir yang paling mungkin: ${t}.`;
  }

  return {
    headline: headline(match, a),
    factors,
    risks,
    scenario,
    confidence: a.confidence,
    disclaimer: DISCLAIMER,
  };
}

/* -------------------------------------------------------------- Tanya jawab */

export function suggestionsFor(match, a) {
  const base = ['Siapa yang lebih berpeluang menang?', 'Skor apa yang paling mungkin?', 'Apa risikonya?', 'Bagaimana form kedua tim?'];
  if (match.status === 'live') base.unshift('Bagaimana jalannya pertandingan sekarang?');
  if (a.drawable) base.push('Seberapa besar peluang seri?');
  base.push('Bagaimana cara model menghitung?');
  return base.slice(0, 6);
}

/* ---- memahami pertanyaan ---- */

const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
// Kata umum pada nama tim yang tidak cukup untuk membedakan tim.
const GENERIC = new Set(['fc', 'sc', 'cf', 'ac', 'as', 'the', 'de', 'del', 'la', 'le', 'el', 'club', 'team', 'tim', 'sport', 'sports', 'afc', 'bk', 'fk', 'sk', 'if', 'cd', 'ud']);

/** Tim mana yang disebut? Memakai kata pembeda tiap tim (nama, kode singkat); kata yang sama di kedua nama diabaikan. */
export function mentionedSide(question, match) {
  const q = new Set(norm(question).split(' ').filter(Boolean));
  const tokens = (t) => new Set([...norm(`${t.name} ${t.short || ''}`).split(' ')].filter((w) => w.length >= 3 && !GENERIC.has(w)));
  const th = tokens(match.home);
  const ta = tokens(match.away);
  const hit = (mine, other) => [...mine].some((w) => !other.has(w) && q.has(w));
  let h = hit(th, ta);
  let a = hit(ta, th);
  // Sebutan peran ("tuan rumah", "tim tamu") bila nama tidak disebut.
  if (!h && !a) { h = /\b(tuan rumah|kandang|home)\b/.test(norm(question)); a = /\b(tamu|tandang|away)\b/.test(norm(question)); }
  if (h && !a) return 'H';
  if (a && !h) return 'A';
  return null;
}

const when = (iso) => {
  try {
    return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)).replace(/\./g, ':') + ' WIB';
  } catch { return String(iso); }
};

// Maksud pertanyaan. Dicocokkan per kata utuh (bukan potongan kata, jadi "informasi" tidak dianggap "form"), dengan akhiran umum
// (-nya, -kah, -lah, -kan) dibolehkan, dan boleh lebih dari satu maksud per pertanyaan.
const W = (words, extra = '') => new RegExp(`\\b(${words})(nya|kah|lah|kan)?\\b${extra}`);
const INTENTS = [
  ['reason', /\b(kenapa|mengapa|alasan(nya)?|sebab(nya)?|kok)\b|\bapa (yang )?membuat\b|\bbagaimana bisa\b/],
  ['draw', W('seri|draw|imbang')],
  ['score', W('skor|score|gol|hasil akhir')],
  ['totals', W('over|under|total|jumlah gol|banyak gol|tinggi skor|rendah skor')],
  ['btts', /\b(btts|both teams)\b|\bkedua tim\b.*\b(cetak|mencetak|gol|skor|bobol|sama sama)\b/],
  ['h2h', W('h2h|head to head|head|pertemuan|rekor|bertemu|berhadapan')],
  ['form', W('form|performa|belakangan|tren|laga terakhir|lima laga|kondisi tim')],
  ['risk', W('risiko|resiko|waspada|jebakan|upset|kejutan|kelemahan|bahaya|rawan|meleset')],
  ['confidence', W('keyakinan|yakin|akurat|akurasi|percaya|dipercaya|terpercaya|confidence|andal|jaminan|pasti|valid')],
  ['compare', W('banding|bandingkan|perbandingan|vs|versus|lebih kuat|kuat mana|selisih|rating|elo')],
  ['method', W('cara|metode|algoritma|poisson|dihitung|menghitung|hitung|rumus|dasar|ai|model bekerja|bekerja')],
  ['info', /\b(kapan|jam|waktu|mulai|kickoff|tanggal|stadion|venue|liga|kompetisi|jadwal)(nya)?\b|\bdi mana\b|\bdimana\b/],
  ['live', W('sekarang|saat ini|kini|berjalan|berlangsung|live|menit|update|perkembangan')],
  ['winner', W('menang|pemenang|kalah|unggul|favorit|jagoan|prediksi|ramal|ramalan|tebak|peluang|kans|probabilitas|persen|siapa')],
  ['outside', W('cuaca|cedera|injury|susunan pemain|lineup|pemain|kartu|wasit|berita|transfer|pelatih|suporter|motivasi')],
  ['summary', W('informasi|info|detail|ringkasan|rangkuman|jelaskan|penjelasan|analisis|gambaran|overview|tentang')],
  ['help', W('bisa apa|apa saja|bantu|bantuan|fitur|help|fungsi')],
  ['thanks', /\b(terima kasih|makasih|thanks|thx)\b/],
];

export function answer({ question, match, analysis: a, form, h2h, sport }) {
  const raw = String(question || '');
  const q = norm(raw);
  const cur = a.current;
  const l = leader(a);
  const ex = explain({ match, analysis: a, form, h2h, sport });
  const sug = suggestionsFor(match, a);
  const out = (reply) => ({ reply, suggestions: sug });

  if (/\b(taruh|taruhan|bet|betting|odds?|judi|bandar|cuan|profit|handicap|parlay|togel)\b/.test(q)) {
    return out('Saya tidak memberi saran bertaruh dan JonBet tidak menyediakan odds atau taruhan. Saya hanya menjelaskan peluang statistik pertandingan ini. Taruhan uang berisiko merugikan, dan perjudian online dilarang di Indonesia.\n\n' + ex.headline);
  }
  if (/^(halo|hai|hi|hello|selamat|pagi|siang|malam|test|tes|p)\b/.test(q) && q.length < 25) {
    return out(`Halo! Saya JonBet AI. Saya bisa menjelaskan analisis ${match.home.name} lawan ${match.away.name}: peluang menang, skor yang mungkin, form tim, dan risikonya. Mau mulai dari mana?`);
  }

  const side = mentionedSide(raw, match);
  const target = side || l.side; // tim yang dimaksud; bila tidak disebut, yang unggul
  const pOf = (sd) => (sd === 'H' ? cur.probs.home : sd === 'A' ? cur.probs.away : cur.probs.draw);
  const formOf = (sd) => formLine(sd === 'H' ? form?.home : form?.away);
  const probsLine = () => `${match.home.name} ${P(cur.probs.home)}${a.drawable ? `, seri ${P(cur.probs.draw)}` : ''}, ${match.away.name} ${P(cur.probs.away)}`;
  const nowNote = match.status === 'live' ? ' (sudah memperhitungkan skor dan sisa waktu)' : '';

  const handlers = {
    winner() {
      if (side && side !== 'D') return `Peluang ${sideName(match, side)} menang ${P(pOf(side))}${nowNote}. Untuk perbandingan: ${probsLine()}.`;
      return `${ex.headline} Peluang: ${probsLine()}${nowNote}.`;
    },
    reason() {
      const name = sideName(match, target);
      const parts = ex.factors.filter((f) => ['Kekuatan tim', 'Form terakhir', 'Rekor pertemuan'].includes(f.title)).map((f) => f.text);
      const lead = side && side !== l.side
        ? `${name} punya peluang menang ${P(pOf(side))}, lebih rendah dari ${sideName(match, l.side)} (${P(l.p)}). Alasannya:`
        : `Peluang ${name} ${P(pOf(target))} terutama karena:`;
      return `${lead}\n${parts.map((t) => `• ${t}`).join('\n')}\n\nIni dasar statistik saja: cedera, susunan pemain, dan kondisi lapangan tidak ikut dihitung.`;
    },
    compare() {
      const d = Math.round(a.elo.diff);
      const adv = a.elo.homeAdv ? ` (termasuk keuntungan kandang ${a.elo.homeAdv} poin)` : '';
      if (!(a.confidence.games > 0)) return 'Model belum punya riwayat hasil kedua tim, jadi kekuatan keduanya belum bisa dibandingkan.';
      return `Rating Elo ${match.home.name} ${Math.round(a.elo.home)}, ${match.away.name} ${Math.round(a.elo.away)}. ${Math.abs(d) <= 15 ? 'Selisihnya kecil, kekuatan hampir sama' : `${d > 0 ? match.home.name : match.away.name} unggul sekitar ${Math.abs(d)} poin`}${adv}. ${ex.factors.find((f) => f.title === 'Form terakhir')?.text || ''}`.trim();
    },
    live() {
      if (match.status === 'upcoming') return `Pertandingan belum dimulai (${when(match.kickoff)}). ${ex.headline}`;
      const sc = match.score ? `${match.score.home}–${match.score.away}` : '-';
      if (match.status === 'finished') return `Pertandingan sudah selesai dengan skor ${sc}. ${ex.headline}`;
      let extra = '';
      if (cur.model === 'poisson' && a.live && match.score) extra = ` Model memperkirakan masih ada sekitar ${N1(a.live.expected.total - (match.score.home + match.score.away))} ${sport.scoreUnit} tambahan.`;
      return `Skor ${sc}${whenOf(match)}. ${ex.headline}${extra}`;
    },
    draw() {
      if (!a.drawable) return `Di ${sport.name.toLowerCase()} hasil seri tidak berlaku pada hasil akhir, jadi yang dihitung hanya peluang menang: ${match.home.name} ${P(cur.probs.home)}, ${match.away.name} ${P(cur.probs.away)}.`;
      return `Peluang seri ${P(cur.probs.draw)}. ${cur.probs.draw > 0.28 ? 'Angka ini cukup tinggi karena kedua tim relatif seimbang atau pertandingan diperkirakan rendah skor.' : 'Angka ini wajar untuk pertandingan dengan perbedaan kekuatan yang cukup terlihat.'}`;
    },
    score() {
      if (match.status === 'finished' && match.score) return `Skor akhir ${match.score.home}–${match.score.away}. ${ex.headline}`;
      if (cur.topScores.length) {
        const t = cur.topScores.slice(0, 4).map((s) => `${s.home}–${s.away} (${P(s.p)})`).join(', ');
        return `Skor akhir paling mungkin: ${t}. Skor harapan rata-rata ${N1(cur.expected.home)}–${N1(cur.expected.away)}. Peluang tiap skor spesifik selalu kecil, jadi lihat polanya, bukan satu angka.`;
      }
      if (cur.sets && cur.sets.length) return `Skor ${sport.scoreUnit} paling mungkin: ${cur.sets.slice(0, 3).map((s) => `${s.score.replace('-', '–')} (${P(s.p)})`).join(', ')}.`;
      if (cur.expected) return `Perkiraan skor sekitar ${Math.round(cur.expected.home)}–${Math.round(cur.expected.away)} ${sport.scoreUnit} (total ${Math.round(cur.expected.total)}).`;
      return 'Untuk cabang ini model hanya menghitung peluang menang, bukan skor.';
    },
    totals() {
      if (!cur.totals.length) return 'Cabang ini tidak punya analisis total skor.';
      return `Peluang total ${sport.scoreUnit}: ${cur.totals.map((x) => `lebih dari ${N1(x.line)}: ${P(x.over)}`).join('; ')}. Skor harapan total ${N1(cur.expected.total)}.`;
    },
    btts() { return cur.btts ? `Peluang kedua tim sama-sama mencetak ${sport.scoreUnit} adalah ${P(cur.btts.yes)}.` : 'Analisis ini tidak tersedia untuk cabang tersebut.'; },
    h2h() { return ex.factors.find((x) => x.title === 'Rekor pertemuan')?.text || 'Belum ada catatan pertemuan kedua sisi dalam data yang dikumpulkan JonBet.'; },
    form() {
      const lines = (side ? [formOf(side)] : [formLine(form?.home), formLine(form?.away)]).filter(Boolean);
      return lines.length ? lines.join('\n') : 'Belum cukup riwayat laga untuk menilai form. Datanya terkumpul seiring pertandingan yang selesai.';
    },
    risk() { return ex.risks.map((r) => `• ${r}`).join('\n'); },
    confidence() { return `Keyakinan model ${a.confidence.score}/100 (${a.confidence.label}). ${a.confidence.reasons.join(' ')} Angka ini menilai kecukupan data dan ketegasan selisih, bukan jaminan hasil.`; },
    method() {
      const how = cur.model === 'poisson' ? 'distribusi Poisson dengan koreksi untuk skor rendah' : cur.model === 'points' ? 'distribusi normal untuk selisih poin' : 'peluang menang per set yang diturunkan dari Elo';
      return `JonBet memberi rating Elo ke tiap tim dan memperbarui otomatis setiap ada hasil baru. Selisih rating (plus keuntungan kandang) diubah menjadi peluang memakai ${how}. Saat pertandingan berlangsung, peluang dihitung ulang dari skor dan sisa waktu. Ini model statistik bawaan, bukan model bahasa: ia menjawab dari angka analisis pertandingan ini.`;
    },
    info() {
      const bits = [`${match.home.name} lawan ${match.away.name}`, match.league ? `liga ${match.league}` : null, `${when(match.kickoff)}`, match.venue ? `di ${match.venue}` : null].filter(Boolean);
      return `${bits.join(', ')}. Status: ${match.status === 'live' ? 'sedang berlangsung' : match.status === 'finished' ? 'selesai' : match.status === 'upcoming' ? 'belum mulai' : match.status}.`;
    },
    summary() { return [ex.headline, ...ex.factors.slice(0, 3).map((f) => f.text), ex.scenario].filter(Boolean).join('\n\n'); },
    outside() { return `Hal itu tidak ikut dihitung model (cedera, susunan pemain, cuaca, wasit, dan berita tidak ada di datanya), jadi saya tidak bisa menjawabnya dengan jujur. Yang bisa saya jelaskan: peluang menang, skor yang mungkin, form, rekor pertemuan, dan risikonya.\n\n${ex.headline}`; },
    help() { return 'Saya bisa menjawab untuk pertandingan ini: siapa yang lebih berpeluang, kenapa, skor yang mungkin, peluang seri, total skor, form dan rekor pertemuan, perbandingan rating, risiko, jadwal, serta cara model menghitung. Sebut nama tim kalau mau jawaban untuk satu tim.'; },
    thanks() { return 'Sama-sama. Ada lagi yang mau ditanyakan soal pertandingan ini?'; },
  };

  // Maksud yang terdeteksi, berurut menurut posisinya dalam pertanyaan; paling banyak tiga jawaban digabung.
  const found = INTENTS.map(([id, re]) => ({ id, at: q.search(re) })).filter((x) => x.at >= 0).sort((x, y) => x.at - y.at).map((x) => x.id);
  let ids = found;
  // "winner" kata kunci umum: bila ada maksud yang lebih spesifik, ia hanya ikut bila pertanyaannya memang soal siapa menang.
  if (ids.length > 1 && ids.includes('winner') && !/\b(siapa|menang|pemenang|favorit|peluang|prediksi|kans|persen)\b/.test(q)) ids = ids.filter((x) => x !== 'winner');
  if (ids.includes('reason')) ids = ids.filter((x) => !['winner', 'compare', 'form', 'h2h'].includes(x)); // jawaban "kenapa" sudah memuat ketiganya
  if (ids.includes('live') && ids.includes('score')) ids = ids.filter((x) => x !== 'score' || match.status === 'upcoming');
  if (ids.includes('info') && ids.includes('live') && !/\bmenit\b/.test(q)) ids = ids.filter((x) => x !== 'live');
  if (ids.includes('outside') && ids.length > 1) ids = ids.filter((x) => x !== 'summary');
  if (ids.includes('summary') && ids.length > 1) ids = ids.filter((x) => x !== 'summary' || !ids.some((y) => !['winner', 'live'].includes(y) && y !== 'summary'));
  ids = ids.slice(0, 3);

  if (!ids.length) {
    if (side) return out(`Peluang ${sideName(match, side)} menang ${P(pOf(side))}${nowNote}. ${formOf(side) || 'Belum ada riwayat laga untuk tim ini.'}`);
    return out(`Saya belum menangkap maksud pertanyaan itu, dan saya hanya bisa menjawab dari angka analisis pertandingan ini (bukan model bahasa umum). Coba tanyakan misalnya: siapa yang lebih berpeluang menang, kenapa, skor yang mungkin, atau risikonya.\n\nRingkasan: ${ex.headline}`);
  }
  return out(ids.map((id) => handlers[id]()).join('\n\n'));
}
