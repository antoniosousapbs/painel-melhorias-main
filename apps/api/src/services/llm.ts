import { getPool, sql } from '../db/connection.js';
import { encryptSecret, decryptSecret, maskSecret } from '../utils/crypto.js';
import 'dotenv/config';

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

interface LlmProviderInternal extends LlmProvider {
  ApiKeyEncrypted: string;
}

export interface LlmUsoConfigItem {
  Finalidade: LlmFinalidade;
  ProviderId: number | null;
  FallbackProviderId: number | null;
  ProviderNome?: string | null;
  FallbackProviderNome?: string | null;
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

type Msg = { role: string; content: string };

// ─── Cache leve em memória (evita bater no SQL a cada mensagem de chat) ───
const CACHE_TTL_MS = 60_000;
let usoCache: { data: LlmUsoConfigItem[]; at: number } | null = null;
let providersCache: { data: LlmProviderInternal[]; at: number } | null = null;

function invalidateCache() {
  usoCache = null;
  providersCache = null;
}

// ─── CRUD de Providers ───
async function loadProviders(): Promise<LlmProviderInternal[]> {
  if (providersCache && Date.now() - providersCache.at < CACHE_TTL_MS) return providersCache.data;
  const pool = await getPool();
  const r = await pool.request().query(`SELECT Id, Nome, Kind, ApiUrl, ApiKeyEncrypted, ModelName, ApiVersion, Ativo, AtualizadoEm FROM LlmProviders ORDER BY Nome`);
  const data = r.recordset as LlmProviderInternal[];
  providersCache = { data, at: Date.now() };
  return data;
}

export async function getProviders(): Promise<LlmProvider[]> {
  const providers = await loadProviders();
  return providers.map(p => {
    let apiKeyMasked: string | undefined;
    if (p.ApiKeyEncrypted) {
      try {
        apiKeyMasked = maskSecret(decryptSecret(p.ApiKeyEncrypted));
      } catch {
        // Chave gravada com uma CONFIG_ENCRYPTION_KEY/JWT_SECRET diferente do atual — não
        // derruba a listagem inteira, só sinaliza este provider como precisando de reconfiguração.
        apiKeyMasked = '⚠️ chave ilegível — reconfigure';
      }
    }
    return {
      Id: p.Id, Nome: p.Nome, Kind: p.Kind, ApiUrl: p.ApiUrl, ModelName: p.ModelName, ApiVersion: p.ApiVersion,
      Ativo: p.Ativo, AtualizadoEm: p.AtualizadoEm,
      ApiKeyMasked: apiKeyMasked,
    };
  });
}

export async function addProvider(data: { nome: string; kind: LlmKind; apiUrl: string; apiKey: string; modelName: string; apiVersion?: string; ativo?: boolean }): Promise<void> {
  const pool = await getPool();
  await pool.request()
    .input('nome', sql.NVarChar(100), data.nome)
    .input('kind', sql.NVarChar(30), data.kind)
    .input('apiUrl', sql.NVarChar(500), data.apiUrl)
    .input('apiKey', sql.NVarChar(1000), encryptSecret(data.apiKey))
    .input('modelName', sql.NVarChar(100), data.modelName)
    .input('apiVersion', sql.NVarChar(30), data.apiVersion || null)
    .input('ativo', sql.Bit, data.ativo ?? true)
    .query(`INSERT INTO LlmProviders (Nome, Kind, ApiUrl, ApiKeyEncrypted, ModelName, ApiVersion, Ativo) VALUES (@nome, @kind, @apiUrl, @apiKey, @modelName, @apiVersion, @ativo)`);
  invalidateCache();
}

export async function updateProvider(id: number, data: { nome?: string; kind?: LlmKind; apiUrl?: string; apiKey?: string; modelName?: string; apiVersion?: string; ativo?: boolean }): Promise<void> {
  const pool = await getPool();
  const sets: string[] = [];
  const req = pool.request().input('id', sql.Int, id);
  if (data.nome !== undefined) { sets.push('Nome = @nome'); req.input('nome', sql.NVarChar(100), data.nome); }
  if (data.kind !== undefined) { sets.push('Kind = @kind'); req.input('kind', sql.NVarChar(30), data.kind); }
  if (data.apiUrl !== undefined) { sets.push('ApiUrl = @apiUrl'); req.input('apiUrl', sql.NVarChar(500), data.apiUrl); }
  if (data.apiKey !== undefined && data.apiKey.trim()) { sets.push('ApiKeyEncrypted = @apiKey'); req.input('apiKey', sql.NVarChar(1000), encryptSecret(data.apiKey)); }
  if (data.modelName !== undefined) { sets.push('ModelName = @modelName'); req.input('modelName', sql.NVarChar(100), data.modelName); }
  if (data.apiVersion !== undefined) { sets.push('ApiVersion = @apiVersion'); req.input('apiVersion', sql.NVarChar(30), data.apiVersion || null); }
  if (data.ativo !== undefined) { sets.push('Ativo = @ativo'); req.input('ativo', sql.Bit, data.ativo); }
  if (sets.length === 0) return;
  sets.push('AtualizadoEm = GETDATE()');
  await req.query(`UPDATE LlmProviders SET ${sets.join(', ')} WHERE Id = @id`);
  invalidateCache();
}

export async function deleteProvider(id: number): Promise<void> {
  const pool = await getPool();
  await pool.request().input('id', sql.Int, id).query(`DELETE FROM LlmUsoConfig WHERE ProviderId = @id OR FallbackProviderId = @id`);
  await pool.request().input('id', sql.Int, id).query(`DELETE FROM LlmProviders WHERE Id = @id`);
  invalidateCache();
}

/** Testa a conexão de um provider (por Id já salvo, ou por dados avulsos ainda não salvos). */
export async function testProvider(input: { id?: number; kind?: LlmKind; apiUrl?: string; apiKey?: string; modelName?: string; apiVersion?: string }): Promise<{ ok: boolean; message: string }> {
  let provider: { kind: LlmKind; apiUrl: string; apiKey: string; modelName: string; apiVersion?: string | null };
  if (input.id) {
    const providers = await loadProviders();
    const p = providers.find(x => x.Id === input.id);
    if (!p) return { ok: false, message: 'Provider não encontrado' };
    let apiKey: string;
    try {
      apiKey = decryptSecret(p.ApiKeyEncrypted);
    } catch {
      return { ok: false, message: 'Chave de API ilegível (foi salva com uma CONFIG_ENCRYPTION_KEY diferente da atual) — edite o provider e informe a chave novamente.' };
    }
    provider = { kind: p.Kind, apiUrl: p.ApiUrl, apiKey, modelName: p.ModelName, apiVersion: p.ApiVersion };
  } else {
    if (!input.kind || !input.apiUrl || !input.apiKey || !input.modelName) return { ok: false, message: 'Dados incompletos para teste' };
    provider = { kind: input.kind, apiUrl: input.apiUrl, apiKey: input.apiKey, modelName: input.modelName, apiVersion: input.apiVersion };
  }
  try {
    const content = await callProvider(provider, [{ role: 'user', content: 'oi' }], { maxTokens: 8 });
    return { ok: true, message: content ? `Respondeu: "${content.slice(0, 60)}"` : 'Respondeu (vazio)' };
  } catch (err: any) {
    return { ok: false, message: err.message };
  }
}

// ─── Atribuição por finalidade ───
export async function getUsoConfig(): Promise<LlmUsoConfigItem[]> {
  if (usoCache && Date.now() - usoCache.at < CACHE_TTL_MS) return usoCache.data;
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT u.Finalidade, u.ProviderId, u.FallbackProviderId, p1.Nome AS ProviderNome, p2.Nome AS FallbackProviderNome
    FROM LlmUsoConfig u
    LEFT JOIN LlmProviders p1 ON p1.Id = u.ProviderId
    LEFT JOIN LlmProviders p2 ON p2.Id = u.FallbackProviderId
  `);
  const data = r.recordset as LlmUsoConfigItem[];
  usoCache = { data, at: Date.now() };
  return data;
}

export async function setUsoConfig(finalidade: LlmFinalidade, providerId: number | null, fallbackProviderId: number | null): Promise<void> {
  const pool = await getPool();
  await pool.request()
    .input('finalidade', sql.NVarChar(50), finalidade)
    .input('providerId', sql.Int, providerId)
    .input('fallbackId', sql.Int, fallbackProviderId)
    .query(`
      MERGE LlmUsoConfig AS target
      USING (SELECT @finalidade AS Finalidade) AS src ON target.Finalidade = src.Finalidade
      WHEN MATCHED THEN UPDATE SET ProviderId = @providerId, FallbackProviderId = @fallbackId
      WHEN NOT MATCHED THEN INSERT (Finalidade, ProviderId, FallbackProviderId) VALUES (@finalidade, @providerId, @fallbackId);
    `);
  invalidateCache();
}

// ─── Resolução da cadeia de providers para uma finalidade ───
async function resolveChain(finalidade: LlmFinalidade): Promise<LlmProviderInternal[]> {
  const [uso, providers] = await Promise.all([getUsoConfig(), loadProviders()]);
  const cfg = uso.find(u => u.Finalidade === finalidade);
  const chain: LlmProviderInternal[] = [];
  if (cfg?.ProviderId) {
    const p = providers.find(x => x.Id === cfg.ProviderId && x.Ativo);
    if (p) chain.push(p);
  }
  if (cfg?.FallbackProviderId) {
    const p = providers.find(x => x.Id === cfg.FallbackProviderId && x.Ativo);
    if (p) chain.push(p);
  }
  return chain;
}

// ─── Adaptadores por Kind (monta request/parseia response de cada formato) ───
const DEFAULT_AZURE_API_VERSION = '2024-05-01-preview';

/** Endpoint de inferência de modelos do Azure AI Foundry vive na raiz do recurso
 * (`{origin}/models/chat/completions`), não sob `/api/projects/<project>` — esse
 * caminho é o de gerenciamento do projeto (SDK azure-ai-projects), não o de inferência. */
function foundryChatUrl(apiUrl: string, apiVersion?: string | null): string {
  const origin = new URL(apiUrl).origin;
  return `${origin}/models/chat/completions?api-version=${apiVersion || DEFAULT_AZURE_API_VERSION}`;
}

// ─── Modelos de raciocínio (o1/o3/o4/gpt-5.x/kimi-k2) ──────────────────────────────
// Esses modelos gastam tokens "invisíveis" de raciocínio dentro do MESMO orçamento de
// max_completion_tokens (doc oficial: "reserve at least 25,000 tokens for reasoning and
// output" para tarefas abertas). Nossas tarefas são bem delimitadas (uma pergunta de
// entrevista, um JSON de contagem APF), então usamos pisos menores, calibrados por
// finalidade — sem isso, o valor hardcoded anterior (500-1024) deixava o modelo gastar
// tudo em raciocínio interno e devolver resposta vazia/truncada, ou apenas repetir a
// pergunta no turno seguinte.
// "kimi" (Kimi K2, Moonshot AI) também raciocína internamente como o1/o3/gpt-5.x — faltava
// aqui, então caia no piso baixo (maxTokens padrão) e sempre devolvia resposta vazia com
// finish_reason=length em entradas grandes (ex.: chamado #318120, entrevista longa).
const REASONING_MODEL_RE = /^(o1|o3|o4|gpt-5|kimi)/i;
function isReasoningModel(modelName: string): boolean {
  return REASONING_MODEL_RE.test(modelName);
}

const REASONING_MIN_TOKENS: Record<LlmFinalidade, number> = {
  chat: 2000,
  classificacao: 1500,
  // Subido de 6000 pra 16000 após falha real em produção (chamado #318120): tanto o
  // provider principal (GPT-5.4) quanto o fallback (Kimi K2.6 — que só passou a ser
  // reconhecido como modelo de raciocínio nesta mesma correção) esgotaram 6000 tokens em
  // raciocínio interno numa entrevista longa/complexa e devolveram resposta vazia
  // (finish_reason=length), com a geração de APF falhando por completo (sem fallback
  // restante). Mesmo padrão já usado em spec_estruturacao (6000 → 16000 → 24000).
  apf_geracao: 16000,
  apf_refinamento: 16000,
  spec_geracao: 6000,
  // 'high' reasoning_effort (ver REASONING_EFFORT) consome MUITO mais tokens "invisíveis"
  // de raciocínio dentro do mesmo orçamento — 6000 (suficiente em 'medium') fazia o modelo
  // gastar tudo em raciocínio e devolver resposta vazia (JSON.parse: "Unexpected end of
  // JSON input"), regressão real detectada ao gerar a especificação do chamado #326204.
  // Subido de 16000 pra 24000 após NOVA ocorrência em produção (chamado com contexto maior
  // esgotou o piso anterior de novo) — só aumenta o TETO de tokens de saída, não o esforço
  // de raciocínio (`reasoning_effort` continua 'medium'), então não reintroduz o problema
  // de timeout que motivou reverter de 'high' pra 'medium'.
  spec_estruturacao: 24000,
  spec_revisao: 4000,
};

// Efforts baixos priorizam latência (entrevista interativa, chat); geração/refinamento de
// APF e estruturação da Especificação usam esforço médio — 'high' foi testado em produção
// pro spec_estruturacao e chegou a estourar 150s de timeout no GPT-5.4 (chamado #326204);
// revertido pra 'medium' por confiabilidade. A riqueza de conteúdo adicional é buscada via
// instruções de prompt (ver prompts/spec/estruturacao.ts), não via esforço de raciocínio.
const REASONING_EFFORT: Record<LlmFinalidade, 'low' | 'medium' | 'high'> = {
  chat: 'low',
  classificacao: 'low',
  apf_geracao: 'medium',
  apf_refinamento: 'medium',
  spec_geracao: 'medium',
  spec_estruturacao: 'medium',
  spec_revisao: 'low',
};

// Timeout por finalidade — evita que uma chamada travada segure a conexão além do timeout
// do reverse proxy em produção (IIS ARR), permitindo que o fallback de provider entre em
// ação a tempo em vez de deixar a conexão do usuário cair primeiro (causa raiz do erro
// "Erro ao conectar com o serviço de geração de documentos").
const TIMEOUT_MS: Record<LlmFinalidade, number> = {
  chat: 30_000,
  classificacao: 30_000,
  apf_geracao: 120_000, // subido de 90s pra 120s junto com o piso de tokens (ver REASONING_MIN_TOKENS)
  apf_refinamento: 120_000,
  spec_geracao: 90_000,
  spec_estruturacao: 150_000, // 'high' reasoning_effort custa mais tempo de parede que 'medium'
  spec_revisao: 60_000,
};

function buildRequestBody(
  provider: { kind: LlmKind; modelName: string },
  messages: Msg[],
  opts: { maxTokens?: number; temperature?: number; jsonMode?: boolean; finalidade: LlmFinalidade; stream: boolean },
): string {
  const isFoundry = provider.kind === 'azure-ai-foundry';
  const reasoning = isFoundry && isReasoningModel(provider.modelName);
  const maxTokens = reasoning
    ? Math.max(opts.maxTokens ?? 0, REASONING_MIN_TOKENS[opts.finalidade])
    : (opts.maxTokens ?? 1024);
  const responseFormat = opts.jsonMode ? { response_format: { type: 'json_object' } } : {};
  // Modelos mais novos (ex: gpt-5.x) exigem max_completion_tokens; max_tokens está sendo
  // descontinuado. Providers openai-compatible (Groq etc.) ainda usam max_tokens.
  const tokenParam = isFoundry ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const reasoningParam = reasoning ? { reasoning_effort: REASONING_EFFORT[opts.finalidade] } : {};
  // Modelos de raciocínio (gpt-5.x, o1/o3/o4) só aceitam o temperature padrão (1) — enviar
  // qualquer outro valor derruba a chamada com HTTP 400 "Unsupported value: 'temperature'".
  const temperatureParam = reasoning ? {} : { temperature: opts.temperature ?? 0.4 };
  return JSON.stringify({
    model: provider.modelName, messages, stream: opts.stream,
    ...temperatureParam, ...tokenParam, ...reasoningParam, ...responseFormat,
  });
}

async function fetchWithTimeout(url: string, init: { method: string; headers: Record<string, string>; body: string }, modelName: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new Error(isTimeout ? `${modelName}: timeout após ${timeoutMs / 1000}s sem resposta` : `${modelName}: ${err.message}`);
  }
}

async function callProvider(
  provider: { kind: LlmKind; apiUrl: string; apiKey: string; modelName: string; apiVersion?: string | null },
  messages: Msg[],
  opts?: { maxTokens?: number; temperature?: number; jsonMode?: boolean; finalidade?: LlmFinalidade }
): Promise<string> {
  const finalidade = opts?.finalidade ?? 'chat';
  const isFoundry = provider.kind === 'azure-ai-foundry';
  const url = isFoundry ? foundryChatUrl(provider.apiUrl, provider.apiVersion) : provider.apiUrl;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isFoundry) headers['api-key'] = provider.apiKey;
  else headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const body = buildRequestBody(provider, messages, { ...opts, finalidade, stream: false });
  const timeoutMs = TIMEOUT_MS[finalidade];

  const MAX_RETRIES = 4;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body }, provider.modelName, timeoutMs);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0') || Math.pow(2, attempt + 1);
      console.warn(`⏳ ${provider.modelName} rate limit (429) — aguardando ${retryAfter}s (tentativa ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`${provider.modelName} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      throw lastErr;
    }
    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    // Resposta vazia com HTTP 200 (ex.: modelo de raciocínio gastou todo o orçamento de
    // tokens em raciocínio interno, finish_reason="length") NÃO pode ser tratada como
    // sucesso — sem isso, o fallback pro próximo provider da cadeia (ver llmComplete)
    // nunca era acionado, e o erro só aparecia bem mais tarde (ex.: "estruturação da
    // especificação" recebendo string vazia). Lançar aqui aciona o fallback já existente.
    if (!content.trim()) {
      const finishReason = data.choices?.[0]?.finish_reason;
      throw new Error(`${provider.modelName}: resposta vazia (finish_reason=${finishReason || 'desconhecido'}${finishReason === 'length' ? ' — orçamento de tokens esgotado, provável raciocínio interno excessivo' : ''})`);
    }
    return content;
  }
  throw lastErr || new Error(`${provider.modelName}: excedeu tentativas por rate limit (429)`);
}

async function* streamProvider(
  provider: { kind: LlmKind; apiUrl: string; apiKey: string; modelName: string; apiVersion?: string | null },
  messages: Msg[],
  opts?: { maxTokens?: number; temperature?: number; finalidade?: LlmFinalidade }
): AsyncGenerator<string> {
  const finalidade = opts?.finalidade ?? 'chat';
  const isFoundry = provider.kind === 'azure-ai-foundry';
  const url = isFoundry ? foundryChatUrl(provider.apiUrl, provider.apiVersion) : provider.apiUrl;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isFoundry) headers['api-key'] = provider.apiKey;
  else headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const body = buildRequestBody(provider, messages, { ...opts, finalidade, stream: true });
  const timeoutMs = TIMEOUT_MS[finalidade];

  const res = await fetchWithTimeout(url, { method: 'POST', headers, body }, provider.modelName, timeoutMs);
  if (!res.ok) throw new Error(`${provider.modelName} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch { /* skip malformed SSE line */ }
    }
  }
}

async function callOllama(messages: Msg[]): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json() as any;
  const content = data.message?.content || '';
  // Mesma proteção do callProvider — resposta vazia não pode virar sucesso silencioso,
  // senão o erro real (ex.: dos providers anteriores da cadeia) fica mascarado.
  if (!content.trim()) throw new Error('Ollama: resposta vazia');
  return content;
}

async function* streamOllama(messages: Msg[]): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const content = parsed.message?.content;
        if (content) yield content;
        if (parsed.done) return;
      } catch { /* skip malformed line */ }
    }
  }
}

// ─── API pública: chamada não-streaming, com fallback automático ───
export async function llmComplete(finalidade: LlmFinalidade, messages: Msg[], opts?: { maxTokens?: number; temperature?: number; jsonMode?: boolean }): Promise<string> {
  const chain = await resolveChain(finalidade);
  let lastErr: any = null;
  for (const provider of chain) {
    try {
      return await callProvider(
        { kind: provider.Kind, apiUrl: provider.ApiUrl, apiKey: decryptSecret(provider.ApiKeyEncrypted), modelName: provider.ModelName, apiVersion: provider.ApiVersion },
        messages, { ...opts, finalidade }
      );
    } catch (err: any) {
      lastErr = err;
      console.warn(`⚠️  [llm:${finalidade}] ${provider.Nome} falhou (${err.message}), tentando próximo...`);
    }
  }
  // Última rede de segurança: Ollama local
  try {
    return await callOllama(messages);
  } catch (err: any) {
    throw lastErr || err;
  }
}

// ─── API pública: chamada streaming, com fallback automático (só antes do 1º chunk) ───
export async function* llmStream(finalidade: LlmFinalidade, messages: Msg[], opts?: { maxTokens?: number; temperature?: number }): AsyncGenerator<string> {
  const chain = await resolveChain(finalidade);
  let lastErr: any = null;
  for (const provider of chain) {
    try {
      yield* streamProvider(
        { kind: provider.Kind, apiUrl: provider.ApiUrl, apiKey: decryptSecret(provider.ApiKeyEncrypted), modelName: provider.ModelName, apiVersion: provider.ApiVersion },
        messages, { ...opts, finalidade }
      );
      return;
    } catch (err: any) {
      lastErr = err;
      console.warn(`⚠️  [llm:${finalidade}] ${provider.Nome} falhou (${err.message}), tentando próximo...`);
    }
  }
  try {
    yield* streamOllama(messages);
  } catch (err: any) {
    throw lastErr || err;
  }
}

// ─── Seed inicial (chamado pela migration) — nunca hardcoded no código, sempre via .env ───
export async function ensureSeedProviders(): Promise<void> {
  const pool = await getPool();
  const existing = await pool.request().query(`SELECT COUNT(*) AS n FROM LlmProviders`);
  if (existing.recordset[0].n > 0) return; // já semeado (ou já configurado manualmente)

  const groqUrl = process.env.CHAT_API_URL;
  const groqKey = process.env.CHAT_API_KEY;
  // llama-3.3-70b-versatile foi deprecado pela Groq em 16/08/2026 — substituto recomendado: gpt-oss-120b
  const groqModel = process.env.CHAT_MODEL || 'openai/gpt-oss-120b';
  let groqId: number | null = null;
  if (groqUrl && groqKey) {
    await addProvider({ nome: 'Groq Llama 3.3', kind: 'openai-compatible', apiUrl: groqUrl, apiKey: groqKey, modelName: groqModel });
    const rows = await getProviders();
    groqId = rows.find(p => p.Nome === 'Groq Llama 3.3')?.Id ?? null;
  }

  const foundryUrl = process.env.AZURE_FOUNDRY_URL;
  const foundryKey = process.env.AZURE_FOUNDRY_API_KEY;
  const foundryModels: Record<string, string> = {
    'GPT-5.4 (Azure AI Foundry)': 'gpt-5.4',
    'GPT-4.1 (Azure AI Foundry)': 'gpt-4.1',
    'Grok 4.3 (Azure AI Foundry)': 'grok-4.3',
    'Kimi K2.6 (Azure AI Foundry)': 'Kimi-K2.6',
  };
  let gpt54Id: number | null = null;
  let gpt41Id: number | null = null;
  if (foundryUrl && foundryKey) {
    for (const [nome, modelName] of Object.entries(foundryModels)) {
      await addProvider({ nome, kind: 'azure-ai-foundry', apiUrl: foundryUrl, apiKey: foundryKey, modelName });
    }
    const rows = await getProviders();
    gpt54Id = rows.find(p => p.ModelName === 'gpt-5.4')?.Id ?? null;
    gpt41Id = rows.find(p => p.ModelName === 'gpt-4.1')?.Id ?? null;
  }

  // Atribuição por finalidade: GPT-5.4 é o mais indicado para APF/Especificação (raciocínio
  // estruturado em várias etapas); Groq continua no chat/classificação (alto volume, baixa latência).
  // Fallback cruzado entre "famílias" de infraestrutura diferentes, para resiliência real.
  if (groqId) {
    await setUsoConfig('chat', groqId, gpt41Id);
    await setUsoConfig('classificacao', groqId, gpt41Id);
  }
  if (gpt54Id) {
    await setUsoConfig('apf_geracao', gpt54Id, groqId);
    await setUsoConfig('apf_refinamento', gpt54Id, groqId);
    await setUsoConfig('spec_geracao', gpt54Id, groqId);
    await setUsoConfig('spec_estruturacao', gpt54Id, groqId);
    await setUsoConfig('spec_revisao', gpt54Id, groqId);
  } else if (groqId) {
    await setUsoConfig('apf_geracao', groqId, null);
    await setUsoConfig('apf_refinamento', groqId, null);
    await setUsoConfig('spec_geracao', groqId, null);
    await setUsoConfig('spec_estruturacao', groqId, null);
    await setUsoConfig('spec_revisao', groqId, null);
  }
}
