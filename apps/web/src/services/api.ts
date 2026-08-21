import { authFetch } from '../auth/authFetch';

// Lê URL da API do env-config.js (runtime) ou variável do Vite (build)
export const API_BASE = (window as any)._env_?.VITE_API_BASE || import.meta.env.VITE_API_BASE || '/api';

export async function fetchWorkItems(params: Record<string, string | number>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '' && v !== null) query.set(k, String(v));
  });
  const res = await authFetch(`${API_BASE}/workitems?${query}`);
  if (!res.ok) throw new Error('Failed to fetch work items');
  return res.json();
}

export async function fetchWorkItem(id: number) {
  const res = await authFetch(`${API_BASE}/workitems/${id}`);
  if (!res.ok) throw new Error('Failed to fetch work item');
  return res.json();
}

export async function updateWorkItem(id: number, data: Record<string, any>) {
  const res = await authFetch(`${API_BASE}/workitems/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || 'Failed to update work item');
  }
  return res.json();
}

export async function fetchKpis(filters?: { cliente?: string; categoria?: string; modulo?: string; status?: string; caseType?: string; projeto?: string; responsavel?: string; apf?: 'com' | 'sem' }) {
  const params = new URLSearchParams();
  if (filters?.cliente) params.set('cliente', filters.cliente);
  if (filters?.categoria) params.set('categoria', filters.categoria);
  if (filters?.modulo) params.set('modulo', filters.modulo);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.caseType) params.set('caseType', filters.caseType);
  if (filters?.projeto) params.set('projeto', filters.projeto);
  if (filters?.responsavel) params.set('responsavel', filters.responsavel);
  if (filters?.apf) params.set('apf', filters.apf);
  const qs = params.toString();
  const res = await authFetch(`${API_BASE}/workitems/kpis${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error('Failed to fetch KPIs');
  return res.json();
}

export async function fetchFilters() {
  const res = await authFetch(`${API_BASE}/workitems/filters`);
  if (!res.ok) throw new Error('Failed to fetch filters');
  return res.json();
}

export async function fetchCharts(filters?: { cliente?: string; categoria?: string; modulo?: string; prioridade?: string; status?: string; caseType?: string; projeto?: string; responsavel?: string; apf?: 'com' | 'sem' }) {
  const params = new URLSearchParams();
  if (filters?.cliente) params.set('cliente', filters.cliente);
  if (filters?.categoria) params.set('categoria', filters.categoria);
  if (filters?.modulo) params.set('modulo', filters.modulo);
  if (filters?.prioridade) params.set('prioridade', filters.prioridade);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.caseType) params.set('caseType', filters.caseType);
  if (filters?.projeto) params.set('projeto', filters.projeto);
  if (filters?.responsavel) params.set('responsavel', filters.responsavel);
  if (filters?.apf) params.set('apf', filters.apf);
  const qs = params.toString();
  const res = await authFetch(`${API_BASE}/workitems/charts${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error('Failed to fetch charts');
  return res.json();
}

export async function fetchNextPriority(cliente: string): Promise<number> {
  const res = await authFetch(`${API_BASE}/workitems/next-priority?cliente=${encodeURIComponent(cliente)}`);
  if (!res.ok) throw new Error('Failed to fetch next priority');
  const data = await res.json();
  return data.next;
}

export async function triggerSync() {
  const res = await authFetch(`${API_BASE}/sync/trigger`, { method: 'POST' });
  if (!res.ok) throw new Error('Sync failed');
  return res.json();
}

export async function triggerClassify(limit?: number, filters?: { cliente?: string; modulo?: string; status?: string }) {
  const res = await authFetch(`${API_BASE}/classify/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: limit || 50, filters }),
  });
  if (!res.ok) throw new Error('Classification failed');
  return res.json();
}

export async function classifyOne(id: number) {
  const res = await authFetch(`${API_BASE}/classify/${id}`, { method: 'POST' });
  if (!res.ok) throw new Error('Classification failed');
  return res.json();
}

export async function fetchConfig() {
  const res = await authFetch(`${API_BASE}/config`);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function updateConfig(chave: string, valor: string) {
  const res = await authFetch(`${API_BASE}/config/${chave}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor }),
  });
  if (!res.ok) throw new Error('Failed to update config');
  return res.json();
}

// â”€â”€â”€ Document Generation â”€â”€â”€
export async function generateApfDoc(id: number) {
  const res = await authFetch(`${API_BASE}/documents/${id}/generate-apf`, { method: 'POST' });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Falha ao gerar APF'); }
  return res.json();
}

export async function generateSpecDoc(id: number) {
  const res = await authFetch(`${API_BASE}/documents/${id}/generate-spec`, { method: 'POST' });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Falha ao gerar Spec'); }
  return res.json();
}

// Novo pipeline (template Word) — coexiste com generateSpecDoc() acima, não substitui.
export async function generateSpecDocxDoc(id: number) {
  const res = await authFetch(`${API_BASE}/documents/${id}/generate-spec-docx`, { method: 'POST' });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Falha ao gerar Especificação'); }
  return res.json();
}

export function getDocDownloadUrl(id: number, tipo: 'APF' | 'SPEC' | 'APF_EXCEL' | 'SPEC_DOCX') {
  return `${API_BASE}/documents/${id}/download/${tipo}`;
}

/**
 * Baixa um arquivo autenticado (o navegador não envia o header Authorization em
 * navegações normais de <a href>, então o download precisa passar pelo authFetch).
 * Busca o conteúdo via fetch autenticado, extrai o nome do arquivo do header
 * Content-Disposition (com fallback) e simula o clique num link temporário.
 */
export async function downloadDocument(url: string, fallbackFilename: string) {
  const res = await authFetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error || 'Falha ao baixar documento');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function fetchDocStatus(ids: number[]): Promise<Record<number, { apf: boolean; apfExcel: boolean; spec: boolean; specDocx: boolean }>> {
  if (ids.length === 0) return {};
  const res = await authFetch(`${API_BASE}/documents/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) return {};
  return res.json();
}

export async function fetchApfParams() {
  const res = await authFetch(`${API_BASE}/documents/apf-params`);
  if (!res.ok) throw new Error('Failed to fetch APF params');
  return res.json();
}

export async function updateApfParams(data: Record<string, number>) {
  const res = await authFetch(`${API_BASE}/documents/apf-params`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update APF params');
  return res.json();
}

// ─── Diretrizes de Contagem APF por Team Project ───
export interface ApfDiretriz {
  ProjectCode: string;
  Diretriz: string;
  Ativo: boolean;
  AtualizadoEm?: string;
}

export async function fetchApfDiretrizes(): Promise<ApfDiretriz[]> {
  const res = await authFetch(`${API_BASE}/documents/apf-diretrizes`);
  if (!res.ok) throw new Error('Failed to fetch APF diretrizes');
  return res.json();
}

export async function updateApfDiretriz(projectCode: string, diretriz: string): Promise<ApfDiretriz[]> {
  const res = await authFetch(`${API_BASE}/documents/apf-diretrizes/${encodeURIComponent(projectCode)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diretriz }),
  });
  if (!res.ok) throw new Error('Failed to update APF diretriz');
  return res.json();
}

// ─── Modelos de IA (providers de LLM configuráveis) ───
export type LlmKind = 'openai-compatible' | 'azure-ai-foundry';
export type LlmFinalidade = 'chat' | 'classificacao' | 'apf_geracao' | 'apf_refinamento' | 'spec_geracao' | 'spec_estruturacao' | 'spec_revisao';

export interface LlmProvider {
  Id: number;
  Nome: string;
  Kind: LlmKind;
  ApiUrl: string;
  ModelName: string;
  ApiVersion?: string | null;
  Ativo: boolean;
  ApiKeyMasked?: string;
  AtualizadoEm?: string;
}

export interface LlmUsoConfigItem {
  Finalidade: LlmFinalidade;
  ProviderId: number | null;
  FallbackProviderId: number | null;
  ProviderNome?: string | null;
  FallbackProviderNome?: string | null;
}

export async function fetchLlmProviders(): Promise<LlmProvider[]> {
  const res = await authFetch(`${API_BASE}/llm-providers`);
  if (!res.ok) throw new Error('Failed to fetch LLM providers');
  return res.json();
}

export async function addLlmProvider(data: { nome: string; kind: LlmKind; apiUrl: string; apiKey: string; modelName: string; apiVersion?: string; ativo?: boolean }): Promise<LlmProvider[]> {
  const res = await authFetch(`${API_BASE}/llm-providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to add LLM provider');
  return res.json();
}

export async function updateLlmProvider(id: number, data: Partial<{ nome: string; kind: LlmKind; apiUrl: string; apiKey: string; modelName: string; apiVersion: string; ativo: boolean }>): Promise<LlmProvider[]> {
  const res = await authFetch(`${API_BASE}/llm-providers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update LLM provider');
  return res.json();
}

export async function deleteLlmProvider(id: number): Promise<LlmProvider[]> {
  const res = await authFetch(`${API_BASE}/llm-providers/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete LLM provider');
  return res.json();
}

export async function testLlmProvider(data: { id?: number; kind?: LlmKind; apiUrl?: string; apiKey?: string; modelName?: string }): Promise<{ ok: boolean; message: string }> {
  const res = await authFetch(`${API_BASE}/llm-providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function fetchLlmUsoConfig(): Promise<LlmUsoConfigItem[]> {
  const res = await authFetch(`${API_BASE}/llm-uso`);
  if (!res.ok) throw new Error('Failed to fetch LLM uso config');
  return res.json();
}

export async function updateLlmUsoConfig(finalidade: LlmFinalidade, providerId: number | null, fallbackProviderId: number | null): Promise<LlmUsoConfigItem[]> {
  const res = await authFetch(`${API_BASE}/llm-uso/${finalidade}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, fallbackProviderId }),
  });
  if (!res.ok) throw new Error('Failed to update LLM uso config');
  return res.json();
}

// Label pública (não-sensível) do provider atual de uma finalidade — usada só para exibição
// (ex: legenda "Agente de suporte IA · <provider>" no chat da PATi). Sem restrição de Admin.
export async function fetchLlmCurrentProviderLabel(finalidade: LlmFinalidade): Promise<string | null> {
  const res = await authFetch(`${API_BASE}/llm-current/${finalidade}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.nome || null;
}

export async function fetchAudit(workItemId: number) {
  const res = await authFetch(`${API_BASE}/audit/${workItemId}`);
  if (!res.ok) throw new Error('Failed to fetch audit');
  return res.json();
}

export async function fetchStats() {
  const res = await authFetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}

export async function fetchPrompt() {
  const res = await authFetch(`${API_BASE}/prompt`);
  if (!res.ok) throw new Error('Failed to fetch prompt');
  return res.json();
}

export async function updatePrompt(template: string, ativo: boolean) {
  const res = await authFetch(`${API_BASE}/prompt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template, ativo }),
  });
  if (!res.ok) throw new Error('Failed to update prompt');
  return res.json();
}

// â”€â”€â”€ Knowledge Base â”€â”€â”€
export async function fetchKnowledge() {
  const res = await authFetch(`${API_BASE}/documents/knowledge`);
  if (!res.ok) throw new Error('Failed to fetch knowledge');
  return res.json();
}

export async function addKnowledgeEntry(data: { categoria: string; titulo: string; conteudo: string; tags?: string }) {
  const res = await authFetch(`${API_BASE}/documents/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to add knowledge');
  return res.json();
}

export async function updateKnowledgeEntry(id: number, data: { titulo?: string; conteudo?: string; tags?: string; ativo?: boolean }) {
  const res = await authFetch(`${API_BASE}/documents/knowledge/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update knowledge');
  return res.json();
}

export async function deleteKnowledgeEntry(id: number) {
  const res = await authFetch(`${API_BASE}/documents/knowledge/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete knowledge');
  return res.json();
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export async function fetchAuditLog(params: {
  page?: number; size?: number; tipo?: string; userId?: string; workItemId?: number; from?: string; to?: string;
}) {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.size) q.set('size', String(params.size));
  if (params.tipo) q.set('tipo', params.tipo);
  if (params.userId) q.set('userId', params.userId);
  if (params.workItemId) q.set('workItemId', String(params.workItemId));
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  const res = await authFetch(`${API_BASE}/documents/audit?${q}`);
  if (!res.ok) throw new Error('Failed to fetch audit log');
  return res.json();
}

export async function fetchDocVersions(workItemId: number) {
  const res = await authFetch(`${API_BASE}/documents/${workItemId}/versions`);
  if (!res.ok) throw new Error('Failed to fetch versions');
  return res.json();
}

// ── Identidade / Papéis (RBAC) ─────────────────────────────────────────────────

export interface CurrentUser {
  oid: string | null;
  email: string | null;
  nome: string | null;
  role: 'Admin' | 'Operador' | null;
  hasAccess: boolean;
  projects: string[];
}

export async function fetchMe(): Promise<CurrentUser> {
  const res = await authFetch(`${API_BASE}/me`);
  if (!res.ok) throw new Error('Failed to fetch current user');
  return res.json();
}

export interface UserRoleEntry {
  Id: number;
  AadObjectId: string | null;
  Email: string;
  Nome: string | null;
  Role: 'Admin' | 'Operador';
  Projects: string[];
  CriadoEm: string;
  AtualizadoEm: string | null;
}

export async function fetchUsers(): Promise<UserRoleEntry[]> {
  const res = await authFetch(`${API_BASE}/users`);
  if (!res.ok) throw new Error('Failed to fetch users');
  return res.json();
}

export async function addUser(email: string, role: 'Admin' | 'Operador', projects?: string[]) {
  const res = await authFetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role, projects }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to add user');
  return res.json();
}

export async function updateUserRole(id: number, role: 'Admin' | 'Operador', projects?: string[]) {
  const res = await authFetch(`${API_BASE}/users/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, projects }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to update user');
  return res.json();
}

export async function deleteUser(id: number) {
  const res = await authFetch(`${API_BASE}/users/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to delete user');
  return res.json();
}

// ── Projetos DevOps ────────────────────────────────────────────────────────────

export async function fetchProjects(): Promise<string[]> {
  const res = await authFetch(`${API_BASE}/projects`);
  if (!res.ok) throw new Error('Failed to fetch projects');
  return res.json();
}

// ── Sincronização ──────────────────────────────────────────────────────────────

export interface SyncStatus {
  lastSync: string | null;
  isSyncing: boolean;
}

export async function fetchSyncLast(): Promise<SyncStatus> {
  const res = await authFetch(`${API_BASE}/sync/last`);
  if (!res.ok) throw new Error('Failed to fetch sync status');
  return res.json();
}

export async function cancelSync(): Promise<{ success: boolean; wasSyncing: boolean }> {
  const res = await authFetch(`${API_BASE}/sync/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to cancel sync');
  return res.json();
}

// ── Interview Sessions ─────────────────────────────────────────────────────────

export async function registerInterviewSession(sessionId: string, workItemId: number, tipo: string, userName: string, userEmail: string) {
  const res = await authFetch(`${API_BASE}/documents/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, workItemId, tipo, userName, userEmail }),
  });
  if (!res.ok) return { sessionId, conflicts: [] };
  return res.json() as Promise<{ sessionId: string; conflicts: { UserName: string; UserEmail: string; StartedAt: string }[] }>;
}

export async function releaseInterviewSession(sessionId: string) {
  await authFetch(`${API_BASE}/documents/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function heartbeatInterviewSession(sessionId: string) {
  await authFetch(`${API_BASE}/documents/sessions/${sessionId}`, { method: 'PUT' });
}

