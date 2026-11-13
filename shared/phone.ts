import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';
import { normalizeVarName, normalizeVars } from './template';

export type { CountryCode };

export interface CountryInfo {
  code: CountryCode;
  name: string;
  dialCode: string;
  flag: string;
}

export function flagEmoji(code: string): string {
  if (!/^[A-Z]{2}$/i.test(code)) return '🌐';
  const base = 0x1f1e6;
  const upper = code.toUpperCase();
  return String.fromCodePoint(base + upper.charCodeAt(0) - 65, base + upper.charCodeAt(1) - 65);
}

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

let countryCache: CountryInfo[] | null = null;
export function listCountries(): CountryInfo[] {
  countryCache ??= getCountries()
    .map((code) => ({
      code,
      name: countryName(code),
      dialCode: `+${getCountryCallingCode(code)}`,
      flag: flagEmoji(code),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return countryCache;
}

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && (getCountries() as string[]).includes(value);
}

export type PhoneResult =
  | { ok: true; e164: string; country: string | null }
  | { ok: false; reason: string };

/**
 * Normalises a phone number to E.164. Numbers without an international
 * prefix are read as belonging to `defaultCountry`.
 */
export function normalizePhone(raw: string, defaultCountry?: string): PhoneResult {
  let input = String(raw ?? '').trim();
  if (!input) return { ok: false, reason: 'Empty' };
  input = input.replace(/[\s().\- ]/g, '');
  if (input.startsWith('00')) input = `+${input.slice(2)}`;
  if (!/^\+?\d{4,17}$/.test(input)) return { ok: false, reason: 'Not a phone number' };

  const country = defaultCountry && isCountryCode(defaultCountry) ? defaultCountry : undefined;
  if (!input.startsWith('+') && !country) {
    return { ok: false, reason: 'Missing country code' };
  }
  const parsed = parsePhoneNumberFromString(input, country);
  if (!parsed) return { ok: false, reason: 'Not a phone number' };
  if (!parsed.isValid()) return { ok: false, reason: 'Invalid number for its country' };
  return { ok: true, e164: parsed.number, country: parsed.country ?? null };
}

export interface RecipientInput {
  phone: string;
  vars?: Record<string, unknown>;
}

export interface Recipient {
  phone: string;
  country: string | null;
  vars: Record<string, string>;
}

export interface InvalidRecipient {
  input: string;
  reason: string;
  row: number;
}

export interface RecipientList {
  valid: Recipient[];
  invalid: InvalidRecipient[];
  duplicates: number;
}

/** Validates, normalises and de-duplicates a recipient list. */
export function buildRecipients(rows: RecipientInput[], defaultCountry?: string): RecipientList {
  const seen = new Set<string>();
  const valid: Recipient[] = [];
  const invalid: InvalidRecipient[] = [];
  let duplicates = 0;

  rows.forEach((row, index) => {
    const result = normalizePhone(row.phone, defaultCountry);
    if (!result.ok) {
      invalid.push({ input: String(row.phone ?? ''), reason: result.reason, row: index + 1 });
      return;
    }
    if (seen.has(result.e164)) {
      duplicates += 1;
      return;
    }
    seen.add(result.e164);
    valid.push({ phone: result.e164, country: result.country, vars: normalizeVars(row.vars) });
  });

  return { valid, invalid, duplicates };
}

const PHONE_HEADERS = ['phone', 'phone_number', 'mobile', 'mobile_number', 'msisdn', 'number', 'to', 'cell', 'telephone', 'tel', 'whatsapp'];

/** Picks the column that most likely holds phone numbers from a CSV header row. */
export function detectPhoneColumn(headers: string[]): number {
  const normalized = headers.map(normalizeVarName);
  for (const candidate of PHONE_HEADERS) {
    const index = normalized.indexOf(candidate);
    if (index !== -1) return index;
  }
  return normalized.findIndex((h) => /phone|mobile|msisdn|number/.test(h));
}
