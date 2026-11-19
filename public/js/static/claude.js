// Kunci API Claude milik pengguna (opsional). Disimpan HANYA di browser perangkat ini (localStorage), tidak pernah dikirim ke
// server JonBet atau GitHub; dipakai langsung ke api.anthropic.com saat pengguna bertanya di "Tanya JonBet AI".
const KEY = 'jonbet.claude.v1';
export const CLAUDE_MODELS = [
  ['claude-haiku-5-5', 'Haiku 5.5 (hemat, cepat)'],
  ['claude-sonnet-5-5', 'Sonnet 5.5 (lebih cermat, lebih mahal)'],
];
let mem = null; // cadangan bila localStorage tidak bisa dipakai (mode pribadi)

export function getClaude() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const v = JSON.parse(raw); if (v && typeof v.key === 'string' && v.key.length >= 20 && v.key.length <= 300) return { key: v.key, model: CLAUDE_MODELS.some(([m]) => m === v.model) ? v.model : CLAUDE_MODELS[0][0] }; }
  } catch { /* abaikan */ }
  return mem;
}
export function setClaude({ key, model }) {
  const k = String(key || '').trim();
  if (k.length < 20 || k.length > 300 || /\s/.test(k)) throw new Error('Kunci tidak tampak seperti kunci API Claude.');
  const v = { key: k, model: CLAUDE_MODELS.some(([m]) => m === model) ? model : CLAUDE_MODELS[0][0] };
  mem = v;
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* tetap di memori sampai tab ditutup */ }
  return v;
}
export function clearClaude() {
  mem = null;
  try { localStorage.removeItem(KEY); } catch { /* abaikan */ }
}
