import { Navigate } from 'react-router-dom';
import { ReactNode } from 'react';
import { useCurrentUser } from './RoleContext';

export function RequireRole({ role, children }: { role: 'Admin' | 'Operador'; children: ReactNode }) {
  const { user, loading } = useCurrentUser();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-white text-lg">Carregando...</div>
      </div>
    );
  }

  if (!user || user.role !== role) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
