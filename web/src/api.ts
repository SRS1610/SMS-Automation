import type { CountryInfo } from '../../shared/phone';
import type {
  CampaignStatus,
  CampaignSummary,
  CreateCampaignRequest,
  CreateCampaignResponse,
  MessageRow,
  MessageStatus,
  Overview,
  ProviderInput,
  ProviderSummary,
  ProviderTypeInfo,
  SessionInfo,
  Settings,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: any,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/login')) unauthorizedListeners.forEach((l) => l());
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export interface Page<T> {
  items: T[];
  total: number;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface SuppressionEntry {
  number: string;
  reason: string | null;
  createdAt: string;
}

export const api = {
  session: () => request<SessionInfo>('GET', '/session'),
  login: (password: string) => request<SessionInfo>('POST', '/login', { password }),
  logout: () => request<SessionInfo>('POST', '/logout'),
  quitApp: () => request<{ ok: boolean }>('POST', '/app/quit', { confirm: true }),

  providerTypes: () => request<ProviderTypeInfo[]>('GET', '/provider-types'),
  countries: () => request<CountryInfo[]>('GET', '/countries'),

  providers: () => request<ProviderSummary[]>('GET', '/providers'),
  createProvider: (input: ProviderInput) => request<ProviderSummary>('POST', '/providers', input),
  updateProvider: (id: string, input: ProviderInput) => request<ProviderSummary>('PUT', `/providers/${id}`, input),
  setProviderEnabled: (id: string, enabled: boolean) => request<ProviderSummary>('PATCH', `/providers/${id}`, { enabled }),
  deleteProvider: (id: string) => request<void>('DELETE', `/providers/${id}`),
  testProvider: (id: string) => request<TestResult>('POST', `/providers/${id}/test`),
  sendTestSms: (id: string, body: { to: string; text: string; from?: string }) =>
    request<TestResult & { to?: string }>('POST', `/providers/${id}/send-test`, body),

  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/settings', patch),

  suppressions: (params: { search?: string; limit?: number; offset?: number }) =>
    request<Page<SuppressionEntry>>('GET', `/suppressions${qs(params)}`),
  addSuppressions: (numbers: string[], reason?: string) =>
    request<{ added: number; existing: number; invalid: string[] }>('POST', '/suppressions', { numbers, reason }),
  removeSuppression: (number: string) => request<void>('DELETE', `/suppressions/${encodeURIComponent(number)}`),

  overview: () => request<Overview>('GET', '/overview'),
  campaigns: (params: { status?: CampaignStatus; search?: string; limit?: number; offset?: number }) =>
    request<Page<CampaignSummary>>('GET', `/campaigns${qs(params)}`),
  campaign: (id: string) => request<CampaignSummary>('GET', `/campaigns/${id}`),
  createCampaign: (body: CreateCampaignRequest) => request<CreateCampaignResponse>('POST', '/campaigns', body),
  deleteCampaign: (id: string) => request<void>('DELETE', `/campaigns/${id}`),
  campaignMessages: (id: string, params: { status?: MessageStatus; search?: string; limit?: number; offset?: number }) =>
    request<Page<MessageRow>>('GET', `/campaigns/${id}/messages${qs(params)}`),
  campaignAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry-failed') =>
    request<CampaignSummary>('POST', `/campaigns/${id}/${action}`),
  exportUrl: (id: string) => `/api/campaigns/${id}/export.csv`,
};
