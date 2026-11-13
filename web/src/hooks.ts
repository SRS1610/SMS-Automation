import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/** Current location hash as a path, e.g. "#/campaigns/abc" -> "/campaigns/abc". */
function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  return raw.startsWith('/') ? raw : '/dashboard';
}

export function useRoute(): string {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener('hashchange', notify);
      return () => window.removeEventListener('hashchange', notify);
    },
    readHash,
    () => '/dashboard',
  );
}

export function navigate(path: string): void {
  window.location.hash = path;
  window.scrollTo({ top: 0 });
}

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T) => void;
}

/**
 * Loads data and optionally polls it. While reloading, the previous data is
 * kept on screen (no flash), and `loading` is only true for the first load.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[], opts: { intervalMs?: number | false } = {}): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    try {
      const value = await loadRef.current();
      if (id === seq.current) {
        setData(value);
        setError(undefined);
      }
    } catch (err) {
      if (id === seq.current) setError(err as Error);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, opts.intervalMs);
    return () => clearInterval(timer);
  }, [opts.intervalMs, reload]);

  return { data, error, loading, reload, setData };
}

/** Fired after gateways are added, changed or removed, so other views can refresh. */
export const GATEWAYS_CHANGED = 'sms:gateways-changed';
export function notifyGatewaysChanged(): void {
  window.dispatchEvent(new Event(GATEWAYS_CHANGED));
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
