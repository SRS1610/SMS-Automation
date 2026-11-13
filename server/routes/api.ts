import express, { type Router } from 'express';
import { z } from 'zod';
import { listCountries, normalizePhone } from '../../shared/phone';
import { analyzeSms } from '../../shared/sms';
import { CAMPAIGN_STATUSES, MESSAGE_STATUSES, type MessageRow } from '../../shared/types';
import type { CampaignStore } from '../campaignStore';
import { MAX_MESSAGE_CHARS, MAX_RECIPIENTS } from '../campaignStore';
import type { Dispatcher } from '../dispatcher';
import { badRequest } from '../errors';
import type { ProviderStore } from '../providerStore';
import { PROVIDERS, providerTypeInfo } from '../providers/registry';
import { ProviderError } from '../providers/types';
import type { SettingsStore } from '../settings';
import type { SuppressionStore } from '../suppressions';

export interface ApiDeps {
  providers: ProviderStore;
  campaigns: CampaignStore;
  settings: SettingsStore;
  suppressions: SuppressionStore;
  dispatcher: Dispatcher;
}

const providerInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(10),
  countries: z.array(z.string().length(2)).max(300).default([]),
  rateLimit: z.number().min(0.1).max(1000).default(10),
  defaultSender: z.string().trim().max(32).nullable().default(null),
  config: z.record(z.string(), z.string().max(20_000)).default({}),
});

const settingsInput = z
  .object({
    defaultCountry: z.string().length(2),
    defaultSender: z.string().max(32),
    publicBaseUrl: z.string().max(500),
    optOutFooter: z.string().max(160),
    maxAttempts: z.number().int().min(1).max(10),
  })
  .partial();

const campaignInput = z.object({
  name: z.string().max(120).default(''),
  body: z.string().min(1, 'Message is empty').max(MAX_MESSAGE_CHARS),
  sender: z.string().trim().max(32).nullish(),
  providerId: z.string().max(64).nullish(),
  scheduledAt: z.string().max(64).nullish(),
  defaultCountry: z.string().length(2).nullish(),
  recipients: z
    .array(
      z.object({
        phone: z.string().max(64),
        vars: z.record(z.string().max(64), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).optional(),
      }),
    )
    .min(1, 'Add at least one recipient')
    .max(MAX_RECIPIENTS),
});

const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(100).optional(),
});

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formulas and quote everything.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^\+\d/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function messagesCsv(rows: MessageRow[]): string {
  const header = ['to', 'country', 'status', 'gateway', 'gateway_message_id', 'attempts', 'segments', 'encoding', 'sent_at', 'delivered_at', 'error', 'body'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [r.to, r.country, r.status, r.providerName, r.providerMessageId, r.attempts, r.segments, r.encoding, r.sentAt, r.deliveredAt, r.error, r.body]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function apiRoutes(deps: ApiDeps): Router {
  const { providers, campaigns, settings, suppressions, dispatcher } = deps;
  const router = express.Router();

  // ---- reference data ---------------------------------------------------
  router.get('/provider-types', (_req, res) => {
    res.json(PROVIDERS.map(providerTypeInfo));
  });
  router.get('/countries', (_req, res) => {
    res.json(listCountries());
  });

  // ---- gateways -----------------------------------------------------------
  router.get('/providers', (_req, res) => {
    res.json(providers.list());
  });
  router.post('/providers', (req, res) => {
    res.status(201).json(providers.create(providerInput.parse(req.body)));
  });
  router.get('/providers/:id', (req, res) => {
    res.json(providers.get(req.params.id));
  });
  router.put('/providers/:id', (req, res) => {
    res.json(providers.update(req.params.id, providerInput.parse(req.body)));
  });
  router.patch('/providers/:id', (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(providers.setEnabled(req.params.id, enabled));
  });
  router.delete('/providers/:id', (req, res) => {
    providers.remove(req.params.id);
    res.status(204).end();
  });

  router.post('/providers/:id/test', async (req, res) => {
    providers.get(req.params.id); // 404 if missing
    const provider = providers.resolve(req.params.id)!;
    try {
      const message = await provider.def.test(provider.config, dispatcher.contextFor(provider.id));
      providers.recordTest(provider.id, true, message);
      res.json({ ok: true, message });
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : `Unexpected error: ${(err as Error).message}`;
      providers.recordTest(provider.id, false, message);
      res.json({ ok: false, message });
    }
  });

  router.post('/providers/:id/send-test', async (req, res) => {
    const body = z
      .object({ to: z.string().min(3).max(32), text: z.string().min(1).max(MAX_MESSAGE_CHARS), from: z.string().max(32).optional() })
      .parse(req.body);
    providers.get(req.params.id);
    const provider = providers.resolve(req.params.id)!;
    const current = settings.get();
    const phone = normalizePhone(body.to, current.defaultCountry);
    if (!phone.ok) throw badRequest(`Phone number: ${phone.reason}`);
    const from = body.from?.trim() || provider.defaultSender || current.defaultSender || undefined;
    if (provider.def.senderRequired && !from) throw badRequest(`${provider.def.label} needs a sender ID`);
    try {
      const result = await provider.def.send(
        provider.config,
        { to: phone.e164, from, text: body.text, unicode: analyzeSms(body.text).encoding === 'UCS-2' },
        { fetch: dispatcher.contextFor(provider.id).fetch },
      );
      res.json({ ok: true, message: `Accepted by ${provider.name} (ID ${result.providerMessageId})`, to: phone.e164 });
    } catch (err) {
      res.json({ ok: false, message: err instanceof ProviderError ? err.message : `Unexpected error: ${(err as Error).message}` });
    }
  });

  // ---- settings ----------------------------------------------------------
  router.get('/settings', (_req, res) => {
    res.json(settings.get());
  });
  router.put('/settings', (req, res) => {
    res.json(settings.update(settingsInput.parse(req.body)));
  });

  // ---- opt-out list ------------------------------------------------------
  router.get('/suppressions', (req, res) => {
    res.json(suppressions.list(page.parse(req.query)));
  });
  router.post('/suppressions', (req, res) => {
    const body = z
      .object({ numbers: z.array(z.string().max(64)).min(1).max(100_000), reason: z.string().max(200).nullish() })
      .parse(req.body);
    res.json(suppressions.add(body.numbers, body.reason?.trim() || null, settings.get().defaultCountry));
  });
  router.delete('/suppressions/:number', (req, res) => {
    suppressions.remove(req.params.number);
    res.status(204).end();
  });

  // ---- campaigns ---------------------------------------------------------
  router.get('/overview', (_req, res) => {
    res.json(campaigns.overview());
  });
  router.get('/campaigns', (req, res) => {
    const q = page.extend({ status: z.enum(CAMPAIGN_STATUSES).optional() }).parse(req.query);
    res.json(campaigns.list(q));
  });
  router.post('/campaigns', (req, res) => {
    const result = campaigns.create(campaignInput.parse(req.body));
    dispatcher.tick();
    res.status(201).json(result);
  });
  router.get('/campaigns/:id', (req, res) => {
    res.json(campaigns.get(req.params.id));
  });
  router.delete('/campaigns/:id', (req, res) => {
    campaigns.remove(req.params.id);
    res.status(204).end();
  });
  router.get('/campaigns/:id/messages', (req, res) => {
    const q = page.extend({ status: z.enum(MESSAGE_STATUSES).optional() }).parse(req.query);
    res.json(campaigns.messages(req.params.id, q));
  });
  router.get('/campaigns/:id/export.csv', (req, res) => {
    const campaign = campaigns.get(req.params.id);
    const filename = `${campaign.name.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 60) || 'campaign'}-${campaign.id}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(messagesCsv(campaigns.allMessages(req.params.id)));
  });

  const action = (name: 'pause' | 'resume' | 'cancel' | 'retryFailed') => (req: express.Request<{ id: string }>, res: express.Response) => {
    const result = campaigns[name](req.params.id);
    dispatcher.tick();
    res.json(result);
  };
  router.post('/campaigns/:id/pause', action('pause'));
  router.post('/campaigns/:id/resume', action('resume'));
  router.post('/campaigns/:id/cancel', action('cancel'));
  router.post('/campaigns/:id/retry-failed', action('retryFailed'));

  return router;
}
