/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  // adicione outras variáveis de ambiente do Vite aqui se necessário
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly PROD: boolean;
  readonly DEV: boolean;
}
