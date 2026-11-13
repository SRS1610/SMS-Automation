import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { Auth } from './auth';
import { CampaignStore } from './campaignStore';
import type { AppConfig } from './config';
import { SecretBox } from './crypto';
import { type DB } from './db';
import { Dispatcher, type DispatcherOptions } from './dispatcher';
import { HttpError } from './errors';
import { ProviderStore } from './providerStore';
import { apiRoutes } from './routes/api';
import { webhookRoutes } from './routes/webhooks';
import { SettingsStore } from './settings';
import { SuppressionStore } from './suppressions';

export interface AppOptions {
  config: Pick<AppConfig, 'adminPassword' | 'appSecret' | 'webDir' | 'secureCookies'> & Partial<Pick<AppConfig, 'desktop' | 'allowedHosts'>>;
  db: DB;
  dispatcher?: DispatcherOptions;
  /** Called when the desktop app's Quit button is used. */
  onQuit?: () => void;
}

export function createApp({ config, db, dispatcher: dispatcherOptions, onQuit }: AppOptions) {
  const box = new SecretBox(config.appSecret);
  const settings = new SettingsStore(db);
  const providers = new ProviderStore(db, box);
  const suppressions = new SuppressionStore(db);
  const campaigns = new CampaignStore(db, providers, settings, suppressions);
  const dispatcher = new Dispatcher({ db, providers, settings, campaigns, suppressions }, dispatcherOptions);
  const auth = new Auth(config.adminPassword, box, config.secureCookies, !!config.desktop);
  const allowedHosts = new Set(config.allowedHosts ?? []);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Gateways reach /webhooks through a tunnel or proxy under another host name, so only the
  // dashboard and API are pinned to the allowed hosts.
  if (allowedHosts.size > 0) {
    app.use((req, res, next) => {
      if (req.path.startsWith('/webhooks/') || allowedHosts.has((req.headers.host ?? '').toLowerCase())) return next();
      res.status(403).type('text/plain').send('Host not allowed');
    });
  }

  app.use('/webhooks', webhookRoutes({ providers, campaigns, log: (m) => console.error(`[webhooks] ${m}`) }));

  const api = express.Router();
  api.use(express.json({ limit: '25mb' }));
  api.use(auth.routes());
  api.use(auth.middleware());
  api.use(apiRoutes({ providers, campaigns, settings, suppressions, dispatcher }));
  if (config.desktop) {
    api.post('/app/quit', (req, res) => {
      // Requiring a JSON body forces a CORS preflight, so other websites can't trigger this.
      if (req.body?.confirm !== true) {
        res.status(400).json({ error: 'Missing confirmation' });
        return;
      }
      res.json({ ok: true });
      setTimeout(() => onQuit?.(), 100);
    });
  }
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', api);

  if (existsSync(path.join(config.webDir, 'index.html'))) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/webhooks')) return next();
      res.sendFile(path.join(config.webDir, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      res.status(400).json({ error: `${where}${first?.message ?? 'Invalid request'}`, issues: err.issues });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, dispatcher, providers, campaigns, settings, suppressions };
}
