import sql from 'mssql';
import dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Tenta .env na pasta atual (produção) ou ../../.env (desenvolvimento monorepo)
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
];
const envPath = envPaths.find(p => existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
  console.log('[ENV] Carregado de:', envPath);
} else {
  console.warn('[ENV] Arquivo .env não encontrado em nenhum caminho conhecido.');
}

const config: sql.config = {
  server: process.env.DB_SERVER!,
  database: process.env.DB_DATABASE!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
  port: parseInt(process.env.DB_PORT || '1433'),
  options: {
    encrypt: false,
    trustServerCertificate: true,
    // O SQL Server roda com relógio local (America/Sao_Paulo) e todo o código usa GETDATE()
    // (local), não GETUTCDATE(). O driver tedious, por padrão (useUTC=true), interpreta os
    // valores DATETIME2 lidos do banco COMO SE já fossem UTC — isso fazia todo Date object
    // construído a partir de GETDATE() representar 3h A MENOS que o horário real (ex.: eventos
    // gravados às 20:30 apareciam na tela como 17:30). useUTC:false faz o tedious ler/escrever
    // DATETIME2 usando o fuso horário local do processo Node (também America/Sao_Paulo aqui),
    // batendo com o que GETDATE() já grava — corrige a exibição em toda a aplicação de uma vez,
    // sem precisar tocar em cada GETDATE()/formatação de data espalhada pelo código.
    useUTC: false,
    instanceName: process.env.DB_SERVER!.includes('\\')
      ? process.env.DB_SERVER!.split('\\')[1]
      : undefined,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// Fix server name (remove instance from server field if present)
if (config.server.includes('\\')) {
  config.server = config.server.split('\\')[0];
}

let pool: sql.ConnectionPool | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool) {
    const newPool = await new sql.ConnectionPool(config).connect();
    // Sem isso, uma queda de conexão (rede, restart do SQL Server) deixa `pool` apontando
    // para um objeto morto para sempre — getPool() nunca mais recria porque só checa `!pool`.
    newPool.on('error', (err) => {
      console.error('❌ Erro no pool SQL — descartando para forçar reconexão na próxima chamada:', err.message);
      pool = null;
    });
    pool = newPool;
    console.log(`✅ Conectado ao SQL Server: ${config.server}/${config.database}`);
  }
  return pool;
}

export { sql };
