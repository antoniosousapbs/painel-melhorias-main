import { useMsal } from '@azure/msal-react';
import { useNavigate } from 'react-router-dom';
import { getImagePath } from '../utils/imagePath';

export default function AccessDenied() {
  const { instance } = useMsal();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await instance.clearCache();
    sessionStorage.clear();
    localStorage.clear();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-blue-900 to-gray-900">
      <div className="flex flex-col items-center gap-6 p-10 bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700 shadow-2xl max-w-md w-full mx-4">
        <img
          src={getImagePath('logo-paradigma.png')}
          alt="Paradigma"
          className="h-14 w-auto object-contain"
        />

        <div className="flex flex-col items-center gap-3 text-center">
          <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
            <svg className="w-7 h-7 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M8 8l8 8M16 8l-8 8" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-white text-lg font-semibold">Acesso não autorizado</h1>
          <p className="text-gray-300 text-sm">
            Sua conta não tem acesso liberado ao Dashboard de Melhorias.
          </p>
          <p className="text-gray-400 text-xs">
            Solicite acesso ao administrador do sistema.
          </p>
        </div>

        <button
          onClick={handleLogout}
          className="px-6 py-2.5 bg-white hover:bg-gray-100 text-gray-800 font-medium rounded-lg transition-colors shadow-lg w-full"
        >
          Sair
        </button>
      </div>
    </div>
  );
}
