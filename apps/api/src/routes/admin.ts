import { Router, Request, Response } from 'express';
import { syncFromDevOps, backfillFromDevOps, getSyncStatus, requestSyncCancel } from '../services/devops-sync.js';
import { classifyUnclassified, classifyWorkItem } from '../services/classification.js';
import { getPool, sql } from '../db/connection.js';
import { getProjectFilter } from '../services/workitem.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// POST /api/sync/trigger — disponível para qualquer usuário autenticado (Admin ou Operador).
// Escopo restrito aos projetos do usuário (null = Admin, sem restrição = sync completa).
router.post('/sync/trigger', async (req, res) => {
  try {
    const result = await syncFromDevOps(undefined, (req as any).userProjects);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/sync/cancel — solicita o cancelamento da sincronização em andamento (qualquer papel)
router.post('/sync/cancel', async (_req, res) => {
  const wasSyncing = requestSyncCancel();
  res.json({ success: true, wasSyncing });
});

// GET /api/sync/last — status da última sincronização, restrito aos projetos do usuário
// (evita que uma sync parcial de um Operador "engane" outros usuários sobre a atualidade dos dados deles).
router.get('/sync/last', async (req, res) => {
  try {
    const pool = await getPool();
    const pf = await getProjectFilter('AND', (req as any).userProjects);
    const request = pool.request();
    pf.bind(request);
    const r = await request.query(`SELECT MAX(UltimaSyncDevOps) as lastSync FROM WorkItems WHERE 1=1 ${pf.clause}`);
    res.json({ lastSync: r.recordset[0]?.lastSync ?? null, isSyncing: getSyncStatus().isSyncing });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects — lista os projetos DevOps configurados globalmente para sincronização.
// Usado para popular o seletor de "projetos visíveis" no cadastro de usuários (apenas Admin).
router.get('/projects', requireRole('Admin'), async (_req, res) => {
  try {
    const pool = await getPool();
    const cfg = await pool.request().query(`SELECT Valor FROM Configuracoes WHERE Chave = 'devops_projects'`);
    const raw = cfg.recordset[0]?.Valor || '';
    const projects = raw.split(',').map((p: string) => p.trim()).filter(Boolean);
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/backfill — Backfill Modulo + State from DevOps for ALL items in DB
router.post('/sync/backfill', requireRole('Admin'), async (_req, res) => {
  try {
    const result = await backfillFromDevOps();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/classify/trigger
router.post('/classify/trigger', requireRole('Admin'), async (req, res) => {
  try {
    const limit = req.body.limit || 50;
    const filters = req.body.filters || undefined;
    const classified = await classifyUnclassified(limit, filters);
    res.json({ success: true, classified });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/classify/:id
router.post('/classify/:id', async (req, res) => {
  try {
    const result = await classifyWorkItem(parseInt(req.params.id));
    if (!result) return res.status(422).json({ error: 'Falha ao classificar: resposta inválida do modelo' });
    res.json({ success: true, classification: result });
  } catch (err: any) {
    const status = err.message?.includes('não encontrado') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/classify/stream — SSE endpoint for real-time classification progress
router.get('/classify/stream', requireRole('Admin'), async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const reclassify = req.query.reclassify === 'true';
  const filters: any = {};
  if (req.query.cliente) filters.cliente = req.query.cliente;
  if (req.query.categoria) filters.categoria = req.query.categoria;
  if (req.query.modulo) filters.modulo = req.query.modulo;
  if (req.query.prioridade) filters.prioridade = req.query.prioridade;
  if (req.query.status) filters.status = req.query.status;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (type: string, data: any) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const pool = await getPool();

    // Get configured projects filter
    const cfgResult = await pool.request()
      .query(`SELECT Valor FROM Configuracoes WHERE Chave = 'devops_projects'`);
    const rawProjects = cfgResult.recordset[0]?.Valor || '';
    const projects = rawProjects.split(',').map((p: string) => p.trim()).filter(Boolean);

    let whereClause = reclassify
      ? 'WHERE ClassificacaoRevisada = 0'
      : 'WHERE Categoria IS NULL AND ClassificacaoRevisada = 0';
    const request = pool.request().input('limit', sql.Int, limit);

    // Add project filter
    if (projects.length > 0) {
      const projConditions = projects.map((_: string, i: number) => `DevOpsAreaPath LIKE @proj${i}`);
      whereClause += ` AND (${projConditions.join(' OR ')})`;
      projects.forEach((p: string, i: number) => {
        request.input(`proj${i}`, sql.NVarChar(200), `${p}%`);
      });
    }

    if (filters.cliente) {
      const clients = (filters.cliente as string).split(',').map((c: string) => c.trim()).filter(Boolean);
      if (clients.length > 0) {
        const conds = clients.map((_: string, i: number) => `ClienteNome = @cliente${i}`);
        whereClause += ` AND (${conds.join(' OR ')})`;
        clients.forEach((c: string, i: number) => request.input(`cliente${i}`, sql.NVarChar(200), c));
      }
    }
    if (filters.categoria) {
      whereClause += ' AND Categoria = @categoria';
      request.input('categoria', sql.NVarChar(100), filters.categoria);
    }
    if (filters.modulo) {
      whereClause += ' AND Modulo = @modulo';
      request.input('modulo', sql.NVarChar(100), filters.modulo);
    }
    if (filters.prioridade) {
      whereClause += ' AND Prioridade = @prioridade';
      request.input('prioridade', sql.NVarChar(50), filters.prioridade);
    }
    if (filters.status) {
      whereClause += ' AND DevOpsState = @status';
      request.input('status', sql.NVarChar(50), filters.status);
    }

    const items = await request.query(`
      SELECT TOP (@limit) Id, Title FROM WorkItems
      ${whereClause}
      ORDER BY ChangedDate DESC
    `);

    const total = items.recordset.length;
    send('start', { total });

    if (total === 0) {
      send('done', { classified: 0, total: 0, errors: 0 });
      res.end();
      return;
    }

    let classified = 0;
    let errors = 0;

    for (let i = 0; i < total; i++) {
      if (aborted) break;

      const row = items.recordset[i];
      const startTime = Date.now();

      try {
        send('progress', {
          current: i + 1,
          total,
          pct: Math.round(((i + 1) / total) * 100),
          id: row.Id,
          title: row.Title?.substring(0, 80),
          status: 'classifying',
        });

        const result = await classifyWorkItem(row.Id);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (result) {
          classified++;
          send('classified', {
            current: i + 1,
            total,
            pct: Math.round(((i + 1) / total) * 100),
            id: row.Id,
            title: row.Title?.substring(0, 80),
            categoria: result.categoria,
            confianca: result.confianca,
            elapsed: `${elapsed}s`,
          });
        } else {
          errors++;
          send('error', {
            current: i + 1,
            total,
            pct: Math.round(((i + 1) / total) * 100),
            id: row.Id,
            title: row.Title?.substring(0, 80),
            message: 'Failed to parse classification',
            elapsed: `${elapsed}s`,
          });
        }
      } catch (err: any) {
        errors++;
        send('error', {
          current: i + 1,
          total,
          pct: Math.round(((i + 1) / total) * 100),
          id: row.Id,
          title: row.Title?.substring(0, 80),
          message: err.message?.substring(0, 120),
        });
      }

      // Delay between items to respect Groq rate limits
      if (i < total - 1 && !aborted) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    send('done', { classified, total, errors });
  } catch (err: any) {
    send('error', { message: err.message });
  }

  res.end();
});

// GET /api/stats
router.get('/stats', requireRole('Admin'), async (_req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN ClassificacaoOrigem IS NOT NULL THEN 1 END) as classified,
        COUNT(CASE WHEN ClassificacaoOrigem IS NULL THEN 1 END) as pending,
        MAX(UltimaSyncDevOps) as lastSync
      FROM WorkItems
    `);
    const stats = r.recordset[0];

    const docR = await pool.request().query(`
      SELECT
        COUNT(*) as totalDocs,
        COUNT(CASE WHEN Tipo = 'apf' THEN 1 END) as docsApf,
        COUNT(CASE WHEN Tipo = 'spec' THEN 1 END) as docsSpec,
        COUNT(DISTINCT WorkItemId) as workItemsComDoc
      FROM DocumentosGerados
    `);
    const docStats = docR.recordset[0];

    // Check Ollama
    let ollamaOnline = false;
    try {
      const ollamaRes = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/tags`);
      ollamaOnline = ollamaRes.ok;
    } catch {}

    res.json({ ...stats, ...docStats, ollamaOnline });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prompt
router.get('/prompt', requireRole('Admin'), async (_req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT Id, Nome, Template, Ativo, AtualizadoEm FROM PromptTemplates WHERE Nome = 'classificacao_padrao'`);
    res.json(r.recordset[0] || null);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prompt
router.put('/prompt', requireRole('Admin'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('template', sql.NVarChar(sql.MAX), req.body.template)
      .input('ativo', sql.Bit, req.body.ativo !== undefined ? req.body.ativo : 1)
      .input('now', sql.DateTime2, new Date())
      .query(`UPDATE PromptTemplates SET Template = @template, Ativo = @ativo, AtualizadoEm = @now WHERE Nome = 'classificacao_padrao'`);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config
router.get('/config', requireRole('Admin'), async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`SELECT Chave, Valor, Descricao, AtualizadoEm FROM Configuracoes`);
    res.json(result.recordset);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/:chave
router.put('/config/:chave', requireRole('Admin'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('chave', sql.NVarChar(100), req.params.chave)
      .input('valor', sql.NVarChar(sql.MAX), req.body.valor)
      .input('por', sql.NVarChar(100), req.body.atualizadoPor || 'admin')
      .input('now', sql.DateTime2, new Date())
      .query(`
        UPDATE Configuracoes SET Valor = @valor, AtualizadoPor = @por, AtualizadoEm = @now
        WHERE Chave = @chave
      `);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit/:workItemId
router.get('/audit/:workItemId', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, parseInt(req.params.workItemId))
      .query(`SELECT * FROM WorkItemAuditLog WHERE WorkItemId = @id ORDER BY AlteradoEm DESC`);
    res.json(result.recordset);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
