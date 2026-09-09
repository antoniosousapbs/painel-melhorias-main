import jwt from 'jsonwebtoken';

export interface AuthUser {
  userId: string;
  name: string;
  email: string;
}

/** Decodifica (sem verificar assinatura — só usado após validateToken já ter validado a
 * requisição) o JWT do header Authorization pra extrair identidade, usada em auditoria. */
export function tryExtractUser(authHeader?: string): AuthUser | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.decode(authHeader.slice(7)) as any;
    if (!decoded) return null;
    return {
      userId: decoded.oid || decoded.sub || '',
      name: decoded.name || decoded.unique_name || '',
      email: decoded.preferred_username || decoded.upn || decoded.email || '',
    };
  } catch { return null; }
}
