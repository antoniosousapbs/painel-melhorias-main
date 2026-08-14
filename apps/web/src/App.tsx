import { Routes, Route, Link, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import Dashboard from './pages/Dashboard';
import Configuracoes from './pages/Configuracoes';
import WorkItemDetail from './pages/WorkItemDetail';
import Login from './pages/Login';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { RequireRole } from './auth/RequireRole';
import { useCurrentUser } from './auth/RoleContext';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { fetchSyncLast } from './services/api';
import { getImagePath } from './utils/imagePath';
import PatiChat from './components/PatiChat';

function getShortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 2) return fullName;
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const isDashboard = location.pathname === '/' || location.pathname.startsWith('/workitem');
  const isAuthenticated = useIsAuthenticated();
  const { instance, accounts } = useMsal();
  const { isAdmin, hasAccess } = useCurrentUser();
  const fullName = accounts[0]?.name || '';
  const shortName = getShortName(fullName);
  const initials = getInitials(fullName);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  // Última sincronização — visível no header para todos os papéis, independente da página
  useEffect(() => {
    if (!isAuthenticated || !hasAccess) return;
    const load = () => { fetchSyncLast().then(s => setLastSync(s.lastSync)).catch(() => {}); };
    load();
    const interval = setInterval(load, 30_000);
    window.addEventListener('painelbacklog:sync-done', load);
    return () => { clearInterval(interval); window.removeEventListener('painelbacklog:sync-done', load); };
  }, [isAuthenticated, hasAccess]);

  useEffect(() => {
    if (!isAuthenticated || !accounts[0]) return;
    const fetchPhoto = async () => {
      try {
        const token = await instance.acquireTokenSilent({
          scopes: ['User.Read'],
          account: accounts[0],
        });
        const res = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
          headers: { Authorization: `Bearer ${token.accessToken}` },
        });
        if (res.ok) {
          const blob = await res.blob();
          setPhotoUrl(URL.createObjectURL(blob));
        }
      } catch {
        // sem foto, usa iniciais
      }
    };
    fetchPhoto();
  }, [isAuthenticated, accounts, instance]);

  const handleLogout = async () => {
    setLoggingOut(true);
    await instance.clearCache();
    sessionStorage.clear();
    localStorage.clear();
    navigate('/login');
  };

  if (location.pathname === '/login') {
    if (isAuthenticated && !loggingOut) return <Navigate to="/" replace />;
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    );
  }

  return (
    <ProtectedRoute>
    <div className="min-h-screen bg-bg">
      {/* ─── Top Nav Bar ─── */}
      <nav
        className="w-full h-20 shadow-md sticky top-0 z-50"
        style={{ background: 'linear-gradient(135deg, #021B79 0%, #033AF0 100%)' }}
      >
        <div className="max-w-container mx-auto px-8 h-full flex items-center justify-between">
          {/* Left: logo + title */}
          <div className="flex items-center gap-4">
            <img
              src={getImagePath('logo-paradigma.png')}
              alt="Paradigma"
              className="h-10 w-auto object-contain"
            />
            <div className="w-px h-6 bg-white/25" />
            <div className="flex flex-col leading-tight">
              <span className="text-[15px] font-semibold text-white tracking-tight">
                Dashboard de Melhorias
              </span>
              <span className="text-[11px] text-white/60 font-medium tracking-wide">
                {lastSync
                  ? `Última sincronização: ${new Date(lastSync).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                  : 'Última sincronização: —'}
              </span>
            </div>
          </div>

          {/* Right: nav links + user */}
          <div className="flex items-center gap-3">
            {isAdmin && (
              <Link
                to="/"
                className={`h-8 px-3 rounded text-[13px] font-medium flex items-center transition-colors duration-150 ${
                  isDashboard
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`}
              >
                Dashboard
              </Link>
            )}
            {isAdmin && (
              <Link
                to="/configuracoes"
                className={`h-8 px-3 rounded text-[13px] font-medium flex items-center transition-colors duration-150 ${
                  location.pathname === '/configuracoes'
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`}
              >
                Configurações
              </Link>
            )}
            <div className="w-px h-6 bg-white/25 ml-1" />
            <div className="flex items-center gap-2.5">
              {photoUrl ? (
                <img
                  src={photoUrl}
                  alt={shortName}
                  className="w-8 h-8 rounded-full object-cover border border-white/30"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-[11px] font-bold text-white border border-white/30">
                  {initials}
                </div>
              )}
              <div className="flex flex-col leading-tight items-end">
                <span className="text-[12px] text-white/90 font-medium">{shortName}</span>
                <button
                  onClick={handleLogout}
                  className="text-[11px] text-white/50 hover:text-white/90 transition-colors text-right"
                >
                  Sair
                </button>
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* ─── Content ─── */}
      <div className="max-w-container mx-auto px-8 pt-7 pb-12">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route
            path="/configuracoes"
            element={
              <RequireRole role="Admin">
                <Configuracoes />
              </RequireRole>
            }
          />
          <Route path="/backoffice" element={<Navigate to="/configuracoes" replace />} />
          <Route path="/workitem/:id" element={<WorkItemDetail />} />
        </Routes>
      </div>
    </div>
    </ProtectedRoute>
  );
}
