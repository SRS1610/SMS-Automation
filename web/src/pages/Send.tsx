import {
  ArrowRight,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  FileSpreadsheet,
  PlugZap,
  Send as SendIcon,
  Smartphone,
  Upload,
  Wand,
  X,
} from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { buildRecipients, countryName, flagEmoji, type Recipient } from '../../../shared/phone';
import { providersForCountry } from '../../../shared/routing';
import { analyzeSms, hasGsmReplacements, toGsmFriendly } from '../../../shared/sms';
import { renderTemplate, templateVariables } from '../../../shared/template';
import type { ProviderSummary, ProviderTypeInfo, Settings } from '../../../shared/types';
import { api, ApiError } from '../api';
import { CountrySelect } from '../components/CountryPicker';
import { useToast } from '../components/Toast';
import { Alert, Card, ConfirmDialog, Field, Loading, Modal, PageHeader, Spinner } from '../components/ui';
import { fmtDateTime, fmtInt, fmtPhone, plural } from '../format';
import { navigate, useResource } from '../hooks';
import { parseCsvFile, parsePasted, tableToInputs, variableNames, type ParsedTable } from '../recipients';

const MAX_CHARS = 1600;

/** Alphanumeric IDs: 1–11 letters/digits/spaces with at least one letter. Numeric: up to 15 digits. */
export function senderProblem(sender: string): string | null {
  const s = sender.trim();
  if (!s) return null;
  if (/^\+?\d{3,15}$/.test(s)) return null;
  if (!/^[A-Za-z0-9 .&-]+$/.test(s)) return 'Sender IDs may only use letters, digits, spaces and . & -';
  if (s.length > 11) return 'Alphanumeric sender IDs are limited to 11 characters';
  if (!/[A-Za-z]/.test(s)) return 'Use a phone number or include at least one letter';
  return null;
}

function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

function RecipientSummary({ valid, invalid, duplicates, onShowInvalid }: {
  valid: Recipient[];
  invalid: number;
  duplicates: number;
  onShowInvalid: () => void;
}) {
  const byCountry = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of valid) counts.set(r.country ?? '??', (counts.get(r.country ?? '??') ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [valid]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="badge good">
          <span className="dot" aria-hidden />
          {plural(valid.length, 'valid number')}
        </span>
        {invalid > 0 && (
          <button type="button" className="badge critical" style={{ border: 0, cursor: 'pointer' }} onClick={onShowInvalid}>
            <span className="dot" aria-hidden />
            {fmtInt(invalid)} invalid · review
          </button>
        )}
        {duplicates > 0 && <span className="badge">{plural(duplicates, 'duplicate')} removed</span>}
      </div>
      {byCountry.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {byCountry.slice(0, 10).map(([code, n]) => (
            <span className="chip" key={code} title={code === '??' ? 'Unknown country' : countryName(code)}>
              <span aria-hidden>{code === '??' ? '🌐' : flagEmoji(code)}</span>
              {code === '??' ? 'Other' : code}
              <span className="muted tabular">{fmtInt(n)}</span>
            </span>
          ))}
          {byCountry.length > 10 && <span className="chip muted">+{byCountry.length - 10} more countries</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phone preview
// ---------------------------------------------------------------------------

function PhonePreview({ sender, text, recipient, index, count, onMove }: {
  sender: string;
  text: string;
  recipient: Recipient | undefined;
  index: number;
  count: number;
  onMove: (delta: number) => void;
}) {
  const info = analyzeSms(text);
  return (
    <div>
      <div className="phone" aria-label="Message preview">
        <div className="phone-top">
          <span className="phone-avatar" aria-hidden>
            <Smartphone size={16} />
          </span>
          <span className="phone-sender">{sender || 'Gateway default sender'}</span>
        </div>
        <div className={`bubble ${text ? '' : 'empty'}`}>{text || 'Your message will appear here'}</div>
        <div className="phone-meta">
          <span>{recipient ? `To ${fmtPhone(recipient.phone)}` : 'No recipient yet'}</span>
          {text && <span>{plural(info.segments, 'segment')}</span>}
        </div>
      </div>
      {count > 1 && (
        <div className="spread" style={{ marginTop: 10 }}>
          <button className="icon-btn" aria-label="Previous recipient" onClick={() => onMove(-1)} disabled={index === 0}>
            <ChevronLeft size={16} />
          </button>
          <span className="muted small tabular">
            Recipient {fmtInt(index + 1)} of {fmtInt(count)}
          </span>
          <button className="icon-btn" aria-label="Next recipient" onClick={() => onMove(1)} disabled={index >= count - 1}>
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface Loaded {
  settings: Settings;
  providers: ProviderSummary[];
  types: ProviderTypeInfo[];
}

export function SendPage() {
  const loaded = useResource<Loaded>(async () => {
    const [settings, providers, types] = await Promise.all([api.settings(), api.providers(), api.providerTypes()]);
    return { settings, providers, types };
  }, []);

  if (loaded.loading && !loaded.data) return <Loading />;
  if (loaded.error && !loaded.data) return <Alert tone="critical">Could not load: {loaded.error.message}</Alert>;
  return <Composer {...loaded.data!} />;
}

function Composer({ settings, providers, types }: Loaded) {
  const toast = useToast();
  const enabled = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const typeInfo = useMemo(() => new Map(types.map((t) => [t.type, t])), [types]);

  // recipients
  const [source, setSource] = useState<'paste' | 'csv'>('paste');
  const [pasteText, setPasteText] = useState('');
  const [csv, setCsv] = useState<(ParsedTable & { fileName: string }) | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [defaultCountry, setDefaultCountry] = useState(settings.defaultCountry);
  const [showInvalid, setShowInvalid] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // message
  const [body, setBody] = useState('');
  const [sender, setSender] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  // delivery
  const [providerId, setProviderId] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduleAt, setScheduleAt] = useState(() => localInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [name, setName] = useState('');
  const [previewIndex, setPreviewIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const pasted = useMemo(() => parsePasted(pasteText), [pasteText]);
  const table = source === 'csv' ? csv : pasted;
  const inputs = useMemo(() => (table ? tableToInputs(table) : []), [table]);
  const deferredInputs = useDeferredValue(inputs);
  const list = useMemo(() => buildRecipients(deferredInputs, defaultCountry), [deferredInputs, defaultCountry]);
  const variables = useMemo(() => (table ? variableNames(table) : []), [table]);

  const template = useMemo(() => {
    const trimmed = body.trim();
    if (!trimmed) return '';
    return settings.optOutFooter && !trimmed.includes(settings.optOutFooter) ? `${trimmed}\n${settings.optOutFooter}` : trimmed;
  }, [body, settings.optOutFooter]);
  const deferredTemplate = useDeferredValue(template);

  const index = Math.min(previewIndex, Math.max(0, list.valid.length - 1));
  const previewRecipient = list.valid[index];
  const previewText = renderTemplate(template, previewRecipient?.vars ?? {});
  const previewInfo = analyzeSms(previewText);
  const draftInfo = analyzeSms(body.trim() ? renderTemplate(body, previewRecipient?.vars ?? {}) : '');

  const segments = useMemo(() => {
    if (!deferredTemplate || !list.valid.length) return { total: 0, min: 0, max: 0 };
    let total = 0;
    let min = Infinity;
    let max = 0;
    for (const r of list.valid) {
      const n = analyzeSms(renderTemplate(deferredTemplate, r.vars)).segments;
      total += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    return { total, min, max };
  }, [deferredTemplate, list.valid]);

  const unknownVariables = templateVariables(body).filter((v) => !variables.includes(v));

  // routing preview
  const fixedProvider = providerId ? providers.find((p) => p.id === providerId) : undefined;
  const routes = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const r of list.valid) counts.set(r.country, (counts.get(r.country) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([country, count]) => ({ country, count, candidates: providersForCountry(enabled, country) }));
  }, [list.valid, enabled]);
  const uncovered = providerId ? [] : routes.filter((r) => r.candidates.length === 0);
  const usedProviders = fixedProvider ? [fixedProvider] : Array.from(new Set(routes.flatMap((r) => r.candidates.slice(0, 1))));
  const needsSender = usedProviders.filter((p) => typeInfo.get(p.type)?.senderRequired && !sender.trim() && !p.defaultSender && !settings.defaultSender);
  const allSandbox = usedProviders.length > 0 && usedProviders.every((p) => p.type === 'sandbox');

  const scheduledDate = when === 'later' ? new Date(scheduleAt) : null;
  const scheduleError =
    when === 'later' && (!scheduledDate || Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now()) ? 'Pick a time in the future' : null;
  const senderError = senderProblem(sender);
  const defaultName = `Campaign ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  const blocker =
    enabled.length === 0
      ? 'Add a gateway in Settings first'
      : list.valid.length === 0
        ? 'Add at least one valid recipient'
        : !body.trim()
          ? 'Write your message'
          : template.length > MAX_CHARS
            ? `Message is longer than ${MAX_CHARS} characters`
            : senderError
              ? 'Fix the sender ID'
              : needsSender.length
                ? 'A sender ID is required'
                : scheduleError
                  ? scheduleError
                  : null;

  useEffect(() => setPreviewIndex(0), [deferredInputs]);

  async function loadFile(file: File) {
    setCsvError(null);
    if (file.size > 30 * 1024 * 1024) {
      setCsvError('That file is larger than 30 MB. Split it into smaller campaigns.');
      return;
    }
    try {
      const parsed = await parseCsvFile(file);
      if (!parsed.rows.length) {
        setCsvError('No rows found in that file.');
        return;
      }
      setCsv({ ...parsed, fileName: file.name });
    } catch (err) {
      setCsvError(`Could not read the file: ${(err as Error).message}`);
    }
  }

  function insertVariable(variable: string) {
    const token = `{{${variable}}}`;
    const el = textarea.current;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function submit() {
    setBusy(true);
    try {
      const result = await api.createCampaign({
        name: name.trim() || defaultName,
        body: body.trim(),
        sender: sender.trim() || null,
        providerId: providerId || null,
        scheduledAt: when === 'later' && scheduledDate ? scheduledDate.toISOString() : null,
        defaultCountry,
        recipients: list.valid.map((r) => ({ phone: r.phone, vars: r.vars })),
      });
      const skipped = result.suppressed ? ` ${plural(result.suppressed, 'number')} on the opt-out list will be skipped.` : '';
      toast.success(
        result.campaign.status === 'scheduled'
          ? `Scheduled for ${fmtDateTime(result.campaign.scheduledAt)}.${skipped}`
          : `Sending to ${plural(result.accepted, 'recipient')}.${skipped}`,
      );
      navigate(`/campaigns/${result.campaign.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the campaign');
      setBusy(false);
      setConfirming(false);
    }
  }

  const recipientsLabel = `${fmtInt(list.valid.length)} recipient${list.valid.length === 1 ? '' : 's'}`;
  const sendLabel = when === 'later' ? `Schedule for ${recipientsLabel}` : `Send to ${recipientsLabel}`;

  return (
    <>
      <PageHeader title="Send SMS" subtitle="Send one message to many customers, in any country. Each recipient gets their own SMS." />

      {enabled.length === 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert
            tone="warning"
            title="No SMS gateway is connected"
            action={
              <a className="btn sm" href="#/settings/gateways">
                <PlugZap size={14} /> Add gateway
              </a>
            }
          >
            You can prepare a campaign, but you need at least one enabled gateway to send it.
          </Alert>
        </div>
      )}

      <div className="compose">
        <div>
          {/* 1. Recipients ------------------------------------------------ */}
          <Card
            title={
              <span className="step-title">
                <span className="step-num">1</span>Recipients
              </span>
            }
          >
            <div className="stack">
              <div className="segmented" role="tablist" aria-label="Recipient source">
                <button role="tab" aria-selected={source === 'paste'} className={source === 'paste' ? 'active' : ''} onClick={() => setSource('paste')}>
                  <ClipboardPaste size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                  Paste numbers
                </button>
                <button role="tab" aria-selected={source === 'csv'} className={source === 'csv' ? 'active' : ''} onClick={() => setSource('csv')}>
                  <FileSpreadsheet size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                  Upload CSV
                </button>
              </div>

              {source === 'paste' ? (
                <Field
                  htmlFor="paste"
                  help="One number per line, or comma-separated. To personalise, paste CSV with a header row such as phone,name,code."
                >
                  <textarea
                    id="paste"
                    className="textarea mono"
                    rows={7}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder={'+14155552671\n+447400123456\n+919876543210\n\n…or\n\nphone,name\n+14155552671,Ada'}
                    spellCheck={false}
                  />
                </Field>
              ) : csv ? (
                <div className="stack" style={{ gap: 12 }}>
                  <div className="spread" style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <span className="row" style={{ minWidth: 0 }}>
                      <FileSpreadsheet size={18} className="secondary" />
                      <span style={{ fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{csv.fileName}</span>
                      <span className="muted small nowrap">{plural(csv.rows.length, 'row')}</span>
                    </span>
                    <button className="icon-btn" aria-label="Remove file" onClick={() => setCsv(null)}>
                      <X size={16} />
                    </button>
                  </div>
                  {csv.headers.length > 0 && (
                    <Field label="Phone number column" htmlFor="phone-col">
                      <select
                        id="phone-col"
                        className="select"
                        value={csv.phoneColumn}
                        onChange={(e) => setCsv({ ...csv, phoneColumn: Number(e.target.value) })}
                      >
                        {csv.headers.map((h, i) => (
                          <option key={i} value={i}>
                            {h || `Column ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              ) : (
                <div
                  className={`dropzone ${dragOver ? 'over' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file) void loadFile(file);
                  }}
                >
                  <Upload size={22} />
                  <strong style={{ color: 'var(--ink)' }}>Drop a CSV file here, or click to choose</strong>
                  <span className="small">Include a header row. Every column becomes a variable you can use in the message.</span>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void loadFile(file);
                      e.target.value = '';
                    }}
                  />
                </div>
              )}
              {csvError && source === 'csv' && <Alert tone="critical">{csvError}</Alert>}

              <Field
                label="Country for numbers without a country code"
                htmlFor="default-country"
                help="Numbers that start with + or 00 keep their own country."
              >
                <CountrySelect id="default-country" value={defaultCountry} onChange={setDefaultCountry} />
              </Field>

              {inputs.length > 0 && (
                <RecipientSummary valid={list.valid} invalid={list.invalid.length} duplicates={list.duplicates} onShowInvalid={() => setShowInvalid(true)} />
              )}
            </div>
          </Card>

          {/* 2. Message ------------------------------------------------- */}
          <Card
            title={
              <span className="step-title">
                <span className="step-num">2</span>Message
              </span>
            }
          >
            <div className="stack">
              <Field
                label="Sender ID"
                htmlFor="sender"
                error={senderError}
                help={
                  <>
                    A phone number, or up to 11 letters and digits (alphanumeric IDs aren’t allowed in some countries, such as the US and Canada).{' '}
                    {settings.defaultSender ? `Leave blank to use ${settings.defaultSender}.` : 'Leave blank to use the gateway’s default.'}
                  </>
                }
              >
                <input
                  id="sender"
                  className="input"
                  value={sender}
                  onChange={(e) => setSender(e.target.value)}
                  placeholder={settings.defaultSender || 'e.g. ACME or +14155550100'}
                  maxLength={16}
                />
              </Field>

              <Field label="Message" htmlFor="body" required>
                {variables.length > 0 && (
                  <div className="var-chips" style={{ marginBottom: 2 }}>
                    <span className="muted small">Insert:</span>
                    {variables.map((v) => (
                      <button type="button" key={v} className="var-chip" onClick={() => insertVariable(v)}>
                        {`{{${v}}}`}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  id="body"
                  ref={textarea}
                  className="textarea"
                  rows={6}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={variables.length ? `Hi {{${variables.find((v) => v !== 'phone') ?? variables[0]}}}, …` : 'Hi there, your order has shipped…'}
                  maxLength={MAX_CHARS}
                />
                <div className="counter">
                  <span>
                    <strong>{fmtInt(draftInfo.characters)}</strong> characters · <strong>{draftInfo.segments}</strong>{' '}
                    {draftInfo.segments === 1 ? 'segment' : 'segments'} · {draftInfo.encoding}
                  </span>
                  {draftInfo.characters > 0 && (
                    <span className="tabular">{fmtInt(draftInfo.remaining)} characters left in this segment</span>
                  )}
                </div>
              </Field>

              {draftInfo.encoding === 'UCS-2' && (
                <Alert
                  tone="warning"
                  title="This message uses Unicode"
                  action={
                    hasGsmReplacements(body) ? (
                      <button className="btn sm" onClick={() => setBody(toGsmFriendly(body))}>
                        <Wand size={14} /> Use plain characters
                      </button>
                    ) : undefined
                  }
                >
                  {draftInfo.nonGsmCharacters.slice(0, 8).map((c) => (c.trim() ? c : '␣')).join(' ')} {draftInfo.nonGsmCharacters.length > 8 ? '…' : ''} switch the
                  whole message to Unicode, which fits 70 characters per segment instead of 160. Non-Latin scripts and emoji always need Unicode.
                </Alert>
              )}
              {unknownVariables.length > 0 && (
                <Alert tone="warning">
                  {unknownVariables.map((v) => `{{${v}}}`).join(', ')} {unknownVariables.length === 1 ? 'isn’t a column' : 'aren’t columns'} in your recipient list,
                  so {unknownVariables.length === 1 ? 'it' : 'they'} will be blank. Add a fallback like {'{{name|there}}'}.
                </Alert>
              )}
              {settings.optOutFooter && (
                <div className="muted small">
                  Footer added to every message: <span className="secondary">“{settings.optOutFooter}”</span> ·{' '}
                  <a href="#/settings/general">Change</a>
                </div>
              )}
            </div>
          </Card>

          {/* 3. Delivery ---------------------------------------------------- */}
          <Card
            title={
              <span className="step-title">
                <span className="step-num">3</span>Delivery
              </span>
            }
          >
            <div className="stack">
              <Field label="Gateway" htmlFor="gateway">
                <select id="gateway" className="select" value={providerId} onChange={(e) => setProviderId(e.target.value)} disabled={enabled.length === 0}>
                  <option value="">Automatic routing by destination country</option>
                  {enabled.map((p) => (
                    <option key={p.id} value={p.id}>
                      Only {p.name}
                    </option>
                  ))}
                </select>
              </Field>

              {!providerId && routes.length > 0 && enabled.length > 0 && (
                <div>
                  <div className="field-label">Routing</div>
                  <div className="route-list">
                    {routes.slice(0, 8).map((r) => (
                      <div className="route-row" key={r.country ?? 'unknown'}>
                        <span aria-hidden>{r.country ? flagEmoji(r.country) : '🌐'}</span>
                        <span style={{ minWidth: 0 }}>{r.country ? countryName(r.country) : 'Unknown country'}</span>
                        <span className="muted tabular small">{fmtInt(r.count)}</span>
                        <ArrowRight size={13} className="arrow" />
                        {r.candidates.length ? (
                          <span>
                            {r.candidates[0].name}
                            {r.candidates.length > 1 && <span className="muted small"> · then {r.candidates.slice(1).map((c) => c.name).join(', ')}</span>}
                          </span>
                        ) : (
                          <span className="badge critical">
                            <span className="dot" aria-hidden />
                            No gateway
                          </span>
                        )}
                      </div>
                    ))}
                    {routes.length > 8 && <div className="muted small">+{routes.length - 8} more countries</div>}
                  </div>
                </div>
              )}
              {uncovered.length > 0 && (
                <Alert tone="critical" title="Some destinations have no gateway">
                  {uncovered.map((r) => `${r.country ? countryName(r.country) : 'Unknown'} (${fmtInt(r.count)})`).join(', ')}. Those messages will fail
                  unless you add a gateway that covers them in Settings.
                </Alert>
              )}
              {needsSender.length > 0 && (
                <Alert tone="warning">
                  {needsSender.map((p) => p.name).join(', ')} {needsSender.length === 1 ? 'needs' : 'need'} a sender ID. Enter one above, or set a default on the
                  gateway.
                </Alert>
              )}

              <div className="field">
                <span className="field-label">When</span>
                <div className="radio-row">
                  <label className="radio-card">
                    <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} />
                    <span>
                      <span className="title">Send now</span>
                      <br />
                      <span className="desc">Starts as soon as you confirm</span>
                    </span>
                  </label>
                  <label className="radio-card">
                    <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} />
                    <span>
                      <span className="title">Schedule</span>
                      <br />
                      <span className="desc">Pick a date and time</span>
                    </span>
                  </label>
                </div>
              </div>
              {when === 'later' && (
                <Field
                  label="Send at"
                  htmlFor="schedule"
                  error={scheduleError}
                  help={`Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Consider each country’s local time and quiet hours.`}
                >
                  <input
                    id="schedule"
                    type="datetime-local"
                    className="input"
                    value={scheduleAt}
                    min={localInputValue(new Date())}
                    onChange={(e) => setScheduleAt(e.target.value)}
                  />
                </Field>
              )}

              <Field label="Campaign name" htmlFor="name" help="Only you see this.">
                <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} maxLength={120} />
              </Field>
            </div>
          </Card>
        </div>

        {/* Aside ------------------------------------------------------------ */}
        <aside className="compose-aside">
          <Card title="Preview">
            <PhonePreview
              sender={sender.trim() || settings.defaultSender}
              text={previewText}
              recipient={previewRecipient}
              index={index}
              count={list.valid.length}
              onMove={(d) => setPreviewIndex(Math.min(Math.max(0, index + d), list.valid.length - 1))}
            />
          </Card>
          <Card title="Summary">
            <dl className="summary-list">
              <div>
                <dt>Recipients</dt>
                <dd>{fmtInt(list.valid.length)}</dd>
              </div>
              <div>
                <dt>Countries</dt>
                <dd>{fmtInt(routes.length)}</dd>
              </div>
              <div>
                <dt>Segments per message</dt>
                <dd>{segments.max === 0 ? previewInfo.segments || '—' : segments.min === segments.max ? segments.max : `${segments.min}–${segments.max}`}</dd>
              </div>
              <div>
                <dt>Total segments</dt>
                <dd>{segments.total ? fmtInt(segments.total) : '—'}</dd>
              </div>
              <div>
                <dt>Gateway</dt>
                <dd>{fixedProvider ? fixedProvider.name : 'Automatic'}</dd>
              </div>
              <div>
                <dt>When</dt>
                <dd>{when === 'later' && scheduledDate && !scheduleError ? fmtDateTime(scheduledDate.toISOString()) : 'Now'}</dd>
              </div>
            </dl>
            <div style={{ marginTop: 16 }}>
              <button className="btn primary lg block" disabled={!!blocker} onClick={() => setConfirming(true)}>
                {when === 'later' ? <CalendarClock size={16} /> : <SendIcon size={16} />}
                {sendLabel}
              </button>
              {blocker && <div className="muted small" style={{ marginTop: 8, textAlign: 'center' }}>{blocker}</div>}
            </div>
          </Card>
        </aside>
      </div>

      {showInvalid && (
        <Modal title={`${fmtInt(list.invalid.length)} invalid numbers`} subtitle="These rows will be skipped." onClose={() => setShowInvalid(false)}>
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Value</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {list.invalid.slice(0, 500).map((r) => (
                  <tr key={r.row}>
                    <td className="num muted">{r.row}</td>
                    <td className="mono">{r.input || <span className="muted">(empty)</span>}</td>
                    <td>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.invalid.length > 500 && <p className="muted small" style={{ marginTop: 8 }}>Showing the first 500.</p>}
        </Modal>
      )}

      {confirming && (
        <ConfirmDialog
          title={when === 'later' ? 'Schedule this campaign?' : 'Send this campaign now?'}
          confirmLabel={when === 'later' ? 'Schedule' : `Send ${fmtInt(list.valid.length)} messages`}
          busy={busy}
          onConfirm={submit}
          onCancel={() => setConfirming(false)}
        >
          <div className="stack" style={{ gap: 12 }}>
            <p>
              {fmtInt(list.valid.length)} recipients in {plural(routes.length, 'country', 'countries')} will receive about {fmtInt(segments.total)} segments
              {fixedProvider ? ` through ${fixedProvider.name}` : ` through ${usedProviders.map((p) => p.name).join(', ') || 'your gateways'}`}
              {when === 'later' && scheduledDate ? `, starting ${fmtDateTime(scheduledDate.toISOString())}` : ''}.
            </p>
            <div className="bubble" style={{ maxWidth: '100%' }}>
              {previewText}
            </div>
            {allSandbox ? (
              <Alert tone="info">Sandbox gateway: messages are simulated and no real SMS is sent.</Alert>
            ) : (
              <Alert tone="warning">This sends real SMS and your gateway will charge for them. Make sure recipients agreed to hear from you.</Alert>
            )}
            {busy && (
              <div className="row muted small">
                <Spinner size={14} /> Creating campaign…
              </div>
            )}
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
