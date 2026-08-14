import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { Navigate } from 'react-router-dom';
import { ReactNode } from 'react';
import { useCurrentUser } from './RoleContext';
import AccessDenied from '../pages/AccessDenied';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const { inProgress } = useMsal();
  const { loading, hasAccess } = useCurrentUser();

  if (inProgress !== InteractionStatus.None) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-white text-lg">Carregando...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Aguarda /api/me resolver antes de decidir entre o app e a tela de bloqueio,
  // para não piscar o Dashboard antes de saber se o usuário tem acesso.
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-white text-lg">Carregando...</div>
      </div>
    );
  }

  if (!hasAccess) {
    return <AccessDenied />;
  }

  return <>{children}</>;
}
