// Pratinjau lokal versi GitHub Pages: membangun situs (data simulasi, tanpa internet) lalu menyajikannya
// di http://localhost:8080/jonbet/ seperti yang akan terlihat di github.io/NAMA-REPO/.
// Pemakaian: npm run preview:pages        (atau PROVIDER=thesportsdb npm run preview:pages untuk data nyata)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPages } from './build-pages.mjs';
import { startStaticSite } from './static-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provider = (process.env.PROVIDER || 'demo').toLowerCase();
const result = await buildPages({ outDir: path.join(ROOT, 'dist'), stateDir: path.join(ROOT, '.pages-state'), provider, key: process.env.THESPORTSDB_KEY || '3' });
const site = await startStaticSite(result.outDir, { port: Number(process.env.PORT || 8080), host: '0.0.0.0' });
console.log(`\nPratinjau siap (${result.outcome}, ${result.matches} pertandingan): ${site.url}`);
console.log('Tekan Ctrl+C untuk berhenti.');
process.on('SIGINT', async () => { await site.close(); process.exit(0); });
