import { digitsOnly, field, http, httpFailure, JSON_TYPE, requireConfig } from './http';
import { ProviderError, type ProviderDefinition, type ReportedStatus } from './types';

// Vonage SMS API status codes: https://developer.vonage.com/en/messaging/sms/guides/troubleshooting-sms
const RETRYABLE_STATUS = new Set(['1', '5', '10']); // throttled, internal error, too many binds

function mapStatus(status: string | undefined): ReportedStatus | null {
  switch (status) {
    case 'delivered':
      return 'delivered';
    case 'failed':
    case 'rejected':
    case 'expired':
      return 'failed';
    case 'accepted':
    case 'buffered':
      return 'sent';
    default:
      return null;
  }
}

export const vonage: ProviderDefinition = {
  type: 'vonage',
  label: 'Vonage (Nexmo)',
  description: 'Vonage SMS API using your API key and secret.',
  website: 'https://developer.vonage.com/en/messaging/sms/overview',
  coverage: '200+ countries',
  senderRequired: true,
  deliveryReports: 'auto',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'text', required: true, help: 'Shown at the top of the Vonage API Dashboard.' },
    { key: 'apiSecret', label: 'API secret', type: 'secret', required: true },
  ],

  async send(config, input, ctx) {
    requireConfig(config, 'Vonage', 'apiKey', 'apiSecret');
    if (!input.from) throw new ProviderError('Vonage: a sender ID (from) is required', { retryable: false, code: 'no_sender' });
    const res = await http(ctx, 'https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: JSON_TYPE,
      body: JSON.stringify({
        api_key: config.apiKey,
        api_secret: config.apiSecret,
        from: input.from,
        to: digitsOnly(input.to),
        text: input.text,
        type: input.unicode ? 'unicode' : 'text',
        ...(input.callbackUrl ? { callback: input.callbackUrl, 'status-report-req': 1 } : {}),
      }),
    });
    if (!res.ok) throw httpFailure('Vonage', res, res.data?.['error-text'] ?? res.data?.title);
    const parts: any[] = Array.isArray(res.data?.messages) ? res.data.messages : [];
    const failed = parts.find((m) => m.status !== '0');
    if (failed || parts.length === 0) {
      const status = String(failed?.status ?? 'unknown');
      throw new ProviderError(`Vonage: ${failed?.['error-text'] ?? 'no message parts accepted'} (status ${status})`, {
        retryable: RETRYABLE_STATUS.has(status),
        code: status,
      });
    }
    // Long messages are split into several parts; the first part's ID identifies the message.
    return { providerMessageId: String(parts[0]['message-id']) };
  },

  async test(config, ctx) {
    requireConfig(config, 'Vonage', 'apiKey', 'apiSecret');
    const qs = new URLSearchParams({ api_key: config.apiKey, api_secret: config.apiSecret });
    const res = await http(ctx, `https://rest.nexmo.com/account/get-balance?${qs}`);
    if (!res.ok || typeof res.data?.value !== 'number') throw httpFailure('Vonage', res, res.data?.['error-code-label'] ?? res.data?.title);
    return `Connected. Account balance: €${res.data.value.toFixed(2)}`;
  },

  parseWebhook({ body, query }) {
    const source = body && typeof body === 'object' && field(body, 'messageId') ? body : query;
    const id = field(source, 'messageId');
    const status = mapStatus(field(source, 'status'));
    if (!id || !status) return [];
    const code = field(source, 'err-code');
    return [{ providerMessageId: id, status, error: status === 'failed' ? `Vonage error ${code ?? 'unknown'}` : undefined }];
  },
};
