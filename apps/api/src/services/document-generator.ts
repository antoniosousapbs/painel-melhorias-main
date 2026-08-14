import { getPool, sql } from '../db/connection.js';
import PDFDocument from 'pdfkit';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { buildContextoFinal } from '../utils/context.js';
import { llmComplete, type LlmFinalidade } from './llm.js';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── LLM helpers ─── provider/modelo resolvidos dinamicamente via services/llm.ts
// (finalidade 'apf_geracao' | 'apf_refinamento' | 'spec_geracao'), com fallback
// automático entre providers configurados e, por último, Ollama local.

/** Call LLM expecting a JSON response. */
async function callLLMJson(systemPrompt: string, userContent: string, finalidade: LlmFinalidade = 'apf_geracao', maxTokens = 3000): Promise<string> {
  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }]
    : [{ role: 'user', content: userContent }];
  return llmComplete(finalidade, messages, { jsonMode: true, maxTokens });
}

/** Call LLM expecting free-text response. */
async function callLLMText(prompt: string, finalidade: LlmFinalidade = 'spec_geracao', maxTokens = 3000): Promise<string> {
  return llmComplete(finalidade, [{ role: 'user', content: prompt }], { maxTokens });
}

// ─── Knowledge Base Query ───
async function getRelevantKnowledge(title: string, description: string, patiComment: string, workItemId?: number): Promise<string> {
  const pool = await getPool();
  const text = `${title} ${description} ${patiComment}`.toLowerCase();
  const lines: string[] = [];

  // Estado atual da contagem deste MESMO chamado (se já foi contado antes) — busca exata por
  // WorkItemRef, sempre incluída (não depende de palavra-chave), para manter consistência
  // entre gerações/refinamentos/spec do mesmo item.
  if (workItemId) {
    const current = await pool.request()
      .input('wid', sql.Int, workItemId)
      .query(`SELECT Conteudo FROM PatiConhecimento WHERE Categoria = 'contagem_apf' AND WorkItemRef = @wid AND Ativo = 1`);
    if (current.recordset.length > 0) {
      lines.push('=== CONTAGEM APF ANTERIOR DESTE MESMO CHAMADO (mantenha consistência, salvo se a instrução pedir mudança) ===');
      lines.push(current.recordset[0].Conteudo);
      lines.push('');
    }
  }

  // Extract keywords for matching
  const keywords: string[] = [];
  const moduleMap: Record<string, string> = {
    'cotação': 'cotacao', 'cotacao': 'cotacao', 'rfq': 'cotacao',
    'pedido': 'pedidos', 'pedidos': 'pedidos', 'pday': 'pedidos', 'programação': 'pedidos',
    'fornecedor': 'fornecedores', 'fornecedores': 'fornecedores', 'cadastro': 'fornecedores',
    'contrato': 'contratos', 'contratos': 'contratos', 'vigência': 'contratos',
    'aprovação': 'aprovacao', 'workflow': 'aprovacao', 'alçada': 'aprovacao',
    'fiscal': 'fiscal', 'nfe': 'fiscal', 'nota fiscal': 'fiscal',
  };

  for (const [word, tag] of Object.entries(moduleMap)) {
    if (text.includes(word)) keywords.push(tag);
  }

  // Check for patterns
  if (text.includes('integra') || text.includes('api') || text.includes('sap') || text.includes('totvs') || text.includes('erp')) {
    keywords.push('integracao', 'api', 'erp');
  }
  if (text.includes('tela') || text.includes('cadastro') || text.includes('crud')) {
    keywords.push('tela', 'cadastro');
  }
  if (text.includes('relat') || text.includes('export') || text.includes('excel') || text.includes('pdf')) {
    keywords.push('relatorio');
  }
  if (text.includes('portal') || text.includes('fornecedor externo')) {
    keywords.push('portal', 'fornecedor');
  }
  if (text.includes('regra') || text.includes('validação') || text.includes('cálculo') || text.includes('recalcul')) {
    keywords.push('regra-negocio');
  }

  // Always include architecture overview
  keywords.push('arquitetura');

  if (keywords.length === 0) return lines.join('\n');

  // Build query to find relevant knowledge
  const conditions = keywords.map((_, i) => `Tags LIKE @k${i}`);
  const request = pool.request();
  keywords.forEach((k, i) => request.input(`k${i}`, sql.NVarChar(100), `%${k}%`));

  const result = await request.query(`
    SELECT DISTINCT TOP 8 Titulo, Conteudo, Categoria
    FROM PatiConhecimento
    WHERE Ativo = 1 AND Categoria != 'contagem_apf' AND (${conditions.join(' OR ')})
    ORDER BY Categoria, Titulo
  `);

  if (result.recordset.length > 0) {
    lines.push('=== CONTEXTO DO SISTEMA (Base de Conhecimento PATi) ===');
    for (const row of result.recordset) {
      lines.push(`[${row.Categoria.toUpperCase()}] ${row.Titulo}:`);
      lines.push(row.Conteudo);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Types ───
export interface ApfElement {
  processo: string;
  tipo: 'CE' | 'SE' | 'EE' | 'ALI' | 'AIE';
  operacao: 'I' | 'A' | 'E';
  td: number;
  arTr: number;
  complexidade: 'Baixa' | 'Media' | 'Alta';
  pf: number;
  justificativa?: string;
}

export interface ApfResult {
  elementos: ApfElement[];
  totalPF: number;
  totalPFA: number;
  totalHoras: number;
  horasDetalhamento: {
    gestao: number;
    analiseNegocio: number;
    analiseTestes: number;
    codificacao: number;
    execucaoTestes: number;
    homologacao: number;
  };
}

interface ApfParametros {
  Produtividade: number;
  DeflatorInclusao: number;
  DeflatorAlteracao: number;
  DeflatorExclusao: number;
  CicloGestao: number;
  CicloAnaliseNegocio: number;
  CicloAnaliseTestes: number;
  CicloCodificacao: number;
  CicloExecucaoTestes: number;
  CicloHomologacao: number;
}

// ─── APF Complexity → PF mapping ───
const PF_TABLE: Record<string, Record<string, number>> = {
  EE: { Baixa: 3, Media: 4, Alta: 6 },
  SE: { Baixa: 4, Media: 5, Alta: 7 },
  CE: { Baixa: 3, Media: 4, Alta: 6 },
  ALI: { Baixa: 7, Media: 10, Alta: 15 },
  AIE: { Baixa: 5, Media: 7, Alta: 10 },
};

// ─── Get APF Parameters from DB ───
export async function getApfParametros(): Promise<ApfParametros> {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT TOP 1 * FROM ApfParametros`);
  return result.recordset[0];
}

// ─── Update APF Parameters ───
export async function updateApfParametros(data: Partial<ApfParametros>): Promise<ApfParametros> {
  const pool = await getPool();
  const sets: string[] = [];
  const request = pool.request();

  if (data.Produtividade !== undefined) { sets.push('Produtividade = @prod'); request.input('prod', sql.Decimal(10, 2), data.Produtividade); }
  if (data.DeflatorInclusao !== undefined) { sets.push('DeflatorInclusao = @defI'); request.input('defI', sql.Decimal(5, 2), data.DeflatorInclusao); }
  if (data.DeflatorAlteracao !== undefined) { sets.push('DeflatorAlteracao = @defA'); request.input('defA', sql.Decimal(5, 2), data.DeflatorAlteracao); }
  if (data.DeflatorExclusao !== undefined) { sets.push('DeflatorExclusao = @defE'); request.input('defE', sql.Decimal(5, 2), data.DeflatorExclusao); }
  if (data.CicloGestao !== undefined) { sets.push('CicloGestao = @cG'); request.input('cG', sql.Decimal(5, 2), data.CicloGestao); }
  if (data.CicloAnaliseNegocio !== undefined) { sets.push('CicloAnaliseNegocio = @cAN'); request.input('cAN', sql.Decimal(5, 2), data.CicloAnaliseNegocio); }
  if (data.CicloAnaliseTestes !== undefined) { sets.push('CicloAnaliseTestes = @cAT'); request.input('cAT', sql.Decimal(5, 2), data.CicloAnaliseTestes); }
  if (data.CicloCodificacao !== undefined) { sets.push('CicloCodificacao = @cC'); request.input('cC', sql.Decimal(5, 2), data.CicloCodificacao); }
  if (data.CicloExecucaoTestes !== undefined) { sets.push('CicloExecucaoTestes = @cET'); request.input('cET', sql.Decimal(5, 2), data.CicloExecucaoTestes); }
  if (data.CicloHomologacao !== undefined) { sets.push('CicloHomologacao = @cH'); request.input('cH', sql.Decimal(5, 2), data.CicloHomologacao); }

  if (sets.length > 0) {
    sets.push('AtualizadoEm = GETDATE()');
    await request.query(`UPDATE ApfParametros SET ${sets.join(', ')} WHERE Id = (SELECT TOP 1 Id FROM ApfParametros)`);
  }

  return getApfParametros();
}

// ─── APF Diretrizes por Team Project (contexto de negócio, complementar ao IFPUG) ───
export interface ApfDiretrizProjeto {
  ProjectCode: string;
  Diretriz: string;
  Ativo: boolean;
  AtualizadoEm?: string;
}

export async function getApfDiretrizes(): Promise<ApfDiretrizProjeto[]> {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT ProjectCode, Diretriz, Ativo, AtualizadoEm FROM ApfDiretrizesProjeto ORDER BY ProjectCode`);
  return r.recordset;
}

export async function upsertApfDiretriz(projectCode: string, diretriz: string, atualizadoPor?: string): Promise<void> {
  const pool = await getPool();
  const existing = await pool.request().input('code', sql.NVarChar(200), projectCode)
    .query(`SELECT Id FROM ApfDiretrizesProjeto WHERE ProjectCode = @code`);

  if (existing.recordset.length > 0) {
    await pool.request()
      .input('code', sql.NVarChar(200), projectCode)
      .input('diretriz', sql.NVarChar(sql.MAX), diretriz)
      .input('por', sql.NVarChar(100), atualizadoPor || null)
      .query(`UPDATE ApfDiretrizesProjeto SET Diretriz = @diretriz, Ativo = 1, AtualizadoPor = @por, AtualizadoEm = GETDATE() WHERE ProjectCode = @code`);
  } else {
    await pool.request()
      .input('code', sql.NVarChar(200), projectCode)
      .input('diretriz', sql.NVarChar(sql.MAX), diretriz)
      .input('por', sql.NVarChar(100), atualizadoPor || null)
      .query(`INSERT INTO ApfDiretrizesProjeto (ProjectCode, Diretriz, Ativo, AtualizadoPor) VALUES (@code, @diretriz, 1, @por)`);
  }
}

/** Encontra a diretriz ativa cujo ProjectCode é prefixo do DevOpsAreaPath do work item. */
async function getDiretrizForProject(devOpsAreaPath: string | null | undefined): Promise<string | null> {
  if (!devOpsAreaPath) return null;
  const pool = await getPool();
  const r = await pool.request().query(`SELECT ProjectCode, Diretriz FROM ApfDiretrizesProjeto WHERE Ativo = 1`);
  const match = r.recordset.find((row: any) => devOpsAreaPath.startsWith(row.ProjectCode));
  return match ? match.Diretriz : null;
}

/**
 * Consolida todo o contexto de entrevista/refinamento já coletado para um chamado —
 * geração original + cada ajuste/refinamento posterior — para que uma nova entrevista ou
 * um novo refinamento não force o analista a repetir informações já fornecidas antes.
 */
export async function getContextoAcumulado(workItemId: number): Promise<string> {
  const pool = await getPool();
  const history = await pool.request()
    .input('wid', sql.Int, workItemId)
    .query(`
      SELECT Tipo, Versao, InterviewContext, CriadoEm
      FROM DocumentVersionHistory
      WHERE WorkItemId = @wid AND InterviewContext IS NOT NULL AND LEN(InterviewContext) > 0
      ORDER BY CriadoEm ASC
    `);

  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const row of history.recordset) {
    const ctx = (row.InterviewContext as string || '').trim();
    if (!ctx || seen.has(ctx)) continue;
    seen.add(ctx);
    blocks.push(`--- Entrevista/ajuste anterior (${row.Tipo} v${row.Versao}) ---\n${ctx}`);
  }

  // Fallback: chamados gerados antes de existir o versionamento, ou refinados fora do fluxo de interview
  if (blocks.length === 0) {
    const current = await pool.request()
      .input('wid', sql.Int, workItemId)
      .query(`SELECT TOP 1 InterviewContext FROM DocumentosGerados WHERE WorkItemId = @wid AND InterviewContext IS NOT NULL AND LEN(InterviewContext) > 0`);
    const ctx = (current.recordset[0]?.InterviewContext || '').trim();
    if (ctx) blocks.push(`--- Contexto da última geração ---\n${ctx}`);
  }

  return blocks.join('\n\n');
}

// ─── Call LLM for APF analysis (cloud or Ollama) ───
async function callOllamaForApf(
  title: string, description: string, patiComment: string, extraContext?: string,
  workItemId?: number, projectDiretriz?: string | null
): Promise<{ elementos: ApfElement[]; resumoGeral: string }> {
  const knowledge = await getRelevantKnowledge(title, description, patiComment, workItemId);

  const systemPrompt = `Você é um analista de Pontos de Função (APF) especializado na metodologia IFPUG, atuando
sobre diferentes produtos e unidades de negócio da Paradigma.
Analise o chamado abaixo e identifique os processos elementares e grupos de dados REALMENTE necessários
para implementar a funcionalidade descrita — não crie elementos artificiais ou redundantes.

${knowledge}
${projectDiretriz ? `=== CONTEXTO DE NEGÓCIO DESTE PROJETO (diretriz configurada pelo time, apenas orientativa) ===
${projectDiretriz}
IMPORTANTE: essa diretriz é um guia de como esta unidade organiza seus processos/produtos — as regras de
complexidade IFPUG abaixo SEMPRE prevalecem na classificação final. Use a diretriz só para entender melhor
o contexto do produto, nunca para alterar a matriz de complexidade.
` : ''}
PRINCÍPIO DE PARCIMÔNIA — MUITO IMPORTANTE:
- Conte o MENOR número de elementos que descreva fielmente a mudança. Nunca infira elementos extras
  "para completar" a análise ou para parecer mais completo.
- Se a funcionalidade pode ser implementada alterando UM único processo elementar já existente (ex:
  adicionar um filtro a uma consulta/tela que já existe), conte APENAS esse elemento como Alteração (A)
  — não crie elementos adicionais para representar a interface visual (campo, checkbox, botão) nem para
  o dado em si.
- ALI (Arquivo Lógico Interno) e AIE (Arquivo de Interface Externa) representam GRUPOS DE DADOS mantidos
  ou referenciados pela aplicação — NUNCA representam telas, layout ou componentes visuais. Uma mudança
  puramente visual (adicionar campo/checkbox numa tela existente) NÃO gera elemento ALI/AIE. Um ALI só é
  contado se uma nova estrutura de dados lógica for criada, ou se uma estrutura existente ganhar novos
  atributos PERSISTIDOS (não apenas exibidos).
- Se o próprio chamado menciona que o dado JÁ EXISTE no banco e a tela/consulta também JÁ EXISTE, isso é
  sinal de que há apenas UM elemento a contar: a Alteração do EE/CE existente que processa essa tela/consulta.

Para cada elemento, determine:
- processo: nome descritivo do processo elementar ou grupo de dados
- tipo: CE (Consulta Externa), SE (Saída Externa), EE (Entrada Externa), ALI (Arquivo Lógico Interno), AIE (Arquivo de Interface Externa)
- operacao: I (Inclusão), A (Alteração), E (Exclusão)
- td: número de Tipos de Dados (campos/atributos referenciados)
- arTr: número de Arquivos Referenciados (ALI/AIE acessados) ou Tipos de Registro
- justificativa: 1 a 3 frases, em linguagem clara, explicando por que você escolheu esse tipo/operação/TD/AR-TR/complexidade — cite trechos ou fatos do chamado que embasaram a decisão

REGRAS PARA OPERAÇÃO (I/A/E) — MUITO IMPORTANTE:
- I (Inclusão): use quando o elemento é NOVO no sistema — nova tela, novo campo, novo processo, novo alerta, novo relatório que não existia antes.
- A (Alteração): use quando o elemento JÁ EXISTE e está sendo modificado, estendido ou ajustado.
- E (Exclusão): use APENAS quando o chamado explicitamente descreve REMOVER ou DESATIVAR uma funcionalidade existente. É EXTREMAMENTE RARO em chamados de nova funcionalidade — na dúvida, use I ou A.

Regras de complexidade IFPUG (matrizes TD × AR/TR):
- EE  → Baixa: td≤15 e ar≤1, ou td≤4 e ar=2 | Média: td≤4 e ar≥3, ou td 5-15 e ar=2, ou td≥16 e ar≤1 | Alta: restante
- SE/CE → Baixa: td≤19 e ar≤1, ou td≤5 e ar≤3 | Média: td≤5 e ar≥4, ou td 6-19 e ar 2-3, ou td≥20 e ar≤1 | Alta: restante
- ALI/AIE → Baixa: td≤50 e tr=1, ou td≤19 e tr≤5 | Média: td≤19 e tr≥6, ou td 20-50 e tr 2-5, ou td≥51 e tr=1 | Alta: restante

IMPORTANTE: Use o contexto do sistema acima para embasar sua análise. Considere integrações, padrões de tela
e módulos que o chamado referencia — mas NUNCA use isso como justificativa para multiplicar elementos além
do estritamente necessário.

Retorne APENAS um JSON válido no formato:
{"resumoGeral":"1-2 frases resumindo como você interpretou o chamado como um todo","elementos":[{"processo":"...","tipo":"CE|SE|EE|ALI|AIE","operacao":"I|A|E","td":N,"arTr":N,"complexidade":"Baixa|Media|Alta","justificativa":"..."}]}

Se não houver informação suficiente para uma análise precisa, faça sua melhor estimativa com pelo menos 1 elemento.`;

  const userContent = `TÍTULO: ${title}\nDESCRIÇÃO: ${description}\nDETALHAMENTO: ${patiComment}${extraContext ? `\nCONTEXTO ADICIONAL (entrevista com analista):\n${extraContext}` : ''}`;

  const jsonText = await callLLMJson(systemPrompt, userContent, 'apf_geracao');

  try {
    const parsed = JSON.parse(jsonText);
    return { elementos: parsed.elementos || [], resumoGeral: parsed.resumoGeral || '' };
  } catch {
    throw new Error('Falha ao interpretar resposta da LLM para APF');
  }
}

// ─── IFPUG complexity recalculation (server-side correction) ───
function recalcularComplexidade(tipo: string, td: number, arTr: number): 'Baixa' | 'Media' | 'Alta' {
  if (tipo === 'EE') {
    if ((td <= 15 && arTr <= 1) || (td <= 4 && arTr === 2)) return 'Baixa';
    if ((td <= 4 && arTr >= 3) || (td >= 5 && td <= 15 && arTr === 2) || (td >= 16 && arTr <= 1)) return 'Media';
    return 'Alta';
  }
  if (tipo === 'SE' || tipo === 'CE') {
    if ((td <= 19 && arTr <= 1) || (td <= 5 && arTr <= 3)) return 'Baixa';
    if ((td <= 5 && arTr >= 4) || (td >= 6 && td <= 19 && arTr >= 2 && arTr <= 3) || (td >= 20 && arTr <= 1)) return 'Media';
    return 'Alta';
  }
  if (tipo === 'ALI' || tipo === 'AIE') {
    if ((td <= 50 && arTr === 1) || (td <= 19 && arTr >= 1 && arTr <= 5)) return 'Baixa';
    if ((td <= 19 && arTr >= 6) || (td >= 20 && td <= 50 && arTr >= 2 && arTr <= 5) || (td >= 51 && arTr === 1)) return 'Media';
    return 'Alta';
  }
  return 'Baixa'; // fallback
}

// ─── Calculate APF from elements ───
export function calculateApf(elementos: ApfElement[], params: ApfParametros): ApfResult {
  let totalPF = 0;
  let totalPFA = 0;

  const calculatedElements = elementos.map(el => {
    const complexidade = recalcularComplexidade(el.tipo, el.td, el.arTr);
    const pf = PF_TABLE[el.tipo]?.[complexidade] || 3;
    const deflator = el.operacao === 'I' ? params.DeflatorInclusao
      : el.operacao === 'A' ? params.DeflatorAlteracao
      : params.DeflatorExclusao;
    const pfa = +(pf * deflator).toFixed(2);
    totalPF += pf;
    totalPFA += pfa;
    return { ...el, complexidade, pf };
  });

  totalPFA = +totalPFA.toFixed(2);
  const totalHoras = +(totalPFA * params.Produtividade).toFixed(1);

  const horasDetalhamento = {
    gestao: +(totalHoras * params.CicloGestao / 100).toFixed(1),
    analiseNegocio: +(totalHoras * params.CicloAnaliseNegocio / 100).toFixed(1),
    analiseTestes: +(totalHoras * params.CicloAnaliseTestes / 100).toFixed(1),
    codificacao: +(totalHoras * params.CicloCodificacao / 100).toFixed(1),
    execucaoTestes: +(totalHoras * params.CicloExecucaoTestes / 100).toFixed(1),
    homologacao: +(totalHoras * params.CicloHomologacao / 100).toFixed(1),
  };

  return { elementos: calculatedElements, totalPF, totalPFA, totalHoras, horasDetalhamento };
}

// ─── Generate APF for a work item ───
export async function generateApf(workItemId: number, extraContext?: string): Promise<{ apf: ApfResult; pdfBuffer: Buffer }> {
  const pool = await getPool();

  // Get work item
  const wiResult = await pool.request()
    .input('id', sql.Int, workItemId)
    .query(`SELECT Id, Title, Description, ClienteNome, Modulo, DiscussionPati, DevOpsAreaPath FROM WorkItems WHERE Id = @id`);
  const wi = wiResult.recordset[0];
  if (!wi) throw new Error('Work item não encontrado');
  if (!wi.DiscussionPati && !extraContext && !wi.Description) throw new Error('Nenhum detalhamento encontrado para este item. O chamado precisa ter ao menos uma descrição.');

  // Get params
  const params = await getApfParametros();

  // Diretriz de contagem do projeto (complementar ao IFPUG, opcional)
  const projectDiretriz = await getDiretrizForProject(wi.DevOpsAreaPath);

  // Call LLM
  const { elementos, resumoGeral } = await callOllamaForApf(wi.Title, wi.Description || '', wi.DiscussionPati || '', extraContext, workItemId, projectDiretriz);
  if (elementos.length === 0) throw new Error('LLM não identificou elementos funcionais');

  // Calculate
  const apf = calculateApf(elementos, params);

  // Update EsforcoAPF on work item
  await pool.request()
    .input('id', sql.Int, workItemId)
    .input('horas', sql.Decimal(10, 2), apf.totalHoras)
    .query(`UPDATE WorkItems SET EsforcoAPF = @horas, AtualizadoEm = GETDATE() WHERE Id = @id`);

  // Generate PDF
  const pdfBuffer = await generateApfPdf(wi, apf, params, resumoGeral);

  // Generate Excel from template
  const excelBuffer = await generateApfExcel(wi, apf, params);

  // Save PDF document to DB (with elements JSON for refinement)
  await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(20), 'APF')
    .input('nome', sql.NVarChar(300), `APF_${workItemId}_${wi.ClienteNome || 'SRM'}.pdf`)
    .input('conteudo', sql.VarBinary(sql.MAX), pdfBuffer)
    .input('elementos', sql.NVarChar(sql.MAX), JSON.stringify(apf.elementos))
    .query(`
      DELETE FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = @tipo;
      INSERT INTO DocumentosGerados (WorkItemId, Tipo, NomeArquivo, Conteudo, ElementosJson) VALUES (@wiId, @tipo, @nome, @conteudo, @elementos);
    `);

  // Save Excel document to DB
  await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(20), 'APF_EXCEL')
    .input('nome', sql.NVarChar(300), `APF_${workItemId}_${wi.ClienteNome || 'SRM'}.xlsx`)
    .input('conteudo', sql.VarBinary(sql.MAX), excelBuffer)
    .input('elementos', sql.NVarChar(sql.MAX), JSON.stringify(apf.elementos))
    .query(`
      DELETE FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = @tipo;
      INSERT INTO DocumentosGerados (WorkItemId, Tipo, NomeArquivo, Conteudo, ElementosJson) VALUES (@wiId, @tipo, @nome, @conteudo, @elementos);
    `);

  // Atualiza a Base de Conhecimento com o estado ATUAL da contagem deste chamado (upsert)
  await upsertContagemApfKnowledge(workItemId, wi, apf, resumoGeral);

  return { apf, pdfBuffer };
}

// ─── Generate Business Spec ───
export async function generateSpec(workItemId: number, extraContext?: string): Promise<{ content: string; pdfBuffer: Buffer }> {
  const pool = await getPool();

  const wiResult = await pool.request()
    .input('id', sql.Int, workItemId)
    .query(`SELECT Id, Title, Description, ClienteNome, Modulo, DiscussionPati FROM WorkItems WHERE Id = @id`);
  const wi = wiResult.recordset[0];
  if (!wi) throw new Error('Work item não encontrado');
  if (!wi.DiscussionPati && !extraContext && !wi.Description) throw new Error('Nenhum detalhamento encontrado para este item. O chamado precisa ter ao menos uma descrição.');

  // Build consolidated context: Description + [PATI] comments + interview history
  const contextoFinal = buildContextoFinal(wi.Description, wi.DiscussionPati, undefined);

  // Se já existe uma contagem APF para este item, inclui como contexto para manter consistência
  const apfKnowledge = await pool.request()
    .input('wid', sql.Int, workItemId)
    .query(`SELECT Conteudo FROM PatiConhecimento WHERE Categoria = 'contagem_apf' AND WorkItemRef = @wid AND Ativo = 1`);
  const contagemApfContexto = apfKnowledge.recordset.length > 0
    ? `\nCONTAGEM APF JÁ REALIZADA PARA ESTE CHAMADO (use para manter consistência com a especificação):\n${apfKnowledge.recordset[0].Conteudo}\n`
    : '';

  const prompt = `Você é um analista de negócios especializado em especificações funcionais de sistemas corporativos da Paradigma.
Gere uma ESPECIFICAÇÃO DE NEGÓCIO completa e profissional para o chamado abaixo.

A especificação deve conter:
1. OBJETIVO - O que a funcionalidade faz e por que é necessária
2. ESCOPO - O que está incluso e excluso
3. REGRAS DE NEGÓCIO - Todas as regras que a implementação deve seguir (numere: RN01, RN02...)
4. REQUISITOS FUNCIONAIS - Lista detalhada de funcionalidades (numere: RF01, RF02...)
5. REQUISITOS NÃO-FUNCIONAIS - Performance, segurança, etc. se aplicável
6. CRITÉRIOS DE ACEITAÇÃO - Condições para considerar a entrega completa
7. FLUXO PRINCIPAL - Passos do fluxo feliz
8. FLUXOS ALTERNATIVOS - Exceções e caminhos alternativos
9. PREMISSAS - Informações assumidas para elaboração deste documento

TÍTULO: ${wi.Title}
MÓDULO: ${wi.Modulo || 'N/A'}
CLIENTE: ${wi.ClienteNome || 'N/A'}

CONTEXTO CONSOLIDADO (Descrição + Comentários [PATI] + Interrogatório):
${contextoFinal}
${contagemApfContexto}${extraContext ? `
INTERROGATÓRIO APF (respostas do analista):
${extraContext}` : ''}

Escreva em português brasileiro, de forma clara e objetiva. Use formatação com cabeçalhos e numeração.`;

  const content = await callLLMText(prompt, 'spec_geracao');

  // Generate PDF
  const pdfBuffer = await generateSpecPdf(wi, content);

  // Save document
  await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(20), 'SPEC')
    .input('nome', sql.NVarChar(300), `SPEC_${workItemId}_${wi.ClienteNome || 'SRM'}.pdf`)
    .input('conteudo', sql.VarBinary(sql.MAX), pdfBuffer)
    .query(`
      DELETE FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = @tipo;
      INSERT INTO DocumentosGerados (WorkItemId, Tipo, NomeArquivo, Conteudo) VALUES (@wiId, @tipo, @nome, @conteudo);
    `);

  return { content, pdfBuffer };
}

// ─── Refine APF via chat instruction ───
export async function refineApf(
  workItemId: number,
  instrucao: string,
  auditUser?: { userId: string; name: string; email: string } | null,
): Promise<{ apf: ApfResult; changes: string }> {
  const pool = await getPool();

  // Get work item
  const wiResult = await pool.request()
    .input('id', sql.Int, workItemId)
    .query(`SELECT Id, Title, Description, ClienteNome, Modulo, DiscussionPati, DevOpsAreaPath FROM WorkItems WHERE Id = @id`);
  const wi = wiResult.recordset[0];
  if (!wi) throw new Error('Work item não encontrado');

  // Get current elements
  const docResult = await pool.request()
    .input('wiId', sql.Int, workItemId)
    .query(`SELECT ElementosJson FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = 'APF'`);
  const currentDoc = docResult.recordset[0];
  if (!currentDoc || !currentDoc.ElementosJson) {
    throw new Error('Nenhuma APF gerada para este chamado. Gere primeiro com "gerar APF do ' + workItemId + '".');
  }

  const currentElements: ApfElement[] = JSON.parse(currentDoc.ElementosJson);
  const params = await getApfParametros();

  // Diretriz de contagem do projeto (complementar ao IFPUG, opcional)
  const projectDiretriz = await getDiretrizForProject(wi.DevOpsAreaPath);

  // Get relevant knowledge for context (inclui o estado atual da contagem deste mesmo item)
  const knowledge = await getRelevantKnowledge(wi.Title, wi.Description || '', instrucao, workItemId);

  // Build consolidated context for refinement: Description + [PATI] comments
  const contextoRefinamento = buildContextoFinal(wi.Description, wi.DiscussionPati);

  // Reaproveita tudo que já foi coletado em entrevistas/refinamentos anteriores deste
  // chamado — evita que o analista precise reexplicar o que já foi respondido antes.
  const contextoAcumulado = await getContextoAcumulado(workItemId);

  // Call LLM to refine
  const prompt = `Você é um analista de Pontos de Função (APF) especializado na metodologia IFPUG, atuando sobre
diferentes produtos e unidades de negócio da Paradigma.
Você já realizou uma contagem APF para o chamado abaixo. O usuário deseja ajustar a contagem com base em novas informações.

${knowledge}
${projectDiretriz ? `=== CONTEXTO DE NEGÓCIO DESTE PROJETO (diretriz configurada pelo time, apenas orientativa) ===
${projectDiretriz}
IMPORTANTE: essa diretriz é só um guia de contexto de produto — as regras de complexidade IFPUG abaixo SEMPRE prevalecem.
` : ''}
PRINCÍPIO DE PARCIMÔNIA — MUITO IMPORTANTE:
- Conte o MENOR número de elementos que descreva fielmente a mudança. Nunca infira elementos extras.
- ALI (Arquivo Lógico Interno) e AIE (Arquivo de Interface Externa) representam GRUPOS DE DADOS mantidos ou
  referenciados pela aplicação — NUNCA representam telas, layout ou componentes visuais.
- Se o dado já existe no banco e a tela/consulta já existe, ajuste apenas o elemento EXISTENTE (Alteração),
  sem criar elementos novos para representar a interface visual ou o dado em si.

CHAMADO: #${wi.Id} - ${wi.Title}
CLIENTE: ${wi.ClienteNome || 'N/A'}
CONTEXTO CONSOLIDADO (Descrição + Comentários [PATI]):
${contextoRefinamento.slice(0, 1500)}
${contextoAcumulado ? `
CONTEXTO JÁ LEVANTADO EM ENTREVISTAS/AJUSTES ANTERIORES (não peça essas informações de novo, use para embasar o ajuste):
${contextoAcumulado.slice(0, 3000)}
` : ''}
CONTAGEM ATUAL (elementos):
${JSON.stringify(currentElements, null, 2)}

INSTRUÇÃO DO USUÁRIO PARA AJUSTE:
"${instrucao}"

Com base na instrução, ajuste a contagem:
- Adicione novos elementos se o usuário menciona novas funcionalidades, integrações, telas, APIs, etc.
- Remova elementos se o usuário pede para remover
- Altere complexidade, tipo ou operação se solicitado
- Mantenha os elementos não afetados pela instrução

Para cada elemento, determine:
- processo: nome descritivo
- tipo: CE (Consulta Externa), SE (Saída Externa), EE (Entrada Externa), ALI (Arquivo Lógico Interno), AIE (Arquivo de Interface Externa)
- operacao: I (Inclusão), A (Alteração), E (Exclusão)
- td: número de Tipos de Dados
- arTr: número de Arquivos Referenciados ou Tipos de Registro
- complexidade: Baixa, Media, Alta (use as regras IFPUG)
- justificativa: 1 a 3 frases explicando por que esse elemento ficou com esse TD/AR-TR/operação/complexidade, citando o chamado ou a instrução do usuário. Para elementos não afetados pela instrução, mantenha a justificativa anterior se houver.

REGRAS PARA OPERAÇÃO (I/A/E):
- I: elemento NOVO sendo adicionado ao sistema.
- A: elemento EXISTENTE sendo modificado ou estendido.
- E: APENAS quando o chamado pede explicitamente REMOVER uma funcionalidade — é muito raro.

Retorne APENAS um JSON válido:
{"elementos":[...],"resumoAlteracoes":"descrição curta do que mudou"}`;

  const jsonText = await callLLMJson('', prompt, 'apf_refinamento');

  let newElements: ApfElement[];
  let changes: string;
  try {
    const parsed = JSON.parse(jsonText);
    newElements = parsed.elementos || [];
    changes = parsed.resumoAlteracoes || 'Contagem ajustada conforme solicitado';
  } catch {
    throw new Error('Falha ao interpretar resposta da LLM para refinamento');
  }

  if (newElements.length === 0) throw new Error('LLM retornou contagem vazia após refinamento');

  // Calculate new APF
  const apf = calculateApf(newElements, params);

  // Save refinement history
  const currentApf = calculateApf(currentElements, params);
  await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('instrucao', sql.NVarChar(sql.MAX), instrucao)
    .input('antes', sql.NVarChar(sql.MAX), JSON.stringify(currentElements))
    .input('depois', sql.NVarChar(sql.MAX), JSON.stringify(newElements))
    .input('pfAntes', sql.Decimal(10, 2), currentApf.totalPF)
    .input('pfDepois', sql.Decimal(10, 2), apf.totalPF)
    .query(`INSERT INTO ApfRefinamentos (WorkItemId, InstrucaoUsuario, ElementosAntes, ElementosDepois, TotalPFAntes, TotalPFDepois) 
            VALUES (@wiId, @instrucao, @antes, @depois, @pfAntes, @pfDepois)`);

  // Update EsforcoAPF
  await pool.request()
    .input('id', sql.Int, workItemId)
    .input('horas', sql.Decimal(10, 2), apf.totalHoras)
    .query(`UPDATE WorkItems SET EsforcoAPF = @horas, AtualizadoEm = GETDATE() WHERE Id = @id`);

  // Regenerate PDF
  const pdfBuffer = await generateApfPdf(wi, apf, params, changes);

  // Regenerate Excel from template
  const excelBuffer = await generateApfExcel(wi, apf, params);

  // Update PDF document
  await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(20), 'APF')
    .input('nome', sql.NVarChar(300), `APF_${workItemId}_${wi.ClienteNome || 'SRM'}.pdf`)
    .input('conteudo', sql.VarBinary(sql.MAX), pdfBuffer)
    .input('elementos', sql.NVarChar(sql.MAX), JSON.stringify(newElements))
    .query(`
      DELETE FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = @tipo;
      INSERT INTO DocumentosGerados (WorkItemId, Tipo, NomeArquivo, Conteudo, ElementosJson) VALUES (@wiId, @tipo, @nome, @conteudo, @elementos);
    `);

  // Update Excel document
  await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(20), 'APF_EXCEL')
    .input('nome', sql.NVarChar(300), `APF_${workItemId}_${wi.ClienteNome || 'SRM'}.xlsx`)
    .input('conteudo', sql.VarBinary(sql.MAX), excelBuffer)
    .input('elementos', sql.NVarChar(sql.MAX), JSON.stringify(newElements))
    .query(`
      DELETE FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = @tipo;
      INSERT INTO DocumentosGerados (WorkItemId, Tipo, NomeArquivo, Conteudo, ElementosJson) VALUES (@wiId, @tipo, @nome, @conteudo, @elementos);
    `);

  // Auto-learn: store refinement as knowledge for future reference
  await autoLearnFromRefinement(pool, workItemId, wi.Title, instrucao, changes, currentElements.length, newElements.length);

  // Atualiza a Base de Conhecimento com o estado ATUAL da contagem deste chamado (upsert)
  await upsertContagemApfKnowledge(workItemId, wi, apf, changes);

  // ── Audit: mesma gravação de histórico de versões feita na geração completa (routes/documents.ts)
  // — sem isso, refinamentos incrementais nunca apareciam na tela "Histórico de Documentos".
  try {
    const versao = await nextVersion(workItemId, 'APF');
    await pool.request()
      .input('wid', sql.Int, workItemId)
      .input('wtitle', sql.NVarChar(500), wi.Title)
      .input('versao', sql.Int, versao)
      .input('pf', sql.Decimal(10, 2), apf.totalPF)
      .input('horas', sql.Decimal(10, 2), apf.totalHoras)
      .input('elementos', sql.NVarChar(sql.MAX), JSON.stringify(apf.elementos))
      .input('ctx', sql.NVarChar(sql.MAX), instrucao || null)
      .input('uid', sql.NVarChar(200), auditUser?.userId || null)
      .input('uname', sql.NVarChar(200), auditUser?.name || null)
      .input('uemail', sql.NVarChar(200), auditUser?.email || null)
      .query(`INSERT INTO DocumentVersionHistory
        (WorkItemId,WorkItemTitle,Tipo,Versao,TotalPF,TotalHoras,ElementosJson,InterviewContext,GeradoPorUserId,GeradoPorNome,GeradoPorEmail)
        VALUES (@wid,@wtitle,'APF',@versao,@pf,@horas,@elementos,@ctx,@uid,@uname,@uemail)`);
    if (auditUser) {
      await pool.request()
        .input('wid', sql.Int, workItemId)
        .input('uid', sql.NVarChar(200), auditUser.userId)
        .input('uname', sql.NVarChar(200), auditUser.name)
        .input('uemail', sql.NVarChar(200), auditUser.email)
        .input('ctx', sql.NVarChar(sql.MAX), instrucao || null)
        .query(`UPDATE DocumentosGerados SET GeradoPorUserId=@uid,GeradoPorNome=@uname,GeradoPorEmail=@uemail,InterviewContext=@ctx
                WHERE WorkItemId=@wid AND Tipo='APF'`);
    }
  } catch (auditErr: any) {
    console.warn('⚠️  Audit save failed (non-blocking):', auditErr.message);
  }

  return { apf, changes };
}

/** Próximo número de versão para WorkItemId+Tipo em DocumentVersionHistory — usado tanto na
 * geração completa (routes/documents.ts) quanto no refinamento incremental (refineApf). */
export async function nextVersion(workItemId: number, tipo: string): Promise<number> {
  const pool = await getPool();
  const r = await pool.request()
    .input('wid', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(10), tipo)
    .query(`SELECT ISNULL(MAX(Versao), 0) + 1 AS Next FROM DocumentVersionHistory WHERE WorkItemId = @wid AND Tipo = @tipo`);
  return r.recordset[0]?.Next ?? 1;
}

// ─── Auto-learn from refinements ───
async function autoLearnFromRefinement(
  pool: any, workItemId: number, title: string, instrucao: string, changes: string,
  elementsBefore: number, elementsAfter: number
): Promise<void> {
  try {
    // Only store significant refinements (elements changed)
    if (elementsBefore === elementsAfter) return;

    const diff = elementsAfter - elementsBefore;
    const action = diff > 0 ? `+${diff} elementos` : `${diff} elementos`;

    // Create a learned knowledge entry
    const conteudo = `Refinamento em #${workItemId} (${title}): Instrução: "${instrucao}" → ${changes}. Resultado: ${action} (${elementsBefore}→${elementsAfter}).`;

    // Extract tags from the instruction
    const lower = instrucao.toLowerCase();
    const tags: string[] = ['aprendido'];
    if (lower.includes('api') || lower.includes('integra')) tags.push('integracao', 'api');
    if (lower.includes('tela') || lower.includes('consulta')) tags.push('tela', 'consulta');
    if (lower.includes('relat') || lower.includes('export')) tags.push('relatorio');
    if (lower.includes('campo') || lower.includes('cadastro')) tags.push('cadastro', 'campo');
    if (lower.includes('regra') || lower.includes('valid')) tags.push('regra-negocio');

    await pool.request()
      .input('cat', sql.NVarChar(50), 'aprendizado')
      .input('titulo', sql.NVarChar(200), `Refinamento #${workItemId}: ${changes.slice(0, 150)}`)
      .input('conteudo', sql.NVarChar(sql.MAX), conteudo)
      .input('tags', sql.NVarChar(500), tags.join(','))
      .input('wiRef', sql.Int, workItemId)
      .query(`INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem, WorkItemRef) 
              VALUES (@cat, @titulo, @conteudo, @tags, 'aprendido', @wiRef)`);
  } catch (err: any) {
    // Don't fail the refinement if learning fails
    console.warn('Auto-learn failed:', err.message);
  }
}

// ─── Upsert do estado ATUAL da contagem APF de um work item na Base de Conhecimento ───
// Diferente de autoLearnFromRefinement (que sempre INSERE um histórico de aprendizado cruzado
// entre itens), esta função mantém UM ÚNICO registro por WorkItemRef com a contagem mais recente,
// consumido por getRelevantKnowledge() em futuras gerações/refinamentos/spec do MESMO item.
async function upsertContagemApfKnowledge(workItemId: number, wi: any, apf: ApfResult, resumoGeral: string): Promise<void> {
  try {
    const pool = await getPool();

    const linhasElementos = apf.elementos.map(el =>
      `- ${el.tipo} (${el.operacao}) "${el.processo}" — TD=${el.td}, AR/TR=${el.arTr}, Complexidade=${el.complexidade}, PF=${el.pf}${el.justificativa ? ` — ${el.justificativa}` : ''}`
    );
    const conteudo = [
      `Resumo: ${resumoGeral || '—'}`,
      `Total PF: ${apf.totalPF} | PF Ajustado: ${apf.totalPFA} | Horas estimadas: ${apf.totalHoras}`,
      'Elementos:',
      ...linhasElementos,
    ].join('\n');

    const titulo = `Contagem APF atual — #${workItemId}: ${wi.Title}`.slice(0, 200);

    const existing = await pool.request()
      .input('wid', sql.Int, workItemId)
      .query(`SELECT Id FROM PatiConhecimento WHERE Categoria = 'contagem_apf' AND WorkItemRef = @wid`);

    if (existing.recordset.length > 0) {
      await pool.request()
        .input('id', sql.Int, existing.recordset[0].Id)
        .input('titulo', sql.NVarChar(200), titulo)
        .input('conteudo', sql.NVarChar(sql.MAX), conteudo)
        .query(`UPDATE PatiConhecimento SET Titulo = @titulo, Conteudo = @conteudo, Ativo = 1, AtualizadoEm = GETDATE() WHERE Id = @id`);
    } else {
      await pool.request()
        .input('wid', sql.Int, workItemId)
        .input('titulo', sql.NVarChar(200), titulo)
        .input('conteudo', sql.NVarChar(sql.MAX), conteudo)
        .query(`INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem, WorkItemRef) 
                VALUES ('contagem_apf', @titulo, @conteudo, 'contagem_apf', 'aprendido', @wid)`);
    }
  } catch (err: any) {
    // Não deve quebrar a geração/refinamento se o upsert de conhecimento falhar
    console.warn('Upsert contagem_apf knowledge failed:', err.message);
  }
}

// ─── Get APF elements for a work item (for chat display) ───
export async function getApfElements(workItemId: number): Promise<ApfElement[] | null> {
  const pool = await getPool();
  const result = await pool.request()
    .input('wiId', sql.Int, workItemId)
    .query(`SELECT ElementosJson FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = 'APF'`);
  if (result.recordset.length === 0 || !result.recordset[0].ElementosJson) return null;
  return JSON.parse(result.recordset[0].ElementosJson);
}

/** Lista numerada e legível dos elementos já contados — usada na entrevista/refinamento pra o
 * analista (e a própria PATi) saberem exatamente o que já existe antes de pedir um ajuste. */
export async function getApfElementsSummary(workItemId: number): Promise<string> {
  const elementos = await getApfElements(workItemId);
  if (!elementos || elementos.length === 0) return '';
  return elementos
    .map((el, i) => `${i + 1}. [${el.tipo}-${el.operacao}] ${el.processo} — TD=${el.td}, AR/TR=${el.arTr}, Complexidade=${el.complexidade}`)
    .join('\n');
}

// ─── Knowledge Base CRUD ───
export async function getKnowledgeBase(): Promise<any[]> {
  const pool = await getPool();
  const result = await pool.request().query(
    `SELECT Id, Categoria, Titulo, Conteudo, Tags, Origem, WorkItemRef, Ativo, CriadoEm, AtualizadoEm 
     FROM PatiConhecimento ORDER BY Categoria, Titulo`
  );
  return result.recordset;
}

export async function addKnowledge(data: { categoria: string; titulo: string; conteudo: string; tags?: string }): Promise<any> {
  const pool = await getPool();
  const result = await pool.request()
    .input('cat', sql.NVarChar(50), data.categoria)
    .input('titulo', sql.NVarChar(200), data.titulo)
    .input('conteudo', sql.NVarChar(sql.MAX), data.conteudo)
    .input('tags', sql.NVarChar(500), data.tags || '')
    .query(`INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) 
            OUTPUT INSERTED.* VALUES (@cat, @titulo, @conteudo, @tags, 'manual')`);
  return result.recordset[0];
}

export async function updateKnowledge(id: number, data: { titulo?: string; conteudo?: string; tags?: string; ativo?: boolean }): Promise<any> {
  const pool = await getPool();
  const sets: string[] = ['AtualizadoEm = GETDATE()'];
  const request = pool.request().input('id', sql.Int, id);
  if (data.titulo !== undefined) { sets.push('Titulo = @t'); request.input('t', sql.NVarChar(200), data.titulo); }
  if (data.conteudo !== undefined) { sets.push('Conteudo = @c'); request.input('c', sql.NVarChar(sql.MAX), data.conteudo); }
  if (data.tags !== undefined) { sets.push('Tags = @tags'); request.input('tags', sql.NVarChar(500), data.tags); }
  if (data.ativo !== undefined) { sets.push('Ativo = @a'); request.input('a', sql.Bit, data.ativo ? 1 : 0); }
  await request.query(`UPDATE PatiConhecimento SET ${sets.join(', ')} WHERE Id = @id`);
  const result = await pool.request().input('id', sql.Int, id).query(`SELECT * FROM PatiConhecimento WHERE Id = @id`);
  return result.recordset[0];
}

export async function deleteKnowledge(id: number): Promise<void> {
  const pool = await getPool();
  await pool.request().input('id', sql.Int, id).query(`DELETE FROM PatiConhecimento WHERE Id = @id`);
}

// ─── APF PDF Generator ───
export async function generateApfPdf(wi: any, apf: ApfResult, params: ApfParametros, resumoGeral?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#033AF0')
      .text('Análise de Pontos de Função', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica').fillColor('#666')
      .text(`Gerado por PATi em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}`, { align: 'center' });
    doc.moveDown(1);

    // Work Item Info
    doc.fontSize(10).fillColor('#333').font('Helvetica-Bold');
    doc.text(`ID: ${wi.Id}`, { continued: true }).font('Helvetica').text(`  |  ${wi.Title}`);
    doc.font('Helvetica-Bold').text(`Cliente: `, { continued: true }).font('Helvetica').text(wi.ClienteNome || 'N/A');
    doc.font('Helvetica-Bold').text(`Módulo: `, { continued: true }).font('Helvetica').text(wi.Modulo || 'N/A');
    doc.moveDown(1);

    // Parameters summary
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1A3470').text('Parâmetros da Contagem:');
    doc.font('Helvetica').fillColor('#333');
    doc.text(`Produtividade: ${params.Produtividade} H/PF  |  Deflator Inclusão: ${params.DeflatorInclusao}  |  Alteração: ${params.DeflatorAlteracao}  |  Exclusão: ${params.DeflatorExclusao}`);
    doc.moveDown(1);

    // APF Table
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#033AF0').text('Planilha de Contagem de Pontos de Função');
    doc.moveDown(0.5);

    const tableTop = doc.y;
    const colWidths = [150, 30, 25, 25, 30, 50, 30, 35];
    const headers = ['Processo Elementar', 'Tipo', 'Op.', 'TD', 'AR/TR', 'Complex.', 'PF', 'PFA'];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    // Header row
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
    doc.rect(40, tableTop, tableWidth, 14).fill('#1A3470');
    let xPos = 40;
    headers.forEach((h, i) => {
      doc.fillColor('#fff').text(h, xPos + 2, tableTop + 3, { width: colWidths[i] - 4, align: 'center' });
      xPos += colWidths[i];
    });

    // Data rows
    let yPos = tableTop + 14;
    doc.font('Helvetica').fillColor('#333').fontSize(7);
    apf.elementos.forEach((el, idx) => {
      const deflator = el.operacao === 'I' ? params.DeflatorInclusao : el.operacao === 'A' ? params.DeflatorAlteracao : params.DeflatorExclusao;
      const pfa = +(el.pf * deflator).toFixed(2);
      const bgColor = idx % 2 === 0 ? '#f8f9fc' : '#ffffff';
      doc.rect(40, yPos, tableWidth, 12).fill(bgColor);
      xPos = 40;
      const rowData = [el.processo, el.tipo, el.operacao, String(el.td), String(el.arTr), el.complexidade, String(el.pf), pfa.toFixed(2)];
      rowData.forEach((val, i) => {
        doc.fillColor('#333').text(val, xPos + 2, yPos + 2, { width: colWidths[i] - 4, align: i === 0 ? 'left' : 'center' });
        xPos += colWidths[i];
      });
      yPos += 12;
    });

    // Totals row
    doc.rect(40, yPos, tableWidth, 14).fill('#EDF3FF');
    doc.font('Helvetica-Bold').fillColor('#1A3470');
    doc.text('TOTAL', 42, yPos + 3, { width: colWidths[0] - 4 });
    const lastTwoCols = colWidths.slice(0, 6).reduce((a, b) => a + b, 0);
    doc.text(String(apf.totalPF), 40 + lastTwoCols + 2, yPos + 3, { width: colWidths[6] - 4, align: 'center' });
    doc.text(apf.totalPFA.toFixed(2), 40 + lastTwoCols + colWidths[6] + 2, yPos + 3, { width: colWidths[7] - 4, align: 'center' });
    yPos += 20;

    // Hours breakdown
    doc.y = yPos + 10;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#033AF0').text('Ciclo Produtivo - Distribuição de Horas');
    doc.moveDown(0.5);

    const cycleTop = doc.y;
    const cycleHeaders = ['Etapa', 'Participação', 'Horas'];
    const cycleWidths = [180, 80, 60];
    const cycleWidth = cycleWidths.reduce((a, b) => a + b, 0);

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
    doc.rect(40, cycleTop, cycleWidth, 14).fill('#1A3470');
    xPos = 40;
    cycleHeaders.forEach((h, i) => {
      doc.fillColor('#fff').text(h, xPos + 2, cycleTop + 3, { width: cycleWidths[i] - 4, align: 'center' });
      xPos += cycleWidths[i];
    });

    const cycleData = [
      ['Gestão do Projeto', `${params.CicloGestao}%`, apf.horasDetalhamento.gestao.toFixed(1)],
      ['Análise de Negócio/Técnica', `${params.CicloAnaliseNegocio}%`, apf.horasDetalhamento.analiseNegocio.toFixed(1)],
      ['Análise de Testes', `${params.CicloAnaliseTestes}%`, apf.horasDetalhamento.analiseTestes.toFixed(1)],
      ['Codificação', `${params.CicloCodificacao}%`, apf.horasDetalhamento.codificacao.toFixed(1)],
      ['Execução dos Testes', `${params.CicloExecucaoTestes}%`, apf.horasDetalhamento.execucaoTestes.toFixed(1)],
      ['Homologação', `${params.CicloHomologacao}%`, apf.horasDetalhamento.homologacao.toFixed(1)],
    ];

    yPos = cycleTop + 14;
    doc.font('Helvetica').fillColor('#333').fontSize(7);
    cycleData.forEach((row, idx) => {
      const bgColor = idx % 2 === 0 ? '#f8f9fc' : '#ffffff';
      doc.rect(40, yPos, cycleWidth, 12).fill(bgColor);
      xPos = 40;
      row.forEach((val, i) => {
        doc.fillColor('#333').text(val, xPos + 2, yPos + 2, { width: cycleWidths[i] - 4, align: i === 0 ? 'left' : 'center' });
        xPos += cycleWidths[i];
      });
      yPos += 12;
    });

    // Total row
    doc.rect(40, yPos, cycleWidth, 14).fill('#EDF3FF');
    doc.font('Helvetica-Bold').fillColor('#1A3470');
    doc.text('Total de Horas', 42, yPos + 3, { width: cycleWidths[0] - 4 });
    doc.text('100%', 40 + cycleWidths[0] + 2, yPos + 3, { width: cycleWidths[1] - 4, align: 'center' });
    doc.text(apf.totalHoras.toFixed(1), 40 + cycleWidths[0] + cycleWidths[1] + 2, yPos + 3, { width: cycleWidths[2] - 4, align: 'center' });

    // Summary box
    doc.y = yPos + 30;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1A3470');
    doc.text(`Resumo: Total PF = ${apf.totalPF}  |  PF Ajustado = ${apf.totalPFA}  |  Total Horas = ${apf.totalHoras}`, { align: 'center' });

    // Memória de Cálculo / Justificativa da Contagem — texto livre, sem limite de coluna
    doc.addPage();
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#033AF0')
      .text('Memória de Cálculo — Justificativa da Contagem', { align: 'left' });
    doc.moveDown(0.8);

    if (resumoGeral) {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1A3470').text('Resumo geral da análise:');
      doc.font('Helvetica').fillColor('#333').fontSize(9).text(resumoGeral);
      doc.moveDown(1);
    }

    apf.elementos.forEach((el, idx) => {
      if (doc.y > 700) doc.addPage();
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1A3470')
        .text(`${idx + 1}. ${el.processo}`);
      doc.font('Helvetica').fillColor('#666').fontSize(8)
        .text(`Tipo: ${el.tipo}  |  Operação: ${el.operacao}  |  TD: ${el.td}  |  AR/TR: ${el.arTr}  |  Complexidade: ${el.complexidade}  |  PF: ${el.pf}`);
      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text(el.justificativa || 'Justificativa não informada pela análise.');
      doc.moveDown(0.8);
    });

    doc.end();
  });
}

// ─── APF Excel Generator (from template) ───
// Uses JSZip to manipulate raw XML — ExcelJS corrupts the Table3 structured table

// Adds a string to sharedStrings and returns its index
function addSharedString(sharedStrings: string[], value: string): number {
  sharedStrings.push(value);
  return sharedStrings.length - 1;
}

function setCellValue(xml: string, cellRef: string, value: string | number | null, sharedStrings?: string[], existingCount?: number): string {  const selfClosing = new RegExp(`<c r="${cellRef}"([^>]*?)/>`, 's');
  const withContent = new RegExp(`<c r="${cellRef}"([^>]*?)>.*?</c>`, 's');

  if (value === null || value === '') {
    return xml;
  }

  const stripType = (attrs: string) => attrs.replace(/\s*t="[^"]*"/, '');

  let buildReplacement: (attrs: string) => string;
  if (typeof value === 'number') {
    buildReplacement = (attrs) => `<c r="${cellRef}"${stripType(attrs)}><v>${value}</v></c>`;
  } else if (sharedStrings && existingCount !== undefined) {
    // Use shared string reference
    const idx = existingCount + addSharedString(sharedStrings, String(value));
    buildReplacement = (attrs) => `<c r="${cellRef}"${stripType(attrs)} t="s"><v>${idx}</v></c>`;
  } else {
    const escaped = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    buildReplacement = (attrs) => `<c r="${cellRef}"${stripType(attrs)} t="inlineStr"><is><t>${escaped}</t></is></c>`;
  }

  let match = xml.match(selfClosing);
  if (match) {
    return xml.replace(selfClosing, buildReplacement(match[1]));
  }
  match = xml.match(withContent);
  if (match) {
    return xml.replace(withContent, buildReplacement(match[1]));
  }
  return xml;
}

// Ajusta a altura de uma linha (para caber texto quebrado em várias linhas — sem isso o Excel
// mantém a altura padrão de 1 linha e o texto excedente fica visualmente cortado).
function setRowHeight(xml: string, rowNum: number, heightPt: number): string {
  const tagRe = new RegExp(`<row r="${rowNum}"([^>]*)>`);
  const m = xml.match(tagRe);
  if (!m) return xml;
  let attrs = m[1];
  attrs = /\sht="[\d.]+"/.test(attrs) ? attrs.replace(/\sht="[\d.]+"/, ` ht="${heightPt}"`) : `${attrs} ht="${heightPt}"`;
  if (!/customHeight="1"/.test(attrs)) attrs += ' customHeight="1"';
  return xml.replace(tagRe, `<row r="${rowNum}"${attrs}>`);
}

// Estima quantas linhas um texto ocupa quebrado numa coluna de N caracteres de largura,
// para calcular a altura de linha necessária (heurística simples, não precisa ser exata).
function estimateWrappedLines(text: string, charsPerLine: number): number {
  if (!text) return 1;
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

export async function generateApfExcel(wi: any, apf: ApfResult, params: ApfParametros): Promise<Buffer> {
  // __dirname referencia o diretório do arquivo compilado (dist/services),
  // então subimos 2 níveis para chegar em dist/ e depois entramos em templates/
  const templatePath = resolve(__dirname, '../../templates', 'Modelo APF.xlsx');
  const templateBuf = readFileSync(templatePath);
  const zip = await JSZip.loadAsync(templateBuf);

  // ─── Read shared strings to add new text values properly ───
  let sharedStringsXml = await zip.file('xl/sharedStrings.xml')!.async('string');
  // uniqueCount = actual number of <si> elements (the index base for new strings)
  const uniqueMatch = sharedStringsXml.match(/uniqueCount="(\d+)"/);
  const existingCount = uniqueMatch ? parseInt(uniqueMatch[1]) : 0;
  const newStrings: string[] = []; // collector for new strings

  // ─── Aba Contagem (sheet1.xml) ───
  let sheet1 = await zip.file('xl/worksheets/sheet1.xml')!.async('string');

  // Identificação (text cells use shared strings)
  // "Aplicação" usa o Módulo (Cotação/Pedidos/Fornecedores...) — o DevOpsAreaPath tem só 1-2
  // valores possíveis pra todo o sistema, então sempre aparecia o mesmo texto pra todo chamado.
  const aplicacaoLabel = wi.Modulo || (wi.DevOpsAreaPath ? String(wi.DevOpsAreaPath).split('\\')[0] : 'N/A');
  sheet1 = setCellValue(sheet1, 'G5', wi.ClienteNome || 'N/A', newStrings, existingCount);
  sheet1 = setCellValue(sheet1, 'G6', aplicacaoLabel, newStrings, existingCount);
  sheet1 = setCellValue(sheet1, 'G7', `#${wi.Id} - ${wi.Title}`, newStrings, existingCount);
  sheet1 = setCellValue(sheet1, 'G8', 'PATi - Geração Automática', newStrings, existingCount);

  // Deflatores
  sheet1 = setCellValue(sheet1, 'V12', params.DeflatorInclusao);
  sheet1 = setCellValue(sheet1, 'V13', params.DeflatorAlteracao);
  sheet1 = setCellValue(sheet1, 'V14', params.DeflatorExclusao);

  // Produtividade
  sheet1 = setCellValue(sheet1, 'Z19', params.Produtividade);

  // Ciclo produtivo (decimais)
  sheet1 = setCellValue(sheet1, 'V26', params.CicloGestao / 100);
  sheet1 = setCellValue(sheet1, 'V27', params.CicloAnaliseNegocio / 100);
  sheet1 = setCellValue(sheet1, 'V28', params.CicloAnaliseTestes / 100);
  sheet1 = setCellValue(sheet1, 'V29', params.CicloCodificacao / 100);
  sheet1 = setCellValue(sheet1, 'V30', params.CicloExecucaoTestes / 100);
  sheet1 = setCellValue(sheet1, 'V31', params.CicloHomologacao / 100);

  // Propósito
  sheet1 = setCellValue(sheet1, 'B35', `Análise de Pontos de Função para o chamado #${wi.Id} - ${wi.Title}. Gerado automaticamente por PATi em ${new Date().toLocaleDateString('pt-BR')}.`, newStrings, existingCount);

  // Remove cached formula values in Contagem to force recalculation
  const formulaCachePattern = /(<c r="[^"]*"[^>]*>(?:<f[^>]*>.*?<\/f>|<f[^/]*\/>))<v>[^<]*<\/v>/g;
  sheet1 = sheet1.replace(formulaCachePattern, '$1');

  zip.file('xl/worksheets/sheet1.xml', sheet1);

  // ─── Aba Funções (sheet2.xml) ───
  let sheet2 = await zip.file('xl/worksheets/sheet2.xml')!.async('string');

  // Replace "Empresa: DOCOL" in B5 with actual client name
  sheet2 = setCellValue(sheet2, 'B5', `Empresa: ${wi.ClienteNome || 'N/A'}`, newStrings, existingCount);
  // B7 ("Projeto") era texto fixo no template ("Projeto: HPF Data de Programação"), nunca
  // substituído — sempre aparecia igual em toda planilha gerada. Agora reflete o chamado real.
  sheet2 = setCellValue(sheet2, 'B7', `Projeto: #${wi.Id} - ${wi.Title}`, newStrings, existingCount);

  // Fill elements into rows 11-20 (text via shared strings, numbers direct)
  apf.elementos.forEach((el, idx) => {
    const row = 11 + idx;
    if (row > 20) return; // Template supports up to 10 rows
    sheet2 = setCellValue(sheet2, `B${row}`, el.processo, newStrings, existingCount);
    sheet2 = setCellValue(sheet2, `D${row}`, el.tipo, newStrings, existingCount);
    sheet2 = setCellValue(sheet2, `E${row}`, el.operacao, newStrings, existingCount);
    sheet2 = setCellValue(sheet2, `F${row}`, el.td);
    sheet2 = setCellValue(sheet2, `G${row}`, el.arTr);
    // Coluna "Observações" (AH) recebe a justificativa da contagem gerada pela IA
    sheet2 = setCellValue(sheet2, `AH${row}`, el.justificativa || '', newStrings, existingCount);

    // Expande a altura da linha pra caber o texto quebrado (coluna B ~89 caracteres de
    // largura, coluna AH ~69) — sem isso, qualquer texto que quebre em 2+ linhas fica
    // visualmente cortado até o usuário redimensionar manualmente a linha no Excel.
    const lines = Math.max(
      estimateWrappedLines(el.processo || '', 85),
      estimateWrappedLines(el.justificativa || '', 65),
    );
    sheet2 = setRowHeight(sheet2, row, Math.min(Math.max(lines * 14, 15), 150));
  });

  // Fix column D (Tipo) alignment: original styles 117/124 have numFmtId=4 (number format)
  // which causes Excel to ignore horizontal alignment for text values.
  // Style 2 (used by col E) has numFmtId=0 + center alignment and works correctly.
  for (let r = 11; r <= 20; r++) {
    sheet2 = sheet2.replace(new RegExp(`<c r="D${r}" s="\\d+"`), `<c r="D${r}" s="2"`);
  }

  // Normalize column B styles: original uses mix of 125/124/122/121/104 causing
  // inconsistent appearance. Use style 104 (left, fontId=13 non-bold, wrapText) for all.
  for (let r = 11; r <= 20; r++) {
    sheet2 = sheet2.replace(new RegExp(`<c r="B${r}" s="\\d+"`), `<c r="B${r}" s="104"`);
  }

  // Normalize column E row 20: uses style 106 instead of 118 (missing fill/color).
  sheet2 = sheet2.replace(/<c r="E20" s="\d+"/, '<c r="E20" s="118"');

  // Remove cached formula values in data rows to force recalculation
  // Matches formula cells like: <f>...</f><v>0</v> or <f .../>...<v>...</v>
  // Replace cached <v>...</v> after <f> elements with empty (forces Excel to recalculate)
  // Include header rows (6-9) that have SUM(Table3[...]) formulas + data/total rows
  const sheet2FormulaCache = /(<c r="[^"]*"[^>]*>(?:<f[^>]*>.*?<\/f>|<f[^/]*\/>))<v>[^<]*<\/v>/g;
  sheet2 = sheet2.replace(sheet2FormulaCache, '$1');

  zip.file('xl/worksheets/sheet2.xml', sheet2);

  // ─── Fix logo dimensions: prevent stretching (logo oficial, 613x139px, aspect ~4.41:1) ───
  let drawing1 = await zip.file('xl/drawings/drawing1.xml')!.async('string');
  drawing1 = drawing1.replace(
    /<a:ext cx="1609724" cy="337993"\/>/,
    '<a:ext cx="1324800" cy="300405"/>'
  );
  // Adjust twoCellAnchor end position to match new width
  drawing1 = drawing1.replace(
    /<xdr:to><xdr:col>10<\/xdr:col><xdr:colOff>38100<\/xdr:colOff>/,
    '<xdr:to><xdr:col>8</xdr:col><xdr:colOff>115126</xdr:colOff>'
  );
  zip.file('xl/drawings/drawing1.xml', drawing1);

  // ─── Fix logo dimensions in sheet2 (drawing2.xml) ───
  let drawing2 = await zip.file('xl/drawings/drawing2.xml')!.async('string');
  drawing2 = drawing2.replace(
    /<a:ext cx="1609724" cy="337993"\/>/,
    '<a:ext cx="1324800" cy="300405"/>'
  );
  drawing2 = drawing2.replace(
    /<xdr:to><xdr:col>1<\/xdr:col><xdr:colOff>1609724<\/xdr:colOff>/,
    '<xdr:to><xdr:col>1</xdr:col><xdr:colOff>1324800</xdr:colOff>'
  );
  zip.file('xl/drawings/drawing2.xml', drawing2);

  // Remove calcChain.xml — forces Excel to recalculate all formulas on open
  zip.remove('xl/calcChain.xml');

  // Remove calcChain references from content types and relationships
  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  contentTypes = contentTypes.replace(/<Override[^>]*calcChain[^>]*\/>/, '');
  zip.file('[Content_Types].xml', contentTypes);

  let wbRels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  wbRels = wbRels.replace(/<Relationship[^>]*calcChain[^>]*\/>/, '');
  zip.file('xl/_rels/workbook.xml.rels', wbRels);

  // Fix alignment in styles.xml
  let styles = await zip.file('xl/styles.xml')!.async('string');

  // Fix DXF formats in table columns: add center alignment to Tipo (DXF 46), TD (DXF 44), AR/TR (DXF 43)
  // Must use positional replacement within <dxfs> section to avoid corrupting duplicate DXFs
  // OOXML schema order within <dxf>: font, numFmt, fill, alignment, border, protection
  // Alignment must have ALL 8 attributes for Excel to apply it (partial is ignored)
  const dxfsStart = styles.indexOf('<dxfs');
  const dxfsEnd = styles.indexOf('</dxfs>') + '</dxfs>'.length;
  let dxfsSection = styles.substring(dxfsStart, dxfsEnd);
  const dxfIndices = [43, 44, 46]; // indices that need center alignment added
  const fullAlignment = '<alignment horizontal="center" vertical="center" textRotation="0" wrapText="0" indent="0" justifyLastLine="0" shrinkToFit="0" readingOrder="0"/>';
  let dxfIdx = 0;
  dxfsSection = dxfsSection.replace(/<dxf>([\s\S]*?)<\/dxf>/g, (match, inner) => {
    const currentIdx = dxfIdx++;
    if (dxfIndices.includes(currentIdx) && !inner.includes('<alignment')) {
      // Insert alignment AFTER </fill> to respect OOXML element order
      const aligned = inner.replace(/<\/fill>/, '</fill>' + fullAlignment);
      return '<dxf>' + aligned + '</dxf>';
    }
    return match;
  });
  styles = styles.substring(0, dxfsStart) + dxfsSection + styles.substring(dxfsEnd);

  zip.file('xl/styles.xml', styles);

  // Set fullCalcOnLoad in workbook.xml to guarantee recalculation
  let workbook = await zip.file('xl/workbook.xml')!.async('string');
  if (workbook.includes('<calcPr')) {
    workbook = workbook.replace(/<calcPr[^/]*\/>/, '<calcPr calcId="0" fullCalcOnLoad="1"/>');
  } else {
    workbook = workbook.replace('</workbook>', '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
  }
  zip.file('xl/workbook.xml', workbook);

  // ─── Fix Table3: disable row stripes (causes inconsistent bold) ───
  let table1 = await zip.file('xl/tables/table1.xml')!.async('string');
  table1 = table1.replace('showRowStripes="1"', 'showRowStripes="0"');
  zip.file('xl/tables/table1.xml', table1);

  // ─── Update sharedStrings.xml with new strings ───
  if (newStrings.length > 0) {
    const newUniqueCount = existingCount + newStrings.length;
    // count = total references (existing + new), uniqueCount = unique entries
    const existingCountAttr = sharedStringsXml.match(/count="(\d+)"/);
    const newCount = (existingCountAttr ? parseInt(existingCountAttr[1]) : 0) + newStrings.length;
    sharedStringsXml = sharedStringsXml.replace(/count="\d+"/, `count="${newCount}"`);
    sharedStringsXml = sharedStringsXml.replace(/uniqueCount="\d+"/, `uniqueCount="${newUniqueCount}"`);
    // Insert new <si> elements before closing </sst>
    const newSiElements = newStrings.map(s => {
      const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<si><t>${escaped}</t></si>`;
    }).join('');
    sharedStringsXml = sharedStringsXml.replace('</sst>', `${newSiElements}</sst>`);
    zip.file('xl/sharedStrings.xml', sharedStringsXml);
  }

  // Generate buffer
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return buffer;
}

// ─── Spec PDF Generator ───
export async function generateSpecPdf(wi: any, content: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#033AF0')
      .text('Especificação de Negócio', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica').fillColor('#666')
      .text(`Gerado por PATi em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}`, { align: 'center' });
    doc.moveDown(1);

    // Work Item Info
    doc.fontSize(10).fillColor('#333').font('Helvetica-Bold');
    doc.text(`ID: ${wi.Id}`, { continued: true }).font('Helvetica').text(`  |  ${wi.Title}`);
    doc.font('Helvetica-Bold').text(`Cliente: `, { continued: true }).font('Helvetica').text(wi.ClienteNome || 'N/A');
    doc.font('Helvetica-Bold').text(`Módulo: `, { continued: true }).font('Helvetica').text(wi.Modulo || 'N/A');
    doc.moveDown(1);

    // Separator
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(1);

    // Content - render markdown-like text
    const lines = content.split('\n');
    for (const line of lines) {
      if (doc.y > 750) {
        doc.addPage();
      }

      const trimmed = line.trim();
      if (!trimmed) {
        doc.moveDown(0.3);
        continue;
      }

      // Headings
      if (trimmed.startsWith('# ')) {
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#033AF0').text(trimmed.replace(/^#+\s*/, ''));
        doc.moveDown(0.3);
      } else if (trimmed.startsWith('## ')) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1A3470').text(trimmed.replace(/^#+\s*/, ''));
        doc.moveDown(0.2);
      } else if (trimmed.startsWith('### ')) {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#264A8E').text(trimmed.replace(/^#+\s*/, ''));
        doc.moveDown(0.2);
      } else if (/^\d+\./.test(trimmed)) {
        // Numbered items - bold prefix
        const match = trimmed.match(/^(\d+\.\s*)(.*)/);
        if (match) {
          doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text(match[1], { continued: true });
          doc.font('Helvetica').text(match[2]);
        }
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        doc.fontSize(9).font('Helvetica').fillColor('#333').text(`  • ${trimmed.slice(2)}`);
      } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#1A3470').text(trimmed.replace(/\*\*/g, ''));
      } else {
        doc.fontSize(9).font('Helvetica').fillColor('#333').text(trimmed);
      }
    }

    doc.end();
  });
}

// ─── Get document for download ───
export async function getDocument(workItemId: number, tipo: string): Promise<{ buffer: Buffer; filename: string } | null> {
  const pool = await getPool();
  const result = await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(20), tipo)
    .query(`SELECT NomeArquivo, Conteudo FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = @tipo ORDER BY GeradoEm DESC`);

  if (result.recordset.length === 0) return null;
  const row = result.recordset[0];
  return { buffer: row.Conteudo, filename: row.NomeArquivo };
}

// ─── Check which items have documents ───
export async function getDocumentStatus(workItemIds: number[]): Promise<Record<number, { apf: boolean; apfExcel: boolean; spec: boolean }>> {
  if (workItemIds.length === 0) return {};
  const pool = await getPool();
  const idList = workItemIds.join(',');
  const result = await pool.request()
    .query(`SELECT WorkItemId, Tipo FROM DocumentosGerados WHERE WorkItemId IN (${idList})`);

  const status: Record<number, { apf: boolean; apfExcel: boolean; spec: boolean }> = {};
  for (const row of result.recordset) {
    if (!status[row.WorkItemId]) status[row.WorkItemId] = { apf: false, apfExcel: false, spec: false };
    if (row.Tipo === 'APF') status[row.WorkItemId].apf = true;
    if (row.Tipo === 'APF_EXCEL') status[row.WorkItemId].apfExcel = true;
    if (row.Tipo === 'SPEC') status[row.WorkItemId].spec = true;
  }
  return status;
}
