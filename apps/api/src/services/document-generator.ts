import { getPool, sql } from '../db/connection.js';
import PDFDocument from 'pdfkit';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { buildContextoFinal } from '../utils/context.js';
import { llmComplete, type LlmFinalidade } from './llm.js';
import { estruturarDemanda, detectarLacunas, type SpecEstruturada, type LacunasResult } from './spec-structuring.js';
import { revisarEspecificacao, type RevisaoResult } from './spec-review.js';
import { generateSpecDocx } from './spec-docx-generator.js';
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
  /** Justificativa em linguagem de NEGÓCIO (sem jargão IFPUG) — por que essa funcionalidade faz
   * parte do escopo, pra um leitor não-técnico (cliente). Distinta de `justificativa` (técnica,
   * usada só na coluna "Observações" da aba Funções) — exibida na Memória de Cálculo. */
  justificativaNegocio?: string;
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

/** Síntese estruturada de UMA versão de APF (geração inicial ou refinamento) — sempre
 * calculada pela LLM sobre TODO o contexto acumulado até aquele ponto (não só a última
 * interação), em linguagem de documento formal (nunca formato de diálogo/emoji). Persistida
 * como JSON em `DocumentVersionHistory.ResumoAnalise`; consumida pela seção "Resumo Executivo"
 * da Memória de Cálculo (só a versão atual) e pelo PDF de Auditoria (uma por versão). */
export interface SintesePati {
  oQueFoiPedido: string;
  oQueFoiEntendido: string;
  oQueFoiProjetado: string;
  motivoContagem: string;
}

export function parseSintese(raw: string | null | undefined): SintesePati | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.oQueFoiPedido) return parsed as SintesePati;
    return null;
  } catch {
    return null; // formato antigo/corrompido — trata como "sem síntese" em vez de quebrar a página
  }
}

/** Remove emojis/ícones (PDFKit/Excel não renderizam a maioria — viram caracteres corrompidos
 * tipo "þ"), rótulos de diálogo cru ("PATi:"/"Analista:" — nunca devem aparecer em nenhum
 * documento gerado, mesmo quando o texto de origem é um InterviewContext bruto) e normaliza
 * espaçamento — camada de segurança aplicada a QUALQUER texto antes de ir pro Excel/PDF, mesmo
 * que o prompt da LLM já peça texto limpo (nunca confiar só na LLM obedecer). */
function sanitizeForDocument(text: string | null | undefined): string {
  if (!text) return '';
  return text
    // Emojis e pictográficos (faixas Unicode mais comuns), variation selectors e ZWJ
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, '')
    // Rótulos de transcript cru (InterviewContext pode ter sido gravado como diálogo)
    .replace(/\b(PATi|Analista)\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Igual a `sanitizeForDocument`, mas SEM remover quebra de linha nem rótulo de papel — usado só
 * pra reconstruir a conversa turno a turno (`parseInteracaoTurns`), onde a quebra de linha e o
 * rótulo são exatamente a estrutura que precisamos preservar. */
function stripEmojiOnly(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, '');
}

/** `InterviewContext` é gravado pelo frontend como uma linha por turno ("Analista: ..." /
 * "PATi: ...", opcionalmente com horário embutido "PATi [15:15:56]: ..." — turnos gravados
 * antes dessa mudança não têm o horário, o que é tratado normalmente), separadas por `\n`.
 * Reconstrói isso em turnos estruturados pra renderizar como uma conversa legível (papel +
 * horário + mensagem), em vez de um bloco de texto corrido. Linhas sem rótulo (quebra de linha
 * dentro da própria mensagem) são anexadas ao turno anterior. */
function parseInteracaoTurns(raw: string | null | undefined): { role: 'PATi' | 'Analista'; horario?: string; texto: string }[] {
  if (!raw) return [];
  const turnos: { role: 'PATi' | 'Analista'; horario?: string; texto: string }[] = [];
  for (const linhaCrua of raw.split(/\r?\n/)) {
    const linha = linhaCrua.replace('[PRONTO_PARA_GERAR]', '').trim();
    if (!linha) continue;
    const m = linha.match(/^(PATi|Analista)\s*(?:\[([^\]]+)\])?\s*:\s*(.*)$/i);
    if (m) {
      turnos.push({ role: /^pati$/i.test(m[1]) ? 'PATi' : 'Analista', horario: m[2]?.trim(), texto: m[3].trim() });
    } else if (turnos.length > 0) {
      turnos[turnos.length - 1].texto += ' ' + linha;
    } else {
      turnos.push({ role: 'Analista', texto: linha });
    }
  }
  return turnos.filter(t => t.texto.length > 0);
}

/** Iniciais (até 2 letras) pra avatar do Analista no chat do PDF de Auditoria — 1ª letra do
 * primeiro + 1ª letra do último nome, ou as 2 primeiras letras se só houver um nome. */
function getInitials(name: string | null | undefined): string {
  const partes = (name || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return 'AN';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
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
 *
 * Prioriza as entrevistas MAIS RECENTES (não as mais antigas) quando o total excede o
 * orçamento de caracteres — o contrário de um `.slice(0, n)` simples, que cortaria
 * justamente as respostas mais novas (normalmente as mais atualizadas/confirmadas) por
 * estarem no fim da lista cronológica. Ver bug real: entrevista re-perguntando o "novo
 * aprovador" que já constava numa entrevista anterior, descartada pelo corte antigo.
 */
export async function getContextoAcumulado(workItemId: number, maxChars = 8000): Promise<string> {
  const pool = await getPool();
  const history = await pool.request()
    .input('wid', sql.Int, workItemId)
    .query(`
      SELECT Tipo, Versao, InterviewContext, CriadoEm
      FROM DocumentVersionHistory
      WHERE WorkItemId = @wid AND InterviewContext IS NOT NULL AND LEN(InterviewContext) > 0
      ORDER BY CriadoEm DESC
    `);

  const seen = new Set<string>();
  const blocksDesc: string[] = [];
  for (const row of history.recordset) {
    const ctx = (row.InterviewContext as string || '').trim();
    if (!ctx || seen.has(ctx)) continue;
    seen.add(ctx);
    blocksDesc.push(`--- Entrevista/ajuste anterior (${row.Tipo} v${row.Versao}) ---\n${ctx}`);
  }

  // Fallback: chamados gerados antes de existir o versionamento, ou refinados fora do fluxo de interview
  if (blocksDesc.length === 0) {
    const current = await pool.request()
      .input('wid', sql.Int, workItemId)
      .query(`SELECT TOP 1 InterviewContext FROM DocumentosGerados WHERE WorkItemId = @wid AND InterviewContext IS NOT NULL AND LEN(InterviewContext) > 0`);
    const ctx = (current.recordset[0]?.InterviewContext || '').trim();
    if (ctx) blocksDesc.push(`--- Contexto da última geração ---\n${ctx}`);
  }

  // Mantém blocos inteiros a partir do MAIS RECENTE (blocksDesc[0]) até estourar o orçamento —
  // sempre inclui ao menos o mais recente, mesmo que ele sozinho já exceda o limite.
  const kept: string[] = [];
  let total = 0;
  for (const block of blocksDesc) {
    if (total + block.length > maxChars && kept.length > 0) break;
    kept.push(block);
    total += block.length;
  }

  // Reordena de volta pra ordem cronológica (mais antigo → mais recente) pra leitura natural.
  return kept.reverse().join('\n\n');
}

// ─── Call LLM for APF analysis (cloud or Ollama) ───
async function callOllamaForApf(
  title: string, description: string, patiComment: string, extraContext?: string,
  workItemId?: number, projectDiretriz?: string | null
): Promise<{ elementos: ApfElement[]; resumoGeral: string; sintese: SintesePati }> {
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
- justificativaNegocio: 2 a 4 frases em linguagem DE NEGÓCIO, SEM jargão de IFPUG (nunca cite TD/AR-TR/
  complexidade/PF aqui) — explique para um leitor não-técnico (o cliente) qual necessidade real esse
  processo elementar atende e por que ele faz parte do escopo desta solicitação

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

Além da contagem, produza uma síntese executiva em 4 campos curtos (2-4 frases cada), em linguagem de
documento formal — **NUNCA** use emojis/ícones, **NUNCA** formate como diálogo ("PATi:"/"Analista:"),
escreva como um analista descrevendo o trabalho pra um leitor que não participou da conversa:
- oQueFoiPedido: o que o analista/cliente solicitou (com base na descrição e no contexto adicional)
- oQueFoiEntendido: como você interpretou o requisito (qual comportamento/regra de negócio ficou definido)
- oQueFoiProjetado: a solução/abordagem técnica adotada para atender o pedido
- motivoContagem: por que a contagem ficou como ficou, numa visão geral (não repita a justificativa por
  elemento, dê o racional da classificação como um todo)

Retorne APENAS um JSON válido no formato:
{"resumoGeral":"1-2 frases resumindo como você interpretou o chamado como um todo","sintese":{"oQueFoiPedido":"...","oQueFoiEntendido":"...","oQueFoiProjetado":"...","motivoContagem":"..."},"elementos":[{"processo":"...","tipo":"CE|SE|EE|ALI|AIE","operacao":"I|A|E","td":N,"arTr":N,"complexidade":"Baixa|Media|Alta","justificativa":"...","justificativaNegocio":"..."}]}

Se não houver informação suficiente para uma análise precisa, faça sua melhor estimativa com pelo menos 1 elemento.`;

  const userContent = `TÍTULO: ${title}\nDESCRIÇÃO: ${description}\nDETALHAMENTO: ${patiComment}${extraContext ? `\nCONTEXTO ADICIONAL (entrevista com analista):\n${extraContext}` : ''}`;

  const jsonText = await callLLMJson(systemPrompt, userContent, 'apf_geracao');

  try {
    const parsed = JSON.parse(jsonText);
    const sintese: SintesePati = {
      oQueFoiPedido: parsed.sintese?.oQueFoiPedido || '',
      oQueFoiEntendido: parsed.sintese?.oQueFoiEntendido || '',
      oQueFoiProjetado: parsed.sintese?.oQueFoiProjetado || '',
      motivoContagem: parsed.sintese?.motivoContagem || '',
    };
    return { elementos: parsed.elementos || [], resumoGeral: parsed.resumoGeral || '', sintese };
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
export async function generateApf(workItemId: number, extraContext?: string): Promise<{ apf: ApfResult; resumoGeral: string; sintese: SintesePati }> {
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
  const { elementos, resumoGeral, sintese } = await callOllamaForApf(wi.Title, wi.Description || '', wi.DiscussionPati || '', extraContext, workItemId, projectDiretriz);
  if (elementos.length === 0) throw new Error('LLM não identificou elementos funcionais');

  // Calculate
  const apf = calculateApf(elementos, params);

  // Update EsforcoAPF on work item
  await pool.request()
    .input('id', sql.Int, workItemId)
    .input('horas', sql.Decimal(10, 2), apf.totalHoras)
    .query(`UPDATE WorkItems SET EsforcoAPF = @horas, AtualizadoEm = GETDATE() WHERE Id = @id`);

  // Gera o Excel (único documento de APF hoje — PDF removido; a memória de cálculo agora traz
  // um resumo executivo estruturado; a trilha de auditoria completa virou um PDF à parte).
  const excelBuffer = await generateApfExcel(wi, apf, params, sintese, { askAtual: extraContext });

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

  return { apf, resumoGeral, sintese };
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

// ─── Generate Business Spec (novo pipeline: Word template + estruturação + revisão) ───
// Coexiste com generateSpec() (PDF simples, mantida sem alterações) — Tipo='SPEC_DOCX' é
// um documento NOVO e independente, não substitui nem altera o fluxo 'SPEC' existente.
// Pipeline: elicitação (já feita antes via streamInterview, chega aqui como extraContext) →
// estruturação (LLM, JSON) → identificação de lacunas (determinístico) → revisão (LLM,
// consultiva) → geração do documento (sem LLM, docxtemplater) → auditoria/versionamento.
export async function generateSpecCompleta(
  workItemId: number,
  extraContext?: string,
  auditUser?: { userId: string; name: string; email: string } | null,
): Promise<{ spec: SpecEstruturada; docxBuffer: Buffer; lacunas: LacunasResult; revisao: RevisaoResult }> {
  const pool = await getPool();

  const wiResult = await pool.request()
    .input('id', sql.Int, workItemId)
    .query(`SELECT Id, Title, Description, ClienteNome, Modulo, DiscussionPati FROM WorkItems WHERE Id = @id`);
  const wi = wiResult.recordset[0];
  if (!wi) throw new Error('Work item não encontrado');
  if (!wi.DiscussionPati && !extraContext && !wi.Description) throw new Error('Nenhum detalhamento encontrado para este item. O chamado precisa ter ao menos uma descrição.');

  const contextoFinal = buildContextoFinal(wi.Description, wi.DiscussionPati, undefined);
  const contextoAcumulado = await getContextoAcumulado(workItemId);
  const contextoConsolidado = [contextoFinal, contextoAcumulado].filter(Boolean).join('\n\n');

  const spec = await estruturarDemanda({
    workItemId,
    titulo: wi.Title,
    cliente: wi.ClienteNome,
    modulo: wi.Modulo,
    contextoConsolidado,
    interviewContext: extraContext,
    autor: auditUser?.name || 'Equipe Paradigma',
  });

  const lacunas = detectarLacunas(spec);
  if (lacunas.criticas.length > 0) {
    throw new Error(`Não foi possível gerar a especificação — faltam informações essenciais: ${lacunas.criticas.join(' ')}`);
  }

  const revisao = await revisarEspecificacao(spec);

  // Número real da versão (mesma contagem sequencial usada em DocumentVersionHistory/Auditoria)
  // PRECISA ser calculado ANTES de renderizar o docx — senão o documento sai sempre com o
  // "1.0" fixo que estruturarDemanda() usa como placeholder (bug real: a versão dentro do
  // texto do documento nunca acompanhava a versão real mostrada na Auditoria).
  const versao = await nextVersion(workItemId, 'SPEC_DOCX');
  const dataHoje = new Date().toLocaleDateString('pt-BR');
  if (spec.versionamento.length > 0) {
    const ultima = spec.versionamento[spec.versionamento.length - 1];
    ultima.versao = `${versao}.0`;
    ultima.data = dataHoje;
  }

  const docxBuffer = await generateSpecDocx(spec, { produto: wi.Modulo });

  await pool.request()
    .input('wiId', sql.Int, workItemId)
    .input('tipo', sql.NVarChar(20), 'SPEC_DOCX')
    .input('nome', sql.NVarChar(300), `SPEC_${workItemId}_${wi.ClienteNome || 'SRM'}.docx`)
    .input('conteudo', sql.VarBinary(sql.MAX), docxBuffer)
    .input('especificacao', sql.NVarChar(sql.MAX), JSON.stringify(spec))
    .input('userId', sql.NVarChar(200), auditUser?.userId || null)
    .input('userName', sql.NVarChar(200), auditUser?.name || null)
    .input('userEmail', sql.NVarChar(200), auditUser?.email || null)
    .input('interviewContext', sql.NVarChar(sql.MAX), extraContext || null)
    .query(`
      DELETE FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = @tipo;
      INSERT INTO DocumentosGerados (WorkItemId, Tipo, NomeArquivo, Conteudo, EspecificacaoJson, GeradoPorUserId, GeradoPorNome, GeradoPorEmail, InterviewContext)
      VALUES (@wiId, @tipo, @nome, @conteudo, @especificacao, @userId, @userName, @userEmail, @interviewContext);
    `);

  // Auditoria/versionamento — mesmo padrão já estabelecido pra APF (refineApf/generate/stream).
  try {
    await pool.request()
      .input('wid', sql.Int, workItemId)
      .input('wtitle', sql.NVarChar(500), wi.Title)
      .input('versao', sql.Int, versao)
      .input('especificacao', sql.NVarChar(sql.MAX), JSON.stringify(spec))
      .input('ctx', sql.NVarChar(sql.MAX), extraContext || null)
      .input('uid', sql.NVarChar(200), auditUser?.userId || null)
      .input('uname', sql.NVarChar(200), auditUser?.name || null)
      .input('uemail', sql.NVarChar(200), auditUser?.email || null)
      .query(`INSERT INTO DocumentVersionHistory
        (WorkItemId, WorkItemTitle, Tipo, Versao, EspecificacaoJson, InterviewContext, GeradoPorUserId, GeradoPorNome, GeradoPorEmail)
        VALUES (@wid, @wtitle, 'SPEC_DOCX', @versao, @especificacao, @ctx, @uid, @uname, @uemail)`);
  } catch (auditErr: any) {
    console.warn('⚠️  Audit save failed (non-blocking):', auditErr.message);
  }

  return { spec, docxBuffer, lacunas, revisao };
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

  // Get current elements (snapshot vive no Excel agora — único documento de APF, PDF removido)
  const docResult = await pool.request()
    .input('wiId', sql.Int, workItemId)
    .query(`SELECT ElementosJson FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = 'APF_EXCEL'`);
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
- justificativaNegocio: 2 a 4 frases em linguagem DE NEGÓCIO, SEM jargão de IFPUG, explicando por que esse
  processo elementar faz parte do escopo. Para elementos não afetados pela instrução, mantenha a
  justificativa de negócio anterior se houver.

REGRAS PARA OPERAÇÃO (I/A/E):
- I: elemento NOVO sendo adicionado ao sistema.
- A: elemento EXISTENTE sendo modificado ou estendido.
- E: APENAS quando o chamado pede explicitamente REMOVER uma funcionalidade — é muito raro.

Além da contagem, produza uma síntese executiva em 4 campos curtos (2-4 frases cada), em linguagem de
documento formal — **NUNCA** use emojis/ícones, **NUNCA** formate como diálogo ("PATi:"/"Analista:"),
sempre representando o estado ATUAL/CONSOLIDADO da análise (incorporando o histórico anterior + este
ajuste), nunca só a mudança pontual:
- oQueFoiPedido: o que foi solicitado ao todo (histórico + este ajuste)
- oQueFoiEntendido: como o requisito foi interpretado, já considerando este ajuste
- oQueFoiProjetado: a solução/abordagem técnica atual, após este ajuste
- motivoContagem: racional geral de por que a contagem está como está agora

Retorne APENAS um JSON válido:
{"elementos":[...],"resumoAlteracoes":"descrição curta do que mudou nesta rodada","sintese":{"oQueFoiPedido":"...","oQueFoiEntendido":"...","oQueFoiProjetado":"...","motivoContagem":"..."}}`;

  const jsonText = await callLLMJson('', prompt, 'apf_refinamento');

  let newElements: ApfElement[];
  let changes: string;
  let sintese: SintesePati;
  try {
    const parsed = JSON.parse(jsonText);
    newElements = parsed.elementos || [];
    changes = parsed.resumoAlteracoes || 'Contagem ajustada conforme solicitado';
    sintese = {
      oQueFoiPedido: parsed.sintese?.oQueFoiPedido || '',
      oQueFoiEntendido: parsed.sintese?.oQueFoiEntendido || '',
      oQueFoiProjetado: parsed.sintese?.oQueFoiProjetado || '',
      motivoContagem: parsed.sintese?.motivoContagem || '',
    };
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

  // Regenerate Excel (único documento de APF hoje — PDF removido)
  const excelBuffer = await generateApfExcel(wi, apf, params, sintese, { askAtual: instrucao });

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
      .input('resumo', sql.NVarChar(sql.MAX), JSON.stringify(sintese))
      .input('uid', sql.NVarChar(200), auditUser?.userId || null)
      .input('uname', sql.NVarChar(200), auditUser?.name || null)
      .input('uemail', sql.NVarChar(200), auditUser?.email || null)
      .query(`INSERT INTO DocumentVersionHistory
        (WorkItemId,WorkItemTitle,Tipo,Versao,TotalPF,TotalHoras,ElementosJson,InterviewContext,ResumoAnalise,GeradoPorUserId,GeradoPorNome,GeradoPorEmail)
        VALUES (@wid,@wtitle,'APF',@versao,@pf,@horas,@elementos,@ctx,@resumo,@uid,@uname,@uemail)`);
    if (auditUser) {
      await pool.request()
        .input('wid', sql.Int, workItemId)
        .input('uid', sql.NVarChar(200), auditUser.userId)
        .input('uname', sql.NVarChar(200), auditUser.name)
        .input('uemail', sql.NVarChar(200), auditUser.email)
        .input('ctx', sql.NVarChar(sql.MAX), instrucao || null)
        .query(`UPDATE DocumentosGerados SET GeradoPorUserId=@uid,GeradoPorNome=@uname,GeradoPorEmail=@uemail,InterviewContext=@ctx
                WHERE WorkItemId=@wid AND Tipo='APF_EXCEL'`);
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
    .query(`SELECT ElementosJson FROM DocumentosGerados WHERE WorkItemId = @wiId AND Tipo = 'APF_EXCEL'`);
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

// Clona entradas de cellXfs (styles.xml) adicionando vertical="center", preservando fonte/
// preenchimento/borda/horizontal originais — usado para centralizar verticalmente colunas do
// template que originalmente não tinham esse atributo (ficam "coladas" embaixo quando a altura
// da linha cresce por texto longo em Processo/Observações). Retorna o XML atualizado + um mapa
// styleOriginal -> novoIndex (novos estilos são anexados ao final de cellXfs).
function cloneCellXfsWithVerticalCenter(stylesXml: string, sourceIndices: number[]): { stylesXml: string; indexMap: Record<number, number> } {
  const section = stylesXml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  if (!section) return { stylesXml, indexMap: {} };
  const originalCount = parseInt(section[1]);
  const body = section[2];
  const parts = body.split(/(?=<xf )/).filter(s => s.trim().length > 0);
  const indexMap: Record<number, number> = {};
  const cloned: string[] = [];
  sourceIndices.forEach((srcIdx, i) => {
    const original = parts[srcIdx];
    if (!original) return;
    const withCenter = /<alignment[^>]*vertical="/.test(original)
      ? original.replace(/vertical="[^"]*"/, 'vertical="center"')
      : original.replace(/<alignment /, '<alignment vertical="center" ');
    indexMap[srcIdx] = originalCount + cloned.length;
    cloned.push(withCenter);
  });
  const newSection = `<cellXfs count="${originalCount + cloned.length}">${body}${cloned.join('')}</cellXfs>`;
  return { stylesXml: stylesXml.replace(section[0], newSection), indexMap };
}

// ─── Abas suplementares do Excel de APF: "Memória de Cálculo" e "Auditoria da Comunicação" ───
// 100% ADITIVAS — construídas do zero (inlineStr, sem depender de sharedStrings.xml nem dos
// estilos do template), nunca tocam nas abas Contagem/Funções (exigência: modelo atual
// "blindado", a melhoria é só incremental). Substituem o conteúdo que só existia no PDF da
// APF (removido nesta rodada) e adicionam a trilha de auditoria que não existia em nenhum
// dos dois formatos.

function colLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Constrói uma planilha simples do zero (texto/número via inlineStr) — sem tabela
 * estruturada, sem fórmula, sem dependência do sharedStrings/estilos do template.
 * Fiel ao layout aprovado pelo usuário (Modelo_Memoria_de_Calculo.xlsx, 09/09/2026). */
interface SheetRow {
  cells: (string | number | null)[];
  band?:
    | 'title' | 'metaChamado' | 'metaGray' | 'metaGrayBorder' | 'section'
    | 'field' | 'tableHeader' | 'total' | 'totalHoursHighlight' | 'totalPFAHighlight'
    | 'agregado' | 'matrix' | 'legend' | 'disclaimer' | 'subtotalSummary';
  // omitido = linha de dados de tabela (usa align por célula: left/center/right)
  align?: ('left' | 'center' | 'right')[]; // por célula
  cellStyleOverride?: Record<number, number>;
  height?: number; // força altura (pt), ignorando a estimativa automática por texto
  // Mescla da coluna `mergeFrom` até a última coluna real (K) — omitido = sem merge.
  // O texto da linha deve estar em `cells[mergeFrom]` (células antes disso ficam null).
  mergeFrom?: number;
  // Posição dentro de um bloco de linhas repetidas — afeta a borda superior (ver appendReportStyles):
  // 'first' = logo após um título de seção (borda mais forte); 'mid'/undefined = entre linhas
  // (borda mais fina); 'last' = usado só pela Matriz de Complexidade (sem borda).
  pos?: 'first' | 'mid' | 'last';
}

/** Helper: linha de texto único mesclado de `mergeFrom` até a última coluna (K). */
function mergedRow(text: string, mergeFrom: number, band: SheetRow['band'], extra?: Partial<SheetRow>): SheetRow {
  const cells: (string | number | null)[] = new Array(mergeFrom).fill(null);
  cells.push(text);
  return { cells, band, mergeFrom, ...extra };
}

interface ReportStyleIds {
  title: number; metaChamado: number; metaGray: number; metaGrayBorder: number; section: number;
  fieldLabelFirst: number; fieldLabelRest: number; fieldCardFirst: number; fieldCardRest: number;
  tableHeaderFirst: number; tableHeader: number;
  dataFirstLeft: number; dataFirstCenter: number; dataFirstRight: number;
  dataRestLeft: number; dataRestCenter: number; dataRestRight: number;
  totalRowLeft: number; totalRowRight: number;
  totalHoursHighlight: number; totalPFAHighlight: number;
  agregadoFirstBold: number; agregadoRest: number;
  matrixFirst: number; matrixMid: number; matrixLast: number;
  legendText: number; disclaimer: number; subtotalSummary: number;
}

/** Acrescenta ao styles.xml (SEM tocar em nenhuma entrada existente — mesmo padrão seguro de
 * `cloneCellXfsWithVerticalCenter`, só ANEXA) o conjunto de fontes/preenchimentos/bordas/estilos
 * usado pela aba "Memória de Cálculo" — 100% fiel ao layout aprovado pelo usuário
 * (Modelo_Memoria_de_Calculo.xlsx). Como só anexa, as abas Contagem/Funções (que referenciam
 * estilos por índice) nunca são afetadas. */
function appendReportStyles(stylesXml: string): { stylesXml: string; ids: ReportStyleIds } {
  const fontsSection = stylesXml.match(/<fonts count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/)!;
  const fontsCount = parseInt(fontsSection[1]);
  const newFonts = [
    '<font><b/><sz val="14"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>', // 0 título
    '<font><sz val="9"/><color rgb="FF4B5563"/><name val="Calibri"/><family val="2"/></font>', // 1 meta (chamado)
    '<font><sz val="8"/><color rgb="FF667085"/><name val="Calibri"/><family val="2"/></font>', // 2 meta (cliente/tipo)
    '<font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>', // 3 seção
    '<font><b/><sz val="8"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>', // 4 chip (rótulo de campo)
    '<font><sz val="9"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font>', // 5 corpo
    '<font><b/><sz val="9"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font>', // 6 corpo negrito
    '<font><sz val="8"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font>', // 7 texto pequeno (matriz/legenda/nota)
    '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>', // 8 destaque Total de Horas (branco)
    '<font><b/><sz val="10"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font>', // 9 destaque Total PFA
  ];
  const [fTitle, fMetaChamado, fMetaGray, fSection, fChip, fBody, fBodyBold, fSmall, fTotalHoras, fTotalPFA] = newFonts.map((_, i) => fontsCount + i);
  let out = stylesXml.replace(fontsSection[0], `<fonts count="${fontsCount + newFonts.length}">${fontsSection[2]}${newFonts.join('')}</fonts>`);

  const fillsSection = out.match(/<fills count="(\d+)">([\s\S]*?)<\/fills>/)!;
  const fillsCount = parseInt(fillsSection[1]);
  const newFills = [
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/></patternFill></fill>', // 0 cabeçalho de tabela / chip
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF7F8FA"/></patternFill></fill>', // 1 card / matriz
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE7EDF5"/></patternFill></fill>', // 2 destaque Total PFA
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill>', // 3 destaque Total de Horas
  ];
  const [fillTableHdr, fillCard, fillTotalPFA, fillTotalHoras] = newFills.map((_, i) => fillsCount + i);
  out = out.replace(fillsSection[0], `<fills count="${fillsCount + newFills.length}">${fillsSection[2]}${newFills.join('')}</fills>`);

  const bordersSection = out.match(/<borders count="(\d+)">([\s\S]*?)<\/borders>/)!;
  const bordersCount = parseInt(bordersSection[1]);
  const hair = (rgb: string) => `style="hair"><color rgb="${rgb}"/></`;
  const thin = (rgb: string) => `style="thin"><color rgb="${rgb}"/></`;
  const newBorders = [
    `<border><left/><right/><top/><bottom ${thin('FF1F3864')}bottom><diagonal/></border>`, // 0 sublinhado de seção
    `<border><left/><right/><top ${thin('FF1F3864')}top><bottom/><diagonal/></border>`, // 1 topo forte (1º após seção)
    `<border><left/><right/><top ${hair('FFE2E6EC')}top><bottom/><diagonal/></border>`, // 2 topo fino (entre linhas)
    `<border><left/><right/><top ${thin('FFC9CFD8')}top><bottom/><diagonal/></border>`, // 3 topo 1ª linha de tabela
    `<border><left/><right/><top ${thin('FF7C8798')}top><bottom/><diagonal/></border>`, // 4 topo linha TOTAL
    `<border><left/><right ${hair('FFD9DEE7')}right><top ${thin('FF1F3864')}top><bottom/><diagonal/></border>`, // 5 chip 1º campo
    `<border><left/><right ${hair('FFD9DEE7')}right><top ${hair('FFE2E6EC')}top><bottom/><diagonal/></border>`, // 6 chip campos seguintes
    `<border><left/><right/><top ${hair('FFC9CFD8')}top><bottom/><diagonal/></border>`, // 7 nota de vigência (topo)
  ];
  const [bSectionUnderline, bTopStrong, bTopHair, bTopFirstRow, bTopTotal, bChipFirst, bChipRest, bDisclaimer] = newBorders.map((_, i) => bordersCount + i);
  out = out.replace(bordersSection[0], `<borders count="${bordersCount + newBorders.length}">${bordersSection[2]}${newBorders.join('')}</borders>`);

  const cellXfsSection = out.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/)!;
  const xfsCount = parseInt(cellXfsSection[1]);
  const xf = (fontId: number, fillId: number, borderId: number, align: string, valign: string, wrap = true) =>
    `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${align}" vertical="${valign}"${wrap ? ' wrapText="1"' : ''}/></xf>`;
  const newXfs = [
    xf(fTitle, 0, 0, 'center', 'center', false), // 0 title
    xf(fMetaChamado, 0, 0, 'left', 'center', false), // 1 metaChamado
    xf(fMetaGray, 0, 0, 'left', 'center'), // 2 metaGray
    xf(fMetaGray, 0, bSectionUnderline, 'left', 'center'), // 3 metaGrayBorder
    xf(fSection, 0, bSectionUnderline, 'left', 'center', false), // 4 section
    xf(fChip, fillTableHdr, bChipFirst, 'center', 'center'), // 5 fieldLabelFirst
    xf(fChip, fillTableHdr, bChipRest, 'center', 'center'), // 6 fieldLabelRest
    xf(fBody, 0, bTopStrong, 'justify', 'center'), // 7 fieldCardFirst
    xf(fBody, 0, bTopHair, 'justify', 'center'), // 8 fieldCardRest
    xf(fBodyBold, fillTableHdr, bTopStrong, 'center', 'center', false), // 9 tableHeaderFirst
    xf(fBodyBold, fillTableHdr, 0, 'center', 'center', false), // 10 tableHeader
    xf(fBody, 0, bTopFirstRow, 'left', 'center', false), // 11 dataFirstLeft
    xf(fBody, 0, bTopFirstRow, 'center', 'center', false), // 12 dataFirstCenter
    xf(fBody, 0, bTopFirstRow, 'right', 'center', false), // 13 dataFirstRight
    xf(fBody, 0, bTopHair, 'left', 'center', false), // 14 dataRestLeft
    xf(fBody, 0, bTopHair, 'center', 'center', false), // 15 dataRestCenter
    xf(fBody, 0, bTopHair, 'right', 'center', false), // 16 dataRestRight
    xf(fBodyBold, fillTableHdr, bTopTotal, 'left', 'center', false), // 17 totalRowLeft
    xf(fBodyBold, fillTableHdr, bTopTotal, 'right', 'center', false), // 18 totalRowRight
    xf(fTotalHoras, fillTotalHoras, bTopHair, 'left', 'center'), // 19 totalHoursHighlight
    xf(fTotalPFA, fillTotalPFA, bTopHair, 'left', 'center'), // 20 totalPFAHighlight
    xf(fBodyBold, 0, bTopStrong, 'left', 'center'), // 21 agregadoFirstBold
    xf(fBody, 0, bTopHair, 'left', 'center'), // 22 agregadoRest
    xf(fSmall, fillCard, bTopStrong, 'left', 'center'), // 23 matrixFirst
    xf(fSmall, fillCard, bTopHair, 'left', 'center'), // 24 matrixMid
    xf(fSmall, fillCard, 0, 'left', 'center'), // 25 matrixLast
    xf(fSmall, 0, 0, 'left', 'center'), // 26 legendText
    xf(fSmall, 0, bDisclaimer, 'left', 'center'), // 27 disclaimer
    xf(fBodyBold, fillCard, 0, 'left', 'center', false), // 28 subtotalSummary
  ];
  out = out.replace(cellXfsSection[0], `<cellXfs count="${xfsCount + newXfs.length}">${cellXfsSection[2]}${newXfs.join('')}</cellXfs>`);

  return {
    stylesXml: out,
    ids: {
      title: xfsCount + 0, metaChamado: xfsCount + 1, metaGray: xfsCount + 2, metaGrayBorder: xfsCount + 3, section: xfsCount + 4,
      fieldLabelFirst: xfsCount + 5, fieldLabelRest: xfsCount + 6, fieldCardFirst: xfsCount + 7, fieldCardRest: xfsCount + 8,
      tableHeaderFirst: xfsCount + 9, tableHeader: xfsCount + 10,
      dataFirstLeft: xfsCount + 11, dataFirstCenter: xfsCount + 12, dataFirstRight: xfsCount + 13,
      dataRestLeft: xfsCount + 14, dataRestCenter: xfsCount + 15, dataRestRight: xfsCount + 16,
      totalRowLeft: xfsCount + 17, totalRowRight: xfsCount + 18,
      totalHoursHighlight: xfsCount + 19, totalPFAHighlight: xfsCount + 20,
      agregadoFirstBold: xfsCount + 21, agregadoRest: xfsCount + 22,
      matrixFirst: xfsCount + 23, matrixMid: xfsCount + 24, matrixLast: xfsCount + 25,
      legendText: xfsCount + 26, disclaimer: xfsCount + 27, subtotalSummary: xfsCount + 28,
    },
  };
}

/** Constrói uma planilha "de página" a partir de linhas descritas por banda — sem tabela
 * estruturada/fórmula, então nunca interfere no restante do arquivo. Fiel ao layout aprovado
 * pelo usuário: título/seções mesclados a partir da coluna certa (nunca A — reservada pra
 * margem/logo), campos com chip+card lado a lado, cabeçalhos de tabela e destaques de total. */
function buildStyledSheetXml(rows: SheetRow[], colWidths: number[], ids: ReportStyleIds, opts: { freezeAtRow?: number; trailingMarginWidth?: number } = {}): string {
  const numCols = colWidths.length;
  const lastCol = colLetter(numCols - 1);
  const lastRow = Math.max(rows.length, 1);
  let cols = `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}`;
  if (opts.trailingMarginWidth) cols += `<col min="${numCols + 1}" max="${numCols + 1}" width="${opts.trailingMarginWidth}" customWidth="1"/>`;
  cols += '</cols>';

  const merges: string[] = [];

  const rowsXml = rows.map((row, ri) => {
    const r = ri + 1;
    const first = row.pos !== 'mid' && row.pos !== 'last'; // 'first' ou undefined = trata como "primeira linha do bloco"
    let styleFor: (ci: number) => number;

    switch (row.band) {
      case 'title': styleFor = () => ids.title; break;
      case 'metaChamado': styleFor = () => ids.metaChamado; break;
      case 'metaGray': styleFor = () => ids.metaGray; break;
      case 'metaGrayBorder': styleFor = () => ids.metaGrayBorder; break;
      case 'section': styleFor = () => ids.section; break;
      case 'field':
        // Chip (coluna C, célula solta) + card (colunas D:última, mescladas) — layout lado a
        // lado; ver `mergeFrom` da própria linha (sempre 3 = coluna D) definido pelo chamador.
        styleFor = (ci) => {
          if (ci === 2) return first ? ids.fieldLabelFirst : ids.fieldLabelRest;
          return first ? ids.fieldCardFirst : ids.fieldCardRest;
        };
        break;
      case 'tableHeader':
        styleFor = () => (row.pos === 'first' ? ids.tableHeaderFirst : ids.tableHeader);
        break;
      case 'total':
        styleFor = (ci) => (row.align?.[ci] === 'right' ? ids.totalRowRight : ids.totalRowLeft);
        break;
      case 'totalHoursHighlight': styleFor = () => ids.totalHoursHighlight; break;
      case 'totalPFAHighlight': styleFor = () => ids.totalPFAHighlight; break;
      case 'agregado': styleFor = () => (row.pos === 'first' ? ids.agregadoFirstBold : ids.agregadoRest); break;
      case 'matrix':
        styleFor = () => (row.pos === 'first' ? ids.matrixFirst : row.pos === 'last' ? ids.matrixLast : ids.matrixMid);
        break;
      case 'legend': styleFor = () => ids.legendText; break;
      case 'disclaimer': styleFor = () => ids.disclaimer; break;
      case 'subtotalSummary': styleFor = () => ids.subtotalSummary; break;
      default: {
        // Linha de dados de tabela (elementos/subtotal/ciclo) — alinhamento por célula decide
        // left/center/right; `pos:'first'` (1ª linha após o cabeçalho) usa borda mais forte.
        styleFor = (ci) => {
          const align = row.align?.[ci];
          const isFirst = row.pos === 'first';
          if (align === 'right') return isFirst ? ids.dataFirstRight : ids.dataRestRight;
          if (align === 'left') return isFirst ? ids.dataFirstLeft : ids.dataRestLeft;
          return isFirst ? ids.dataFirstCenter : ids.dataRestCenter;
        };
      }
    }

    if (row.mergeFrom !== undefined && numCols > row.mergeFrom + 1) {
      merges.push(`<mergeCell ref="${colLetter(row.mergeFrom)}${r}:${lastCol}${r}"/>`);
    }

    const cells = row.cells.map((val, ci) => {
      const ref = `${colLetter(ci)}${r}`;
      const s = row.cellStyleOverride?.[ci] ?? styleFor(ci);
      if (val === null || val === undefined || val === '') return `<c r="${ref}" s="${s}"/>`;
      if (typeof val === 'number') return `<c r="${ref}" s="${s}"><v>${val}</v></c>`;
      const escaped = String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`;
    }).join('');

    // Altura de linha escala com o maior texto — linhas mescladas usam a largura real do
    // intervalo mesclado (não a largura total da planilha), senão a altura fica superestimada.
    const mergedWidth = row.mergeFrom !== undefined
      ? colWidths.slice(row.mergeFrom).reduce((a, b) => a + b, 0)
      : null;
    const charsPerLine = mergedWidth ? Math.round(mergedWidth * 0.95) : 70;
    const longest = row.cells.reduce((acc: string, v) => typeof v === 'string' && v.length > acc.length ? v : acc, '');
    const lines = estimateWrappedLines(longest, charsPerLine);
    const heightAttr = row.height
      ? ` ht="${row.height}" customHeight="1"`
      : lines > 1 ? ` ht="${Math.min(lines * 14, 250)}" customHeight="1"` : '';

    return `<row r="${r}"${heightAttr}>${cells}</row>`;
  }).join('');

  const mergeCellsXml = merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '';
  const paneXml = opts.freezeAtRow
    ? `<pane ySplit="${opts.freezeAtRow}" topLeftCell="A${opts.freezeAtRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`
    : '';

  // showGridLines="0" tira as linhas de grade padrão do Excel em TODA a área da planilha — sem
  // isso, qualquer célula fora do conteúdo (título/cards/tabelas) mostra a grade cinza clara
  // default, dando aspecto de "planilha" em vez de "página de relatório" (pedido do usuário).
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${lastCol}${lastRow}"/><sheetViews><sheetView showGridLines="0" showRowColHeaders="0" workbookViewId="0">${paneXml}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowsXml}</sheetData>${mergeCellsXml}</worksheet>`;
}

/** Linhas da aba "Memória de Cálculo": resumo executivo estruturado (o que foi pedido —
 * compilado de forma determinística a partir do histórico, nunca só a paráfrase da última
 * versão — entendido/projetado + racional da contagem, sempre o estado ATUAL) + relação de
 * elementos com justificativa DE NEGÓCIO (sem repetir os dados técnicos já detalhados na aba
 * Funções) + subtotal por tipo de função + fórmula do cálculo agregado PF -> PFA -> Horas +
 * legenda de siglas + nota de vigência. A distribuição de horas por ciclo já vive na aba
 * Contagem — não é repetida aqui. */
function buildMemoriaCalculoRows(
  wi: any, apf: ApfResult, params: ApfParametros,
  sintese: SintesePati, elaboradoPor: string | null, versaoAtual: number, _ids: ReportStyleIds,
  solicitacaoCompilada: string,
): SheetRow[] {
  const rows: SheetRow[] = [];

  // Linha 1 em branco reservada pra logo (ancorada na coluna B, flutua por cima) — precisa ser
  // o PRIMEIRO elemento do cabeçalho, igual nas outras abas, nunca sobrepor título/texto.
  rows.push({ cells: [], height: 10 });
  // Título mescla só C:K (não B) — a coluna B fica livre pra logo, que se estende até a linha 3.
  rows.push(mergedRow('MEMÓRIA DE CÁLCULO - ANÁLISE DE PONTOS DE FUNÇÃO', 2, 'title', { height: 25 }));
  // "Chamado #..." mescla D:K (B e C ainda reservados — a logo ocupa até esta linha também).
  rows.push(mergedRow(`Chamado #${wi.Id} - ${wi.Title}`, 3, 'metaChamado', { height: 19 }));
  // A partir daqui a logo já terminou (só ocupa linhas 2-3) — mescla volta a começar em B.
  rows.push(mergedRow(`Cliente: ${wi.ClienteNome || 'N/A'}  ·  Módulo: ${wi.Modulo || 'N/A'}  ·  Versão ${versaoAtual}  ·  Gerado em: ${new Date().toLocaleString('pt-BR')}`, 1, 'metaGray', { height: 18 }));
  rows.push(mergedRow(`Tipo de Contagem: Melhoria em Aplicação Existente  ·  Elaborado por: PATi (Inteligência Artificial)${elaboradoPor ? `, com curadoria de ${elaboradoPor}` : ''}`, 1, 'metaGrayBorder', { height: 18 }));
  rows.push({ cells: [], height: 12 });

  rows.push(mergedRow('RESUMO EXECUTIVO DA ANÁLISE', 1, 'section', { height: 24 }));
  const campos: [string, string][] = [
    ['O QUE FOI SOLICITADO', solicitacaoCompilada],
    ['O QUE FOI ENTENDIDO', sintese.oQueFoiEntendido],
    ['SOLUÇÃO PROJETADA', sintese.oQueFoiProjetado],
    ['RACIONAL DA CONTAGEM', sintese.motivoContagem],
  ];
  campos.forEach(([label, texto], idx) => {
    // Chip (coluna C) + card (D:K mesclado) NA MESMA linha — layout lado a lado fiel ao modelo.
    const cells: (string | number | null)[] = [null, null, label, sanitizeForDocument(texto) || 'Síntese não disponível para esta versão.'];
    rows.push({ cells, band: 'field', mergeFrom: 3, height: 58, pos: idx === 0 ? 'first' : 'mid' });
  });
  rows.push({ cells: [], height: 12 });

  // Relação de elementos: SEM repetir os dados técnicos (Tipo/Operação/TD/AR-TR/Complexidade/PF/
  // Deflator/PFA já detalhados na aba Funções) — aqui o foco é a justificativa DE NEGÓCIO de cada
  // item (por que faz parte do escopo), pra um leitor não-técnico. Deflator/PFA por elemento ainda
  // são calculados (não impressos) só pra alimentar o subtotal por tipo logo abaixo.
  rows.push(mergedRow('RELAÇÃO DE ELEMENTOS FUNCIONAIS', 1, 'section', { height: 24 }));
  rows.push({ cells: [null, 'Nº', 'Processo Elementar', 'Justificativa de Negócio'], band: 'tableHeader', mergeFrom: 3, pos: 'first', height: 21 });
  const porTipo: Record<string, { qtd: number; pf: number; pfa: number }> = {};
  apf.elementos.forEach((el, idx) => {
    const deflator = el.operacao === 'I' ? params.DeflatorInclusao : el.operacao === 'A' ? params.DeflatorAlteracao : params.DeflatorExclusao;
    const pfa = +(el.pf * deflator).toFixed(2);
    rows.push({
      cells: [null, idx + 1, el.processo, sanitizeForDocument(el.justificativaNegocio) || 'Justificativa de negócio não disponível para este elemento.'],
      align: ['left', 'center', 'left', 'left'],
      mergeFrom: 3,
      pos: idx === 0 ? 'first' : 'mid',
    });
    const g = porTipo[el.tipo] || (porTipo[el.tipo] = { qtd: 0, pf: 0, pfa: 0 });
    g.qtd++; g.pf += el.pf; g.pfa += pfa;
  });
  rows.push({ cells: [], height: 12 });

  // Subtotal por tipo de função — agrupamento padrão IFPUG (Funções de Dados: ALI/AIE vs
  // Funções Transacionais: EE/SE/CE), enriquece o relatório sem alterar a contagem em si.
  rows.push(mergedRow('SUBTOTAL POR TIPO DE FUNÇÃO', 1, 'section', { height: 24 }));
  const gruposDados = (['ALI', 'AIE'] as const).reduce((acc, t) => acc + (porTipo[t]?.pf || 0), 0);
  const gruposTransacionais = (['EE', 'SE', 'CE'] as const).reduce((acc, t) => acc + (porTipo[t]?.pf || 0), 0);
  rows.push(mergedRow(`Funções de Dados (ALI + AIE): ${gruposDados} PF  ·  Funções Transacionais (EE + SE + CE): ${gruposTransacionais} PF`, 1, 'subtotalSummary', { height: 22 }));
  rows.push({ cells: [], height: 12 });
  rows.push({ cells: [null, null, 'Tipo de Função', 'Qtde', 'PF', 'PFA', '% do Total PF'], band: 'tableHeader', height: 21 });
  const TIPO_LABEL: Record<string, string> = {
    EE: 'Entrada Externa (EE)', SE: 'Saída Externa (SE)', CE: 'Consulta Externa (CE)',
    ALI: 'Arquivo Lógico Interno (ALI)', AIE: 'Arquivo de Interface Externa (AIE)',
  };
  const tiposComDado = (['EE', 'SE', 'CE', 'ALI', 'AIE'] as const).filter(t => porTipo[t]);
  tiposComDado.forEach((tipo, idx) => {
    const g = porTipo[tipo];
    const pct = apf.totalPF > 0 ? `${((g.pf / apf.totalPF) * 100).toFixed(1)}%` : '0.0%';
    rows.push({
      cells: [null, null, TIPO_LABEL[tipo], g.qtd, g.pf, +g.pfa.toFixed(2), pct],
      align: ['left', 'left', 'left', 'right', 'right', 'right', 'right'],
      pos: idx === 0 ? 'first' : 'mid',
      height: 21,
    });
  });
  rows.push({
    cells: [null, null, 'TOTAL', apf.elementos.length, apf.totalPF, apf.totalPFA, '100%'],
    band: 'total', align: ['left', 'left', 'left', 'right', 'right', 'right', 'right'], height: 21,
  });
  rows.push({ cells: [], height: 12 });

  rows.push(mergedRow('MEMÓRIA DO CÁLCULO AGREGADO', 1, 'section', { height: 24 }));
  rows.push(mergedRow(`Total de Pontos de Função (bruto): ${apf.totalPF} PF`, 1, 'agregado', { pos: 'first', height: 22 }));
  rows.push(mergedRow('Total de Pontos de Função Ajustado (PFA) = Σ (PF do elemento × Deflator da operação)', 1, 'agregado', { height: 22 }));
  rows.push(mergedRow(`Deflatores aplicados — Inclusão: ${params.DeflatorInclusao} | Alteração: ${params.DeflatorAlteracao} | Exclusão: ${params.DeflatorExclusao}`, 1, 'agregado', { height: 22 }));
  rows.push(mergedRow(`Total PFA = ${apf.totalPFA}`, 1, 'totalPFAHighlight', { height: 22 }));
  rows.push(mergedRow(`Produtividade aplicada: ${params.Produtividade} horas por PF`, 1, 'agregado', { height: 22 }));
  rows.push(mergedRow(`Total de Horas = PFA × Produtividade = ${apf.totalPFA} × ${params.Produtividade} = ${apf.totalHoras}h`, 1, 'totalHoursHighlight', { height: 22 }));
  rows.push({ cells: [], height: 12 });

  rows.push(mergedRow('MATRIZ DE COMPLEXIDADE IFPUG (REFERÊNCIA)', 1, 'section', { height: 24 }));
  rows.push(mergedRow('EE (Entrada Externa) — Baixa: TD≤15 e AR≤1, ou TD≤4 e AR=2  |  Média: TD≤4 e AR≥3, ou TD 5-15 e AR=2, ou TD≥16 e AR≤1  |  Alta: demais casos', 1, 'matrix', { pos: 'first', height: 35 }));
  rows.push(mergedRow('SE/CE (Saída/Consulta Externa) — Baixa: TD≤19 e AR≤1, ou TD≤5 e AR≤3  |  Média: TD≤5 e AR≥4, ou TD 6-19 e AR 2-3, ou TD≥20 e AR≤1  |  Alta: demais casos', 1, 'matrix', { pos: 'mid', height: 35 }));
  rows.push(mergedRow('ALI/AIE (Arquivos) — Baixa: TD≤50 e TR=1, ou TD≤19 e TR≤5  |  Média: TD≤19 e TR≥6, ou TD 20-50 e TR 2-5, ou TD≥51 e TR=1  |  Alta: demais casos', 1, 'matrix', { pos: 'last', height: 35 }));
  rows.push({ cells: [], height: 12 });

  rows.push(mergedRow('LEGENDA DE SIGLAS', 1, 'section', { height: 24 }));
  rows.push(mergedRow('CE = Consulta Externa  ·  SE = Saída Externa  ·  EE = Entrada Externa  ·  ALI = Arquivo Lógico Interno  ·  AIE = Arquivo de Interface Externa', 1, 'legend', { height: 28 }));
  rows.push(mergedRow('TD = Tipos de Dados (campos/atributos referenciados)  ·  AR/TR = Arquivos Referenciados / Tipos de Registro  ·  PF = Pontos de Função (bruto)  ·  PFA = Pontos de Função Ajustado (após deflator)', 1, 'legend', { height: 28 }));
  rows.push({ cells: [], height: 12 });

  rows.push(mergedRow('Esta memória de cálculo reflete o escopo entendido até a data de geração acima. Alterações de escopo posteriores exigem nova análise e podem impactar a contagem de pontos de função e o esforço estimado.', 1, 'disclaimer', { height: 29 }));
  return rows;
}

/** Histórico completo de versões de APF (geração inicial + cada refinamento) — autor, PF/Horas
 * e as 2 sínteses de texto (o que foi pedido + como foi interpretado/resolvido). Fonte única
 * reusada pela seção "evolução da solicitação" da Memória de Cálculo E pelo PDF de Auditoria da
 * Comunicação (mesma tabela DocumentVersionHistory já usada pela tela de Auditoria do sistema —
 * nenhum rastreamento novo precisou ser criado). */
interface ApfVersionEntry {
  versao: number;
  criadoEm: Date;
  geradoPorNome: string | null;
  geradoPorEmail: string | null;
  totalPF: number | null;
  totalHoras: number | null;
  interviewContext: string | null;
  resumoAnalise: string | null;
}
async function getApfVersionHistory(workItemId: number): Promise<ApfVersionEntry[]> {
  const pool = await getPool();
  const history = await pool.request()
    .input('wid', sql.Int, workItemId)
    .query(`SELECT Versao, CriadoEm, GeradoPorNome, GeradoPorEmail, TotalPF, TotalHoras, InterviewContext, ResumoAnalise
            FROM DocumentVersionHistory WHERE WorkItemId = @wid AND Tipo = 'APF' ORDER BY Versao ASC`);
  return history.recordset.map((row: any) => ({
    versao: row.Versao,
    criadoEm: row.CriadoEm,
    geradoPorNome: row.GeradoPorNome,
    geradoPorEmail: row.GeradoPorEmail,
    totalPF: row.TotalPF,
    totalHoras: row.TotalHoras,
    interviewContext: row.InterviewContext,
    resumoAnalise: row.ResumoAnalise,
  }));
}

/** Compila "O QUE FOI SOLICITADO" de forma DETERMINÍSTICA (nunca só a paráfrase da LLM, que
 * pode perder fidelidade ao longo de várias refinagens): pedido inicial + um "Complemento" por
 * refinamento subsequente, cada um usando o InterviewContext REAL daquela versão (a instrução
 * literal que o analista deu à PATi). `historicoAnterior` já deve vir filtrado só com versões
 * anteriores à que está sendo renderizada. `askAtual` é o pedido/instrução da versão CORRENTE
 * (ainda não gravada em DocumentVersionHistory no momento da geração ao vivo). */
function buildSolicitacaoCompilada(
  historicoAnterior: ApfVersionEntry[], sinteseAtual: SintesePati, askAtual?: string | null,
): string {
  const fmtData = (d: Date) => new Date(d).toLocaleDateString('pt-BR');
  const partes: string[] = [];

  if (historicoAnterior.length === 0) {
    // Primeira geração — não há o que compilar ainda, o pedido inicial É o que a LLM sintetizou
    // a partir da descrição/discussão original do chamado.
    partes.push(sanitizeForDocument(askAtual) || sanitizeForDocument(sinteseAtual.oQueFoiPedido) || 'Não informado.');
  } else {
    const primeira = historicoAnterior[0];
    const sinteseInicial = parseSintese(primeira.resumoAnalise);
    const pedidoInicial = sanitizeForDocument(primeira.interviewContext) || sanitizeForDocument(sinteseInicial?.oQueFoiPedido) || 'Não informado.';
    partes.push(`Solicitação inicial (v${primeira.versao}, ${fmtData(primeira.criadoEm)}): ${pedidoInicial}`);
    for (const v of historicoAnterior.slice(1)) {
      const texto = sanitizeForDocument(v.interviewContext);
      if (!texto) continue;
      partes.push(`Complemento (v${v.versao}, ${fmtData(v.criadoEm)}): ${texto}`);
    }
    const complementoAtual = sanitizeForDocument(askAtual);
    if (complementoAtual) partes.push(`Complemento mais recente: ${complementoAtual}`);
  }
  return partes.join('\n\n');
}

export async function generateApfExcel(wi: any, apf: ApfResult, params: ApfParametros, sintese: SintesePati, opts: { versaoOverride?: number; askAtual?: string | null } = {}): Promise<Buffer> {
  // __dirname é dist/services (build) ou src/services (dev via tsx) — em ambos os casos
  // subir 2 níveis chega na raiz do app (sibling de dist/src), onde templates/ deve existir
  // (NÃO dentro de dist/templates — copy-assets copia lá também, mas esse caminho não é usado).
  const templatePath = resolve(__dirname, '../../templates', 'Modelo APF.xlsx');
  const templateBuf = readFileSync(templatePath);
  const zip = await JSZip.loadAsync(templateBuf);

  // Estilos originais de D,E,F,G,H,I,J,K,L,M,N,O,P,Q não têm vertical="center" (ficam no rodapé
  // da linha quando ela cresce por texto longo). Clonamos aqui, cedo, pra ter os novos índices
  // disponíveis ao processar sheet2 mais abaixo; a seção de DXF (mais abaixo) reusa essa mesma
  // variável `styles`, sem recarregar do zip.
  let styles = await zip.file('xl/styles.xml')!.async('string');
  const { stylesXml: stylesWithVCenter, indexMap: vCenter } = cloneCellXfsWithVerticalCenter(styles, [2, 83, 120, 71, 3, 81, 82, 84, 85]);
  styles = stylesWithVCenter;

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
  // which causes Excel to ignore horizontal alignment for text values. Style 2 (used by col E)
  // has numFmtId=0 + center alignment and works correctly — usamos o clone com vertical=center.
  for (let r = 11; r <= 20; r++) {
    sheet2 = sheet2.replace(new RegExp(`<c r="D${r}" s="\\d+"`), `<c r="D${r}" s="${vCenter[2]}"`);
  }

  // Normalize column B styles: original uses mix of 125/124/122/121/104 causing
  // inconsistent appearance. Use style 104 (left, fontId=13 non-bold, wrapText) for all
  // (104 já tem vertical="center" no template original).
  for (let r = 11; r <= 20; r++) {
    sheet2 = sheet2.replace(new RegExp(`<c r="B${r}" s="\\d+"`), `<c r="B${r}" s="104"`);
  }

  // Alinha ao meio (vertical=center) as demais colunas de valores da tabela (E=I/A/E,
  // F=TD, G=AR/TR, H..Q=colunas calculadas por fórmula: Complex./PF/PFA/Total/Desenv./
  // An.Teste/Teste) — no template original elas só tinham alinhamento horizontal, ficando
  // "coladas" embaixo quando a linha cresce pro texto de Processo/Observações caber.
  const colunasParaCentralizar: Record<string, number> = {
    E: vCenter[2], F: vCenter[83], G: vCenter[120], H: vCenter[71],
    I: vCenter[3], J: vCenter[3], K: vCenter[81], L: vCenter[82],
    M: vCenter[84], N: vCenter[85], O: vCenter[85], P: vCenter[85], Q: vCenter[85],
  };
  for (const [col, styleId] of Object.entries(colunasParaCentralizar)) {
    for (let r = 11; r <= 20; r++) {
      sheet2 = sheet2.replace(new RegExp(`<c r="${col}${r}" s="\\d+"`), `<c r="${col}${r}" s="${styleId}"`);
    }
  }

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

  // ─── Nova aba suplementar "Memória de Cálculo" ───
  // Bloco 100% ADITIVO, no fim da função: não modifica nenhuma linha das abas Contagem/
  // Funções processadas acima (modelo atual permanece BLINDADO), só acrescenta 1 sheet nova —
  // sheet3.xml já pertence à aba oculta de validação existente no template, por isso sheet5 —
  // com estilo próprio (título/seções/cabeçalho/zebra/total), via inlineStr (sem depender do
  // sharedStrings do template), e registra as partes de metadado que o .xlsx exige pra
  // reconhecer uma aba nova. A "Auditoria da Comunicação" saiu do Excel — agora é um PDF à
  // parte (generateApfAuditoriaPdf), sempre gerado na hora a partir do histórico mais atual.
  let stylesFinal = await zip.file('xl/styles.xml')!.async('string');
  const { stylesXml: stylesWithReport, ids: reportStyleIds } = appendReportStyles(stylesFinal);
  zip.file('xl/styles.xml', stylesWithReport);

  // "Elaborado por" e a solicitação compilada consideram só versões ANTERIORES à que está
  // sendo renderizada agora — importante tanto pra geração ao vivo (a versão atual ainda não
  // foi gravada em DocumentVersionHistory neste ponto, o INSERT acontece depois no chamador)
  // quanto pro re-render de uma versão histórica antiga (não deve "ver" versões futuras).
  const historicoTodo = await getApfVersionHistory(wi.Id);
  const versaoAtual = opts.versaoOverride ?? await nextVersion(wi.Id, 'APF');
  const historicoAnterior = historicoTodo.filter(v => v.versao < versaoAtual);
  const ultimaVersao = historicoAnterior[historicoAnterior.length - 1];
  const elaboradoPor = ultimaVersao?.geradoPorNome || null;
  const solicitacaoCompilada = buildSolicitacaoCompilada(historicoAnterior, sintese, opts.askAtual);

  const memoriaRows = buildMemoriaCalculoRows(wi, apf, params, sintese, elaboradoPor, versaoAtual, reportStyleIds, solicitacaoCompilada);
  // Grade fiel ao modelo aprovado: A=margem esquerda, B=Nº, C=Processo (larga), D..K=demais
  // colunas de conteúdo; L=margem direita cosmética (nunca recebe merge/conteúdo).
  let sheet5Xml = buildStyledSheetXml(memoriaRows, [3.86, 6.43, 33.14, 14.43, 13.29, 10.29, 12.43, 15.57, 9.86, 12.14, 11], reportStyleIds, { trailingMarginWidth: 3.86 });

  // Logo da Paradigma (mesma imagem já embutida em Contagem/Funções, xl/media/image1.png) —
  // partes novas e próprias (drawing5.xml + rels), nunca reaproveita drawing1/drawing2.
  // Ancorada na coluna B, linhas 2-3 (col=1,row=1 0-based) — mesmas coordenadas/tamanho do
  // layout aprovado pelo usuário: primeiro elemento do cabeçalho, ao lado do título (que
  // mescla a partir de C pra não sobrepor a logo).
  const drawing5Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>1</xdr:col><xdr:colOff>50800</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>38100</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>1222375</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>79375</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Logo Paradigma"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1" cstate="print"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr bwMode="auto"><a:xfrm><a:off x="307975" y="161925"/><a:ext cx="1600200" cy="355600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="9525"><a:noFill/></a:ln></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
  zip.file('xl/drawings/drawing5.xml', drawing5Xml);
  zip.file('xl/drawings/_rels/drawing5.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>');
  zip.file('xl/worksheets/_rels/sheet5.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing5.xml"/></Relationships>');
  // <drawing> precisa vir depois de <mergeCells> e antes de </worksheet> (ordem exigida pelo
  // schema CT_Worksheet) — buildStyledSheetXml não sabe de drawings, então injeta aqui.
  sheet5Xml = sheet5Xml.replace('</worksheet>', '<drawing r:id="rId1"/></worksheet>');
  zip.file('xl/worksheets/sheet5.xml', sheet5Xml);

  let contentTypesFinal = await zip.file('[Content_Types].xml')!.async('string');
  // Remove a aba "TFS" (sheet4) — vazia, sem nenhuma fórmula/nome definido referenciando-a
  // em nenhum outro lugar do arquivo (confirmado antes de implementar), pedido do usuário.
  contentTypesFinal = contentTypesFinal.replace(/<Override PartName="\/xl\/worksheets\/sheet4\.xml"[^>]*\/>/, '');
  contentTypesFinal = contentTypesFinal.replace('</Types>',
    '<Override PartName="/xl/worksheets/sheet5.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/drawings/drawing5.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
  zip.file('[Content_Types].xml', contentTypesFinal);

  let wbRelsFinal = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  wbRelsFinal = wbRelsFinal.replace(/<Relationship Id="rId4"[^>]*\/>/, '');
  wbRelsFinal = wbRelsFinal.replace('</Relationships>',
    '<Relationship Id="rId13" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/></Relationships>');
  zip.file('xl/_rels/workbook.xml.rels', wbRelsFinal);

  let workbookFinal = await zip.file('xl/workbook.xml')!.async('string');
  workbookFinal = workbookFinal.replace(/<sheet name="TFS"[^>]*\/>/, '');
  workbookFinal = workbookFinal.replace('</sheets>',
    '<sheet name="Memória de Cálculo" sheetId="8" r:id="rId13"/></sheets>');
  zip.file('xl/workbook.xml', workbookFinal);
  zip.remove('xl/worksheets/sheet4.xml');


  // Generate buffer
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return buffer;
}

/** PDF "Auditoria da Comunicação" — trilha completa de interação com o operador (o que foi
 * solicitado + como foi interpretado/resolvido, versão a versão). Saiu do Excel (pedido do
 * usuário: textos de comunicação longos ficavam ilegíveis espremidos em colunas de planilha)
 * — gerado SOB DEMANDA a cada download (nunca salvo em DocumentosGerados), pra sempre refletir
 * o histórico mais atual no momento, incluindo refinamentos feitos depois do último Excel. */
export async function generateApfAuditoriaPdf(workItemId: number): Promise<Buffer> {
  const pool = await getPool();
  const wiResult = await pool.request()
    .input('id', sql.Int, workItemId)
    .query(`SELECT Id, Title, ClienteNome, Modulo FROM WorkItems WHERE Id = @id`);
  const wi = wiResult.recordset[0];
  if (!wi) throw new Error('Work item não encontrado');

  const historico = await getApfVersionHistory(workItemId);
  const PAGE_WIDTH = 515; // A4 - margem 40 dos dois lados
  const FIELD_INDENT = 12;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#1F3864')
      .text('Auditoria da Comunicação - Análise de Pontos de Função', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#667085')
      .text(`Chamado #${wi.Id} - ${wi.Title}`, { align: 'center' });
    doc.text(`Cliente: ${wi.ClienteNome || 'N/A'}  ·  Módulo: ${wi.Modulo || 'N/A'}  ·  Gerado em ${new Date().toLocaleString('pt-BR')}`, { align: 'center' });
    doc.moveDown(1);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E2E6EC').stroke();
    doc.moveDown(1);

    if (historico.length === 0) {
      doc.fontSize(10).font('Helvetica').fillColor('#333333')
        .text('Nenhum histórico de versão registrado ainda para este chamado.');
    }

    // Renderiza um campo (rótulo + parágrafo) com uma barra de destaque colorida à esquerda —
    // desenhada DEPOIS do texto, quando já se sabe a altura final do bloco (PDFKit não permite
    // saber a altura de um texto com wrap antes de renderizá-lo).
    const renderField = (label: string, texto: string) => {
      if (doc.y > 700) doc.addPage();
      const top = doc.y;
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1F3864')
        .text(label, 40 + FIELD_INDENT, doc.y, { width: PAGE_WIDTH - FIELD_INDENT });
      doc.moveDown(0.15);
      doc.fontSize(9.5).font('Helvetica').fillColor('#333333')
        .text(texto, 40 + FIELD_INDENT, doc.y, { width: PAGE_WIDTH - FIELD_INDENT, align: 'justify', lineGap: 1.5 });
      const bottom = doc.y;
      doc.rect(40, top, 2.5, bottom - top).fill('#1F3864');
      doc.moveDown(0.55);
    };

    // Renderiza a conversa com a PATi como um chat premium (balões alternados esquerda/direita,
    // avatar com iniciais, nome em negrito, hora discreta) — em vez de cartões de largura total.
    const CHAT_LEFT = 40, CHAT_RIGHT = 555, CHAT_WIDTH = CHAT_RIGHT - CHAT_LEFT;
    const AVATAR_SIZE = 22, AVATAR_GAP = 6;
    const BUBBLE_MAX_WIDTH = Math.round(CHAT_WIDTH * 0.78);
    const BUBBLE_PAD_X = 11, BUBBLE_PAD_TOP = 8, BUBBLE_PAD_BOTTOM = 9, BUBBLE_RADIUS = 8;
    const NAME_SIZE = 9, BODY_SIZE = 9.5, TIME_SIZE = 8, BUBBLE_GAP_Y = 16;

    // Centraliza a sigla no círculo usando as métricas REAIS da fonte (capHeight/ascender do AFM
    // do Helvetica-Bold) em vez da altura de linha inteira — texto maiúsculo sem descendentes
    // ("IA"/"AS") fica com menos tinta na metade inferior da caixa de linha, então centralizar a
    // caixa inteira deixa o texto visualmente alto; centralizar pelo capHeight é o que bate com o
    // centro geométrico real dos traços do texto.
    const drawAvatar = (x: number, y: number, cor: string, iniciais: string) => {
      const r = AVATAR_SIZE / 2;
      doc.circle(x + r, y + r, r).fill(cor);
      doc.fontSize(8).font('Helvetica-Bold');
      const font = (doc as any)._font;
      const capHeight = (font.capHeight / 1000) * 8;
      const ascender = (font.ascender / 1000) * 8;
      const textTop = y + r - ascender + capHeight / 2;
      doc.fillColor('#FFFFFF').text(iniciais, x, textTop, { width: AVATAR_SIZE, align: 'center', lineBreak: false });
    };

    const renderInteracaoChat = (label: string, turnos: { role: 'PATi' | 'Analista'; horario?: string; texto: string }[], autorNome: string | null) => {
      if (doc.y > 700) doc.addPage();
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1F3864')
        .text(label, CHAT_LEFT, doc.y, { width: CHAT_WIDTH });
      doc.moveDown(0.6);

      const iniciaisAnalista = getInitials(autorNome);

      turnos.forEach(t => {
        const isPati = t.role === 'PATi';
        const nome = isPati ? 'PATi' : 'Analista';
        const corAvatar = isPati ? '#1F3864' : '#64748B';
        const corNome = isPati ? '#1F3864' : '#475467';
        const fillBolha = isPati ? '#E8F0FE' : '#D9E2F3';
        // Só mostra horário quando ele foi REALMENTE registrado pra este turno específico —
        // turnos antigos (gravados antes do horário por mensagem existir) não têm um horário
        // individual de verdade, então repetir o horário da versão em todos seria enganoso
        // (pareceria que tudo aconteceu no mesmo instante). Melhor omitir do que fingir precisão.

        // Mede o texto ANTES de desenhar (heightOfString calcula a altura com wrap sem
        // renderizar) — necessário pra desenhar o balão preenchido ATRÁS do texto, e pra saber
        // com certeza que o texto cabe dentro da altura do balão (nunca deve vazar pra fora).
        const maxContentWidth = BUBBLE_MAX_WIDTH - BUBBLE_PAD_X * 2;
        doc.font('Helvetica').fontSize(BODY_SIZE);
        const naturalWidth = doc.widthOfString(t.texto);
        doc.font('Helvetica-Bold').fontSize(NAME_SIZE);
        const nameWidth = doc.widthOfString(nome);
        const contentWidth = Math.min(maxContentWidth, Math.max(naturalWidth, nameWidth, 46));
        const bubbleWidth = contentWidth + BUBBLE_PAD_X * 2;

        doc.font('Helvetica').fontSize(BODY_SIZE);
        const textHeight = doc.heightOfString(t.texto, { width: contentWidth, align: 'left', lineGap: 2 });
        const nameLineHeight = NAME_SIZE + 5;
        const timeLineHeight = t.horario ? TIME_SIZE + 6 : 0;
        // +2pt de folga de segurança — nunca deixar o texto encostar/vazar a borda inferior.
        const bubbleHeight = BUBBLE_PAD_TOP + nameLineHeight + textHeight + timeLineHeight + BUBBLE_PAD_BOTTOM + 2;

        // Quebra de página ANTES de desenhar (já sabemos a altura exata do balão) — evita um
        // balão cortado ao meio entre páginas, e garante que NENHUMA mensagem fique de fora.
        if (doc.y + Math.max(AVATAR_SIZE, bubbleHeight) > 780) doc.addPage();

        const bubbleTop = doc.y;
        const avatarX = isPati ? CHAT_LEFT : CHAT_RIGHT - AVATAR_SIZE;
        const bubbleX = isPati ? CHAT_LEFT + AVATAR_SIZE + AVATAR_GAP : CHAT_RIGHT - AVATAR_SIZE - AVATAR_GAP - bubbleWidth;

        drawAvatar(avatarX, bubbleTop, corAvatar, isPati ? 'IA' : iniciaisAnalista);
        doc.roundedRect(bubbleX, bubbleTop, bubbleWidth, bubbleHeight, BUBBLE_RADIUS).fill(fillBolha);

        doc.fontSize(NAME_SIZE).font('Helvetica-Bold').fillColor(corNome)
          .text(nome, bubbleX + BUBBLE_PAD_X, bubbleTop + BUBBLE_PAD_TOP, { width: contentWidth });
        doc.fontSize(BODY_SIZE).font('Helvetica').fillColor('#26313F')
          .text(t.texto, bubbleX + BUBBLE_PAD_X, bubbleTop + BUBBLE_PAD_TOP + nameLineHeight, { width: contentWidth, align: 'left', lineGap: 2 });
        if (t.horario) {
          doc.fontSize(TIME_SIZE).font('Helvetica').fillColor('#9AA5B4')
            .text(t.horario, bubbleX + BUBBLE_PAD_X, bubbleTop + BUBBLE_PAD_TOP + nameLineHeight + textHeight + 4, { width: contentWidth, align: 'right' });
        }

        doc.y = Math.max(bubbleTop + AVATAR_SIZE, bubbleTop + bubbleHeight) + BUBBLE_GAP_Y;
      });
      doc.moveDown(0.1);
    };

    let prevPF: number | null = null;
    let prevHoras: number | null = null;
    // Deltas calculados em ordem CRONOLÓGICA (senão Δ ficaria errado), mas exibidos em ordem
    // DECRESCENTE (evento mais recente primeiro — pedido do usuário, mais natural pra auditoria).
    const comDeltas = historico.map(v => {
      const deltaPF = prevPF !== null && v.totalPF != null ? +(v.totalPF - prevPF).toFixed(2) : null;
      const deltaHoras = prevHoras !== null && v.totalHoras != null ? +(v.totalHoras - prevHoras).toFixed(2) : null;
      if (v.totalPF != null) prevPF = v.totalPF;
      if (v.totalHoras != null) prevHoras = v.totalHoras;
      return { ...v, deltaPF, deltaHoras };
    }).reverse();

    comDeltas.forEach((v, idx) => {
      if (doc.y > 650) doc.addPage();

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1F3864')
        .text(`Versão ${v.versao}  ·  ${new Date(v.criadoEm).toLocaleString('pt-BR')}  ·  ${v.geradoPorNome || '—'}${v.geradoPorEmail ? ` (${v.geradoPorEmail})` : ''}`);
      doc.moveDown(0.15);
      // Só mostra os segmentos que têm valor real — nunca imprime "Var. PF: —" vazio (pedido do
      // usuário: campo sem valor não agrega nada visualmente, melhor não aparecer).
      const metaSegmentos: string[] = [];
      if (v.totalPF != null) metaSegmentos.push(`PF: ${v.totalPF}`);
      if (v.totalHoras != null) metaSegmentos.push(`Horas: ${v.totalHoras}`);
      if (v.deltaPF !== null) metaSegmentos.push(`Var. PF: ${v.deltaPF >= 0 ? `+${v.deltaPF}` : v.deltaPF}`);
      if (v.deltaHoras !== null) metaSegmentos.push(`Var. Horas: ${v.deltaHoras >= 0 ? `+${v.deltaHoras}` : v.deltaHoras}`);
      if (metaSegmentos.length > 0) {
        doc.fontSize(9).font('Helvetica').fillColor('#667085').text(metaSegmentos.join('  ·  '));
        doc.moveDown(0.5);
      } else {
        doc.moveDown(0.35);
      }

      // "INTERAÇÃO COM A PATI" usa o InterviewContext BRUTO (só emoji removido — preserva as
      // quebras de linha e os rótulos de papel) pra reconstruir a conversa turno a turno. É a
      // comunicação real entre operador e agente, existe desde sempre para TODA versão. Quando
      // não há InterviewContext (raro), cai pra síntese estruturada em prosa (sem turnos).
      const sintese = parseSintese(v.resumoAnalise);
      const turnos = parseInteracaoTurns(stripEmojiOnly(v.interviewContext));
      const horarioVersao = new Date(v.criadoEm).toLocaleString('pt-BR');
      if (turnos.length > 0) {
        // Fecha a conversa com uma mensagem final de conclusão — a entrevista em si nunca grava
        // "documento gerado com sucesso" (isso só acontece DEPOIS que o InterviewContext já foi
        // fechado), mas toda versão registrada AQUI representa uma geração bem-sucedida, então
        // esse fechamento sempre reflete a realidade. Esta é a ÚNICA mensagem com horário
        // "chutado" a partir da versão — é genuinamente o momento real desse evento (diferente
        // dos turnos antigos sem horário próprio, que não recebem essa data pra não parecer que
        // tudo aconteceu no mesmo instante).
        const turnosComFechamento = [...turnos, {
          role: 'PATi' as const,
          horario: horarioVersao,
          texto: `Documento de APF gerado com sucesso (Versão ${v.versao}): ${v.totalPF ?? '—'} PF, ${v.totalHoras ?? '—'} horas.`,
        }];
        renderInteracaoChat('INTERAÇÃO COM A PATI', turnosComFechamento, v.geradoPorNome);
      } else {
        renderField('INTERAÇÃO COM A PATI', (sintese && sanitizeForDocument(sintese.oQueFoiPedido)) || 'Nenhum registro de solicitação disponível para esta versão.');
      }
      if (sintese) {
        renderField('O QUE FOI ENTENDIDO', sanitizeForDocument(sintese.oQueFoiEntendido) || 'Síntese não disponível para esta versão.');
        renderField('SOLUÇÃO PROJETADA', sanitizeForDocument(sintese.oQueFoiProjetado) || 'Síntese não disponível para esta versão.');
        renderField('RACIONAL DA CONTAGEM', sanitizeForDocument(sintese.motivoContagem) || 'Síntese não disponível para esta versão.');
      }

      if (idx < comDeltas.length - 1) {
        doc.moveDown(0.2);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E2E6EC').stroke();
        doc.moveDown(0.6);
      }
    });

    doc.end();
  });
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
export async function getDocumentStatus(workItemIds: number[]): Promise<Record<number, { apfExcel: boolean; spec: boolean; specDocx: boolean }>> {
  if (workItemIds.length === 0) return {};
  const pool = await getPool();
  const idList = workItemIds.join(',');
  const result = await pool.request()
    .query(`SELECT WorkItemId, Tipo FROM DocumentosGerados WHERE WorkItemId IN (${idList})`);

  const status: Record<number, { apfExcel: boolean; spec: boolean; specDocx: boolean }> = {};
  for (const row of result.recordset) {
    if (!status[row.WorkItemId]) status[row.WorkItemId] = { apfExcel: false, spec: false, specDocx: false };
    if (row.Tipo === 'APF_EXCEL') status[row.WorkItemId].apfExcel = true;
    if (row.Tipo === 'SPEC') status[row.WorkItemId].spec = true;
    if (row.Tipo === 'SPEC_DOCX') status[row.WorkItemId].specDocx = true;
  }
  return status;
}
