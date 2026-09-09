/**
 * Shared utility: consolidated context (contextoFinal) for all PATi AI modules.
 *
 * Priority order (per specification):
 *   1. Description  — original description from DevOps Support Case
 *   2. [PATI] comments — discussion comments tagged [PATI] synced from DevOps
 *   3. Interview history — Q&A from the APF interrogatório session
 *
 * ALL AI modules (classification, APF, spec, refinement) must call
 * buildContextoFinal and use the result as their context input.
 */

export interface HistoryEntry {
  role: string;
  content: string;
}

/**
 * Build the consolidated context string for AI operations.
 */
export function buildContextoFinal(
  description: string | null | undefined,
  patiComments: string | null | undefined,
  interviewHistory?: HistoryEntry[],
): string {
  const parts: string[] = [];

  if (description?.trim()) {
    parts.push(`=== DESCRIÇÃO ===\n${description.trim()}`);
  }

  if (patiComments?.trim()) {
    parts.push(`=== COMENTÁRIOS [PATI] (refinamentos registrados no DevOps) ===\n${patiComments.trim()}`);
  }

  if (interviewHistory && interviewHistory.length > 0) {
    const qa = interviewHistory
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'assistant' ? 'PATi' : 'Analista'}: ${m.content.slice(0, 800)}`)
      .join('\n');
    if (qa.trim()) {
      parts.push(`=== INTERROGATÓRIO APF (respostas do analista) ===\n${qa}`);
    }
  }

  return parts.join('\n\n') || '(sem informações disponíveis)';
}

/**
 * Convert an interview history array to plain text for use as extraContext.
 */
export function interviewHistoryToText(
  history: HistoryEntry[] | undefined,
): string {
  if (!history || history.length === 0) return '';
  return history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'PATi' : 'Analista'}: ${m.content.slice(0, 800)}`)
    .join('\n');
}

/**
 * Trunca um texto composto por blocos separados por `separator`, mantendo os blocos MAIS
 * RECENTES (do fim para o começo) até o orçamento de caracteres — ao contrário de um simples
 * `.slice(0, n)`, que descarta justamente a informação mais nova (normalmente a mais
 * atualizada/confirmada, ex.: o último comentário [PATI] ou a última entrevista) quando o
 * texto total excede o orçamento. Usado para [PATI] comments (concatenados cronologicamente,
 * mais antigo primeiro) e outros textos onde "o que veio depois" tende a suplantar "o que veio
 * antes" em vez de só complementar.
 */
export function keepMostRecentBlocks(text: string, separator: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  const blocks = text.split(separator);
  const kept: string[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (total + block.length > maxChars && kept.length > 0) break;
    kept.unshift(block);
    total += block.length + separator.length;
  }
  // Nem o bloco mais recente sozinho cabe no orçamento — mantém o FINAL dele (a conclusão de
  // um comentário/transcrição longa tende a estar no fim, não no começo).
  if (kept.length === 1 && kept[0].length > maxChars) return kept[0].slice(-maxChars);
  return kept.join(separator);
}

