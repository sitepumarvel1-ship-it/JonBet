import { setOffline } from './state.js';
import { STATIC } from './mode.js';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  // Mode statis (GitHub Pages): tidak ada server, permintaan dijawab oleh modul di browser.
  if (STATIC) return (await import('./static/api.js')).handle(path, { method, body, signal });
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    setOffline(true);
    throw new ApiError('Tidak bisa terhubung ke server. Periksa koneksi internet.', 0, 'network');
  }
  setOffline(false);
  let data = null;
  try { data = await res.json(); } catch { /* badan kosong */ }
  if (!res.ok) throw new ApiError(data?.error?.message || 'Terjadi kesalahan. Coba lagi.', res.status, data?.error?.code);
  return data;
}
