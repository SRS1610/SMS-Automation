import { describe, expect, it } from 'vitest';
import { SecretBox } from '../server/crypto';
import { africastalking } from '../server/providers/africastalking';
import { clicksend } from '../server/providers/clicksend';
import { fillTemplate, generic } from '../server/providers/generic';
import { infobip } from '../server/providers/infobip';
import { plivo } from '../server/providers/plivo';
import { sinch } from '../server/providers/sinch';
import { telnyx } from '../server/providers/telnyx';
import { twilio } from '../server/providers/twilio';
import { ProviderError, type ProviderContext, type ProviderDefinition, type SendInput } from '../server/providers/types';
import { vonage } from '../server/providers/vonage';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function mockFetch(status: number, body: unknown) {
  const calls: Captured[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body as string | undefined,
    });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  const ctx: ProviderContext = { fetch };
  return { ctx, calls };
}

const input: SendInput = { to: '+447400123456', from: 'ACME', text: 'Hello & welcome', unicode: false, callbackUrl: 'https://sms.example.com/webhooks/gw/tok' };

async function rejection(def: ProviderDefinition, config: Record<string, string>, status: number, body: unknown) {
  const { ctx } = mockFetch(status, body);
  try {
    await def.send(config, input, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected send to fail');
}

const TWILIO = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'secret' };

describe('Twilio', () => {
  it('posts a form-encoded message with basic auth and status callback', async () => {
    const { ctx, calls } = mockFetch(201, { sid: 'SM1', status: 'queued' });
    await expect(twilio.send(TWILIO, input, ctx)).resolves.toEqual({ providerMessageId: 'SM1' });
    const [call] = calls;
    expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.accountSid}/Messages.json`);
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${TWILIO.accountSid}:secret`).toString('base64')}`);
    const form = new URLSearchParams(call.body);
    expect(Object.fromEntries(form)).toEqual({ To: '+447400123456', From: 'ACME', Body: 'Hello & welcome', StatusCallback: input.callbackUrl });
  });

  it('marks throttling as retryable and invalid numbers as permanent', async () => {
    expect((await rejection(twilio, TWILIO, 429, { code: 20429, message: 'Too Many Requests' })).retryable).toBe(true);
    const permanent = await rejection(twilio, TWILIO, 400, { code: 21211, message: "The 'To' number is not valid." });
    expect(permanent.retryable).toBe(false);
    expect(permanent.message).toContain('not valid');
  });

  it('requires a sender or messaging service', async () => {
    const { ctx } = mockFetch(201, { sid: 'SM1' });
    await expect(twilio.send(TWILIO, { ...input, from: undefined }, ctx)).rejects.toThrow(/Messaging Service/);
    await expect(twilio.send({ ...TWILIO, messagingServiceSid: `MG${'b'.repeat(32)}` }, { ...input, from: undefined }, ctx)).resolves.toBeTruthy();
  });

  it('parses status callbacks', () => {
    expect(twilio.parseWebhook!({ method: 'POST', body: { MessageSid: 'SM1', MessageStatus: 'delivered' }, query: {} }, TWILIO)).toEqual([
      { providerMessageId: 'SM1', status: 'delivered', error: undefined },
    ]);
    expect(twilio.parseWebhook!({ method: 'POST', body: { MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' }, query: {} }, TWILIO)[0]).toMatchObject({
      status: 'failed',
      error: 'Twilio error 30003',
    });
    expect(twilio.parseWebhook!({ method: 'POST', body: { MessageSid: 'SM1', MessageStatus: 'queued' }, query: {} }, TWILIO)).toEqual([]);
  });

  it('validates SIDs', () => {
    expect(twilio.validate!({ accountSid: 'nope', authToken: 'x' })).toMatch(/Account SID/);
    expect(twilio.validate!(TWILIO)).toBeNull();
  });
});

describe('Vonage', () => {
  const config = { apiKey: 'key', apiSecret: 'secret' };

  it('sends JSON without the + and flags unicode', async () => {
    const { ctx, calls } = mockFetch(200, { 'message-count': '1', messages: [{ status: '0', 'message-id': 'V1' }] });
    await expect(vonage.send(config, { ...input, unicode: true }, ctx)).resolves.toEqual({ providerMessageId: 'V1' });
    expect(calls[0].url).toBe('https://rest.nexmo.com/sms/json');
    expect(JSON.parse(calls[0].body!)).toMatchObject({ api_key: 'key', to: '447400123456', from: 'ACME', type: 'unicode', callback: input.callbackUrl });
  });

  it('reads per-message status codes', async () => {
    const throttled = await rejection(vonage, config, 200, { messages: [{ status: '1', 'error-text': 'Throttled' }] });
    expect(throttled.retryable).toBe(true);
    const barred = await rejection(vonage, config, 200, { messages: [{ status: '7', 'error-text': 'Number barred' }] });
    expect(barred.retryable).toBe(false);
  });

  it('parses delivery receipts from query or body', () => {
    expect(vonage.parseWebhook!({ method: 'GET', body: {}, query: { messageId: 'V1', status: 'delivered' } }, config)[0].status).toBe('delivered');
    expect(vonage.parseWebhook!({ method: 'POST', body: { messageId: 'V1', status: 'rejected', 'err-code': '6' }, query: {} }, config)[0]).toMatchObject({
      status: 'failed',
    });
  });
});

describe('Plivo', () => {
  it('sends with src/dst and returns the first message UUID', async () => {
    const { ctx, calls } = mockFetch(202, { message_uuid: ['P1'], api_id: 'x' });
    await expect(plivo.send({ authId: 'MA1', authToken: 't' }, input, ctx)).resolves.toEqual({ providerMessageId: 'P1' });
    expect(calls[0].url).toBe('https://api.plivo.com/v1/Account/MA1/Message/');
    expect(JSON.parse(calls[0].body!)).toEqual({ src: 'ACME', dst: '447400123456', text: 'Hello & welcome', url: input.callbackUrl, method: 'POST' });
  });

  it('uses a Powerpack when no sender is given', async () => {
    const { ctx, calls } = mockFetch(202, { message_uuid: ['P1'] });
    await plivo.send({ authId: 'MA1', authToken: 't', powerpackUuid: 'pp' }, { ...input, from: undefined }, ctx);
    expect(JSON.parse(calls[0].body!).powerpack_uuid).toBe('pp');
  });

  it('surfaces API errors', async () => {
    const err = await rejection(plivo, { authId: 'MA1', authToken: 't' }, 400, { error: 'invalid dst' });
    expect(err.message).toBe('Plivo: invalid dst');
    expect(err.retryable).toBe(false);
  });
});

describe('Sinch', () => {
  it('creates a batch on the regional host', async () => {
    const { ctx, calls } = mockFetch(201, { id: 'B1' });
    await sinch.send({ servicePlanId: 'plan', apiToken: 'tok', region: 'eu' }, input, ctx);
    expect(calls[0].url).toBe('https://eu.sms.api.sinch.com/xms/v1/plan/batches');
    expect(calls[0].headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].body!)).toMatchObject({ to: ['+447400123456'], from: 'ACME', delivery_report: 'per_recipient' });
  });

  it('parses recipient delivery reports', () => {
    const updates = sinch.parseWebhook!({ method: 'POST', body: { type: 'recipient_delivery_report_sms', batch_id: 'B1', status: 'Delivered', code: 0 }, query: {} }, {});
    expect(updates).toEqual([{ providerMessageId: 'B1', status: 'delivered', error: undefined }]);
  });
});

describe('Telnyx', () => {
  it('sends with bearer auth and webhook override', async () => {
    const { ctx, calls } = mockFetch(200, { data: { id: 'T1' } });
    await expect(telnyx.send({ apiKey: 'KEY1', messagingProfileId: 'mp' }, input, ctx)).resolves.toEqual({ providerMessageId: 'T1' });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ to: '+447400123456', messaging_profile_id: 'mp', webhook_url: input.callbackUrl });
  });

  it('reads error details', async () => {
    const err = await rejection(telnyx, { apiKey: 'k' }, 422, { errors: [{ code: '40310', detail: 'Invalid destination' }] });
    expect(err.message).toContain('Invalid destination');
  });

  it('parses finalized events', () => {
    const body = { data: { event_type: 'message.finalized', payload: { id: 'T1', to: [{ status: 'delivery_failed' }], errors: [{ detail: 'Carrier rejected' }] } } };
    expect(telnyx.parseWebhook!({ method: 'POST', body, query: {} }, {})).toEqual([{ providerMessageId: 'T1', status: 'failed', error: 'Carrier rejected' }]);
  });
});

describe('Infobip', () => {
  const config = { baseUrl: 'https://abc12.api.infobip.com/', apiKey: 'k' };

  it('sends to the personal base URL', async () => {
    const { ctx, calls } = mockFetch(200, { bulkId: 'b', messages: [{ messageId: 'I1', status: { groupName: 'PENDING' } }] });
    await expect(infobip.send(config, input, ctx)).resolves.toEqual({ providerMessageId: 'I1' });
    expect(calls[0].url).toBe('https://abc12.api.infobip.com/sms/2/text/advanced');
    expect(calls[0].headers.authorization).toBe('App k');
    expect(JSON.parse(calls[0].body!).messages[0].destinations).toEqual([{ to: '447400123456' }]);
  });

  it('treats REJECTED as a permanent failure', async () => {
    const err = await rejection(infobip, config, 200, { messages: [{ messageId: 'I1', status: { groupName: 'REJECTED', name: 'REJECTED_NOT_ENOUGH_CREDITS', description: 'Not enough credits' } }] });
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Not enough credits');
  });

  it('rejects base URLs outside infobip.com', () => {
    expect(infobip.validate!({ baseUrl: 'evil.example.com', apiKey: 'k' })).toMatch(/infobip/);
  });

  it('parses delivery reports', () => {
    const body = { results: [{ messageId: 'I1', status: { groupName: 'DELIVERED' } }, { messageId: 'I2', status: { groupName: 'UNDELIVERABLE', description: 'Absent' } }] };
    expect(infobip.parseWebhook!({ method: 'POST', body, query: {} }, config)).toEqual([
      { providerMessageId: 'I1', status: 'delivered', error: undefined },
      { providerMessageId: 'I2', status: 'failed', error: 'Absent' },
    ]);
  });
});

describe('ClickSend', () => {
  it('reads the per-message status', async () => {
    const { ctx } = mockFetch(200, { response_code: 'SUCCESS', data: { messages: [{ message_id: 'C1', status: 'SUCCESS' }] } });
    await expect(clicksend.send({ username: 'u', apiKey: 'k' }, input, ctx)).resolves.toEqual({ providerMessageId: 'C1' });
    const err = await rejection(clicksend, { username: 'u', apiKey: 'k' }, 200, { data: { messages: [{ status: 'INVALID_RECIPIENT' }] } });
    expect(err.message).toContain('INVALID_RECIPIENT');
  });
});

describe("Africa's Talking", () => {
  it('posts a form with the apiKey header and checks recipient status codes', async () => {
    const { ctx, calls } = mockFetch(201, { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: 101, status: 'Success', messageId: 'ATX1' }] } });
    await expect(africastalking.send({ username: 'app', apiKey: 'k', environment: 'sandbox' }, input, ctx)).resolves.toEqual({ providerMessageId: 'ATX1' });
    expect(calls[0].url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(calls[0].headers.apikey).toBe('k');
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ username: 'app', to: '+447400123456', message: 'Hello & welcome', from: 'ACME' });

    const err = await rejection(africastalking, { username: 'app', apiKey: 'k' }, 201, {
      SMSMessageData: { Recipients: [{ statusCode: 405, status: 'InsufficientBalance' }] },
    });
    expect(err.retryable).toBe(false);
  });
});

describe('Custom HTTP gateway', () => {
  it('escapes placeholders for JSON bodies and URLs', async () => {
    const { ctx, calls } = mockFetch(200, { data: { id: 42 } });
    const config = {
      url: 'https://gw.example.com/send?to={{to}}',
      method: 'POST',
      contentType: 'json',
      bodyTemplate: '{"to":"{{to_digits}}","text":"{{text}}"}',
      headers: 'Authorization: Bearer abc\nX-Sender: {{from}}',
      messageIdPath: 'data.id',
    };
    const result = await generic.send(config, { ...input, text: 'Line "one"\nLine two' }, ctx);
    expect(result).toEqual({ providerMessageId: '42' });
    expect(calls[0].url).toBe('https://gw.example.com/send?to=%2B447400123456');
    expect(JSON.parse(calls[0].body!)).toEqual({ to: '447400123456', text: 'Line "one"\nLine two' });
    expect(calls[0].headers.authorization).toBe('Bearer abc');
    expect(calls[0].headers['x-sender']).toBe('ACME');
  });

  it('supports form bodies and a success marker', async () => {
    expect(fillTemplate('to={{to}}&msg={{text}}', { to: '+1', text: 'a&b' }, 'form')).toBe('to=%2B1&msg=a%26b');
    const { ctx } = mockFetch(200, 'ERR: no credit');
    await expect(generic.send({ url: 'https://gw.example.com', successContains: 'OK' }, input, ctx)).rejects.toThrow(/unexpected response/);
  });

  it('parses delivery reports using the configured fields', () => {
    const config = { url: 'https://gw.example.com', dlrIdField: 'msg.id', dlrStatusField: 'state', dlrDeliveredValues: 'DELIVRD' };
    expect(generic.parseWebhook!({ method: 'POST', body: { msg: { id: 'g1' }, state: 'DELIVRD' }, query: {} }, config)).toEqual([
      { providerMessageId: 'g1', status: 'delivered' },
    ]);
    expect(generic.parseWebhook!({ method: 'GET', body: {}, query: { id: 'g2', status: 'UNDELIV' } }, { url: 'x' })[0].status).toBe('failed');
  });
});

describe('network failures', () => {
  it('turns timeouts and connection errors into retryable errors', async () => {
    const ctx: ProviderContext = {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    };
    const err = await twilio.send(TWILIO, input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });
});

describe('SecretBox', () => {
  it('round-trips and authenticates ciphertext', () => {
    const box = new SecretBox('test-secret');
    const sealed = box.seal('{"authToken":"abc"}');
    expect(sealed).not.toContain('abc');
    expect(box.open(sealed)).toBe('{"authToken":"abc"}');
    expect(() => new SecretBox('other-secret').open(sealed)).toThrow();
    expect(box.verify('x', box.sign('x'))).toBe(true);
    expect(box.verify('y', box.sign('x'))).toBe(false);
  });
});
