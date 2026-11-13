import { ProviderError, type ProviderContext } from './types';

export interface HttpResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or null if the body wasn't JSON. */
  data: any;
  text: string;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * fetch() wrapper used by every gateway adapter: applies a timeout, parses
 * JSON leniently, and turns network failures into retryable ProviderErrors.
 */
export async function http(ctx: ProviderContext, url: string, req: HttpRequest = {}): Promise<HttpResponse> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: req.method ?? 'GET',
      headers: { Accept: 'application/json', ...req.headers },
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : (err as Error)?.message || 'network error';
    throw new ProviderError(`Request to ${safeHost(url)} failed: ${reason}`, { retryable: true, code: 'network' });
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, ok: res.ok, data, text };
}

/** HTTP statuses worth retrying: throttling, timeouts and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function httpFailure(label: string, res: HttpResponse, message?: string | null, code?: string | number | null): ProviderError {
  const detail = message || truncate(res.text) || `HTTP ${res.status}`;
  return new ProviderError(`${label}: ${detail}`, {
    retryable: isRetryableStatus(res.status),
    code: code !== undefined && code !== null ? String(code) : `http_${res.status}`,
    httpStatus: res.status,
  });
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export function formBody(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  return params.toString();
}

export const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
export const JSON_TYPE = { 'Content-Type': 'application/json' };

export function digitsOnly(e164: string): string {
  return e164.replace(/^\+/, '');
}

export function truncate(text: string, max = 300): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'gateway';
  }
}

/** Reads a field from a webhook payload that may arrive as JSON, form body or query string. */
export function field(source: unknown, ...keys: string[]): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return undefined;
}

export function requireConfig(config: Record<string, string>, label: string, ...keys: string[]): void {
  for (const key of keys) {
    if (!config[key]) {
      throw new ProviderError(`${label}: missing "${key}" in gateway settings`, { retryable: false, code: 'config' });
    }
  }
}
