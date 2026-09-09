import { Router } from 'express';
import { listWorkItems, getWorkItem, updateWorkItem, getKpis, getFilterOptions, getChartData, getNextPriority } from '../services/workitem.js';
import { tryExtractUser } from '../utils/auth-user.js';

const router = Router();

/**
 * Combina a restrição de acesso do usuário (req.userProjects — null para Admin,
 * array para Operador) com o filtro de projeto escolhido na UI (?projeto=A,B).
 * Admin sem escolha → sem restrição. Admin com escolha → usa exatamente a escolha.
 * Operador sempre fica restrito à própria lista; se escolher um subconjunto, intersecta
 * (nunca amplia além do que já tem acesso).
 */
function resolveEffectiveProjects(req: any): string[] | null {
  const userProjects = req.userProjects as string[] | null;
  const requestedRaw = req.query.projeto as string | undefined;
  const requested = requestedRaw ? requestedRaw.split(',').map((s: string) => s.trim()).filter(Boolean) : [];

  if (userProjects === null) {
    return requested.length > 0 ? requested : null;
  }
  if (requested.length === 0) return userProjects;
  return userProjects.filter(p => requested.includes(p));
}

// GET /api/workitems
router.get('/', async (req, res) => {
  try {
    const result = await listWorkItems({
      page: parseInt(req.query.page as string) || 1,
      size: parseInt(req.query.size as string) || 50,
      cliente: req.query.cliente as string,
      categoria: req.query.categoria as string,
      modulo: req.query.modulo as string,
      prioridade: req.query.prioridade as string,
      status: req.query.status as string,
      caseType: req.query.caseType as string,
      responsavel: req.query.responsavel as string,
      apf: req.query.apf as 'com' | 'sem' | undefined,
      search: req.query.search as string,
      encerrados: req.query.encerrados === 'true',
    }, resolveEffectiveProjects(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workitems/filters
router.get('/filters', async (req, res) => {
  try {
    const options = await getFilterOptions(resolveEffectiveProjects(req), req.query.encerrados === 'true');
    res.json(options);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workitems/kpis
router.get('/kpis', async (req, res) => {
  try {
    const { cliente, categoria, modulo, status, caseType, responsavel, apf } = req.query as Record<string, string | undefined>;
    const kpis = await getKpis({ cliente, categoria, modulo, status, caseType, responsavel, apf: apf as 'com' | 'sem' | undefined }, resolveEffectiveProjects(req));
    res.json(kpis);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workitems/charts
router.get('/charts', async (req, res) => {
  try {
    const { cliente, categoria, modulo, prioridade, status, caseType, responsavel, apf } = req.query as Record<string, string | undefined>;
    const data = await getChartData({ cliente, categoria, modulo, prioridade, status, caseType, responsavel, apf: apf as 'com' | 'sem' | undefined }, resolveEffectiveProjects(req));
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workitems/next-priority?cliente=X
router.get('/next-priority', async (req, res) => {
  try {
    const cliente = req.query.cliente as string;
    if (!cliente) return res.status(400).json({ error: 'cliente is required' });
    const next = await getNextPriority(cliente, resolveEffectiveProjects(req));
    res.json({ next });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workitems/:id
router.get('/:id', async (req, res) => {
  try {
    const item = await getWorkItem(parseInt(req.params.id), resolveEffectiveProjects(req));
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/workitems/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Garante que o item está dentro do escopo de projetos do usuário antes de alterar
    const existing = await getWorkItem(id, resolveEffectiveProjects(req));
    if (!existing) return res.status(404).json({ error: 'Not found' });

    // Atribui a edição ao usuário autenticado de verdade (JWT) — nunca mais 'admin' fixo
    // nem depende do frontend enviar `revisadoPor` (que nunca era enviado, na prática).
    const user = tryExtractUser(req.headers.authorization);

    const updated = await updateWorkItem(id, {
      categoria: req.body.categoria,
      tipo: req.body.tipo,
      modulo: req.body.modulo,
      prioridade: req.body.prioridade,
      impactoOperacao: req.body.impactoOperacao,
      esforcoAPF: req.body.esforcoAPF,
      apfDispensado: req.body.apfDispensado,
      apfDispensadoMotivo: req.body.apfDispensadoMotivo,
      revisadoPor: user?.name || req.body.revisadoPor || 'PATi',
      revisadoPorEmail: user?.email,
    });
    res.json(updated);
  } catch (err: any) {
    const isConflict = /já está em uso|deve ser um número inteiro|Informe o motivo|Informe o esforço/.test(err.message || '');
    res.status(isConflict ? 409 : 500).json({ error: err.message });
  }
});

export default router;
