import { Inbox, LayoutDashboard, LogOut, MessageSquare, Power, Send, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '../../shared/types';
import { api, onUnauthorized } from './api';
import { ConfirmDialog, EmptyState, Loading } from './components/ui';
import { GATEWAYS_CHANGED, useResource, useRoute } from './hooks';
import { CampaignDetail } from './pages/CampaignDetail';
import { Campaigns } from './pages/Campaigns';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { SendPage } from './pages/Send';
import { SettingsPage } from './pages/Settings';

const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/send', label: 'Send SMS', icon: Send },
  { path: '/campaigns', label: 'Campaigns', icon: Inbox },
  { path: '/settings', label: 'Settings', icon: SettingsIcon },
];

function GatewayStatus({ route }: { route: string }) {
  const { data, reload } = useResource(() => api.providers(), [route], { intervalMs: 30_000 });
  useEffect(() => {
    const handler = () => void reload();
    window.addEventListener(GATEWAYS_CHANGED, handler);
    return () => window.removeEventListener(GATEWAYS_CHANGED, handler);
  }, [reload]);
  if (!data) return null;
  const enabled = data.filter((p) => p.enabled).length;
  return (
    <a href="#/settings/gateways" className="gateway-status" style={{ textDecoration: 'none' }}>
      <span className="key" style={{ borderRadius: '50%', background: enabled ? 'var(--good)' : 'var(--warning)' }} aria-hidden />
      {enabled ? `${enabled} gateway${enabled === 1 ? '' : 's'} active` : 'No gateway connected'}
    </a>
  );
}

function Page({ route }: { route: string }) {
  const [, section, id] = route.split('/');
  switch (section) {
    case 'send':
      return <SendPage />;
    case 'campaigns':
      return id ? <CampaignDetail id={id} /> : <Campaigns />;
    case 'settings':
      return <SettingsPage tab={id ?? 'gateways'} />;
    default:
      return <Dashboard />;
  }
}

function QuitButton({ onQuit }: { onQuit: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => setConfirming(true)}>
        <Power size={14} /> Quit app
      </button>
      {confirming && (
        <ConfirmDialog
          title="Quit SMS Automation?"
          confirmLabel="Quit"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.quitApp();
            } finally {
              onQuit();
            }
          }}
        >
          Sending stops while the app is closed. Unfinished and scheduled campaigns carry on the next time you open it.
        </ConfirmDialog>
      )}
    </>
  );
}

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [stopped, setStopped] = useState(false);

  const refreshSession = useCallback(() => {
    api
      .session()
      .then(setSession)
      .catch(() => setSession({ authRequired: false, authenticated: true }));
  }, []);

  useEffect(() => {
    refreshSession();
    return onUnauthorized(() => setSession((s) => (s ? { ...s, authenticated: false } : s)));
  }, [refreshSession]);

  if (stopped) {
    return (
      <div className="login">
        <EmptyState icon={<Power size={20} />} title="SMS Automation has stopped">
          You can close this tab. Open the app again from your Applications folder to continue.
        </EmptyState>
      </div>
    );
  }
  if (!session) return <Loading />;
  if (!session.authenticated) return <Login onSuccess={setSession} />;

  const section = `/${route.split('/')[1]}`;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <MessageSquare size={17} />
          </span>
          <span className="brand-name">SMS Automation</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map(({ path, label, icon: Icon }) => (
            <a
              key={path}
              href={`#${path}`}
              className={section === path ? 'active' : undefined}
              aria-current={section === path ? 'page' : undefined}
              aria-label={label}
              title={label}
            >
              <Icon size={17} aria-hidden />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <GatewayStatus route={route} />
          {session.desktop && <QuitButton onQuit={() => setStopped(true)} />}
          {session.authRequired && (
            <button
              className="btn ghost sm"
              style={{ justifyContent: 'flex-start' }}
              onClick={async () => {
                setSession(await api.logout());
              }}
            >
              <LogOut size={14} /> Sign out
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        <Page route={route} />
      </main>
    </div>
  );
}
