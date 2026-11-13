import { digitsOnly, http, httpFailure, JSON_TYPE, requireConfig } from './http';
import { ProviderError, type ProviderDefinition, type ReportedStatus, type StatusUpdate } from './types';

function host(config: Record<string, string>): string {
  const value = (config.baseUrl || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+\.infobip\.com$/i.test(value)) {
    throw new ProviderError('Infobip: base URL should look like xxxxx.api.infobip.com', { retryable: false, code: 'config' });
  }
  return `https://${value}`;
}

function mapGroup(group: string | undefined): ReportedStatus | null {
  switch (group) {
    case 'DELIVERED':
      return 'delivered';
    case 'UNDELIVERABLE':
    case 'EXPIRED':
    case 'REJECTED':
      return 'failed';
    default:
      return null;
  }
}

function serviceError(data: any): string | undefined {
  return data?.requestError?.serviceException?.text ?? data?.requestError?.policyException?.text;
}

export const infobip: ProviderDefinition = {
  type: 'infobip',
  label: 'Infobip',
  description: 'Infobip SMS API with your personal base URL and API key.',
  website: 'https://www.infobip.com/docs/api/channels/sms',
  coverage: '190+ countries',
  senderRequired: false,
  deliveryReports: 'auto',
  fields: [
    { key: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'xxxxx.api.infobip.com', help: 'Your personal API base URL from the Infobip portal homepage.' },
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
  ],
  validate(config) {
    try {
      if (config.baseUrl) host(config);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  },

  async send(config, input, ctx) {
    requireConfig(config, 'Infobip', 'baseUrl', 'apiKey');
    const res = await http(ctx, `${host(config)}/sms/2/text/advanced`, {
      method: 'POST',
      headers: { ...JSON_TYPE, Authorization: `App ${config.apiKey}` },
      body: JSON.stringify({
        messages: [
          {
            destinations: [{ to: digitsOnly(input.to) }],
            ...(input.from ? { from: input.from } : {}),
            text: input.text,
            ...(input.callbackUrl ? { notifyUrl: input.callbackUrl, notifyContentType: 'application/json' } : {}),
          },
        ],
      }),
    });
    const message = res.data?.messages?.[0];
    if (!res.ok || !message?.messageId) throw httpFailure('Infobip', res, serviceError(res.data));
    if (message.status?.groupName === 'REJECTED') {
      throw new ProviderError(`Infobip: ${message.status.description ?? message.status.name}`, { retryable: false, code: message.status.name });
    }
    return { providerMessageId: String(message.messageId) };
  },

  async test(config, ctx) {
    requireConfig(config, 'Infobip', 'baseUrl', 'apiKey');
    const res = await http(ctx, `${host(config)}/account/1/balance`, { headers: { Authorization: `App ${config.apiKey}` } });
    if (!res.ok) throw httpFailure('Infobip', res, serviceError(res.data));
    return `Connected. Balance: ${res.data?.balance ?? '?'} ${res.data?.currency ?? ''}`.trim();
  },

  parseWebhook({ body }) {
    const results: any[] = Array.isArray((body as any)?.results) ? (body as any).results : [];
    const updates: StatusUpdate[] = [];
    for (const result of results) {
      const status = mapGroup(result?.status?.groupName);
      if (!result?.messageId || !status) continue;
      updates.push({
        providerMessageId: String(result.messageId),
        status,
        error: status === 'failed' ? (result.error?.description ?? result.status?.description) : undefined,
      });
    }
    return updates;
  },
};
