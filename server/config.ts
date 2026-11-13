import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  adminPassword: string | null;
  appSecret: string;
  /** Directory with the built dashboard, served when present. */
  webDir: string;
  /** Cookies get the Secure flag (set when served over HTTPS). */
  secureCookies: boolean;
}

function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 'sms.db'),
    adminPassword: env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD : null,
    appSecret: env.APP_SECRET || loadOrCreateSecret(dataDir),
    webDir: path.resolve(env.WEB_DIR || './dist/web'),
    secureCookies: env.SECURE_COOKIES === 'true',
  };
}
