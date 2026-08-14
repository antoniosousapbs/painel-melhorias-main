import { Router } from 'express';
import { getPool } from '../db/connection.js';

const router = Router();

// GET /api/me — identidade + papel + projetos DevOps efetivos do usuário autenticado
router.get('/me', async (req, res) => {
  const user = (req as any).user;
  const role = (req as any).userRole as string | null;
  const userProjects = (req as any).userProjects as string[] | null;

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
