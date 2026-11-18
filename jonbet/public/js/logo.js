import { MARK_SVG } from './logo-art.js';

// Logo statis: di-parse sekali dari string SVG milik kita sendiri (bukan input pengguna).
let template;
export function logoMark(className = '') {
  if (!template) template = new DOMParser().parseFromString(MARK_SVG, 'image/svg+xml').documentElement;
  const el = document.importNode(template, true);
  // Id gradien harus unik per salinan agar tidak bentrok antar elemen logo di halaman yang sama.
  const uid = `jb${Math.random().toString(36).slice(2, 7)}`;
  for (const node of el.querySelectorAll('[id]')) {
    const old = node.getAttribute('id');
    node.setAttribute('id', `${old}-${uid}`);
    for (const ref of el.querySelectorAll('*')) {
      for (const attr of ['fill', 'stroke']) {
        if (ref.getAttribute(attr) === `url(#${old})`) ref.setAttribute(attr, `url(#${old}-${uid})`);
      }
    }
  }
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  if (className) el.setAttribute('class', className);
  return el;
}
