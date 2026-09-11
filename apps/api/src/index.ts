import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import cron from 'node-cron';

import workitemsRouter from './routes/workitems.js';
import adminRouter from './routes/admin.js';
import chatRouter from './routes/chat.js';
import documentsRouter from './routes/documents.js';
import meRouter from './routes/me.js';
import usersRouter from './routes/users.js';
import llmRouter from './routes/llm.js';
import auditRouter from './routes/audit.js';
import { syncFromDevOps } from './services/devops-sync.js';
import { validateToken, resolveRole, requireAnyAccess, verifyTokenString, resolveUserSyncScope } from './middleware/auth.js';
import { logAudit } from './utils/audit.js';

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

// Sem isso, uma promise rejeitada sem catch (ou uma exceção fora de um handler Express)
// derruba o processo inteiro sem log algum — todos os usuários caem junto, sem rastro.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection (não derrubou o processo):', reason);
  logAudit({ eventType: 'ERRO', detalhe: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`, sucesso: false });
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception — encerrando para o PM2 reiniciar limpo:', err);
  logAudit({ eventType: 'ERRO', detalhe: `uncaughtException: ${err.message}`, sucesso: false });
  process.exit(1);
});

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

app.use(cors());
// Limite padrão do Express (100kb) já cobria o corpo normal da API, mas entrevistas muito
// longas com a PATi (interviewContext compilado) podem passar disso — sem essa folga, o corpo
// de POST cairia no mesmo problema que a query string tinha (requisição rejeitada sem log).
app.use(express.json({ limit: '5mb' }));

// Health check (público, sem autenticação)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Manual sync trigger with SSE progress stream — registrado ANTES do middleware
// global porque EventSource (usado no Dashboard) não envia header Authorization;
// o token chega via query string e é validado manualmente aqui. Disponível para
// qualquer usuário autenticado (Admin ou Operador) — não é mais exclusivo de Admin.
// A sync é restrita aos projetos do usuário (Admin = sem restrição, sync completa;
// Operador = só os projetos associados a ele, sem apagar dados de outros projetos).
app.get('/api/sync/stream', async (req, res) => {
  let scopeProjects: string[] | null;
  try {
    const token = req.query.token as string;
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    const decoded = await verifyTokenString(token);
    scopeProjects = await resolveUserSyncScope(decoded);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const result = await syncFromDevOps((event) => {
      if (!aborted) send(event);
    }, scopeProjects);
    if (!aborted && !result.cancelled) send({ type: 'done', ...result });
  } catch (err: any) {
    if (!aborted) send({ type: 'error', message: err.message });
  }
  res.end();
});

// A partir daqui, toda rota /api/* exige token AAD válido + papel resolvido.
// requireAnyAccess bloqueia com 403 quem não tem NENHUM registro em UserRoles
// (usuário autenticado no tenant, mas sem cadastro liberado) — exceto /api/me,
// que precisa responder normalmente para o frontend mostrar a tela de bloqueio.
app.use('/api', validateToken, resolveRole, requireAnyAccess);

// Routes
app.use('/api/workitems', workitemsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api', meRouter);
app.use('/api/users', usersRouter);
app.use('/api', adminRouter);
app.use('/api', chatRouter);
app.use('/api', llmRouter);
app.use('/api/audit', auditRouter);

// Manual sync trigger (REST) — mesma ação do /api/sync/trigger (admin.ts), mantido por compatibilidade.
// Disponível para qualquer usuário autenticado — a sincronização não é mais exclusiva de Admin,
// mas fica restrita aos projetos do usuário (req.userProjects, resolvido pelo middleware acima).
app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncFromDevOps(undefined, (req as any).userProjects);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduled sync every 2 hours — sempre sync COMPLETA (scopeProjects null explícito),
// independente de qualquer usuário. É essa que mantém o banco saneado (remove itens
// cancelados/fora do escopo global), então nunca deve ser restrita.
cron.schedule('0 */2 * * *', async () => {
  console.log('⏰ Running scheduled DevOps sync...');
  try {
    const result = await syncFromDevOps(undefined, null);
    console.log(`✅ Sync complete: ${result.total} items (${result.created} new, ${result.updated} updated)`);
  } catch (err: any) {
    console.error('❌ Scheduled sync failed:', err);
    logAudit({ eventType: 'SYNC', detalhe: `Sync agendada falhou: ${err.message}`, sucesso: false });
  }
});

// Middleware de erro do Express — rede de segurança final para exceções que escaparem
// dos try/catch de cada rota (a maioria já responde 500 localmente e nunca chega aqui).
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('❌ Erro não tratado na rota:', err);
  logAudit({ eventType: 'ERRO', detalhe: `${req.method} ${req.path}: ${err?.message || err}`, sucesso: false });
  if (!res.headersSent) res.status(500).json({ error: 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
});
