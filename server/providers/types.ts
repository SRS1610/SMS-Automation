import type { DeliveryReportMode, FieldDef } from '../../shared/types';

export type ProviderConfig = Record<string, string>;

export interface SendInput {
  /** Destination in E.164, e.g. +447911123456. */
  to: string;
  /** Sender ID / originating number. May be undefined if the gateway has a default. */
  from?: string;
  text: string;
  /** True when the text needs UCS-2 (non GSM-7 characters). */
  unicode: boolean;
  /** Where the gateway should POST delivery receipts, when a public URL is configured. */
  callbackUrl?: string;
}

export interface SendOutput {
  providerMessageId: string;
}

export type ReportedStatus = 'sent' | 'delivered' | 'failed';

export interface StatusUpdate {
  providerMessageId: string;
  status: ReportedStatus;
  error?: string;
}

export interface WebhookRequest {
  method: string;
  body: unknown;
  query: Record<string, unknown>;
}

export interface ProviderContext {
  fetch: typeof fetch;
  /** Lets a gateway report delivery status outside of a webhook (used by the sandbox). */
  reportStatus?: (update: StatusUpdate) => void;
}

export interface ProviderDefinition {
  type: string;
  label: string;
  description: string;
  website: string;
  coverage: string;
  fields: FieldDef[];
  senderRequired: boolean;
  deliveryReports: DeliveryReportMode;
  webhookHelp?: string;
  /** Extra validation of a complete config. Return an error message, or null. */
  validate?(config: ProviderConfig): string | null;
  send(config: ProviderConfig, input: SendInput, ctx: ProviderContext): Promise<SendOutput>;
  /** Verifies credentials without sending a message. Returns a human readable summary. */
  test(config: ProviderConfig, ctx: ProviderContext): Promise<string>;
  /** Turns a delivery-report callback into status updates. */
  parseWebhook?(req: WebhookRequest, config: ProviderConfig): StatusUpdate[];
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly code?: string;
  readonly httpStatus?: number;

  constructor(message: string, opts: { retryable: boolean; code?: string; httpStatus?: number }) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
  }
}
