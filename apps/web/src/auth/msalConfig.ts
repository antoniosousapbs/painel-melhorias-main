import { Configuration, LogLevel } from '@azure/msal-browser';

const isProd = import.meta.env.PROD;

const getAppBasePath = (): string => {
  const configuredRedirect = (window as Window & { _env_?: { MSAL_REDIRECT_URI?: string } })._env_?.MSAL_REDIRECT_URI;

  if (typeof configuredRedirect === 'string' && configuredRedirect.trim()) {
    try {
      const url = new URL(configuredRedirect);
      const pathname = url.pathname.replace(/\/+$/, '');
      return pathname && pathname !== '/' ? pathname : '';
    } catch {
      // fallback para a URL atual
    }
  }

  const href = typeof window !== 'undefined' ? window.location.href : '';
  const pathname = href ? new URL(href).pathname : '/';
  const segments = pathname.split('/').filter(Boolean);

  return segments[0] === 'improvements' ? '/improvements' : '';
};

const appBasePath = getAppBasePath();
const appRoot = `${window.location.origin}${appBasePath}`;

// Em produção, a aplicação roda como sub-aplicação no IIS.
// O redirect precisa apontar exatamente para a raiz da aplicação,
// e não para o host sem o path da sub-aplicação.
const redirectUri = (window as Window & { _env_?: { MSAL_REDIRECT_URI?: string } })._env_?.MSAL_REDIRECT_URI || appRoot;

export const msalConfig: Configuration = {
  auth: {
    clientId: '05bd370d-71b5-41cd-87ed-aeb68a091830',
    authority: 'https://login.microsoftonline.com/2ec1379e-af09-4a76-89f8-adde6b8733b4',
    redirectUri: redirectUri,
    postLogoutRedirectUri: redirectUri,
  },
  cache: {
    cacheLocation: 'sessionStorage',
  },
  system: {
    loggerOptions: {
      logLevel: isProd ? LogLevel.Error : LogLevel.Warning,
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === LogLevel.Error) console.error(message);
        else if (!isProd && level === LogLevel.Warning) console.warn(message);
      },
    },
  },
};

export const loginRequest = {
  scopes: ['User.Read'],
  prompt: 'select_account',
};
