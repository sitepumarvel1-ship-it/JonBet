// Memeriksa sintaks semua berkas JavaScript (server, klien, skrip, tes) tanpa menjalankannya.
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['server', 'public/js', 'public/sw.js', 'scripts', 'test'];
const files = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); return; }
  if (['.js', '.mjs'].includes(extname(p))) files.push(p);
};
for (const r of roots) walk(r);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`Sintaks salah di ${f}\n${r.stderr}`); }
}
console.log(`${files.length - bad}/${files.length} berkas JavaScript lolos pemeriksaan sintaks`);
process.exit(bad ? 1 : 0);
