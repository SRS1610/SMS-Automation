import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export const fmtInt = (n: number) => integer.format(n);

/** Full number below 10,000, compact above (12.9K). */
export const fmtCount = (n: number) => (Math.abs(n) < 10_000 ? integer.format(n) : compact.format(n));

export const fmtPercent = (ratio: number | null, digits = 1) =>
  ratio === null || !Number.isFinite(ratio) ? '—' : `${(ratio * 100).toFixed(ratio === 1 || ratio === 0 ? 0 : digits)}%`;

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  let text: string;
  if (abs < 45_000) return future ? 'in a moment' : 'just now';
  else if (minutes < 60) text = `${minutes} min`;
  else if (minutes < 60 * 24) text = `${Math.round(minutes / 60)} h`;
  else if (minutes < 60 * 24 * 14) text = `${Math.round(minutes / 1440)} d`;
  else return fmtDateTime(iso);
  return future ? `in ${text}` : `${text} ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

const phoneCache = new Map<string, string>();
/** "+14155552671" -> "+1 415 555 2671" */
export function fmtPhone(e164: string): string {
  let out = phoneCache.get(e164);
  if (out === undefined) {
    out = parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
    if (phoneCache.size > 5000) phoneCache.clear();
    phoneCache.set(e164, out);
  }
  return out;
}
