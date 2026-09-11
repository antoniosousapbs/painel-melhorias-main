import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool, sql } from '../db/connection.js';
import { generateApf, generateSpec, generateSpecCompleta, getDocument, getDocumentStatus, getApfParametros, updateApfParametros, refineApf, getApfElements, getKnowledgeBase, addKnowledge, updateKnowledge, deleteKnowledge, generateApfExcel, generateApfAuditoriaPdf, generateSpecPdf, calculateApf, getApfDiretrizes, upsertApfDiretriz, nextVersion, parseSintese } from '../services/document-generator.js';
import { generateSpecDocx } from '../services/spec-docx-generator.js';
import { getWorkItem, getProjectFilter } from '../services/workitem.js';
import { interviewHistoryToText } from '../utils/context.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { tryExtractUser } from '../utils/auth-user.js';

const router = Router();

// POST /api/documents/:id/generate-apf
// Body (optional): { interviewHistory: [{ role, content }] }
router.post('/:id/generate-apf', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    // Garante que o work item está dentro do escopo de projetos do usuário
    const workItem = await getWorkItem(id, (req as any).userProjects);
    if (!workItem) return res.status(404).json({ error: 'Chamado não encontrado' });
    // Convert interview history to text for use as extraContext
    const extraContext = interviewHistoryToText(req.body?.interviewHistory);
    const auditUser = tryExtractUser(req.headers.authorization);
    const result = await generateApf(id, extraContext || undefined, auditUser);
    res.json({ totalPF: result.apf.totalPF, totalPFA: result.apf.totalPFA, totalHoras: result.apf.totalHoras, elementos: result.apf.elementos.length });
  } catch (err: any) {
    console.error('APF generation error:', err.message);
    logAudit({ eventType: 'ERRO', user: tryExtractUser(req.headers.authorization), workItemId: parseInt(req.params.id) || null, detalhe: `generate-apf: ${err.message}`, sucesso: false });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/:id/generate-spec
// Body (optional): { interviewHistory: [{ role, content }] }
router.post('/:id/generate-spec', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    // Garante que o work item está dentro do escopo de projetos do usuário
    const workItem = await getWorkItem(id, (req as any).userProjects);
    if (!workItem) return res.status(404).json({ error: 'Chamado não encontrado' });
    const extraContext = interviewHistoryToText(req.body?.interviewHistory);
    const result = await generateSpec(id, extraContext || undefined);
    res.json({ success: true, length: result.content.length });
  } catch (err: any) {
    console.error('Spec generation error:', err.message);
    logAudit({ eventType: 'ERRO', user: tryExtractUser(req.headers.authorization), workItemId: parseInt(req.params.id) || null, detalhe: `generate-spec: ${err.message}`, sucesso: false });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/:id/generate-spec-docx — pipeline novo (estruturação + revisão +
// template Word). Coexiste com /generate-spec (PDF simples), não substitui.
router.post('/:id/generate-spec-docx', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const workItem = await getWorkItem(id, (req as any).userProjects);
    if (!workItem) return res.status(404).json({ error: 'Chamado não encontrado' });
    const extraContext = interviewHistoryToText(req.body?.interviewHistory);
    const auditUser = tryExtractUser(req.headers.authorization);
    const result = await generateSpecCompleta(id, extraContext || undefined, auditUser);
    res.json({
      success: true,
      requisitos: result.spec.requisitosFuncionais.length,
      regras: result.spec.regrasNegocio.length,
      avisos: result.lacunas.avisos,
      revisaoOk: result.revisao.ok,
      observacoesRevisao: result.revisao.observacoes,
    });
  } catch (err: any) {
    console.error('Spec docx generation error:', err.message);
    logAudit({ eventType: 'ERRO', user: tryExtractUser(req.headers.authorization), workItemId: parseInt(req.params.id) || null, detalhe: `generate-spec-docx: ${err.message}`, sucesso: false });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/:id/refine-apf — Refine APF via natural language instruction
router.post('/:id/refine-apf', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    // Garante que o work item está dentro do escopo de projetos do usuário
    const workItem = await getWorkItem(id, (req as any).userProjects);
    if (!workItem) return res.status(404).json({ error: 'Chamado não encontrado' });
    const { instrucao } = req.body;
    if (!instrucao || typeof instrucao !== 'string' || instrucao.trim().length === 0) {
      return res.status(400).json({ error: 'instrucao é obrigatória' });
    }
    const auditUser = tryExtractUser(req.headers.authorization);
    const result = await refineApf(id, instrucao.trim(), auditUser);
    res.json({
      totalPF: result.apf.totalPF,
      totalPFA: result.apf.totalPFA,
      totalHoras: result.apf.totalHoras,
      elementos: result.apf.elementos.length,
      changes: result.changes,
    });
  } catch (err: any) {
    console.error('APF refinement error:', err.message);
    logAudit({ eventType: 'ERRO', user: tryExtractUser(req.headers.authorization), workItemId: parseInt(req.params.id) || null, detalhe: `refine-apf: ${err.message}`, sucesso: false });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/apf-elements — Get current APF elements for display
router.get('/:id/apf-elements', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    // Garante que o work item está dentro do escopo de projetos do usuário
    const workItem = await getWorkItem(id, (req as any).userProjects);
    if (!workItem) return res.status(404).json({ error: 'Chamado não encontrado' });
    const elements = await getApfElements(id);
    if (!elements) return res.status(404).json({ error: 'Nenhuma APF encontrada para este item' });
    res.json({ elements });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/download/:tipo (APF_EXCEL, SPEC ou SPEC_DOCX)
router.get('/:id/download/:tipo', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const tipo = req.params.tipo.toUpperCase();
    if (!['APF_EXCEL', 'SPEC', 'SPEC_DOCX'].includes(tipo)) return res.status(400).json({ error: 'Tipo deve ser APF_EXCEL, SPEC ou SPEC_DOCX' });

    // Garante que o work item está dentro do escopo de projetos do usuário
    const workItem = await getWorkItem(id, (req as any).userProjects);
    if (!workItem) return res.status(404).json({ error: 'Documento não encontrado. Gere o documento primeiro.' });

    const doc = await getDocument(id, tipo);
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado. Gere o documento primeiro.' });

    if (tipo === 'APF_EXCEL') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } else if (tipo === 'SPEC_DOCX') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } else {
      res.setHeader('Content-Type', 'application/pdf');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/auditoria-pdf — trilha de auditoria completa (o que foi solicitado +
// como foi interpretado, versão a versão) sempre gerada na hora (nunca salva), pra refletir o
// histórico mais atual mesmo depois de refinamentos feitos após o último Excel gerado.
router.get('/:id/auditoria-pdf', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const workItem = await getWorkItem(id, (req as any).userProjects);
    if (!workItem) return res.status(404).json({ error: 'Chamado não encontrado' });

    const buffer = await generateApfAuditoriaPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Auditoria_APF_${id}.pdf"`);
    res.send(buffer);
  } catch (err: any) {
    console.error('Auditoria PDF error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/status - Get doc status for multiple items
router.post('/status', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
    const status = await getDocumentStatus(ids);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/apf-params
router.get('/apf-params', requireRole('Admin'), async (_req, res) => {
  try {
    const params = await getApfParametros();
    res.json(params);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/apf-params
router.put('/apf-params', requireRole('Admin'), async (req, res) => {
  try {
    const updated = await updateApfParametros(req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Diretrizes de Contagem por Team Project (contexto de negócio, complementar ao IFPUG) ───
// GET /api/documents/apf-diretrizes
router.get('/apf-diretrizes', requireRole('Admin'), async (_req, res) => {
  try {
    const items = await getApfDiretrizes();
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/apf-diretrizes/:projectCode
router.put('/apf-diretrizes/:projectCode', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const { projectCode } = req.params;
    const { diretriz } = req.body;
    if (typeof diretriz !== 'string') return res.status(400).json({ error: 'diretriz é obrigatória' });
    const user = tryExtractUser(req.headers.authorization);
    await upsertApfDiretriz(projectCode, diretriz, user?.email || user?.name);
    const items = await getApfDiretrizes();
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Knowledge Base CRUD ───
// GET /api/documents/knowledge
router.get('/knowledge', requireRole('Admin'), async (_req, res) => {
  try {
    const items = await getKnowledgeBase();
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/knowledge
router.post('/knowledge', requireRole('Admin'), async (req, res) => {
  try {
    const { categoria, titulo, conteudo, tags } = req.body;
    if (!categoria || !titulo || !conteudo) {
      return res.status(400).json({ error: 'categoria, titulo e conteudo são obrigatórios' });
    }
    const item = await addKnowledge({ categoria, titulo, conteudo, tags });
    res.json(item);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/knowledge/:id
router.put('/knowledge/:id', requireRole('Admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const item = await updateKnowledge(id, req.body);
    res.json(item);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/documents/knowledge/:id
router.delete('/knowledge/:id', requireRole('Admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    await deleteKnowledge(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE Streaming: Batch document generation via PATi chat ───
// POST /api/documents/generate/stream — body: { ids, tipo, force, interviewContext, sessionId,
// cliente, categoria, modulo, prioridade, status }. ERA GET com tudo na query string — uma
// entrevista longa com a PATi gera um `interviewContext` de vários KB, que ao ser URL-encoded
// (acentos/pontuação do português viram %XX, 3x mais bytes) estourava o limite de tamanho de
// URL do IIS/Node MUITO antes de chegar no Express — a requisição falhava na camada de rede,
// sem NENHUM log de aplicação (nem erro, nem auditoria), e a entrevista inteira era perdida.
// Corpo de POST não tem esse teto (só o limite do body-parser, configurado bem mais alto).
router.post('/generate/stream', async (req: Request, res: Response) => {
  const { ids: idsParam, tipo = 'AMBOS', force = 'false', interviewContext: interviewCtx, sessionId: reqSessionId } = req.body;
  const forceRegenerate = force === 'true' || force === true;
  const interviewContext = typeof interviewCtx === 'string' && interviewCtx.trim() ? interviewCtx.trim() : undefined;
  const sessionId = typeof reqSessionId === 'string' ? reqSessionId : undefined;

  // Extract user for audit
  const auditUser = tryExtractUser(req.headers.authorization);

  // Dashboard filters (passed from chat)
  const filterCliente = req.body.cliente as string | undefined;
  const filterCategoria = req.body.categoria as string | undefined;
  const filterModulo = req.body.modulo as string | undefined;
  const filterPrioridade = req.body.prioridade as string | undefined;
  const filterStatus = req.body.status as string | undefined;

  // Parse IDs
  let workItemIds: number[] = [];
  if (typeof idsParam === 'string' && idsParam.trim()) {
    workItemIds = idsParam.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
  } else if (Array.isArray(idsParam)) {
    workItemIds = idsParam.map((n: any) => parseInt(n)).filter(n => !isNaN(n) && n > 0);
  }

  const pool = await getPool();
  const operatorProjects = (req as any).userProjects as string[] | null | undefined;

  // If no IDs provided, find all items matching current dashboard filters
  if (workItemIds.length === 0) {
    let query = `SELECT Id FROM WorkItems WHERE 1=1`;
    const request = pool.request();
    const pf = await getProjectFilter('AND', operatorProjects);
    pf.bind(request);
    query += ` ${pf.clause}`;

    if (filterCliente) {
      const clients = filterCliente.split(',').map(c => c.trim()).filter(Boolean);
      if (clients.length > 0) {
        const conds = clients.map((_, i) => `ClienteNome = @fc${i}`);
        query += ` AND (${conds.join(' OR ')})`;
        clients.forEach((c, i) => request.input(`fc${i}`, sql.NVarChar(200), c));
      }
    }
    if (filterCategoria) { query += ` AND Categoria = @fcat`; request.input('fcat', sql.NVarChar(100), filterCategoria); }
    if (filterModulo) { query += ` AND Modulo = @fmod`; request.input('fmod', sql.NVarChar(100), filterModulo); }
    if (filterPrioridade) { query += ` AND CAST(Prioridade AS NVARCHAR(50)) = @fprio`; request.input('fprio', sql.NVarChar(50), filterPrioridade); }
    if (filterStatus) { query += ` AND DevOpsState = @fst`; request.input('fst', sql.NVarChar(50), filterStatus); }

    query += ` ORDER BY Id`;
    const result = await request.query(query);
    workItemIds = result.recordset.map((r: any) => r.Id);

    if (workItemIds.length === 0) {
      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ type: 'start', total: 0, items: 0, skipped: 0 });
      send({ type: 'done', generated: 0, errors: 0, skipped: 0, total: 0 });
      res.end();
      return;
    }
  }

  const generateApfDoc = tipo === 'APF' || tipo === 'AMBOS';
  // 'SPEC' (PDF simples, legado) só é gerado quando pedido explicitamente por esse tipo —
  // o chat da PATi agora usa 'SPEC_DOCX' (novo pipeline) tanto para especificação isolada
  // quanto dentro de 'AMBOS' (APF + Especificação).
  const generateSpecDoc = tipo === 'SPEC';
  const generateSpecDocxDoc = tipo === 'SPEC_DOCX' || tipo === 'AMBOS';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Comentário SSE periódico — mantém a conexão "viva" aos olhos de qualquer proxy reverso
  // (em produção, IIS ARR) enquanto a geração aguarda uma resposta lenta do LLM sem enviar
  // nenhum evento real. Sem isso, o proxy pode encerrar a conexão por inatividade antes do
  // backend responder, e o front exibe "Erro ao conectar com o serviço de geração de documentos".
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = () => {
    heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* conexão já encerrada */ } }, 15_000);
  };
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };

  // Validate items — check existing docs
  const validItems: { Id: number; Title: string; ClienteNome: string; hasApf: boolean; hasSpec: boolean; hasSpecDocx: boolean }[] = [];

  for (const id of workItemIds) {
    const r = pool.request().input('id', sql.Int, id);
    const pf = await getProjectFilter('AND', operatorProjects);
    pf.bind(r);
    const result = await r.query(`
        SELECT w.Id, w.Title, w.ClienteNome,
          CASE WHEN EXISTS(SELECT 1 FROM DocumentosGerados WHERE WorkItemId = w.Id AND Tipo = 'APF_EXCEL') THEN 1 ELSE 0 END as hasApf,
          CASE WHEN EXISTS(SELECT 1 FROM DocumentosGerados WHERE WorkItemId = w.Id AND Tipo = 'SPEC') THEN 1 ELSE 0 END as hasSpec,
          CASE WHEN EXISTS(SELECT 1 FROM DocumentosGerados WHERE WorkItemId = w.Id AND Tipo = 'SPEC_DOCX') THEN 1 ELSE 0 END as hasSpecDocx
        FROM WorkItems w WHERE w.Id = @id ${pf.clause}
      `);
    if (result.recordset.length > 0) {
      const row = result.recordset[0];
      validItems.push({ ...row, hasApf: row.hasApf === 1, hasSpec: row.hasSpec === 1, hasSpecDocx: row.hasSpecDocx === 1 });
    }
  }

  // Skip items that already have docs (unless force)
  let skipped = 0;
  const itemsToProcess: typeof validItems = [];

  for (const item of validItems) {
    const needsApf = generateApfDoc && (!item.hasApf || forceRegenerate);
    const needsSpec = generateSpecDoc && (!item.hasSpec || forceRegenerate);
    const needsSpecDocx = generateSpecDocxDoc && (!item.hasSpecDocx || forceRegenerate);
    if (needsApf || needsSpec || needsSpecDocx) {
      itemsToProcess.push(item);
    } else {
      skipped++;
    }
  }

  // Calculate total steps (only count steps that actually need to be done)
  let totalSteps = 0;
  for (const item of itemsToProcess) {
    if (generateApfDoc && (!item.hasApf || forceRegenerate)) totalSteps++;
    if (generateSpecDoc && (!item.hasSpec || forceRegenerate)) totalSteps++;
    if (generateSpecDocxDoc && (!item.hasSpecDocx || forceRegenerate)) totalSteps++;
  }

  send({ type: 'start', total: totalSteps, items: itemsToProcess.length, skipped });

  if (itemsToProcess.length === 0) {
    const message = skipped > 0
      ? `Todos os ${skipped} chamados já possuem documentos gerados. Para refazer, peça: "refazer APF do chamado X" ou "recontar todos".`
      : 'Nenhum chamado encontrado para geração.';
    send({ type: 'done', generated: 0, errors: 0, skipped, total: 0, message });
    res.end();
    return;
  }

  let current = 0;
  let generated = 0;
  let errors = 0;
  const results: { id: number; title: string; apf?: { totalPF: number; totalHoras: number }; spec?: boolean; error?: string }[] = [];

  startHeartbeat();
  for (const item of itemsToProcess) {
    // Generate APF (only if needed)
    if (generateApfDoc && (!item.hasApf || forceRegenerate)) {
      current++;
      const pct = Math.round((current / totalSteps) * 100);
      send({ type: 'progress', current, total: totalSteps, pct, id: item.Id, step: 'APF', title: item.Title });

      try {
        const t0 = Date.now();
        const result = await generateApf(item.Id, interviewContext, auditUser);
        const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        generated++;

        // ── Audit: save version snapshot ────────────────────────────────────
        try {
          const versao = await nextVersion(item.Id, 'APF');
          await pool.request()
            .input('wid', sql.Int, item.Id)
            .input('wtitle', sql.NVarChar(500), item.Title)
            .input('tipo', sql.NVarChar(10), 'APF')
            .input('versao', sql.Int, versao)
            .input('pf', sql.Decimal(10, 2), result.apf.totalPF)
            .input('horas', sql.Decimal(10, 2), result.apf.totalHoras)
            .input('elementos', sql.NVarChar(sql.MAX), JSON.stringify(result.apf.elementos))
            .input('ctx', sql.NVarChar(sql.MAX), interviewContext || null)
            .input('resumo', sql.NVarChar(sql.MAX), JSON.stringify(result.sintese))
            .input('uid', sql.NVarChar(200), auditUser?.userId || null)
            .input('uname', sql.NVarChar(200), auditUser?.name || null)
            .input('uemail', sql.NVarChar(200), auditUser?.email || null)
            .query(`INSERT INTO DocumentVersionHistory
              (WorkItemId,WorkItemTitle,Tipo,Versao,TotalPF,TotalHoras,ElementosJson,InterviewContext,ResumoAnalise,GeradoPorUserId,GeradoPorNome,GeradoPorEmail)
              VALUES (@wid,@wtitle,'APF',@versao,@pf,@horas,@elementos,@ctx,@resumo,@uid,@uname,@uemail)`);
          // Stamp user on DocumentosGerados (current doc)
          if (auditUser) {
            await pool.request()
              .input('wid', sql.Int, item.Id)
              .input('uid', sql.NVarChar(200), auditUser.userId)
              .input('uname', sql.NVarChar(200), auditUser.name)
              .input('uemail', sql.NVarChar(200), auditUser.email)
              .input('ctx', sql.NVarChar(sql.MAX), interviewContext || null)
              .query(`UPDATE DocumentosGerados SET GeradoPorUserId=@uid,GeradoPorNome=@uname,GeradoPorEmail=@uemail,InterviewContext=@ctx
                      WHERE WorkItemId=@wid AND Tipo='APF_EXCEL'`);
          }
        } catch (auditErr: any) {
          console.warn('⚠️  Audit save failed (non-blocking):', auditErr.message);
        }
        // ── end audit ────────────────────────────────────────────────────────

        send({
          type: 'generated',
          current, total: totalSteps, pct,
          id: item.Id,
          step: 'APF',
          title: item.Title,
          totalPF: result.apf.totalPF,
          totalHoras: result.apf.totalHoras,
          elapsed,
        });
        const existing = results.find(r => r.id === item.Id);
        if (existing) existing.apf = { totalPF: result.apf.totalPF, totalHoras: result.apf.totalHoras };
        else results.push({ id: item.Id, title: item.Title, apf: { totalPF: result.apf.totalPF, totalHoras: result.apf.totalHoras } });
      } catch (err: any) {
        errors++;
        send({ type: 'error', current, total: totalSteps, pct, id: item.Id, step: 'APF', message: err.message });
        logAudit({ eventType: 'ERRO', user: auditUser, workItemId: item.Id, detalhe: `generate-batch APF: ${err.message}`, sucesso: false });
        const existing = results.find(r => r.id === item.Id);
        if (existing) existing.error = err.message;
        else results.push({ id: item.Id, title: item.Title, error: err.message });
      }
    }

    // Generate Spec (only if needed)
    if (generateSpecDoc && (!item.hasSpec || forceRegenerate)) {
      current++;
      const pct = Math.round((current / totalSteps) * 100);
      send({ type: 'progress', current, total: totalSteps, pct, id: item.Id, step: 'SPEC', title: item.Title });

      try {
        const t0 = Date.now();
        await generateSpec(item.Id);
        const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        generated++;

        // ── Audit: save version snapshot ────────────────────────────────────
        try {
          const versao = await nextVersion(item.Id, 'SPEC');
          const specRow = await pool.request().input('wid', sql.Int, item.Id)
            .query(`SELECT TOP 1 CAST(Conteudo AS NVARCHAR(MAX)) AS Txt FROM DocumentosGerados WHERE WorkItemId = @wid AND Tipo = 'SPEC'`);
          const specText = specRow.recordset[0]?.Txt || null;
          await pool.request()
            .input('wid', sql.Int, item.Id)
            .input('wtitle', sql.NVarChar(500), item.Title)
            .input('versao', sql.Int, versao)
            .input('spec', sql.NVarChar(sql.MAX), specText)
            .input('ctx', sql.NVarChar(sql.MAX), interviewContext || null)
            .input('uid', sql.NVarChar(200), auditUser?.userId || null)
            .input('uname', sql.NVarChar(200), auditUser?.name || null)
            .input('uemail', sql.NVarChar(200), auditUser?.email || null)
            .query(`INSERT INTO DocumentVersionHistory
              (WorkItemId,WorkItemTitle,Tipo,Versao,SpecContent,InterviewContext,GeradoPorUserId,GeradoPorNome,GeradoPorEmail)
              VALUES (@wid,@wtitle,'SPEC',@versao,@spec,@ctx,@uid,@uname,@uemail)`);
          if (auditUser) {
            await pool.request()
              .input('wid', sql.Int, item.Id)
              .input('uid', sql.NVarChar(200), auditUser.userId)
              .input('uname', sql.NVarChar(200), auditUser.name)
              .input('uemail', sql.NVarChar(200), auditUser.email)
              .input('ctx', sql.NVarChar(sql.MAX), interviewContext || null)
              .query(`UPDATE DocumentosGerados SET GeradoPorUserId=@uid,GeradoPorNome=@uname,GeradoPorEmail=@uemail,InterviewContext=@ctx
                      WHERE WorkItemId=@wid AND Tipo='SPEC'`);
          }
        } catch (auditErr: any) {
          console.warn('⚠️  Audit save failed (non-blocking):', auditErr.message);
        }
        // ── end audit ────────────────────────────────────────────────────────

        send({
          type: 'generated',
          current, total: totalSteps, pct,
          id: item.Id,
          step: 'SPEC',
          title: item.Title,
          elapsed,
        });
        const existing = results.find(r => r.id === item.Id);
        if (existing) existing.spec = true;
        else results.push({ id: item.Id, title: item.Title, spec: true });
      } catch (err: any) {
        errors++;
        send({ type: 'error', current, total: totalSteps, pct, id: item.Id, step: 'SPEC', message: err.message });
        logAudit({ eventType: 'ERRO', user: auditUser, workItemId: item.Id, detalhe: `generate-batch SPEC: ${err.message}`, sucesso: false });
      }
    }

    // Generate Spec via novo pipeline (template Word) — só quando tipo=SPEC_DOCX.
    // generateSpecCompleta já persiste DocumentosGerados + DocumentVersionHistory
    // (incluindo o stamp de auditoria) internamente, então não repetimos esse bloco aqui.
    if (generateSpecDocxDoc && (!item.hasSpecDocx || forceRegenerate)) {
      current++;
      const pct = Math.round((current / totalSteps) * 100);
      send({ type: 'progress', current, total: totalSteps, pct, id: item.Id, step: 'SPEC_DOCX', title: item.Title });

      try {
        const t0 = Date.now();
        await generateSpecCompleta(item.Id, interviewContext, auditUser);
        const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        generated++;

        send({
          type: 'generated',
          current, total: totalSteps, pct,
          id: item.Id,
          step: 'SPEC_DOCX',
          title: item.Title,
          elapsed,
        });
        const existing = results.find(r => r.id === item.Id);
        if (existing) existing.spec = true;
        else results.push({ id: item.Id, title: item.Title, spec: true });
      } catch (err: any) {
        errors++;
        send({ type: 'error', current, total: totalSteps, pct, id: item.Id, step: 'SPEC_DOCX', message: err.message });
        logAudit({ eventType: 'ERRO', user: auditUser, workItemId: item.Id, detalhe: `generate-batch SPEC_DOCX: ${err.message}`, sucesso: false });
      }
    }
  }

  stopHeartbeat();
  send({
    type: 'done',
    generated,
    errors,
    skipped,
    total: totalSteps,
    results,
  });

  // Release interview session if provided
  if (sessionId) {
    try {
      const pool2 = await getPool();
      await pool2.request()
        .input('sid', sql.NVarChar(100), sessionId)
        .query(`UPDATE InterviewSessions SET Status = 'completed' WHERE SessionId = @sid`);
    } catch { /* non-blocking */ }
  }

  res.end();
});


// ─── Interview Sessions (conflict detection) ──────────────────────────────────

// POST /api/documents/sessions — register a new interview session, returns conflicts
router.post('/sessions', async (req: Request, res: Response) => {
  const { sessionId, workItemId, tipo, userName, userEmail } = req.body;
  if (!sessionId || !workItemId || !tipo) {
    return res.status(400).json({ error: 'sessionId, workItemId e tipo são obrigatórios' });
  }
  const user = tryExtractUser(req.headers.authorization);
  const userId = user?.userId || '';
  const name = userName || user?.name || 'Anônimo';
  const email = userEmail || user?.email || '';

  const pool = await getPool();

  // Mark stale sessions as abandoned (inactive > 30 min)
  await pool.request().query(`
    UPDATE InterviewSessions SET Status = 'abandoned'
    WHERE Status = 'active' AND DATEDIFF(MINUTE, LastActivity, GETDATE()) > 30
  `);

  // Check for active sessions from OTHER users for the same chamado+tipo
  const conflicts = await pool.request()
    .input('wid', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(10), tipo)
    .input('uid', sql.NVarChar(200), userId)
    .query(`
      SELECT UserName, UserEmail, StartedAt FROM InterviewSessions
      WHERE WorkItemId = @wid AND Tipo = @tipo AND Status = 'active'
        AND (UserId <> @uid OR UserId = '')
    `);

  // Upsert this session
  await pool.request()
    .input('sid', sql.NVarChar(100), sessionId)
    .input('wid', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(10), tipo)
    .input('uid', sql.NVarChar(200), userId)
    .input('uname', sql.NVarChar(200), name)
    .input('uemail', sql.NVarChar(200), email)
    .query(`
      IF EXISTS (SELECT 1 FROM InterviewSessions WHERE SessionId = @sid)
        UPDATE InterviewSessions SET Status = 'active', LastActivity = GETDATE() WHERE SessionId = @sid
      ELSE
        INSERT INTO InterviewSessions (SessionId, WorkItemId, Tipo, UserId, UserName, UserEmail)
        VALUES (@sid, @wid, @tipo, @uid, @uname, @uemail)
    `);

  res.json({ sessionId, conflicts: conflicts.recordset });
});

// PUT /api/documents/sessions/:sessionId — heartbeat (update LastActivity)
router.put('/sessions/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const pool = await getPool();
  await pool.request()
    .input('sid', sql.NVarChar(100), sessionId)
    .query(`UPDATE InterviewSessions SET LastActivity = GETDATE() WHERE SessionId = @sid AND Status = 'active'`);
  res.json({ ok: true });
});

// PUT /api/documents/sessions/:sessionId/transcript — salva o histórico da entrevista até
// agora (chamado a cada turno respondido) — permite RETOMAR de onde parou numa falha de
// LLM/rede ou se o analista fechar o navegador no meio da entrevista.
router.put('/sessions/:sessionId/transcript', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { history } = req.body;
  if (!Array.isArray(history)) return res.status(400).json({ error: 'history deve ser um array' });
  const pool = await getPool();
  await pool.request()
    .input('sid', sql.NVarChar(100), sessionId)
    .input('transcript', sql.NVarChar(sql.MAX), JSON.stringify(history))
    .query(`UPDATE InterviewSessions SET TranscriptJson = @transcript, LastActivity = GETDATE() WHERE SessionId = @sid`);
  res.json({ ok: true });
});

// GET /api/documents/sessions/resume?workItemId=X&tipo=APF — retorna a entrevista NÃO
// concluída mais recente do próprio usuário autenticado pra esse chamado+tipo (se houver),
// pra oferecer retomar em vez de começar do zero. Nunca retorna entrevista de OUTRO usuário.
router.get('/sessions/resume', async (req: Request, res: Response) => {
  const wid = parseInt(req.query.workItemId as string);
  const tipo = req.query.tipo as string;
  if (isNaN(wid) || !tipo) return res.status(400).json({ error: 'workItemId e tipo são obrigatórios' });
  const user = tryExtractUser(req.headers.authorization);
  if (!user?.userId) return res.json({ resumable: false });

  const pool = await getPool();
  const r = await pool.request()
    .input('wid', sql.Int, wid)
    .input('tipo', sql.NVarChar(10), tipo)
    .input('uid', sql.NVarChar(200), user.userId)
    .query(`
      SELECT TOP 1 SessionId, TranscriptJson, LastActivity
      FROM InterviewSessions
      WHERE WorkItemId = @wid AND Tipo = @tipo AND UserId = @uid
        AND Status IN ('active', 'abandoned') AND TranscriptJson IS NOT NULL
      ORDER BY LastActivity DESC
    `);
  const row = r.recordset[0];
  if (!row) return res.json({ resumable: false });
  let history: any[] = [];
  try { history = JSON.parse(row.TranscriptJson) || []; } catch { history = []; }
  if (history.length === 0) return res.json({ resumable: false });
  res.json({ resumable: true, sessionId: row.SessionId, history, lastActivity: row.LastActivity });
});

// DELETE /api/documents/sessions/:sessionId — release session
router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { status = 'completed' } = req.body || {};
  const safeStatus = ['completed', 'abandoned'].includes(status) ? status : 'completed';
  const pool = await getPool();
  await pool.request()
    .input('sid', sql.NVarChar(100), sessionId)
    .input('st', sql.NVarChar(20), safeStatus)
    .query(`UPDATE InterviewSessions SET Status = @st WHERE SessionId = @sid`);
  res.json({ ok: true });
});

// GET /api/documents/sessions/active/:workItemId — who else is interviewing this chamado
router.get('/sessions/active/:workItemId', async (req: Request, res: Response) => {
  const wid = parseInt(req.params.workItemId);
  if (isNaN(wid)) return res.status(400).json({ error: 'workItemId inválido' });
  const pool = await getPool();
  // Expire stale first
  await pool.request().query(`
    UPDATE InterviewSessions SET Status = 'abandoned'
    WHERE Status = 'active' AND DATEDIFF(MINUTE, LastActivity, GETDATE()) > 30
  `);
  const r = await pool.request()
    .input('wid', sql.Int, wid)
    .query(`SELECT SessionId, Tipo, UserName, UserEmail, StartedAt FROM InterviewSessions WHERE WorkItemId = @wid AND Status = 'active'`);
  res.json(r.recordset);
});

// ─── Audit ────────────────────────────────────────────────────────────────────

// GET /api/documents/audit?page=1&size=50&tipo=APF&userId=&workItemId=&from=&to=
router.get('/audit', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query.size as string) || 50));
    const offset = (page - 1) * size;
    const tipo = req.query.tipo as string | undefined;
    const userId = req.query.userId as string | undefined;
    const workItemId = req.query.workItemId ? parseInt(req.query.workItemId as string) : undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const pool = await getPool();

    // Build WHERE clause and bind params to BOTH requests (count + page)
    let where = 'WHERE 1=1';
    const bindFilters = (r: any) => {
      if (tipo) { r.input('tipo', sql.NVarChar(10), tipo); }
      if (userId) { r.input('uid', sql.NVarChar(200), userId); }
      if (workItemId) { r.input('wid', sql.Int, workItemId); }
      if (from) { r.input('from', sql.DateTime2, new Date(from)); }
      if (to) { r.input('to', sql.DateTime2, new Date(to)); }
    };
    if (tipo) where += ' AND Tipo = @tipo';
    if (userId) where += ' AND GeradoPorUserId = @uid';
    if (workItemId) where += ' AND WorkItemId = @wid';
    if (from) where += ' AND CriadoEm >= @from';
    if (to) where += ' AND CriadoEm <= @to';

    const pageReq = pool.request().input('offset', sql.Int, offset).input('size', sql.Int, size);
    const countReq = pool.request();
    bindFilters(pageReq);
    bindFilters(countReq);

    const [rows, countResult] = await Promise.all([
      pageReq.query(`
        SELECT Id, WorkItemId, WorkItemTitle, Tipo, Versao, TotalPF, TotalHoras,
               GeradoPorUserId, GeradoPorNome, GeradoPorEmail, CriadoEm
        FROM DocumentVersionHistory
        ${where}
        ORDER BY CriadoEm DESC
        OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
      `),
      countReq.query(`SELECT COUNT(*) AS Total FROM DocumentVersionHistory ${where}`),
    ]);

    res.json({
      total: countResult.recordset[0].Total,
      page,
      size,
      items: rows.recordset,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/versions/:versionId/download — regenera e baixa o documento de uma versão histórica
// (APF sempre em Excel — PDF removido; SPEC em PDF; SPEC_DOCX em Word)
router.get('/:id/versions/:versionId/download', async (req: Request, res: Response) => {
  try {
    const workItemId = parseInt(req.params.id);
    const versionId  = parseInt(req.params.versionId);
    if (isNaN(workItemId) || isNaN(versionId)) return res.status(400).json({ error: 'IDs inválidos' });

    // Garante que o work item está dentro do escopo de projetos do usuário
    const scopedWorkItem = await getWorkItem(workItemId, (req as any).userProjects);
    if (!scopedWorkItem) return res.status(404).json({ error: 'Versão não encontrada' });

    const pool = await getPool();

    // Fetch history record (validate ownership)
    const vRow = await pool.request()
      .input('vid', sql.Int, versionId)
      .input('wid', sql.Int, workItemId)
      .query(`SELECT * FROM DocumentVersionHistory WHERE Id = @vid AND WorkItemId = @wid`);
    const version = vRow.recordset[0];
    if (!version) return res.status(404).json({ error: 'Versão não encontrada' });

    // Fetch work item metadata
    const wiRow = await pool.request()
      .input('wid', sql.Int, workItemId)
      .query(`SELECT Id, Title, ClienteNome, Modulo, Description, DiscussionPati FROM WorkItems WHERE Id = @wid`);
    const wi = wiRow.recordset[0] || { Id: workItemId, Title: version.WorkItemTitle, ClienteNome: null, Modulo: null, Description: null, DiscussionPati: null };

    if (version.Tipo === 'APF') {
      if (!version.ElementosJson) return res.status(404).json({ error: 'Snapshot de elementos não disponível para esta versão' });
      const elementos = JSON.parse(version.ElementosJson);
      const params = await getApfParametros();
      const apf = calculateApf(elementos, params);

      // PDF removido — Excel é o único formato de APF hoje. Reusa a síntese estruturada JÁ
      // gravada nessa versão específica (não a mais recente) — é um snapshot histórico.
      const sinteseSnapshot = parseSintese(version.ResumoAnalise) || { oQueFoiPedido: '', oQueFoiEntendido: '', oQueFoiProjetado: '', motivoContagem: '' };
      const buf = await generateApfExcel(wi, apf, params, sinteseSnapshot, { versaoOverride: version.Versao, askAtual: version.InterviewContext });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="APF_${workItemId}_v${version.Versao}.xlsx"`);
      return res.send(buf);
    }

    if (version.Tipo === 'SPEC') {
      if (!version.SpecContent) return res.status(404).json({ error: 'Conteúdo não disponível para esta versão' });
      const buf = await generateSpecPdf(wi, version.SpecContent);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="SPEC_${workItemId}_v${version.Versao}.pdf"`);
      return res.send(buf);
    }

    if (version.Tipo === 'SPEC_DOCX') {
      if (!version.EspecificacaoJson) return res.status(404).json({ error: 'Snapshot da especificação não disponível para esta versão' });
      const spec = JSON.parse(version.EspecificacaoJson);
      const buf = await generateSpecDocx(spec, { produto: wi.Modulo });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="SPEC_${workItemId}_v${version.Versao}.docx"`);
      return res.send(buf);
    }

    res.status(400).json({ error: 'Tipo inválido' });
  } catch (err: any) {
    console.error('Version download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/versions — all versions for a work item
router.get('/:id/versions', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const pool = await getPool();
    const r = await pool.request()
      .input('wid', sql.Int, id)
      .query(`
        SELECT Id, WorkItemId, WorkItemTitle, Tipo, Versao, TotalPF, TotalHoras,
               GeradoPorNome, GeradoPorEmail, CriadoEm
        FROM DocumentVersionHistory WHERE WorkItemId = @wid
        ORDER BY Tipo, Versao DESC
      `);
    res.json(r.recordset);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
