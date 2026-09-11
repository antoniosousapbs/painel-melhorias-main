import { getPool, sql } from '../db/connection.js';
import { getProjectFilter } from './workitem.js';
import { llmStream } from './llm.js';
import { getContextoAcumulado, getApfElementsSummary } from './document-generator.js';
import { keepMostRecentBlocks } from '../utils/context.js';
import 'dotenv/config';

// ── Cache for data context (avoids re-querying SQL on every message) ──
let _cachedContext: string | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Mantém as mensagens mais RECENTES do histórico dentro de um orçamento de CARACTERES, em vez
// de um número fixo de mensagens (ex.: as antigas history.slice(-10)/(-6)). Um corte por
// CONTAGEM quebra entrevistas longas: cada turno de entrevista é 1 pergunta + 1 resposta (2
// mensagens), então slice(-10) só enxerga os últimos ~5 turnos — a PATi "esquece" tudo antes
// disso e repete perguntas já respondidas (bug real reportado com entrevistas de 15+ turnos).
// Um orçamento de caracteres generoso cobre dezenas de turnos reais (mensagens já limitadas a
// 1000 chars no cliente) sem chegar perto da janela de contexto de nenhum provider configurado
// (Groq 128k tokens, GPT-5.4 922k tokens de input) nem do limite de tamanho por requisição.
function trimHistoryByBudget(history: { role: string; content: string }[], maxChars = 16000): { role: string; content: string }[] {
  let total = 0;
  const kept: { role: string; content: string }[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const len = history[i].content.length;
    if (kept.length > 0 && total + len > maxChars) break; // sempre mantém ao menos a última mensagem
    total += len;
    // Só repassa role/content pro provider — o front pode enviar campos extras (ex.: `at`, usado
    // só pra montar o InterviewContext com horário por turno) que a API do provider (Groq/OpenAI-
    // compatible) rejeita com HTTP 400 se estiverem presentes no objeto da mensagem.
    kept.unshift({ role: history[i].role, content: history[i].content });
  }
  return kept;
}

// ── Data-fetching tools the LLM context is built from ──────────────


/** Gather a concise data snapshot for the LLM context (cached 2min, skips cache when filtered) */
export async function buildDataContext(filters?: Record<string,string>, operatorProjects?: string[] | null): Promise<string> {
  const hasFilters = filters && Object.keys(filters).length > 0;
  // Operador (escopo restrito) nunca usa o cache global — evita vazar dados de outros projetos
  // e evita servir a um Operador um contexto cacheado por um Admin (ou vice-versa).
  const isScoped = operatorProjects !== undefined && operatorProjects !== null;

  // Return cached if fresh AND no filters AND sem escopo por projeto
  if (!hasFilters && !isScoped && _cachedContext && (Date.now() - _cachedAt) < CACHE_TTL_MS) {
    return _cachedContext;
  }

  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);

  const mkReq = () => {
    const r = pool.request();
    pf.bind(r);
    let w = `WHERE 1=1 ${pf.clause}`;
    if (filters?.cliente) {
      const clients = filters.cliente.split(',').map(c => c.trim()).filter(Boolean);
      if (clients.length > 0) {
        const conds = clients.map((_, i) => `ClienteNome = @fCliente${i}`);
        w += ` AND (${conds.join(' OR ')})`;
        clients.forEach((c, i) => r.input(`fCliente${i}`, sql.NVarChar(200), c));
      }
    }
    if (filters?.categoria) { w += ' AND Categoria = @fCategoria'; r.input('fCategoria', sql.NVarChar(100), filters.categoria); }
    if (filters?.modulo) { w += ' AND Modulo = @fModulo'; r.input('fModulo', sql.NVarChar(100), filters.modulo); }
    if (filters?.prioridade) { w += ' AND CAST(Prioridade AS NVARCHAR(50)) = @fPrioridade'; r.input('fPrioridade', sql.NVarChar(50), filters.prioridade); }
    if (filters?.status) { w += ' AND DevOpsState = @fStatus'; r.input('fStatus', sql.NVarChar(50), filters.status); }
    return { r, w };
  };

  // Run ALL queries in parallel
  const [kpisRes, topClientesRes, distClienteRes, modulosRes, prioridadesRes, recentesRes] = await Promise.all([
    // 1. Overall KPIs
    (() => { const q = mkReq(); return q.r.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN Categoria = 'Produto' THEN 1 ELSE 0 END) as produto,
        SUM(CASE WHEN Categoria = 'Hibrido' THEN 1 ELSE 0 END) as hibrido,
        SUM(CASE WHEN Categoria = 'Cliente' THEN 1 ELSE 0 END) as cliente,
        SUM(CASE WHEN Categoria = 'Info Insuficiente' OR Categoria IS NULL THEN 1 ELSE 0 END) as infoInsuf,
        SUM(CASE WHEN ClassificacaoRevisada = 1 THEN 1 ELSE 0 END) as revisados
      FROM WorkItems ${q.w}`); })(),
    // 2. Top 10 clients
    (() => { const q = mkReq(); return q.r.query(`
      SELECT TOP 10 ClienteNome as nome, COUNT(*) as qtd
      FROM WorkItems ${q.w} AND ClienteNome IS NOT NULL AND ClienteNome != ''
      GROUP BY ClienteNome ORDER BY qtd DESC`); })(),
    // 3. Category per top client
    (() => { const q = mkReq(); return q.r.query(`
      SELECT TOP 30 ClienteNome as nome, Categoria as cat, COUNT(*) as qtd
      FROM WorkItems ${q.w} AND ClienteNome IS NOT NULL AND Categoria IS NOT NULL
      GROUP BY ClienteNome, Categoria ORDER BY ClienteNome, qtd DESC`); })(),
    // 4. Modules
    (() => { const q = mkReq(); return q.r.query(`
      SELECT TOP 10 ISNULL(Modulo,'N/A') as modulo, COUNT(*) as qtd
      FROM WorkItems ${q.w} GROUP BY Modulo ORDER BY qtd DESC`); })(),
    // 5. Priorities
    (() => { const q = mkReq(); return q.r.query(`
      SELECT ISNULL(CAST(Prioridade AS NVARCHAR(50)),'N/A') as prioridade, COUNT(*) as qtd
      FROM WorkItems ${q.w} GROUP BY CAST(Prioridade AS NVARCHAR(50)) ORDER BY qtd DESC`); })(),
    // 6. Recent 10
    (() => { const q = mkReq(); return q.r.query(`
      SELECT TOP 10 Id, Title, ClienteNome, Categoria, Modulo, CAST(Prioridade AS NVARCHAR(50)) as Prioridade, ImpactoOperacao
      FROM WorkItems ${q.w} ORDER BY ChangedDate DESC`); })(),
  ]);

  const kpis = kpisRes.recordset[0];
  const topClientes = topClientesRes.recordset;
  const distCliente = distClienteRes.recordset;
  const modulos = modulosRes.recordset;
  const prioridades = prioridadesRes.recordset;
  const recentes = recentesRes.recordset;

  // Build text summary
  const lines: string[] = [];
  const filterDesc = hasFilters ? ` — FILTROS: ${Object.entries(filters!).map(([k,v]) => `${k}=${v}`).join(', ')}` : '';
  lines.push(`=== DADOS DO PAINEL (${new Date().toLocaleDateString('pt-BR')})${filterDesc} ===`);
  lines.push(`Total de chamados: ${kpis.total}`);
  lines.push(`Produto: ${kpis.produto} | Híbrido: ${kpis.hibrido} | Cliente: ${kpis.cliente} | Info Insuficiente: ${kpis.infoInsuf}`);
  lines.push(`Revisados manualmente: ${kpis.revisados}`);
  lines.push('');

  lines.push('--- Top 10 Clientes ---');
  for (const c of topClientes) lines.push(`  ${c.nome}: ${c.qtd} chamados`);
  lines.push('');

  lines.push('--- Distribuição Categoria por Cliente ---');
  for (const d of distCliente) lines.push(`  ${d.nome} | ${d.cat}: ${d.qtd}`);
  lines.push('');

  lines.push('--- Top 10 Módulos ---');
  for (const m of modulos) lines.push(`  ${m.modulo}: ${m.qtd}`);
  lines.push('');

  lines.push('--- Prioridades ---');
  for (const p of prioridades) lines.push(`  ${p.prioridade}: ${p.qtd}`);
  lines.push('');

  lines.push('--- Últimos 10 chamados ---');
  for (const r of recentes) {
    lines.push(`  #${r.Id} [${r.ClienteNome || '?'}] ${r.Title} | Cat: ${r.Categoria || 'N/A'} | Mod: ${r.Modulo || 'N/A'} | Prio: ${r.Prioridade || 'N/A'}`);
  }

  const result = lines.join('\n');

  // Update cache only for unfiltered e sem escopo por projeto
  if (!hasFilters && !isScoped) {
    _cachedContext = result;
    _cachedAt = Date.now();
  }

  return result;
}

/** Run a focused SQL query based on the user's question */
export async function queryForQuestion(
  question: string,
  filters?: Record<string,string>,
  history?: { role: string; content: string }[],
  operatorProjects?: string[] | null,
): Promise<string> {
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);
  const q = question.toLowerCase();

  const mkReq = () => {
    const r = pool.request();
    pf.bind(r);
    let w = `WHERE 1=1 ${pf.clause}`;
    if (filters?.cliente) {
      const clients = filters.cliente.split(',').map(c => c.trim()).filter(Boolean);
      if (clients.length > 0) {
        const conds = clients.map((_, i) => `ClienteNome = @fCliente${i}`);
        w += ` AND (${conds.join(' OR ')})`;
        clients.forEach((c, i) => r.input(`fCliente${i}`, sql.NVarChar(200), c));
      }
    }
    if (filters?.categoria) { w += ' AND Categoria = @fCategoria'; r.input('fCategoria', sql.NVarChar(100), filters.categoria); }
    if (filters?.modulo) { w += ' AND Modulo = @fModulo'; r.input('fModulo', sql.NVarChar(100), filters.modulo); }
    if (filters?.prioridade) { w += ' AND CAST(Prioridade AS NVARCHAR(50)) = @fPrioridade'; r.input('fPrioridade', sql.NVarChar(50), filters.prioridade); }
    if (filters?.status) { w += ' AND DevOpsState = @fStatus'; r.input('fStatus', sql.NVarChar(50), filters.status); }
    return { r, w };
  };

  const parts: string[] = [];

  // ── 1. Detect work item IDs — current question OR recent history ──
  const idRegex = /\b(\d{4,7})\b/g;
  let idMatches = question.match(idRegex);

  // If no IDs in current question, scan last 6 messages in history
  if (!idMatches && history && history.length > 0) {
    const recentText = history.slice(-6).map(m => m.content).join(' ');
    idMatches = recentText.match(idRegex);
  }
  if (idMatches) {
    const uniqueIds = [...new Set(idMatches.map(Number).filter(id => id >= 1000))];
    for (const wid of uniqueIds.slice(0, 5)) { // max 5 IDs per query
      const iq = pool.request();
      pf.bind(iq);
      iq.input('wid', sql.Int, wid);
      const rows = (await iq.query(`
        SELECT Id, Title, Description, DevOpsState, DevOpsAreaPath, DevOpsTags,
               ClienteNome, CreatedDate, ChangedDate, Categoria, Tipo, Modulo,
               Prioridade, EsforcoAPF, ImpactoOperacao, ClassificacaoOrigem,
               ClassificacaoConfianca, ClassificacaoRevisada, DiscussionPati
        FROM WorkItems WHERE Id = @wid ${pf.clause}
      `)).recordset;

      if (rows.length > 0) {
        const wi = rows[0];
        let detail = `\n=== CHAMADO #${wi.Id} (DETALHES COMPLETOS) ===\n`;
        detail += `Título: ${wi.Title}\n`;
        detail += `Cliente: ${wi.ClienteNome || 'N/A'}\n`;
        detail += `Estado DevOps: ${wi.DevOpsState || 'N/A'}\n`;
        detail += `Área: ${wi.DevOpsAreaPath || 'N/A'}\n`;
        detail += `Tags: ${wi.DevOpsTags || 'N/A'}\n`;
        detail += `Categoria: ${wi.Categoria || 'Não classificado'}\n`;
        detail += `Tipo: ${wi.Tipo || 'N/A'}\n`;
        detail += `Módulo: ${wi.Modulo || 'N/A'}\n`;
        detail += `Prioridade: ${wi.Prioridade || 'N/A'}\n`;
        detail += `Impacto Operação: ${wi.ImpactoOperacao || 'N/A'}\n`;
        detail += `Esforço APF: ${wi.EsforcoAPF ?? 'Não estimado'}\n`;
        detail += `Classificação Origem: ${wi.ClassificacaoOrigem || 'N/A'}\n`;
        detail += `Confiança: ${wi.ClassificacaoConfianca != null ? (wi.ClassificacaoConfianca * 100).toFixed(0) + '%' : 'N/A'}\n`;
        detail += `Revisada: ${wi.ClassificacaoRevisada ? 'Sim' : 'Não'}\n`;
        detail += `Criado: ${wi.CreatedDate ? new Date(wi.CreatedDate).toLocaleDateString('pt-BR') : 'N/A'}\n`;
        detail += `Atualizado: ${wi.ChangedDate ? new Date(wi.ChangedDate).toLocaleDateString('pt-BR') : 'N/A'}\n`;
        if (wi.Description) {
          // Trim description to avoid context overflow (max 2000 chars)
          const desc = wi.Description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          detail += `Descrição: ${desc.slice(0, 2000)}${desc.length > 2000 ? '...(truncado)' : ''}\n`;
        } else {
          detail += `Descrição: Não disponível\n`;
        }
        if (wi.DiscussionPati) {
          // Mantém os comentários [PATI] MAIS RECENTES (não os mais antigos) quando o total
          // excede o orçamento — são os que costumam trazer a resposta final/confirmada.
          const patiRecente = keepMostRecentBlocks(wi.DiscussionPati, '\n\n---\n\n', 1500);
          detail += `\nTag [PATI] presente: SIM\nComentários [PATI] (refinamentos registrados no DevOps):\n${patiRecente}${patiRecente.length < wi.DiscussionPati.length ? '...(comentários mais antigos omitidos)' : ''}\n`;
        } else {
          detail += `\nTag [PATI] presente: NÃO (nenhum comentário [PATI] registrado no DevOps para este chamado)\n`;
        }
        parts.push(detail);
      }
    }

    // If IDs were found and all resolved, return early with full details
    if (parts.length > 0) return parts.join('\n');
  }

  // ── 2. Detect if user is asking about a specific client ──
  const clienteMatch = question.match(/\b([A-Z]{2,}(?:\s+[A-Z]+)*)\b/);
  if (clienteMatch) {
    const clienteGuess = clienteMatch[1];
    const chk = mkReq();
    chk.r.input('nome', sql.NVarChar, `%${clienteGuess}%`);
    const exists = (await chk.r.query(`SELECT TOP 1 ClienteNome FROM WorkItems ${chk.w} AND ClienteNome LIKE @nome`)).recordset;
    if (exists.length > 0) {
      const nome = exists[0].ClienteNome;
      const sq = mkReq();
      sq.r.input('cliente', sql.NVarChar, `%${nome}%`);
      const detail = (await sq.r.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN Categoria='Produto' THEN 1 ELSE 0 END) as produto,
          SUM(CASE WHEN Categoria='Hibrido' THEN 1 ELSE 0 END) as hibrido,
          SUM(CASE WHEN Categoria='Cliente' THEN 1 ELSE 0 END) as cliente,
          SUM(CASE WHEN Categoria='Info Insuficiente' OR Categoria IS NULL THEN 1 ELSE 0 END) as infoInsuf
        FROM WorkItems ${sq.w} AND ClienteNome LIKE @cliente
      `)).recordset[0];

      const mq2 = mkReq();
      mq2.r.input('cliente', sql.NVarChar, `%${nome}%`);
      const mods = (await mq2.r.query(`
        SELECT TOP 5 ISNULL(Modulo,'N/A') as modulo, COUNT(*) as qtd
        FROM WorkItems ${mq2.w} AND ClienteNome LIKE @cliente
        GROUP BY Modulo ORDER BY qtd DESC
      `)).recordset;

      const iq = mkReq();
      iq.r.input('cliente', sql.NVarChar, `%${nome}%`);
      const items = (await iq.r.query(`
        SELECT TOP 5 Id, Title, Categoria, Modulo, Prioridade
        FROM WorkItems ${iq.w} AND ClienteNome LIKE @cliente
        ORDER BY ChangedDate DESC
      `)).recordset;

      let out = `\n--- Dados específicos de ${nome} ---\n`;
      out += `Total: ${detail.total} | Produto: ${detail.produto} | Híbrido: ${detail.hibrido} | Cliente: ${detail.cliente} | Info Insuf: ${detail.infoInsuf}\n`;
      out += 'Módulos: ' + mods.map((m: any) => `${m.modulo}(${m.qtd})`).join(', ') + '\n';
      out += 'Últimos chamados:\n';
      for (const i of items) out += `  #${i.Id} ${i.Title} [${i.Categoria || 'N/A'}] [${i.Modulo || 'N/A'}]\n`;
      return out;
    }
  }

  // If asking about modules
  if (q.includes('módulo') || q.includes('modulo')) {
    const mq = mkReq();
    const mods = (await mq.r.query(`
      SELECT ISNULL(Modulo,'N/A') as modulo, COUNT(*) as qtd,
        SUM(CASE WHEN Categoria='Produto' THEN 1 ELSE 0 END) as produto,
        SUM(CASE WHEN Categoria='Hibrido' THEN 1 ELSE 0 END) as hibrido,
        SUM(CASE WHEN Categoria='Cliente' THEN 1 ELSE 0 END) as cliente
      FROM WorkItems ${mq.w}
      GROUP BY Modulo ORDER BY qtd DESC
    `)).recordset;
    let out = '\n--- Detalhe por Módulo ---\n';
    for (const m of mods) out += `  ${m.modulo}: ${m.qtd} total (P:${m.produto} H:${m.hibrido} C:${m.cliente})\n`;
    return out;
  }

  // If asking about priorities
  if (q.includes('prioridade') || q.includes('priorid') || q.includes('urgente') || q.includes('crítico')) {
    const pq = mkReq();
    const prios = (await pq.r.query(`
      SELECT ISNULL(CAST(Prioridade AS NVARCHAR(50)),'N/A') as prioridade, COUNT(*) as qtd
      FROM WorkItems ${pq.w}
      GROUP BY CAST(Prioridade AS NVARCHAR(50)) ORDER BY qtd DESC
    `)).recordset;
    let out = '\n--- Detalhe por Prioridade ---\n';
    for (const p of prios) out += `  ${p.prioridade}: ${p.qtd}\n`;
    return out;
  }

  return ''; // No specific query needed
}

/** Stream LLM response — uses cloud API (Groq/DeepSeek) with Ollama fallback */
export async function* streamChat(
  userMessage: string,
  history: { role: string; content: string }[],
  dataContext: string,
  extraContext: string,
): AsyncGenerator<string> {
  // If we have specific work-item details, skip the full dataContext to reduce prompt size
  const hasSpecificData = extraContext.includes('DETALHES COMPLETOS') || extraContext.includes('Dados específicos');
  const contextBlock = hasSpecificData ? extraContext : `${dataContext}\n${extraContext}`;

  const systemPrompt = `Você é a PATi, agente de suporte inteligente da Paradigma.
Responda em pt-BR, de forma direta e profissional. Use markdown simples.

**Personalidade:** Você é proativa, analítica e autônoma. Quando o usuário faz uma pergunta vaga ou o contexto é insuficiente, faça perguntas de esclarecimento antes de responder. Não tenha medo de pedir mais detalhes.

**Suas capacidades:**
- Responder perguntas sobre os chamados do painel (clientes, categorias, módulos, prioridades, esforço)
- Classificar chamados pendentes (diga "classificar chamados")
- Gerar documentos APF/Especificação (diga "gerar APF do 318350" ou "gerar APF de todos")
- Refinar/ajustar contagem APF existente (mencione o ID e descreva o ajuste)
- Analisar métricas e estatísticas do backlog
- Filtrar e buscar chamados específicos
- Explicar critérios e metodologia IFPUG de contagem de Pontos de Função

**Sobre APF (Pontos de Função - IFPUG):**
- Tipos: EE (Entrada Externa), SE (Saída Externa), CE (Consulta Externa), ALI (Arquivo Lógico Interno), AIE (Arquivo de Interface Externa)
- Complexidade: determinada por TD (Tipos de Dados) e AR/TR (Arquivos Referenciados / Tipos de Registro)
- O esforço em horas é calculado multiplicando PF pela produtividade configurada (horas/PF)
- Quando perguntarem sobre critérios, explique a metodologia de forma clara e didática

**PROIBIÇÃO ABSOLUTA:**
- NUNCA faça análise APF, cálculo de PF, listagem de elementos funcionais (EE/SE/CE/ALI/AIE) ou estimativas de horas no chat
- Quando o usuário pedir APF ou contagem de um chamado específico, instrua a usar: "gerar APF do chamado [ID]" para disparar a entrevista de levantamento
- Se o usuário já disse "gerar APF" e você perguntou o ID e ele respondeu só com o ID — informe que ele deve usar o comando completo: "gerar APF do chamado [ID]"

**Comportamento:**
- Se o usuário pedir algo que você não entende, pergunte
- Se os dados de um chamado forem insuficientes para uma boa análise, sugira que o usuário forneça mais detalhes
- Use APENAS os dados abaixo para responder sobre chamados. Não invente dados.
- Quando detalhar chamado, liste: ID, título, cliente, categoria, tipo, módulo, prioridade, impacto, esforço APF, descrição.

${contextBlock}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimHistoryByBudget(history),
    { role: 'user', content: userMessage },
  ];

  // Provider resolvido dinamicamente via configuração (finalidade 'chat'), com fallback
  // automático entre providers e, por último, Ollama local.
  yield* llmStream('chat', messages);
}

/** Returns the raw context that would be injected into the interview system prompt — for diagnostics */
export async function getInterviewContext(workItemId: number, operatorProjects?: string[] | null) {
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);
  const request = pool.request().input('id', sql.Int, workItemId);
  pf.bind(request);
  const result = await request
    .query(`SELECT Id, Title, Description, ClienteNome, DiscussionPati FROM WorkItems WHERE Id = @id ${pf.clause}`);

  const wi = result.recordset[0];
  if (!wi) throw new Error(`Chamado #${workItemId} não encontrado`);

  const descText = (wi.Description || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);

  const patiData = keepMostRecentBlocks((wi.DiscussionPati || '').trim(), '\n\n---\n\n', 2000);
  const hasPati = patiData.length > 0;

  return {
    workItemId: wi.Id,
    title: wi.Title,
    cliente: wi.ClienteNome || null,
    hasPati,
    descriptionSanitized: descText || null,
    patiDataTruncated: hasPati ? patiData : null,
    charCounts: {
      descriptionRaw: (wi.Description || '').length,
      descriptionSanitized: descText.length,
      patiRaw: (wi.DiscussionPati || '').length,
      patiInjected: patiData.length,
    },
  };
}

/** Stream an interview session to gather requirements before APF/Spec generation */
export async function* streamInterview(
  workItemId: number,
  tipo: string,
  history: { role: string; content: string }[],
  bulkFilters?: Record<string, string>,
  operatorProjects?: string[] | null,
): AsyncGenerator<string> {
  if (bulkFilters !== undefined) {
    yield* streamInterviewBulk(bulkFilters, tipo, history, operatorProjects);
    return;
  }
  // Fetch work item data
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);
  const request = pool.request().input('id', sql.Int, workItemId);
  pf.bind(request);
  const result = await request
    .query(`SELECT Id, Title, Description, ClienteNome, DiscussionPati FROM WorkItems WHERE Id = @id ${pf.clause}`);

  const wi = result.recordset[0];
  if (!wi) throw new Error(`Chamado #${workItemId} não encontrado`);

  // Strip HTML from description
  const descText = (wi.Description || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);

  const tipoLabel = tipo === 'SPEC' ? 'Especificação de Negócio' : tipo === 'APF' ? 'APF (Análise de Pontos de Função)' : 'APF + Especificação de Negócio';

  const patiData = keepMostRecentBlocks((wi.DiscussionPati || '').trim(), '\n\n---\n\n', 2000);
  const hasPati = patiData.length > 0;
  const hasDesc = descText.length > 0;

  // Contexto já coletado em entrevistas/refinamentos anteriores deste chamado — reaproveitado
  // para não obrigar o analista a repetir respostas já dadas (geração nova ou refinamento).
  // getContextoAcumulado já prioriza as entrevistas MAIS RECENTES internamente — nada de
  // truncar de novo aqui por cima (isso descartaria justamente o que acabou de ser priorizado).
  const contextoAcumulado = await getContextoAcumulado(workItemId);
  const hasAcumulado = contextoAcumulado.length > 0;

  // Elementos já contados (tabela estruturada, não só prosa) — permite à PATi saber EXATAMENTE
  // o que já existe e perguntar qual elemento o analista quer ajustar, em vez de adivinhar.
  // Só entra em jogo quando o tipo pedido envolve APF — numa geração de Especificação pura,
  // uma contagem de APF pré-existente é irrelevante e não deve direcionar a entrevista para
  // "o que você quer ajustar" (isso confundia o fluxo de geração de Especificação).
  const isApfFocused = tipo === 'APF' || tipo === 'AMBOS';
  const elementosSummary = await getApfElementsSummary(workItemId);
  const hasElementos = isApfFocused && elementosSummary.length > 0;

  const systemPrompt = `Você é a PATi, agente de suporte inteligente da Paradigma.
Seu objetivo agora é **entrevistar o analista** para coletar informações suficientes para gerar um documento de **${tipoLabel}** para o chamado #${workItemId}.

**Dados disponíveis do chamado:**
- Título: ${wi.Title}
- Cliente: ${wi.ClienteNome || 'N/A'}
- Descrição: ${descText || '(vazia)'}
- Tag [PATI] na discussão: ${hasPati ? `ENCONTRADA — "${patiData}"` : 'NÃO encontrada'}
${hasElementos ? `
**ELEMENTOS JÁ CONTADOS NESTE CHAMADO (a numeração abaixo é a referência para o analista apontar qual elemento ajustar):**
${elementosSummary}
` : ''}${hasAcumulado ? `
**JÁ FOI LEVANTADO EM ENTREVISTA(S)/AJUSTE(S) ANTERIORES DESTE CHAMADO — NÃO PERGUNTE ISSO DE NOVO:**
${contextoAcumulado}
` : ''}
**INSUMOS DA CONTAGEM:**
1. Descrição do chamado | 2. ${hasPati ? 'Dados [PATI] (acima)' : 'Sem [PATI]'} | 3. Respostas desta entrevista${hasAcumulado ? ' | 4. Contexto acumulado acima' : ''}${hasElementos ? ' | 5. Elementos já contados acima' : ''}

**PROIBIÇÕES:**
- NUNCA escreva o RELATÓRIO de APF, tabela de elementos (EE/SE/CE/ALI/AIE) ou cálculo de pontos de função — isso é responsabilidade do sistema backend
- PODE e DEVE discutir, perguntar e coletar informações sobre o chamado
- NUNCA diga "não posso gerar ou discutir APF" — sua função É coletar informações sobre APF
- NUNCA repita uma pergunta cuja resposta já está no contexto acumulado acima — se tudo já foi coberto, pule direto para "Posso gerar o documento agora?"
${hasElementos ? `- **GLOSSÁRIO APF (NÃO CONFUNDIR)**: TD/TED = "Tipos de Dados" (data element types), usado para calcular a complexidade de ALI/AIE. AR/TR = "Tipos de Registro" (record element types). **TD/TED NUNCA significa "Tempo de Desenvolvimento"** — não use essa expansão em hipótese alguma, mesmo que o analista escreva só a sigla.
- **REGRA DE AMBIGUIDADE (MUITO IMPORTANTE)**: se o analista pedir pra alterar um campo (TD, AR/TR, complexidade, tipo, operação) sem dizer CLARAMENTE qual elemento da lista numerada acima deve ser afetado, e houver mais de 1 elemento contado, NÃO ASSUMA e NÃO aplique a mudança silenciosamente — pergunte explicitamente qual elemento (peça o número da lista) antes de dizer "Posso gerar o documento agora?". Só sinalize pronto depois que ficar claro qual elemento(s) o pedido afeta.
` : ''}
**Comportamento na PRIMEIRA mensagem:**
- O status [PATI] já foi informado automaticamente. NÃO repita nem mencione o status [PATI].
${hasElementos
    ? '- A lista de elementos já contados já foi mostrada automaticamente acima do seu texto — NÃO repita a lista. Pergunte diretamente e objetivamente: "O que você gostaria de ajustar?" e mencione, em uma frase curta, que também pode refazer a entrevista completa do zero se preferir.'
    : hasAcumulado
      ? '- Resuma em 1-2 frases o que já foi levantado anteriormente (contexto acumulado acima) e pergunte OBJETIVAMENTE apenas o que falta ajustar ou complementar — não reinicie o levantamento do zero.'
      : `- Inicie DIRETAMENTE com: (1) resumo de 1-2 frases do que entendeu do chamado${hasPati ? ', citando os dados [PATI]' : hasDesc ? ', baseado na descrição disponível' : ' (sem dados pré-existentes)'}, (2) UMA pergunta.`}

**Comportamento nas demais mensagens:**
- UMA pergunta por vez. Aguarde a resposta.
- Perguntas úteis: quais telas/campos criados ou alterados? integrações externas? regras de negócio? relatórios/consultas? processos batch?

**REGRA CRÍTICA DO [PRONTO_PARA_GERAR]:**
- Quando tiver informações suficientes, termine com: "Posso gerar o documento de ${tipoLabel} agora?"
- Quando o analista confirmar ("sim", "pode", "gerar", "gera", "vai", "ok", "bora" etc.):
  * Responda EXATAMENTE: "Certo. [PRONTO_PARA_GERAR]"
  * NÃO escreva mais nada além disso

**TOM:** Direto, profissional, sem agradecimentos. Sempre em pt-BR.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimHistoryByBudget(history),
  ];

  // If no history (first interaction), add a trigger and inject [PATI] status as first SSE chunk
  if (history.length === 0) {
    const patiStatusLine = hasElementos
      ? `✨ Encontrei a contagem atual deste chamado:\n\n${elementosSummary}\n\n`
      : hasAcumulado
        ? `✨ Encontrei contexto de uma entrevista/ajuste anterior deste chamado — vou reaproveitar.\n\n`
        : hasPati
          ? `✨ Encontrei análise prévia na tag [PATI] neste chamado.\n\n`
          : hasDesc
            ? `⚠️ Não há dados [PATI] neste chamado, mas há descrição disponível — usarei como base.\n\n`
            : `⚠️ Não há dados [PATI] nem descrição neste chamado — as respostas desta entrevista serão o principal insumo.\n\n`;
    yield patiStatusLine;
    const trigger = hasElementos
      ? `Quero revisar a contagem de ${tipoLabel} do chamado #${workItemId}. O que você precisa saber?`
      : `Quero gerar ${tipoLabel} para o chamado #${workItemId}. O que você precisa saber?`;
    messages.push({ role: 'user', content: trigger });
  }

  // Provider resolvido dinamicamente (finalidade 'chat'); para modelos de raciocínio o
  // piso mínimo de tokens é aplicado automaticamente em llm.ts (ver REASONING_MIN_TOKENS)
  yield* llmStream('chat', messages, { maxTokens: 800 });
}

/** Bulk interview: fetch all filtered items, read Description+DiscussionPati, interrogate user */
async function* streamInterviewBulk(
  filters: Record<string, string>,
  tipo: string,
  history: { role: string; content: string }[],
  operatorProjects?: string[] | null,
): AsyncGenerator<string> {
  const pool = await getPool();
  const pf = await getProjectFilter('AND', operatorProjects);

  const req = pool.request();
  pf.bind(req);
  let w = `WHERE 1=1 ${pf.clause}`;
  if (filters.cliente) {
    const clients = filters.cliente.split(',').map((c: string) => c.trim()).filter(Boolean);
    if (clients.length > 0) {
      const conds = clients.map((_: string, i: number) => `ClienteNome = @fCliente${i}`);
      w += ` AND (${conds.join(' OR ')})`;
      clients.forEach((c: string, i: number) => req.input(`fCliente${i}`, sql.NVarChar(200), c));
    }
  }
  if (filters.categoria) { w += ' AND Categoria = @fCategoria'; req.input('fCategoria', sql.NVarChar(100), filters.categoria); }
  if (filters.modulo) { w += ' AND Modulo = @fModulo'; req.input('fModulo', sql.NVarChar(100), filters.modulo); }
  if (filters.prioridade) { w += ' AND CAST(Prioridade AS NVARCHAR(50)) = @fPrioridade'; req.input('fPrioridade', sql.NVarChar(50), filters.prioridade); }
  if (filters.status) { w += ' AND DevOpsState = @fStatus'; req.input('fStatus', sql.NVarChar(50), filters.status); }

  const result = await req.query(
    `SELECT TOP 20 Id, Title, Description, ClienteNome, Modulo, DiscussionPati FROM WorkItems ${w} ORDER BY ChangedDate DESC`,
  );
  const items = result.recordset;

  if (items.length === 0) throw new Error('Nenhum chamado encontrado para os filtros ativos.');

  const tipoLabel = tipo === 'SPEC' ? 'Especificação de Negócio' : tipo === 'APF' ? 'APF (Análise de Pontos de Função)' : 'APF + Especificação';

  // Build per-item summary (Description + DiscussionPati) with explicit [PATI] status
  const itemsSummary = items.map((wi: any) => {
    const desc = (wi.Description || '')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
      .slice(0, 400);
    const patiComments = (wi.DiscussionPati || '').trim().slice(0, 300);
    let line = `#${wi.Id} [${wi.ClienteNome || '?'}] ${wi.Title}`;
    if (desc) line += `\n  Descrição: ${desc}`;
    line += patiComments
      ? `\n  [PATI] encontrado: "${patiComments}"`
      : '\n  [PATI]: não encontrado';
    return line;
  }).join('\n\n');

  const filterDesc = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ');

  const systemPrompt = `Você é a PATi, agente de suporte inteligente da Paradigma.
Seu objetivo é **entrevistar o analista** para coletar informações suficientes para gerar **${tipoLabel}** para os chamados abaixo.

**Filtros ativos:** ${filterDesc || 'nenhum (todos os chamados)'}
**Total de chamados:** ${items.length}

**Chamados com seus dados disponíveis:**
${itemsSummary}

**INSUMOS DA CONTAGEM (o que o sistema usará para gerar cada documento):**
1. Descrição de cada chamado
2. Dados [PATI] encontrados na discussão (quando houver — veja status por chamado acima)
3. Respostas que o analista fornecerá nesta entrevista

**PROIBIÇÕES ABSOLUTAS — NÃO VIOLÁVEIS:**
- NUNCA escreva análise APF, pontos de função, elementos funcionais (EE/SE/CE/ALI/AIE) no chat
- NUNCA calcule PF, complexidade ou horas no chat
- NUNCA escreva relatórios ou documentos no chat
- Você COLETA informações. A GERAÇÃO acontece no sistema backend, não no chat.

**Comportamento obrigatório:**
1. Na PRIMEIRA mensagem:
   a) Apresente brevemente o que entendeu de cada chamado (1-2 linhas), citando se há dados [PATI] ou não.
   b) Destaque os chamados SEM dados [PATI] — eles precisam de mais atenção na entrevista.
   c) Faça UMA pergunta relevante sobre o conjunto.
2. Faça UMA pergunta por vez. Aguarde resposta antes de perguntar outra coisa.
3. Seja específica. Baseie cada pergunta nos dados acima.
4. Foque em: integrações, telas, campos, regras de negócio, fluxos.

**REGRA CRÍTICA DO [PRONTO_PARA_GERAR]:**
- Quando tiver informações suficientes, termine com: "Posso gerar os documentos agora?"
- Quando o analista confirmar ("sim", "pode", "gerar", "gera", "vai", "ok", "bora" etc.):
  * Responda EXATAMENTE: "Certo. [PRONTO_PARA_GERAR]"
  * NÃO escreva mais nada além disso

**TOM:** Direto, profissional, sem agradecimentos. Sempre em pt-BR.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimHistoryByBudget(history),
  ];

  if (history.length === 0) {
    const semPati = items.filter((wi: any) => !(wi.DiscussionPati || '').trim()).length;
    const comPati = items.length - semPati;
    const bulkStatusLine = comPati > 0
      ? `📋 Analisando ${items.length} chamado(s): ✅ ${comPati} com dados [PATI] | ⚠️ ${semPati} sem dados [PATI] (precisam de mais atenção na entrevista).\n\n`
      : `📋 Analisando ${items.length} chamado(s): ⚠️ Nenhum possui dados [PATI] — as respostas desta entrevista serão o principal insumo.\n\n`;
    yield bulkStatusLine;
    messages.push({ role: 'user', content: `Quero gerar ${tipoLabel} para os ${items.length} chamados listados. O que você precisa saber?` });
  }

  yield* llmStream('chat', messages, { maxTokens: 600 });
}

