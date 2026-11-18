import { h } from './dom.js';
import { api } from './api.js';
import { setUser, on } from './state.js';
import { STATIC } from './mode.js';
import { icon, toast } from './components.js';

let dlg;

export function initAuth() {
  on('need-auth', (mode) => openAuth(mode || 'login'));
}

export function openAuth(mode = 'login') {
  dlg?.remove();
  let current = mode;
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 20, required: true });
  const pass = h('input', { class: 'input', name: 'password', type: 'password', maxlength: 72, required: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' });
  const title = h('h2', {});
  const hint = h('p', { class: 'muted' });
  const switchBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' });
  const form = h('form', { class: 'form-box', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'auth-user' }, STATIC ? 'Nama profil' : 'Nama pengguna'), user),
    STATIC ? null : h('div', { class: 'field' }, h('label', { for: 'auth-pass' }, 'Kata sandi'), pass),
    hint, msg, submit);
  user.id = 'auth-user';
  pass.id = 'auth-pass';

  function draw() {
    const reg = current === 'register';
    title.textContent = STATIC ? (reg ? 'Buat profil' : 'Masuk') : (reg ? 'Buat akun' : 'Masuk');
    submit.textContent = reg ? (STATIC ? 'Buat profil' : 'Daftar') : 'Masuk';
    switchBtn.textContent = STATIC ? (reg ? 'Sudah punya profil? Masuk' : 'Belum punya profil? Buat') : (reg ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar');
    hint.textContent = STATIC
      ? 'Tanpa kata sandi. Profil dan tebakan hanya tersimpan di browser perangkat ini dan tidak terlihat orang lain. Nama 3 sampai 20 karakter (huruf, angka, garis bawah).'
      : reg ? 'Nama pengguna 3 sampai 20 karakter (huruf, angka, garis bawah). Kata sandi minimal 8 karakter.' : '';
    pass.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    msg.textContent = '';
  }

  switchBtn.addEventListener('click', () => { current = current === 'login' ? 'register' : 'login'; draw(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    submit.disabled = true;
    try {
      const r = await api(`/api/auth/${current}`, { method: 'POST', body: STATIC ? { username: user.value.trim() } : { username: user.value.trim(), password: pass.value } });
      setUser(r.user);
      dlg.close();
      toast(current === 'register' ? `Selamat datang, ${r.user.username}!` : `Halo lagi, ${r.user.username}.`);
    } catch (err) { msg.textContent = err.message; } finally { submit.disabled = false; }
  });

  dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'auth-title' },
    h('div', { class: 'modal-body' },
      h('div', { class: 'modal-head' }, title, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Tutup', onclick: () => dlg.close() }, icon('close'))),
      form, switchBtn));
  title.id = 'auth-title';
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  draw();
  dlg.showModal();
  user.focus();
}
