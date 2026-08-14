import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../auth/msalConfig';
import { getImagePath } from '../utils/imagePath';

export default function Login() {
  const { instance } = useMsal();

  const handleLogin = () => {
    instance.loginRedirect(loginRequest);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-blue-900 to-gray-900">
      <div className="flex flex-col items-center gap-8 p-10 bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700 shadow-2xl max-w-md w-full mx-4">
        <img
          src={getImagePath('logo-paradigma.png')}
          alt="Paradigma"
        />

        <div className="flex flex-col items-center gap-2">
          <img
            src={getImagePath('pati/amigavel.png')}
            alt="PATi"
          />
          <p className="text-gray-300 text-sm text-center">
            Dashboard Executivo de Evoluções
          </p>
        </div>

        <button
          onClick={handleLogin}
          className="flex items-center gap-3 px-6 py-3 bg-white hover:bg-gray-100 text-gray-800 font-medium rounded-lg transition-colors shadow-lg w-full justify-center"
        >
          <svg className="w-5 h-5" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          Entrar com conta Microsoft
        </button>

        <p className="text-gray-500 text-xs text-center">
          Acesso restrito a colaboradores Paradigma
        </p>
      </div>
    </div>
  );
}
