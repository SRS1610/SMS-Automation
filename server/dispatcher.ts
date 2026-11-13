import { providersForCountry } from '../shared/routing';
import type { Settings } from '../shared/types';
import type { CampaignStore } from './campaignStore';
import { nowIso, type DB } from './db';
import type { ProviderStore, ResolvedProvider } from './providerStore';
import { ProviderError, type ProviderContext } from './providers/types';
import type { SettingsStore } from './settings';
import type { SuppressionStore } from './suppressions';

interface QueuedMessage {
  id: number;
  campaign_id: string;
  to_number: string;
  country: string | null;
  body: string;
  encoding: string;
  attempts: number;
  fixed_provider: string | null;
  sender: string | null;
}

export interface DispatcherDeps {
  db: DB;
  providers: ProviderStore;
  settings: SettingsStore;
  campaigns: CampaignStore;
  suppressions: SuppressionStore;
}

export interface DispatcherOptions {
  tickMs?: number;
  /** Max concurrent requests to gateways across all campaigns. */
  maxInFlight?: number;
  fetch?: typeof fetch;
  /** Delay before retrying a transient failure, by attempt number (1-based). */
  backoffMs?: (attempt: number) => number;
  log?: (message: string) => void;
}

const defaultBackoff = (attempt: number) => Math.min(10 * 60_000, 5_000 * 3 ** (attempt - 1));

/**
 * Background worker that drains queued messages: picks a gateway for each
 * recipient (routing rules or the campaign's fixed gateway), respects each
 * gateway's messages-per-second limit, retries transient failures with
 * back-off and fails over to the next gateway when one rejects a message.
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly buckets = new Map<string, { tokens: number; updated: number; rate: number }>();
  private readonly tickMs: number;
  private readonly maxInFlight: number;
  private readonly backoff: (attempt: number) => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly deps: DispatcherDeps,
    private readonly opts: DispatcherOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? 250;
    this.maxInFlight = opts.maxInFlight ?? 50;
    this.backoff = opts.backoffMs ?? defaultBackoff;
    this.log = opts.log ?? ((message) => console.error(`[dispatcher] ${message}`));
  }

  /** Context handed to gateway adapters. */
  contextFor(providerId: string): ProviderContext {
    return {
      fetch: this.opts.fetch ?? globalThis.fetch,
      reportStatus: (update) => {
        try {
          this.deps.campaigns.applyStatus(providerId, update);
        } catch (err) {
          this.log(`could not apply status: ${(err as Error).message}`);
        }
      },
    };
  }

  start(): void {
    if (this.timer) return;
    // Messages left mid-send by a crash or restart go back to the queue.
    this.deps.db.prepare("UPDATE messages SET status = 'queued', updated_at = ? WHERE status = 'sending'").run(nowIso());
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.deps.campaigns.promoteScheduled();
      this.dispatch();
      this.deps.campaigns.completeFinished();
    } catch (err) {
      this.log(`tick failed: ${(err as Error).stack ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Runs ticks until there is nothing left to send (used by tests and scripts). */
  async runUntilIdle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.tick();
      if (this.inFlight.size > 0) {
        await Promise.race([...this.inFlight]);
        continue;
      }
      const pending = this.deps.db
        .prepare(
          `SELECT 1 FROM messages m JOIN campaigns c ON c.id = m.campaign_id
           WHERE c.status IN ('sending') AND m.status IN ('queued', 'sending') LIMIT 1`,
        )
        .get();
      if (!pending) {
        this.tick();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Dispatcher did not become idle in time');
  }

  private take(provider: ResolvedProvider): boolean {
    const rate = Math.max(0.1, provider.rateLimit);
    const now = Date.now();
    let bucket = this.buckets.get(provider.id);
    if (!bucket || bucket.rate !== rate) {
      bucket = { tokens: Math.max(1, rate), updated: now, rate };
      this.buckets.set(provider.id, bucket);
    }
    bucket.tokens = Math.min(Math.max(1, rate), bucket.tokens + ((now - bucket.updated) / 1000) * rate);
    bucket.updated = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private dispatch(): void {
    const capacity = this.maxInFlight - this.inFlight.size;
    if (capacity <= 0) return;
    const { db, campaigns, suppressions } = this.deps;
    const now = nowIso();
    const rows = db
      .prepare(
        `SELECT m.id, m.campaign_id, m.to_number, m.country, m.body, m.encoding, m.attempts,
                c.provider_id AS fixed_provider, c.sender
         FROM messages m JOIN campaigns c ON c.id = m.campaign_id
         WHERE c.status = 'sending' AND m.status = 'queued' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
         ORDER BY m.id LIMIT ?`,
      )
      .all(now, Math.max(capacity * 4, 200)) as unknown as QueuedMessage[];
    if (!rows.length) return;

    const providers = this.deps.providers.resolveAll();
    const anyEnabled = providers.some((p) => p.enabled);
    const settings = this.deps.settings.get();
    const halted = new Set<string>();
    const claim = db.prepare(
      "UPDATE messages SET status = 'sending', provider_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
    );
    let started = 0;

    for (const row of rows) {
      if (started >= capacity) break;
      if (halted.has(row.campaign_id)) continue;

      if (suppressions.has(row.to_number)) {
        campaigns.markSuppressed(row.id);
        continue;
      }

      let candidates: ResolvedProvider[];
      if (row.fixed_provider) {
        const fixed = providers.find((p) => p.id === row.fixed_provider);
        if (!fixed || !fixed.enabled) {
          campaigns.pauseWithError(
            row.campaign_id,
            fixed ? `Gateway “${fixed.name}” is disabled. Enable it, then resume the campaign.` : 'The campaign’s gateway was deleted.',
          );
          halted.add(row.campaign_id);
          continue;
        }
        candidates = [fixed];
      } else {
        if (!anyEnabled) {
          campaigns.pauseWithError(row.campaign_id, 'No SMS gateway is enabled. Enable one in Settings, then resume the campaign.');
          halted.add(row.campaign_id);
          continue;
        }
        candidates = providersForCountry(providers, row.country);
        if (!candidates.length) {
          campaigns.markFailed(row.id, `No enabled gateway covers ${row.country ?? 'this destination'}`);
          continue;
        }
      }

      const provider = candidates[row.attempts % candidates.length];
      if (!this.take(provider)) continue;
      if (claim.run(provider.id, now, row.id).changes !== 1) continue;
      started += 1;

      const sender = row.sender || provider.defaultSender || settings.defaultSender || undefined;
      const task: Promise<void> = this.sendOne(row, provider, candidates.length, sender, settings).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
    }
  }

  private async sendOne(row: QueuedMessage, provider: ResolvedProvider, candidateCount: number, sender: string | undefined, settings: Settings) {
    const attempt = row.attempts + 1;
    try {
      if (provider.def.senderRequired && !sender) {
        throw new ProviderError(`${provider.def.label} needs a sender ID. Set one on the campaign, the gateway, or in Settings → General.`, {
          retryable: false,
          code: 'no_sender',
        });
      }
      const callbackUrl =
        settings.publicBaseUrl && provider.def.deliveryReports === 'auto'
          ? `${settings.publicBaseUrl}/webhooks/${provider.id}/${provider.webhookToken}`
          : undefined;
      const result = await provider.def.send(
        provider.config,
        { to: row.to_number, from: sender, text: row.body, unicode: row.encoding === 'UCS-2', callbackUrl },
        this.contextFor(provider.id),
      );
      this.deps.campaigns.markSent(row.id, result.providerMessageId);
    } catch (err) {
      const error =
        err instanceof ProviderError ? err : new ProviderError(`${provider.name}: ${(err as Error)?.message ?? String(err)}`, { retryable: false, code: 'internal' });
      const maxAttempts = Math.max(settings.maxAttempts, candidateCount);
      const canFailOver = attempt < candidateCount;
      if (attempt < maxAttempts && (error.retryable || canFailOver)) {
        this.deps.campaigns.requeue(row.id, error.message, error.retryable ? this.backoff(attempt) : 0);
      } else {
        this.deps.campaigns.markFailed(row.id, error.message);
      }
    }
  }
}
