import { getPool, sql } from '../db/connection.js';
import { buildContextoFinal } from '../utils/context.js';
import { llmComplete } from './llm.js';
import 'dotenv/config';

interface ClassificationResult {
  categoria: string;
  tipo: string;
  modulo: string;
  impacto: string;
  confianca: number;
}

async function getPromptTemplate(): Promise<string> {
  const pool = await getPool();
  const result = await pool.request()
    .query(`SELECT Template FROM PromptTemplates WHERE Nome = 'classificacao_padrao' AND Ativo = 1`);
  return result.recordset[0]?.Template || '';
}

async function callLLM(prompt: string): Promise<string> {
  return llmComplete('classificacao', [{ role: 'user', content: prompt }], { temperature: 0.1, jsonMode: true });
}

function parseClassification(raw: string): ClassificationResult | null {
  try {
    // Extract JSON from response (might have extra text around it)
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      categoria: parsed.categoria || 'Info Insuficiente',
      tipo: parsed.tipo || 'UX',
      modulo: parsed.modulo || 'Geral',
      // Prioridade NUNCA vem da classificação automática — é exclusivamente numérica e
      // preenchida manualmente pelo analista (ver updateWorkItem em services/workitem.ts).
      impacto: parsed.impacto || 'Medio',
      confianca: parseFloat(parsed.confianca) || 0.5,
    };
  } catch {
    return null;
  }
}

export async function classifyWorkItem(workItemId: number): Promise<ClassificationResult | null> {
  const pool = await getPool();

  const item = await pool.request()
    .input('id', sql.Int, workItemId)
    .query(`SELECT Id, Title, Description, DiscussionPati FROM WorkItems WHERE Id = @id`);

  if (item.recordset.length === 0) throw new Error(`Chamado #${workItemId} não encontrado`);

  const title = item.recordset[0].Title;
  const rawDesc = item.recordset[0].Description || '';
  const patiComments = item.recordset[0].DiscussionPati || '';
  // Truncate description to ~2000 chars to fit LLM context window
  const description = rawDesc.length > 2000 ? rawDesc.substring(0, 2000) + '...' : rawDesc;

  // Build consolidated context: Description + [PATI] comments (priority order per spec)
  const contextoFinal = buildContextoFinal(description, patiComments);

  const template = await getPromptTemplate();
  if (!template) throw new Error('Prompt template not found');

  // Replace {{DESCRICAO}} with the full contextoFinal so [PATI] comments always feed classification
  const prompt = template
    .replace('{{TITULO}}', title)
    .replace('{{DESCRICAO}}', contextoFinal);
  const rawResponse = await callLLM(prompt);
  const classification = parseClassification(rawResponse);

  if (!classification) {
    console.warn(`Failed to parse classification for work item ${workItemId}`);
    return null;
  }

  // Update DB (Modulo comes from DevOps, not AI; Prioridade nunca é tocada pela IA)
  await pool.request()
    .input('id', sql.Int, workItemId)
    .input('categoria', sql.NVarChar(50), classification.categoria)
    .input('tipo', sql.NVarChar(100), classification.tipo)
    .input('impacto', sql.NVarChar(50), classification.impacto)
    .input('origem', sql.NVarChar(20), 'AI')
    .input('confianca', sql.Decimal(3, 2), classification.confianca)
    .input('now', sql.DateTime2, new Date())
    .query(`
      UPDATE WorkItems SET
        Categoria = @categoria,
        Tipo = @tipo,
        ImpactoOperacao = @impacto,
        ClassificacaoOrigem = @origem,
        ClassificacaoConfianca = @confianca,
        AtualizadoEm = @now
      WHERE Id = @id AND ClassificacaoRevisada = 0
    `);

  return classification;
}

export async function classifyUnclassified(limit: number = 50, filters?: { cliente?: string; categoria?: string; modulo?: string; status?: string }): Promise<number> {
  const pool = await getPool();

  // Get configured projects
  const cfgResult = await pool.request()
    .query(`SELECT Valor FROM Configuracoes WHERE Chave = 'devops_projects'`);
  const rawProjects = cfgResult.recordset[0]?.Valor || '';
  const projects = rawProjects.split(',').map((p: string) => p.trim()).filter(Boolean);

  let whereClause = 'WHERE Categoria IS NULL AND ClassificacaoRevisada = 0';
  const request = pool.request().input('limit', sql.Int, limit);

  if (projects.length > 0) {
    const projConditions = projects.map((_: string, i: number) => `DevOpsAreaPath LIKE @proj${i}`);
    whereClause += ` AND (${projConditions.join(' OR ')})`;
    projects.forEach((p: string, i: number) => {
      request.input(`proj${i}`, sql.NVarChar(200), `${p}%`);
    });
  }

  if (filters?.cliente) {
    whereClause += ' AND ClienteNome = @cliente';
    request.input('cliente', sql.NVarChar(200), filters.cliente);
  }
  if (filters?.modulo) {
    whereClause += ' AND Modulo = @modulo';
    request.input('modulo', sql.NVarChar(100), filters.modulo);
  }
  if (filters?.status) {
    whereClause += ' AND DevOpsState = @status';
    request.input('status', sql.NVarChar(50), filters.status);
  }

  const items = await request.query(`
    SELECT TOP (@limit) Id FROM WorkItems
    ${whereClause}
    ORDER BY ChangedDate DESC
  `);

  let classified = 0;
  for (const row of items.recordset) {
    try {
      const result = await classifyWorkItem(row.Id);
      if (result) classified++;
      // Small delay to not overwhelm Ollama
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`Error classifying ${row.Id}:`, err);
    }
  }

  return classified;
}
