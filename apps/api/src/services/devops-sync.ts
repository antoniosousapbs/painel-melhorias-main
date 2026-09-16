import { getPool, sql } from '../db/connection.js';

const PAT = process.env.DEVOPS_PAT!;
const ORG = process.env.DEVOPS_ORG!;
const PROJECT = process.env.DEVOPS_PROJECT || '';
const ORG_URL = `https://dev.azure.com/${ORG}/_apis`;
// Comments API requires project-scoped URL
const PROJECT_URL = PROJECT ? `https://dev.azure.com/${ORG}/${PROJECT}/_apis` : ORG_URL;

function authHeader(): Record<string, string> {
  const token = Buffer.from(`:${PAT}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
  };
}

function extractClient(title: string): string {
  const match = title.match(/\[([^\]]+)\]/);
  if (match) {
    const val = match[1].trim();
    if (!/^\d+$/.test(val)) return val;
  }
  return '';
}

/**
 * Normaliza o responsável (System.AssignedTo) para sempre "Primeiro Nome + Último Nome"
 * (nunca o nome completo, nunca e-mail). Aceita tanto o objeto de identidade do DevOps
 * ({ displayName, uniqueName }) quanto strings legadas ("Nome <email>" ou só o e-mail).
 * Rodar isso no sync consolida automaticamente registros que ora vinham com e-mail,
 * ora com nome completo, para o mesmo usuário — sem precisar de lógica extra na leitura.
 */
function normalizeAssignedTo(raw: any): string | null {
  if (!raw) return null;
  let display: string = typeof raw === 'string' ? raw : (raw.displayName || raw.uniqueName || '');
  if (!display) return null;
  display = display.trim();

  // "Nome Completo <email@dominio.com>" → mantém só a parte antes de "<"
  const angleMatch = display.match(/^(.*?)\s*<[^>]+>$/);
  if (angleMatch && angleMatch[1].trim()) display = angleMatch[1].trim();

  // Se o que sobrou ainda é um e-mail puro, deriva o nome da parte local (antes do @)
  const emailMatch = display.match(/^([^\s@]+)@[^\s@]+$/);
  if (emailMatch) display = emailMatch[1].replace(/[._]+/g, ' ');

  const parts = display.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const first = cap(parts[0]);
  const lastPart = parts.length > 1 ? cap(parts[parts.length - 1]) : '';
  return lastPart ? `${first} ${lastPart}` : first;
}

/** Strip HTML tags and decode common entities for clean text */
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type SyncProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; current: number; total: number; pct: number; id: number; title: string }
  | { type: 'done'; total: number; created: number; updated: number; canceled: number }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

/**
 * Lock em memória: evita que duas sincronizações rodem em paralelo (disparo manual
 * de um usuário coincidindo com o cron a cada 2h, ou dois cliques concorrentes),
 * o que poderia gerar corrida de UPDATE/INSERT na mesma linha de WorkItems.
 */
let syncInProgress = false;
let lastSyncCompletedAt: Date | null = null;
/** Flag de aborto cooperativo: checado entre lotes/itens do processamento. */
let cancelRequested = false;

export function getSyncStatus() {
  return { isSyncing: syncInProgress, lastSync: lastSyncCompletedAt };
}

/** Solicita o cancelamento da sincronização em andamento (se houver). Retorna se havia uma para cancelar. */
export function requestSyncCancel(): boolean {
  if (!syncInProgress) return false;
  cancelRequested = true;
  return true;
}

export async function syncFromDevOps(
  onProgress?: (event: SyncProgressEvent) => void,
  scopeProjects?: string[] | null
): Promise<{ total: number; updated: number; created: number; canceled: number; cancelled?: boolean }> {
  // Operador sem nenhum projeto associado: nada para sincronizar, nem precisa do lock.
  if (Array.isArray(scopeProjects) && scopeProjects.length === 0) {
    return { total: 0, updated: 0, created: 0, canceled: 0 };
  }
  if (syncInProgress) {
    throw new Error('Uma sincronização já está em andamento. Aguarde a conclusão.');
  }
  syncInProgress = true;
  cancelRequested = false;
  try {
    const result = await runSync(onProgress, scopeProjects ?? null);
    if (!result.cancelled) lastSyncCompletedAt = new Date();
    return result;
  } finally {
    syncInProgress = false;
    cancelRequested = false;
  }
}

async function runSync(
  onProgress?: (event: SyncProgressEvent) => void,
  scopeProjects?: string[] | null
): Promise<{ total: number; updated: number; created: number; canceled: number; cancelled?: boolean }> {
  const pool = await getPool();

  // Get WIQL query from config
  const configResult = await pool.request()
    .input('chave', sql.NVarChar, 'wiql_query')
    .query(`SELECT Valor FROM Configuracoes WHERE Chave = @chave`);

  const wiqlQuery = configResult.recordset[0]?.Valor;
  if (!wiqlQuery) throw new Error('WIQL query not configured');

  // Projetos: sync restrita (scopeProjects informado, ex: Operador) usa exatamente essa lista;
  // sync completa (scopeProjects null/undefined, ex: Admin ou cron) usa a configuração global.
  let projectsValue: string | undefined;
  if (scopeProjects) {
    projectsValue = scopeProjects.join(', ');
  } else {
    const projectsResult = await pool.request()
      .input('chaveProj', sql.NVarChar, 'devops_projects')
      .query(`SELECT Valor FROM Configuracoes WHERE Chave = @chaveProj`);
    projectsValue = projectsResult.recordset[0]?.Valor?.trim();
  }

  let finalQuery = wiqlQuery;
  if (projectsValue) {
    const projectList = projectsValue
      .split(',')
      .map((p: string) => `'${p.trim().replace(/'/g, "''")}'`)
      .join(', ');
    const projectFilter = `[System.TeamProject] IN (${projectList})`;
    const orderByIdx = finalQuery.toUpperCase().indexOf('ORDER BY');
    if (orderByIdx > -1) {
      finalQuery = finalQuery.substring(0, orderByIdx) + `AND ${projectFilter} ` + finalQuery.substring(orderByIdx);
    } else {
      finalQuery += ` AND ${projectFilter}`;
    }
  }

  console.log(`📋 WIQL (projects: ${projectsValue || 'ALL'}${scopeProjects ? ', escopo restrito' : ''}):`, finalQuery);

  // Execute WIQL (org-level for cross-project support)
  const wiqlRes = await fetch(`${ORG_URL}/wit/wiql?api-version=7.1`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({ query: finalQuery }),
  });

  if (!wiqlRes.ok) {
    throw new Error(`WIQL failed: ${wiqlRes.status} ${await wiqlRes.text()}`);
  }

  const wiqlData = await wiqlRes.json() as { workItems: { id: number }[] };
  const allIds = wiqlData.workItems.map((w: { id: number }) => w.id);

  if (allIds.length === 0) return { total: 0, updated: 0, created: 0, canceled: 0 };

  onProgress?.({ type: 'start', total: allIds.length });

  // Fetch work item details in batches of 200
  let created = 0;
  let updated = 0;
  const canceledIds: number[] = [];
  let processedCount = 0;

  for (let i = 0; i < allIds.length; i += 200) {
    if (cancelRequested) {
      onProgress?.({ type: 'cancelled' });
      return { total: processedCount, updated, created, canceled: canceledIds.length, cancelled: true };
    }

    const batchIds = allIds.slice(i, i + 200);
    const idsParam = batchIds.join(',');

    const detailRes = await fetch(
      `${ORG_URL}/wit/workitems?ids=${idsParam}&fields=System.Id,System.Title,System.Description,System.State,System.AreaPath,System.Tags,System.CreatedDate,System.ChangedDate,System.AssignedTo,Custom.SystemModule,Custom.SupportCaseType,Custom.SupportCaseStatus,Custom.CustomerName&api-version=7.1`,
      { headers: authHeader() }
    );

    if (!detailRes.ok) {
      console.error(`Batch fetch failed: ${detailRes.status}`);
      continue;
    }

    const detailData = await detailRes.json() as { value: any[] };

    for (const item of detailData.value) {
      // Checagem por ITEM (não só por lote de 200) — sem isso, clicar em "Cancelar" no meio
      // de um lote grande podia levar dezenas de segundos pra fazer efeito, dando a impressão
      // de que o cancelamento não funcionava.
      if (cancelRequested) {
        onProgress?.({ type: 'cancelled' });
        return { total: processedCount, updated, created, canceled: canceledIds.length, cancelled: true };
      }

      const fields = item.fields;
      const id = fields['System.Id'];
      const title = fields['System.Title'] || '';
      const description = stripHtml(fields['System.Description'] || '');
      const state = fields['System.State'] || '';
      const areaPath = fields['System.AreaPath'] || '';
      const tags = fields['System.Tags'] || '';
      const createdDate = fields['System.CreatedDate'] || null;
      const changedDate = fields['System.ChangedDate'] || null;
      const cliente = fields['Custom.CustomerName'] || extractClient(title);
      const modulo = fields['Custom.SystemModule'] || null;
      const supportCaseType = fields['Custom.SupportCaseType'] || null;
      const supportCaseStatus = fields['Custom.SupportCaseStatus'] || null;
      // System.AssignedTo vem como objeto de identidade ({ displayName, uniqueName, ... }) ou,
      // em itens legados, como string "Nome <email>"/email puro — normalizeAssignedTo trata os dois casos.
      const assignedTo = normalizeAssignedTo(fields['System.AssignedTo']);

      // Skip canceled items — register for removal and move on
      if (state === 'Canceled') {
        canceledIds.push(id);
        continue;
      }

      processedCount++;
      onProgress?.({
        type: 'progress',
        current: processedCount,
        total: allIds.length,
        pct: Math.round((processedCount / allIds.length) * 100),
        id,
        title: title.substring(0, 80),
      });

      // Upsert
      const exists = await pool.request()
        .input('id', sql.Int, id)
        .query(`SELECT Id FROM WorkItems WHERE Id = @id`);

      if (exists.recordset.length > 0) {
        await pool.request()
          .input('id', sql.Int, id)
          .input('title', sql.NVarChar(500), title)
          .input('description', sql.NVarChar(sql.MAX), description)
          .input('state', sql.NVarChar(50), state)
          .input('areaPath', sql.NVarChar(200), areaPath)
          .input('tags', sql.NVarChar(500), tags)
          .input('changedDate', sql.DateTime2, changedDate)
          .input('cliente', sql.NVarChar(200), cliente)
          .input('modulo', sql.NVarChar(100), modulo)
          .input('caseType', sql.NVarChar(100), supportCaseType)
          .input('caseStatus', sql.NVarChar(200), supportCaseStatus)
          .input('assignedTo', sql.NVarChar(200), assignedTo)
          .input('now', sql.DateTime2, new Date())
          .query(`
            UPDATE WorkItems SET
              Title = @title,
              Description = @description,
              DevOpsState = @state,
              DevOpsAreaPath = @areaPath,
              DevOpsTags = @tags,
              ChangedDate = @changedDate,
              ClienteNome = @cliente,
              Modulo = @modulo,
              SupportCaseType = @caseType,
              SupportCaseStatus = @caseStatus,
              AssignedTo = @assignedTo,
              UltimaSyncDevOps = @now,
              AtualizadoEm = @now
            WHERE Id = @id
          `);
        updated++;
      } else {
        await pool.request()
          .input('id', sql.Int, id)
          .input('title', sql.NVarChar(500), title)
          .input('description', sql.NVarChar(sql.MAX), description)
          .input('state', sql.NVarChar(50), state)
          .input('areaPath', sql.NVarChar(200), areaPath)
          .input('tags', sql.NVarChar(500), tags)
          .input('createdDate', sql.DateTime2, createdDate)
          .input('changedDate', sql.DateTime2, changedDate)
          .input('cliente', sql.NVarChar(200), cliente)
          .input('modulo', sql.NVarChar(100), modulo)
          .input('caseType', sql.NVarChar(100), supportCaseType)
          .input('caseStatus', sql.NVarChar(200), supportCaseStatus)
          .input('assignedTo', sql.NVarChar(200), assignedTo)
          .input('now', sql.DateTime2, new Date())
          .query(`
            INSERT INTO WorkItems (Id, Title, Description, DevOpsState, DevOpsAreaPath, DevOpsTags, ClienteNome, Modulo, SupportCaseType, SupportCaseStatus, AssignedTo, CreatedDate, ChangedDate, UltimaSyncDevOps, CriadoEm, AtualizadoEm)
            VALUES (@id, @title, @description, @state, @areaPath, @tags, @cliente, @modulo, @caseType, @caseStatus, @assignedTo, @createdDate, @changedDate, @now, @now, @now)
          `);
        created++;
      }
    }
  }

  // Remove canceled items from local DB (may have been synced before they were canceled)
  if (canceledIds.length > 0) {
    const canceledSet = canceledIds.join(',');
    await pool.request().query(`DELETE FROM WorkItemAuditLog WHERE WorkItemId IN (${canceledSet})`);
    await pool.request().query(`DELETE FROM DocumentosGerados WHERE WorkItemId IN (${canceledSet})`);
    await pool.request().query(`DELETE FROM ApfRefinamentos WHERE WorkItemId IN (${canceledSet})`);
    await pool.request().query(`DELETE FROM WorkItems WHERE Id IN (${canceledSet})`);
    console.log(`🚫 Removed ${canceledIds.length} canceled items from local DB`);
  }

  // Remove items from local DB that are NOT in the WIQL result set.
  // Só roda em sync COMPLETA (scopeProjects null) — numa sync restrita (Operador),
  // o resultado da WIQL é intencionalmente parcial e NÃO representa o estado
  // completo desejado, então essa limpeza destrutiva ficaria errada (apagaria
  // itens de outros projetos que o usuário simplesmente não buscou).
  if (!scopeProjects && allIds.length > 0) {
    const idSet = allIds.join(',');
    // Delete dependent audit logs first
    await pool.request()
      .query(`DELETE FROM WorkItemAuditLog WHERE WorkItemId NOT IN (${idSet})`);
    await pool.request()
      .query(`DELETE FROM DocumentosGerados WHERE WorkItemId NOT IN (${idSet})`);
    await pool.request()
      .query(`DELETE FROM ApfRefinamentos WHERE WorkItemId NOT IN (${idSet})`);
    const delResult = await pool.request()
      .query(`DELETE FROM WorkItems WHERE Id NOT IN (${idSet})`);
    const removed = delResult.rowsAffected[0] || 0;
    if (removed > 0) {
      console.log(`🗑️ Removed ${removed} items from local DB (not in WIQL result)`);
    }
  }

  // Os comentários [PATI] NÃO são mais varridos aqui (era 1 chamada HTTP por item, em TODA
  // sincronização — manual ou cron a cada 2h — o que não escala com o crescimento do backlog).
  // Agora são buscados sob demanda, só pro chamado específico, no momento em que uma entrevista
  // com a PATi começa (ver refreshPatiComment, chamado a partir de registerInterviewSession).
  return { total: allIds.length, updated, created, canceled: canceledIds.length };
}

/**
 * Busca ao vivo (1 chamada HTTP) o comentário [PATI] mais atual de UM chamado específico e
 * persiste em WorkItems.DiscussionPati — chamado no início de uma entrevista (nova ou
 * retomada), não durante a sincronização geral. Falha "aberta": se o DevOps estiver
 * indisponível ou o PAT tiver expirado, mantém o último valor já salvo em vez de bloquear a
 * entrevista (mesmo padrão de tolerância a falhas já usado no sync completo).
 */
export async function refreshPatiComment(workItemId: number): Promise<void> {
  try {
    const patiComment = await fetchPatiComment(workItemId);
    if (patiComment === null) return; // sem [PATI] no DevOps — não apaga o que já existe localmente
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, workItemId)
      .input('discussion', sql.NVarChar(sql.MAX), patiComment)
      .query(`UPDATE WorkItems SET DiscussionPati = @discussion WHERE Id = @id AND (DiscussionPati IS NULL OR DiscussionPati != @discussion)`);
  } catch (err) {
    console.error(`⚠️ refreshPatiComment(${workItemId}) falhou — usando último valor salvo:`, (err as Error).message);
  }
}

/** Fetch comments from a work item's discussion and extract [PATI] tagged content */
async function fetchPatiComment(workItemId: number): Promise<string | null> {
  const res = await fetch(
    `${PROJECT_URL}/wit/workitems/${workItemId}/comments?api-version=7.1-preview.4`,
    { headers: authHeader() }
  );
  if (!res.ok) return null;

  const data = await res.json() as { comments: { text: string }[] };
  if (!data.comments || data.comments.length === 0) return null;

  // Find comments containing [PATI] tag (case-insensitive)
  const patiComments: string[] = [];
  for (const comment of data.comments) {
    const text = stripHtml(comment.text);
    if (text.toLowerCase().includes('[pati]')) {
      // Remove the tag itself and trim
      patiComments.push(text.replace(/\[pati\]/gi, '').trim());
    }
  }

  return patiComments.length > 0 ? patiComments.join('\n\n---\n\n') : null;
}

/**
 * Backfill Modulo for ALL items in DB by fetching Custom.SystemModule from DevOps.
 * Also updates DevOpsState for items that became Closed/Removed.
 */
export async function backfillFromDevOps(): Promise<{ total: number; updated: number }> {
  const pool = await getPool();

  // Get ALL item IDs from DB
  const dbItems = await pool.request().query(`SELECT Id FROM WorkItems ORDER BY Id`);
  const allIds = dbItems.recordset.map((r: any) => r.Id);

  if (allIds.length === 0) return { total: 0, updated: 0 };

  let updated = 0;

  for (let i = 0; i < allIds.length; i += 200) {
    const batchIds = allIds.slice(i, i + 200);
    const idsParam = batchIds.join(',');

    const detailRes = await fetch(
      `${ORG_URL}/wit/workitems?ids=${idsParam}&fields=System.Id,System.Description,System.State,System.AreaPath,Custom.SystemModule,Custom.SupportCaseType,Custom.SupportCaseStatus&api-version=7.1&$expand=none&errorPolicy=Omit`,
      { headers: authHeader() }
    );

    if (!detailRes.ok) {
      console.error(`Backfill batch failed: ${detailRes.status}, retrying individually...`);
      // Retry one by one for this batch
      for (const singleId of batchIds) {
        try {
          const singleRes = await fetch(
            `${ORG_URL}/wit/workitems/${singleId}?fields=System.Id,System.Description,System.State,System.AreaPath,Custom.SystemModule,Custom.SupportCaseType,Custom.SupportCaseStatus&api-version=7.1`,
            { headers: authHeader() }
          );
          if (!singleRes.ok) continue; // item deleted
          const singleData = await singleRes.json() as { fields: any };
          const f = singleData.fields;
          await pool.request()
            .input('id', sql.Int, f['System.Id'])
            .input('description', sql.NVarChar(sql.MAX), stripHtml(f['System.Description'] || ''))
            .input('state', sql.NVarChar(50), f['System.State'] || '')
            .input('areaPath', sql.NVarChar(200), f['System.AreaPath'] || '')
            .input('modulo', sql.NVarChar(100), f['Custom.SystemModule'] || null)
            .input('caseType', sql.NVarChar(100), f['Custom.SupportCaseType'] || null)
            .input('caseStatus', sql.NVarChar(200), f['Custom.SupportCaseStatus'] || null)
            .input('now', sql.DateTime2, new Date())
            .query(`UPDATE WorkItems SET Description = @description, Modulo = @modulo, DevOpsState = @state, DevOpsAreaPath = @areaPath, SupportCaseType = @caseType, SupportCaseStatus = @caseStatus, UltimaSyncDevOps = @now, AtualizadoEm = @now WHERE Id = @id`);
          updated++;
        } catch {}
      }
      continue;
    }

    const detailData = await detailRes.json() as { value: any[] };

    for (const item of detailData.value) {
      const fields = item.fields;
      const id = fields['System.Id'];
      const description = stripHtml(fields['System.Description'] || '');
      const state = fields['System.State'] || '';
      const areaPath = fields['System.AreaPath'] || '';
      const modulo = fields['Custom.SystemModule'] || null;
      const caseType = fields['Custom.SupportCaseType'] || null;
      const caseStatus = fields['Custom.SupportCaseStatus'] || null;

      await pool.request()
        .input('id', sql.Int, id)
        .input('description', sql.NVarChar(sql.MAX), description)
        .input('state', sql.NVarChar(50), state)
        .input('areaPath', sql.NVarChar(200), areaPath)
        .input('modulo', sql.NVarChar(100), modulo)
        .input('caseType', sql.NVarChar(100), caseType)
        .input('caseStatus', sql.NVarChar(200), caseStatus)
        .input('now', sql.DateTime2, new Date())
        .query(`
          UPDATE WorkItems SET
            Description = @description,
            Modulo = @modulo,
            DevOpsState = @state,
            DevOpsAreaPath = @areaPath,
            SupportCaseType = @caseType,
            SupportCaseStatus = @caseStatus,
            UltimaSyncDevOps = @now,
            AtualizadoEm = @now
          WHERE Id = @id
        `);
      updated++;
    }
  }

  console.log(`✅ Backfill complete: ${updated} of ${allIds.length} items updated`);
  return { total: allIds.length, updated };
}
