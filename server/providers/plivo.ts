import { basicAuth, digitsOnly, field, http, httpFailure, JSON_TYPE, requireConfig } from './http';
import { ProviderError, type ProviderDefinition, type ReportedStatus } from './types';

const API = 'https://api.plivo.com/v1/Account';

function mapStatus(status: string | undefined): ReportedStatus | null {
  switch (status) {
    case 'delivered':
      return 'delivered';
    case 'failed':
    case 'undelivered':
    case 'rejected':
      return 'failed';
    case 'sent':
      return 'sent';
    default:
      return null;
  }
}

export const plivo: ProviderDefinition = {
  type: 'plivo',
  label: 'Plivo',
  description: 'Plivo Messaging API. Send from a number, alphanumeric sender ID, or a Powerpack number pool.',
  website: 'https://www.plivo.com/docs/messaging/',
  coverage: '190+ countries',
  senderRequired: false,
  deliveryReports: 'auto',
  fields: [
    { key: 'authId', label: 'Auth ID', type: 'text', required: true, placeholder: 'MA…', help: 'From the Plivo console overview page.' },
    { key: 'authToken', label: 'Auth token', type: 'secret', required: true },
    { key: 'powerpackUuid', label: 'Powerpack UUID', type: 'text', help: 'Optional. Lets Plivo choose a sender from a number pool instead of a fixed sender ID.' },
  ],

  async send(config, input, ctx) {
    requireConfig(config, 'Plivo', 'authId', 'authToken');
    if (!input.from && !config.powerpackUuid) {
      throw new ProviderError('Plivo: a sender ID (src) or a Powerpack UUID is required', { retryable: false, code: 'no_sender' });
    }
    const res = await http(ctx, `${API}/${encodeURIComponent(config.authId)}/Message/`, {
      method: 'POST',
      headers: { ...JSON_TYPE, Authorization: basicAuth(config.authId, config.authToken) },
      body: JSON.stringify({
        ...(input.from ? { src: input.from } : { powerpack_uuid: config.powerpackUuid }),
        dst: digitsOnly(input.to),
        text: input.text,
        ...(input.callbackUrl ? { url: input.callbackUrl, method: 'POST' } : {}),
      }),
    });
    const uuid = Array.isArray(res.data?.message_uuid) ? res.data.message_uuid[0] : undefined;
    if (!res.ok || !uuid) throw httpFailure('Plivo', res, res.data?.error);
    return { providerMessageId: String(uuid) };
  },

  async test(config, ctx) {
    requireConfig(config, 'Plivo', 'authId', 'authToken');
    const res = await http(ctx, `${API}/${encodeURIComponent(config.authId)}/`, {
      headers: { Authorization: basicAuth(config.authId, config.authToken) },
    });
    if (!res.ok) throw httpFailure('Plivo', res, res.data?.error);
    const credits = res.data?.cash_credits ? ` Credits: ${res.data.cash_credits}` : '';
    return `Connected to ${res.data?.account_type ?? 'Plivo'} account ${res.data?.name ? `“${res.data.name}”` : config.authId}.${credits}`;
  },

  parseWebhook({ body }) {
    const id = field(body, 'MessageUUID');
    const status = mapStatus(field(body, 'Status'));
    if (!id || !status) return [];
    const code = field(body, 'ErrorCode');
    return [{ providerMessageId: id, status, error: status === 'failed' ? `Plivo error ${code ?? 'unknown'}` : undefined }];
  },
};
