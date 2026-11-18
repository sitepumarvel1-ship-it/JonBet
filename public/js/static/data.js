// Pembaca berkas data mode statis (data/*.json di situs yang sama). Selalu divalidasi ulang ke jaringan
// (cache: 'no-cache') sehingga murah (304) tetapi tidak pernah menyajikan data basi tanpa sepengetahuan.
import { ApiError } from '../api.js';
import { setOffline } from '../state.js';
import { matchFile } from './paths.js';

const root = () => new URL('data/', document.baseURI);
const memo = new Map(); // nama -> { at, value }
const MEMO_MS = 15_000;

export async function getJson(rel, { signal } = {}) {
  let res;
  try {
    res = await fetch(new URL(rel, root()), { cache: 'no-cache', signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    setOffline(true);
    throw new ApiError('Tidak bisa terhubung ke internet. Periksa koneksi lalu coba lagi.', 0, 'network');
  }
  setOffline(false);
  if (res.status === 404) throw new ApiError('Data tidak ditemukan. Mungkin sudah lewat dari jendela data terbaru.', 404, 'not_found');
  if (!res.ok) throw new ApiError('Data belum bisa dimuat. Coba lagi sebentar.', 502, 'upstream');
  try {
    return await res.json();
  } catch {
    throw new ApiError('Data sedang diperbarui. Coba lagi sebentar.', 502, 'bad_data');
  }
}

async function cached(name) {
  const hit = memo.get(name);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const value = await getJson(name);
  memo.set(name, { at: Date.now(), value });
  return value;
}

export const config = () => cached('config.json');
export const meta = () => cached('meta.json');
export const matches = () => cached('matches.json');
export const results = () => cached('results.json');
export const record = () => cached('record.json');

export async function bundle(id) {
  const file = matchFile(id);
  if (!file) throw new ApiError('Pertandingan tidak ditemukan.', 404, 'not_found');
  return getJson(file);
}
