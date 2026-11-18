// Penyimpanan keadaan aplikasi + pemancar kejadian sederhana.
const listeners = new Map();

export const state = {
  user: null,
  config: null,
  offline: !navigator.onLine,
};

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}

export function emit(evt, payload) {
  for (const fn of listeners.get(evt) || []) {
    try { fn(payload); } catch (e) { console.error(e); }
  }
}

export function setOffline(v) {
  if (state.offline === v) return;
  state.offline = v;
  emit('offline', v);
}

export function setUser(u) {
  state.user = u;
  emit('user', u);
}

export const sportOf = (id) => (state.config?.sports || []).find((s) => s.id === id) || null;
