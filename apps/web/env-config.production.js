/**
 * Configuração de runtime da aplicação em PRODUÇÃO (pta0404).
 *
 * Este arquivo NÃO fica em public/ de propósito — não deve ser servido pelo
 * Vite em desenvolvimento local. Ele é copiado para
 * deploy-package/improvements/public/env-config.js apenas ao gerar o pacote
 * de deploy (substituindo o env-config.js neutro usado em dev).
 *
 * O IIS faz proxy de /improvements/api/* → localhost:3002/api/*
 */
window._env_ = {
  VITE_API_BASE: '/improvements/api',
  MSAL_REDIRECT_URI: 'https://pta0404.pta.com.br/improvements',
};
