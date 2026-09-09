import { getPool, sql } from '../db/connection.js';

/* ─── In-memory cache for project config (avoids DB roundtrip per request) ─── */
let _projectsCache: string[] | null = null;
let _projectsCacheTs = 0;
const PROJECTS_CACHE_TTL = 60_000; // 1 minute

/** Reads configured projects and returns a WHERE fragment + bind function.
 *  `operatorProjects`: quando informado (não undefined/null), restringe adicionalmente
 *  aos projetos do usuário Operador. Array vazio → força zero resultados. */
export async function getProjectFilter(prefix = 'AND', operatorProjects?: string[] | null) {
  if (operatorProjects !== undefined && operatorProjects !== null) {
    if (operatorProjects.length === 0) return { clause: `${prefix} 1 = 0`, bind: (_r: any) => {} };
    const conditions = operatorProjects.map((_: string, i: number) => `DevOpsAreaPath LIKE @opProj${i}`);
    const clause = `${prefix} (${conditions.join(' OR ')})`;
    const bind = (request: any) => {
      operatorProjects.forEach((p: string, i: number) => {
        request.input(`opProj${i}`, sql.NVarChar(200), `${p}%`);
      });
    };
    return { clause, bind };
  }

  const now = Date.now();
  let projects: string[];

  if (_projectsCache && now - _projectsCacheTs < PROJECTS_CACHE_TTL) {
    projects = _projectsCache;
  } else {
    const pool = await getPool();
    const cfg = await pool.request()
      .query(`SELECT Valor FROM Configuracoes WHERE Chave = 'devops_projects'`);
    const raw = cfg.recordset[0]?.Valor || '';
    projects = raw.split(',').map((p: string) => p.trim()).filter(Boolean);
    _projectsCache = projects;
    _projectsCacheTs = now;
  }
  if (projects.length === 0) return { clause: '', bind: (_r: any) => {} };

  // Build: DevOpsAreaPath LIKE 'Proj1%' OR DevOpsAreaPath LIKE 'Proj2%'
  const conditions = projects.map((_: string, i: number) => `DevOpsAreaPath LIKE @proj${i}`);
  const clause = `${prefix} (${conditions.join(' OR ')})`;
  const bind = (request: any) => {
    projects.forEach((p: string, i: number) => {
      request.input(`proj${i}`, sql.NVarChar(200), `${p}%`);
    });
  };
  return { clause, bind };
}

export interface WorkItemFilters {
  page?: number;
  size?: number;
  cliente?: string;
  categoria?: string;
  modulo?: string;
  prioridade?: string;
  status?: string;
  caseType?: string;
  responsavel?: string;
  apf?: 'com' | 'sem';
  search?: string;
  /** true = só chamados ENCERRADOS (DevOpsState='Closed'), usado pela aba Histórico.
   * Ausente/false = comportamento padrão do Dashboard (exclui Closed e Canceled). */
  encerrados?: boolean;
}

export interface WorkItemUpdate {
  categoria?: string;
  tipo?: string;
  modulo?: string;
  prioridade?: number | null;
  impactoOperacao?: string;
  esforcoAPF?: number;
  apfDispensado?: boolean;
  apfDispensadoMotivo?: string;
  revisadoPor?: string;
  revisadoPorEmail?: string;
}

export async function getNextPriority(cliente: string, operatorProjects?: string[] | null) {
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);
  const req = pool.request();
  pf.bind(req);
  req.input('cliente', sql.NVarChar, `%${cliente}%`);
  const result = await req.query(`
    SELECT ISNULL(MAX(Prioridade), -1) + 1 as next
    FROM WorkItems
    WHERE ClienteNome LIKE @cliente ${pf.clause}
  `);
  return result.recordset[0]?.next ?? 0;
}

export async function listWorkItems(filters: WorkItemFilters, operatorProjects?: string[] | null) {
  const pool = await getPool();

  // ── Fast path: pure numeric search → direct ID lookup, bypass all filters ──
  if (filters.search && /^\d+$/.test(filters.search.trim())) {
    const exactId = parseInt(filters.search.trim(), 10);
    const pf = await getProjectFilter('AND', operatorProjects);
    const r = pool.request().input('id', sql.Int, exactId);
    pf.bind(r);
    const result = await r.query(`SELECT * FROM WorkItems WHERE Id = @id ${pf.clause}`);
    return { items: result.recordset, total: result.recordset.length, totalPages: 1 };
  }

  const page = filters.page || 1;
  const size = filters.size || 50;
  const offset = (page - 1) * size;

  const pf = await getProjectFilter('AND', operatorProjects);
  // Chamados encerrados (Closed) ficam no banco (histórico), mas só aparecem na aba
  // Histórico — o Dashboard/KPIs/gráficos padrão continuam mostrando só backlog ativo.
  // No Histórico, só faz sentido listar chamados que tiveram uma contagem de APF real
  // (é o objetivo declarado da tela — Esforço APF sempre deve vir preenchido aqui;
  // um chamado fechado com só uma Especificação gerada, sem APF, não pertence a esta
  // lista, senão a coluna Esforço aparece vazia pra parte dos registros).
  let where = filters.encerrados
    ? `WHERE DevOpsState = 'Closed' AND EXISTS (SELECT 1 FROM DocumentVersionHistory dvh WHERE dvh.WorkItemId = WorkItems.Id AND dvh.Tipo = 'APF') ${pf.clause}`
    : `WHERE DevOpsState NOT IN ('Canceled', 'Closed') ${pf.clause}`;
  const request = pool.request();
  pf.bind(request);

  if (filters.cliente) {
    where += ' AND ClienteNome LIKE @cliente';
    request.input('cliente', sql.NVarChar, `%${filters.cliente}%`);
  }
  if (filters.categoria) {
    const categorias = filters.categoria.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (categorias.length === 1) {
      where += ' AND Categoria = @categoria';
      request.input('categoria', sql.NVarChar, categorias[0]);
    } else {
      const conds = categorias.map((s: string, i: number) => { request.input(`categoria${i}`, sql.NVarChar, s); return `@categoria${i}`; });
      where += ` AND Categoria IN (${conds.join(',')})`;
    }
  }
  if (filters.modulo) {
    where += ' AND Modulo = @modulo';
    request.input('modulo', sql.NVarChar, filters.modulo);
  }
  if (filters.prioridade) {
    where += ' AND Prioridade = @prioridade';
    request.input('prioridade', sql.NVarChar, filters.prioridade);
  }
  if (filters.status) {
    const statuses = filters.status.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      where += ' AND SupportCaseStatus = @status';
      request.input('status', sql.NVarChar, statuses[0]);
    } else {
      const conds = statuses.map((s: string, i: number) => { request.input(`status${i}`, sql.NVarChar, s); return `@status${i}`; });
      where += ` AND SupportCaseStatus IN (${conds.join(',')})`;
    }
  }
  if (filters.caseType) {
    const types = filters.caseType.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (types.length === 1) {
      where += ' AND SupportCaseType = @caseType';
      request.input('caseType', sql.NVarChar, types[0]);
    } else {
      const conds = types.map((s: string, i: number) => { request.input(`ct${i}`, sql.NVarChar, s); return `@ct${i}`; });
      where += ` AND SupportCaseType IN (${conds.join(',')})`;
    }
  }
  if (filters.responsavel) {
    const responsaveis = filters.responsavel.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (responsaveis.length === 1) {
      where += ' AND AssignedTo = @responsavel';
      request.input('responsavel', sql.NVarChar, responsaveis[0]);
    } else {
      const conds = responsaveis.map((s: string, i: number) => { request.input(`resp${i}`, sql.NVarChar, s); return `@resp${i}`; });
      where += ` AND AssignedTo IN (${conds.join(',')})`;
    }
  }
  if (filters.search) {
    where += ' AND (Title LIKE @search OR CAST(Id AS NVARCHAR) LIKE @search)';
    request.input('search', sql.NVarChar, `%${filters.search}%`);
  }
  if (filters.apf === 'com') {
    where += ' AND EsforcoAPF IS NOT NULL AND EsforcoAPF > 0';
  } else if (filters.apf === 'sem') {
    where += ' AND (EsforcoAPF IS NULL OR EsforcoAPF = 0)';
  }

  request.input('offset', sql.Int, offset);
  request.input('size', sql.Int, size);

  const dataResult = await request.query(`
    SELECT * FROM WorkItems ${where}
    ORDER BY ChangedDate DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
  `);

  // Count total
  const countRequest = pool.request();
  pf.bind(countRequest);
  if (filters.cliente) countRequest.input('cliente', sql.NVarChar, `%${filters.cliente}%`);
  if (filters.categoria) {
    const categorias = filters.categoria.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (categorias.length === 1) {
      countRequest.input('categoria', sql.NVarChar, categorias[0]);
    } else {
      categorias.forEach((s: string, i: number) => countRequest.input(`categoria${i}`, sql.NVarChar, s));
    }
  }
  if (filters.modulo) countRequest.input('modulo', sql.NVarChar, filters.modulo);
  if (filters.prioridade) countRequest.input('prioridade', sql.NVarChar, filters.prioridade);
  if (filters.status) {
    const statuses = filters.status.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      countRequest.input('status', sql.NVarChar, statuses[0]);
    } else {
      statuses.forEach((s: string, i: number) => countRequest.input(`status${i}`, sql.NVarChar, s));
    }
  }
  if (filters.caseType) {
    const types = filters.caseType.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (types.length === 1) {
      countRequest.input('caseType', sql.NVarChar, types[0]);
    } else {
      types.forEach((s: string, i: number) => countRequest.input(`ct${i}`, sql.NVarChar, s));
    }
  }
  if (filters.responsavel) {
    const responsaveis = filters.responsavel.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (responsaveis.length === 1) {
      countRequest.input('responsavel', sql.NVarChar, responsaveis[0]);
    } else {
      responsaveis.forEach((s: string, i: number) => countRequest.input(`resp${i}`, sql.NVarChar, s));
    }
  }
  if (filters.search) countRequest.input('search', sql.NVarChar, `%${filters.search}%`);

  const countResult = await countRequest.query(`SELECT COUNT(*) as total FROM WorkItems ${where}`);

  return {
    items: dataResult.recordset,
    total: countResult.recordset[0].total,
    page,
    size,
    totalPages: Math.ceil(countResult.recordset[0].total / size),
  };
}

export async function getWorkItem(id: number, operatorProjects?: string[] | null) {
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);
  const request = pool.request().input('id', sql.Int, id);
  pf.bind(request);
  const result = await request.query(`SELECT * FROM WorkItems WHERE Id = @id ${pf.clause}`);
  return result.recordset[0] || null;
}

export async function updateWorkItem(id: number, data: WorkItemUpdate) {
  const pool = await getPool();

  // Get current values for audit
  const current = await getWorkItem(id);
  if (!current) throw new Error('Work item not found');

  if (data.apfDispensado === true) {
    if (!data.apfDispensadoMotivo?.trim()) {
      throw new Error('Informe o motivo para dispensar este chamado de APF');
    }
    const esforcoEfetivo = data.esforcoAPF !== undefined ? data.esforcoAPF : current.EsforcoAPF;
    if (!(Number(esforcoEfetivo) > 0)) {
      throw new Error('Informe o esforço estimado (em horas, maior que zero) para dispensar este chamado de APF');
    }
  }

  const sets: string[] = [];
  const request = pool.request().input('id', sql.Int, id);

  const auditEntries: { campo: string; anterior: string; novo: string }[] = [];

  if (data.categoria !== undefined) {
    sets.push('Categoria = @categoria');
    request.input('categoria', sql.NVarChar(50), data.categoria);
    if (current.Categoria !== data.categoria) {
      auditEntries.push({ campo: 'Categoria', anterior: current.Categoria || '', novo: data.categoria });
    }
  }
  if (data.tipo !== undefined) {
    sets.push('Tipo = @tipo');
    request.input('tipo', sql.NVarChar(100), data.tipo);
    if (current.Tipo !== data.tipo) {
      auditEntries.push({ campo: 'Tipo', anterior: current.Tipo || '', novo: data.tipo });
    }
  }
  if (data.modulo !== undefined) {
    sets.push('Modulo = @modulo');
    request.input('modulo', sql.NVarChar(100), data.modulo);
    if (current.Modulo !== data.modulo) {
      auditEntries.push({ campo: 'Modulo', anterior: current.Modulo || '', novo: data.modulo });
    }
  }
  if (data.prioridade !== undefined) {
    if (data.prioridade !== null) {
      if (!Number.isInteger(data.prioridade)) {
        throw new Error('Prioridade deve ser um número inteiro');
      }
      // Nunca pode repetir para o mesmo cliente — checagem de aplicação além do índice único no
      // banco (UQ_WorkItems_Cliente_Prioridade), para devolver uma mensagem clara ao usuário.
      const dupe = await pool.request()
        .input('cliente', sql.NVarChar(200), current.ClienteNome)
        .input('prioridade', sql.Int, data.prioridade)
        .input('id', sql.Int, id)
        .query(`SELECT TOP 1 Id, Title FROM WorkItems WHERE ClienteNome = @cliente AND Prioridade = @prioridade AND Id <> @id`);
      if (dupe.recordset.length > 0) {
        const other = dupe.recordset[0];
        throw new Error(`Prioridade ${data.prioridade} já está em uso pelo chamado #${other.Id} (${other.Title}) deste cliente. Escolha outro número.`);
      }
    }
    sets.push('Prioridade = @prioridade');
    request.input('prioridade', sql.Int, data.prioridade);
    if (String(current.Prioridade ?? '') !== String(data.prioridade ?? '')) {
      auditEntries.push({ campo: 'Prioridade', anterior: String(current.Prioridade ?? ''), novo: String(data.prioridade ?? '') });
    }
  }
  if (data.impactoOperacao !== undefined) {
    sets.push('ImpactoOperacao = @impacto');
    request.input('impacto', sql.NVarChar(50), data.impactoOperacao);
    if (current.ImpactoOperacao !== data.impactoOperacao) {
      auditEntries.push({ campo: 'ImpactoOperacao', anterior: current.ImpactoOperacao || '', novo: data.impactoOperacao });
    }
  }
  if (data.esforcoAPF !== undefined) {
    sets.push('EsforcoAPF = @apf');
    request.input('apf', sql.Decimal(10, 2), data.esforcoAPF);
    if (current.EsforcoAPF !== data.esforcoAPF) {
      auditEntries.push({ campo: 'EsforcoAPF', anterior: String(current.EsforcoAPF || ''), novo: String(data.esforcoAPF) });
    }
  }
  if (data.apfDispensado !== undefined) {
    sets.push('ApfDispensado = @apfDispensado');
    request.input('apfDispensado', sql.Bit, data.apfDispensado);
    if (Boolean(current.ApfDispensado) !== data.apfDispensado) {
      auditEntries.push({
        campo: 'ApfDispensado',
        anterior: String(Boolean(current.ApfDispensado)),
        novo: `${data.apfDispensado}${data.apfDispensado && data.apfDispensadoMotivo ? ` (Motivo: ${data.apfDispensadoMotivo})` : ''}`,
      });
    }
    if (data.apfDispensado) {
      sets.push('ApfDispensadoMotivo = @apfDispensadoMotivo');
      request.input('apfDispensadoMotivo', sql.NVarChar(500), data.apfDispensadoMotivo || null);
      sets.push('ApfDispensadoPor = @apfDispensadoPor');
      request.input('apfDispensadoPor', sql.NVarChar(100), data.revisadoPor || 'PATi');
      sets.push('ApfDispensadoEm = @apfDispensadoEm');
      request.input('apfDispensadoEm', sql.DateTime2, new Date());
    } else {
      // Revertendo a dispensa — limpa os campos de auditoria da dispensa anterior.
      sets.push('ApfDispensadoMotivo = NULL, ApfDispensadoPor = NULL, ApfDispensadoEm = NULL');
    }
  }

  if (sets.length === 0) return current;

  // Mark as manually revised
  sets.push('ClassificacaoRevisada = 1');
  sets.push('ClassificacaoRevisadaPor = @revisadoPor');
  sets.push('ClassificacaoRevisadaEm = @now');
  sets.push('AtualizadoEm = @now');
  request.input('revisadoPor', sql.NVarChar(100), data.revisadoPor || 'PATi');
  request.input('now', sql.DateTime2, new Date());

  await request.query(`UPDATE WorkItems SET ${sets.join(', ')} WHERE Id = @id`);

  // Write audit log
  for (const entry of auditEntries) {
    await pool.request()
      .input('workItemId', sql.Int, id)
      .input('campo', sql.NVarChar(50), entry.campo)
      .input('anterior', sql.NVarChar(500), entry.anterior)
      .input('novo', sql.NVarChar(500), entry.novo)
      .input('por', sql.NVarChar(100), data.revisadoPor || 'PATi')
      .input('porEmail', sql.NVarChar(200), data.revisadoPorEmail || null)
      .query(`
        INSERT INTO WorkItemAuditLog (WorkItemId, Campo, ValorAnterior, ValorNovo, AlteradoPor, AlteradoPorEmail)
        VALUES (@workItemId, @campo, @anterior, @novo, @por, @porEmail)
      `);
  }

  return await getWorkItem(id);
}

export async function getKpis(
  filters?: { cliente?: string; categoria?: string; modulo?: string; status?: string; caseType?: string; responsavel?: string; apf?: 'com' | 'sem' },
  operatorProjects?: string[] | null
) {
  const pool = await getPool();
  const request = pool.request();
  const pf = await getProjectFilter('AND', operatorProjects);

  let where = `WHERE DevOpsState NOT IN ('Canceled', 'Closed') ${pf.clause}`;
  pf.bind(request);
  if (filters?.cliente) {
    where += ' AND ClienteNome LIKE @cliente';
    request.input('cliente', sql.NVarChar, `%${filters.cliente}%`);
  }
  if (filters?.categoria) {
    const categorias = filters.categoria.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (categorias.length === 1) {
      where += ' AND Categoria = @categoria';
      request.input('categoria', sql.NVarChar, categorias[0]);
    } else {
      const conds = categorias.map((s: string, i: number) => { request.input(`categoria${i}`, sql.NVarChar, s); return `@categoria${i}`; });
      where += ` AND Categoria IN (${conds.join(',')})`;
    }
  }
  if (filters?.modulo) {
    where += ' AND Modulo = @modulo';
    request.input('modulo', sql.NVarChar, filters.modulo);
  }
  if (filters?.status) {
    const statuses = filters.status.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      where += ' AND SupportCaseStatus = @status';
      request.input('status', sql.NVarChar, statuses[0]);
    } else {
      const conds = statuses.map((s: string, i: number) => { request.input(`status${i}`, sql.NVarChar, s); return `@status${i}`; });
      where += ` AND SupportCaseStatus IN (${conds.join(',')})`;
    }
  }
  if (filters?.caseType) {
    const types = filters.caseType.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (types.length === 1) {
      where += ' AND SupportCaseType = @caseType';
      request.input('caseType', sql.NVarChar, types[0]);
    } else {
      const conds = types.map((s: string, i: number) => { request.input(`ct${i}`, sql.NVarChar, s); return `@ct${i}`; });
      where += ` AND SupportCaseType IN (${conds.join(',')})`;
    }
  }
  if (filters?.responsavel) {
    const responsaveis = filters.responsavel.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (responsaveis.length === 1) {
      where += ' AND AssignedTo = @responsavel';
      request.input('responsavel', sql.NVarChar, responsaveis[0]);
    } else {
      const conds = responsaveis.map((s: string, i: number) => { request.input(`resp${i}`, sql.NVarChar, s); return `@resp${i}`; });
      where += ` AND AssignedTo IN (${conds.join(',')})`;
    }
  }
  if (filters?.apf === 'com') {
    where += ' AND EsforcoAPF IS NOT NULL AND EsforcoAPF > 0';
  } else if (filters?.apf === 'sem') {
    where += ' AND (EsforcoAPF IS NULL OR EsforcoAPF = 0)';
  }

  const result = await request.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN Categoria = 'Produto' THEN 1 ELSE 0 END) as produto,
      SUM(CASE WHEN Categoria = 'Hibrido' THEN 1 ELSE 0 END) as hibrido,
      SUM(CASE WHEN Categoria = 'Cliente' THEN 1 ELSE 0 END) as cliente,
      SUM(CASE WHEN Categoria = 'Info Insuficiente' OR Categoria IS NULL THEN 1 ELSE 0 END) as infoInsuficiente,
      SUM(ISNULL(EsforcoAPF, 0)) as totalAPF,
      SUM(CASE WHEN EsforcoAPF IS NOT NULL AND EsforcoAPF > 0 THEN 1 ELSE 0 END) as comApf,
      SUM(CASE WHEN EsforcoAPF IS NULL OR EsforcoAPF = 0 THEN 1 ELSE 0 END) as semApf,
      SUM(CASE WHEN ClassificacaoRevisada = 1 THEN 1 ELSE 0 END) as revisados,
      SUM(CASE WHEN Categoria IS NOT NULL THEN 1 ELSE 0 END) as classificados
    FROM WorkItems ${where}
  `);

  const row = result.recordset[0];
  const total = row.total || 1;

  return {
    total: row.total,
    produto: row.produto,
    hibrido: row.hibrido,
    cliente: row.cliente,
    infoInsuficiente: row.infoInsuficiente,
    pctProduto: ((row.produto / total) * 100).toFixed(2),
    pctHibrido: ((row.hibrido / total) * 100).toFixed(2),
    pctCliente: ((row.cliente / total) * 100).toFixed(2),
    totalAPF: row.totalAPF,
    comApf: row.comApf,
    semApf: row.semApf,
    revisados: row.revisados,
    classificados: row.classificados,
  };
}

export async function getChartData(filters?: { cliente?: string; categoria?: string; modulo?: string; prioridade?: string; status?: string; caseType?: string; responsavel?: string; apf?: 'com' | 'sem' }, operatorProjects?: string[] | null) {
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);

  let paramIdx = 0;
  const buildReq = () => {
    const tag = paramIdx++;
    const r = pool.request();
    pf.bind(r);
    let where = `WHERE DevOpsState NOT IN ('Canceled', 'Closed') ${pf.clause || ''}`;
    if (filters?.cliente) {
      where += ` AND ClienteNome LIKE @cliente${tag}`;
      r.input(`cliente${tag}`, sql.NVarChar, `%${filters.cliente}%`);
    }
    if (filters?.categoria) {
      const categorias = filters.categoria.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (categorias.length === 1) {
        where += ` AND Categoria = @categoria${tag}`;
        r.input(`categoria${tag}`, sql.NVarChar, categorias[0]);
      } else {
        const conds = categorias.map((s: string, i: number) => { r.input(`cat${tag}_${i}`, sql.NVarChar, s); return `@cat${tag}_${i}`; });
        where += ` AND Categoria IN (${conds.join(',')})`;
      }
    }
    if (filters?.modulo) {
      where += ` AND Modulo = @modulo${tag}`;
      r.input(`modulo${tag}`, sql.NVarChar, filters.modulo);
    }
    if (filters?.prioridade) {
      where += ` AND Prioridade = @prioridade${tag}`;
      r.input(`prioridade${tag}`, sql.NVarChar, filters.prioridade);
    }
    if (filters?.status) {
      const statuses = filters.status.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        where += ` AND SupportCaseStatus = @status${tag}`;
        r.input(`status${tag}`, sql.NVarChar, statuses[0]);
      } else {
        const conds = statuses.map((s: string, i: number) => { r.input(`st${tag}_${i}`, sql.NVarChar, s); return `@st${tag}_${i}`; });
        where += ` AND SupportCaseStatus IN (${conds.join(',')})`;
      }
    }
    if (filters?.caseType) {
      const types = filters.caseType.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (types.length === 1) {
        where += ` AND SupportCaseType = @ct${tag}`;
        r.input(`ct${tag}`, sql.NVarChar, types[0]);
      } else {
        const conds = types.map((s: string, i: number) => { r.input(`ct${tag}_${i}`, sql.NVarChar, s); return `@ct${tag}_${i}`; });
        where += ` AND SupportCaseType IN (${conds.join(',')})`;
      }
    }
    if (filters?.responsavel) {
      const responsaveis = filters.responsavel.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (responsaveis.length === 1) {
        where += ` AND AssignedTo = @resp${tag}`;
        r.input(`resp${tag}`, sql.NVarChar, responsaveis[0]);
      } else {
        const conds = responsaveis.map((s: string, i: number) => { r.input(`resp${tag}_${i}`, sql.NVarChar, s); return `@resp${tag}_${i}`; });
        where += ` AND AssignedTo IN (${conds.join(',')})`;
      }
    }
    if (filters?.apf === 'com') {
      where += ' AND EsforcoAPF IS NOT NULL AND EsforcoAPF > 0';
    } else if (filters?.apf === 'sem') {
      where += ' AND (EsforcoAPF IS NULL OR EsforcoAPF = 0)';
    }
    return { r, where };
  };

  const cat = buildReq();
  const mod = buildReq();
  const prio = buildReq();
  const cli = buildReq();
  const modRank = buildReq();
  const timeline = buildReq();

  const [catResult, modResult, prioResult, cliResult, modRankResult, timelineResult] = await Promise.all([
    cat.r.query(`
      SELECT
        Categoria as label,
        COUNT(*) as value
      FROM WorkItems ${cat.where} AND Categoria IS NOT NULL AND Categoria != ''
      GROUP BY Categoria
      ORDER BY value DESC
    `),
    mod.r.query(`
      SELECT
        SupportCaseStatus as label,
        COUNT(*) as value
      FROM WorkItems ${mod.where} AND SupportCaseStatus IS NOT NULL AND SupportCaseStatus != ''
      GROUP BY SupportCaseStatus
      ORDER BY value DESC
    `),
    prio.r.query(`
      SELECT
        SupportCaseType as label,
        COUNT(*) as value
      FROM WorkItems ${prio.where} AND SupportCaseType IS NOT NULL AND SupportCaseType != ''
      GROUP BY SupportCaseType
      ORDER BY value DESC
    `),
    cli.r.query(`
      SELECT TOP 100
        ClienteNome as label,
        COUNT(*) as value
      FROM WorkItems ${cli.where} AND ClienteNome IS NOT NULL AND ClienteNome != ''
      GROUP BY ClienteNome
      ORDER BY value DESC
    `),
    modRank.r.query(`
      SELECT TOP 100
        Modulo as label,
        COUNT(*) as value
      FROM WorkItems ${modRank.where} AND Modulo IS NOT NULL AND Modulo != ''
      GROUP BY Modulo
      ORDER BY value DESC
    `),
    timeline.r.query(`
      SELECT
        FORMAT(CreatedDate, 'yyyy-MM') as label,
        COUNT(*) as value
      FROM WorkItems ${timeline.where} AND CreatedDate IS NOT NULL
      GROUP BY FORMAT(CreatedDate, 'yyyy-MM')
      ORDER BY label ASC
    `),
  ]);

  return {
    categoria: catResult.recordset,
    caseStatus: modResult.recordset,
    caseType: prioResult.recordset,
    clienteRanking: cliResult.recordset,
    moduloRanking: modRankResult.recordset,
    timeline: timelineResult.recordset,
  };
}

export async function getFilterOptions(operatorProjects?: string[] | null, encerrados?: boolean) {
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);

  // Mesmo recorte usado em listWorkItems: por padrão só backlog ativo (nunca Canceled/Closed);
  // no modo "encerrados" (aba Histórico), só chamados fechados com uma contagem de APF real —
  // sem isso, os combos de filtro traziam valores de chamados sem Esforço APF preenchido.
  const stateFilter = encerrados
    ? `DevOpsState = 'Closed' AND EXISTS (SELECT 1 FROM DocumentVersionHistory dvh WHERE dvh.WorkItemId = WorkItems.Id AND dvh.Tipo = 'APF')`
    : `DevOpsState NOT IN ('Canceled', 'Closed')`;

  const mkReq = () => { const r = pool.request(); pf.bind(r); return r; };

  const [categorias, modulos, prioridades, estados, clientes, caseTypes, responsaveis] = await Promise.all([
    mkReq().query(`SELECT DISTINCT Categoria FROM WorkItems WHERE ${stateFilter} AND Categoria IS NOT NULL ${pf.clause} ORDER BY Categoria`),
    mkReq().query(`SELECT DISTINCT Modulo FROM WorkItems WHERE ${stateFilter} AND Modulo IS NOT NULL AND Modulo != '' ${pf.clause} ORDER BY Modulo`),
    mkReq().query(`SELECT DISTINCT Prioridade FROM WorkItems WHERE ${stateFilter} AND Prioridade IS NOT NULL ${pf.clause} ORDER BY Prioridade`),
    mkReq().query(`SELECT DISTINCT SupportCaseStatus FROM WorkItems WHERE ${stateFilter} AND SupportCaseStatus IS NOT NULL AND SupportCaseStatus != '' ${pf.clause} ORDER BY SupportCaseStatus`),
    mkReq().query(`SELECT DISTINCT ClienteNome FROM WorkItems WHERE ${stateFilter} AND ClienteNome IS NOT NULL AND ClienteNome != '' ${pf.clause} ORDER BY ClienteNome`),
    mkReq().query(`SELECT DISTINCT SupportCaseType FROM WorkItems WHERE ${stateFilter} AND SupportCaseType IS NOT NULL AND SupportCaseType != '' ${pf.clause} ORDER BY SupportCaseType`),
    mkReq().query(`SELECT DISTINCT AssignedTo FROM WorkItems WHERE ${stateFilter} AND AssignedTo IS NOT NULL AND AssignedTo != '' ${pf.clause} ORDER BY AssignedTo`),
  ]);

  return {
    categorias: categorias.recordset.map((r: any) => r.Categoria),
    modulos: modulos.recordset.map((r: any) => r.Modulo),
    prioridades: prioridades.recordset.map((r: any) => r.Prioridade),
    estados: estados.recordset.map((r: any) => r.SupportCaseStatus),
    clientes: clientes.recordset.map((r: any) => r.ClienteNome),
    caseTypes: caseTypes.recordset.map((r: any) => r.SupportCaseType),
    responsaveis: responsaveis.recordset.map((r: any) => r.AssignedTo),
  };
}
