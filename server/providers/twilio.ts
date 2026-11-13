import { basicAuth, field, FORM, formBody, http, httpFailure, requireConfig } from './http';
import { ProviderError, type ProviderDefinition, type ReportedStatus } from './types';

const API = 'https://api.twilio.com/2010-04-01';

// Twilio error codes that mean "this recipient can't be messaged" rather than a transient fault.
const PERMANENT_CODES = new Set([21211, 21408, 21610, 21612, 21614, 21606, 21659, 30003, 30005, 30006, 30007]);

function mapStatus(status: string | undefined): ReportedStatus | null {
  switch (status) {
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'failed';
    case 'sent':
      return 'sent';
    default:
      return null;
  }
}

export const twilio: ProviderDefinition = {
  type: 'twilio',
  label: 'Twilio',
  description: 'Programmable Messaging API. Send from long codes, short codes, alphanumeric IDs or a Messaging Service.',
  website: 'https://www.twilio.com/docs/messaging',
  coverage: '180+ countries',
  senderRequired: false,
  deliveryReports: 'auto',
  fields: [
    { key: 'accountSid', label: 'Account SID', type: 'text', required: true, placeholder: 'AC…', help: 'Found on the Twilio Console dashboard.' },
    { key: 'authToken', label: 'Auth token', type: 'secret', required: true },
    {
      key: 'messagingServiceSid',
      label: 'Messaging Service SID',
      type: 'text',
      placeholder: 'MG…',
      help: 'Optional. When set, messages go through the service (a sender ID becomes optional, and Twilio picks one from its pool when none is given).',
    },
  ],
  validate(config) {
    if (config.accountSid && !/^AC[0-9a-fA-F]{32}$/.test(config.accountSid)) return 'Account SID should look like AC followed by 32 hex characters';
    if (config.messagingServiceSid && !/^MG[0-9a-fA-F]{32}$/.test(config.messagingServiceSid)) return 'Messaging Service SID should start with MG';
    return null;
  },

  async send(config, input, ctx) {
    requireConfig(config, 'Twilio', 'accountSid', 'authToken');
    if (!input.from && !config.messagingServiceSid) {
      throw new ProviderError('Twilio: a sender (From) or a Messaging Service SID is required', { retryable: false, code: 'no_sender' });
    }
    const res = await http(ctx, `${API}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { ...FORM, Authorization: basicAuth(config.accountSid, config.authToken) },
      body: formBody({
        To: input.to,
        From: input.from,
        MessagingServiceSid: config.messagingServiceSid || undefined,
        Body: input.text,
        StatusCallback: input.callbackUrl,
      }),
    });
    if (!res.ok || !res.data?.sid) {
      const err = httpFailure('Twilio', res, res.data?.message, res.data?.code);
      if (PERMANENT_CODES.has(Number(res.data?.code))) {
        throw new ProviderError(err.message, { retryable: false, code: err.code, httpStatus: res.status });
      }
      throw err;
    }
    return { providerMessageId: res.data.sid };
  },

  async test(config, ctx) {
    requireConfig(config, 'Twilio', 'accountSid', 'authToken');
    const res = await http(ctx, `${API}/Accounts/${encodeURIComponent(config.accountSid)}.json`, {
      headers: { Authorization: basicAuth(config.accountSid, config.authToken) },
    });
    if (!res.ok) throw httpFailure('Twilio', res, res.data?.message, res.data?.code);
    return `Connected to account “${res.data?.friendly_name ?? config.accountSid}” (${res.data?.status ?? 'unknown status'})`;
  },

  parseWebhook({ body }) {
    const id = field(body, 'MessageSid', 'SmsSid');
    const status = mapStatus(field(body, 'MessageStatus', 'SmsStatus'));
    if (!id || !status) return [];
    const code = field(body, 'ErrorCode');
    return [{ providerMessageId: id, status, error: status === 'failed' ? `Twilio error ${code ?? 'unknown'}` : undefined }];
  },
};
