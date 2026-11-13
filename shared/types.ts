import type { InvalidRecipient, RecipientInput } from './phone';

export const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'failed', 'cancelled', 'suppressed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['scheduled', 'sending', 'paused', 'completed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type FieldType = 'text' | 'secret' | 'url' | 'number' | 'select' | 'textarea';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string;
  options?: { value: string; label: string }[];
  /** Treat the value as a secret (encrypted, never sent back to the browser). */
  secret?: boolean;
}

export type DeliveryReportMode =
  /** Callback URL is sent with every message when a public URL is configured. */
  | 'auto'
  /** The webhook URL must be pasted into the provider's own console. */
  | 'manual'
  /** Delivery receipts are simulated (sandbox). */
  | 'simulated'
  | 'none';

export interface ProviderTypeInfo {
  type: string;
  label: string;
  description: string;
  website: string;
  coverage: string;
  fields: FieldDef[];
  senderRequired: boolean;
  deliveryReports: DeliveryReportMode;
  webhookHelp?: string;
}

export interface SecretState {
  set: boolean;
  hint: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  priority: number;
  countries: string[];
  rateLimit: number;
  defaultSender: string | null;
  config: Record<string, string>;
  secrets: Record<string, SecretState>;
  webhookPath: string;
  lastTest: { at: string; ok: boolean; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInput {
  name: string;
  type: string;
  enabled: boolean;
  priority: number;
  countries: string[];
  rateLimit: number;
  defaultSender: string | null;
  /** Secret fields left blank keep their stored value. */
  config: Record<string, string>;
}

export interface Settings {
  defaultCountry: string;
  defaultSender: string;
  publicBaseUrl: string;
  optOutFooter: string;
  maxAttempts: number;
}

export type StatusCounts = Record<MessageStatus, number>;

export interface CampaignSummary {
  id: string;
  name: string;
  body: string;
  sender: string | null;
  providerId: string | null;
  providerName: string | null;
  status: CampaignStatus;
  scheduledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  total: number;
  segments: number;
  counts: StatusCounts;
  lastError: string | null;
}

export interface MessageRow {
  id: number;
  to: string;
  country: string | null;
  body: string;
  status: MessageStatus;
  providerId: string | null;
  providerName: string | null;
  providerMessageId: string | null;
  attempts: number;
  error: string | null;
  segments: number;
  encoding: string;
  sentAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
}

export interface CreateCampaignRequest {
  name: string;
  body: string;
  sender?: string | null;
  providerId?: string | null;
  scheduledAt?: string | null;
  defaultCountry?: string | null;
  recipients: RecipientInput[];
}

export interface CreateCampaignResponse {
  campaign: CampaignSummary;
  accepted: number;
  suppressed: number;
  duplicates: number;
  invalidCount: number;
  invalid: InvalidRecipient[];
}

export interface DailyPoint {
  date: string;
  delivered: number;
  sent: number;
  failed: number;
}

export interface Overview {
  windowDays: number;
  totals: StatusCounts & { all: number; segments: number };
  deliveryRate: number | null;
  daily: DailyPoint[];
  countries: { country: string | null; count: number }[];
  providers: { id: string; name: string; type: string; enabled: boolean; sent: number; delivered: number; failed: number }[];
  activeCampaigns: number;
  scheduledCampaigns: number;
}

export interface SessionInfo {
  authRequired: boolean;
  authenticated: boolean;
  /** Running as the local desktop app (shows a Quit button). */
  desktop?: boolean;
}

export function emptyCounts(): StatusCounts {
  return { queued: 0, sending: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0, suppressed: 0 };
}
