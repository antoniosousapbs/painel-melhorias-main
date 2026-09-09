import { getPool, sql } from '../db/connection.js';

export type AuditEventType = 'ACESSO' | 'ERRO' | 'SYNC';

export interface AuditUser {
  userId: string;
  name: string;
  email: string;
}

/**
 * Grava um evento genérico de auditoria (acesso, erro, sync) em AuditLog.
 * Complementa DocumentVersionHistory (gerações de APF/Spec, já gravado nas rotas de
 * documents.ts) e WorkItemAuditLog (mudança de campo) — os três são unificados na
 * consulta de GET /api/audit. Nunca lança: falha de log não pode derrubar a operação
 * que está sendo auditada.
 */
export async function logAudit(evt: {
  eventType: AuditEventType;
  user?: AuditUser | null;
  workItemId?: number | null;
  detalhe?: string;
  sucesso?: boolean;
}): Promise<void> {
  try {
    const pool = await getPool();
    await pool.request()
      .input('eventType', sql.NVarChar(30), evt.eventType)
      .input('userId', sql.NVarChar(200), evt.user?.userId || null)
      .input('userName', sql.NVarChar(200), evt.user?.name || null)
      .input('userEmail', sql.NVarChar(200), evt.user?.email || null)
      .input('workItemId', sql.Int, evt.workItemId ?? null)
      .input('detalhe', sql.NVarChar(sql.MAX), evt.detalhe?.slice(0, 4000) || null)
      .input('sucesso', sql.Bit, evt.sucesso ?? true)
      .query(`
        INSERT INTO AuditLog (EventType, UserId, UserName, UserEmail, WorkItemId, Detalhe, Sucesso)
        VALUES (@eventType, @userId, @userName, @userEmail, @workItemId, @detalhe, @sucesso)
      `);
  } catch (err: any) {
    console.warn('⚠️  logAudit falhou (não-bloqueante):', err.message);
  }
}
