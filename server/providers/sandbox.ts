import { randomBytes } from 'node:crypto';
import { ProviderError, type ProviderDefinition } from './types';

function percent(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Simulated gateway. Nothing leaves the server: messages are "accepted" after
 * a short delay and a delivery receipt follows a few seconds later. Useful for
 * trying the dashboard and for rehearsing a campaign before paying for it.
 */
export const sandbox: ProviderDefinition = {
  type: 'sandbox',
  label: 'Sandbox (simulated)',
  description: 'Simulates a gateway without sending real SMS. Try campaigns end-to-end at no cost.',
  website: '',
  coverage: 'Every country (simulated)',
  senderRequired: false,
  deliveryReports: 'simulated',
  fields: [
    { key: 'rejectRate', label: 'Rejected at send (%)', type: 'number', default: '0', help: 'Share of messages the simulated gateway refuses outright.' },
    { key: 'undeliveredRate', label: 'Undelivered (%)', type: 'number', default: '3', help: 'Share of accepted messages that later report as failed.' },
    { key: 'latencyMs', label: 'Response time (ms)', type: 'number', default: '150' },
  ],

  async send(config, input, ctx) {
    await sleep(Math.min(5_000, Math.max(0, Number(config.latencyMs) || 0)));
    if (Math.random() * 100 < percent(config.rejectRate, 0)) {
      throw new ProviderError('Sandbox: simulated rejection', { retryable: false, code: 'simulated_reject' });
    }
    const providerMessageId = `sbx_${randomBytes(8).toString('hex')}`;
    if (ctx.reportStatus) {
      const failed = Math.random() * 100 < percent(config.undeliveredRate, 3);
      const delay = 1_500 + Math.random() * 3_000;
      const report = ctx.reportStatus;
      setTimeout(() => {
        report(failed ? { providerMessageId, status: 'failed', error: 'Sandbox: simulated handset unreachable' } : { providerMessageId, status: 'delivered' });
      }, delay).unref?.();
    }
    void input;
    return { providerMessageId };
  },

  async test() {
    return 'Sandbox is ready. Messages are simulated and never leave this server.';
  },
};
