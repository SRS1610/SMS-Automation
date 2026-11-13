import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';

const config = loadConfig();
const db = openDb(config.dbFile);
const { app, dispatcher } = createApp({ config, db });

dispatcher.start();
const server = app.listen(config.port, config.host, () => {
  console.log(`SMS Automation listening on http://localhost:${config.port}`);
  if (!config.adminPassword) {
    console.warn('ADMIN_PASSWORD is not set: the dashboard is open to anyone who can reach this port.');
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, finishing in-flight messages…`);
  server.close();
  await dispatcher.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
