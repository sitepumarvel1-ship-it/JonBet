// Penamaan berkas data pada mode statis. Dipakai bersama oleh browser dan skrip build.

export const MATCH_ID_RE = /^(demo|tsdb|espn|pub):[A-Za-z0-9_-]{1,48}$/;

/** id pertandingan -> berkas bundel analisis, relatif terhadap folder data/. */
export function matchFile(id) {
  const s = String(id);
  if (!MATCH_ID_RE.test(s)) return null;
  return `m/${s.replace(':', '_')}.json`;
}
