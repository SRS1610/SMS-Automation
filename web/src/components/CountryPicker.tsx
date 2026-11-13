import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { listCountries, type CountryInfo } from '../../../shared/phone';

function matches(country: CountryInfo, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  const digits = q.replace(/[^\d]/g, '');
  return (
    country.name.toLowerCase().includes(q) ||
    country.code.toLowerCase() === q ||
    (digits.length > 0 && country.dialCode.replace('+', '').startsWith(digits))
  );
}

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return ref;
}

interface ListProps {
  query: string;
  exclude?: Set<string>;
  onPick: (code: string) => void;
  highlight: number;
  setHighlight: (n: number) => void;
}

function useFiltered(query: string, exclude?: Set<string>) {
  const all = useMemo(() => listCountries(), []);
  return useMemo(() => all.filter((c) => !exclude?.has(c.code) && matches(c, query)), [all, query, exclude]);
}

function OptionList({ query, exclude, onPick, highlight, setHighlight }: ListProps) {
  const options = useFiltered(query, exclude);
  if (!options.length) return <div className="picker-menu muted small" style={{ padding: 10 }}>No matching country</div>;
  return (
    <div className="picker-menu" role="listbox">
      {options.map((c, i) => (
        <button
          type="button"
          role="option"
          aria-selected={i === highlight}
          key={c.code}
          className={`picker-option ${i === highlight ? 'highlight' : ''}`}
          onMouseEnter={() => setHighlight(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c.code)}
        >
          <span aria-hidden>{c.flag}</span>
          <span>{c.name}</span>
          <span className="dial">{c.dialCode}</span>
        </button>
      ))}
    </div>
  );
}

/** Searchable single-country select. */
export function CountrySelect({ value, onChange, id }: { value: string; onChange: (code: string) => void; id?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useOutsideClose(close);
  const current = useMemo(() => listCountries().find((c) => c.code === value), [value]);
  const options = useFiltered(query);

  const pick = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="picker" ref={ref}>
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={open}
        value={open ? query : current ? `${current.flag}  ${current.name} (${current.dialCode})` : value}
        placeholder="Search country or dial code"
        onFocus={() => {
          setOpen(true);
          setQuery('');
          setHighlight(0);
        }}
        onBlur={() => {
          setOpen(false);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight(Math.min(highlight + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight(Math.max(highlight - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault(); // never submit the surrounding form from the picker
            if (open && options[highlight]) pick(options[highlight].code);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && <OptionList query={query} onPick={pick} highlight={highlight} setHighlight={setHighlight} />}
    </div>
  );
}

/** Multi-country picker shown as removable chips. */
export function CountryMultiSelect({ value, onChange, id }: { value: string[]; onChange: (codes: string[]) => void; id?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useOutsideClose(close);
  const selected = useMemo(() => new Set(value), [value]);
  const byCode = useMemo(() => new Map<string, CountryInfo>(listCountries().map((c) => [c.code, c])), []);
  const options = useFiltered(query, selected);

  const add = (code: string) => {
    onChange([...value, code]);
    setQuery('');
    setHighlight(0);
    setOpen(false);
  };

  return (
    <div className="picker" ref={ref}>
      {value.length > 0 && (
        <div className="picker-chips">
          {value.map((code) => (
            <span className="chip" key={code}>
              <span aria-hidden>{byCode.get(code)?.flag}</span>
              {byCode.get(code)?.name ?? code}
              <button type="button" aria-label={`Remove ${byCode.get(code)?.name ?? code}`} onClick={() => onChange(value.filter((c) => c !== code))}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={open}
        value={query}
        placeholder="Add a country…"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight(Math.min(highlight + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight(Math.max(highlight - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault(); // never submit the surrounding form from the picker
            if (open && options[highlight]) add(options[highlight].code);
          } else if (e.key === 'Backspace' && !query && value.length) {
            onChange(value.slice(0, -1));
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && <OptionList query={query} exclude={selected} onPick={add} highlight={highlight} setHighlight={setHighlight} />}
    </div>
  );
}
