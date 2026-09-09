import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool, sql } from '../db/connection.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// Auditoria completa é sensível (mostra ações de TODOS os usuários, acessos e erros) —
// restrita a Admin, mesmo padrão já usado em Configurações/gestão de usuários.
router.use(requireRole('Admin'));

// GET /api/audit?eventType=&workItemId=&user=&from=&to=&page=&size=
// Unifica 3 fontes numa única linha do tempo: DocumentVersionHistory (gerações de
// APF/Spec), WorkItemAuditLog (mudança de campo do chamado) e AuditLog (acesso/erro/sync).
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query.size as string) || 50));
    const offset = (page - 1) * size;
    const eventType = req.query.eventType as string | undefined;
    const workItemId = req.query.workItemId ? parseInt(req.query.workItemId as string) : undefined;
    const user = req.query.user as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const pool = await getPool();

    const cte = `
      WITH UnifiedAudit AS (
        SELECT
          CONCAT('DOC-', Id) AS UniqueId, 'DOC' AS Source, 'DOC_' + Tipo AS EventType,
          CriadoEm AS Data, WorkItemId, WorkItemTitle,
          GeradoPorNome AS UsuarioNome, GeradoPorEmail AS UsuarioEmail,
          -- Literais com acento/travessão SEMPRE com prefixo N — sem isso o SQL Server
          -- guarda como VARCHAR (codepage sem suporte a "→"), virando "?" na exibição.
          CASE WHEN Tipo = 'APF' THEN CONCAT(N'Versão ', Versao, N' — ', TotalPF, N' PF, ', TotalHoras, N'h')
               ELSE CONCAT(N'Versão ', Versao) END AS Detalhe,
          CAST(1 AS BIT) AS Sucesso
        FROM DocumentVersionHistory

        UNION ALL

        SELECT
          CONCAT('CAMPO-', Id), 'CAMPO', 'CAMPO_ALTERADO',
          AlteradoEm, WorkItemId, NULL,
          AlteradoPor, AlteradoPorEmail,
          -- Nome do campo traduzido pra rótulo legível + valores booleanos do "dispensar
          -- APF" traduzidos pra Sim/Não (preserva o motivo, se houver, depois de "Sim").
          CONCAT(
            CASE Campo
              WHEN 'Modulo' THEN N'Módulo'
              WHEN 'ImpactoOperacao' THEN N'Impacto na Operação'
              WHEN 'EsforcoAPF' THEN N'Esforço APF'
              WHEN 'ApfDispensado' THEN N'APF Dispensado'
              ELSE Campo
            END,
            N': ',
            CASE
              WHEN Campo = 'ApfDispensado' AND ValorAnterior = 'true' THEN N'Sim'
              WHEN Campo = 'ApfDispensado' AND ValorAnterior = 'false' THEN N'Não'
              ELSE ISNULL(ValorAnterior, N'—')
            END,
            N' → ',
            CASE
              WHEN Campo = 'ApfDispensado' AND ValorNovo LIKE 'true%' THEN N'Sim' + SUBSTRING(ValorNovo, 5, 500)
              WHEN Campo = 'ApfDispensado' AND ValorNovo = 'false' THEN N'Não'
              ELSE ISNULL(ValorNovo, N'—')
            END
          ),
          CAST(1 AS BIT)
        FROM WorkItemAuditLog

        UNION ALL

        SELECT
          CONCAT('SYS-', Id), 'SYS', EventType,
          CriadoEm, WorkItemId,
          -- Só usa o rótulo genérico quando NÃO há chamado associado — se houver WorkItemId,
          -- deixa NULL pra o COALESCE (fora da CTE) resolver o título real via LEFT JOIN.
          CASE WHEN WorkItemId IS NULL THEN
            CASE EventType
              WHEN 'ACESSO' THEN N'Acesso ao sistema'
              WHEN 'SYNC' THEN N'Sincronização DevOps'
              WHEN 'ERRO' THEN N'Erro do sistema'
              ELSE EventType
            END
          END,
          UserName, UserEmail,
          Detalhe,
          Sucesso
        FROM AuditLog
      )
      SELECT ua.UniqueId, ua.Source, ua.EventType, ua.Data, ua.WorkItemId,
             COALESCE(ua.WorkItemTitle, w.Title, CONCAT(N'Chamado #', ua.WorkItemId), ua.EventType) AS WorkItemTitle,
             ua.UsuarioNome, ua.UsuarioEmail, ua.Detalhe, ua.Sucesso
      FROM UnifiedAudit ua
      LEFT JOIN WorkItems w ON w.Id = ua.WorkItemId
      WHERE 1=1
    `;
    const countCte = cte.replace(
      /SELECT ua\.UniqueId[\s\S]*?WHERE 1=1/,
      'SELECT COUNT(*) AS Total FROM UnifiedAudit ua LEFT JOIN WorkItems w ON w.Id = ua.WorkItemId WHERE 1=1'
    );

    let filterSql = '';
    if (eventType) filterSql += ' AND ua.EventType = @eventType';
    if (workItemId) filterSql += ' AND ua.WorkItemId = @workItemId';
    if (user) filterSql += ' AND (ua.UsuarioNome LIKE @user OR ua.UsuarioEmail LIKE @user)';
    if (from) filterSql += ' AND ua.Data >= @from';
    if (to) filterSql += ' AND ua.Data <= @to';

    const bind = (r: any) => {
      if (eventType) r.input('eventType', sql.NVarChar(30), eventType);
      if (workItemId) r.input('workItemId', sql.Int, workItemId);
      if (user) r.input('user', sql.NVarChar(200), `%${user}%`);
      if (from) r.input('from', sql.DateTime2, new Date(from));
      if (to) r.input('to', sql.DateTime2, new Date(to));
    };

    const pageReq = pool.request();
    bind(pageReq);
    const countReq = pool.request();
    bind(countReq);

    pageReq.input('offset', sql.Int, offset).input('size', sql.Int, size);
    const [rows, countResult] = await Promise.all([
      pageReq.query(`${cte}${filterSql} ORDER BY ua.Data DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`),
      countReq.query(`${countCte}${filterSql}`),
    ]);

    res.json({ total: countResult.recordset[0].Total, page, size, items: rows.recordset });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
