import { Inbox, PlugZap, Plus, Table2, ChartColumn } from 'lucide-react';
import { useState } from 'react';
import type { CampaignSummary } from '../../../shared/types';
import { api } from '../api';
import { BarList, CountryLabel, DailyChart, SeriesLegend } from '../components/charts';
import { Alert, Card, EmptyState, Loading, PageHeader, ProgressBar, StatusBadge } from '../components/ui';
import { fmtCount, fmtInt, fmtPercent, fmtRelative } from '../format';
import { navigate, useResource } from '../hooks';

export function campaignProgressParts(c: CampaignSummary) {
  return [
    { label: 'Delivered', value: c.counts.delivered, color: 'var(--series-delivered)' },
    { label: 'Sent', value: c.counts.sent + c.counts.sending, color: 'var(--series-sent)' },
    { label: 'Failed', value: c.counts.failed, color: 'var(--series-failed)' },
    { label: 'Queued', value: c.counts.queued, color: 'var(--series-queued)' },
  ];
}

function Stat({ label, value, foot }: { label: string; value: string; foot?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function Dashboard() {
  const overview = useResource(() => api.overview(), [], { intervalMs: 5_000 });
  const recent = useResource(() => api.campaigns({ limit: 6 }), [], { intervalMs: 5_000 });
  const [tableView, setTableView] = useState(false);

  if (overview.loading && !overview.data) return <Loading />;
  if (overview.error && !overview.data) return <Alert tone="critical">Could not load the dashboard: {overview.error.message}</Alert>;
  const o = overview.data!;
  const handed = o.totals.sent + o.totals.delivered + o.totals.failed;
  const noGateways = o.providers.length === 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Activity over the last ${o.windowDays} days, across every gateway`}
        actions={
          <a className="btn primary" href="#/send">
            <Plus size={16} /> New campaign
          </a>
        }
      />

      {noGateways && (
        <div style={{ marginBottom: 16 }}>
          <Alert
            tone="warning"
            title="Connect an SMS gateway to start sending"
            action={
              <a className="btn sm" href="#/settings/gateways">
                <PlugZap size={14} /> Add gateway
              </a>
            }
          >
            Add Twilio, Vonage, Plivo, Sinch, Infobip or any HTTP gateway in Settings. The Sandbox gateway lets you try everything without sending real SMS.
          </Alert>
        </div>
      )}

      <div className="stat-grid">
        <Stat label="Messages sent" value={fmtCount(handed)} foot={`${fmtCount(o.totals.segments)} billable segments`} />
        <Stat
          label="Delivery rate"
          value={fmtPercent(o.deliveryRate)}
          foot={o.deliveryRate === null ? 'Needs delivery receipts' : `${fmtInt(o.totals.delivered)} confirmed delivered`}
        />
        <Stat label="Failed" value={fmtCount(o.totals.failed)} foot={handed ? `${fmtPercent(o.totals.failed / handed)} of messages sent` : 'Nothing sent yet'} />
        <Stat
          label="Active campaigns"
          value={fmtInt(o.activeCampaigns)}
          foot={`${fmtInt(o.totals.queued + o.totals.sending)} queued · ${fmtInt(o.scheduledCampaigns)} scheduled`}
        />
      </div>

      <div className="dash-grid">
        <Card
          title="Messages per day"
          hint="Last 14 days, UTC"
          actions={
            <button className="btn ghost sm" onClick={() => setTableView((v) => !v)} aria-pressed={tableView}>
              {tableView ? <ChartColumn size={14} /> : <Table2 size={14} />}
              {tableView ? 'Chart' : 'Table'}
            </button>
          }
        >
          {!tableView && (
            <div style={{ marginBottom: 12 }}>
              <SeriesLegend />
            </div>
          )}
          <DailyChart data={o.daily} tableView={tableView} />
        </Card>

        <Card title="Top destinations" hint="Messages by country">
          <BarList
            items={o.countries.map((c) => ({ key: c.country ?? 'unknown', label: <CountryLabel code={c.country} />, value: c.count }))}
            empty="Destinations appear here once you send a campaign."
          />
        </Card>

        <Card
          title="Recent campaigns"
          actions={
            <a className="btn ghost sm" href="#/campaigns">
              View all
            </a>
          }
          bodyClassName=""
        >
          {recent.data && recent.data.items.length === 0 ? (
            <EmptyState
              icon={<Inbox size={20} />}
              title="No campaigns yet"
              action={
                <a className="btn primary" href="#/send">
                  <Plus size={16} /> Create your first campaign
                </a>
              }
            >
              Paste numbers or upload a CSV, write your message, and send to customers in any country.
            </EmptyState>
          ) : (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Status</th>
                    <th style={{ width: '28%' }}>Progress</th>
                    <th className="num">Recipients</th>
                  </tr>
                </thead>
                <tbody>
                  {(recent.data?.items ?? []).map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => navigate(`/campaigns/${c.id}`)}>
                      <td>
                        <a className="cell-title" href={`#/campaigns/${c.id}`} style={{ color: 'inherit' }} onClick={(e) => e.stopPropagation()}>
                          {c.name}
                        </a>
                        <div className="cell-sub">{fmtRelative(c.createdAt)}</div>
                      </td>
                      <td>
                        <StatusBadge status={c.status} kind="campaign" />
                      </td>
                      <td>
                        <ProgressBar total={c.total} parts={campaignProgressParts(c)} />
                      </td>
                      <td className="num">{fmtInt(c.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Gateways"
          hint="Last 30 days"
          actions={
            <a className="btn ghost sm" href="#/settings/gateways">
              Manage
            </a>
          }
        >
          {o.providers.length === 0 ? (
            <div className="muted small">No gateways connected yet.</div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {o.providers.map((p) => {
                const total = p.sent + p.delivered + p.failed;
                return (
                  <div key={p.id}>
                    <div className="spread">
                      <span className="row" style={{ gap: 8, minWidth: 0 }}>
                        <span className="key" style={{ borderRadius: '50%', background: p.enabled ? 'var(--good)' : 'var(--neutral-dot)' }} aria-hidden />
                        <span style={{ fontWeight: 550 }}>{p.name}</span>
                        {!p.enabled && <span className="muted small">disabled</span>}
                      </span>
                      <span className="secondary small tabular">{fmtInt(total)} sent</span>
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <ProgressBar
                        total={total}
                        parts={[
                          { label: 'Delivered', value: p.delivered, color: 'var(--series-delivered)' },
                          { label: 'Sent', value: p.sent, color: 'var(--series-sent)' },
                          { label: 'Failed', value: p.failed, color: 'var(--series-failed)' },
                        ]}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
