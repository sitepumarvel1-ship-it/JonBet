import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { boot } from './helpers.js';

/** Permintaan mentah: path dikirim apa adanya (fetch menormalkan ../). */
function rawGet(base, path, { method = 'GET', headers = {} } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

test('header keamanan ada di halaman, aset, dan API; CSP ketat tanpa unsafe-inline/eval', async () => {
  for (const path of ['/', '/api/config', '/css/app.css', '/js/main.js', '/nonexistent-page', '/api/ngawur']) {
    const r = await t.req('GET', path);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, path);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*(?!\.)/, `${path}: ${csp}`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.ok(r.headers.get('referrer-policy'), path);
    assert.match(r.headers.get('permissions-policy') || '', /geolocation=\(\)/);
  }
});

test('pelintas direktori dan berkas sensitif tidak pernah dibaca', async () => {
  const paths = ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fserver/config.js', '/icons/../../package.json', '/....//package.json',
    '/.env', '/.git/config', '/js/../../server/app.js', '/%00', '/css/app.css%00.png', '//etc/passwd', '/..\\package.json', '/%5c..%5cpackage.json', '/server/app.js', '/package.json', '/data/jonbet.db'];
  for (const p of paths) {
    const r = await rawGet(t.base, p);
    const body = r.body.toString('utf8');
    assert.doesNotMatch(body, /"name":\s*"jonbet"|createApp|root:x:0|\[core\]|scryptSync/, `${p} membocorkan isi`);
    assert.ok([200, 400, 404].includes(r.status), `${p} -> ${r.status}`);
    if (r.status === 200) assert.match(String(r.headers['content-type']), /text\/html/, `${p}: hanya boleh index.html (SPA)`);
  }
});

test('penyajian statis: tipe MIME, ETag/304, gzip, HEAD, metode lain 405', async () => {
  const css = await t.req('GET', '/css/app.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  const etag = css.headers.get('etag');
  assert.ok(etag);
  const r304 = await rawGet(t.base, '/css/app.css', { headers: { 'if-none-match': etag } });
  assert.equal(r304.status, 304);
  const gz = await rawGet(t.base, '/js/main.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.match(zlib.gunzipSync(gz.body).toString(), /boot/);
  const head = await rawGet(t.base, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const man = await t.req('GET', '/manifest.webmanifest');
  assert.match(man.headers.get('content-type'), /manifest\+json/);
  const mf = JSON.parse(man.text);
  assert.equal(mf.display, 'standalone');
  for (const ic of mf.icons) assert.equal((await t.req('GET', new URL(ic.src, 'http://x/manifest.webmanifest').pathname)).status, 200, ic.src);
  assert.equal(mf.start_url, './', 'start_url harus relatif agar jalan di subfolder (github.io/nama-repo/)');
  assert.equal(mf.scope, './');
  const sw = await t.req('GET', '/sw.js');
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal((await t.req('POST', '/', { body: {} })).status, 405);
  assert.equal((await t.req('PUT', '/css/app.css', { body: {} })).status, 405);
  const missing = await t.req('GET', '/js/tidak-ada.js');
  assert.equal(missing.status, 404, 'berkas aset yang hilang tidak boleh dijawab index.html');
  const spa = await t.req('GET', '/match/demo:lnp-1-0');
  assert.equal(spa.status, 200);
  assert.match(spa.text, /<div id="app">/);
});

test('semua berkas yang dirujuk index.html, manifest, dan service worker memang ada', async () => {
  const html = (await t.req('GET', '/')).text;
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `rujukan harus relatif agar jalan di subfolder: ${ref}`);
    assert.equal((await t.req('GET', new URL(ref, 'http://x/').pathname)).status, 200, ref);
  }
  const sw = (await t.req('GET', '/sw.js')).text;
  const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\])\.map\(at\)/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(shell.length >= 25);
  for (const f of shell) assert.equal((await t.req('GET', new URL(f, 'http://x/').pathname)).status, 200, `SHELL: ${f}`);
});

test('semua modul JS klien memakai impor yang ada (tidak ada 404 saat dimuat)', async () => {
  const seen = new Set();
  const sharedSeen = new Set();
  const fs_ = await import('node:fs');
  const path_ = await import('node:path');
  const root_ = path_.resolve(path_.dirname(new URL(import.meta.url).pathname), '..');
  async function walk(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const r = await t.req('GET', path);
    assert.equal(r.status, 200, path);
    for (const m of r.text.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      const base = new URL(path, 'http://x');
      const target = new URL(spec, base).pathname;
      // /js/shared/* hanya ada pada build GitHub Pages (salinan dari server/); di sini cukup dipastikan sumbernya ada.
      if (target.startsWith('/js/shared/')) {
        const src = path_.join(root_, 'server', target.slice('/js/shared/'.length));
        assert.ok(fs_.existsSync(src), `sumber modul bersama tidak ada: ${src}`);
        sharedSeen.add(target);
        continue;
      }
      await walk(target);
    }
  }
  await walk('/js/main.js');
  assert.ok(seen.size >= 15, `hanya ${seen.size} modul`);
  assert.deepEqual([...sharedSeen].sort(), ['/js/shared/ai/explainer.js', '/js/shared/model/model.js', '/js/shared/util.js']);
});

test('Origin lintas situs ditolak untuk semua permintaan yang mengubah data; tanpa Origin / Origin sama diterima', async () => {
  const m = (await t.req('GET', '/api/matches?status=upcoming')).json.matches[0];
  const u = await t.signup();
  const evil = { origin: 'https://evil.example' };
  for (const [method, path, body] of [
    ['POST', '/api/auth/login', { username: u.name, password: u.password }],
    ['POST', '/api/auth/register', { username: 'penyusup_1', password: 'kata-sandi-1' }],
    ['POST', '/api/auth/logout', {}],
    ['POST', `/api/matches/${encodeURIComponent(m.id)}/predictions`, { pick: 'H' }],
    ['POST', `/api/matches/${encodeURIComponent(m.id)}/ai`, { message: 'halo' }],
    ['POST', '/api/predictions/1/like', {}],
    ['DELETE', '/api/predictions/1', undefined],
  ]) {
    const r = await t.req(method, path, { body, cookie: u.cookie, headers: evil });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.error.code, 'bad_origin');
  }
  assert.equal((await t.req('GET', '/api/me', { cookie: u.cookie })).json.user.username, u.name, 'sesi tidak rusak');
  const same = await t.req('POST', '/api/auth/login', { body: { username: u.name, password: u.password }, headers: { origin: t.base } });
  assert.equal(same.status, 200);
  const junk = await t.req('POST', '/api/auth/login', { body: { username: u.name, password: u.password }, headers: { origin: 'bukan url' } });
  assert.equal(junk.status, 403);
  assert.equal((await t.req('GET', '/api/matches', { headers: evil })).status, 200, 'GET tanpa efek samping boleh');
});

test('badan permintaan: tipe konten, ukuran, JSON rusak', async () => {
  const u = await t.signup();
  const m = (await t.req('GET', '/api/matches?status=upcoming')).json.matches[0];
  const path = `/api/matches/${encodeURIComponent(m.id)}/predictions`;
  assert.equal((await t.req('POST', path, { raw: 'pick=H', headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookie: u.cookie })).status, 415);
  assert.equal((await t.req('POST', path, { raw: '{"pick":"H"}', headers: { 'content-type': 'text/plain' }, cookie: u.cookie })).status, 415);
  assert.equal((await t.req('POST', path, { raw: '{rusak', cookie: u.cookie, headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await t.req('POST', path, { raw: '[1,2,3]', cookie: u.cookie, headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await t.req('POST', path, { raw: 'null', cookie: u.cookie, headers: { 'content-type': 'application/json' } })).status, 400);
  const big = await t.req('POST', path, { body: { pick: 'H', note: 'x'.repeat(40_000) }, cookie: u.cookie });
  assert.equal(big.status, 413);
  const chunked = await t.req('POST', '/api/auth/login', { raw: JSON.stringify({ username: 'a'.repeat(30_000), password: 'b' }), headers: { 'content-type': 'application/json' } });
  assert.equal(chunked.status, 413);
  const proto = await t.req('POST', path, { raw: '{"pick":"H","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}', cookie: u.cookie, headers: { 'content-type': 'application/json' } });
  assert.ok([200, 201].includes(proto.status));
  assert.equal({}.polluted, undefined, 'prototype tidak boleh tercemar');
});

test('injeksi SQL tidak berefek di parameter, catatan, nama pengguna', async () => {
  const evilQ = "'; DROP TABLE users; --";
  assert.equal((await t.req('GET', `/api/matches?q=${encodeURIComponent(evilQ)}`)).status, 200);
  assert.equal((await t.req('GET', `/api/feed?sport=${encodeURIComponent(evilQ)}`)).status, 400);
  assert.equal((await t.req('GET', `/api/leaderboard?period=${encodeURIComponent(evilQ)}`)).status, 200);
  const u = await t.signup();
  const m = (await t.req('GET', '/api/matches?status=upcoming')).json.matches[1];
  const r = await t.req('POST', `/api/matches/${encodeURIComponent(m.id)}/predictions`, { body: { pick: 'H', note: `${evilQ} <img src=x onerror=alert(1)>` }, cookie: u.cookie });
  assert.equal(r.status, 201);
  const reg = await t.req('POST', '/api/auth/register', { body: { username: "x' OR '1'='1", password: 'kata-sandi-1' } });
  assert.equal(reg.status, 400);
  assert.equal((await t.req('GET', '/api/me', { cookie: u.cookie })).json.user.username, u.name, 'tabel users masih utuh');
});

test('catatan berisi HTML dikirim sebagai JSON (nosniff), tidak pernah sebagai HTML', async () => {
  const m = (await t.req('GET', '/api/matches?status=upcoming')).json.matches[2];
  const u = await t.signup();
  await t.req('POST', `/api/matches/${encodeURIComponent(m.id)}/predictions`, { body: { pick: 'H', note: '<script>alert(1)</script>' }, cookie: u.cookie });
  const r = await t.req('GET', `/api/matches/${encodeURIComponent(m.id)}/community`);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('rahasia tidak bocor: hash/salt/token tidak ada di respons mana pun, sesi disimpan sebagai hash', async () => {
  const u = await t.signup('rahasia_tes');
  const token = u.cookie.split('=')[1];
  const m = (await t.req('GET', '/api/matches?status=upcoming')).json.matches[3];
  await t.req('POST', `/api/matches/${encodeURIComponent(m.id)}/predictions`, { body: { pick: 'A' }, cookie: u.cookie });
  const blobs = [];
  for (const path of ['/api/me', '/api/users/rahasia_tes', '/api/leaderboard', '/api/feed', `/api/matches/${encodeURIComponent(m.id)}/community`]) {
    blobs.push((await t.req('GET', path, { cookie: u.cookie })).text);
  }
  for (const b of blobs) assert.doesNotMatch(b, /pass_hash|pass_salt|token_hash|scrypt/i);
  const rows = t.app.db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.token_hash !== token && !r.token_hash.includes(token)), 'token mentah tidak boleh tersimpan');
  const usr = t.app.db.prepare("SELECT pass_hash FROM users WHERE username = 'rahasia_tes'").get();
  assert.ok(usr.pass_hash.length >= 64 && !usr.pass_hash.includes('kata-sandi-1'));
});

test('cookie Secure aktif lewat COOKIE_SECURE atau X-Forwarded-Proto (dengan TRUST_PROXY)', async () => {
  const a = await boot({ secureCookies: true });
  try {
    const r = await a.req('POST', '/api/auth/register', { body: { username: 'aman_1', password: 'kata-sandi-1' } });
    assert.match(r.setCookie, /Secure/);
  } finally { await a.close(); }
  const b = await boot({ trustProxy: true });
  try {
    const r = await b.req('POST', '/api/auth/register', { body: { username: 'aman_2', password: 'kata-sandi-1' }, headers: { 'x-forwarded-proto': 'https' } });
    assert.match(r.setCookie, /Secure/);
  } finally { await b.close(); }
  const c = await boot({ trustProxy: false });
  try {
    const r = await c.req('POST', '/api/auth/register', { body: { username: 'aman_3', password: 'kata-sandi-1' }, headers: { 'x-forwarded-proto': 'https' } });
    assert.doesNotMatch(r.setCookie, /Secure/, 'header proxy diabaikan bila TRUST_PROXY mati');
  } finally { await c.close(); }
});

test('batas laju API: 429 + Retry-After; X-Forwarded-For tidak bisa dipakai menghindar bila proxy tak dipercaya', async () => {
  const a = await boot({ rateLimitPerMinute: 5 });
  try {
    const codes = [];
    let last;
    for (let i = 0; i < 8; i++) { last = await a.req('GET', '/api/health', { headers: { 'x-forwarded-for': `10.0.0.${i}` } }); codes.push(last.status); }
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(codes.slice(5).every((c) => c === 429), codes.join());
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.equal(last.json.error.code, 'rate_limited');
    const staticOk = await a.req('GET', '/');
    assert.equal(staticOk.status, 200, 'halaman statis tidak ikut dibatasi API');
  } finally { await a.close(); }
  const b = await boot({ rateLimitPerMinute: 3, trustProxy: true });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await b.req('GET', '/api/health', { headers: { 'x-forwarded-for': `203.0.113.${i}` } })).status);
    assert.ok(codes.every((c) => c === 200), 'IP berbeda lewat proxy tepercaya dihitung terpisah: ' + codes.join());
  } finally { await b.close(); }
});

test('batas laju login/daftar', async () => {
  const a = await boot({ authRateLimitPerMinute: 4 });
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await a.req('POST', '/api/auth/login', { body: { username: `orang_${i}`, password: 'kata-sandi-1' } })).status);
    assert.equal(codes.filter((c) => c === 429).length, 3, codes.join());
  } finally { await a.close(); }
});

test('galat tak terduga dijawab 500 generik tanpa jejak tumpukan', async () => {
  const logs = [];
  const boom = { name: 'boom', isDemo: false, async listMatches() { throw new TypeError('rahasia-internal-xyz'); }, async getMatch() { throw new TypeError('rahasia-internal-xyz'); } };
  const a = await boot({ provider: 'thesportsdb', primaryProvider: boom, fallbackDemo: false, log: (...x) => logs.push(x.join(' ')) });
  try {
    for (const path of ['/api/matches', '/api/matches/tsdb:1/analysis']) {
      const r = await a.req('GET', path);
      assert.ok(r.status >= 400);
      assert.doesNotMatch(r.text, /rahasia-internal|at .*\.js:\d+|node_modules/);
    }
  } finally { await a.close(); }
});

test('banyak koneksi paralel + permintaan rusak tidak menjatuhkan server', async () => {
  const a = await boot();
  try {
    const burst = Array.from({ length: 150 }, (_, i) => a.req('GET', i % 3 === 0 ? '/api/matches' : i % 3 === 1 ? '/api/config' : '/css/app.css'));
    const res = await Promise.all(burst);
    assert.ok(res.every((r) => r.status === 200));
    const weird = [
      rawGet(a.base, '/api/matches?from=%ff'), rawGet(a.base, '/%ff'), rawGet(a.base, '/api/matches/%ff/analysis'),
      rawGet(a.base, '/' + 'a'.repeat(9000)), rawGet(a.base, '/api/' + 'b'.repeat(9000)),
      rawGet(a.base, '/api/matches?' + 'q=1&'.repeat(2000)), rawGet(a.base, '/api/users/%00%00%00'),
    ];
    for (const r of await Promise.all(weird)) assert.ok(r.status < 500, String(r.status));
    assert.equal((await a.req('GET', '/api/health')).status, 200, 'server masih hidup');
  } finally { await a.close(); }
});

test('ALLOWED_ORIGINS: tampilan di domain lain diizinkan hanya bila terdaftar', async () => {
  const a = await boot({ allowedOrigins: 'https://jonbet.netlify.app/, https://staging--jonbet.netlify.app' });
  try {
    const body = { username: 'netlify_1', password: 'kata-sandi-1' };
    const ok = await a.req('POST', '/api/auth/register', { body, headers: { origin: 'https://jonbet.netlify.app' } });
    assert.equal(ok.status, 201);
    const ok2 = await a.req('POST', '/api/auth/login', { body, headers: { origin: 'https://STAGING--jonbet.netlify.app' } });
    assert.equal(ok2.status, 200);
    for (const origin of ['https://jonbet.netlify.app.evil.example', 'http://jonbet.netlify.app', 'https://evil.example', 'https://netlify.app']) {
      const r = await a.req('POST', '/api/auth/login', { body, headers: { origin } });
      assert.equal(r.status, 403, origin);
    }
  } finally { await a.close(); }
  const b = await boot();
  try {
    const r = await b.req('POST', '/api/auth/register', { body: { username: 'netlify_2', password: 'kata-sandi-1' }, headers: { origin: 'https://jonbet.netlify.app' } });
    assert.equal(r.status, 403, 'tanpa ALLOWED_ORIGINS, domain lain tetap ditolak');
  } finally { await b.close(); }
});
