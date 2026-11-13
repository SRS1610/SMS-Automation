import { http, httpFailure, JSON_TYPE, requireConfig } from './http';
import { ProviderError, type ProviderDefinition, type ReportedStatus, type StatusUpdate } from './types';

const API = 'https://api.telnyx.com/v2';

function mapStatus(status: string | undefined): ReportedStatus | null {
  switch (status) {
    case 'delivered':
      return 'delivered';
    case 'sending_failed':
    case 'delivery_failed':
    case 'expired':
      return 'failed';
    case 'sent':
    case 'delivery_unconfirmed':
      return 'sent';
    default:
      return null;
  }
}

function errorDetail(data: any): string | undefined {
  const first = Array.isArray(data?.errors) ? data.errors[0] : undefined;
  return first ? first.detail || first.title : undefined;
}

export const telnyx: ProviderDefinition = {
  type: 'telnyx',
  label: 'Telnyx',
  description: 'Telnyx Messaging API v2. Send from a number, short code, or alphanumeric ID via a messaging profile.',
  website: 'https://developers.telnyx.com/docs/messaging',
  coverage: 'Global',
  senderRequired: true,
  deliveryReports: 'auto',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Mission Control Portal → API Keys (starts with KEY…).' },
    {
      key: 'messagingProfileId',
      label: 'Messaging profile ID',
      type: 'text',
      help: 'Required when sending with an alphanumeric sender ID.',
    },
  ],

  async send(config, input, ctx) {
    requireConfig(config, 'Telnyx', 'apiKey');
    if (!input.from) throw new ProviderError('Telnyx: a sender (from) is required', { retryable: false, code: 'no_sender' });
    const res = await http(ctx, `${API}/messages`, {
      method: 'POST',
      headers: { ...JSON_TYPE, Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        text: input.text,
        ...(config.messagingProfileId ? { messaging_profile_id: config.messagingProfileId } : {}),
        ...(input.callbackUrl ? { webhook_url: input.callbackUrl, use_profile_webhooks: false } : {}),
      }),
    });
    if (!res.ok || !res.data?.data?.id) throw httpFailure('Telnyx', res, errorDetail(res.data), res.data?.errors?.[0]?.code);
    return { providerMessageId: String(res.data.data.id) };
  },

  async test(config, ctx) {
    requireConfig(config, 'Telnyx', 'apiKey');
    const res = await http(ctx, `${API}/balance`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    if (!res.ok) throw httpFailure('Telnyx', res, errorDetail(res.data));
    const balance = res.data?.data;
    return balance ? `Connected. Balance: ${balance.balance} ${balance.currency}` : 'Connected to Telnyx';
  },

  parseWebhook({ body }) {
    const payload = (body as any)?.data?.payload;
    if (!payload?.id) return [];
    const recipient = Array.isArray(payload.to) ? payload.to[0] : undefined;
    const status = mapStatus(recipient?.status);
    if (!status) return [];
    const update: StatusUpdate = { providerMessageId: String(payload.id), status };
    if (status === 'failed') update.error = errorDetail(payload) ?? `Telnyx status ${recipient?.status}`;
    return [update];
  },
};
