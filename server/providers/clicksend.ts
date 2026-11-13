import { basicAuth, http, httpFailure, JSON_TYPE, requireConfig } from './http';
import { ProviderError, type ProviderDefinition } from './types';

const API = 'https://rest.clicksend.com/v3';

export const clicksend: ProviderDefinition = {
  type: 'clicksend',
  label: 'ClickSend',
  description: 'ClickSend REST API v3 using your username and API key.',
  website: 'https://developers.clicksend.com/docs/rest/v3/',
  coverage: 'Global',
  senderRequired: false,
  deliveryReports: 'none',
  fields: [
    { key: 'username', label: 'Username', type: 'text', required: true, help: 'Your ClickSend account username (often your email address).' },
    { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Dashboard → Developers → API Credentials.' },
  ],

  async send(config, input, ctx) {
    requireConfig(config, 'ClickSend', 'username', 'apiKey');
    const res = await http(ctx, `${API}/sms/send`, {
      method: 'POST',
      headers: { ...JSON_TYPE, Authorization: basicAuth(config.username, config.apiKey) },
      body: JSON.stringify({
        messages: [{ source: 'sms-automation', to: input.to, body: input.text, ...(input.from ? { from: input.from } : {}) }],
      }),
    });
    const message = res.data?.data?.messages?.[0];
    if (!res.ok) throw httpFailure('ClickSend', res, res.data?.response_msg, res.data?.response_code);
    if (!message || message.status !== 'SUCCESS' || !message.message_id) {
      throw new ProviderError(`ClickSend: ${message?.status ?? res.data?.response_msg ?? 'message not accepted'}`, {
        retryable: false,
        code: message?.status,
      });
    }
    return { providerMessageId: String(message.message_id) };
  },

  async test(config, ctx) {
    requireConfig(config, 'ClickSend', 'username', 'apiKey');
    const res = await http(ctx, `${API}/account`, { headers: { Authorization: basicAuth(config.username, config.apiKey) } });
    if (!res.ok) throw httpFailure('ClickSend', res, res.data?.response_msg, res.data?.response_code);
    const account = res.data?.data;
    const balance = account?.balance !== undefined ? ` Balance: ${account.balance} ${account?._currency?.currency_name_short ?? ''}` : '';
    return `Connected as ${account?.username ?? config.username}.${balance}`.trim();
  },
};
