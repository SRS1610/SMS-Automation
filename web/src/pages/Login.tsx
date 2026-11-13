import { Lock, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { api, ApiError } from '../api';
import { Alert, Field, Spinner } from '../components/ui';

export function Login({ onSuccess }: { onSuccess: (session: SessionInfo) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onSuccess(await api.login(password));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not sign in');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark" aria-hidden>
            <MessageSquare size={17} />
          </span>
          <h1 style={{ fontSize: 18 }}>SMS Automation</h1>
        </div>
        <p className="secondary">Enter the admin password to open the dashboard.</p>
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Password" htmlFor="password">
          <input id="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        <button className="btn primary lg block" disabled={!password || busy}>
          {busy ? <Spinner size={15} /> : <Lock size={15} />} Sign in
        </button>
      </form>
    </div>
  );
}
