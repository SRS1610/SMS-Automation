import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { openDb } from '../server/db';

type Handler = (url: string, init: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** Spins up the real app on an ephemeral port with an in-memory DB and a fake gateway network. */
async function setup(opts: { password?: string; gateway?: Handler } = {}) {
  const calls: { url: string; body: string }[] = [];
  const gatewayFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: String(init.body ?? '') });
    const handler = opts.gateway ?? (() => ({ status: 201, body: { sid: `SM${calls.length}` } }));
    const res = await handler(url, init);
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof fetch;

  const db = openDb(':memory:');
  const ctx = createApp({
    config: { adminPassword: opts.password ?? null, appSecret: 'test-secret', webDir: '/nonexistent', secureCookies: false },
    db,
    dispatcher: { fetch: gatewayFetch, backoffMs: () => 0, log: () => {} },
  });
  const server: Server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  const cleanup = async () => {
    await ctx.dispatcher.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  };
  return { ...ctx, base, call, calls, cleanup, db };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
let current: Ctx | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});
async function start(opts?: Parameters<typeof setup>[0]) {
  current = await setup(opts);
  return current;
}

const TWILIO_CONFIG = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'super-secret-token' };

async function addTwilio(t: Ctx, extra: Record<string, unknown> = {}) {
  const res = await t.call('POST', '/api/providers', { name: 'Twilio', type: 'twilio', defaultSender: '+14155550100', config: TWILIO_CONFIG, ...extra });
  expect(res.status).toBe(201);
  return res.data;
}

describe('gateway settings API', () => {
  it('stores credentials encrypted and never returns secrets', async () => {
    const t = await start();
    const created = await addTwilio(t);
    expect(created.config).toEqual({ accountSid: TWILIO_CONFIG.accountSid, messagingServiceSid: '' });
    expect(created.secrets.authToken).toEqual({ set: true, hint: '••••oken' });
    expect(JSON.stringify(created)).not.toContain('super-secret-token');

    const row = t.db.prepare('SELECT config_enc FROM providers').get() as { config_enc: string };
    expect(row.config_enc).not.toContain('super-secret-token');

    // Blank secret on update keeps the stored one.
    const updated = await t.call('PUT', `/api/providers/${created.id}`, {
      name: 'Twilio US',
      type: 'twilio',
      countries: ['us'],
      config: { accountSid: TWILIO_CONFIG.accountSid, authToken: '' },
    });
    expect(updated.status).toBe(200);
    expect(updated.data.name).toBe('Twilio US');
    expect(updated.data.countries).toEqual(['US']);
    expect(t.providers.resolve(created.id)!.config.authToken).toBe('super-secret-token');
  });

  it('validates gateway input', async () => {
    const t = await start();
    expect((await t.call('POST', '/api/providers', { name: 'X', type: 'nope', config: {} })).status).toBe(400);
    const missing = await t.call('POST', '/api/providers', { name: 'X', type: 'twilio', config: { accountSid: TWILIO_CONFIG.accountSid } });
    expect(missing.status).toBe(400);
    expect(missing.data.error).toMatch(/Auth token is required/);
    expect((await t.call('POST', '/api/providers', { name: 'X', type: 'sandbox', countries: ['ZZ'], config: {} })).data.error).toMatch(/Unknown country/);
  });

  it('tests a connection and records the result', async () => {
    const t = await start({ gateway: () => ({ status: 200, body: { friendly_name: 'Acme', status: 'active' } }) });
    const gw = await addTwilio(t);
    const res = await t.call('POST', `/api/providers/${gw.id}/test`);
    expect(res.data).toEqual({ ok: true, message: 'Connected to account “Acme” (active)' });
    expect((await t.call('GET', `/api/providers/${gw.id}`)).data.lastTest.ok).toBe(true);
  });
});

describe('campaigns', () => {
  it('sends a personalised campaign and tracks delivery receipts', async () => {
    const t = await start();
    const gw = await addTwilio(t);
    await t.call('PUT', '/api/settings', { optOutFooter: 'Reply STOP to opt out', publicBaseUrl: 'https://sms.example.com' });

    const created = await t.call('POST', '/api/campaigns', {
      name: 'Launch',
      body: 'Hi {{name|there}}!',
      defaultCountry: 'US',
      recipients: [{ phone: '(415) 555-2671', vars: { name: 'Ada' } }, { phone: '+447400123456' }, { phone: '+14155552671' }, { phone: 'junk' }],
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ accepted: 2, duplicates: 1, invalidCount: 1 });

    await t.dispatcher.runUntilIdle();
    expect(t.calls).toHaveLength(2);
    const first = Object.fromEntries(new URLSearchParams(t.calls[0].body));
    expect(first).toMatchObject({ To: '+14155552671', From: '+14155550100', Body: 'Hi Ada!\nReply STOP to opt out' });
    expect(first.StatusCallback).toMatch(new RegExp(`^https://sms.example.com/webhooks/${gw.id}/`));
    expect(Object.fromEntries(new URLSearchParams(t.calls[1].body)).Body).toBe('Hi there!\nReply STOP to opt out');

    const campaign = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}`)).data;
    expect(campaign.status).toBe('completed');
    expect(campaign.counts.sent).toBe(2);

    // Delivery receipt through the public webhook.
    const hook = await fetch(`${t.base}${gw.webhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'MessageSid=SM1&MessageStatus=delivered',
    });
    expect(hook.status).toBe(200);
    const bad = await fetch(`${t.base}/webhooks/${gw.id}/wrong-token`, { method: 'POST' });
    expect(bad.status).toBe(404);

    const after = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}`)).data;
    expect(after.counts).toMatchObject({ delivered: 1, sent: 1 });
    const overview = (await t.call('GET', '/api/overview')).data;
    expect(overview.totals.delivered).toBe(1);
    expect(overview.deliveryRate).toBe(0.5);

    const csv = await fetch(`${t.base}/api/campaigns/${created.data.campaign.id}/export.csv`).then((r) => r.text());
    expect(csv.split('\n')[0]).toContain('to,country,status');
    expect(csv).toContain('"delivered"');
  });

  it('fails over to the next gateway when one rejects a message', async () => {
    let twilioCalls = 0;
    const t = await start({
      gateway: (url) => {
        if (url.includes('twilio')) {
          twilioCalls += 1;
          return { status: 400, body: { code: 21408, message: 'Permission to send to this region is not enabled' } };
        }
        return { status: 202, body: { message_uuid: ['plivo-1'] } };
      },
    });
    await addTwilio(t, { priority: 1 });
    await t.call('POST', '/api/providers', { name: 'Plivo', type: 'plivo', priority: 2, defaultSender: 'ACME', config: { authId: 'MA1', authToken: 'tok' } });

    const created = await t.call('POST', '/api/campaigns', { body: 'Hello', recipients: [{ phone: '+919876543210' }] });
    await t.dispatcher.runUntilIdle();
    const [message] = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}/messages`)).data.items;
    expect(message).toMatchObject({ status: 'sent', providerName: 'Plivo', providerMessageId: 'plivo-1', attempts: 2, error: null });
    expect(twilioCalls).toBe(1);
  });

  it('retries throttled messages on the same gateway', async () => {
    let n = 0;
    const t = await start({ gateway: () => (++n === 1 ? { status: 429, body: { message: 'Too many requests' } } : { status: 201, body: { sid: 'SM-ok' } }) });
    await addTwilio(t);
    const created = await t.call('POST', '/api/campaigns', { body: 'Hello', recipients: [{ phone: '+14155552671' }] });
    await t.dispatcher.runUntilIdle();
    const [message] = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}/messages`)).data.items;
    expect(message).toMatchObject({ status: 'sent', providerMessageId: 'SM-ok', attempts: 2 });
  });

  it('fails permanently after the last attempt', async () => {
    const t = await start({ gateway: () => ({ status: 400, body: { code: 21211, message: 'Invalid To number' } }) });
    await addTwilio(t);
    const created = await t.call('POST', '/api/campaigns', { body: 'Hello', recipients: [{ phone: '+14155552671' }] });
    await t.dispatcher.runUntilIdle();
    const campaign = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}`)).data;
    expect(campaign).toMatchObject({ status: 'completed', counts: { failed: 1 } });
    const [message] = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}/messages?status=failed`)).data.items;
    expect(message.error).toBe('Twilio: Invalid To number');
    expect(message.attempts).toBe(1);

    // Retry failed puts them back in the queue.
    const retried = await t.call('POST', `/api/campaigns/${created.data.campaign.id}/retry-failed`);
    expect(retried.data.status).toBe('sending');
  });

  it('skips opted-out numbers and countries with no gateway', async () => {
    const t = await start({ gateway: () => ({ status: 201, body: { sid: 'SM1' } }) });
    await addTwilio(t, { countries: ['US'] });
    await t.call('POST', '/api/suppressions', { numbers: ['+1 212 555 0123'] });
    const created = await t.call('POST', '/api/campaigns', {
      body: 'Hello',
      recipients: [{ phone: '+12125550123' }, { phone: '+14155552671' }, { phone: '+33612345678' }],
    });
    expect(created.data.suppressed).toBe(1);
    await t.dispatcher.runUntilIdle();
    const counts = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}`)).data.counts;
    expect(counts).toMatchObject({ suppressed: 1, sent: 1, failed: 1 });
    const [failed] = (await t.call('GET', `/api/campaigns/${created.data.campaign.id}/messages?status=failed`)).data.items;
    expect(failed.error).toBe('No enabled gateway covers FR');
  });

  it('pauses a campaign whose gateway gets disabled, and resumes it', async () => {
    const t = await start();
    const gw = await addTwilio(t);
    await t.call('POST', '/api/providers', { name: 'Sandbox', type: 'sandbox', config: {} });
    await t.call('PATCH', `/api/providers/${gw.id}`, { enabled: false });
    const created = await t.call('POST', '/api/campaigns', { body: 'Hi', providerId: gw.id, recipients: [{ phone: '+14155552671' }] });
    expect(created.status).toBe(400); // can't target a disabled gateway

    await t.call('PATCH', `/api/providers/${gw.id}`, { enabled: true });
    const ok = await t.call('POST', '/api/campaigns', { body: 'Hi', providerId: gw.id, scheduledAt: new Date(Date.now() + 60_000).toISOString(), recipients: [{ phone: '+14155552671' }] });
    expect(ok.data.campaign.status).toBe('scheduled');
    const id = ok.data.campaign.id;

    await t.call('PATCH', `/api/providers/${gw.id}`, { enabled: false });
    t.db.prepare('UPDATE campaigns SET scheduled_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
    t.dispatcher.tick();
    const paused = (await t.call('GET', `/api/campaigns/${id}`)).data;
    expect(paused.status).toBe('paused');
    expect(paused.lastError).toMatch(/disabled/);

    await t.call('PATCH', `/api/providers/${gw.id}`, { enabled: true });
    expect((await t.call('POST', `/api/campaigns/${id}/resume`)).data.status).toBe('sending');
    await t.dispatcher.runUntilIdle();
    expect((await t.call('GET', `/api/campaigns/${id}`)).data.status).toBe('completed');
  });

  it('cancels queued messages', async () => {
    const t = await start();
    await addTwilio(t);
    const created = await t.call('POST', '/api/campaigns', {
      body: 'Hi',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      recipients: [{ phone: '+14155552671' }, { phone: '+12125550123' }],
    });
    const cancelled = await t.call('POST', `/api/campaigns/${created.data.campaign.id}/cancel`);
    expect(cancelled.data).toMatchObject({ status: 'cancelled', counts: { cancelled: 2, queued: 0 } });
    expect((await t.call('POST', `/api/campaigns/${created.data.campaign.id}/cancel`)).status).toBe(409);
  });

  it('respects the per-gateway rate limit', async () => {
    const t = await start();
    await addTwilio(t, { rateLimit: 2 });
    await t.call('POST', '/api/campaigns', {
      body: 'Hi',
      recipients: ['+14155552671', '+12125550123', '+13105550199', '+16465550111', '+17185550122'].map((phone) => ({ phone })),
    });
    // The POST already ran one tick: a bucket of 2/s allows two messages immediately.
    t.dispatcher.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.calls.length).toBe(2);
    await t.dispatcher.runUntilIdle();
    expect(t.calls.length).toBe(5);
  });

  it('rejects campaigns when no gateway is enabled', async () => {
    const t = await start();
    const res = await t.call('POST', '/api/campaigns', { body: 'Hi', recipients: [{ phone: '+14155552671' }] });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/No SMS gateway/);
  });
});

describe('authentication', () => {
  it('protects the API when ADMIN_PASSWORD is set', async () => {
    const t = await start({ password: 'hunter2' });
    expect((await t.call('GET', '/api/session')).data).toEqual({ authRequired: true, authenticated: false });
    expect((await t.call('GET', '/api/providers')).status).toBe(401);
    expect((await t.call('POST', '/api/login', { password: 'wrong' })).status).toBe(401);
    expect((await t.call('POST', '/api/login', { password: 'hunter2' })).status).toBe(200);
    expect((await t.call('GET', '/api/providers')).status).toBe(200);
    await t.call('POST', '/api/logout');
  });
});
