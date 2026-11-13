import { isCountryCode } from '../shared/phone';
import type { ProviderInput, ProviderSummary, SecretState } from '../shared/types';
import { randomId, randomToken, type SecretBox } from './crypto';
import { nowIso, type DB } from './db';
import { badRequest, notFound } from './errors';
import { getProviderDefinition, isSecretField } from './providers/registry';
import type { ProviderConfig, ProviderDefinition } from './providers/types';

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  config_enc: string;
  enabled: number;
  priority: number;
  countries: string;
  rate_limit: number;
  default_sender: string | null;
  webhook_token: string;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

/** A gateway with decrypted credentials, ready for sending. Never leaves the server. */
export interface ResolvedProvider {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  priority: number;
  countries: string[];
  rateLimit: number;
  defaultSender: string | null;
  webhookToken: string;
  config: ProviderConfig;
  def: ProviderDefinition;
}

function maskSecret(value: string): SecretState {
  if (!value) return { set: false, hint: '' };
  return { set: true, hint: value.length >= 12 ? `••••${value.slice(-4)}` : '••••••' };
}

export class ProviderStore {
  private resolvedCache: ResolvedProvider[] | null = null;

  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
  ) {}

  private rows(): ProviderRow[] {
    return this.db.prepare('SELECT * FROM providers ORDER BY priority, name').all() as unknown as ProviderRow[];
  }

  private row(id: string): ProviderRow | undefined {
    return this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as unknown as ProviderRow | undefined;
  }

  private decrypt(row: ProviderRow): ProviderConfig {
    try {
      return JSON.parse(this.box.open(row.config_enc)) as ProviderConfig;
    } catch {
      // Wrong APP_SECRET or corrupted value: surface as an empty config so the UI can ask for credentials again.
      return {};
    }
  }

  private toSummary(row: ProviderRow): ProviderSummary {
    const def = getProviderDefinition(row.type);
    const config = this.decrypt(row);
    const visible: Record<string, string> = {};
    const secrets: Record<string, SecretState> = {};
    for (const field of def?.fields ?? []) {
      const value = config[field.key] ?? '';
      if (def && isSecretField(def, field.key)) secrets[field.key] = maskSecret(value);
      else visible[field.key] = value;
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      priority: row.priority,
      countries: JSON.parse(row.countries) as string[],
      rateLimit: row.rate_limit,
      defaultSender: row.default_sender,
      config: visible,
      secrets,
      webhookPath: `/webhooks/${row.id}/${row.webhook_token}`,
      lastTest:
        row.last_test_at !== null
          ? { at: row.last_test_at, ok: row.last_test_ok === 1, message: row.last_test_message ?? '' }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toResolved(row: ProviderRow): ResolvedProvider | null {
    const def = getProviderDefinition(row.type);
    if (!def) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      priority: row.priority,
      countries: JSON.parse(row.countries) as string[],
      rateLimit: row.rate_limit,
      defaultSender: row.default_sender,
      webhookToken: row.webhook_token,
      config: this.decrypt(row),
      def,
    };
  }

  list(): ProviderSummary[] {
    return this.rows().map((row) => this.toSummary(row));
  }

  get(id: string): ProviderSummary {
    const row = this.row(id);
    if (!row) throw notFound('Gateway not found');
    return this.toSummary(row);
  }

  /** All gateways with decrypted configs (cached until the next change). */
  resolveAll(): ResolvedProvider[] {
    this.resolvedCache ??= this.rows()
      .map((row) => this.toResolved(row))
      .filter((p): p is ResolvedProvider => p !== null);
    return this.resolvedCache;
  }

  resolve(id: string): ResolvedProvider | undefined {
    return this.resolveAll().find((p) => p.id === id);
  }

  private buildConfig(def: ProviderDefinition, incoming: Record<string, string>, existing: ProviderConfig): ProviderConfig {
    const config: ProviderConfig = {};
    for (const field of def.fields) {
      const raw = incoming[field.key];
      const value = typeof raw === 'string' ? (field.type === 'textarea' ? raw.replace(/\r\n/g, '\n').trim() : raw.trim()) : '';
      if (isSecretField(def, field.key) && value === '' && existing[field.key]) {
        config[field.key] = existing[field.key]; // blank secret = keep the stored one
      } else if (value !== '') {
        config[field.key] = value;
      } else if (field.default !== undefined && field.type === 'select') {
        config[field.key] = field.default;
      }
      if (field.type === 'select' && field.options && config[field.key] && !field.options.some((o) => o.value === config[field.key])) {
        throw badRequest(`${field.label}: unsupported value`);
      }
      if (field.type === 'number' && config[field.key] && !Number.isFinite(Number(config[field.key]))) {
        throw badRequest(`${field.label} must be a number`);
      }
      if (field.required && !config[field.key]) throw badRequest(`${field.label} is required`);
    }
    const problem = def.validate?.(config);
    if (problem) throw badRequest(problem);
    return config;
  }

  private normalizeInput(input: ProviderInput) {
    const countries = Array.from(new Set(input.countries.map((c) => c.toUpperCase())));
    const unknown = countries.filter((c) => !isCountryCode(c));
    if (unknown.length) throw badRequest(`Unknown country codes: ${unknown.join(', ')}`);
    return {
      name: input.name.trim(),
      enabled: input.enabled ? 1 : 0,
      priority: Math.round(input.priority),
      countries: JSON.stringify(countries.sort()),
      rateLimit: input.rateLimit,
      defaultSender: input.defaultSender?.trim() || null,
    };
  }

  create(input: ProviderInput): ProviderSummary {
    const def = getProviderDefinition(input.type);
    if (!def) throw badRequest(`Unknown gateway type "${input.type}"`);
    const config = this.buildConfig(def, input.config, {});
    const n = this.normalizeInput(input);
    const id = randomId('gw');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO providers (id, name, type, config_enc, enabled, priority, countries, rate_limit, default_sender, webhook_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, n.name, def.type, this.box.seal(JSON.stringify(config)), n.enabled, n.priority, n.countries, n.rateLimit, n.defaultSender, randomToken(), now, now);
    this.resolvedCache = null;
    return this.get(id);
  }

  update(id: string, input: ProviderInput): ProviderSummary {
    const row = this.row(id);
    if (!row) throw notFound('Gateway not found');
    if (input.type !== row.type) throw badRequest('A gateway’s type can’t be changed. Add a new gateway instead.');
    const def = getProviderDefinition(row.type);
    if (!def) throw badRequest(`Unknown gateway type "${row.type}"`);
    const config = this.buildConfig(def, input.config, this.decrypt(row));
    const n = this.normalizeInput(input);
    this.db
      .prepare(
        `UPDATE providers SET name = ?, config_enc = ?, enabled = ?, priority = ?, countries = ?, rate_limit = ?, default_sender = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(n.name, this.box.seal(JSON.stringify(config)), n.enabled, n.priority, n.countries, n.rateLimit, n.defaultSender, nowIso(), id);
    this.resolvedCache = null;
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean): ProviderSummary {
    const result = this.db.prepare('UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), id);
    if (result.changes === 0) throw notFound('Gateway not found');
    this.resolvedCache = null;
    return this.get(id);
  }

  remove(id: string): void {
    const result = this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    if (result.changes === 0) throw notFound('Gateway not found');
    this.resolvedCache = null;
  }

  recordTest(id: string, ok: boolean, message: string): void {
    this.db.prepare('UPDATE providers SET last_test_at = ?, last_test_ok = ?, last_test_message = ? WHERE id = ?').run(nowIso(), ok ? 1 : 0, message, id);
  }
}
