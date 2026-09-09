import { llmComplete } from './llm.js';
import { buildEstruturacaoPrompt } from '../prompts/spec/estruturacao.js';

/**
 * Representação estruturada de uma Especificação de Negócio — modelo interno independente
 * do template Word (ver spec-docx-generator.ts para o mapeamento pra tags do docxtemplater).
 * Mantido mesmo quando um campo não tem seção correspondente no template atual (ex.:
 * criteriosAceite), pra permitir rastreabilidade/uso futuro em APF sem perder informação.
 */
export interface RequisitoFuncional {
  id: string; // "F-001"
  titulo: string;
  prioridade: 'Must Have' | 'Should Have' | 'Could Have';
  entrada: string; // parâmetro(s) de entrada do método/endpoint (obrigatório/opcional, tipo de dado)
  descricao: string;
  regraPrincipal: string;
  beneficio: string;
  origem: 'CONFIRMADO' | 'INFERIDO' | 'SUGERIDO' | 'PENDENTE_DE_DEFINICAO' | 'NAO_APLICAVEL';
  regrasRelacionadas: string[]; // ["RN-001"]
  criteriosAceite: { dado: string; quando: string; entao: string }[];
}

export interface RegraNegocio {
  id: string; // "RN-001"
  nome: string;
  descricao: string;
  impacto: 'Baixo' | 'Médio' | 'Alto' | 'Crítico';
}

// Escopo é o coração da especificação — cada item leva uma justificativa curta (o "porquê"),
// não só o rótulo, pra dar substância real a uma das seções mais lidas do documento.
export interface EscopoItem {
  item: string;
  justificativa: string;
}

export interface SpecEstruturada {
  demanda: { workItemId: number; titulo: string; cliente: string; modulo: string };
  objetivo: string;
  resumoResultadoEsperado: string;
  usuariosImpactados: string;
  contextoNegocio: { intro: string; comoFuncionaHoje: string[] };
  problemaAtual: { problema: string; descricao: string }[];
  beneficiosEsperados: { beneficio: string; impacto: string }[];
  stakeholders: { perfil: string; papel: string }[];
  escopo: { incluido: EscopoItem[]; excluido: EscopoItem[] };
  premissas: string[];
  restricoes: string[];
  processoAtual: { fluxoResumido: string[]; gargalosRiscos: { item: string; descricao: string }[] };
  processoFuturo: { intro: string; fluxo: string[] };
  comparativoProcessos: { processo: string; situacaoAtual: string; novaSituacao: string }[];
  requisitosFuncionais: RequisitoFuncional[];
  regrasNegocio: RegraNegocio[];
  matrizRiscos: { risco: string; probabilidade: string; impacto: string; mitigacao: string; responsavel: string }[];
  glossario: { termo: string; definicao: string }[];
  pendencias: { descricao: string; criticidade: 'alta' | 'media' | 'baixa' }[];
  versionamento: { versao: string; data: string; autor: string; descricao: string }[];
  historicoAlteracoes: { area: string; alteracao: string }[];
}

/** Remove cercas de markdown (```json ... ```) que alguns modelos ainda incluem apesar do jsonMode. */
function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

/** Normaliza itens de escopo — tolera o modelo devolver string solta (sem justificativa)
 * em vez do formato pedido, em vez de quebrar a geração. */
function normalizeEscopoItems(raw: any): EscopoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any) => typeof r === 'string' ? { item: r, justificativa: '' } : { item: r.item || '', justificativa: r.justificativa || '' });
}

interface ExclusaoObrigatoria { keywords: string[]; item: string; justificativa: string }

// Cláusulas de proteção que TODA especificação deve conter, independente do que a LLM
// produziu — garante a cobertura mesmo se o modelo esquecer/ignorar a instrução do prompt.
const EXCLUSOES_OBRIGATORIAS: ExclusaoObrigatoria[] = [
  {
    keywords: ['retroativ', 'já existentes', 'dados existentes', 'instâncias existentes', 'registros existentes'],
    item: 'Tratamento retroativo de registros, instâncias ou dados já existentes',
    justificativa: 'Quaisquer registros criados antes da publicação desta entrega não são objeto desta especificação e não serão reprocessados, corrigidos ou migrados no âmbito deste escopo.',
  },
  {
    keywords: ['nova tela', 'novo campo', 'novo componente', 'telas ou campos', 'campos ou componentes'],
    item: 'Criação de telas, campos ou componentes não descritos nesta especificação',
    justificativa: 'A solução utiliza os elementos de interface já descritos nesta especificação — novos elementos de UI são tratados como escopo adicional.',
  },
  {
    keywords: ['relatório', 'relatorio', 'consulta', 'exportaç', 'exportacao'],
    item: 'Alterações em relatórios, consultas ou exportações não mencionadas',
    justificativa: 'Relatórios e consultas não citados nesta especificação permanecem inalterados nesta entrega.',
  },
  {
    keywords: ['integraç', 'integracao', 'sistema externo', 'api externa', 'terceiro'],
    item: 'Integrações com sistemas externos não descritas nesta especificação',
    justificativa: 'Integrações não detalhadas nesta especificação estão fora do âmbito desta entrega.',
  },
  {
    keywords: ['não detalhad', 'nao detalhad', 'fora do descrito'],
    item: 'Funcionalidades ou comportamentos não detalhados na seção "Dentro do Escopo"',
    justificativa: 'Apenas os itens listados em "Dentro do Escopo" fazem parte desta entrega.',
  },
];

/** Garante que as 5 exclusões padrão (retroativo, telas/campos, relatórios, integrações,
 * não detalhado) estejam sempre presentes no "Fora do Escopo" — só acrescenta as que ainda
 * não estão cobertas (checagem por palavra-chave), nunca duplica o que a LLM já escreveu. */
function ensureExclusoesObrigatorias(excluido: EscopoItem[]): EscopoItem[] {
  const haystack = excluido.map(e => `${e.item} ${e.justificativa}`.toLowerCase()).join(' | ');
  const resultado = [...excluido];
  for (const regra of EXCLUSOES_OBRIGATORIAS) {
    const jaCoberto = regra.keywords.some(k => haystack.includes(k));
    if (!jaCoberto) resultado.push({ item: regra.item, justificativa: regra.justificativa });
  }
  return resultado;
}

/**
 * Etapa 2 do pipeline (Estruturação): transforma a demanda + contexto acumulado + entrevista
 * numa representação estruturada (SpecEstruturada). Não gera o documento (isso é
 * responsabilidade do spec-docx-generator.ts, sem LLM) nem faz a revisão (spec-review.ts).
 */
export async function estruturarDemanda(params: {
  workItemId: number;
  titulo: string;
  cliente: string;
  modulo: string;
  contextoConsolidado: string;
  interviewContext?: string;
  autor: string;
}): Promise<SpecEstruturada> {
  const { system, user } = buildEstruturacaoPrompt(params);
  const raw = await llmComplete('spec_estruturacao', [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { jsonMode: true, maxTokens: 4000 });

  let parsed: any;
  if (!raw.trim()) {
    throw new Error('A LLM devolveu uma resposta vazia na estruturação da especificação (provável orçamento de tokens insuficiente para o esforço de raciocínio configurado — ver REASONING_MIN_TOKENS em llm.ts).');
  }
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch (err) {
    throw new Error(`Falha ao interpretar JSON da estruturação da especificação: ${(err as Error).message}. Resposta bruta: ${raw.substring(0, 300)}`);
  }

  // Renumeração defensiva de IDs (garante sequência mesmo se o modelo pular algum número)
  const requisitosFuncionais: RequisitoFuncional[] = (parsed.requisitosFuncionais || []).map((r: any, i: number) => ({
    id: `F-${String(i + 1).padStart(3, '0')}`,
    titulo: r.titulo || '',
    prioridade: r.prioridade || 'Should Have',
    entrada: r.entrada || '',
    descricao: r.descricao || '',
    regraPrincipal: r.regraPrincipal || '',
    beneficio: r.beneficio || '',
    origem: r.origem || 'INFERIDO',
    regrasRelacionadas: Array.isArray(r.regrasRelacionadas) ? r.regrasRelacionadas : [],
    criteriosAceite: Array.isArray(r.criteriosAceite) ? r.criteriosAceite : [],
  }));

  const regrasNegocio: RegraNegocio[] = (parsed.regrasNegocio || []).map((r: any, i: number) => ({
    id: `RN-${String(i + 1).padStart(3, '0')}`,
    nome: r.nome || '',
    descricao: r.descricao || '',
    impacto: r.impacto || 'Médio',
  }));

  const dataHoje = new Date().toLocaleDateString('pt-BR');

  return {
    demanda: { workItemId: params.workItemId, titulo: params.titulo, cliente: params.cliente, modulo: params.modulo },
    objetivo: parsed.objetivo || '',
    resumoResultadoEsperado: parsed.resumoResultadoEsperado || '',
    usuariosImpactados: parsed.usuariosImpactados || '',
    contextoNegocio: { intro: parsed.contextoNegocio?.intro || '', comoFuncionaHoje: parsed.contextoNegocio?.comoFuncionaHoje || [] },
    problemaAtual: parsed.problemaAtual || [],
    beneficiosEsperados: parsed.beneficiosEsperados || [],
    stakeholders: parsed.stakeholders || [],
    escopo: { incluido: normalizeEscopoItems(parsed.escopo?.incluido), excluido: ensureExclusoesObrigatorias(normalizeEscopoItems(parsed.escopo?.excluido)) },
    premissas: parsed.premissas || [],
    restricoes: parsed.restricoes || [],
    processoAtual: { fluxoResumido: parsed.processoAtual?.fluxoResumido || [], gargalosRiscos: parsed.processoAtual?.gargalosRiscos || [] },
    processoFuturo: { intro: parsed.processoFuturo?.intro || '', fluxo: parsed.processoFuturo?.fluxo || [] },
    comparativoProcessos: parsed.comparativoProcessos || [],
    requisitosFuncionais,
    regrasNegocio,
    matrizRiscos: parsed.matrizRiscos || [],
    glossario: parsed.glossario || [],
    pendencias: parsed.pendencias || [],
    versionamento: [{ versao: '1.0', data: dataHoje, autor: params.autor, descricao: 'Elaboração inicial da especificação.' }],
    historicoAlteracoes: [{ area: 'Elaboração', alteracao: 'Especificação elaborada com base nas informações coletadas junto ao cliente.' }],
  };
}

export interface LacunasResult {
  criticas: string[]; // impedem a geração do documento
  avisos: string[];   // não bloqueiam, mas valem menção ao usuário
}

/**
 * Etapa 3 do pipeline (Identificação de lacunas) — verificação determinística (sem LLM),
 * seção 13 do briefing de arquitetura. Lacunas críticas devem impedir a geração do
 * documento até serem resolvidas (o orquestrador decide o que fazer com isso).
 */
export function detectarLacunas(spec: SpecEstruturada): LacunasResult {
  const criticas: string[] = [];
  const avisos: string[] = [];

  if (!spec.objetivo?.trim()) criticas.push('Objetivo não foi identificado.');
  if (spec.requisitosFuncionais.length === 0) criticas.push('Nenhum requisito funcional foi identificado.');
  if (spec.stakeholders.length === 0) avisos.push('Nenhum stakeholder foi identificado.');
  if (spec.escopo.incluido.length === 0) avisos.push('Escopo (dentro) não foi identificado.');

  const regraIds = new Set(spec.regrasNegocio.map(r => r.id));
  const regrasReferenciadas = new Set(spec.requisitosFuncionais.flatMap(r => r.regrasRelacionadas));
  for (const regra of spec.regrasNegocio) {
    if (!regrasReferenciadas.has(regra.id)) avisos.push(`Regra de negócio ${regra.id} (${regra.nome}) não está associada a nenhum requisito funcional.`);
  }
  for (const req of spec.requisitosFuncionais) {
    if (req.criteriosAceite.length === 0) avisos.push(`Requisito ${req.id} (${req.titulo}) não tem critérios de aceite.`);
    if (!req.entrada?.trim()) avisos.push(`Requisito ${req.id} (${req.titulo}) não tem parâmetro de entrada especificado.`);
    if (req.origem === 'PENDENTE_DE_DEFINICAO') avisos.push(`Requisito ${req.id} (${req.titulo}) está marcado como pendente de definição.`);
    for (const regraId of req.regrasRelacionadas) {
      if (!regraIds.has(regraId)) avisos.push(`Requisito ${req.id} referencia a regra ${regraId}, que não existe na lista de regras de negócio.`);
    }
  }

  // Mitigação de risco que soa como decisão AINDA PENDENTE ("confirmar com o cliente...",
  // "definir com o negócio se...") nunca deveria ir pro documento final, principalmente em
  // riscos de probabilidade Média/Alta — sinaliza pro analista resolver antes de enviar.
  const PADRAO_DECISAO_PENDENTE = /\b(confirmar com|definir com|a definir|a confirmar|pendente de defini|validar com o cliente se|decidir se)\b/i;
  for (const risco of spec.matrizRiscos) {
    const provavelAltaOuMedia = risco.probabilidade === 'Média' || risco.probabilidade === 'Alta';
    if (provavelAltaOuMedia && PADRAO_DECISAO_PENDENTE.test(risco.mitigacao || '')) {
      avisos.push(`Risco "${risco.risco}" (probabilidade ${risco.probabilidade}) tem mitigação que soa como decisão ainda pendente ("${risco.mitigacao}") — resolva e documente a decisão tomada antes de enviar ao cliente.`);
    }
  }

  return { criticas, avisos };
}
