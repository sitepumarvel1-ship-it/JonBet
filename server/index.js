import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
const port = await app.listen();

const src = app.service.health();
console.log(`JonBet berjalan di http://localhost:${port}`);
console.log(`Sumber data : ${src.provider}${config.provider !== 'demo' && config.fallbackDemo ? ' (cadangan: demo)' : ''}`);
console.log(`JonBet AI   : ${config.anthropicKey ? `Claude (${config.anthropicModel}) + model bawaan` : 'model bawaan'}`);
console.log(`LISTENING ${port}`);

const shutdown = async (sig) => {
  console.log(`\n${sig}: menutup server...`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
