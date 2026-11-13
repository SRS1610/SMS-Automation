import {
  CircleCheck,
  CircleX,
  Gauge,
  Globe,
  MessageSquareText,
  Pencil,
  PlugZap,
  Plus,
  Search,
  Send,
  Trash2,
  UserX,
  Webhook,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { countryName, flagEmoji } from '../../../shared/phone';
import { analyzeSms } from '../../../shared/sms';
import type { ProviderSummary, ProviderTypeInfo, Settings } from '../../../shared/types';
import { api, ApiError } from '../api';
import { CountrySelect } from '../components/CountryPicker';
import { useToast } from '../components/Toast';
import {
  Alert,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Field,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  Toggle,
} from '../components/ui';
import { fmtDateTime, fmtInt, fmtPhone, fmtRelative, plural } from '../format';
import { notifyGatewaysChanged, useDebounced, useResource } from '../hooks';
import { GatewayForm } from './GatewayForm';
import { senderProblem } from './Send';

const TABS = [
  { id: 'gateways', label: 'Gateways', icon: PlugZap },
  { id: 'general', label: 'General', icon: Globe },
  { id: 'opt-outs', label: 'Opt-out list', icon: UserX },
];

export function SettingsPage({ tab }: { tab: string }) {
  const current = TABS.some((t) => t.id === tab) ? tab : 'gateways';
  return (
    <>
      <PageHeader title="Settings" subtitle="Connect SMS gateways and choose how messages are sent" />
      <nav className="tabs" aria-label="Settings sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <a key={id} href={`#/settings/${id}`} className={current === id ? 'active' : undefined} aria-current={current === id ? 'page' : undefined}>
            <Icon size={15} aria-hidden /> {label}
          </a>
        ))}
      </nav>
      {current === 'gateways' && <GatewaysTab />}
      {current === 'general' && <GeneralTab />}
      {current === 'opt-outs' && <OptOutTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

interface GatewayData {
  providers: ProviderSummary[];
  types: ProviderTypeInfo[];
  settings: Settings;
}

function webhookUrl(settings: Settings, provider: ProviderSummary): string {
  return `${settings.publicBaseUrl || window.location.origin}${provider.webhookPath}`;
}

function Coverage({ countries }: { countries: string[] }) {
  if (!countries.length) return <span>All countries</span>;
  const shown = countries.slice(0, 6);
  return (
    <span title={countries.map(countryName).join(', ')}>
      {shown.map((c) => (
        <span key={c} aria-label={countryName(c)} style={{ marginRight: 3 }}>
          {flagEmoji(c)}
        </span>
      ))}
      {countries.length > shown.length && <span className="muted">+{countries.length - shown.length}</span>}
      {countries.length === 1 && <span style={{ marginLeft: 4 }}>{countryName(countries[0])}</span>}
    </span>
  );
}

function GatewayCard({ provider, type, settings, testing, onTest, onToggle, onEdit, onDelete, onSendTest }: {
  provider: ProviderSummary;
  type: ProviderTypeInfo | undefined;
  settings: Settings;
  testing: boolean;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onSendTest: () => void;
}) {
  const reports = type?.deliveryReports ?? 'none';
  return (
    <div className="card gateway-card">
      <div className="gateway-head">
        <div className="gateway-logo" aria-hidden>
          {(type?.label ?? provider.type).slice(0, 1)}
        </div>
        <div className="gateway-title">
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="name">{provider.name}</span>
            {!provider.enabled && <span className="badge">Disabled</span>}
          </div>
          <div className="secondary small">{type?.label ?? provider.type}</div>
        </div>
        <Toggle checked={provider.enabled} onChange={onToggle} label={<span className="sr-only">Enable {provider.name}</span>} />
      </div>

      <div className="gateway-meta">
        <span>
          <Globe size={14} aria-hidden /> <Coverage countries={provider.countries} />
        </span>
        <span title="Priority (lower is tried first)">Priority {provider.priority}</span>
        <span>
          <Gauge size={14} aria-hidden /> {provider.rateLimit} msg/s
        </span>
        <span>
          <MessageSquareText size={14} aria-hidden /> Sender {provider.defaultSender ?? <span className="muted">not set</span>}
        </span>
        {provider.lastTest && (
          <span title={`${provider.lastTest.message} · ${fmtDateTime(provider.lastTest.at)}`} style={{ minWidth: 0 }}>
            {provider.lastTest.ok ? <CircleCheck size={14} color="var(--good)" aria-hidden /> : <CircleX size={14} color="var(--critical)" aria-hidden />}
            <span>
              {provider.lastTest.ok ? 'Connected' : 'Connection failed'} · tested {fmtRelative(provider.lastTest.at)}
            </span>
          </span>
        )}
      </div>
      {provider.lastTest && !provider.lastTest.ok && (
        <div style={{ marginTop: 10 }}>
          <Alert tone="critical">{provider.lastTest.message}</Alert>
        </div>
      )}

      {(reports === 'auto' || reports === 'manual') && (
        <>
          <div className="webhook-box">
            <Webhook size={14} className="muted" aria-hidden />
            <code title={webhookUrl(settings, provider)}>{webhookUrl(settings, provider)}</code>
            <CopyButton value={webhookUrl(settings, provider)} />
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            {reports === 'auto'
              ? settings.publicBaseUrl
                ? 'Delivery receipts: this URL is sent with every message automatically.'
                : 'Delivery receipts: set a public URL under General so the gateway can reach this server.'
              : type?.webhookHelp}
          </div>
        </>
      )}

      <div className="gateway-actions">
        <button className="btn sm" onClick={onTest} disabled={testing}>
          {testing ? <Spinner size={13} /> : <PlugZap size={13} />} Test connection
        </button>
        <button className="btn sm" onClick={onSendTest} disabled={!provider.enabled}>
          <Send size={13} /> Send test SMS
        </button>
        <button className="btn sm" onClick={onEdit}>
          <Pencil size={13} /> Edit
        </button>
        <button className="btn sm ghost danger" onClick={onDelete} style={{ marginLeft: 'auto' }}>
          <Trash2 size={13} /> Remove
        </button>
      </div>
    </div>
  );
}

function TypePicker({ types, onPick, onClose }: { types: ProviderTypeInfo[]; onPick: (t: ProviderTypeInfo) => void; onClose: () => void }) {
  return (
    <Modal wide title="Add an SMS gateway" subtitle="Pick your provider. You can connect several and route countries between them." onClose={onClose}>
      <div className="type-grid">
        {types.map((t) => (
          <button key={t.type} className="type-card" onClick={() => onPick(t)}>
            <span className="label">
              <span className="gateway-logo" style={{ width: 26, height: 26, fontSize: 12 }} aria-hidden>
                {t.label.slice(0, 1)}
              </span>
              {t.label}
            </span>
            <span className="desc">{t.description}</span>
            <span className="coverage">{t.coverage}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function SendTestModal({ provider, settings, onClose }: { provider: ProviderSummary; settings: Settings; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [text, setText] = useState('Test message from SMS Automation. If you can read this, your gateway works.');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <Modal
      title={`Send a test SMS with ${provider.name}`}
      subtitle={provider.type === 'sandbox' ? 'Sandbox: nothing is actually sent.' : 'This sends one real SMS and may be charged by your gateway.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            disabled={busy || !to.trim() || !text.trim()}
            onClick={async () => {
              setBusy(true);
              setResult(null);
              try {
                setResult(await api.sendTestSms(provider.id, { to, text, from: from.trim() || undefined }));
              } catch (err) {
                setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Request failed' });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner size={14} /> : <Send size={14} />} Send test
          </button>
        </>
      }
    >
      <div className="stack">
        {result && <Alert tone={result.ok ? 'good' : 'critical'}>{result.message}</Alert>}
        <Field label="To" htmlFor="test-to" required help={`Include the country code, or it’s read as ${countryName(settings.defaultCountry)}.`}>
          <input id="test-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+14155552671" />
        </Field>
        <Field label="From" htmlFor="test-from" help="Optional. Defaults to the gateway’s sender ID.">
          <input id="test-from" className="input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={provider.defaultSender ?? settings.defaultSender ?? ''} />
        </Field>
        <Field label="Message" htmlFor="test-text" required>
          <textarea id="test-text" className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function GatewaysTab() {
  const toast = useToast();
  const data = useResource<GatewayData>(async () => {
    const [providers, types, settings] = await Promise.all([api.providers(), api.providerTypes(), api.settings()]);
    notifyGatewaysChanged();
    return { providers, types, settings };
  }, []);
  const [picking, setPicking] = useState(false);
  const [formType, setFormType] = useState<ProviderTypeInfo | null>(null);
  const [editing, setEditing] = useState<ProviderSummary | null>(null);
  const [deleting, setDeleting] = useState<ProviderSummary | null>(null);
  const [testSms, setTestSms] = useState<ProviderSummary | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const typeMap = useMemo(() => new Map((data.data?.types ?? []).map((t) => [t.type, t])), [data.data]);

  if (data.loading && !data.data) return <Loading />;
  if (data.error && !data.data) return <Alert tone="critical">Could not load gateways: {data.error.message}</Alert>;
  const { providers, types, settings } = data.data!;

  async function test(provider: ProviderSummary, justCreated = false) {
    setTesting((s) => new Set(s).add(provider.id));
    try {
      const result = await api.testProvider(provider.id);
      if (result.ok) toast.success(justCreated ? `${provider.name} connected. ${result.message}` : `${provider.name}: ${result.message}`);
      else toast.error(justCreated ? `${provider.name} was saved, but the connection test failed: ${result.message}` : `${provider.name}: ${result.message}`);
      await data.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Test failed');
    } finally {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(provider.id);
        return next;
      });
    }
  }

  async function toggle(provider: ProviderSummary, enabled: boolean) {
    try {
      await api.setProviderEnabled(provider.id, enabled);
      toast.success(`${provider.name} ${enabled ? 'enabled' : 'disabled'}`);
      await data.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the gateway');
    }
  }

  const needsPublicUrl = !settings.publicBaseUrl && providers.some((p) => typeMap.get(p.type)?.deliveryReports === 'auto');

  return (
    <div className="stack">
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <p className="secondary" style={{ maxWidth: 640 }}>
          Messages are routed by destination country. Gateways limited to specific countries are tried before catch-all ones, then by priority. If a gateway
          rejects a message, the next one in line is tried.
        </p>
        <button className="btn primary" onClick={() => setPicking(true)}>
          <Plus size={16} /> Add gateway
        </button>
      </div>

      {needsPublicUrl && (
        <Alert
          tone="info"
          title="Delivery receipts are off"
          action={
            <a className="btn sm" href="#/settings/general">
              Set public URL
            </a>
          }
        >
          Gateways can only report “delivered” or “failed” back if they can reach this server. Set its public URL in General.
        </Alert>
      )}

      {providers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PlugZap size={20} />}
            title="No gateways connected"
            action={
              <div className="row wrap" style={{ justifyContent: 'center' }}>
                <button className="btn primary" onClick={() => setPicking(true)}>
                  <Plus size={16} /> Add gateway
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    const sandbox = types.find((t) => t.type === 'sandbox');
                    if (sandbox) setFormType(sandbox);
                  }}
                >
                  Try the sandbox
                </button>
              </div>
            }
          >
            Connect Twilio, Vonage, Plivo, Sinch, Telnyx, Infobip, ClickSend, Africa’s Talking or any HTTP API. Credentials are encrypted at rest.
          </EmptyState>
        </Card>
      ) : (
        <div className="gateway-list">
          {providers.map((p) => (
            <GatewayCard
              key={p.id}
              provider={p}
              type={typeMap.get(p.type)}
              settings={settings}
              testing={testing.has(p.id)}
              onTest={() => test(p)}
              onToggle={(enabled) => toggle(p, enabled)}
              onEdit={() => setEditing(p)}
              onDelete={() => setDeleting(p)}
              onSendTest={() => setTestSms(p)}
            />
          ))}
        </div>
      )}

      {picking && (
        <TypePicker
          types={types}
          onClose={() => setPicking(false)}
          onPick={(t) => {
            setPicking(false);
            setFormType(t);
          }}
        />
      )}
      {(formType || editing) && (
        <GatewayForm
          type={editing ? typeMap.get(editing.type)! : formType!}
          existing={editing}
          onClose={() => {
            setFormType(null);
            setEditing(null);
          }}
          onBack={
            editing
              ? undefined
              : () => {
                  setFormType(null);
                  setPicking(true);
                }
          }
          onSaved={async (saved, created) => {
            setFormType(null);
            setEditing(null);
            await data.reload();
            if (created) void test(saved, true);
            else toast.success(`${saved.name} saved`);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Remove ${deleting.name}?`}
          confirmLabel="Remove gateway"
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.deleteProvider(deleting.id);
              toast.success(`${deleting.name} removed`);
              await data.reload();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not remove');
            } finally {
              setBusy(false);
              setDeleting(null);
            }
          }}
        >
          Its stored credentials are deleted. Campaigns locked to this gateway pause until you resume them; automatically routed messages move to other gateways.
        </ConfirmDialog>
      )}
      {testSms && <SendTestModal provider={testSms} settings={settings} onClose={() => setTestSms(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralTab() {
  const settings = useResource(() => api.settings(), []);
  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error && !settings.data) return <Alert tone="critical">Could not load settings: {settings.error.message}</Alert>;
  return <GeneralForm initial={settings.data!} onSaved={settings.setData} />;
}

function GeneralForm({ initial, onSaved }: { initial: Settings; onSaved: (s: Settings) => void }) {
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((f) => ({ ...f, [key]: value }));

  const senderError = senderProblem(form.defaultSender);
  const footerInfo = form.optOutFooter.trim() ? analyzeSms(`\n${form.optOutFooter.trim()}`) : null;
  const localUrl = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(form.publicBaseUrl);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const saved = await api.updateSettings(form);
          onSaved(saved);
          setForm(saved);
          toast.success('Settings saved');
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Could not save');
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="critical">{error}</Alert>
        </div>
      )}
      <Card title="Sending defaults">
        <div className="grid-2">
          <Field label="Default country" htmlFor="set-country" help="Used for numbers written without a country code. Each campaign can override it.">
            <CountrySelect id="set-country" value={form.defaultCountry} onChange={(v) => set('defaultCountry', v)} />
          </Field>
          <Field
            label="Default sender ID"
            htmlFor="set-sender"
            error={senderError}
            help="Used when neither the campaign nor the gateway sets one."
          >
            <input id="set-sender" className="input" value={form.defaultSender} onChange={(e) => set('defaultSender', e.target.value)} maxLength={16} placeholder="e.g. ACME" />
          </Field>
          <Field
            label="Attempts per message"
            htmlFor="set-attempts"
            help="Temporary failures (timeouts, throttling) are retried with increasing delays, moving to the next gateway when one is available."
          >
            <input
              id="set-attempts"
              className="input"
              type="number"
              min={1}
              max={10}
              value={form.maxAttempts}
              onChange={(e) => set('maxAttempts', Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            />
          </Field>
        </div>
      </Card>

      <Card title="Opt-out footer" hint="Many countries require a way to opt out of marketing SMS">
        <Field
          htmlFor="set-footer"
          help={
            footerInfo
              ? `Added on a new line to every campaign message. Adds ${footerInfo.units} characters, which can push messages into an extra segment.`
              : 'Leave empty to add nothing. Example: “Reply STOP to opt out”.'
          }
        >
          <input id="set-footer" className="input" value={form.optOutFooter} onChange={(e) => set('optOutFooter', e.target.value)} maxLength={160} placeholder="Reply STOP to opt out" />
        </Field>
      </Card>

      <Card title="Delivery receipts" hint="Lets gateways report back whether each SMS reached the handset">
        <div className="stack">
          <Field
            label="Public URL of this dashboard"
            htmlFor="set-url"
            help="Gateways post receipts to this address, so it must be reachable from the internet (not localhost). Each gateway’s exact webhook URL is shown on its card."
          >
            <div className="input-group">
              <input id="set-url" className="input" value={form.publicBaseUrl} onChange={(e) => set('publicBaseUrl', e.target.value)} placeholder="https://sms.example.com" />
              <button type="button" className="btn" onClick={() => set('publicBaseUrl', window.location.origin)}>
                Use this address
              </button>
            </div>
          </Field>
          {localUrl && (
            <Alert tone="warning">
              This looks like a local address that gateways can’t reach. Use your server’s public domain, or a tunnel such as ngrok or Cloudflare Tunnel during
              development.
            </Alert>
          )}
        </div>
      </Card>

      <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        {dirty && (
          <button type="button" className="btn ghost" onClick={() => setForm(initial)} disabled={busy}>
            Discard changes
          </button>
        )}
        <button className="btn primary" disabled={busy || !dirty || !!senderError}>
          {busy && <Spinner size={14} />} Save settings
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Opt-out list
// ---------------------------------------------------------------------------

const OPT_LIMIT = 50;

function OptOutTab() {
  const toast = useToast();
  const [numbers, setNumbers] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{ added: number; existing: number; invalid: string[] } | null>(null);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search, 250);
  const list = useResource(() => api.suppressions({ search: debounced || undefined, limit: OPT_LIMIT, offset }), [debounced, offset]);

  const pending = numbers.split(/[\n,;]+/).map((n) => n.trim()).filter(Boolean);

  return (
    <div className="stack">
      <Card title="Add numbers" hint="These numbers are skipped by every campaign, including ones already running">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = await api.addSuppressions(pending, reason.trim() || undefined);
              setLastResult(result);
              if (result.added) toast.success(`${plural(result.added, 'number')} added to the opt-out list`);
              setNumbers('');
              setOffset(0);
              await list.reload();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not add numbers');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid-2">
            <Field label="Phone numbers" htmlFor="opt-numbers" help="One per line or comma-separated. Numbers without a country code use your default country.">
              <textarea id="opt-numbers" className="textarea mono" rows={4} value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder={'+14155552671\n+447400123456'} />
            </Field>
            <Field label="Reason" htmlFor="opt-reason" help="Optional, for your records.">
              <input id="opt-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Replied STOP" maxLength={200} />
            </Field>
          </div>
          {lastResult && (lastResult.existing > 0 || lastResult.invalid.length > 0) && (
            <Alert tone={lastResult.invalid.length ? 'warning' : 'info'}>
              {lastResult.existing > 0 && `${plural(lastResult.existing, 'number was', 'numbers were')} already on the list. `}
              {lastResult.invalid.length > 0 && `Couldn’t read: ${lastResult.invalid.slice(0, 10).join(', ')}${lastResult.invalid.length > 10 ? '…' : ''}`}
            </Alert>
          )}
          <div>
            <button className="btn primary" disabled={busy || pending.length === 0}>
              {busy ? <Spinner size={14} /> : <Plus size={15} />} Add {pending.length ? plural(pending.length, 'number') : 'numbers'}
            </button>
          </div>
        </form>
      </Card>

      <Card
        title={`Opted-out numbers${list.data ? ` (${fmtInt(list.data.total)})` : ''}`}
        bodyClassName=""
        actions={
          <div style={{ position: 'relative', width: 220 }}>
            <Search size={15} className="muted" style={{ position: 'absolute', left: 10, top: 10 }} aria-hidden />
            <input
              className="input"
              style={{ paddingLeft: 32 }}
              placeholder="Search"
              aria-label="Search opted-out numbers"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </div>
        }
      >
        {!list.data ? (
          <Loading />
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={<UserX size={20} />} title={debounced ? 'No matching numbers' : 'Nobody has opted out'}>
            {debounced ? 'Try a different search.' : 'Add numbers above when customers ask not to be contacted.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Reason</th>
                    <th>Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((s) => (
                    <tr key={s.number}>
                      <td className="tabular nowrap">{fmtPhone(s.number)}</td>
                      <td className="secondary">{s.reason ?? '—'}</td>
                      <td className="secondary nowrap">{fmtDateTime(s.createdAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn sm ghost danger"
                          onClick={async () => {
                            try {
                              await api.removeSuppression(s.number);
                              toast.success(`${fmtPhone(s.number)} can receive messages again`);
                              await list.reload();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Could not remove');
                            }
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination offset={offset} limit={OPT_LIMIT} total={list.data.total} onChange={setOffset} />
          </>
        )}
      </Card>
    </div>
  );
}
