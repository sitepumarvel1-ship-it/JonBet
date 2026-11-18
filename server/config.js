import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export const config = Object.freeze({
  root,
  publicDir: path.join(root, 'public'),
  port: env.PORT !== undefined ? Number(env.PORT) : 3000,
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || path.join(root, 'data', 'jonbet.db'),

  // Sumber data pertandingan: "auto" (ESPN + TheSportsDB, data nyata), "espn", "thesportsdb", atau "demo" (data simulasi).
  provider: (env.PROVIDER || 'auto').toLowerCase(),
  // Jika sumber nyata gagal total dan belum ada data sama sekali, pakai data demo (dengan label jelas di UI).
  fallbackDemo: env.FALLBACK_DEMO !== 'false',
  tsdbKey: env.THESPORTSDB_KEY || '3',

  // AI penjelas. Tanpa kunci, JonBet AI bawaan (berbasis model statistik) yang menjawab.
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',

  trustProxy: env.TRUST_PROXY === 'true',
  // Daftar alamat (dipisah koma) yang boleh mengirim permintaan penulisan selain alamat server sendiri.
  allowedOrigins: env.ALLOWED_ORIGINS || '',
  secureCookies: env.COOKIE_SECURE === 'true',
  sessionDays: 30,

  // Batas keamanan
  maxBodyBytes: 16 * 1024,
  rateLimitPerMinute: Number(env.RATE_LIMIT || 240),
  authRateLimitPerMinute: Number(env.AUTH_RATE_LIMIT || 12),
  aiRateLimitPerMinute: Number(env.AI_RATE_LIMIT || 20),
  writeRateLimitPerMinute: 40,
});
