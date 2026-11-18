import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { pointsFor } from '../server/community.js';

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

const post = (path, body, cookie, headers) => t.req('POST', path, { body, cookie, headers });

test('pointsFor: menang 10 + 2×keyakinan (+10 skor tepat), kalah −keyakinan', () => {
  assert.equal(pointsFor({ won: true, confidence: 3, exactScore: false }), 16);
  assert.equal(pointsFor({ won: true, confidence: 5, exactScore: true }), 30);
  assert.equal(pointsFor({ won: false, confidence: 4, exactScore: false }), -4);
});

test('register: validasi, duplikat (tak peka huruf besar-kecil), nama terlarang', async () => {
  for (const [u, p, code] of [
    ['ab', 'kata-sandi-1', 'bad_username'], ['a'.repeat(21), 'kata-sandi-1', 'bad_username'], ['nama spasi', 'kata-sandi-1', 'bad_username'],
    ['<script>', 'kata-sandi-1', 'bad_username'], ['valid_user', 'pendek', 'bad_password'], ['valid_user', 'x'.repeat(73), 'bad_password'],
    ['Admin', 'kata-sandi-1', 'reserved_username'], ['JonBet', 'kata-sandi-1', 'reserved_username'],
  ]) {
    const r = await post('/api/auth/register', { username: u, password: p });
    assert.equal(r.status, 400, `${u}/${p}`);
    assert.equal(r.json.error.code, code, `${u}`);
  }
  for (const bad of [{}, { username: 5, password: 'kata-sandi-1' }, { username: 'ok_user', password: null }, { username: ['a'], password: ['b'] }]) {
    const r = await post('/api/auth/register', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const a = await post('/api/auth/register', { username: 'Budi_01', password: 'kata-sandi-1' });
  assert.equal(a.status, 201);
  const dup = await post('/api/auth/register', { username: 'Budi_01', password: 'kata-sandi-2' });
  assert.equal(dup.status, 409);
  const dupCase = await post('/api/auth/register', { username: 'budi_01', password: 'kata-sandi-2' });
  assert.equal(dupCase.status, 409, 'nama yang hanya beda huruf besar/kecil harus ditolak (peniruan)');
});

test('login, /api/me, logout; cookie HttpOnly + SameSite; sesi tidak valid setelah logout', async () => {
  const { name, password, cookie } = await t.signup('sesi_tes');
  const reg = await post('/api/auth/login', { username: name, password });
  assert.equal(reg.status, 200);
  assert.match(reg.setCookie, /HttpOnly/);
  assert.match(reg.setCookie, /SameSite=Lax/);
  assert.match(reg.setCookie, /Path=\//);
  assert.doesNotMatch(reg.setCookie, /Secure/, 'tanpa HTTPS, jangan paksa Secure (cookie tak akan terkirim)');
  const me = await t.req('GET', '/api/me', { cookie });
  assert.equal(me.json.user.username, name);
  assert.equal((await t.req('GET', '/api/me')).json.user, null);
  const out = await post('/api/auth/logout', {}, cookie);
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await t.req('GET', '/api/me', { cookie })).json.user, null, 'token lama harus mati');
  assert.equal((await t.req('GET', '/api/me', { cookie: 'jb_session=ngawur' })).json.user, null);
});

test('login salah: pesan sama untuk akun tak ada/salah sandi; terkunci setelah 5 kali', async () => {
  const { name } = await t.signup('kunci_tes');
  const wrongUser = await post('/api/auth/login', { username: 'tidak_ada_1', password: 'apa-saja-123' });
  const wrongPass = await post('/api/auth/login', { username: name, password: 'salah-salah-1' });
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongPass.status, 401);
  assert.equal(wrongUser.json.error.message, wrongPass.json.error.message);
  for (let i = 0; i < 3; i++) await post('/api/auth/login', { username: name, password: 'salah-salah-1' });
  const locked = await post('/api/auth/login', { username: name, password: 'salah-salah-1' });
  assert.ok([401, 429].includes(locked.status));
  const after = await post('/api/auth/login', { username: name, password: 'kata-sandi-1' });
  assert.equal(after.status, 429, 'akun terkunci sementara walau kata sandi benar');
  assert.equal(after.json.error.code, 'locked');
});

test('prediksi: wajib login, validasi pilihan/keyakinan/skor, catatan dibersihkan, bisa diubah', async () => {
  const m = await t.firstMatch('upcoming', 'football');
  const path = `/api/matches/${encodeURIComponent(m.id)}/predictions`;
  assert.equal((await post(path, { pick: 'H' })).status, 401);
  const u = await t.signup();
  const bad = [
    [{ pick: 'X' }, 'bad_pick'], [{}, 'bad_pick'], [{ pick: 'H', confidence: 0 }, 'bad_confidence'], [{ pick: 'H', confidence: 6 }, 'bad_confidence'],
    [{ pick: 'H', confidence: 2.5 }, 'bad_confidence'], [{ pick: 'H', scoreHome: 1 }, 'bad_score'], [{ pick: 'H', scoreHome: -1, scoreAway: 0 }, 'bad_score'],
    [{ pick: 'H', scoreHome: 1, scoreAway: 2 }, 'score_mismatch'], [{ pick: 'A', scoreHome: 2, scoreAway: 2 }, 'score_mismatch'], [{ pick: 'D', scoreHome: 2, scoreAway: 1 }, 'score_mismatch'],
    [{ pick: 'H', scoreHome: 1000, scoreAway: 0 }, 'bad_score'],
  ];
  for (const [body, code] of bad) {
    const r = await post(path, body, u.cookie);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, code, JSON.stringify(body));
  }
  const ok = await post(path, { pick: 'H', confidence: 4, scoreHome: 2, scoreAway: 1, note: '  Tuan rumah <b>kuat</b>\u0000\u0007 sekali  ' }, u.cookie);
  assert.equal(ok.status, 201);
  const again = await post(path, { pick: 'D', confidence: 2, scoreHome: 1, scoreAway: 1, note: 'x'.repeat(1000) }, u.cookie);
  assert.equal(again.status, 200, 'tebakan kedua pada laga yang sama = ubah, bukan ganda');
  assert.equal(again.json.id, ok.json.id);
  const list = await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/community`, { cookie: u.cookie });
  const mine = list.json.items.filter((p) => p.mine);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].pick, 'D');
  assert.equal(mine[0].note.length, 280);
  const noteOk = await post(path, { pick: 'H', note: 'Tuan rumah <b>kuat</b>\u0000\u0007' }, u.cookie);
  assert.equal(noteOk.status, 200);
  const l2 = await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/community`, { cookie: u.cookie });
  assert.equal(l2.json.items[0].note, 'Tuan rumah <b>kuat</b>', 'karakter kontrol dibuang; HTML dibiarkan karena UI memakai textContent');
});

test('tebakan seri ditolak di cabang tanpa seri; laga live/selesai tidak bisa ditebak', async () => {
  const u = await t.signup();
  const nb = await t.firstMatch('upcoming', 'tennis');
  const r = await post(`/api/matches/${encodeURIComponent(nb.id)}/predictions`, { pick: 'D' }, u.cookie);
  assert.equal(r.status, 400);
  for (const st of ['live', 'finished']) {
    const m = await t.firstMatch(st);
    const c = await post(`/api/matches/${encodeURIComponent(m.id)}/predictions`, { pick: 'H' }, u.cookie);
    assert.equal(c.status, 409, st);
    assert.equal(c.json.error.code, 'closed');
  }
});

test('suka: tidak bisa menyukai sendiri; toggle; hitung benar; hapus tebakan menghapus suka', async () => {
  const m = await t.firstMatch('upcoming', 'basketball');
  const a = await t.signup(); const b = await t.signup();
  const path = `/api/matches/${encodeURIComponent(m.id)}/predictions`;
  const pa = await post(path, { pick: 'A', confidence: 3 }, a.cookie);
  assert.equal((await post(`/api/predictions/${pa.json.id}/like`, {}, a.cookie)).json?.error?.code, 'self_like');
  assert.equal((await post(`/api/predictions/${pa.json.id}/like`, {})).status, 401);
  const l1 = await post(`/api/predictions/${pa.json.id}/like`, {}, b.cookie);
  assert.equal(l1.status, 200); assert.equal(l1.json.liked, true); assert.equal(l1.json.likes, 1);
  const l2 = await post(`/api/predictions/${pa.json.id}/like`, {}, b.cookie);
  assert.equal(l2.json.liked, false); assert.equal(l2.json.likes, 0);
  await post(`/api/predictions/${pa.json.id}/like`, {}, b.cookie);
  assert.equal((await post('/api/predictions/99999999/like', {}, b.cookie)).status, 404);
  const del = await t.req('DELETE', `/api/predictions/${pa.json.id}`, { cookie: b.cookie });
  assert.equal(del.status, 404, 'orang lain tak boleh menghapus');
  assert.equal((await t.req('DELETE', `/api/predictions/${pa.json.id}`, { cookie: a.cookie })).status, 200);
  assert.equal((await post(`/api/predictions/${pa.json.id}/like`, {}, b.cookie)).status, 404);
});

test('feed & papan peringkat & profil: bentuk benar dan input liar aman', async () => {
  const feed = await t.req('GET', '/api/feed?sort=top&limit=5');
  assert.equal(feed.status, 200);
  assert.ok(Array.isArray(feed.json.items));
  assert.equal((await t.req('GET', '/api/feed?sort=%27%3B--&offset=0')).status, 200);
  for (const period of ['week', 'all', 'ngawur']) assert.equal((await t.req('GET', `/api/leaderboard?period=${period}`)).status, 200);
  assert.equal((await t.req('GET', '/api/users/tidak_ada_sama_sekali')).status, 404);
  assert.equal((await t.req('GET', '/api/users/ab')).status, 404);
  assert.equal((await t.req('GET', '/api/users/' + encodeURIComponent("x' OR 1=1 --"))).status, 404);
});

test('penyelesaian: tebakan dikunci & dinilai setelah laga selesai, poin dan papan peringkat benar', async () => {
  const ups = (await t.req('GET', '/api/matches?status=upcoming&sport=football')).json.matches;
  const m = ups[ups.length - 1]; // laga lain di file ini memakai laga pertama
  const w = await t.signup('juara_tes'); const l = await t.signup('kalah_tes');
  const path = `/api/matches/${encodeURIComponent(m.id)}/predictions`;
  assert.equal((await post(path, { pick: 'H', confidence: 5 }, w.cookie)).status, 201);
  assert.equal((await post(path, { pick: 'A', confidence: 2 }, l.cookie)).status, 201);
  // majukan waktu sampai laga selesai
  t.clock.t = Date.parse(m.kickoff) + 4 * 3600_000;
  await t.app.service.tick();
  const fin = (await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}`)).json.match;
  assert.equal(fin.status, 'finished');
  const cm = (await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/community`)).json.items;
  assert.equal(cm.length, 2);
  const byUser = Object.fromEntries(cm.map((p) => [p.user.username, p]));
  const homeWon = fin.score.home > fin.score.away;
  const awayWon = fin.score.away > fin.score.home;
  assert.equal(byUser.juara_tes.status, homeWon ? 'won' : 'lost');
  assert.equal(byUser.kalah_tes.status, awayWon ? 'won' : 'lost');
  assert.equal(byUser.juara_tes.points, homeWon ? 20 : -5);
  assert.equal(byUser.kalah_tes.points, awayWon ? 14 : -2);
  assert.equal((await t.req('DELETE', `/api/predictions/${byUser.juara_tes.id}`, { cookie: w.cookie })).status, 409, 'tebakan terkunci');
  const again = await post(path, { pick: 'D', confidence: 1 }, w.cookie);
  assert.equal(again.status, 409, 'tidak boleh mengubah tebakan setelah laga lewat');
  const lb = (await t.req('GET', '/api/leaderboard?period=all')).json.rows;
  assert.ok(lb.some((r) => r.username === 'juara_tes') && lb.some((r) => r.username === 'kalah_tes'));
  for (let i = 1; i < lb.length; i++) assert.ok(lb[i - 1].points >= lb[i].points, 'urutan peringkat');
  const prof = (await t.req('GET', '/api/users/juara_tes')).json;
  assert.equal(prof.settled, 1);
  assert.equal(prof.pending, 0);
  // menyelesaikan dua kali tidak menggandakan poin
  await t.app.service.tick(); await t.app.service.tick();
  assert.equal((await t.req('GET', '/api/users/juara_tes')).json.points, homeWon ? 20 : -5);
});
