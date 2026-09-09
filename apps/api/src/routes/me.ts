import { Router } from 'express';
import { getPool } from '../db/connection.js';
import { logAudit } from '../utils/audit.js';
import { getGraphAppToken } from '../services/graph-app-token.js';

const router = Router();

interface PhotoCacheEntry {
  data: { buffer: Buffer; contentType: string } | null;
  expiry: number;
}
const photoCache = new Map<string, PhotoCacheEntry>();
const PHOTO_HIT_TTL_MS = 24 * 60 * 60 * 1000; // foto encontrada: cache por 24h (raramente muda)
const PHOTO_MISS_TTL_MS = 60 * 60 * 1000; // sem foto/erro: retenta em 1h
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * GET /api/user-photo?email=... — proxy da foto de perfil de QUALQUER usuário do tenant,
 * via Graph app-only (client credentials), com cache em memória. Disponível a qualquer
 * usuário autenticado com acesso liberado (não é exclusivo de Admin), pois é consumido
 * tanto na Auditoria (Admin) quanto no histórico de documentos (todos os papéis).
 * Sem `AAD_CLIENT_SECRET` configurado (feature ainda não habilitada pelo admin do tenant),
 * responde 404 — o front-end já degrada para iniciais nesse caso.
 */
router.get('/user-photo', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'email inválido' });

  const cached = photoCache.get(email);
  if (cached && Date.now() < cached.expiry) {
    if (!cached.data) return res.status(404).end();
    res.set('Content-Type', cached.data.contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(cached.data.buffer);
  }

  const token = await getGraphAppToken();
  if (!token) return res.status(404).end();

  try {
    const graphResp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/photo/$value`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!graphResp.ok) {
      photoCache.set(email, { data: null, expiry: Date.now() + PHOTO_MISS_TTL_MS });
      return res.status(404).end();
    }

    const contentType = graphResp.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await graphResp.arrayBuffer());
    photoCache.set(email, { data: { buffer, contentType }, expiry: Date.now() + PHOTO_HIT_TTL_MS });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    console.error('[user-photo] erro ao buscar foto:', err);
    res.status(404).end();
  }
});

// GET /api/me — identidade + papel + projetos DevOps efetivos do usuário autenticado
router.get('/me', async (req, res) => {
  const user = (req as any).user;
  const role = (req as any).userRole as string | null;
  const userProjects = (req as any).userProjects as string[] | null;

  // Registra o acesso (chamado 1x por sessão pelo frontend, ao carregar o app) — cobre
  // tanto login bem-sucedido quanto usuário autenticado no tenant mas sem acesso liberado.
  logAudit({
    eventType: 'ACESSO',
    user: { userId: user?.oid || '', name: user?.name || '', email: user?.preferred_username || user?.upn || '' },
    detalhe: role === null ? 'Acesso negado (sem registro em UserRoles)' : `Login (role: ${role})`,
    sucesso: role !== null,
  });

  // Sem nenhum registro em UserRoles — usuário autenticado no tenant AAD, mas sem
  // acesso liberado ao sistema. Responde 200 (não 403) para o frontend conseguir
  // distinguir esse caso de um erro de rede/autenticação e mostrar a mensagem certa.
  if (role === null) {
    return res.json({
      oid: user?.oid ?? null,
      email: user?.preferred_username || user?.upn || null,
      nome: user?.name ?? null,
      role: null,
      hasAccess: false,
      projects: [],
    });
  }

  // Admin não tem restrição própria (userProjects = null) — usa a lista global configurada
  // para sincronização, que é o universo de projetos que ele pode filtrar no Dashboard.
  let projects: string[] = userProjects ?? [];
  if (userProjects === null) {
    try {
      const pool = await getPool();
      const cfg = await pool.request().query(`SELECT Valor FROM Configuracoes WHERE Chave = 'devops_projects'`);
      const raw = cfg.recordset[0]?.Valor || '';
      projects = raw.split(',').map((p: string) => p.trim()).filter(Boolean);
    } catch {
      projects = [];
    }
  }

  res.json({
    oid: user?.oid ?? null,
    email: user?.preferred_username || user?.upn || null,
    nome: user?.name ?? null,
    role,
    hasAccess: true,
    projects,
  });
});

export default router;
