// Tanya JonBet AI: asisten lintas laga ("laga live sekarang", "favorit malam ini", "jadwal basket besok").
// Jawabannya dihitung dari daftar laga (di browser pada versi statis, di server pada versi server); ini bukan model bahasa.
import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { matchRow } from '../components.js';

const START = ['Laga live sekarang', 'Favorit malam ini', 'Jadwal besok', 'Hasil kemarin', 'Laga paling ketat hari ini'];

export function askView() {
  let context = null;
  let busy = false;
  const log = h('div', { class: 'chat-log chat-log-tall', role: 'log', 'aria-live': 'polite', 'aria-label': 'Percakapan dengan JonBet AI' });
  const sugg = h('div', { class: 'sugg' });
  const input = h('input', { class: 'input', type: 'text', maxlength: 500, placeholder: 'Tanya soal laga hari ini…', 'aria-label': 'Pertanyaan untuk JonBet AI', autocomplete: 'off' });
  const send = h('button', { class: 'btn btn-primary', type: 'submit', 'aria-label': 'Kirim' }, icon('send', { size: 18 }));
  const form = h('form', { class: 'chat-form' }, input, send);

  const bubble = (who, text, rows) => {
    const b = h('div', { class: `bubble ${who}` }, text);
    log.append(b);
    if (rows?.length) log.append(h('div', { class: 'ask-rows' }, ...rows.map((m) => matchRow(m))));
    log.scrollTop = log.scrollHeight;
    return b;
  };
  const setSuggestions = (list) => mount(sugg, list.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => ask(s) }, s)));

  async function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; send.disabled = true; input.value = '';
    bubble('user', text);
    const typing = bubble('ai', 'JonBet AI sedang mencari…');
    typing.classList.add('typing');
    try {
      const r = await api('/api/ask', { method: 'POST', body: { message: text, context } });
      typing.remove();
      bubble('ai', r.reply, r.matches);
      context = r.context || null;
      setSuggestions(r.suggestions?.length ? r.suggestions : START);
    } catch (e) {
      typing.remove();
      bubble('ai', e.message || 'Maaf, pertanyaan belum bisa dijawab.');
    } finally { busy = false; send.disabled = false; input.focus({ preventScroll: true }); }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });

  bubble('ai', 'Halo! Saya JonBet AI. Tanyakan soal semua laga di JonBet: yang sedang live, jadwal, hasil, favorit menurut model, atau laga paling ketat. Boleh per cabang, liga, atau tim, dan boleh menyambung ("kalau basket?", "besok?", "yang lain"). Untuk analisis mendalam satu laga, buka laganya lalu tanya di sana.');
  setSuggestions(START);

  return {
    title: 'Tanya JonBet AI',
    el: h('div', { class: 'page' },
      h('h1', { style: { font: '800 26px/1.2 var(--font-display)' } }, 'Tanya JonBet AI'),
      h('p', { class: 'sub' }, 'Jawaban disusun dari daftar laga dan peluang model, bukan dari model bahasa umum. Bukan saran bertaruh.'),
      h('div', { class: 'panel ask-panel' }, h('div', { class: 'chat' }, log, sugg, form))),
  };
}
