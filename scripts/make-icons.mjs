// Membuat ikon PNG dari logo. Jalankan: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK_SVG, iconSvg } from '../public/js/logo-art.js';

const require = createRequire('/opt/npm-tools/node_modules/');
const sharp = require('sharp');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
fs.mkdirSync(out, { recursive: true });

const png = (svg, size, file) => sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(out, file));

await png(iconSvg(0.78), 192, 'icon-192.png');
await png(iconSvg(0.78), 512, 'icon-512.png');
await png(iconSvg(0.56), 512, 'icon-maskable-512.png');
await png(iconSvg(0.74), 180, 'apple-touch-icon.png');
await png(MARK_SVG, 64, 'favicon-64.png');
fs.writeFileSync(path.join(out, 'logo.svg'), MARK_SVG);
await png(MARK_SVG, 512, 'logo-512.png');
console.log('ikon selesai:', fs.readdirSync(out).join(', '));
