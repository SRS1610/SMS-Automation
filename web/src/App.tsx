import { Inbox, LayoutDashboard, LogOut, MessageSquare, Send, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '../../shared/types';
import { api, onUnauthorized } from './api';
import { Loading } from './components/ui';
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

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionInfo | null>(null);

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
