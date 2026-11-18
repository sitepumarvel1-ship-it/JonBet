// Menjalankan server dengan data simulasi; bekerja sama di Windows, macOS, dan Linux.
process.env.PROVIDER = 'demo';
await import('../server/index.js');
