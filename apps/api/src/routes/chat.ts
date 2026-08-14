import { Router } from 'express';
import type { Request, Response } from 'express';
import { buildDataContext, queryForQuestion, streamChat, streamInterview, getInterviewContext } from '../services/chat.js';
import { getApfElementsSummary } from '../services/document-generator.js';

const router = Router();

/**
 * POST /api/chat  — SSE streaming chat with PATi
 * Body: { message: string, history?: { role: string, content: string }[] }
 */
router.post('/chat', async (req: Request, res: Response) => {
  const { message, history = [], filters = {} } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  // Limit message length
  const userMessage = message.trim().slice(0, 1000);

  // Sanitize filters
  const dashFilters: Record<string,string> = {};
  for (const key of ['cliente', 'categoria', 'modulo', 'prioridade', 'status']) {
    if (filters[key] && typeof filters[key] === 'string') dashFilters[key] = filters[key];
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const t0 = Date.now();
    const operatorProjects = (req as any).userProjects as string[] | null | undefined;

    // 1. Build data context + focused query IN PARALLEL
    res.write(`data: ${JSON.stringify({ type: 'status', text: 'Consultando dados...' })}\n\n`);
    const hasFilters = Object.keys(dashFilters).length > 0;
    const [dataContext, extraContext] = await Promise.all([
      buildDataContext(hasFilters ? dashFilters : undefined, operatorProjects),
      queryForQuestion(userMessage, hasFilters ? dashFilters : undefined, history, operatorProjects),
    ]);

    const t1 = Date.now();
    console.log(`⏱️  [chat] SQL queries: ${t1 - t0}ms`);

    // 2. Stream LLM response
    res.write(`data: ${JSON.stringify({ type: 'status', text: 'Gerando resposta...' })}\n\n`);

    let fullResponse = '';
    let firstChunk = true;
    for await (const chunk of streamChat(userMessage, history, dataContext, extraContext)) {
      if (firstChunk) {
        console.log(`⏱️  [chat] Time to first token: ${Date.now() - t1}ms`);
        firstChunk = false;
      }
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
    }

    console.log(`⏱️  [chat] Total streaming: ${Date.now() - t1}ms | Tokens: ~${fullResponse.length} chars | Total: ${Date.now() - t0}ms`);
    res.write(`data: ${JSON.stringify({ type: 'done', text: fullResponse })}\n\n`);
  } catch (err: any) {
    console.error('Chat error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', text: err.message || 'Erro interno' })}\n\n`);
  } finally {
    res.end();
  }
});

/**
 * GET /api/chat/interview/context — Debug: returns raw context injected into interview system prompt
 * Query: ?workItemId=322675
 */
router.get('/chat/interview/context', async (req: Request, res: Response) => {
  const id = parseInt(req.query.workItemId as string);
  if (!id || isNaN(id)) {
    res.status(400).json({ error: 'workItemId query param is required' });
    return;
  }
  try {
    const ctx = await getInterviewContext(id, (req as any).userProjects);
    res.json(ctx);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /api/chat/interview — SSE streaming interview for APF/Spec generation
 * Body: { workItemId: number, tipo: string, history: { role: string, content: string }[] }
 */
router.post('/chat/interview', async (req: Request, res: Response) => {
  const { workItemId, tipo = 'APF', history = [], bulk = false, filters = {} } = req.body;

  if (!bulk && (!workItemId || typeof workItemId !== 'number')) {
    res.status(400).json({ error: 'workItemId is required' });
    return;
  }

  // Sanitize filters
  const safeFilters: Record<string, string> = {};
  for (const key of ['cliente', 'categoria', 'modulo', 'prioridade', 'status']) {
    if (filters[key] && typeof filters[key] === 'string') safeFilters[key] = filters[key];
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    let fullResponse = '';
    for await (const chunk of streamInterview(workItemId || 0, tipo, history, bulk ? safeFilters : undefined, (req as any).userProjects)) {
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
    }

    // Check if the LLM decided it has enough info (look for the trigger marker)
    const ready = fullResponse.includes('[PRONTO_PARA_GERAR]');
    // Chamado (não-bulk, tipo APF) que já tem elementos contados → front deve concluir via
    // refinamento incremental (refineApf) em vez de regenerar tudo do zero.
    const isRefinement = !bulk && tipo === 'APF' && workItemId
      ? (await getApfElementsSummary(workItemId)).length > 0
      : false;
    res.write(`data: ${JSON.stringify({ type: 'done', text: fullResponse, ready, isRefinement })}\n\n`);
  } catch (err: any) {
    console.error('Interview error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', text: err.message || 'Erro interno' })}\n\n`);
  } finally {
    res.end();
  }
});

export default router;
