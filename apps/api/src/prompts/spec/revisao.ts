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
- CONSISTÊNCIA: há contradições entre requisitos, regras ou o comparativo de processos?
- RASTREABILIDADE: todo requisito funcional referencia ao menos uma regra de negócio relacionada quando fizer sentido? Alguma regra de negócio não é referenciada por nenhum requisito?
- TESTABILIDADE: os critérios de aceite (dado/quando/então) de cada requisito são objetivos e verificáveis?
- CLAREZA: existe algum termo ambíguo ou requisito vago ("deverá funcionar corretamente" sem explicar o quê)?
- ESCOPO: a especificação extrapolou a demanda original, inventando funcionalidades não solicitadas (verifique os campos "origem" — SUGERIDO/INFERIDO em excesso é sinal de alerta)?
- APF: existe informação suficiente (processos, tipo de operação, dados envolvidos) para uma contagem de pontos de função posterior?

Retorne APENAS um JSON válido no formato:
{"ok": true|false, "observacoes": ["observação objetiva 1", "observação objetiva 2"]}
"ok" deve ser false somente se houver problema que comprometa a compreensão ou uso do documento (não seja excessivamente rígido com detalhes menores).`;

  const user = `ESPECIFICAÇÃO ESTRUTURADA (JSON):\n${JSON.stringify(spec)}`;

  return { system, user };
}
