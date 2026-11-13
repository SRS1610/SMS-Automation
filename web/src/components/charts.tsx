import { useEffect, useRef, useState, type ReactNode } from 'react';
import { countryName, flagEmoji } from '../../../shared/phone';
import type { DailyPoint } from '../../../shared/types';
import { fmtCount, fmtInt } from '../format';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Whole-number tick step giving about four intervals: 1, 2, 5, 10, 20, 25, 50… */
function niceStep(max: number): number {
  const raw = Math.max(1, max / 4);
  const base = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * base;
    if (step >= raw && Number.isInteger(step)) return step;
  }
  return 10 * base;
}

/** Path for a column segment with rounded top corners and a square base. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

const SERIES = [
  { key: 'delivered', label: 'Delivered', color: 'var(--series-delivered)' },
  { key: 'sent', label: 'Sent, awaiting receipt', color: 'var(--series-sent)' },
  { key: 'failed', label: 'Failed', color: 'var(--series-failed)' },
] as const;

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span key={item.label}>
          <span className="key" style={{ background: item.color }} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** Stacked daily columns: delivered / sent / failed. */
export function DailyChart({ data, tableView }: { data: DailyPoint[]; tableView?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (tableView) {
    return (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date (UTC)</th>
              {SERIES.map((s) => (
                <th key={s.key} className="num">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <td>{shortDate(d.date)}</td>
                {SERIES.map((s) => (
                  <td key={s.key} className="num">
                    {fmtInt(d[s.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const height = 250;
  const pad = { top: 10, right: 4, bottom: 26, left: 40 };
  const innerW = Math.max(100, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const totals = data.map((d) => d.delivered + d.sent + d.failed);
  const step = niceStep(Math.max(0, ...totals));
  const max = Math.max(step, Math.ceil(Math.max(0, ...totals) / step) * step);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const band = innerW / Math.max(1, data.length);
  const barW = Math.min(24, Math.max(6, band * 0.56));
  const labelEvery = band < 46 ? 2 : 1;
  const scale = (v: number) => (v / max) * innerH;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg height={height} role="img" aria-label="Messages per day for the last 14 days, by outcome">
        <g transform={`translate(${pad.left},${pad.top})`}>
          {ticks.map((t) => (
            <g key={t} transform={`translate(0,${innerH - scale(t)})`}>
              {t !== 0 && <line className="gridline" x1={0} x2={innerW} />}
              <text className="tick" x={-8} dy="0.32em" textAnchor="end">
                {fmtCount(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = i * band + band / 2;
            const x = cx - barW / 2;
            let y = innerH;
            const parts = SERIES.map((s) => ({ ...s, h: scale(d[s.key]) })).filter((p) => p.h > 0);
            return (
              <g key={d.date} className={`col-group ${hover !== null && hover !== i ? 'dim' : ''}`}>
                {parts.map((p, j) => {
                  const gap = j > 0 ? 2 : 0;
                  const h = Math.max(1, p.h - gap);
                  y -= p.h;
                  const isTop = j === parts.length - 1;
                  // The 2px gap sits under each upper segment, separating it from the one below.
                  return isTop ? (
                    <path key={p.key} d={topRounded(x, y, barW, h, 4)} fill={p.color} />
                  ) : (
                    <rect key={p.key} x={x} y={y} width={barW} height={h} fill={p.color} />
                  );
                })}
                {i % labelEvery === 0 && (
                  <text className="tick" x={cx} y={innerH + 17} textAnchor="middle">
                    {shortDate(d.date)}
                  </text>
                )}
                <rect
                  className="hit"
                  x={i * band}
                  y={0}
                  width={band}
                  height={innerH}
                  tabIndex={0}
                  aria-label={`${shortDate(d.date)}: ${SERIES.map((s) => `${s.label} ${d[s.key]}`).join(', ')}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
          <line className="baseline" x1={0} x2={innerW} y1={innerH} y2={innerH} />
        </g>
      </svg>
      {hover !== null && data[hover] && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(pad.left + hover * band + band / 2, 80), width - 80),
            top: pad.top + innerH - scale(totals[hover]),
          }}
        >
          <div className="tt-title">{shortDate(data[hover].date)} (UTC)</div>
          {SERIES.map((s) => (
            <div className="tt-row" key={s.key}>
              <span className="row" style={{ gap: 6 }}>
                <span className="line-key" style={{ background: s.color }} />
                <span className="secondary">{s.label}</span>
              </span>
              <strong>{fmtInt(data[hover][s.key])}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SeriesLegend() {
  return <ChartLegend items={SERIES.map((s) => ({ label: s.label, color: s.color }))} />;
}

/** Horizontal bar list for a single series (e.g. messages by destination). */
export function BarList({ items, empty }: { items: { key: string; label: ReactNode; value: number }[]; empty?: ReactNode }) {
  if (!items.length) return <div className="muted small">{empty ?? 'No data yet'}</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="barlist">
      {items.map((item) => (
        <div className="barlist-row" key={item.key}>
          <div className="barlist-label">{item.label}</div>
          <div className="barlist-value">{fmtInt(item.value)}</div>
          <div className="barlist-track" aria-hidden>
            <div className="barlist-fill" style={{ width: `${Math.max(1.5, (item.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CountryLabel({ code }: { code: string | null }) {
  if (!code) return <span className="muted">Unknown</span>;
  return (
    <>
      <span aria-hidden>{flagEmoji(code)}</span>
      <span>{countryName(code)}</span>
    </>
  );
}
