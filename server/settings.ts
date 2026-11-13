import { isCountryCode } from '../shared/phone';
import type { Settings } from '../shared/types';
import { type DB } from './db';
import { badRequest } from './errors';

export const DEFAULT_SETTINGS: Settings = {
  defaultCountry: 'US',
  defaultSender: '',
  publicBaseUrl: '',
  optOutFooter: '',
  maxAttempts: 3,
};

export class SettingsStore {
  private cache: Settings | null = null;

  constructor(private readonly db: DB) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        // ignore malformed values; defaults apply
      }
    }
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (key in stored && typeof stored[key] === typeof DEFAULT_SETTINGS[key]) {
        (merged as Record<string, unknown>)[key] = stored[key];
      }
    }
    this.cache = merged;
    return merged;
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.get(), ...patch };
    next.defaultCountry = next.defaultCountry.toUpperCase();
    if (!isCountryCode(next.defaultCountry)) throw badRequest('Default country is not a valid ISO country code');
    next.publicBaseUrl = next.publicBaseUrl.trim().replace(/\/+$/, '');
    if (next.publicBaseUrl) {
      let url: URL;
      try {
        url = new URL(next.publicBaseUrl);
      } catch {
        throw badRequest('Public URL must be a full URL such as https://sms.example.com');
      }
      if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Public URL must start with http:// or https://');
    }
    next.defaultSender = next.defaultSender.trim();
    next.optOutFooter = next.optOutFooter.trim();
    next.maxAttempts = Math.min(10, Math.max(1, Math.round(next.maxAttempts)));

    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(next)) stmt.run(key, JSON.stringify(value));
    this.cache = next;
    return next;
  }
}
