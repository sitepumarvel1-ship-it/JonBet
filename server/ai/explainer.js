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
        (stronger ? `${stronger} unggul sekitar ${Math.abs(dElo)} poin${adv}.` : `Selisihnya kecil${adv}, jadi kekuatan kedua sisi hampir sama.`),
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

function mentionedSide(question, match) {
  const q = teamKey(question);
  const hit = (name) => {
    const k = teamKey(name);
    if (k && q.includes(k)) return true;
    return k.split(' ').some((w) => w.length >= 5 && q.split(' ').includes(w));
  };
  const h = hit(match.home.name);
  const a = hit(match.away.name);
  if (h && !a) return 'H';
  if (a && !h) return 'A';
  return null;
}

export function answer({ question, match, analysis: a, form, h2h, sport }) {
  const q = String(question || '').toLowerCase();
  const cur = a.current;
  const l = leader(a);
  const ex = explain({ match, analysis: a, form, h2h, sport });
  const sug = suggestionsFor(match, a);
  const out = (reply) => ({ reply, suggestions: sug });

  if (/\b(taruh|taruhan|bet|odds?|judi|bandar|cuan|profit)\b/.test(q)) {
    return out('Saya tidak memberi saran bertaruh dan JonBet tidak menyediakan odds atau taruhan. Saya hanya menjelaskan peluang statistik pertandingan ini. Taruhan uang berisiko merugikan, dan perjudian online dilarang di Indonesia.\n\n' + ex.headline);
  }
  if (/^\s*(halo|hai|hi|hello|selamat|pagi|siang|malam|test|tes)\b/.test(q) && q.length < 25) {
    return out(`Halo! Saya JonBet AI. Saya bisa menjelaskan analisis ${match.home.name} lawan ${match.away.name}: peluang menang, skor yang mungkin, form tim, dan risikonya. Mau mulai dari mana?`);
  }

  const side = mentionedSide(question, match);
  if (side && !/(h2h|head|pertemuan|skor|over|under)/.test(q)) {
    const name = sideName(match, side);
    const p = side === 'H' ? cur.probs.home : cur.probs.away;
    const f = side === 'H' ? form?.home : form?.away;
    const fl = formLine(f);
    return out(`Peluang ${name} menang saat ini ${P(p)}${match.status === 'live' ? ' (sudah memperhitungkan skor dan sisa waktu)' : ''}. ${fl || 'Belum ada riwayat laga untuk tim ini.'}`);
  }

  if (/(jalan|sekarang|saat ini|live|berlangsung|menit)/.test(q) && match.status === 'live') {
    const sc = match.score ? `${match.score.home}–${match.score.away}` : '-';
    let extra = '';
    if (cur.model === 'poisson' && a.live) extra = ` Model memperkirakan masih ada sekitar ${N1(a.live.expected.total - (match.score.home + match.score.away))} ${sport.scoreUnit} tambahan.`;
    return out(`Skor ${sc}${whenOf(match)}. ${ex.headline}${extra}`);
  }
  if (/(seri|draw|imbang)/.test(q)) {
    if (!a.drawable) return out(`Di ${sport.name.toLowerCase()} hasil seri tidak berlaku pada hasil akhir, jadi yang dihitung hanya peluang menang: ${match.home.name} ${P(cur.probs.home)}, ${match.away.name} ${P(cur.probs.away)}.`);
    return out(`Peluang seri ${P(cur.probs.draw)}. ${cur.probs.draw > 0.28 ? 'Angka ini cukup tinggi karena kedua tim relatif seimbang atau pertandingan diperkirakan rendah skor.' : 'Angka ini wajar untuk pertandingan dengan perbedaan kekuatan yang cukup terlihat.'}`);
  }
  if (/(skor|score|hasil akhir|berapa gol)/.test(q)) {
    if (cur.topScores.length) {
      const t = cur.topScores.slice(0, 4).map((s) => `${s.home}–${s.away} (${P(s.p)})`).join(', ');
      return out(`Skor akhir paling mungkin: ${t}. Skor harapan rata-rata ${N1(cur.expected.home)}–${N1(cur.expected.away)}. Peluang tiap skor spesifik selalu kecil, jadi lihat polanya, bukan satu angka.`);
    }
    if (cur.sets && cur.sets.length) return out(`Skor ${sport.scoreUnit} paling mungkin: ${cur.sets.slice(0, 3).map((s) => `${s.score.replace('-', '–')} (${P(s.p)})`).join(', ')}.`);
    if (cur.expected) return out(`Perkiraan skor sekitar ${Math.round(cur.expected.home)}–${Math.round(cur.expected.away)} ${sport.scoreUnit} (total ${Math.round(cur.expected.total)}).`);
    return out('Untuk cabang ini model hanya menghitung peluang menang, bukan skor.');
  }
  if (/(over|under|total|jumlah|banyak gol|tinggi skor)/.test(q)) {
    if (!cur.totals.length) return out('Cabang ini tidak punya analisis total skor.');
    const t = cur.totals.map((x) => `lebih dari ${N1(x.line)}: ${P(x.over)}`).join('; ');
    return out(`Peluang total ${sport.scoreUnit}: ${t}. Skor harapan total ${N1(cur.expected.total)}.`);
  }
  if (/(btts|kedua tim.*(cetak|gol)|both)/.test(q)) {
    return out(cur.btts ? `Peluang kedua tim sama-sama mencetak ${sport.scoreUnit} adalah ${P(cur.btts.yes)}.` : 'Analisis ini tidak tersedia untuk cabang tersebut.');
  }
  if (/(h2h|head|pertemuan|rekor|bertemu)/.test(q)) {
    const f = ex.factors.find((x) => x.title === 'Rekor pertemuan');
    return out(f ? f.text : 'Belum ada catatan pertemuan kedua sisi dalam data yang dikumpulkan JonBet.');
  }
  if (/(form|performa|belakangan|terakhir|tren)/.test(q)) {
    const lines = [formLine(form?.home), formLine(form?.away)].filter(Boolean);
    return out(lines.length ? lines.join('\n') : 'Belum cukup riwayat laga untuk menilai form. Datanya terkumpul seiring pertandingan yang selesai.');
  }
  if (/(risiko|waspada|jebakan|upset|kejutan|salah|meleset|kelemahan)/.test(q)) {
    return out(ex.risks.map((r) => `• ${r}`).join('\n'));
  }
  if (/(keyakinan|yakin|akurat|percaya|confidence|andal)/.test(q)) {
    return out(`Keyakinan model ${a.confidence.score}/100 (${a.confidence.label}). ${a.confidence.reasons.join(' ')} Angka ini menilai kecukupan data dan ketegasan selisih, bukan jaminan hasil.`);
  }
  if (/(cara|metode|model|algoritma|elo|poisson|bagaimana.*(hitung|kerja)|dihitung)/.test(q)) {
    const how = cur.model === 'poisson' ? 'distribusi Poisson dengan koreksi untuk skor rendah' : cur.model === 'points' ? 'distribusi normal untuk selisih poin' : 'peluang menang per set yang diturunkan dari Elo';
    return out(`JonBet memberi rating Elo ke tiap tim dan memperbarui otomatis setiap ada hasil baru. Selisih rating (plus keuntungan kandang) diubah menjadi peluang memakai ${how}. Saat pertandingan berlangsung, peluang dihitung ulang dari skor dan sisa waktu.`);
  }
  // Pertanyaan umum (siapa menang, prediksi, dll.) dan semua yang tak dikenali: ringkasan analisis.
  return out([ex.headline, ...ex.factors.slice(0, 2).map((f) => f.text)].join('\n\n'));
}
