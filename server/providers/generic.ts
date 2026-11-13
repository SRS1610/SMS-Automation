import { randomBytes } from 'node:crypto';
import { digitsOnly, http, httpFailure, truncate } from './http';
import { ProviderError, type ProviderConfig, type ProviderDefinition, type SendInput, type StatusUpdate } from './types';

/**
 * A configurable HTTP gateway for any provider with a REST or URL-based API
 * (regional aggregators, self-hosted gateways such as Kannel or an Android
 * SMS gateway, internal services, ...).
 *
 * Placeholders, escaped for where they appear:
 *   {{to}} {{to_digits}} {{from}} {{text}} {{callback_url}} {{unicode}}
 */

type Context = 'url' | 'json' | 'form' | 'raw';

function placeholderValues(input: SendInput): Record<string, string> {
  return {
    to: input.to,
    to_digits: digitsOnly(input.to),
    from: input.from ?? '',
    text: input.text,
    callback_url: input.callbackUrl ?? '',
    unicode: input.unicode ? 'true' : 'false',
  };
}

function escapeFor(context: Context, value: string): string {
  switch (context) {
    case 'url':
    case 'form':
      return encodeURIComponent(value);
    case 'json':
      return JSON.stringify(value).slice(1, -1);
    case 'raw':
      return value.replace(/[\r\n]/g, ' ');
  }
}

export function fillTemplate(template: string, values: Record<string, string>, context: Context): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, name: string) => {
    const value = values[name.toLowerCase()];
    return value === undefined ? match : escapeFor(context, value);
  });
}

export function parseHeaderLines(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (/^[A-Za-z0-9-]+$/.test(name)) headers[name] = value;
  }
  return headers;
}

/** Reads "data.messages.0.id"-style paths. */
export function readPath(source: unknown, path: string): unknown {
  let current: any = source;
  for (const part of path.split('.').filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    current = current[Array.isArray(current) ? Number(part) : part];
  }
  return current;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function buildRequest(config: ProviderConfig, input: SendInput) {
  const values = placeholderValues(input);
  const method = config.method === 'GET' ? 'GET' : 'POST';
  const url = fillTemplate(config.url, values, 'url');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseHeaderLines(config.headers))) {
    headers[name] = fillTemplate(value, values, 'raw');
  }
  let body: string | undefined;
  if (method === 'POST' && config.bodyTemplate) {
    const json = config.contentType !== 'form';
    body = fillTemplate(config.bodyTemplate, values, json ? 'json' : 'form');
    headers['Content-Type'] ??= json ? 'application/json' : 'application/x-www-form-urlencoded';
  }
  return { url, method, headers, body };
}

export const generic: ProviderDefinition = {
  type: 'generic',
  label: 'Custom HTTP gateway',
  description: 'Connect any provider with an HTTP API by describing the request. Use it for regional aggregators or self-hosted gateways.',
  website: '',
  coverage: 'Whatever your gateway supports',
  senderRequired: false,
  deliveryReports: 'manual',
  webhookHelp: 'Point your gateway’s delivery-report callback at this URL and fill in the delivery report fields below.',
  fields: [
    { key: 'url', label: 'Request URL', type: 'url', required: true, placeholder: 'https://api.example.com/sms/send', help: 'Placeholders such as {{to}} are URL-encoded when used here.' },
    {
      key: 'method',
      label: 'Method',
      type: 'select',
      default: 'POST',
      options: [
        { value: 'POST', label: 'POST' },
        { value: 'GET', label: 'GET' },
      ],
    },
    {
      key: 'contentType',
      label: 'Body format',
      type: 'select',
      default: 'json',
      options: [
        { value: 'json', label: 'JSON' },
        { value: 'form', label: 'Form (x-www-form-urlencoded)' },
      ],
    },
    {
      key: 'bodyTemplate',
      label: 'Body template',
      type: 'textarea',
      default: '{\n  "to": "{{to}}",\n  "from": "{{from}}",\n  "text": "{{text}}"\n}',
      help: 'Available: {{to}} {{to_digits}} {{from}} {{text}} {{callback_url}} {{unicode}}. Values are escaped for the chosen format; in JSON keep placeholders inside quotes.',
    },
    {
      key: 'headers',
      label: 'Headers',
      type: 'textarea',
      secret: true,
      placeholder: 'Authorization: Bearer <token>',
      help: 'One "Name: value" per line. Stored encrypted because it usually contains credentials.',
    },
    { key: 'messageIdPath', label: 'Message ID path in response', type: 'text', placeholder: 'data.id', help: 'Dot path to the gateway’s message ID in the JSON response. Leave empty if the API returns none.' },
    { key: 'successContains', label: 'Success marker', type: 'text', help: 'Optional. If set, a response is only treated as accepted when its body contains this text.' },
    { key: 'dlrIdField', label: 'Delivery report: message ID field', type: 'text', placeholder: 'id', help: 'Field holding the message ID in delivery-report callbacks (dot paths allowed).' },
    { key: 'dlrStatusField', label: 'Delivery report: status field', type: 'text', placeholder: 'status' },
    { key: 'dlrDeliveredValues', label: 'Delivered status values', type: 'text', default: 'delivered,delivrd', help: 'Comma separated, case-insensitive.' },
    { key: 'dlrFailedValues', label: 'Failed status values', type: 'text', default: 'failed,undelivered,undeliv,rejected,rejectd,expired' },
  ],
  validate(config) {
    try {
      const url = new URL(fillTemplate(config.url ?? '', placeholderValues({ to: '+10000000000', text: 'x', unicode: false }), 'url'));
      if (!['http:', 'https:'].includes(url.protocol)) return 'Request URL must start with http:// or https://';
    } catch {
      return 'Request URL is not a valid URL';
    }
    return null;
  },

  async send(config, input, ctx) {
    if (!config.url) throw new ProviderError('Custom gateway: request URL is not configured', { retryable: false, code: 'config' });
    const request = buildRequest(config, input);
    const res = await http(ctx, request.url, request);
    if (!res.ok) throw httpFailure('Gateway', res);
    if (config.successContains && !res.text.includes(config.successContains)) {
      throw new ProviderError(`Gateway: unexpected response: ${truncate(res.text, 200)}`, { retryable: false, code: 'unexpected_response' });
    }
    let id: unknown;
    if (config.messageIdPath) {
      id = readPath(res.data, config.messageIdPath);
      if (id === undefined || id === null || id === '') {
        throw new ProviderError(`Gateway: no message ID at "${config.messageIdPath}" in response: ${truncate(res.text, 200)}`, {
          retryable: false,
          code: 'no_message_id',
        });
      }
    }
    return { providerMessageId: id !== undefined ? String(id) : `local_${randomBytes(8).toString('hex')}` };
  },

  async test(config) {
    const problem = generic.validate?.(config);
    if (problem) throw new ProviderError(problem, { retryable: false, code: 'config' });
    const host = new URL(fillTemplate(config.url, placeholderValues({ to: '+10000000000', text: 'x', unicode: false }), 'url')).host;
    return `Configuration looks valid for ${host}. Custom gateways can’t be checked without sending, so use “Send test SMS” to confirm.`;
  },

  parseWebhook({ body, query }, config) {
    return parseGenericWebhook(config, body, query);
  },
};

/** Delivery-report parsing for the custom gateway, driven by its config. */
export function parseGenericWebhook(config: ProviderConfig, body: unknown, query: Record<string, unknown>): StatusUpdate[] {
  const idField = config.dlrIdField || 'id';
  const statusField = config.dlrStatusField || 'status';
  const delivered = splitList(config.dlrDeliveredValues || 'delivered,delivrd');
  const failed = splitList(config.dlrFailedValues || 'failed,undelivered,undeliv,rejected,rejectd,expired');

  const items: unknown[] = Array.isArray(body) ? body : [body, query];
  const updates: StatusUpdate[] = [];
  for (const item of items) {
    const id = readPath(item, idField);
    const rawStatus = readPath(item, statusField);
    if (id === undefined || id === null || rawStatus === undefined || rawStatus === null) continue;
    const status = String(rawStatus).toLowerCase();
    if (delivered.includes(status)) updates.push({ providerMessageId: String(id), status: 'delivered' });
    else if (failed.includes(status)) updates.push({ providerMessageId: String(id), status: 'failed', error: `Gateway status ${rawStatus}` });
    if (!Array.isArray(body) && updates.length) break;
  }
  return updates;
}
