import { CircleAlert, CircleCheck, Copy, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CampaignStatus, MessageStatus } from '../../../shared/types';

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Spinner /> {label}
    </div>
  );
}

export function Card({ title, hint, actions, children, className = '', bodyClassName = 'card-body' }: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <>
      {back}
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="header-actions">{actions}</div>}
      </header>
    </>
  );
}

type Tone = 'info' | 'warning' | 'critical' | 'good';

export function Alert({ tone = 'info', title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'good' ? CircleCheck : tone === 'critical' ? CircleAlert : tone === 'warning' ? TriangleAlert : Info;
  return (
    <div className={`alert ${tone}`} role={tone === 'critical' ? 'alert' : undefined}>
      <Icon size={16} aria-hidden />
      <div className="alert-body">
        {title && <div className="alert-title">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

const MESSAGE_TONE: Record<MessageStatus, { tone: string; label: string }> = {
  queued: { tone: '', label: 'Queued' },
  sending: { tone: 'info', label: 'Sending' },
  sent: { tone: 'info', label: 'Sent' },
  delivered: { tone: 'good', label: 'Delivered' },
  failed: { tone: 'critical', label: 'Failed' },
  cancelled: { tone: '', label: 'Cancelled' },
  suppressed: { tone: 'warning', label: 'Opted out' },
};

const CAMPAIGN_TONE: Record<CampaignStatus, { tone: string; label: string }> = {
  scheduled: { tone: 'info', label: 'Scheduled' },
  sending: { tone: 'info', label: 'Sending' },
  paused: { tone: 'warning', label: 'Paused' },
  completed: { tone: 'good', label: 'Completed' },
  cancelled: { tone: '', label: 'Cancelled' },
};

export function StatusBadge({ status, kind = 'message' }: { status: string; kind?: 'message' | 'campaign' }) {
  const map = kind === 'campaign' ? CAMPAIGN_TONE : MESSAGE_TONE;
  const entry = (map as Record<string, { tone: string; label: string }>)[status] ?? { tone: '', label: status };
  const live = status === 'sending';
  return (
    <span className={`badge ${entry.tone}`}>
      <span className={`dot ${live ? 'pulse' : ''}`} aria-hidden />
      {entry.label}
    </span>
  );
}

export function messageStatusLabel(status: MessageStatus): string {
  return MESSAGE_TONE[status].label;
}

export function Field({ label, help, error, required, children, htmlFor }: {
  label?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {label && (
        <label htmlFor={htmlFor} className={required ? 'required' : undefined}>
          {label}
        </label>
      )}
      {children}
      {error ? <div className="error-text">{error}</div> : help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Modal({ title, subtitle, children, footer, onClose, wide }: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('input, select, textarea, button:not(.icon-btn)');
    (first ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, children, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner size={14} />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const area = document.createElement('textarea');
          area.value = value;
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CircleCheck size={14} /> : <Copy size={14} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export interface ProgressPart {
  value: number;
  color: string;
  label: string;
}

/** Thin segmented bar: one whole split into parts, with an accessible summary. */
export function ProgressBar({ parts, total, tall }: { parts: ProgressPart[]; total: number; tall?: boolean }) {
  const visible = parts.filter((p) => p.value > 0);
  const summary = parts.map((p) => `${p.label}: ${p.value}`).join(', ');
  return (
    <div className={`progress ${tall ? 'tall' : ''}`} role="img" aria-label={summary}>
      {total > 0 &&
        visible.map((p) => (
          <span key={p.label} title={`${p.label}: ${p.value.toLocaleString()}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
    </div>
  );
}

export function Pagination({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <div className="pagination">
      <span className="tabular">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="row">
        <button className="btn sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button className="btn sm" disabled={to >= total} onClick={() => onChange(offset + limit)}>
          Next
        </button>
      </div>
    </div>
  );
}
