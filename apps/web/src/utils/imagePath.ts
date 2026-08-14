/**
 * Resolve o path base para assets da aplicação.
 * Funciona tanto em desenvolvimento (/) quanto em produção (/improvements/),
 * independentemente da rota atual (ex: /improvements/configuracoes).
 */
export function getBasePath(): string {
  const pathname = window.location.pathname || '/';
  const segments = pathname.split('/').filter(Boolean);
  return segments[0] === 'improvements' ? '/improvements/' : '/';
}

/**
 * Resolve path para uma imagem relativo ao base path.
 * Ex: getImagePath('logo-paradigma.png') -> '/improvements/logo-paradigma.png'
 */
export function getImagePath(filename: string): string {
  return getBasePath() + filename;
}
