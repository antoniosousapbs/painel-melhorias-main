import { llmComplete } from './llm.js';
import { buildRevisaoPrompt } from '../prompts/spec/revisao.js';
import type { SpecEstruturada } from './spec-structuring.js';

export interface RevisaoResult {
  ok: boolean;
  observacoes: string[];
}

function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

/**
 * Etapa 4 do pipeline (Revisão automática) — roda depois da estruturação, antes da geração
 * do documento. Em v1 é só CONSULTIVA: nunca bloqueia nem corrige automaticamente a
 * especificação, apenas registra observações objetivas pra auditoria/exibição ao usuário
 * (ver seção 14 do briefing de arquitetura — completude/consistência/rastreabilidade/
 * testabilidade/clareza/escopo/relevância pra APF). Loop de correção automática (etapa 5 do
 * pipeline conceitual) fica pra uma iteração futura.
 */
export async function revisarEspecificacao(spec: SpecEstruturada): Promise<RevisaoResult> {
  const { system, user } = buildRevisaoPrompt(spec);
  try {
    const raw = await llmComplete('spec_revisao', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { jsonMode: true, maxTokens: 4000 });
    const parsed = JSON.parse(stripJsonFences(raw));
    return { ok: parsed.ok !== false, observacoes: Array.isArray(parsed.observacoes) ? parsed.observacoes : [] };
  } catch (err) {
    // Falha na revisão NÃO deve impedir a geração do documento (é uma etapa consultiva) —
    // só registra que a revisão automática não pôde ser concluída.
    console.warn('⚠️  Revisão automática da especificação falhou (não bloqueante):', (err as Error).message);
    return { ok: true, observacoes: ['Revisão automática não pôde ser concluída (erro técnico) — revise manualmente.'] };
  }
}
