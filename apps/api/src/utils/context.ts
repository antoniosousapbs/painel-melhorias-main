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
