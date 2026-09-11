import { useState, useRef, useEffect, useCallback } from 'react';
import PatiSprite from './PatiSprite';
import { getAccessToken } from '../auth/authFetch';
import { registerInterviewSession, releaseInterviewSession, heartbeatInterviewSession, saveInterviewTranscript, fetchResumableInterview, fetchLlmCurrentProviderLabel, API_BASE } from '../services/api';
import { useMsal } from '@azure/msal-react';

export interface PatiFilters {
  cliente?: string;
  categoria?: string;
  modulo?: string;
  prioridade?: string;
  status?: string;
}

interface Message {
  role: 'user' | 'assistant' | 'status';
  content: string;
}

/** Horário com milissegundos (ex: "15:15:56.123") — diferencia turnos que aconteceram no mesmo
 * segundo (respostas rápidas), o que `toLocaleTimeString` sozinho não distingue. */
function formatHoraComMs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString('pt-BR')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

type InterviewState = { active: boolean; workItemId: number; tipo: string; history: { role: string; content: string; at?: string }[]; readyToGenerate?: boolean; bulk?: boolean; force?: boolean; isRefinement?: boolean };

// Entrevista em andamento só vivia em estado do React — um refresh acidental da página (ou
// a aba fechando) perdia TODAS as respostas já dadas, mesmo sem nenhuma falha de geração
// envolvida. Persistir em sessionStorage (sobrevive a refresh, some ao fechar a aba — nunca
// vaza pra outra sessão/usuário) dá uma rede de segurança adicional.
const INTERVIEW_STORAGE_KEY = 'pati_interview_state';
function loadStoredInterview(): InterviewState | null {
  try {
    const raw = sessionStorage.getItem(INTERVIEW_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const SUGGESTIONS = [
  'Resumo geral do painel',
  'Qual cliente tem mais chamados?',
  'Gerar APF de todos os chamados',
  'Classificar chamados pendentes',
];

/* Detect if user is requesting single work item classification */
function isSingleClassifyRequest(msg: string): { match: boolean; id: number } {
  const lower = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!/classifi(c|qu)\w*/.test(lower)) return { match: false, id: 0 };
  const idMatch = msg.match(/\b(\d{4,7})\b/);
  if (!idMatch) return { match: false, id: 0 };
  return { match: true, id: parseInt(idMatch[1]) };
}

/* Detect if user is requesting bulk classification */
function isClassifyRequest(msg: string): boolean {
  const lower = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Questions ABOUT classification — don't intercept, let LLM answer
  if (/^(como|o que|qual|por que|porque)\b/.test(lower)) return false;
  // If a specific ID is present → single classify, not bulk
  if (/\b\d{4,7}\b/.test(msg)) return false;
  // Any phrase containing classify + chamados/pendentes (with optional words in between)
  if (/classifi(c|qu)\w*/.test(lower) && /(chamado|pendente|todos|tudo)/.test(lower)) return true;
  // Direct imperative: "classificar", "classifique", "classificar pendentes"
  if (/^(pode\s+|quero\s+|por favor\s+)?classifi(car|que|ca)\b/.test(lower)) return true;
  return false;
}

/* Detect if user is requesting document generation (APF/Spec) */
function isDocumentRequest(msg: string): { match: boolean; tipo: 'APF' | 'SPEC' | 'AMBOS'; ids: number[]; force: boolean } {
  const lower = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const noMatch = { match: false, tipo: 'AMBOS' as const, ids: [], force: false };

  // Check for document keywords early (APF, spec, etc.)
  const hasApf = /(apf|ponto.* de fun|contagem|metr)/.test(lower);
  // "especif" (em vez de "especifica") tolera erros de digitação comuns como "especifcação"
  const hasSpec = /(spec|especif|espec\b|negocio)/.test(lower);
  const hasBoth = /(ambos|dois|tudo|documento|docs|arquivo)/.test(lower);
  const hasDocKeyword = hasApf || hasSpec || hasBoth;

  // Extract IDs early (needed for guards)
  const idMatches = msg.match(/\b(\d{4,7})\b/g);
  const ids = idMatches ? [...new Set(idMatches.map(Number).filter(n => n >= 1000))] : [];

  // Questions guard — if user is ASKING about docs/process (not commanding generation), route to chat
  const isAskingAbout = /(esclare|expli[cq]|entend|saber|funciona|criterio|detalh[ae]|mostrar?|significa|diferenca|duvida)\w*/.test(lower);
  // "voce pode gerar apf do 314871?" = question form (has ? + modal/subject) → route to chat
  const isQuestionForm = /\?/.test(msg) && /(^|\s)(voce|tu |pode[ms]?|poderia|consegue|da para|daria|seria possivel)\b/.test(lower);
  const isConfirmation = /(^|\s)(sim|ok|agora|entao|por favor|pfv|pf|claro|bora|vamo[s]?|manda)\b/.test(lower);

  // If clearly asking/understanding (not generating) AND no specific IDs AND no "todos" → it's a question
  if (isAskingAbout && ids.length === 0 && !/(todos|tudo)\b/.test(lower)) return noMatch;
  // If question form ("voce pode...?") without confirmation prefix → it's a polite question, not a command
  if (isQuestionForm && !isConfirmation) return noMatch;

  // Detect generation intent — strong verbs use stems to cover all conjugations (crie, gere, monte, etc.)
  const hasStrongGenerate = /(ger[aeo]|gerar|cri[aeo]|criar|produz|elabor[aeo]|mont[aeo]|calcul[aeo]|cont[aeo]|contar)\w*/.test(lower);
  const hasWeakGenerate = /(faz|fac|realiz|execut|rod[aeo])\w*/.test(lower);
  const hasRegenerate = /(refaz|refac|recontar|recont[aeo]|atualiz|redo|reger[aeo]|regerar|nova contagem)\w*/.test(lower);

  // Weak verbs require explicit APF/SPEC keyword — prevents "faz necessario" + "tudo" from firing
  const hasGenerate = hasStrongGenerate || (hasWeakGenerate && (hasApf || hasSpec));

  if (!hasGenerate && !hasDocKeyword && !hasRegenerate) return noMatch;
  if (!hasGenerate && !hasRegenerate && !(hasDocKeyword && ids.length > 0)) return noMatch;

  // Must have a target: specific IDs or explicit "todos/tudo" — otherwise it's a question, not a command
  const hasAllTarget = /(todos|tudo|cada)\b/.test(lower);
  if (ids.length === 0 && !hasAllTarget) return noMatch;

  // Determine doc type
  let tipo: 'APF' | 'SPEC' | 'AMBOS' = 'AMBOS';
  if (hasApf && !hasSpec && !hasBoth) tipo = 'APF';
  else if (hasSpec && !hasApf && !hasBoth) tipo = 'SPEC';

  // Force regeneration?
  const force = hasRegenerate;

  return { match: true, tipo, ids, force };
}

/* Detect if user is requesting APF refinement */
function isRefineRequest(msg: string): { match: boolean; id: number; instrucao: string } {
  const lower = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const noMatch = { match: false, id: 0, instrucao: '' };

  // Must mention a specific ID
  const idMatch = msg.match(/\b(\d{4,7})\b/);
  if (!idMatch) return noMatch;
  const id = parseInt(idMatch[1]);
  if (id < 1000) return noMatch;

  // Questions are NEVER refinement — route to chat
  if (/\?/.test(msg)) return noMatch;
  if (/(^|\s)(tem|qual|quais|como|o que|por que|porque|pode|poderia|mostr|detalh|expli|esclare)\b/.test(lower)) return noMatch;

  // Must have refinement-like context: user is PROVIDING info to adjust existing APF
  // These keywords indicate the user is giving instructions to change the counting
  const hasRefineKeywords = /(considere|adiciona|ajust|inclui|inclua|prev[ei]|falta|remov|alter|muda|atualiz|nao contou|esqueceu|precisa ter|deveria ter|tambem tem|alem disso)\w*/.test(lower);
  const isGenerate = /(ger[aeo]|gerar|cri[aeo]|criar)\s*(apf|spec|especifica|documento)/.test(lower);
  const isRegenerate = /(refaz|refazer|recontar|reconta|regera)\w*/.test(lower);

  if (!hasRefineKeywords) return noMatch;
  if (isGenerate || isRegenerate) return noMatch;

  // The instruction is the full message (LLM will interpret it)
  return { match: true, id, instrucao: msg };
}

export default function PatiChat({ filters = {}, onClassifyDone }: { filters?: PatiFilters; onClassifyDone?: () => void }) {
  const { accounts } = useMsal();
  const currentUser = accounts[0] ?? null;
  const userName = currentUser?.name || '';
  const userEmail = currentUser?.username || '';

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => localStorage.getItem('pati_chat_expanded') === '1');
  const [chatProviderLabel, setChatProviderLabel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>(() => {
    const base: Message[] = [
      { role: 'assistant', content: 'Olá! Sou a **PATi**, sua agente de suporte. Pergunte sobre os dados do painel ou peça para classificar chamados! 🐝' },
    ];
    const restored = loadStoredInterview();
    if (restored?.history?.length) {
      base.push({ role: 'assistant', content: '🔄 Retomando a entrevista de onde paramos — suas respostas anteriores foram preservadas.' });
      for (const turno of restored.history) {
        base.push({ role: turno.role === 'user' ? 'user' : 'assistant', content: turno.content });
      }
    }
    return base;
  });
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<{ pct: number; current: number; total: number } | null>(null);
  const [interview, setInterview] = useState<InterviewState | null>(() => loadStoredInterview());
  const [pendingDocTipo, setPendingDocTipo] = useState<'APF' | 'SPEC' | 'AMBOS' | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Lido dentro de callbacks (ex.: runInterviewStep) sem precisar entrar na dependency array —
  // evita recriar a função a cada troca de sessionId e evita closure desatualizada.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, status, scrollToBottom]);
  // Mantém a entrevista salva em sessionStorage sempre atualizada — some junto quando a
  // entrevista é encerrada/concluída (interview === null) ou some sozinho ao fechar a aba.
  useEffect(() => {
    try {
      if (interview) sessionStorage.setItem(INTERVIEW_STORAGE_KEY, JSON.stringify(interview));
      else sessionStorage.removeItem(INTERVIEW_STORAGE_KEY);
    } catch { /* sessionStorage indisponível/cheio — não é crítico, só perde a rede de segurança */ }
  }, [interview]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { localStorage.setItem('pati_chat_expanded', expanded ? '1' : '0'); }, [expanded]);

  // Cresce o campo de texto conforme o conteúdo digitado (independente do painel estar
  // compacto ou expandido), em vez de rolar o texto escondido numa única linha.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxH = expanded ? 240 : 120;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }, [input, expanded, open]);

  // Busca o nome do provider de IA atual (finalidade 'chat') para exibir na legenda —
  // reflete automaticamente qualquer troca feita em Configurações > Modelos de IA.
  useEffect(() => {
    if (!open || chatProviderLabel) return;
    fetchLlmCurrentProviderLabel('chat').then(setChatProviderLabel).catch(() => {});
  }, [open, chatProviderLabel]);

  /* ─── Classification via SSE ─── */
  const runClassification = useCallback(async () => {
    setStreaming(true);
    setStatus('');
    setProgress(null);
    const activeFilters = Object.entries(filters).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`);
    const scope = activeFilters.length > 0 ? ` (${activeFilters.join(', ')})` : '';
    setMessages(prev => [...prev, { role: 'assistant', content: `⏳ Iniciando classificação dos chamados pendentes${scope}...` }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const classifyParams = new URLSearchParams({ limit: '50', reclassify: 'false' });
      if (filters.cliente) classifyParams.set('cliente', filters.cliente);
      if (filters.categoria) classifyParams.set('categoria', filters.categoria);
      if (filters.modulo) classifyParams.set('modulo', filters.modulo);
      if (filters.prioridade) classifyParams.set('prioridade', filters.prioridade);
      if (filters.status) classifyParams.set('status', filters.status);
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/classify/stream?${classifyParams}`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Erro ao iniciar classificação');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let classified = 0;
      let errors = 0;
      let total = 0;

      const updateLastMsg = (content: string) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content };
          return copy;
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'start') {
              total = data.total;
              if (total === 0) {
                updateLastMsg('✨ Não há chamados pendentes para classificar!');
              } else {
                updateLastMsg(`🔄 Classificando **${total}** chamados pendentes...`);
                setProgress({ pct: 0, current: 0, total });
              }
            } else if (data.type === 'progress') {
              setProgress({ pct: data.pct, current: data.current, total: data.total });
              setStatus(`Analisando #${data.id}...`);
            } else if (data.type === 'classified') {
              classified++;
              setProgress({ pct: data.pct, current: data.current, total: data.total });
              setStatus(`#${data.id} → ${data.categoria} (${data.elapsed})`);
              updateLastMsg(`🔄 Classificando... **${data.current}/${data.total}** (${data.pct}%)\n\nÚltimo: #${data.id} → **${data.categoria}**`);
            } else if (data.type === 'error') {
              errors++;
              setProgress({ pct: data.pct, current: data.current, total: data.total });
            } else if (data.type === 'done') {
              setProgress(null);
              const lines = [
                `✨ Classificação concluída!`,
                ``,
                `- **${data.classified}** chamados classificados`,
              ];
              if (data.errors > 0) lines.push(`- **${data.errors}** erros`);
              lines.push(`- **${data.total}** processados no total`);
              updateLastMsg(lines.join('\n'));
              onClassifyDone?.();
            }
          } catch { /* skip malformed SSE line */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: '❌ Erro ao conectar com o serviço de classificação.' }]);
      }
    } finally {
      setStreaming(false);
      setStatus('');
      setProgress(null);
      abortRef.current = null;
    }
  }, [filters, onClassifyDone]);

  /* ─── Session helpers ─── */
  // Antes de começar uma entrevista do zero, verifica se o PRÓPRIO usuário já tem uma
  // entrevista não concluída pra esse chamado+tipo salva no servidor (ver TranscriptJson) —
  // se houver, retoma o mesmo sessionId + histórico em vez de perguntar tudo de novo (só
  // some se a entrevista terminar com sucesso ou for encerrada explicitamente pelo usuário).
  const startSession = useCallback(async (workItemId: number, tipo: string): Promise<{ sid: string; resumedHistory: { role: string; content: string; at?: string }[] }> => {
    try {
      const resumable = await fetchResumableInterview(workItemId, tipo);
      if (resumable.resumable && resumable.sessionId && resumable.history?.length) {
        setSessionId(resumable.sessionId);
        setConflictWarning(null);
        return { sid: resumable.sessionId, resumedHistory: resumable.history };
      }
    } catch { /* segue pro fluxo normal se a checagem falhar */ }

    const sid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const result = await registerInterviewSession(sid, workItemId, tipo, userName, userEmail);
      setSessionId(sid);
      if (result.conflicts?.length > 0) {
        const names = result.conflicts.map((c: any) => c.UserName || c.UserEmail || 'outro usuário').join(', ');
        setConflictWarning(`⚠️ ${names} também está${result.conflicts.length > 1 ? 'ão' : ''} entrevistando este chamado. Seus documentos serão salvos como versões independentes.`);
      } else {
        setConflictWarning(null);
      }
    } catch { /* non-blocking */ }
    return { sid, resumedHistory: [] };
  }, [userName, userEmail]);

  const endSession = useCallback(async (sid: string | null) => {
    if (!sid) return;
    setSessionId(null);
    setConflictWarning(null);
    try { await releaseInterviewSession(sid); } catch { /* non-blocking */ }
  }, []);

  // Heartbeat — keep session alive while interview is active
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (sessionId) {
      heartbeatRef.current = setInterval(() => heartbeatInterviewSession(sessionId).catch(() => {}), 60_000);
    } else {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    }
    return () => { if (heartbeatRef.current) clearInterval(heartbeatRef.current); };
  }, [sessionId]);

  /* ─── Document generation via SSE ─── */
  const runDocGeneration = useCallback(async (tipo: 'APF' | 'SPEC' | 'SPEC_DOCX' | 'AMBOS', ids: number[], force = false, interviewContext?: string, activeSid?: string): Promise<boolean> => {
    setStreaming(true);
    setStatus('');
    setProgress(null);

    const tipoLabel = tipo === 'APF' ? 'APF' : (tipo === 'SPEC' || tipo === 'SPEC_DOCX') ? 'Especificação' : 'APF + Especificação';
    const scopeLabel = ids.length > 0 ? ` para ${ids.length} chamado(s)` : ' para todos com tag [PATI]';
    const forceLabel = force ? ' (recontagem forçada)' : '';
    if (!interviewContext) {
      setMessages(prev => [...prev, { role: 'assistant', content: `⏳ Iniciando geração de **${tipoLabel}**${scopeLabel}${forceLabel}...` }]);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // POST com corpo JSON (não mais GET com querystring) — `interviewContext` compilado de
      // uma entrevista longa pode passar de dezenas de KB; URL-encoded (acentos do português
      // viram %XX, ~3x mais bytes) estourava o limite de URL do IIS/Node antes mesmo de chegar
      // no Express, derrubando a geração sem nenhum log e perdendo a entrevista inteira.
      const body: Record<string, unknown> = { tipo };
      if (ids.length > 0) body.ids = ids.join(',');
      if (force) body.force = true;
      if (interviewContext) body.interviewContext = interviewContext;
      if (activeSid) body.sessionId = activeSid;
      // Pass dashboard filters so generation respects current view
      if (filters.cliente) body.cliente = filters.cliente;
      if (filters.categoria) body.categoria = filters.categoria;
      if (filters.modulo) body.modulo = filters.modulo;
      if (filters.prioridade) body.prioridade = filters.prioridade;
      if (filters.status) body.status = filters.status;

      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/documents/generate/stream`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Erro ao iniciar geração');


      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let generated = 0;
      let totalSteps = 0;
      // Nem toda falha vira exceção — o stream SSE pode completar normalmente (res.ok, sem
      // throw) mesmo quando a geração de UM item falhou (ex.: LLM devolveu resposta vazia).
      // Sem rastrear isso, a função sempre retornava sucesso ao chegar no fim do stream, o
      // chamador limpava a entrevista, e a resposta da PATi vinha vazia/com erro — perdendo a
      // entrevista inteira mesmo sem nenhuma exceção de rede ter acontecido.
      let hadError = false;

      const updateLastMsg = (content: string) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content };
          return copy;
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'start') {
              totalSteps = data.total;
              if (totalSteps === 0 && data.skipped > 0) {
                updateLastMsg(`✨ Todos os **${data.skipped}** chamados já possuem documentos gerados.\n\n💡 Para refazer, diga: "refazer APF do 318350" ou "recontar todos".`);
              } else if (totalSteps === 0) {
                updateLastMsg('ℹ️ Nenhum chamado encontrado para geração de documentos no filtro atual.');
              } else {
                const skipNote = data.skipped > 0 ? `\n✓ ${data.skipped} já possuem docs (mantidos)` : '';
                updateLastMsg(`🔄 Gerando **${tipoLabel}** para **${data.items}** chamado(s)...${skipNote}`);
                setProgress({ pct: 0, current: 0, total: totalSteps });
              }
            } else if (data.type === 'progress') {
              setProgress({ pct: data.pct, current: data.current, total: data.total });
              setStatus(`Gerando ${data.step} para #${data.id}...`);
            } else if (data.type === 'generated') {
              generated++;
              setProgress({ pct: data.pct, current: data.current, total: data.total });
              const detail = data.step === 'APF'
                ? ` → **${data.totalPF} PF** | **${data.totalHoras}h** (${data.elapsed})`
                : ` (${data.elapsed})`;
              setStatus(`✨ #${data.id} ${data.step}${detail}`);
              updateLastMsg(`🔄 Gerando... **${data.current}/${data.total}** (${data.pct}%)\n\nÚltimo: #${data.id} ${data.step}${detail}`);
            } else if (data.type === 'error') {
              hadError = true;
              setStatus(`❌ #${data.id} ${data.step}: ${data.message}`);
            } else if (data.type === 'done') {
              setProgress(null);
              if (data.errors > 0) hadError = true;

              // When nothing was generated, show a helpful message
              if (data.generated === 0 && data.total === 0) {
                const lines: string[] = [];
                if (data.skipped > 0) {
                  lines.push(`✨ Todos os **${data.skipped}** chamados já possuem documentos gerados.`);
                  lines.push('');
                  lines.push('💡 Para refazer, diga: "refazer APF do 318350" ou "recontar todos".');
                } else {
                  lines.push('ℹ️ Nenhum chamado encontrado para geração de documentos no filtro atual.');
                }
                updateLastMsg(lines.join('\n'));
              } else {
                const lines: string[] = ['✨ **Geração concluída!**\n'];
                if (data.generated > 0) lines.push(`- **${data.generated}** documento(s) gerado(s)`);
                if (data.errors > 0) lines.push(`- **${data.errors}** erro(s)`);
                if (data.skipped > 0) lines.push(`- **${data.skipped}** já possuíam docs (mantidos)`);
                lines.push(`- **${data.total}** etapa(s) processadas`);

                // List APF results
                if (data.results && data.results.length > 0) {
                  lines.push('\n**Resultados:**');
                  for (const r of data.results) {
                    let detail = `- #${r.id} ${r.title?.slice(0, 40)}`;
                    if (r.apf) detail += ` → ${r.apf.totalPF} PF, ${r.apf.totalHoras}h`;
                    if (r.spec) detail += ' | Spec ✓';
                    if (r.error) detail += ` | ❌ ${r.error}`;
                    lines.push(detail);
                  }
                }
                // Erro real (não exceção de rede) — a entrevista NÃO é limpa pelo chamador
                // nesse caso (ver `hadError`/return), então avisa que dá pra só tentar de novo.
                if (data.errors > 0) lines.push('\n💡 Suas respostas da entrevista não foram perdidas — pode tentar novamente dizendo "sim".');

                updateLastMsg(lines.join('\n'));
              }
              onClassifyDone?.(); // refresh dashboard data
            }
          } catch { /* skip malformed SSE line */ }
        }
      }
      return !hadError;
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: '❌ Erro ao conectar com o serviço de geração de documentos. Suas respostas da entrevista NÃO foram perdidas — pode tentar novamente dizendo "sim".' }]);
      }
      return false;
    } finally {
      setStreaming(false);
      setStatus('');
      setProgress(null);
      abortRef.current = null;
    }
  }, [onClassifyDone, filters]);

  /* ─── APF Refinement via chat ─── */
  const runRefinement = useCallback(async (workItemId: number, instrucao: string): Promise<boolean> => {
    setStreaming(true);
    setStatus('Analisando ajuste...');
    setMessages(prev => [...prev, { role: 'assistant', content: `⏳ Ajustando contagem APF do **#${workItemId}** com base na sua instrução...` }]);

    try {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/documents/${workItemId}/refine-apf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instrucao }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao refinar APF');

      const lines = [
        `✨ **APF refinada com sucesso!**\n`,
        `**Alterações:** ${data.changes}\n`,
        `- **${data.elementos}** elementos funcionais`,
        `- **${data.totalPF} PF** → **${data.totalPFA} PFA**`,
        `- **${data.totalHoras}h** de esforço estimado`,
        `\n💡 Pode continuar ajustando: basta descrever mais detalhes sobre o #${workItemId}.`,
        `Para ver a contagem atual, diga: "mostra APF do ${workItemId}"`,
      ];

      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', content: lines.join('\n') };
        return copy;
      });
      onClassifyDone?.(); // refresh dashboard
      return true;
    } catch (err: any) {
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', content: `❌ ${err.message} Suas respostas NÃO foram perdidas — pode tentar novamente dizendo "sim".` };
        return copy;
      });
      return false;
    } finally {
      setStreaming(false);
      setStatus('');
    }
  }, [onClassifyDone]);

  /* ─── Interview mode: gather requirements before generation ─── */
  const runInterviewStep = useCallback(async (userAnswer: string, interviewState: { workItemId: number; tipo: string; history: { role: string; content: string; at?: string }[]; bulk?: boolean; force?: boolean; isRefinement?: boolean }) => {
    setStreaming(true);
    setStatus('PATi analisando...');

    const newHistory = [...interviewState.history];
    if (userAnswer) {
      newHistory.push({ role: 'user', content: userAnswer, at: new Date().toISOString() });
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const token = await getAccessToken();
      const body: Record<string, unknown> = {
        tipo: interviewState.tipo,
        history: newHistory,
      };
      if (interviewState.bulk) {
        body.bulk = true;
        body.filters = filters;
      } else {
        body.workItemId = interviewState.workItemId;
      }
      const res = await fetch(`${API_BASE}/chat/interview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error('Erro de conexão');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let added = false;
      let ready = false;
      let isRefinementFlag = interviewState.isRefinement ?? false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk') {
              assistantText += data.text;
              const displayText = assistantText.replace('[PRONTO_PARA_GERAR]', '').trim();
              if (!displayText) continue; // Don't show empty bubble
              if (!added) {
                setMessages(prev => [...prev, { role: 'assistant', content: displayText }]);
                added = true;
              } else {
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = { role: 'assistant', content: displayText };
                  return copy;
                });
              }
              setStatus('');
            } else if (data.type === 'done') {
              ready = data.ready || assistantText.includes('[PRONTO_PARA_GERAR]');
              if (typeof data.isRefinement === 'boolean') isRefinementFlag = data.isRefinement;
            }
          } catch { /* skip */ }
        }
      }

      // Update interview history
      newHistory.push({ role: 'assistant', content: assistantText, at: new Date().toISOString() });
      // Salva no servidor a cada turno (fire-and-forget) — permite retomar a entrevista depois
      // sem repetir as respostas, mesmo que a geração final falhe ou o navegador feche.
      if (sessionIdRef.current) saveInterviewTranscript(sessionIdRef.current, newHistory).catch(() => {});

      if (ready) {
        // PATi signaled [PRONTO_PARA_GERAR] — check if user already confirmed
        const lastUserMsg = newHistory.filter(m => m.role === 'user').pop()?.content || '';
        const lastLower = lastUserMsg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const userAlreadyConfirmed = /(^|\s)(sim|pode|gerar?|vai|manda|ok|bora|claro|vamo|faz|gere|com certeza|logico|obvio|beleza|por favor|pfv|pf|agora|entao)\b/.test(lastLower);

        if (userAlreadyConfirmed) {
          // User ALREADY confirmed (said "sim" etc.) → generate immediately. Só limpa a
          // entrevista/encerra a sessão DEPOIS de confirmado sucesso — se a geração falhar
          // (ex.: erro de rede/servidor), a entrevista inteira (já confirmada) não pode ser
          // perdida; mantemos o estado pronto pra o usuário só dizer "sim" de novo.
          const sidToUse = sessionId;
          const contextFromInterview = newHistory
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role === 'user' ? 'Analista' : 'PATi'}${m.at ? ` [${formatHoraComMs(m.at)}]` : ''}: ${m.content.replace('[PRONTO_PARA_GERAR]', '')}`)
            .join('\n');
          const tipo = interviewState.tipo as 'APF' | 'SPEC' | 'AMBOS';
          let success: boolean;
          if (isRefinementFlag && tipo === 'APF' && !interviewState.bulk) {
            success = await runRefinement(interviewState.workItemId, contextFromInterview);
          } else {
            setMessages(prev => [...prev, { role: 'assistant', content: '⏳ Gerando documento com base nas informações coletadas...' }]);
            const ids = interviewState.bulk ? [] : [interviewState.workItemId];
            // "Especificação" via chat usa o novo pipeline (template Word) por padrão.
            const genTipo = tipo === 'SPEC' ? 'SPEC_DOCX' : tipo;
            success = await runDocGeneration(genTipo, ids, contextFromInterview ? true : (interviewState.force ?? false), contextFromInterview, sidToUse ?? undefined);
          }
          if (success) {
            setInterview(null);
            await endSession(sidToUse);
          } else {
            setInterview({ active: true, workItemId: interviewState.workItemId, tipo: interviewState.tipo, history: newHistory, readyToGenerate: true, bulk: interviewState.bulk, force: interviewState.force, isRefinement: isRefinementFlag });
          }
        } else {
          // PATi triggered prematurely (without user confirmation) → wait
          setInterview({ active: true, workItemId: interviewState.workItemId, tipo: interviewState.tipo, history: newHistory, readyToGenerate: true, bulk: interviewState.bulk, force: interviewState.force, isRefinement: isRefinementFlag });
        }
      } else {
        // Check if PATi asked to generate (heuristic: requer "?" após "posso gerar" para não bater em "Não posso gerar")
        const askedToGenerate = /posso gerar[^?]*\?/i.test(assistantText);
        // Continue interview
        setInterview({ active: true, workItemId: interviewState.workItemId, tipo: interviewState.tipo, history: newHistory, readyToGenerate: askedToGenerate || undefined, bulk: interviewState.bulk, force: interviewState.force, isRefinement: isRefinementFlag });
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: '❌ Erro na entrevista.' }]);
        setInterview(null);
      }
    } finally {
      setStreaming(false);
      setStatus('');
      abortRef.current = null;
    }
  }, [runDocGeneration, runRefinement]);

  /* ─── Chat via SSE ─── */
  const sendMessage = useCallback(async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || streaming) return;
    setInput('');
    setStreaming(true);
    setStatus('');

    const userMsg: Message = { role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);

    /* If in interview mode, handle user response */
    if (interview?.active) {
      const normalizedForInterview = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // 1) Encerrar — cancela a entrevista imediatamente
      if (/\b(encerrar|cancelar|sair|desistir|abandonar|parar)\b/.test(normalizedForInterview)) {
        setInterview(null);
        setPendingDocTipo(null);
        endSession(sessionId);
        setMessages(prev => [...prev, { role: 'assistant', content: 'Entrevista encerrada.' }]);
        setStreaming(false);
        setStatus('');
        return;
      }

      // 2) Nova solicitação de documento sobrescreve a entrevista atual
      // GUARD: dentro da entrevista, só sobrescreve se for claramente um novo comando
      // (previne respostas de entrevista — ex: "tudo que se faz necessario" — de resetar o contexto)
      const overrideReq = isDocumentRequest(msg);
      if (overrideReq.match) {
        const lMsg = normalizedForInterview;
        const isClearNewCommand = overrideReq.ids.length > 0 ||
          /\b(gerar?|cri[ae]r?|elaborar?|recontar?|refazer?)\s+(apf|spec|especifica|documento)/.test(lMsg) ||
          /\bgerar?\s+(todos|tudo)\b/.test(lMsg);
        if (!isClearNewCommand) {
          // É uma resposta da entrevista, não um novo comando → continua entrevista
          await runInterviewStep(msg, interview);
          return;
        }
        setInterview(null);
        const targetId = overrideReq.ids[0];
        if (targetId) {
          const interviewState = { active: true, workItemId: targetId, tipo: overrideReq.tipo, history: [] as { role: string; content: string; at?: string }[], bulk: false, force: overrideReq.force };
          setInterview(interviewState);
          await runInterviewStep('', interviewState);
        } else {
          const interviewState = { active: true, workItemId: 0, tipo: overrideReq.tipo, history: [] as { role: string; content: string; at?: string }[], bulk: true, force: overrideReq.force };
          setInterview(interviewState);
          await runInterviewStep('', interviewState);
        }
        return;
      }

      if (interview.readyToGenerate) {
        // PATi already asked "Posso gerar?" — check if user is confirming
        const isConfirm = /(^|\s)(sim|pode|gerar?|vai|manda|ok|bora|claro|vamo|faz|gere|com certeza|logico|obvio|beleza|por favor|pfv|pf|agora|entao)\b/.test(normalizedForInterview);
        if (isConfirm) {
          const sidToUse = sessionId;
          // A confirmação do analista ("sim"/"pode"/...) precisa entrar no histórico ANTES de
          // montar o InterviewContext — sem isso, a resposta que libera a geração fica visível
          // só no chat da tela, mas nunca é gravada na trilha de auditoria (PDF).
          const historyWithConfirmation = [...interview.history, { role: 'user', content: msg, at: new Date().toISOString() }];
          const contextFromInterview = historyWithConfirmation
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role === 'user' ? 'Analista' : 'PATi'}${m.at ? ` [${formatHoraComMs(m.at)}]` : ''}: ${m.content.replace('[PRONTO_PARA_GERAR]', '')}`)
            .join('\n');
          const tipo = interview.tipo as 'APF' | 'SPEC' | 'AMBOS';
          let success: boolean;
          if (interview.isRefinement && tipo === 'APF' && !interview.bulk) {
            success = await runRefinement(interview.workItemId, contextFromInterview);
          } else {
            setMessages(prev => [...prev, { role: 'assistant', content: '⏳ Gerando documento com base nas informações coletadas...' }]);
            const ids = interview.bulk ? [] : [interview.workItemId];
            // "Especificação" via chat usa o novo pipeline (template Word) por padrão.
            const genTipo = tipo === 'SPEC' ? 'SPEC_DOCX' : tipo;
            success = await runDocGeneration(genTipo, ids, contextFromInterview ? true : (interview.force ?? false), contextFromInterview, sidToUse ?? undefined);
          }
          // Só limpa a entrevista/encerra a sessão DEPOIS de confirmado sucesso — numa falha
          // (ex.: erro de rede/servidor), a entrevista inteira já confirmada não pode ser
          // perdida; mantemos o estado pronto pra o usuário só dizer "sim" de novo.
          if (success) {
            setInterview(null);
            await endSession(sidToUse);
          } else {
            setInterview({ ...interview, history: historyWithConfirmation });
          }
          return;
        }
        // User didn't confirm — maybe adding more details, continue interview
      }
      await runInterviewStep(msg, interview);
      return;
    }

    /* Handle pendingDocTipo — usuário estava sendo perguntado sobre qual chamado */
    if (pendingDocTipo) {
      const ids = msg.match(/\b(\d{4,7})\b/g)?.map(Number).filter((n: number) => n >= 1000) || [];
      const hasAll = /(todos|tudo|cada)/i.test(msg);
      const tipo = pendingDocTipo;
      setPendingDocTipo(null);
      if (ids.length > 0 || hasAll) {
        const targetId = ids[0];
        if (targetId) {
          const interviewState = { active: true, workItemId: targetId, tipo, history: [] as { role: string; content: string; at?: string }[], bulk: false, force: false };
          setInterview(interviewState);
          await runInterviewStep('', interviewState);
        } else {
          const interviewState = { active: true, workItemId: 0, tipo, history: [] as { role: string; content: string; at?: string }[], bulk: true, force: false };
          setInterview(interviewState);
          await runInterviewStep('', interviewState);
        }
        return;
      }
      // Usuário não informou ID — deixa cair no chat normal
    }

    /* Intercept single work item classification */
    const singleClassify = isSingleClassifyRequest(msg);
    if (singleClassify.match) {
      setMessages(prev => [...prev, { role: 'assistant', content: `⏳ Classificando chamado **#${singleClassify.id}**...` }]);
      try {
        const token = await getAccessToken();
        const res = await fetch(`${API_BASE}/classify/${singleClassify.id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao classificar');
        const cl = data.classification || data;
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content:
            `✨ **#${singleClassify.id}** classificado!\n\n` +
            `- **Categoria:** ${cl.categoria}\n` +
            `- **Tipo:** ${cl.tipo}\n` +
            `- **Módulo:** ${cl.modulo || 'N/A'}\n` +
            `- **Prioridade:** ${cl.prioridade}\n` +
            `- **Impacto:** ${cl.impacto}\n` +
            `- **Confiança:** ${Math.round((cl.confianca || 0) * 100)}%`,
          };
          return copy;
        });
        onClassifyDone?.();
      } catch (err: any) {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: `❌ ${err.message}` };
          return copy;
        });
      } finally {
        setStreaming(false);
        setStatus('');
      }
      return;
    }

    /* Intercept bulk classification requests */
    if (isClassifyRequest(msg)) {
      await runClassification();
      return;
    }

    /* Intercept document generation requests — start interview instead of generating directly */
    const docReq = isDocumentRequest(msg);
    if (docReq.match) {
      // Start interview for the first matching ID (or first from list)
      const targetId = docReq.ids[0];
      if (targetId) {
        const { resumedHistory } = await startSession(targetId, docReq.tipo);
        if (resumedHistory.length > 0) {
          setMessages(prev => [...prev, { role: 'assistant', content: '🔄 Encontrei uma entrevista sua não concluída para este chamado — retomando de onde você parou, sem precisar repetir as respostas.' }]);
        }
        const interviewState = { active: true, workItemId: targetId, tipo: docReq.tipo, history: resumedHistory, bulk: false, force: docReq.force };
        setInterview(interviewState);
        await runInterviewStep('', interviewState);
      } else {
        // "todos" — bulk interview obrigatório (lê description+DiscussionPati de todos os itens)
        const interviewState = { active: true, workItemId: 0, tipo: docReq.tipo, history: [] as { role: string; content: string; at?: string }[], bulk: true, force: docReq.force };
        setInterview(interviewState);
        await runInterviewStep('', interviewState);
      }
      return;
    }

    /* Context-aware generation: if generation intent detected but no target, find last discussed ID */
    const lower = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const hasGenVerb = /(ger[aeo]|gerar|cri[aeo]|criar|faz|fac|realiz|execut|escrev|produz|elabor|mont)\w*/.test(lower);
    const hasDocWord = /(apf|spec|especifica|documento|arquivo|digital|contagem|ponto.* fun)\w*/.test(lower);
    // Guard: only generate on AFFIRMATIVE commands, never on questions
    const isQuestion = /\?/.test(msg) || /(^|\s)(voce|tu |o que|como|quais?|por que|porque|qual|pode[ms]?|poderia|consegue|da para)\b/.test(lower);
    const isConfirmation = /(^|\s)(sim|ok|agora|entao|por favor|pfv|pf|claro|bora|vamo[s]?|manda)\b/.test(lower);
    const isAskingCapability = isQuestion && !isConfirmation;
    if (hasGenVerb && hasDocWord && docReq.ids.length === 0 && !isAskingCapability) {
      // Find last work item ID mentioned by the USER specifically.
      // Avoids picking up parent/related IDs that the assistant mentions in its responses.
      let lastId: number | undefined;
      const userMsgs = messages.filter(m => m.role === 'user');
      for (let i = userMsgs.length - 1; i >= 0; i--) {
        const ids = (userMsgs[i].content.match(/\b(\d{4,7})\b/g) || []).map(Number).filter(n => n >= 1000);
        if (ids.length > 0) { lastId = ids[0]; break; }
      }
      if (lastId) {
        // Determine tipo from keywords
        const hasApfWord = /(apf|contagem|ponto.* fun)\w*/.test(lower);
        const hasSpecWord = /(spec|especif)\w*/.test(lower);
        const tipo: 'APF' | 'SPEC' | 'AMBOS' = hasApfWord && !hasSpecWord ? 'APF' : hasSpecWord && !hasApfWord ? 'SPEC' : 'AMBOS';
        // Start interview instead of generating directly
        const interviewState = { active: true, workItemId: lastId, tipo, history: [] as { role: string; content: string; at?: string }[], bulk: false, force: false };
        setInterview(interviewState);
        await runInterviewStep('', interviewState);
        return;
      }
      // Nenhum ID encontrado no histórico — pede ao usuário qual chamado
      const hasApfWord = /(apf|contagem|ponto.* fun)\w*/.test(lower);
      const hasSpecWord = /(spec|especif)\w*/.test(lower);
      const tipo: 'APF' | 'SPEC' | 'AMBOS' = hasApfWord && !hasSpecWord ? 'APF' : hasSpecWord && !hasApfWord ? 'SPEC' : 'AMBOS';
      const tipoLabel = tipo === 'APF' ? 'APF' : tipo === 'SPEC' ? 'Especificação' : 'APF + Especificação';
      setPendingDocTipo(tipo);
      setMessages(prev => [...prev, { role: 'assistant', content: `Para gerar **${tipoLabel}**, informe o número do chamado.\n\nExemplo: \`gerar ${tipoLabel} do chamado 321497\`\n\nOu para todos: \`gerar ${tipoLabel} de todos\`` }]);
      setStreaming(false);
      setStatus('');
      return;
    }

    /* Intercept APF refinement requests */
    const refineReq = isRefineRequest(msg);
    if (refineReq.match) {
      await runRefinement(refineReq.id, refineReq.instrucao);
      return;
    }

    const history = [...messages, userMsg]
      .filter(m => m.role !== 'status')
      .map(m => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: msg, history: history.slice(-8), filters }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error('Erro de conexão');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let added = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'status') {
              setStatus(data.text);
            } else if (data.type === 'chunk') {
              assistantText += data.text;
              if (!added) {
                setMessages(prev => [...prev, { role: 'assistant', content: assistantText }]);
                added = true;
              } else {
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = { role: 'assistant', content: assistantText };
                  return copy;
                });
              }
              setStatus('');
            } else if (data.type === 'error') {
              const friendlyMsg = data.text?.includes('Conversion failed') || data.text?.includes('SQL') || data.text?.includes('EREQUEST')
                ? 'Desculpe, ocorreu um erro ao consultar os dados. Tente reformular sua pergunta.'
                : data.text || 'Erro desconhecido';
              setMessages(prev => [...prev, { role: 'assistant', content: `Ops, tive um problema: ${friendlyMsg}` }]);
            }
          } catch { /* skip */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Desculpe, não consegui conectar ao servidor. Verifique se o Ollama está rodando.' }]);
      }
    } finally {
      setStreaming(false);
      setStatus('');
      abortRef.current = null;
    }
  }, [input, streaming, messages, interview, runClassification, runDocGeneration, runRefinement, runInterviewStep, filters]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false);
    setStatus('');
  };

  const renderMarkdown = (text: string) => {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/#(\d{4,})/g, '<span class="text-[#6366f1] font-medium">#$1</span>')
      .replace(/^- /gm, '• ')
      .replace(/\n/g, '<br/>');
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-4 right-4 z-50 w-[72px] h-[72px] rounded-full flex items-center justify-center transition-all duration-300 hover:scale-110 cursor-pointer bg-transparent overflow-visible drop-shadow-lg"
        title="Falar com a PATi"
      >
        {open ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        ) : (
          <PatiSprite expression="amigavel" size={68} />
        )}
        {!open && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-[#6366f1] rounded-full border-2 border-white animate-pulse" />
        )}
      </button>

      {/* Chat panel — light theme */}
      {open && (
        <div className={`fixed z-50 bg-white border border-gray-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-fade-up transition-[width,height] duration-200 ${
          expanded
            ? 'bottom-[100px] right-6 w-[min(860px,calc(100vw-3rem))] h-[min(82vh,820px)]'
            : 'bottom-[100px] right-6 w-[400px] h-[min(540px,calc(100vh-7rem))]'
        }`}>
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-[#f7f8fa] border-b border-gray-200">
            <div className="flex-shrink-0">
              <PatiSprite expression={streaming ? 'analisando' : 'amigavel'} size={64} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-[#0f1117] flex items-center gap-1.5">
                PATi
                <span className="text-[10px] font-normal text-[#6366f1] bg-[#6366f1]/10 px-1.5 py-0.5 rounded-full">by paradigma</span>
              </div>
              <div className="text-[11px] text-[#6b7280]">Agente de suporte IA{chatProviderLabel ? ` · ${chatProviderLabel}` : ''}</div>
            </div>
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-[#9ca3af] hover:text-[#0f1117] cursor-pointer p-1"
              title={expanded ? 'Reduzir chat' : 'Expandir chat'}
            >
              {expanded ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              )}
            </button>
            <button onClick={() => setOpen(false)} className="text-[#9ca3af] hover:text-[#0f1117] cursor-pointer p-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3 scrollbar-thin">
            {/* Conflict warning banner */}
            {conflictWarning && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[#fffbeb] border border-[#fcd34d] text-[12px] text-[#92400e]">
                <span className="shrink-0 mt-0.5">⚠️</span>
                <span className="flex-1">{conflictWarning}</span>
                <button onClick={() => setConflictWarning(null)} className="shrink-0 text-[#92400e]/60 hover:text-[#92400e] font-bold">×</button>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <div className="mr-1.5 mt-1 flex-shrink-0">
                    <PatiSprite expression="amigavel" size={40} />
                  </div>
                )}
                <div className={`min-w-0 px-3 py-2 rounded-xl leading-relaxed break-words [overflow-wrap:anywhere] ${expanded ? 'max-w-[80%] text-[14px]' : 'max-w-[85%] text-[13px]'} ${
                  m.role === 'user'
                    ? 'bg-[#6366f1] text-white rounded-br-sm'
                    : 'bg-[#f7f8fa] text-[#0f1117] border border-gray-200 rounded-bl-sm'
                }`}>
                  <span dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                </div>
              </div>
            ))}

            {(status || progress) && (
              <div className="space-y-1.5">
                {progress && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#6366f1] rounded-full transition-all duration-300"
                        style={{ width: `${progress.pct}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-medium text-[#6366f1] tabular-nums whitespace-nowrap">
                      {progress.current}/{progress.total}
                    </span>
                  </div>
                )}
                {status && (
                  <div className="flex items-center gap-2 text-[12px] text-[#6b7280]">
                    <PatiSprite expression="pensando" size={28} className="animate-pulse" />
                    {status}
                  </div>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Suggestions */}
          {messages.length <= 2 && !streaming && (
            <div className="px-4 pb-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(s)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-[#6b7280] hover:text-[#6366f1] hover:border-[#6366f1] transition-colors cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="px-3 py-3 border-t border-gray-200 bg-[#f7f8fa]">
            <div className="flex items-end gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2 focus-within:border-[#6366f1] focus-within:ring-2 focus-within:ring-[#6366f1]/10 transition-all">
              <textarea
                ref={inputRef}
                rows={1}
                placeholder="Pergunte à PATi..."
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                disabled={streaming}
                maxLength={1000}
                className="flex-1 resize-none bg-transparent text-[13px] text-[#0f1117] placeholder-[#9ca3af] outline-none leading-relaxed py-1 max-h-[240px] overflow-y-auto scrollbar-thin"
              />
              {streaming ? (
                <button onClick={handleStop} className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#dc2626] text-white cursor-pointer hover:bg-[#ef4444] transition-colors shrink-0" title="Parar">
                  <svg width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12" rx="2" fill="currentColor"/></svg>
                </button>
              ) : (
                <button
                  onClick={() => sendMessage()}
                  disabled={!input.trim()}
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#6366f1] text-white disabled:opacity-30 cursor-pointer hover:bg-[#4f46e5] transition-colors shrink-0"
                  title="Enviar"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
