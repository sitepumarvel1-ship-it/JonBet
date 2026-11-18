// Penyedia gabungan: sumber utama (ESPN) + pelengkap (TheSportsDB).
//
// - Laga yang sama di kedua sumber hanya tampil sekali, dan versi sumber utama yang dipakai (datanya lebih lengkap).
//   "Sama" = cabang sama, jam mulai berdekatan, dan kedua nama tim cocok (urutan kandang/tandang boleh terbalik).
// - Bila satu sumber gagal, sumber lain tetap dipakai. Hanya bila keduanya gagal, permintaan dianggap gagal.
// - Cabang yang tidak dicakup sumber utama (tenis, bulu tangkis, voli, esports, MMA, rugby, futsal) datang dari pelengkap.

import { nameScore } from '../../public/js/static/espn.js';

const BUCKET = 3 * 3_600_000;

const sameTeams = (a, b) => (nameScore(a.home.name, b.home.name) > 0 && nameScore(a.away.name, b.away.name) > 0)
  || (nameScore(a.home.name, b.away.name) > 0 && nameScore(a.away.name, b.home.name) > 0);

/** Buang dari `extra` laga yang sudah ada di `main`. */
export function mergeMatches(main, extra) {
  const index = new Map(); // `${cabang}|${ember 3 jam}` -> laga
  const add = (m) => {
    const key = `${m.sport}|${Math.floor(Date.parse(m.kickoff) / BUCKET)}`;
    const list = index.get(key);
    if (list) list.push(m); else index.set(key, [m]);
  };
  main.forEach(add);
  const kept = [];
  for (const e of extra) {
    const b = Math.floor(Date.parse(e.kickoff) / BUCKET);
    let dup = false;
    for (let d = -1; d <= 1 && !dup; d++) {
      for (const m of index.get(`${e.sport}|${b + d}`) || []) {
        if (Math.abs(Date.parse(m.kickoff) - Date.parse(e.kickoff)) <= BUCKET && sameTeams(m, e)) { dup = true; break; }
      }
    }
    if (!dup) kept.push(e);
  }
  return [...main, ...kept];
}

export function createCompositeProvider({ primary, secondary, log = () => {} }) {
  let report = null;
  return {
    name: `${primary.name}+${secondary.name}`,
    isDemo: false,
    premium: !!secondary.premium,
    get report() { return report; },

    async listMatches(args) {
      const [a, b] = await Promise.allSettled([primary.listMatches(args), secondary.listMatches(args)]);
      report = {
        [primary.name]: a.status === 'fulfilled' ? { ok: true, matches: a.value.length, ...(primary.report ? { detail: primary.report } : {}) } : { ok: false, error: String(a.reason?.message || a.reason) },
        [secondary.name]: b.status === 'fulfilled' ? { ok: true, matches: b.value.length } : { ok: false, error: String(b.reason?.message || b.reason) },
      };
      if (a.status === 'rejected' && b.status === 'rejected') {
        const ma = String(a.reason?.message || a.reason);
        const mb = String(b.reason?.message || b.reason);
        const err = new Error(`${ma} | ${secondary.name}: ${mb}`);
        err.cause = a.reason;
        throw err;
      }
      if (a.status === 'rejected') log(`${primary.name} gagal, memakai ${secondary.name} saja: ${a.reason?.message}`);
      if (b.status === 'rejected') log(`${secondary.name} gagal, memakai ${primary.name} saja: ${b.reason?.message}`);
      return mergeMatches(a.status === 'fulfilled' ? a.value : [], b.status === 'fulfilled' ? b.value : []);
    },

    async getMatch(id) {
      return String(id).startsWith('espn:') ? primary.getMatch(id) : secondary.getMatch(id);
    },
  };
}
