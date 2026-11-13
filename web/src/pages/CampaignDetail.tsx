import { ArrowLeft, Ban, Download, Pause, Play, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { flagEmoji } from '../../../shared/phone';
import type { MessageStatus } from '../../../shared/types';
import { api, ApiError } from '../api';
import { ChartLegend } from '../components/charts';
import { useToast } from '../components/Toast';
import { Alert, Card, ConfirmDialog, EmptyState, Loading, PageHeader, Pagination, ProgressBar, StatusBadge, messageStatusLabel } from '../components/ui';
import { fmtDateTime, fmtInt, fmtPercent, fmtPhone, fmtRelative } from '../format';
import { navigate, useDebounced, useResource } from '../hooks';
import { campaignProgressParts } from './Dashboard';

const STATUS_TABS: (MessageStatus | '')[] = ['', 'delivered', 'sent', 'failed', 'queued', 'suppressed', 'cancelled'];
const LIMIT = 50;

type Action = 'pause' | 'resume' | 'cancel' | 'retry-failed';

export function CampaignDetail({ id }: { id: string }) {
  const toast = useToast();
  const [status, setStatus] = useState<MessageStatus | ''>('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const debounced = useDebounced(search, 250);

  const campaign = useResource(() => api.campaign(id), [id], { intervalMs: 2_000 });
  const messages = useResource(
    () => api.campaignMessages(id, { status: status || undefined, search: debounced || undefined, limit: LIMIT, offset }),
    [id, status, debounced, offset],
  );
  // Delivery receipts keep arriving after a campaign finishes sending, so the
  // message list follows the campaign's counts rather than its status.
  const countsKey = campaign.data ? JSON.stringify(campaign.data.counts) : '';
  const reloadMessages = messages.reload;
  useEffect(() => {
    if (countsKey) void reloadMessages();
  }, [countsKey, reloadMessages]);

  if (campaign.loading && !campaign.data) return <Loading />;
  if (campaign.error && !campaign.data) {
    return (
      <>
        <a className="back-link" href="#/campaigns">
          <ArrowLeft size={14} /> Campaigns
        </a>
        <Alert tone="critical">{campaign.error instanceof ApiError && campaign.error.status === 404 ? 'This campaign no longer exists.' : campaign.error.message}</Alert>
      </>
    );
  }
  const c = campaign.data!;
  const handed = c.counts.sent + c.counts.delivered + c.counts.failed;
  const pending = c.counts.queued + c.counts.sending;

  async function run(action: Action, success: string) {
    setBusy(true);
    try {
      campaign.setData(await api.campaignAction(id, action));
      toast.success(success);
      void messages.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteCampaign(id);
      toast.success('Campaign deleted');
      navigate('/campaigns');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete');
      setBusy(false);
      setConfirm(null);
    }
  }

  const tabCount = (s: MessageStatus | '') => (s === '' ? c.total : c.counts[s] + (s === 'sent' ? c.counts.sending : 0));

  return (
    <>
      <PageHeader
        back={
          <a className="back-link" href="#/campaigns">
            <ArrowLeft size={14} /> Campaigns
          </a>
        }
        title={
          <span className="row wrap" style={{ gap: 10 }}>
            {c.name} <StatusBadge status={c.status} kind="campaign" />
          </span>
        }
        subtitle={
          c.status === 'scheduled'
            ? `Scheduled for ${fmtDateTime(c.scheduledAt)} (${fmtRelative(c.scheduledAt)})`
            : `Created ${fmtDateTime(c.createdAt)}${c.completedAt ? ` · finished ${fmtDateTime(c.completedAt)}` : ''}`
        }
        actions={
          <>
            {(c.status === 'sending' || c.status === 'scheduled') && (
              <button className="btn" disabled={busy} onClick={() => run('pause', 'Campaign paused')}>
                <Pause size={15} /> Pause
              </button>
            )}
            {c.status === 'paused' && (
              <button className="btn primary" disabled={busy} onClick={() => run('resume', 'Campaign resumed')}>
                <Play size={15} /> Resume
              </button>
            )}
            {c.counts.failed > 0 && c.status !== 'scheduled' && (
              <button className="btn" disabled={busy} onClick={() => run('retry-failed', `Retrying ${fmtInt(c.counts.failed)} failed messages`)}>
                <RotateCcw size={15} /> Retry failed
              </button>
            )}
            <a className="btn" href={api.exportUrl(c.id)} download>
              <Download size={15} /> Export CSV
            </a>
            {(c.status === 'sending' || c.status === 'scheduled' || c.status === 'paused') && (
              <button className="btn danger" disabled={busy} onClick={() => setConfirm('cancel')}>
                <Ban size={15} /> Cancel
              </button>
            )}
            {c.status !== 'sending' && (
              <button className="btn ghost danger" disabled={busy} onClick={() => setConfirm('delete')} aria-label="Delete campaign">
                <Trash2 size={15} />
              </button>
            )}
          </>
        }
      />

      {c.lastError && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warning" title="Campaign paused">
            {c.lastError}
          </Alert>
        </div>
      )}

      <div className="stat-grid">
        <div className="card stat">
          <div className="stat-label">Recipients</div>
          <div className="stat-value">{fmtInt(c.total)}</div>
          <div className="stat-foot">{fmtInt(c.segments)} segments</div>
        </div>
        <div className="card stat">
          <div className="stat-label">
            <span className="key" style={{ background: 'var(--series-delivered)' }} aria-hidden /> Delivered
          </div>
          <div className="stat-value">{fmtInt(c.counts.delivered)}</div>
          <div className="stat-foot">{handed ? `${fmtPercent(c.counts.delivered / handed)} of sent` : 'Waiting to send'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">
            <span className="key" style={{ background: 'var(--series-sent)' }} aria-hidden /> Sent, awaiting receipt
          </div>
          <div className="stat-value">{fmtInt(c.counts.sent + c.counts.sending)}</div>
          <div className="stat-foot">{pending ? `${fmtInt(pending)} still queued` : 'Nothing left in the queue'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">
            <span className="key" style={{ background: 'var(--series-failed)' }} aria-hidden /> Failed
          </div>
          <div className="stat-value">{fmtInt(c.counts.failed)}</div>
          <div className="stat-foot">
            {c.counts.suppressed ? `${fmtInt(c.counts.suppressed)} skipped (opted out)` : handed ? `${fmtPercent(c.counts.failed / handed)} of sent` : '—'}
          </div>
        </div>
      </div>

      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <div className="spread" style={{ flexWrap: 'wrap' }}>
            <ChartLegend
              items={campaignProgressParts(c)
                .filter((p) => p.label !== 'Queued' || p.value > 0)
                .map((p) => ({ label: `${p.label} ${fmtInt(p.value)}`, color: p.color }))}
            />
            <span className="muted small tabular">{fmtPercent((c.total - pending) / Math.max(1, c.total), 0)} processed</span>
          </div>
          <ProgressBar total={c.total} parts={campaignProgressParts(c)} tall />
          <div className="grid-2" style={{ marginTop: 6 }}>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>
                Message
              </div>
              <div className="bubble" style={{ maxWidth: '100%' }}>
                {c.body}
              </div>
            </div>
            <dl className="summary-list" style={{ alignSelf: 'start' }}>
              <div>
                <dt>Sender ID</dt>
                <dd>{c.sender ?? 'Gateway default'}</dd>
              </div>
              <div>
                <dt>Gateway</dt>
                <dd>{c.providerName ?? 'Automatic routing'}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{fmtDateTime(c.startedAt)}</dd>
              </div>
              <div>
                <dt>Opted-out numbers skipped</dt>
                <dd>{fmtInt(c.counts.suppressed)}</dd>
              </div>
            </dl>
          </div>
        </div>
      </Card>

      <Card bodyClassName="" className="messages-card">
        <div style={{ padding: '6px 18px 0' }}>
          <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
            {STATUS_TABS.filter((s) => s === '' || tabCount(s) > 0 || s === status).map((s) => (
              <button
                key={s || 'all'}
                role="tab"
                aria-selected={status === s}
                className={status === s ? 'active' : ''}
                onClick={() => {
                  setStatus(s);
                  setOffset(0);
                }}
              >
                {s === '' ? 'All' : messageStatusLabel(s)} <span className="count">{fmtInt(tabCount(s))}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ position: 'relative', maxWidth: 280 }}>
            <Search size={15} className="muted" style={{ position: 'absolute', left: 10, top: 10 }} aria-hidden />
            <input
              className="input"
              style={{ paddingLeft: 32 }}
              placeholder="Find a phone number"
              aria-label="Find a phone number"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </div>
        </div>
        {messages.data && messages.data.items.length === 0 ? (
          <EmptyState icon={<Search size={20} />} title="No messages here">
            {debounced ? 'No number matches that search.' : 'Nothing has this status yet.'}
          </EmptyState>
        ) : !messages.data ? (
          <Loading />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Status</th>
                    <th>Gateway</th>
                    <th className="num">Segments</th>
                    <th className="num">Attempts</th>
                    <th>Updated</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.data.items.map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap">
                        <span aria-hidden style={{ marginRight: 6 }}>
                          {m.country ? flagEmoji(m.country) : '🌐'}
                        </span>
                        <span className="tabular">{fmtPhone(m.to)}</span>
                      </td>
                      <td>
                        <StatusBadge status={m.status} />
                      </td>
                      <td className="secondary">{m.providerName ?? '—'}</td>
                      <td className="num">
                        {m.segments}
                        {m.encoding === 'UCS-2' && <span className="muted small"> U</span>}
                      </td>
                      <td className="num">{m.attempts || '—'}</td>
                      <td className="nowrap secondary">{fmtRelative(m.deliveredAt ?? m.sentAt ?? m.updatedAt)}</td>
                      <td style={{ maxWidth: 340 }}>
                        {m.error ? (
                          <span className={m.status === 'failed' ? 'small' : 'muted small'} style={{ color: m.status === 'failed' ? 'var(--critical-text)' : undefined }}>
                            {m.status !== 'failed' && m.status !== 'suppressed' && m.status !== 'cancelled' ? `Retrying: ${m.error}` : m.error}
                          </span>
                        ) : m.providerMessageId ? (
                          <span className="mono muted" title="Gateway message ID">
                            {m.providerMessageId}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination offset={offset} limit={LIMIT} total={messages.data.total} onChange={setOffset} />
          </>
        )}
      </Card>

      {confirm === 'cancel' && (
        <ConfirmDialog
          title="Cancel this campaign?"
          confirmLabel="Cancel campaign"
          danger
          busy={busy}
          onConfirm={() => run('cancel', 'Campaign cancelled')}
          onCancel={() => setConfirm(null)}
        >
          {fmtInt(c.counts.queued)} queued messages won’t be sent. Messages already handed to a gateway can’t be recalled.
        </ConfirmDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog title="Delete this campaign?" confirmLabel="Delete" danger busy={busy} onConfirm={remove} onCancel={() => setConfirm(null)}>
          The campaign and its {fmtInt(c.total)} message records will be removed permanently. Export a CSV first if you need a record.
        </ConfirmDialog>
      )}
    </>
  );
}
