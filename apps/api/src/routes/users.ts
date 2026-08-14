import { Router } from 'express';
import { getPool, sql } from '../db/connection.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// Todas as rotas abaixo são restritas a Admin
router.use(requireRole('Admin'));

// GET /api/users — lista todos os usuários, seus papéis e projetos DevOps associados
router.get('/', async (_req, res) => {
  try {
    const pool = await getPool();
    const usersResult = await pool.request().query(
      'SELECT Id, AadObjectId, Email, Nome, Role, CriadoEm, AtualizadoEm FROM UserRoles ORDER BY Email'
    );
    const projectsResult = await pool.request().query(
      'SELECT UserId, ProjectCode FROM UserProjects ORDER BY ProjectCode'
    );
    const projectsByUser = new Map<number, string[]>();
    for (const row of projectsResult.recordset) {
      const list = projectsByUser.get(row.UserId) || [];
      list.push(row.ProjectCode);
      projectsByUser.set(row.UserId, list);
    }
    const users = usersResult.recordset.map((u: any) => ({
      ...u,
      Projects: projectsByUser.get(u.Id) || [],
    }));
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Substitui a lista de projetos DevOps associados a um usuário Operador. */
async function replaceUserProjects(pool: any, userId: number, projects: string[] | undefined) {
  if (projects === undefined) return;
  await pool.request().input('userId', sql.Int, userId).query('DELETE FROM UserProjects WHERE UserId = @userId');
  const unique = Array.from(new Set(projects.map(p => p.trim()).filter(Boolean)));
  for (const code of unique) {
    await pool.request()
      .input('userId', sql.Int, userId)
      .input('code', sql.NVarChar(200), code)
      .query('INSERT INTO UserProjects (UserId, ProjectCode) VALUES (@userId, @code)');
  }
}

// POST /api/users — adiciona um novo usuário (por e-mail; o oid é vinculado no 1º login)
router.post('/', async (req, res) => {
  try {
    const { email, role, projects } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'email e role são obrigatórios' });
    if (!['Admin', 'Operador'].includes(role)) return res.status(400).json({ error: 'role inválido' });

    const pool = await getPool();
    const existing = await pool.request()
      .input('email', sql.NVarChar, email.toLowerCase())
      .query('SELECT Id FROM UserRoles WHERE LOWER(Email) = @email');
    if (existing.recordset.length > 0) return res.status(409).json({ error: 'E-mail já cadastrado' });

    const result = await pool.request()
      .input('email', sql.NVarChar, email)
      .input('role', sql.NVarChar, role)
      .query('INSERT INTO UserRoles (Email, Role) OUTPUT INSERTED.* VALUES (@email, @role)');
    const created = result.recordset[0];

    if (role === 'Operador' && Array.isArray(projects)) {
      await replaceUserProjects(pool, created.Id, projects);
    }

    res.status(201).json({ ...created, Projects: role === 'Operador' && Array.isArray(projects) ? projects : [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id — altera o papel de um usuário e/ou seus projetos DevOps associados
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { role, projects } = req.body;
    if (!['Admin', 'Operador'].includes(role)) return res.status(400).json({ error: 'role inválido' });

    const pool = await getPool();

    // Evita remover o último Admin restante
    if (role !== 'Admin') {
      const admins = await pool.request().query("SELECT COUNT(*) as c FROM UserRoles WHERE Role = 'Admin'");
      const target = await pool.request().input('id', sql.Int, id).query('SELECT Role FROM UserRoles WHERE Id = @id');
      if (target.recordset[0]?.Role === 'Admin' && admins.recordset[0].c <= 1) {
        return res.status(400).json({ error: 'Não é possível remover o último Admin' });
      }
    }

    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('role', sql.NVarChar, role)
      .query('UPDATE UserRoles SET Role = @role, AtualizadoEm = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE Id = @id');
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

    // Admin não tem restrição de projeto — limpa qualquer associação residual.
    // Operador: substitui pela lista enviada (quando informada).
    if (role === 'Admin') {
      await replaceUserProjects(pool, id, []);
    } else {
      await replaceUserProjects(pool, id, projects);
    }

    const projectsResult = await pool.request().input('id', sql.Int, id).query('SELECT ProjectCode FROM UserProjects WHERE UserId = @id ORDER BY ProjectCode');
    res.json({ ...result.recordset[0], Projects: projectsResult.recordset.map((r: any) => r.ProjectCode) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id — remove o vínculo de papel de um usuário
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const pool = await getPool();

    const target = await pool.request().input('id', sql.Int, id).query('SELECT Role FROM UserRoles WHERE Id = @id');
    if (target.recordset.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (target.recordset[0].Role === 'Admin') {
      const admins = await pool.request().query("SELECT COUNT(*) as c FROM UserRoles WHERE Role = 'Admin'");
      if (admins.recordset[0].c <= 1) return res.status(400).json({ error: 'Não é possível remover o último Admin' });
    }

    await pool.request().input('id', sql.Int, id).query('DELETE FROM UserRoles WHERE Id = @id');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
