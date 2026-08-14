import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useIsAuthenticated } from '@azure/msal-react';
import { fetchMe, CurrentUser } from '../services/api';

interface RoleContextValue {
  user: CurrentUser | null;
  loading: boolean;
  isAdmin: boolean;
  hasAccess: boolean;
}

const RoleContext = createContext<RoleContextValue>({ user: null, loading: true, isAdmin: false, hasAccess: true });

export function RoleProvider({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [isAuthenticated]);

  const isAdmin = user?.role === 'Admin';
  // Enquanto ainda carregando (user === null e loading), consideramos hasAccess=true
  // para não piscar a tela de bloqueio antes da resposta de /api/me chegar — quem
  // decide se renderiza o app ou o bloqueio é sempre `loading` combinado com `hasAccess`.
  const hasAccess = user ? user.hasAccess : true;

  return (
    <RoleContext.Provider value={{ user, loading, isAdmin, hasAccess }}>
      {children}
    </RoleContext.Provider>
  );
}

export function useCurrentUser() {
  return useContext(RoleContext);
}
