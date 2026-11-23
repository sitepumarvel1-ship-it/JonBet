// Tes asisten JonBet lintas laga: maksud, saringan (cabang, liga, tim, waktu), konteks percakapan, jawaban jujur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerGlobal, suggestAssistant } from '../server/ai/assistant.js';

const NOW = Date.parse('2026-11-19T06:30:00Z'); // 13.30 WIB, Kamis
const H = 3_600_000;
const iso = (offsetH) => new Date(NOW + offsetH * H).toISOString();
const fc = (home, draw, away, conf = 60) => {
  const pick = home >= away && home >= draw ? 'H' : away >= draw ? 'A' : 'D';
  return { home, draw, away, pick, pickP: Math.max(home, draw, away), confidence: conf, live: false };
};
const mk = (id, sport, league, home, away, offsetH, status, extra = {}) => ({ id, sport, league, home: { name: home }, away: { name: away }, kickoff: iso(offsetH), status, score: null, minute: null, period: null, forecast: fc(0.5, 0.25, 0.25), ...extra });

const MATCHES = [
  mk('a', 'football', 'English Premier League', 'Arsenal', 'Manchester City', -0.6, 'live', { score: { home: 1, away: 0 }, minute: 37, forecast: fc(0.71, 0.18, 0.11) }),
  mk('b', 'football', 'English Premier League', 'Chelsea', 'Liverpool', 5, 'upcoming', { forecast: fc(0.34, 0.3, 0.36, 45) }), // 18.30 WIB hari ini
  mk('c', 'football', 'Spanish La Liga', 'Real Madrid', 'Sevilla', 8, 'upcoming', { forecast: fc(0.72, 0.17, 0.11, 80) }), // 21.30 WIB
  mk('d', 'basketball', 'NBA', 'Los Angeles Lakers', 'Boston Celtics', 13, 'upcoming', { forecast: fc(0.49, 0, 0.51, 50) }), // 02.30 WIB Jumat
  mk('e', 'basketball', 'NBA', 'Miami Heat', 'Denver Nuggets', 30, 'upcoming', { forecast: fc(0.6, 0, 0.4, 70) }), // besok
  mk('f', 'football', 'Liga 1 Indonesia', 'Persija Jakarta', 'Persib Bandung', 20, 'upcoming', { forecast: fc(0.4, 0.28, 0.32, 55) }), // besok pagi WIB
  mk('g', 'football', 'English Premier League', 'Everton', 'Fulham', -20, 'finished', { score: { home: 2, away: 2 } }),
  mk('h', 'basketball', 'NBA', 'Chicago Bulls', 'Detroit Pistons', -22, 'finished', { score: { home: 101, away: 99 } }),
  mk('i', 'tennis', 'ATP Paris Masters', 'Novak Djokovic', 'Carlos Alcaraz', 2, 'upcoming', { forecast: fc(0.45, 0, 0.55, 40) }),
  mk('j', 'football', 'German Bundesliga', 'Bayern Munich', 'Borussia Dortmund', 7, 'upcoming', { forecast: fc(0.66, 0.18, 0.16, 75) }),
  mk('k', 'football', 'English Premier League', 'Manchester United', 'Tottenham Hotspur', 6, 'upcoming', { forecast: fc(0.41, 0.27, 0.32, 50) }),
];
const SPORTS = [{ id: 'football', name: 'Sepak bola' }, { id: 'basketball', name: 'Basket' }, { id: 'tennis', name: 'Tenis' }];
const ask = (question, context = null) => answerGlobal({ question, matches: MATCHES, sports: SPORTS, now: NOW, context });

test('live: daftar laga live dengan skor, menit, dan peluang; kosong menyebut laga berikutnya', () => {
  const r = ask('laga live sekarang');
  assert.match(r.reply, /1 laga live/);
  assert.match(r.reply, /Arsenal 1–0 Manchester City \(menit 37, English Premier League\); peluang Arsenal 71%/);
  assert.deepEqual(r.matchIds, ['a']);
  const none = ask('ada basket yang lagi live?');
  assert.match(none.reply, /Tidak ada laga live untuk basket/);
  assert.match(none.reply, /Berikutnya: Los Angeles Lakers vs Boston Celtics/);
});

test('favorit: urut kekuatan pilihan model, jendela waktu dihormati, tanpa kata taruhan', () => {
  const r = ask('favorit malam ini');
  assert.equal(r.matchIds[0], 'c', 'Real Madrid 72% dengan keyakinan 80 paling kuat');
  assert.deepEqual(r.matchIds.slice(0, 2), ['c', 'j']);
  assert.ok(!r.matchIds.includes('e'), 'laga besok malam tidak termasuk');
  assert.match(r.reply, /Real Madrid 72%, keyakinan model 80\/100/);
  assert.match(r.reply, /bukan saran bertaruh/);
  assert.ok(!/\bodds?\b/i.test(r.reply));
});

test('jadwal per cabang, liga, dan waktu', () => {
  const basket = ask('jadwal basket besok');
  assert.deepEqual(basket.matchIds, ['d', 'e'], 'Jumat 02.30 WIB masih termasuk "besok" menurut WIB');
  assert.match(basket.reply, /Miami Heat vs Denver Nuggets/);
  const liga = ask('jadwal La Liga hari ini');
  assert.deepEqual(liga.matchIds, ['c']);
  const epl = ask('jadwal liga inggris malam ini');
  assert.deepEqual([...epl.matchIds].sort(), ['b', 'k']);
  const tenis = ask('tenis hari ini');
  assert.deepEqual(tenis.matchIds, ['i']);
  const empty = ask('jadwal rugby besok');
  assert.match(empty.reply, /Tidak ada jadwal/);
});

test('tim: nama unik cukup; nama bersama ("Manchester") menyebut kedua tim; ringkasan live, jadwal, hasil', () => {
  const ars = ask('kapan Arsenal main?');
  assert.deepEqual(ars.matchIds, ['a']);
  const manAll = ask('Manchester');
  assert.deepEqual([...manAll.matchIds].sort(), ['a', 'k'], 'City dan United sama-sama ditemukan');
  const lakers = ask('Lakers');
  assert.deepEqual(lakers.matchIds, ['d']);
  const evt = ask('hasil Everton');
  assert.deepEqual(evt.matchIds, ['g']);
  assert.match(evt.reply, /Everton 2–2 Fulham/);
});

test('hasil: kemarin, per cabang', () => {
  const r = ask('hasil kemarin');
  assert.deepEqual([...r.matchIds].sort(), ['g', 'h']);
  assert.match(r.reply, /Chicago Bulls 101–99 Detroit Pistons \(selesai/);
  const nba = ask('hasil basket kemarin');
  assert.deepEqual(nba.matchIds, ['h']);
});

test('paling ketat: selisih peluang terkecil dulu', () => {
  const r = ask('laga paling ketat hari ini');
  assert.equal(r.matchIds[0], 'b', 'Chelsea 34% vs Liverpool 36%');
  assert.match(r.reply, /34% lawan 36%, seri 30%/);
});

test('hitung laga', () => {
  const r = ask('berapa laga hari ini?');
  assert.match(r.reply, /Untuk hari ini: \d+ laga \(\d+ live, \d+ akan datang, \d+ selesai\)/);
});

test('konteks: sambungan "kalau basket?", "besok?", "yang lain" mewarisi jenis pertanyaan', () => {
  const first = ask('jadwal sepak bola hari ini');
  assert.equal(first.context.kind, 'schedule');
  const sw = ask('kalau basket?', first.context);
  assert.deepEqual(sw.context.sports, ['basketball']);
  assert.equal(sw.context.kind, 'schedule');
  assert.match(sw.reply, /basket/);
  assert.equal(sw.context.win.label, 'hari ini', 'waktu diwarisi');
  const tmr = ask('besok?', sw.context);
  assert.deepEqual(tmr.matchIds, ['d', 'e'], 'basket besok (cabang dan jenis diwarisi, waktu diganti)');
  assert.equal(tmr.context.kind, 'schedule');
  assert.deepEqual(ask('kemarin saja', ask('hasil basket hari ini').context).matchIds, ['h'], 'sambungan ke hasil, basket diwarisi');
  assert.deepEqual(ask('kemarin').matchIds.sort(), ['g', 'h'], 'tanpa konteks: kata waktu lampau = hasil');
  // paging
  const many = Array.from({ length: 14 }, (_, i) => mk(`z${i}`, 'football', 'Liga X', `Tim${i}A`, `Tim${i}B`, 1 + i * 0.1, 'upcoming'));
  const p1 = answerGlobal({ question: 'jadwal bola hari ini', matches: many, sports: SPORTS, now: NOW });
  assert.equal(p1.matchIds.length, 6);
  assert.match(p1.reply, /dan 8 lainnya/);
  const p2 = answerGlobal({ question: 'yang lain', matches: many, sports: SPORTS, now: NOW, context: p1.context });
  assert.deepEqual(p2.matchIds, many.slice(6, 12).map((m) => m.id));
  assert.match(p2.reply, /dan 2 lainnya/);
  // tanpa konteks, "yang lain" tidak dipahami
  assert.match(ask('yang lain').reply, /belum menangkap maksud/);
});

test('jujur: tidak mengerti, di luar data, saran taruhan ditolak, sapaan dan bantuan', () => {
  assert.match(ask('asdf qwerty').reply, /belum menangkap maksud/);
  assert.match(ask('bagaimana cedera Salah?').reply, /tidak ada di data JonBet/);
  for (const q of ['kasih tip taruhan malam ini', 'odds Arsenal berapa', 'mana yang pasti cuan']) {
    const r = ask(q);
    assert.match(r.reply, /tidak memberi saran bertaruh/, q);
    assert.deepEqual(r.matchIds, []);
  }
  assert.match(ask('halo').reply, /Saya JonBet AI/);
  assert.match(ask('kamu bisa apa saja?').reply, /merangkum semua laga/);
  assert.match(ask('makasih').reply, /Sama-sama/);
  assert.match(ask('').reply, /Tulis pertanyaannya/);
  assert.match(answerGlobal({ question: 'laga live', matches: [], now: NOW }).reply, /Tidak ada laga live/);
});

test('saran lanjutan menyesuaikan konteks', () => {
  assert.ok(suggestAssistant().includes('Laga live sekarang'));
  const s = suggestAssistant({ sportName: 'basket' });
  assert.ok(s[0].includes('basket'));
});

test('ketahanan: masukan aneh tidak melempar galat', () => {
  const weird = [null, undefined, 123, '   ', '🔥🔥🔥', 'a'.repeat(5000), '<script>alert(1)</script>', 'laga '.repeat(200)];
  for (const w of weird) {
    const r = answerGlobal({ question: w, matches: MATCHES, sports: SPORTS, now: NOW, context: { kind: 'bogus', sports: null } });
    assert.equal(typeof r.reply, 'string');
    assert.ok(Array.isArray(r.matchIds));
  }
  // laga tanpa prakiraan atau tanpa nama liga tidak merusak
  const sparse = [{ id: 'x', sport: 'football', home: { name: 'A' }, away: { name: 'B' }, kickoff: iso(3), status: 'upcoming' }];
  assert.match(answerGlobal({ question: 'jadwal hari ini', matches: sparse, now: NOW }).reply, /A vs B/);
  assert.doesNotThrow(() => answerGlobal({ question: 'favorit hari ini', matches: sparse, now: NOW }));
});

test('cleanContext: hanya kunci dikenal, tipe dan ukuran dibatasi', async () => {
  const { cleanContext } = await import('../server/ai/assistant.js');
  assert.equal(cleanContext(null), null);
  assert.equal(cleanContext([1]), null);
  assert.equal(cleanContext('x'), null);
  const c = cleanContext({ kind: 'hack', sports: ['football', 5, 'x'.repeat(99)], ids: ['a', 'b', 'c', 'd'], side: 'X', offset: -1, win: { from: 0, to: 1e15 }, evil: { a: 1 }, teams: 'Arsenal' });
  assert.equal(c.kind, undefined);
  assert.equal(c.sports.length, 2);
  assert.equal(c.sports[1].length, 24);
  assert.deepEqual(c.ids, ['a', 'b', 'c']);
  assert.equal(c.side, undefined);
  assert.equal(c.offset, undefined);
  assert.equal(c.win, undefined);
  assert.equal(c.evil, undefined);
  assert.deepEqual(c.teams, []);
  const ok = cleanContext({ kind: 'schedule', win: { from: 1, to: 2, label: 'besok', explicit: true }, offset: 6 });
  assert.deepEqual([ok.kind, ok.win.label, ok.offset], ['schedule', 'besok', 6]);
  // konteks hasil bersihan tetap bekerja di asisten
  const r = answerGlobal({ question: 'yang lain', matches: MATCHES, sports: SPORTS, now: NOW, context: cleanContext({ kind: 'schedule', offset: 0 }) });
  assert.equal(typeof r.reply, 'string');
});
