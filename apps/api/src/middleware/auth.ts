import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPool, sql } from '../db/connection.js';

const TENANT_ID = '2ec1379e-af09-4a76-89f8-adde6b8733b4';
const CLIENT_ID = '05bd370d-71b5-41cd-87ed-aeb68a091830';
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

/**
 * Cache simples de tokens já validados via Microsoft Graph, para não bater
 * na Graph a cada requisição (o front-end reusa o mesmo token por ~55min).
 * Chave: token bruto. Valor: timestamp de expiração do cache (ms).
 */
const validatedTokenCache = new Map<string, number>();
const VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Valida o token chamando o Microsoft Graph (/v1.0/me). Se a Microsoft aceitar
 * o token (200), ele é genuíno — delegamos a verificação criptográfica real
 * para a própria Microsoft, em vez de validar a assinatura localmente via JWKS.
 * (Necessário porque o front-end hoje só solicita o escopo `User.Read` do Graph,
 * então o token tem aud=Microsoft Graph, não da nossa própria API.)
 */
async function isValidViaGraph(token: string): Promise<boolean> {
  const cachedExpiry = validatedTokenCache.get(token);
  if (cachedExpiry && Date.now() < cachedExpiry) return true;

  const resp = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.ok) {
    validatedTokenCache.set(token, Date.now() + VALIDATION_CACHE_TTL_MS);
    return true;
  }
  return false;
}

/** Verifica um JWT bruto (string) e retorna o payload decodificado. Rejeita se inválido/expirado. */
export async function verifyTokenString(token: string): Promise<any> {
  const decoded = jwt.decode(token, { complete: true });
  const payload = decoded?.payload as any;

  if (!payload) throw new Error('Token malformado');
  if (payload.tid !== TENANT_ID) throw new Error('Tenant inválido');
  if (payload.appid !== CLIENT_ID && payload.azp !== CLIENT_ID) throw new Error('Aplicação (appid) inválida');
  if (payload.aud !== GRAPH_APP_ID && payload.aud !== CLIENT_ID) throw new Error('Audiência inválida');
  if (payload.exp && Date.now() >= payload.exp * 1000) throw new Error('Token expirado');

  const valid = await isValidViaGraph(token);
  if (!valid) throw new Error('Token rejeitado pela Microsoft (Graph)');

  return payload;
}

export function validateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = authHeader.split(' ')[1];

  verifyTokenString(token)
    .then((decoded) => {
      (req as any).user = decoded;
      next();
    })
    .catch((err) => {
      console.error('[validateToken] falha na verificação do token:', err?.message || err);
      res.status(401).json({ error: 'Token inválido' });
    });
}

/**
 * Consulta a tabela UserRoles para um usuário já decodificado (oid/e-mail) e devolve o Role.
 * Retorna `null` quando o usuário NÃO tem nenhum registro em UserRoles — ou seja, não tem
 * acesso ao sistema (é apenas um usuário autenticado no tenant AAD, sem cadastro liberado).
 * NUNCA mais assume 'Operador' como padrão implícito.
 */
export async function resolveRoleForUser(user: any): Promise<string | null> {
  const oid: string | undefined = user?.oid;
  const email: string = (user?.preferred_username || user?.upn || user?.email || '').toLowerCase();

  try {
    const pool = await getPool();

    if (oid) {
      const byOid = await pool.request()
        .input('oid', sql.UniqueIdentifier, oid)
        .query('SELECT TOP 1 Role FROM UserRoles WHERE AadObjectId = @oid');
      if (byOid.recordset.length > 0) return byOid.recordset[0].Role;
    }

    if (email) {
      const byEmail = await pool.request()
        .input('email', sql.NVarChar, email)
        .query('SELECT TOP 1 Id, Role FROM UserRoles WHERE LOWER(Email) = @email');
      if (byEmail.recordset.length > 0) {
        const row = byEmail.recordset[0];
        if (oid) {
          await pool.request()
            .input('id', sql.Int, row.Id)
            .input('oid', sql.UniqueIdentifier, oid)
            .query('UPDATE UserRoles SET AadObjectId = @oid WHERE Id = @id AND AadObjectId IS NULL');
        }
        return row.Role;
      }
    }
  } catch (err) {
    console.error('Erro ao resolver papel do usuário:', err);
  }

  return null;
}

/**
 * Retorna os projetos DevOps (UserProjects.ProjectCode) associados a um usuário Operador.
 * Admin não usa isso (sem restrição). Usuário sem registro em UserProjects → array vazio
 * (Operador sem projeto associado não enxerga nenhum work item).
 */
export async function resolveProjectsForUser(user: any): Promise<string[]> {
  const oid: string | undefined = user?.oid;
  const email: string = (user?.preferred_username || user?.upn || user?.email || '').toLowerCase();

  try {
    const pool = await getPool();
    let userId: number | null = null;

    if (oid) {
      const byOid = await pool.request()
        .input('oid', sql.UniqueIdentifier, oid)
        .query('SELECT TOP 1 Id FROM UserRoles WHERE AadObjectId = @oid');
      if (byOid.recordset.length > 0) userId = byOid.recordset[0].Id;
    }
    if (userId === null && email) {
      const byEmail = await pool.request()
        .input('email', sql.NVarChar, email)
        .query('SELECT TOP 1 Id FROM UserRoles WHERE LOWER(Email) = @email');
      if (byEmail.recordset.length > 0) userId = byEmail.recordset[0].Id;
    }
    if (userId === null) return [];

    const projects = await pool.request()
      .input('userId', sql.Int, userId)
      .query('SELECT ProjectCode FROM UserProjects WHERE UserId = @userId ORDER BY ProjectCode');
    return projects.recordset.map((r: any) => r.ProjectCode);
  } catch (err) {
    console.error('Erro ao resolver projetos do usuário:', err);
    return [];
  }
}

/**
 * Resolve o papel (Role) do usuário autenticado a partir da tabela UserRoles.
 * Faz o bind automático do AadObjectId (oid) no primeiro login, casando por e-mail.
 * Deve rodar sempre APÓS validateToken. NÃO bloqueia a requisição aqui — isso é
 * responsabilidade do middleware `requireAnyAccess`, registrado logo em seguida em
 * index.ts. Aqui apenas resolvemos o estado: `req.userRole` pode ser `null` quando o
 * usuário não tem NENHUM registro em UserRoles (sem acesso ao sistema).
 *
 * Também resolve `req.userProjects`: `null` significa sem restrição (Admin) OU sem
 * acesso (role null — nesse caso o valor é irrelevante pois a requisição já foi/será
 * bloqueada), um array (possivelmente vazio) restringe os work items visíveis a esses
 * projetos DevOps (Operador).
 */
export async function resolveRole(req: Request, _res: Response, next: NextFunction) {
  const user = (req as any).user;
  const role = await resolveRoleForUser(user);
  (req as any).userRole = role;
  (req as any).userProjects = (role === 'Admin' || role === null) ? null : await resolveProjectsForUser(user);
  next();
}

/**
 * Resolve o escopo de sincronização de um usuário já decodificado (fora do middleware
 * chain — usado por /api/sync/stream, que não passa por resolveRole porque o EventSource
 * não envia header Authorization). `null` = sem restrição (Admin, sync completa).
 * Array (possivelmente vazio) = Operador, sync restrita a esses projetos.
 * Lança erro se o usuário não tiver nenhum acesso (sem registro em UserRoles) — quem
 * chama deve responder 401/403 e nunca disparar uma sincronização.
 */
export async function resolveUserSyncScope(user: any): Promise<string[] | null> {
  const role = await resolveRoleForUser(user);
  if (role === null) throw new Error('Usuário sem acesso liberado ao sistema');
  if (role === 'Admin') return null;
  return await resolveProjectsForUser(user);
}

/** Bloqueia a rota caso o papel do usuário (resolveRole) não esteja entre os permitidos. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any).userRole;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'Acesso negado para o seu perfil' });
    }
    next();
  };
}

/**
 * Bloqueia QUALQUER rota /api/* para usuários sem nenhum registro em UserRoles
 * (`req.userRole === null`). Deve ser montado logo após `resolveRole`, ANTES de todas
 * as rotas de negócio — exceto `/api/me`, que precisa continuar acessível para o
 * frontend conseguir perguntar "eu tenho acesso?" e mostrar a mensagem de bloqueio
 * correta (em vez de um erro genérico).
 */
export function requireAnyAccess(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/me' && (req as any).userRole === null) {
    return next();
  }
  if ((req as any).userRole === null) {
    return res.status(403).json({ error: 'ACCESS_DENIED', message: 'Sua conta não tem acesso liberado ao Dashboard de Melhorias.' });
  }
  next();
}

