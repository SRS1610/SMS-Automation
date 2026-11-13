import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { ProviderInput, ProviderSummary, ProviderTypeInfo } from '../../../shared/types';
import { api, ApiError } from '../api';
import { CountryMultiSelect } from '../components/CountryPicker';
import { Alert, Field, Modal, Spinner, Toggle } from '../components/ui';
import { senderProblem } from './Send';

function initialConfig(type: ProviderTypeInfo, existing: ProviderSummary | null): Record<string, string> {
  const config: Record<string, string> = {};
  for (const field of type.fields) {
    const isSecret = field.type === 'secret' || field.secret;
    if (isSecret) config[field.key] = '';
    else config[field.key] = existing?.config[field.key] ?? field.default ?? '';
  }
  return config;
}

/** Create / edit form for one gateway connection, rendered in a modal. */
export function GatewayForm({ type, existing, onClose, onSaved, onBack }: {
  type: ProviderTypeInfo;
  existing: ProviderSummary | null;
  onClose: () => void;
  onSaved: (provider: ProviderSummary, created: boolean) => void;
  onBack?: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? type.label.replace(/ \(.*\)$/, ''));
  const [config, setConfig] = useState(() => initialConfig(type, existing));
  const [defaultSender, setDefaultSender] = useState(existing?.defaultSender ?? '');
  const [coverage, setCoverage] = useState<'all' | 'some'>(existing && existing.countries.length > 0 ? 'some' : 'all');
  const [countries, setCountries] = useState<string[]>(existing?.countries ?? []);
  const [priority, setPriority] = useState(String(existing?.priority ?? 10));
  const [rateLimit, setRateLimit] = useState(String(existing?.rateLimit ?? 10));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const senderError = senderProblem(defaultSender);
  const set = (key: string, value: string) => setConfig((c) => ({ ...c, [key]: value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (coverage === 'some' && countries.length === 0) {
      setError('Pick at least one country, or choose “All countries”.');
      return;
    }
    const input: ProviderInput = {
      name: name.trim(),
      type: type.type,
      enabled,
      priority: Number(priority) || 0,
      rateLimit: Number(rateLimit) || 1,
      countries: coverage === 'all' ? [] : countries,
      defaultSender: defaultSender.trim() || null,
      config,
    };
    setBusy(true);
    try {
      const saved = existing ? await api.updateProvider(existing.id, input) : await api.createProvider(input);
      onSaved(saved, !existing);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the gateway');
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={existing ? `Edit ${existing.name}` : `Connect ${type.label}`}
      subtitle={
        <>
          {type.description}{' '}
          {type.website && (
            <a href={type.website} target="_blank" rel="noreferrer">
              Docs <ExternalLink size={12} style={{ verticalAlign: '-1px' }} />
            </a>
          )}
        </>
      }
      onClose={onClose}
      footer={
        <>
          {onBack && (
            <button type="button" className="btn ghost" style={{ marginRight: 'auto' }} onClick={onBack} disabled={busy}>
              Back
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="gateway-form" className="btn primary" disabled={busy || !!senderError}>
            {busy && <Spinner size={14} />}
            {existing ? 'Save changes' : 'Save and test'}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={save} id="gateway-form">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Display name" htmlFor="gw-name" required help="Shown in routing and reports, e.g. “Twilio – US”.">
          <input id="gw-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </Field>

        <div className="grid-2">
          {type.fields.map((field) => {
            const id = `gw-${field.key}`;
            const isSecret = field.type === 'secret' || !!field.secret;
            const stored = existing?.secrets[field.key];
            const wide = field.type === 'textarea';
            const placeholder = isSecret && stored?.set ? `Saved (${stored.hint}). Leave blank to keep.` : field.placeholder;
            let control;
            if (field.type === 'select') {
              control = (
                <select id={id} className="select" value={config[field.key]} onChange={(e) => set(field.key, e.target.value)}>
                  {field.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              );
            } else if (field.type === 'textarea') {
              control = (
                <textarea
                  id={id}
                  className="textarea mono"
                  rows={field.key === 'bodyTemplate' ? 6 : 3}
                  value={config[field.key]}
                  placeholder={placeholder}
                  onChange={(e) => set(field.key, e.target.value)}
                  spellCheck={false}
                />
              );
            } else {
              control = (
                <input
                  id={id}
                  className="input"
                  type={isSecret ? 'password' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
                  autoComplete={isSecret ? 'new-password' : 'off'}
                  value={config[field.key]}
                  placeholder={placeholder}
                  required={field.required && !(isSecret && stored?.set)}
                  onChange={(e) => set(field.key, e.target.value)}
                  spellCheck={false}
                />
              );
            }
            return (
              <div key={field.key} style={wide ? { gridColumn: '1 / -1' } : undefined}>
                <Field label={field.label} htmlFor={id} required={field.required} help={field.help}>
                  {control}
                </Field>
              </div>
            );
          })}
        </div>

        <Field
          label="Default sender ID"
          htmlFor="gw-sender"
          required={type.senderRequired}
          error={senderError}
          help={
            type.senderRequired
              ? 'Required by this gateway unless every campaign sets one. Use a number you own or a registered alphanumeric ID.'
              : 'Used when a campaign doesn’t set one. A number you own on this gateway, or an alphanumeric ID (max 11 characters).'
          }
        >
          <input id="gw-sender" className="input" value={defaultSender} onChange={(e) => setDefaultSender(e.target.value)} maxLength={16} placeholder="e.g. +14155550100 or ACME" />
        </Field>

        <div className="field">
          <span className="field-label">Destinations this gateway handles</span>
          <div className="radio-row">
            <label className="radio-card">
              <input type="radio" name="coverage" checked={coverage === 'all'} onChange={() => setCoverage('all')} />
              <span>
                <span className="title">All countries</span>
                <br />
                <span className="desc">Catch-all route for any destination</span>
              </span>
            </label>
            <label className="radio-card">
              <input type="radio" name="coverage" checked={coverage === 'some'} onChange={() => setCoverage('some')} />
              <span>
                <span className="title">Specific countries</span>
                <br />
                <span className="desc">Preferred over catch-all gateways for these</span>
              </span>
            </label>
          </div>
          {coverage === 'some' && <CountryMultiSelect value={countries} onChange={setCountries} />}
        </div>

        <div className="grid-2">
          <Field label="Priority" htmlFor="gw-priority" help="Lower numbers are tried first when several gateways cover a country. Others act as fail-over.">
            <input id="gw-priority" className="input" type="number" min={0} max={1000} value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="Sending rate (messages per second)" htmlFor="gw-rate" help="Keep within your account’s throughput limit to avoid throttling.">
            <input id="gw-rate" className="input" type="number" min={0.1} max={1000} step="any" value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
          </Field>
        </div>

        <Toggle checked={enabled} onChange={setEnabled} label="Enabled — use this gateway for sending" />
      </form>
    </Modal>
  );
}
