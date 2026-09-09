import type { SpecEstruturada } from '../../services/spec-structuring.js';

/**
 * Prompt centralizado da etapa de REVISÃO automática da Especificação estruturada.
 * Roda DEPOIS da estruturação e ANTES da geração do documento — checa completude,
 * consistência, rastreabilidade, testabilidade, clareza, escopo e relevância pra APF
 * (seção 14 do briefing de arquitetura). Em v1 é só consultiva (não bloqueia nem
 * corrige automaticamente) — as observações ficam salvas para auditoria/uso futuro.
 */
export function buildRevisaoPrompt(spec: SpecEstruturada): { system: string; user: string } {
  const system = `Você é um revisor técnico de especificações de negócio. Analise o JSON estruturado abaixo e aponte problemas objetivos, sem reescrever o conteúdo. Verifique:
- COMPLETUDE: alguma seção essencial está vazia ou rasa demais?
- CONSISTÊNCIA: há contradições entre requisitos, regras ou o comparativo de processos? Existe alguma Regra de Negócio com valor FIXO (ex.: um limite, uma mensagem) que contraria uma Premissa que descreve esse mesmo valor como CONFIGURÁVEL, sem declarar explicitamente qual prevalece?
- RASTREABILIDADE: todo requisito funcional referencia ao menos uma regra de negócio relacionada quando fizer sentido? Alguma regra de negócio não é referenciada por nenhum requisito? Todo item de "Dentro do Escopo" tem ao menos um requisito funcional correspondente?
- TESTABILIDADE: os critérios de aceite (dado/quando/então) de cada requisito são objetivos e verificáveis? Algum critério de aceite implica um comportamento que não está descrito em nenhum requisito funcional?
- CLAREZA: existe algum termo ambíguo ou requisito vago ("deverá funcionar corretamente" sem explicar o quê)?
- ESCOPO: a especificação extrapolou a demanda original, inventando funcionalidades não solicitadas (verifique os campos "origem" — SUGERIDO/INFERIDO em excesso é sinal de alerta)?
- APF: existe informação suficiente (processos, tipo de operação, dados envolvidos) para uma contagem de pontos de função posterior?
- PROTEÇÃO/TOM: alguma seção admite lacuna como fraqueza do produto ("a plataforma não possui...", "não há suporte para..."), menciona alternativa cogitada e descartada, enquadra algo como "correção de bug/defeito" em vez de evolução, ou cita identificador específico de registro com problema (número de pedido, ID de usuário)? Alguma mitigação de risco soa como uma decisão ainda pendente ("confirmar com o cliente...", "definir com o negócio...") em vez de uma ação já decidida?

Retorne APENAS um JSON válido no formato:
{"ok": true|false, "observacoes": ["observação objetiva 1", "observação objetiva 2"]}
"ok" deve ser false somente se houver problema que comprometa a compreensão ou uso do documento (não seja excessivamente rígido com detalhes menores).`;

  const user = `ESPECIFICAÇÃO ESTRUTURADA (JSON):\n${JSON.stringify(spec)}`;

  return { system, user };
}
