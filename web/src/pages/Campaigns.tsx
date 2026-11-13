import { Inbox, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import type { CampaignStatus } from '../../../shared/types';
import { api } from '../api';
import { Alert, Card, EmptyState, Loading, PageHeader, Pagination, ProgressBar, StatusBadge } from '../components/ui';
import { fmtDateTime, fmtInt, fmtPercent } from '../format';
import { navigate, useDebounced, useResource } from '../hooks';
import { campaignProgressParts } from './Dashboard';

const FILTERS: { value: CampaignStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'sending', label: 'Sending' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const LIMIT = 25;

export function Campaigns() {
  const [status, setStatus] = useState<CampaignStatus | ''>('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search, 250);
  const campaigns = useResource(
    () => api.campaigns({ status: status || undefined, search: debounced || undefined, limit: LIMIT, offset }),
    [status, debounced, offset],
    { intervalMs: 4_000 },
  );

  const data = campaigns.data;
  const filtered = !!status || !!debounced;

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="Every bulk send, with live delivery progress"
        actions={
          <a className="btn primary" href="#/send">
            <Plus size={16} /> New campaign
          </a>
        }
      />
      <div className="spread" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="segmented" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="tab"
              aria-selected={status === f.value}
              className={status === f.value ? 'active' : ''}
              onClick={() => {
                setStatus(f.value);
                setOffset(0);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative', width: 260, maxWidth: '100%' }}>
          <Search size={15} className="muted" style={{ position: 'absolute', left: 10, top: 10 }} aria-hidden />
          <input
            className="input"
            style={{ paddingLeft: 32 }}
            placeholder="Search by name"
            aria-label="Search campaigns"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>

      {campaigns.loading && !data ? (
        <Loading />
      ) : campaigns.error && !data ? (
        <Alert tone="critical">Could not load campaigns: {campaigns.error.message}</Alert>
      ) : (
        <Card bodyClassName="">
          {data && data.items.length === 0 ? (
            filtered ? (
              <EmptyState icon={<Search size={20} />} title="No matching campaigns">
                Try another status or search term.
              </EmptyState>
            ) : (
              <EmptyState
                icon={<Inbox size={20} />}
                title="No campaigns yet"
                action={
                  <a className="btn primary" href="#/send">
                    <Plus size={16} /> New campaign
                  </a>
                }
              >
                Campaigns you send or schedule show up here with their delivery progress.
              </EmptyState>
            )
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Status</th>
                      <th style={{ width: '22%' }}>Progress</th>
                      <th className="num">Recipients</th>
                      <th className="num">Delivered</th>
                      <th className="num">Failed</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.items.map((c) => {
                      const handed = c.counts.sent + c.counts.delivered + c.counts.failed;
                      return (
                        <tr key={c.id} className="clickable" onClick={() => navigate(`/campaigns/${c.id}`)}>
                          <td>
                            <a className="cell-title" href={`#/campaigns/${c.id}`} style={{ color: 'inherit' }} onClick={(e) => e.stopPropagation()}>
                              {c.name}
                            </a>
                            <div className="cell-sub">{c.body}</div>
                          </td>
                          <td>
                            <StatusBadge status={c.status} kind="campaign" />
                            {c.status === 'scheduled' && <div className="cell-sub">{fmtDateTime(c.scheduledAt)}</div>}
                          </td>
                          <td>
                            <ProgressBar total={c.total} parts={campaignProgressParts(c)} />
                          </td>
                          <td className="num">{fmtInt(c.total)}</td>
                          <td className="num">{handed ? fmtPercent(c.counts.delivered / handed) : '—'}</td>
                          <td className="num">{fmtInt(c.counts.failed)}</td>
                          <td className="nowrap secondary">{fmtDateTime(c.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination offset={offset} limit={LIMIT} total={data!.total} onChange={setOffset} />
            </>
          )}
        </Card>
      )}
    </>
  );
}
