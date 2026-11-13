import { field, FORM, formBody, http, httpFailure, requireConfig } from './http';
import { ProviderError, type ProviderDefinition, type ReportedStatus } from './types';

function apiHost(config: Record<string, string>): string {
  return config.environment === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
}

// Recipient status codes: 100 Processed, 101 Sent, 102 Queued are successes.
const SUCCESS_CODES = new Set([100, 101, 102]);
const RETRYABLE_CODES = new Set([500, 501]);

function mapStatus(status: string | undefined): ReportedStatus | null {
  switch (status) {
    case 'Success':
      return 'delivered';
    case 'Failed':
    case 'Rejected':
    case 'AbsentSubscriber':
    case 'Expired':
      return 'failed';
    case 'Sent':
    case 'Submitted':
    case 'Buffered':
      return 'sent';
    default:
      return null;
  }
}

export const africastalking: ProviderDefinition = {
  type: 'africastalking',
  label: "Africa's Talking",
  description: 'Bulk SMS across African mobile networks.',
  website: 'https://developers.africastalking.com/docs/sms/overview',
  coverage: 'Kenya, Nigeria, Uganda, Tanzania, Rwanda, Malawi, Zambia and more',
  senderRequired: false,
  deliveryReports: 'manual',
  webhookHelp: "Paste this URL into your Africa's Talking dashboard under SMS → SMS Callback URLs → Delivery Reports.",
  fields: [
    { key: 'username', label: 'Username', type: 'text', required: true, help: 'Your application username ("sandbox" for the sandbox).' },
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      default: 'live',
      options: [
        { value: 'live', label: 'Live' },
        { value: 'sandbox', label: 'Sandbox' },
      ],
    },
  ],

  async send(config, input, ctx) {
    requireConfig(config, "Africa's Talking", 'username', 'apiKey');
    const res = await http(ctx, `${apiHost(config)}/version1/messaging`, {
      method: 'POST',
      headers: { ...FORM, apiKey: config.apiKey },
      body: formBody({ username: config.username, to: input.to, message: input.text, from: input.from }),
    });
    if (!res.ok) throw httpFailure("Africa's Talking", res, res.data?.SMSMessageData?.Message ?? res.text);
    const recipient = res.data?.SMSMessageData?.Recipients?.[0];
    if (!recipient) {
      throw new ProviderError(`Africa's Talking: ${res.data?.SMSMessageData?.Message ?? 'message not accepted'}`, { retryable: false });
    }
    const code = Number(recipient.statusCode);
    if (!SUCCESS_CODES.has(code) || !recipient.messageId) {
      throw new ProviderError(`Africa's Talking: ${recipient.status ?? 'rejected'} (${code})`, {
        retryable: RETRYABLE_CODES.has(code),
        code: String(code),
      });
    }
    return { providerMessageId: String(recipient.messageId) };
  },

  async test(config, ctx) {
    requireConfig(config, "Africa's Talking", 'username', 'apiKey');
    const res = await http(ctx, `${apiHost(config)}/version1/user?username=${encodeURIComponent(config.username)}`, {
      headers: { apiKey: config.apiKey },
    });
    if (!res.ok || !res.data?.UserData) throw httpFailure("Africa's Talking", res);
    return `Connected as ${config.username}. Balance: ${res.data.UserData.balance}`;
  },

  parseWebhook({ body }) {
    const id = field(body, 'id');
    const status = mapStatus(field(body, 'status'));
    if (!id || !status) return [];
    return [{ providerMessageId: id, status, error: status === 'failed' ? field(body, 'failureReason', 'status') : undefined }];
  },
};
