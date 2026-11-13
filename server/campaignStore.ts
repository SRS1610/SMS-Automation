import { buildRecipients } from '../shared/phone';
import { analyzeSms } from '../shared/sms';
import { renderTemplate } from '../shared/template';
import {
  emptyCounts,
  type CampaignStatus,
  type CampaignSummary,
  type CreateCampaignRequest,
  type CreateCampaignResponse,
  type DailyPoint,
  type MessageRow,
  type MessageStatus,
  type Overview,
} from '../shared/types';
import { randomId } from './crypto';
import { nowIso, transaction, type DB } from './db';
import { badRequest, conflict, notFound } from './errors';
import type { ProviderStore } from './providerStore';
import type { StatusUpdate } from './providers/types';
import type { SettingsStore } from './settings';
import type { SuppressionStore } from './suppressions';

/** Hard cap on a single message, matching what most gateways accept. */
export const MAX_MESSAGE_CHARS = 1600;
export const MAX_RECIPIENTS = 100_000;

interface CampaignRow {
  id: string;
  name: string;
  body: string;
  sender: string | null;
  provider_id: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total: number;
  last_error: string | null;
}

interface MessageDbRow {
  id: number;
  to_number: string;
  country: string | null;
  body: string;
  status: MessageStatus;
  provider_id: string | null;
  provider_message_id: string | null;
  attempts: number;
  error: string | null;
  segments: number;
  encoding: string;
  sent_at: string | null;
  delivered_at: string | null;
  updated_at: string;
}

export class CampaignStore {
  constructor(
    private readonly db: DB,
    private readonly providers: ProviderStore,
    private readonly settings: SettingsStore,
    private readonly suppressions: SuppressionStore,
  ) {}

  private providerNames(): Map<string, string> {
    return new Map(this.providers.resolveAll().map((p) => [p.id, p.name]));
  }

  private summarize(rows: CampaignRow[]): CampaignSummary[] {
    if (!rows.length) return [];
    const names = this.providerNames();
    const placeholders = rows.map(() => '?').join(',');
    const stats = this.db
      .prepare(
        `SELECT campaign_id, status, COUNT(*) AS n, SUM(segments) AS s FROM messages
         WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id, status`,
      )
      .all(...rows.map((r) => r.id)) as { campaign_id: string; status: MessageStatus; n: number; s: number }[];

    return rows.map((row) => {
      const counts = emptyCounts();
      let segments = 0;
      for (const stat of stats) {
        if (stat.campaign_id !== row.id) continue;
        counts[stat.status] = stat.n;
        if (stat.status !== 'suppressed' && stat.status !== 'cancelled') segments += stat.s;
      }
      return {
        id: row.id,
        name: row.name,
        body: row.body,
        sender: row.sender,
        providerId: row.provider_id,
        providerName: row.provider_id ? (names.get(row.provider_id) ?? 'Deleted gateway') : null,
        status: row.status,
        scheduledAt: row.scheduled_at,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        total: row.total,
        segments,
        counts,
        lastError: row.last_error,
      };
    });
  }

  private row(id: string): CampaignRow {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as unknown as CampaignRow | undefined;
    if (!row) throw notFound('Campaign not found');
    return row;
  }

  get(id: string): CampaignSummary {
    return this.summarize([this.row(id)])[0];
  }

  list(opts: { limit: number; offset: number; status?: CampaignStatus; search?: string }): { items: CampaignSummary[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.search) {
      where.push('name LIKE ?');
      params.push(`%${opts.search}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM campaigns ${clause}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM campaigns ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit, opts.offset) as unknown as CampaignRow[];
    return { items: this.summarize(rows), total };
  }

  create(req: CreateCampaignRequest): CreateCampaignResponse {
    const settings = this.settings.get();
    const providers = this.providers.resolveAll();
    if (req.providerId) {
      const provider = providers.find((p) => p.id === req.providerId);
      if (!provider) throw badRequest('The selected gateway does not exist');
      if (!provider.enabled) throw badRequest(`Gateway “${provider.name}” is disabled`);
    } else if (!providers.some((p) => p.enabled)) {
      throw badRequest('No SMS gateway is enabled. Add one in Settings → Gateways first.');
    }

    let template = req.body.replace(/\r\n/g, '\n').trim();
    if (!template) throw badRequest('Message is empty');
    if (settings.optOutFooter && !template.includes(settings.optOutFooter)) template = `${template}\n${settings.optOutFooter}`;
    if (template.length > MAX_MESSAGE_CHARS) throw badRequest(`Message is longer than ${MAX_MESSAGE_CHARS} characters`);

    let scheduledAt: string | null = null;
    if (req.scheduledAt) {
      const when = new Date(req.scheduledAt);
      if (Number.isNaN(when.getTime())) throw badRequest('Scheduled time is not a valid date');
      if (when.getTime() > Date.now() + 5_000) scheduledAt = when.toISOString();
    }

    if (req.recipients.length > MAX_RECIPIENTS) throw badRequest(`A campaign can have at most ${MAX_RECIPIENTS.toLocaleString('en')} recipients`);
    const defaultCountry = req.defaultCountry || settings.defaultCountry;
    const list = buildRecipients(req.recipients, defaultCountry);
    if (!list.valid.length) throw badRequest('None of the recipients is a valid phone number', { invalid: list.invalid.slice(0, 100) });
    const suppressed = this.suppressions.filter(list.valid.map((r) => r.phone));

    const id = randomId('cmp');
    const now = nowIso();
    const status: CampaignStatus = scheduledAt ? 'scheduled' : 'sending';
    const sender = req.sender?.trim() || null;

    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO campaigns (id, name, body, sender, provider_id, status, scheduled_at, created_at, started_at, total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, req.name.trim() || 'Untitled campaign', template, sender, req.providerId || null, status, scheduledAt, now, scheduledAt ? null : now, list.valid.length);

      const insert = this.db.prepare(
        `INSERT INTO messages (campaign_id, to_number, country, body, encoding, segments, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const recipient of list.valid) {
        const body = renderTemplate(template, recipient.vars).trim();
        const info = analyzeSms(body);
        let messageStatus: MessageStatus = 'queued';
        let error: string | null = null;
        if (suppressed.has(recipient.phone)) {
          messageStatus = 'suppressed';
          error = 'Number is on the opt-out list';
        } else if (!body) {
          messageStatus = 'failed';
          error = 'Message is empty after personalisation';
        } else if (body.length > MAX_MESSAGE_CHARS) {
          messageStatus = 'failed';
          error = `Message is longer than ${MAX_MESSAGE_CHARS} characters after personalisation`;
        }
        insert.run(id, recipient.phone, recipient.country, body, info.encoding, info.segments, messageStatus, error, now, now);
      }
    });

    return {
      campaign: this.get(id),
      accepted: list.valid.length - suppressed.size,
      suppressed: suppressed.size,
      duplicates: list.duplicates,
      invalidCount: list.invalid.length,
      invalid: list.invalid.slice(0, 100),
    };
  }

  messages(id: string, opts: { status?: MessageStatus; search?: string; limit: number; offset: number }): { items: MessageRow[]; total: number } {
    this.row(id);
    const where = ['campaign_id = ?'];
    const params: (string | number)[] = [id];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const digits = (opts.search ?? '').replace(/[^\d]/g, '');
    if (digits) {
      where.push('to_number LIKE ?');
      params.push(`%${digits}%`);
    }
    const clause = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${clause}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE ${clause} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...params, opts.limit, opts.offset) as unknown as MessageDbRow[];
    const names = this.providerNames();
    return { items: rows.map((r) => this.toMessage(r, names)), total };
  }

  allMessages(id: string): MessageRow[] {
    this.row(id);
    const rows = this.db.prepare('SELECT * FROM messages WHERE campaign_id = ? ORDER BY id').all(id) as unknown as MessageDbRow[];
    const names = this.providerNames();
    return rows.map((r) => this.toMessage(r, names));
  }

  private toMessage(r: MessageDbRow, names: Map<string, string>): MessageRow {
    return {
      id: r.id,
      to: r.to_number,
      country: r.country,
      body: r.body,
      status: r.status,
      providerId: r.provider_id,
      providerName: r.provider_id ? (names.get(r.provider_id) ?? 'Deleted gateway') : null,
      providerMessageId: r.provider_message_id,
      attempts: r.attempts,
      error: r.error,
      segments: r.segments,
      encoding: r.encoding,
      sentAt: r.sent_at,
      deliveredAt: r.delivered_at,
      updatedAt: r.updated_at,
    };
  }

  // ---- lifecycle -------------------------------------------------------

  pause(id: string): CampaignSummary {
    const row = this.row(id);
    if (row.status !== 'sending' && row.status !== 'scheduled') throw conflict(`A ${row.status} campaign can’t be paused`);
    this.db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(id);
    return this.get(id);
  }

  pauseWithError(id: string, error: string): void {
    this.db.prepare("UPDATE campaigns SET status = 'paused', last_error = ? WHERE id = ? AND status = 'sending'").run(error, id);
  }

  resume(id: string): CampaignSummary {
    const row = this.row(id);
    if (row.status !== 'paused') throw conflict(`A ${row.status} campaign can’t be resumed`);
    const future = row.scheduled_at !== null && new Date(row.scheduled_at).getTime() > Date.now();
    this.db
      .prepare('UPDATE campaigns SET status = ?, started_at = COALESCE(started_at, ?), last_error = NULL WHERE id = ?')
      .run(future ? 'scheduled' : 'sending', future ? null : nowIso(), id);
    return this.get(id);
  }

  cancel(id: string): CampaignSummary {
    const row = this.row(id);
    if (row.status === 'completed' || row.status === 'cancelled') throw conflict(`The campaign is already ${row.status}`);
    const now = nowIso();
    transaction(this.db, () => {
      this.db.prepare("UPDATE campaigns SET status = 'cancelled', completed_at = ? WHERE id = ?").run(now, id);
      this.db
        .prepare("UPDATE messages SET status = 'cancelled', error = 'Campaign cancelled', updated_at = ? WHERE campaign_id = ? AND status = 'queued'")
        .run(now, id);
    });
    return this.get(id);
  }

  retryFailed(id: string): CampaignSummary {
    const row = this.row(id);
    if (row.status === 'scheduled') throw conflict('The campaign hasn’t started yet');
    const now = nowIso();
    let retried = 0;
    transaction(this.db, () => {
      retried = Number(
        this.db
          .prepare(
            `UPDATE messages SET status = 'queued', attempts = 0, next_attempt_at = NULL, error = NULL, provider_message_id = NULL, updated_at = ?
             WHERE campaign_id = ? AND status = 'failed'`,
          )
          .run(now, id).changes,
      );
      if (retried > 0) {
        this.db
          .prepare("UPDATE campaigns SET status = 'sending', completed_at = NULL, last_error = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?")
          .run(now, id);
      }
    });
    if (retried === 0) throw conflict('There are no failed messages to retry');
    return this.get(id);
  }

  remove(id: string): void {
    const row = this.row(id);
    if (row.status === 'sending') throw conflict('Pause or cancel the campaign before deleting it');
    this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  }

  // ---- dispatcher hooks -------------------------------------------------

  promoteScheduled(): void {
    const now = nowIso();
    this.db.prepare("UPDATE campaigns SET status = 'sending', started_at = ? WHERE status = 'scheduled' AND scheduled_at <= ?").run(now, now);
  }

  completeFinished(): void {
    this.db
      .prepare(
        `UPDATE campaigns SET status = 'completed', completed_at = ?
         WHERE status = 'sending'
           AND NOT EXISTS (SELECT 1 FROM messages WHERE campaign_id = campaigns.id AND status IN ('queued', 'sending'))`,
      )
      .run(nowIso());
  }

  markSent(messageId: number, providerMessageId: string): void {
    const now = nowIso();
    this.db
      .prepare("UPDATE messages SET status = 'sent', provider_message_id = ?, sent_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'sending'")
      .run(providerMessageId, now, now, messageId);
  }

  requeue(messageId: number, error: string, delayMs: number): void {
    const now = new Date();
    this.db
      .prepare("UPDATE messages SET status = 'queued', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
      .run(error, new Date(now.getTime() + delayMs).toISOString(), now.toISOString(), messageId);
  }

  markFailed(messageId: number, error: string): void {
    this.db
      .prepare("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('sending', 'queued')")
      .run(error, nowIso(), messageId);
  }

  markSuppressed(messageId: number): void {
    this.db
      .prepare("UPDATE messages SET status = 'suppressed', error = 'Number is on the opt-out list', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowIso(), messageId);
  }

  /** Applies a delivery receipt. Returns true when it matched a message. */
  applyStatus(providerId: string, update: StatusUpdate): boolean {
    const row = this.db
      .prepare('SELECT id, status FROM messages WHERE provider_id = ? AND provider_message_id = ? ORDER BY id DESC LIMIT 1')
      .get(providerId, update.providerMessageId) as { id: number; status: MessageStatus } | undefined;
    if (!row) return false;
    const now = nowIso();
    if (update.status === 'delivered' && ['sending', 'sent', 'failed'].includes(row.status)) {
      this.db.prepare("UPDATE messages SET status = 'delivered', delivered_at = ?, error = NULL, updated_at = ? WHERE id = ?").run(now, now, row.id);
    } else if (update.status === 'failed' && ['sending', 'sent'].includes(row.status)) {
      this.db
        .prepare("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(update.error ?? 'Delivery failed', now, row.id);
    } else if (update.status === 'sent' && row.status === 'sending') {
      this.db.prepare("UPDATE messages SET status = 'sent', updated_at = ? WHERE id = ?").run(now, row.id);
    }
    return true;
  }

  // ---- reporting ------------------------------------------------------

  overview(windowDays = 30, chartDays = 14): Overview {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const totals = { ...emptyCounts(), all: 0, segments: 0 };
    const byStatus = this.db
      .prepare('SELECT status, COUNT(*) AS n, SUM(segments) AS s FROM messages WHERE created_at >= ? GROUP BY status')
      .all(since) as { status: MessageStatus; n: number; s: number }[];
    for (const row of byStatus) {
      totals[row.status] = row.n;
      totals.all += row.n;
      if (row.status === 'sent' || row.status === 'delivered' || row.status === 'failed') totals.segments += row.s;
    }
    const handedOver = totals.sent + totals.delivered + totals.failed;

    const today = new Date();
    const days: DailyPoint[] = [];
    for (let i = chartDays - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      days.push({ date: d.toISOString().slice(0, 10), delivered: 0, sent: 0, failed: 0 });
    }
    const chartSince = `${days[0].date}T00:00:00.000Z`;
    const daily = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS d, status, COUNT(*) AS n FROM messages
         WHERE created_at >= ? AND status IN ('sent', 'delivered', 'failed') GROUP BY d, status`,
      )
      .all(chartSince) as { d: string; status: 'sent' | 'delivered' | 'failed'; n: number }[];
    for (const row of daily) {
      const point = days.find((p) => p.date === row.d);
      if (point) point[row.status] = row.n;
    }

    const countries = this.db
      .prepare(
        `SELECT country, COUNT(*) AS n FROM messages WHERE created_at >= ? AND status NOT IN ('suppressed', 'cancelled')
         GROUP BY country ORDER BY n DESC LIMIT 8`,
      )
      .all(since) as { country: string | null; n: number }[];

    const perProvider = this.db
      .prepare(
        `SELECT provider_id, status, COUNT(*) AS n FROM messages
         WHERE created_at >= ? AND provider_id IS NOT NULL AND status IN ('sent', 'delivered', 'failed') GROUP BY provider_id, status`,
      )
      .all(since) as { provider_id: string; status: 'sent' | 'delivered' | 'failed'; n: number }[];
    const providers = this.providers.resolveAll().map((p) => {
      const entry = { id: p.id, name: p.name, type: p.type, enabled: p.enabled, sent: 0, delivered: 0, failed: 0 };
      for (const row of perProvider) if (row.provider_id === p.id) entry[row.status] = row.n;
      return entry;
    });

    const campaignCount = (status: CampaignStatus) =>
      (this.db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE status = ?').get(status) as { n: number }).n;

    return {
      windowDays,
      totals,
      deliveryRate: handedOver > 0 ? totals.delivered / handedOver : null,
      daily: days,
      countries: countries.map((c) => ({ country: c.country, count: c.n })),
      providers,
      activeCampaigns: campaignCount('sending'),
      scheduledCampaigns: campaignCount('scheduled'),
    };
  }
}
