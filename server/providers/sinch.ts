import { field, http, httpFailure, JSON_TYPE, requireConfig } from './http';
import { type ProviderDefinition, type ReportedStatus } from './types';

const REGIONS = ['us', 'eu', 'au', 'br', 'ca'];

function baseUrl(config: Record<string, string>): string {
  const region = REGIONS.includes(config.region) ? config.region : 'us';
  return `https://${region}.sms.api.sinch.com/xms/v1/${encodeURIComponent(config.servicePlanId)}`;
}

function mapStatus(status: string | undefined): ReportedStatus | null {
  switch (status) {
    case 'Delivered':
      return 'delivered';
    case 'Failed':
    case 'Rejected':
    case 'Expired':
    case 'Aborted':
      return 'failed';
    case 'Dispatched':
      return 'sent';
    default:
      return null;
  }
}

export const sinch: ProviderDefinition = {
  type: 'sinch',
  label: 'Sinch',
  description: 'Sinch SMS REST API (XMS) using a service plan ID and API token.',
  website: 'https://developers.sinch.com/docs/sms/',
  coverage: 'Global, with regional API hosts',
  senderRequired: false,
  deliveryReports: 'auto',
  fields: [
    { key: 'servicePlanId', label: 'Service plan ID', type: 'text', required: true, help: 'Sinch Customer Dashboard → SMS → APIs.' },
    { key: 'apiToken', label: 'API token', type: 'secret', required: true },
    {
      key: 'region',
      label: 'API region',
      type: 'select',
      default: 'us',
      options: [
        { value: 'us', label: 'United States (us)' },
        { value: 'eu', label: 'Europe (eu)' },
        { value: 'au', label: 'Australia (au)' },
        { value: 'br', label: 'Brazil (br)' },
        { value: 'ca', label: 'Canada (ca)' },
      ],
      help: 'Must match the region your service plan was created in.',
    },
  ],

  async send(config, input, ctx) {
    requireConfig(config, 'Sinch', 'servicePlanId', 'apiToken');
    const res = await http(ctx, `${baseUrl(config)}/batches`, {
      method: 'POST',
      headers: { ...JSON_TYPE, Authorization: `Bearer ${config.apiToken}` },
      body: JSON.stringify({
        to: [input.to],
        ...(input.from ? { from: input.from } : {}),
        body: input.text,
        ...(input.callbackUrl ? { delivery_report: 'per_recipient', callback_url: input.callbackUrl } : {}),
      }),
    });
    if (!res.ok || !res.data?.id) throw httpFailure('Sinch', res, res.data?.text, res.data?.code);
    // One recipient per batch, so the batch ID identifies this message.
    return { providerMessageId: String(res.data.id) };
  },

  async test(config, ctx) {
    requireConfig(config, 'Sinch', 'servicePlanId', 'apiToken');
    const res = await http(ctx, `${baseUrl(config)}/batches?page=0&page_size=1`, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    if (!res.ok) throw httpFailure('Sinch', res, res.data?.text, res.data?.code);
    return `Connected to service plan ${config.servicePlanId} (${(config.region || 'us').toUpperCase()} region)`;
  },

  parseWebhook({ body }) {
    const id = field(body, 'batch_id');
    const status = mapStatus(field(body, 'status'));
    if (!id || !status) return [];
    const code = field(body, 'code');
    return [{ providerMessageId: id, status, error: status === 'failed' ? `Sinch status ${field(body, 'status')} (code ${code ?? '?'})` : undefined }];
  },
};
