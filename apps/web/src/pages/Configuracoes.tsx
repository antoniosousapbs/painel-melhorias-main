import { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchConfig, updateConfig, fetchPrompt, updatePrompt, fetchApfParams, updateApfParams, fetchApfDiretrizes, updateApfDiretriz, ApfDiretriz, fetchKnowledge, addKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry, fetchUsers, addUser, updateUserRole, deleteUser, fetchProjects, UserRoleEntry, fetchLlmProviders, addLlmProvider, updateLlmProvider, deleteLlmProvider, testLlmProvider, fetchLlmUsoConfig, updateLlmUsoConfig, LlmProvider, LlmUsoConfigItem, LlmFinalidade, LlmKind } from '../services/api';
import { useCurrentUser } from '../auth/RoleContext';

// ── tiny reusable pieces ────────────────────────────────────────────
const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`bg-surface border border-border rounded-[10px] shadow-sm p-6 ${className}`}>{children}</div>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-[13px] font-semibold text-txt mb-1">{children}</h3>
);

const Desc = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[12px] text-txt-3 mb-4">{children}</p>
);

const Btn = ({
  onClick, disabled, variant = 'primary', size = 'md', children,
}: {
  onClick: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'success' | 'danger'; size?: 'md' | 'sm';
  children: React.ReactNode;
}) => {
  const base = 'rounded-md font-medium transition-colors duration-150 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed';
  const sizes = {
    md: 'h-9 px-4 text-[13px]',
    sm: 'h-7 px-2.5 text-[12px]',
  };
  const styles = {
    primary: 'border border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8] hover:bg-[#dbeafe]',
    secondary: 'border border-border bg-surface text-txt-2 hover:bg-surface-2',
    success: 'border border-[#86efac] bg-[#f0fdf4] text-[#15803d] hover:bg-[#dcfce7]',
    danger: 'border border-[#fca5a5] bg-[#fef2f2] text-[#b91c1c] hover:bg-[#fee2e2]',
  };
  return <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${styles[variant]}`}>{children}</button>;
};

const StatusDot = ({ ok }: { ok: boolean }) => (
  <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${ok ? 'bg-[#22c55e]' : 'bg-[#ef4444]'}`} />
);

const Tag = ({ label, onRemove }: { label: string; onRemove: () => void }) => (
  <span className="inline-flex items-center gap-1 h-7 pl-3 pr-1.5 bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe] rounded-full text-[12px] font-medium">
    {label}
    <button onClick={onRemove} className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-[#bfdbfe] text-[#1d4ed8] cursor-pointer">×</button>
  </span>
);

const Toast = ({ message, type, onDone }: { message: string; type: 'ok' | 'err'; onDone: () => void }) => {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-[13px] font-medium
      ${type === 'ok' ? 'bg-[#f0fdf4] text-[#15803d] border border-[#86efac]' : 'bg-[#fef2f2] text-[#b91c1c] border border-[#fca5a5]'}`}>
      {type === 'ok' ? '✓' : '✗'} {message}
    </div>
  );
};

// ── ícones de linha custom (mesmo traço do botão de sync: stroke 2, cantos arredondados) ──
type IconProps = { className?: string };
const IconUsers = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M8.5 11a3.25 3.25 0 100-6.5 3.25 3.25 0 000 6.5zM2.5 19.5c0-3 2.7-5 6-5s6 2 6 5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M15.5 5.2a3.25 3.25 0 010 5.6M18.2 19.5c0-2.5-1.9-4.3-4.2-4.9" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconLayers = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8 12 3.5z" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconQuery = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="10.5" cy="10.5" r="6.5"/>
    <path d="M8 9h5M8 12h3.5M15.3 15.3L21 21" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconSpark = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 3.5c.5 3 2 4.5 5 5-3 .5-4.5 2-5 5-.5-3-2-4.5-5-5 3-.5 4.5-2 5-5z" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18.5 14.5c.3 1.5 1 2.2 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.3 2.2-1 2.5-2.5z" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconSliders = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 6h9M17 6h3M4 12h3M9 12h11M4 18h13M21 18h-1" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="13" cy="6" r="2"/>
    <circle cx="6" cy="12" r="2"/>
    <circle cx="18" cy="18" r="2"/>
  </svg>
);
const IconBook = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 6.5c-1.5-1.2-3.6-1.8-5.8-1.8-.9 0-1.7.6-1.7 1.5v11c0 .9.8 1.4 1.7 1.4 2.2 0 4.3.6 5.8 1.9M12 6.5c1.5-1.2 3.6-1.8 5.8-1.8.9 0 1.7.6 1.7 1.5v11c0 .9-.8 1.4-1.7 1.4-2.2 0-4.3.6-5.8 1.9M12 6.5v13" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconGear = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6L6 18M18 18l-1.4-1.4M7.4 7.4L6 6" strokeLinecap="round"/>
  </svg>
);
const IconPencil = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 20l.9-3.8L15.5 5.6a1.8 1.8 0 012.6 0l1.3 1.3a1.8 1.8 0 010 2.6L8.8 20l-4.1.9a.7.7 0 01-.7-.9z" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M13.7 7.4l2.9 2.9" strokeLinecap="round"/>
  </svg>
);
const IconTrash = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4.5 7h15M9.5 7V5.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2V7M18.3 7l-.7 12.1a1.8 1.8 0 01-1.8 1.7H8.2a1.8 1.8 0 01-1.8-1.7L5.7 7" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M10 10.8v6M14 10.8v6" strokeLinecap="round"/>
  </svg>
);
const IconEye = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2.5 12S5.8 6 12 6s9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6z" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="12" cy="12" r="2.6"/>
  </svg>
);
const IconEyeOff = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3.5 3.5l17 17M9.9 9.9a2.6 2.6 0 003.6 3.6M6.3 6.5C4 8.1 2.5 12 2.5 12s3.3 6 9.5 6c1.6 0 3-.4 4.1-1M17.9 16c2.1-1.6 3.6-4 3.6-4s-3.3-6-9.5-6c-.5 0-1 0-1.5.1" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconTarget = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="8.5"/>
    <circle cx="12" cy="12" r="4.5"/>
    <circle cx="12" cy="12" r="0.9" fill="currentColor"/>
  </svg>
);
const IconCpu = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="6" y="6" width="12" height="12" rx="1.5"/>
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.8"/>
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 5l-2 2M5 19l2-2M17 19l-2-2" strokeLinecap="round"/>
  </svg>
);

// ── seções do rail de navegação ─────────────────────────────────────
type SectionId = 'usuarios' | 'projetos' | 'wiql' | 'prompt' | 'apf' | 'diretrizes' | 'modelos-ia' | 'conhecimento' | 'outras';
const SECTIONS: { id: SectionId; label: string; Icon: (props: IconProps) => JSX.Element }[] = [
  { id: 'usuarios', label: 'Usuários & Papéis', Icon: IconUsers },
  { id: 'projetos', label: 'Projetos DevOps', Icon: IconLayers },
  { id: 'wiql', label: 'Consulta WIQL', Icon: IconQuery },
  { id: 'prompt', label: 'Prompt de Classificação IA', Icon: IconSpark },
  { id: 'apf', label: 'Parâmetros APF', Icon: IconSliders },
  { id: 'diretrizes', label: 'Diretrizes de Contagem', Icon: IconTarget },
  { id: 'modelos-ia', label: 'Modelos de IA', Icon: IconCpu },
  { id: 'conhecimento', label: 'Base de Conhecimento', Icon: IconBook },
  { id: 'outras', label: 'Outras Configurações', Icon: IconGear },
];

// ── main component ──────────────────────────────────────────────────
export default function Configuracoes() {
  const [activeSection, setActiveSection] = useState<SectionId>('usuarios');

  // state
  const [configs, setConfigs] = useState<any[]>([]);
  const [prompt, setPrompt] = useState<any>(null);
  const [toast, setToast] = useState<{ message: string; type: 'ok' | 'err' } | null>(null);

  // config editing
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // wiql
  const [editingWiql, setEditingWiql] = useState(false);
  const [wiqlValue, setWiqlValue] = useState('');

  // projects
  const [editingProjects, setEditingProjects] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [newProject, setNewProject] = useState('');

  // prompt
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState('');
  const [promptAtivo, setPromptAtivo] = useState(true);

  // APF Parameters
  const [apfParams, setApfParams] = useState<any>(null);
  const [editingApf, setEditingApf] = useState(false);
  const [apfForm, setApfForm] = useState<Record<string, number>>({});

  // Diretrizes de Contagem APF por projeto
  const [diretrizes, setDiretrizes] = useState<ApfDiretriz[]>([]);
  const [editingDiretriz, setEditingDiretriz] = useState<string | null>(null);
  const [diretrizValue, setDiretrizValue] = useState('');

  // Knowledge Base
  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [kbAdding, setKbAdding] = useState(false);
  const [kbEditing, setKbEditing] = useState<number | null>(null);
  const [kbForm, setKbForm] = useState({ categoria: 'modulo', titulo: '', conteudo: '', tags: '' });

  // Modelos de IA (providers de LLM)
  const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
  const [llmUso, setLlmUso] = useState<LlmUsoConfigItem[]>([]);
  const [llmAdding, setLlmAdding] = useState(false);
  const [llmEditing, setLlmEditing] = useState<number | null>(null);
  const [llmForm, setLlmForm] = useState<{ nome: string; kind: LlmKind; apiUrl: string; apiKey: string; modelName: string; apiVersion: string; ativo: boolean }>({ nome: '', kind: 'openai-compatible', apiUrl: '', apiKey: '', modelName: '', apiVersion: '', ativo: true });
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmUsoSaved, setLlmUsoSaved] = useState<LlmFinalidade | null>(null);

  // Usuários & Papéis
  const { user: currentUser } = useCurrentUser();
  const [users, setUsers] = useState<UserRoleEntry[]>([]);
  const [allProjects, setAllProjects] = useState<string[]>([]);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<'Admin' | 'Operador'>('Operador');
  const [newUserProjects, setNewUserProjects] = useState<string[]>([]);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editingUserProjects, setEditingUserProjects] = useState<string[]>([]);
  const [userSearch, setUserSearch] = useState('');

  // ── load ─────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const [c, p] = await Promise.all([fetchConfig(), fetchPrompt()]);
    setConfigs(c);
    setPrompt(p);

    const wiql = c.find((x: any) => x.Chave === 'wiql_query');
    if (wiql) setWiqlValue(wiql.Valor);

    const proj = c.find((x: any) => x.Chave === 'devops_projects');
    if (proj) setProjects(proj.Valor ? proj.Valor.split(',').map((s: string) => s.trim()).filter(Boolean) : []);

    if (p) { setPromptValue(p.Template); setPromptAtivo(p.Ativo); }

    // Load APF params
    try {
      const apf = await fetchApfParams();
      setApfParams(apf);
      setApfForm(apf);
    } catch { /* ignore */ }

    // Load diretrizes de contagem APF por projeto
    try {
      const d = await fetchApfDiretrizes();
      setDiretrizes(d);
    } catch { /* ignore */ }

    // Load knowledge base
    try {
      const kb = await fetchKnowledge();
      setKnowledge(kb);
    } catch { /* ignore */ }

    // Load LLM providers + atribuição por finalidade
    try {
      const [providers, uso] = await Promise.all([fetchLlmProviders(), fetchLlmUsoConfig()]);
      setLlmProviders(providers);
      setLlmUso(uso);
    } catch { /* ignore */ }

    // Load users
    try {
      const u = await fetchUsers();
      setUsers(u);
    } catch { /* ignore */ }

    // Load projects DevOps configurados (para o seletor de acesso por usuário)
    try {
      const pr = await fetchProjects();
      setAllProjects(pr);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const notify = (message: string, type: 'ok' | 'err' = 'ok') => setToast({ message, type });

  // ── handlers ─────────────────────────────────────────────────
  const handleSaveWiql = async () => {
    try {
      await updateConfig('wiql_query', wiqlValue);
      setEditingWiql(false);
      notify('Query WIQL salva');
      await load();
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleSaveProjects = async () => {
    try {
      await updateConfig('devops_projects', projects.join(', '));
      setEditingProjects(false);
      notify('Projetos salvos');
      await load();
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleAddProject = () => {
    const v = newProject.trim();
    if (v && !projects.includes(v)) setProjects([...projects, v]);
    setNewProject('');
  };

  const handleSavePrompt = async () => {
    try {
      await updatePrompt(promptValue, promptAtivo);
      setEditingPrompt(false);
      notify('Prompt salvo');
      await load();
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleSaveApfParams = async () => {
    try {
      const updated = await updateApfParams(apfForm);
      setApfParams(updated);
      setEditingApf(false);
      notify('Parâmetros APF salvos');
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleSaveDiretriz = async (projectCode: string) => {
    try {
      const updated = await updateApfDiretriz(projectCode, diretrizValue);
      setDiretrizes(updated);
      setEditingDiretriz(null);
      notify('Diretriz salva');
    } catch (e: any) { notify(e.message, 'err'); }
  };

  // Modelos de IA handlers
  const resetLlmForm = () => setLlmForm({ nome: '', kind: 'openai-compatible', apiUrl: '', apiKey: '', modelName: '', apiVersion: '', ativo: true });

  const handleAddLlmProvider = async () => {
    try {
      const updated = await addLlmProvider(llmForm);
      setLlmProviders(updated);
      setLlmAdding(false);
      resetLlmForm();
      setLlmTestResult(null);
      notify('Provider adicionado');
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleUpdateLlmProvider = async (id: number) => {
    try {
      const updated = await updateLlmProvider(id, llmForm);
      setLlmProviders(updated);
      setLlmEditing(null);
      resetLlmForm();
      setLlmTestResult(null);
      notify('Provider atualizado');
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleDeleteLlmProvider = async (id: number) => {
    if (!confirm('Remover este provider? Finalidades que o usam ficarão sem atribuição.')) return;
    try {
      const updated = await deleteLlmProvider(id);
      setLlmProviders(updated);
      const uso = await fetchLlmUsoConfig();
      setLlmUso(uso);
      notify('Provider removido');
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleTestLlmProvider = async (data: { id?: number }) => {
    setLlmTesting(true);
    setLlmTestResult(null);
    try {
      // Se estiver editando e a chave foi deixada em branco (mantém a atual), testa o provider
      // já salvo (por id) em vez dos dados do formulário — senão sempre falharia por "chave vazia".
      const useSavedId = data.id ?? (llmEditing !== null && !llmForm.apiKey.trim() ? llmEditing : undefined);
      const result = useSavedId ? await testLlmProvider({ id: useSavedId }) : await testLlmProvider(llmForm);
      setLlmTestResult(result);
      notify(result.message, result.ok ? 'ok' : 'err');
    } catch (e: any) {
      setLlmTestResult({ ok: false, message: e.message });
      notify(e.message, 'err');
    } finally {
      setLlmTesting(false);
    }
  };

  const handleChangeLlmUso = async (finalidade: LlmFinalidade, providerId: number | null, fallbackProviderId: number | null) => {
    try {
      const updated = await updateLlmUsoConfig(finalidade, providerId, fallbackProviderId);
      setLlmUso(updated);
      notify('Atribuição salva');
      setLlmUsoSaved(finalidade);
      setTimeout(() => setLlmUsoSaved(cur => cur === finalidade ? null : cur), 2000);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  // Knowledge Base handlers
  const handleAddKnowledge = async () => {
    try {
      await addKnowledgeEntry(kbForm);
      setKbAdding(false);
      setKbForm({ categoria: 'modulo', titulo: '', conteudo: '', tags: '' });
      notify('Conhecimento adicionado');
      const kb = await fetchKnowledge();
      setKnowledge(kb);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleUpdateKnowledge = async (id: number) => {
    try {
      await updateKnowledgeEntry(id, kbForm);
      setKbEditing(null);
      setKbForm({ categoria: 'modulo', titulo: '', conteudo: '', tags: '' });
      notify('Conhecimento atualizado');
      const kb = await fetchKnowledge();
      setKnowledge(kb);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleDeleteKnowledge = async (id: number) => {
    if (!confirm('Remover este conhecimento?')) return;
    try {
      await deleteKnowledgeEntry(id);
      notify('Conhecimento removido');
      const kb = await fetchKnowledge();
      setKnowledge(kb);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleToggleKnowledge = async (id: number, currentAtivo: boolean) => {
    try {
      await updateKnowledgeEntry(id, { ativo: !currentAtivo });
      const kb = await fetchKnowledge();
      setKnowledge(kb);
      notify(currentAtivo ? 'Desativado' : 'Ativado');
    } catch (e: any) { notify(e.message, 'err'); }
  };

  // Usuários & Papéis handlers
  const handleAddUser = async () => {
    const email = newUserEmail.trim().toLowerCase();
    if (!email) return;
    try {
      await addUser(email, newUserRole, newUserRole === 'Operador' ? newUserProjects : undefined);
      setNewUserEmail('');
      setNewUserRole('Operador');
      setNewUserProjects([]);
      notify('Usuário adicionado');
      const u = await fetchUsers();
      setUsers(u);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleChangeUserRole = async (id: number, role: 'Admin' | 'Operador') => {
    try {
      await updateUserRole(id, role);
      notify('Papel atualizado');
      const u = await fetchUsers();
      setUsers(u);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleSaveUserProjects = async (id: number, role: 'Admin' | 'Operador') => {
    try {
      await updateUserRole(id, role, editingUserProjects);
      setEditingUserId(null);
      notify('Projetos atualizados');
      const u = await fetchUsers();
      setUsers(u);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleDeleteUser = async (id: number) => {
    if (!confirm('Remover este usuário?')) return;
    try {
      await deleteUser(id);
      notify('Usuário removido');
      const u = await fetchUsers();
      setUsers(u);
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const handleSaveConfig = async (chave: string) => {
    try {
      await updateConfig(chave, editValue);
      setEditingKey(null);
      notify(`${chave} salvo`);
      await load();
    } catch (e: any) { notify(e.message, 'err'); }
  };

  const startEditConfig = (chave: string, valor: string) => {
    setEditingKey(chave);
    setEditValue(valor || '');
  };

  // ── render ───────────────────────────────────────────────────
  const wiqlConfig = configs.find((c: any) => c.Chave === 'wiql_query');
  const projConfig = configs.find((c: any) => c.Chave === 'devops_projects');
  const otherConfigs = configs.filter((c: any) => c.Chave !== 'wiql_query' && c.Chave !== 'devops_projects');

  // Usuários filtrados (por nome/e-mail) e agrupados por papel (Admin primeiro, depois Operador)
  const filteredUsers = useMemo(() => {
    const term = userSearch.trim().toLowerCase();
    if (!term) return users;
    return users.filter(u =>
      (u.Nome || '').toLowerCase().includes(term) || u.Email.toLowerCase().includes(term)
    );
  }, [users, userSearch]);

  const usersByRole = useMemo(() => {
    const admins = filteredUsers.filter(u => u.Role === 'Admin');
    const operadores = filteredUsers.filter(u => u.Role === 'Operador');
    return [
      { role: 'Admin' as const, items: admins },
      { role: 'Operador' as const, items: operadores },
    ].filter(g => g.items.length > 0);
  }, [filteredUsers]);

  return (
    <>
    <div className="flex gap-6 items-start">
      {/* ─── Rail lateral de navegação ─── */}
      <aside className="w-[224px] shrink-0 sticky top-[100px]">
        <h2 className="text-[15px] font-semibold tracking-tight text-txt mb-4 px-1">Configurações</h2>
        <nav className="space-y-0.5">
          {SECTIONS.filter(s => s.id !== 'outras' || otherConfigs.length > 0).map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={`w-full flex items-center gap-2.5 h-9 px-3 rounded-md text-[13px] font-medium text-left transition-colors duration-150 cursor-pointer ${
                activeSection === s.id ? 'bg-[#eff6ff] text-[#1d4ed8]' : 'text-txt-2 hover:bg-surface-2'
              }`}
            >
              <s.Icon className="w-[16px] h-[16px] shrink-0" />
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* ─── Conteúdo da seção selecionada ─── */}
      <div className="flex-1 min-w-0 space-y-4">

      {/* ═══ Projetos DevOps ═══ */}
      {activeSection === 'projetos' && (
      <Card>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Projetos DevOps</SectionTitle>
          {!editingProjects ? (
            <Btn onClick={() => setEditingProjects(true)} variant="secondary"><span className="inline-flex items-center gap-1.5"><IconPencil className="w-3.5 h-3.5" /> Editar</span></Btn>
          ) : (
            <div className="flex gap-2">
              <Btn onClick={handleSaveProjects}>Salvar</Btn>
              <Btn onClick={() => { setEditingProjects(false); load(); }} variant="secondary">Cancelar</Btn>
            </div>
          )}
        </div>
        <Desc>Projetos do Azure DevOps incluídos na sincronização. Remover um projeto exclui seus itens na próxima sync.</Desc>

        <div className="flex flex-wrap gap-2">
          {projects.map(p => (
            <Tag key={p} label={p} onRemove={() => editingProjects && setProjects(projects.filter(x => x !== p))} />
          ))}
          {projects.length === 0 && <span className="text-[12px] text-txt-3 italic">Todos os projetos (sem filtro)</span>}
        </div>

        {editingProjects && (
          <div className="flex items-center gap-2 mt-3">
            <input
              value={newProject} onChange={e => setNewProject(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddProject()}
              placeholder="Nome do projeto (ex: SRM.wbc7srm)"
              className="flex-1 h-9 px-3 border border-border rounded-md text-[13px] bg-bg focus-ring"
            />
            <Btn onClick={handleAddProject} variant="secondary">+ Adicionar</Btn>
          </div>
        )}
      </Card>
      )}

      {/* ═══ Consulta WIQL ═══ */}
      {activeSection === 'wiql' && (
      <Card>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Query WIQL</SectionTitle>
          {!editingWiql ? (
            <Btn onClick={() => setEditingWiql(true)} variant="secondary"><span className="inline-flex items-center gap-1.5"><IconPencil className="w-3.5 h-3.5" /> Editar</span></Btn>
          ) : (
            <div className="flex gap-2">
              <Btn onClick={handleSaveWiql}>Salvar</Btn>
              <Btn onClick={() => { setEditingWiql(false); setWiqlValue(wiqlConfig?.Valor || ''); }} variant="secondary">Cancelar</Btn>
            </div>
          )}
        </div>
        <Desc>Query base enviada ao Azure DevOps. Filtros adicionais aplicados automaticamente: itens com state <strong>Canceled</strong> são excluídos mesmo que retornados pela query.</Desc>

        {editingWiql ? (
          <textarea
            className="w-full border border-border rounded-md p-3 text-[13px] font-mono bg-bg focus-ring resize-y"
            rows={4} value={wiqlValue} onChange={e => setWiqlValue(e.target.value)}
          />
        ) : (
          <pre className="bg-surface-2 border border-border rounded-md p-3 text-[12px] font-mono text-txt-2 whitespace-pre-wrap break-all">
            {wiqlValue || '—'}
          </pre>
        )}
      </Card>
      )}

      {/* ═══ Prompt de Classificação IA ═══ */}
      {activeSection === 'prompt' && (
      <Card>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <SectionTitle>Prompt de Classificação IA</SectionTitle>
            {prompt && (
              <span className={`text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full
                ${promptAtivo ? 'bg-[#f0fdf4] text-[#15803d] border border-[#86efac]' : 'bg-[#fef2f2] text-[#b91c1c] border border-[#fca5a5]'}`}>
                {promptAtivo ? 'Ativo' : 'Inativo'}
              </span>
            )}
          </div>
          {!editingPrompt ? (
            <Btn onClick={() => setEditingPrompt(true)} variant="secondary"><span className="inline-flex items-center gap-1.5"><IconPencil className="w-3.5 h-3.5" /> Editar</span></Btn>
          ) : (
            <div className="flex gap-2">
              <Btn onClick={handleSavePrompt}>Salvar</Btn>
              <Btn onClick={() => { setEditingPrompt(false); if (prompt) { setPromptValue(prompt.Template); setPromptAtivo(prompt.Ativo); } }} variant="secondary">Cancelar</Btn>
            </div>
          )}
        </div>
        <Desc>
          Template enviado ao LLM para classificar cada chamado. Use <code className="text-[11px] bg-surface-2 px-1 py-0.5 rounded">{'{{TITULO}}'}</code> para o título e <code className="text-[11px] bg-surface-2 px-1 py-0.5 rounded">{'{{DESCRICAO}}'}</code> para a descrição do chamado.
        </Desc>

        {editingPrompt ? (
          <>
            <div className="flex items-center gap-3 mb-3">
              <label className="text-[12px] text-txt-2 flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox" checked={promptAtivo} onChange={e => setPromptAtivo(e.target.checked)}
                  className="w-4 h-4 rounded border-border"
                />
                Prompt ativo
              </label>
            </div>
            <textarea
              className="w-full border border-border rounded-md p-3 text-[13px] font-mono bg-bg focus-ring resize-y"
              rows={14} value={promptValue} onChange={e => setPromptValue(e.target.value)}
            />
          </>
        ) : (
          <pre className="bg-surface-2 border border-border rounded-md p-3 text-[12px] font-mono text-txt-2 whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto">
            {promptValue || '—'}
          </pre>
        )}
        {prompt?.AtualizadoEm && (
          <div className="mt-2 text-[11px] text-txt-3">
            Atualizado em {new Date(prompt.AtualizadoEm).toLocaleString('pt-BR')}
          </div>
        )}
      </Card>
      )}

      {/* ═══ Outras Configurações ═══ */}
      {activeSection === 'outras' && otherConfigs.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="text-[13px] font-semibold text-txt">Outras Configurações</h3>
          </div>
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 border-b border-border">
              <tr>
                <th className="text-left px-[14px] py-[10px] text-[11px] font-semibold uppercase tracking-[.05em] text-txt-3 w-[180px]">Chave</th>
                <th className="text-left px-[14px] py-[10px] text-[11px] font-semibold uppercase tracking-[.05em] text-txt-3">Valor</th>
                <th className="text-left px-[14px] py-[10px] text-[11px] font-semibold uppercase tracking-[.05em] text-txt-3 w-[160px]">Atualizado</th>
                <th className="text-right px-[14px] py-[10px] text-[11px] font-semibold uppercase tracking-[.05em] text-txt-3 w-[80px]"></th>
              </tr>
            </thead>
            <tbody>
              {otherConfigs.map((c: any) => (
                <tr key={c.Chave} className="border-b border-border last:border-0 hover:bg-[#f5f7ff] transition-colors duration-100">
                  <td className="px-[14px] py-[10px] font-mono text-[12px] text-txt-3">{c.Chave}</td>
                  <td className="px-[14px] py-[10px]">
                    {editingKey === c.Chave ? (
                      <input
                        value={editValue} onChange={e => setEditValue(e.target.value)}
                        className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring"
                        autoFocus
                        onKeyDown={e => { if (e.key === 'Enter') handleSaveConfig(c.Chave); if (e.key === 'Escape') setEditingKey(null); }}
                      />
                    ) : (
                      <span className="text-txt-2 text-[12px] break-all">{c.Valor || '—'}</span>
                    )}
                  </td>
                  <td className="px-[14px] py-[10px] text-[12px] text-txt-3">
                    {c.AtualizadoEm ? new Date(c.AtualizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="px-[14px] py-[10px] text-right">
                    {editingKey === c.Chave ? (
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => handleSaveConfig(c.Chave)} className="text-[12px] text-[#1d4ed8] font-medium hover:underline cursor-pointer">Salvar</button>
                        <button onClick={() => setEditingKey(null)} className="text-[12px] text-txt-3 hover:underline cursor-pointer">✗</button>
                      </div>
                    ) : (
                      <button onClick={() => startEditConfig(c.Chave, c.Valor)} className="w-6 h-6 inline-flex items-center justify-center text-txt-3 hover:text-[#1d4ed8] cursor-pointer"><IconPencil className="w-3.5 h-3.5" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* ═══ Parâmetros APF ═══ */}
      {activeSection === 'apf' && apfParams && (
        <Card>
          <SectionTitle>Parâmetros APF (Análise de Pontos de Função)</SectionTitle>
          <Desc>Configuração global de produtividade, deflators e ciclo produtivo usados pela PATi na geração de documentos APF.</Desc>

          {!editingApf ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-[12px]">
                <div className="bg-surface-2 rounded-md p-3 border border-border">
                  <div className="text-txt-3 text-[10px] uppercase tracking-wide mb-1">Produtividade</div>
                  <div className="font-semibold text-txt">{apfParams.Produtividade} H/PF</div>
                </div>
                <div className="bg-surface-2 rounded-md p-3 border border-border">
                  <div className="text-txt-3 text-[10px] uppercase tracking-wide mb-1">Deflator Inclusão</div>
                  <div className="font-semibold text-txt">{apfParams.DeflatorInclusao}</div>
                </div>
                <div className="bg-surface-2 rounded-md p-3 border border-border">
                  <div className="text-txt-3 text-[10px] uppercase tracking-wide mb-1">Deflator Alteração</div>
                  <div className="font-semibold text-txt">{apfParams.DeflatorAlteracao}</div>
                </div>
              </div>
              <div className="grid grid-cols-6 gap-2 text-[11px]">
                {[
                  ['Gestão', apfParams.CicloGestao],
                  ['Análise Negócio', apfParams.CicloAnaliseNegocio],
                  ['Análise Testes', apfParams.CicloAnaliseTestes],
                  ['Codificação', apfParams.CicloCodificacao],
                  ['Execução Testes', apfParams.CicloExecucaoTestes],
                  ['Homologação', apfParams.CicloHomologacao],
                ].map(([label, val]) => (
                  <div key={label as string} className="text-center bg-[#f8faff] border border-border rounded p-2">
                    <div className="text-txt-3 text-[9px] uppercase">{label}</div>
                    <div className="font-semibold text-txt">{val}%</div>
                  </div>
                ))}
              </div>
              <Btn onClick={() => { setApfForm(apfParams); setEditingApf(true); }} variant="secondary">Editar Parâmetros</Btn>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                {[
                  ['Produtividade', 'Produtividade', 'H/PF'],
                  ['Deflator Inclusão', 'DeflatorInclusao', ''],
                  ['Deflator Alteração', 'DeflatorAlteracao', ''],
                  ['Deflator Exclusão', 'DeflatorExclusao', ''],
                ].map(([label, key, suffix]) => (
                  <div key={key}>
                    <label className="text-[11px] text-txt-3 block mb-1">{label} {suffix && <span className="text-txt-3">({suffix})</span>}</label>
                    <input type="number" step="0.01" value={apfForm[key] ?? ''} onChange={e => setApfForm({ ...apfForm, [key]: parseFloat(e.target.value) || 0 })}
                      className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring" />
                  </div>
                ))}
              </div>
              <div className="text-[11px] font-medium text-txt-3 mt-2">Ciclo Produtivo (%)</div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  ['Gestão', 'CicloGestao'],
                  ['Análise Negócio', 'CicloAnaliseNegocio'],
                  ['Análise Testes', 'CicloAnaliseTestes'],
                  ['Codificação', 'CicloCodificacao'],
                  ['Execução Testes', 'CicloExecucaoTestes'],
                  ['Homologação', 'CicloHomologacao'],
                ].map(([label, key]) => (
                  <div key={key}>
                    <label className="text-[11px] text-txt-3 block mb-1">{label}</label>
                    <input type="number" step="0.5" value={apfForm[key] ?? ''} onChange={e => setApfForm({ ...apfForm, [key]: parseFloat(e.target.value) || 0 })}
                      className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring" />
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                <Btn onClick={handleSaveApfParams} variant="success">Salvar</Btn>
                <Btn onClick={() => setEditingApf(false)} variant="secondary">Cancelar</Btn>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ═══ Diretrizes de Contagem APF por Projeto ═══ */}
      {activeSection === 'diretrizes' && (
        <Card>
          <SectionTitle>Diretrizes de Contagem</SectionTitle>
          <Desc>
            Contexto de negócio, em linguagem simples, sobre como cada projeto organiza seus produtos/processos.
            Serve apenas como apoio para a IA entender o domínio — as regras de complexidade IFPUG sempre prevalecem
            na contagem final de pontos de função.
          </Desc>

          {allProjects.length === 0 ? (
            <div className="text-[12px] text-txt-3">Nenhum projeto DevOps configurado ainda.</div>
          ) : (
            <div className="space-y-4">
              {allProjects.map(projectCode => {
                const existing = diretrizes.find(d => d.ProjectCode === projectCode);
                const isEditing = editingDiretriz === projectCode;
                return (
                  <div key={projectCode} className="border border-border rounded-md p-4 bg-surface-2">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[13px] font-semibold text-txt">{projectCode}</div>
                      {!isEditing ? (
                        <Btn onClick={() => { setEditingDiretriz(projectCode); setDiretrizValue(existing?.Diretriz || ''); }} variant="secondary" size="sm">
                          <span className="inline-flex items-center gap-1.5"><IconPencil className="w-3.5 h-3.5" /> Editar</span>
                        </Btn>
                      ) : (
                        <div className="flex gap-2">
                          <Btn onClick={() => handleSaveDiretriz(projectCode)} size="sm">Salvar</Btn>
                          <Btn onClick={() => setEditingDiretriz(null)} variant="secondary" size="sm">Cancelar</Btn>
                        </div>
                      )}
                    </div>
                    {isEditing ? (
                      <textarea
                        className="w-full border border-border rounded-md p-3 text-[13px] bg-bg focus-ring resize-y"
                        rows={6} value={diretrizValue} onChange={e => setDiretrizValue(e.target.value)}
                        placeholder="Ex.: Este projeto trata cotações e pedidos de compra integrados ao ERP TOTVS. Fluxos de aprovação seguem alçadas por valor. Telas seguem padrão mestre-detalhe..."
                      />
                    ) : (
                      <div className="text-[12px] text-txt-2 whitespace-pre-wrap">
                        {existing?.Diretriz || <span className="text-txt-3">Nenhuma diretriz configurada para este projeto.</span>}
                      </div>
                    )}
                    {existing?.AtualizadoEm && !isEditing && (
                      <div className="mt-2 text-[11px] text-txt-3">
                        Atualizado em {new Date(existing.AtualizadoEm).toLocaleString('pt-BR')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* ═══ Modelos de IA (providers de LLM) ═══ */}
      {activeSection === 'modelos-ia' && (
      <Card>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Modelos de IA</SectionTitle>
          <Btn onClick={() => { setLlmAdding(true); setLlmEditing(null); resetLlmForm(); setLlmTestResult(null); }} variant="primary">+ Adicionar</Btn>
        </div>
        <Desc>
          Provedores/modelos de IA disponíveis (URL, chave e modelo). Cada finalidade da aplicação (chat, classificação,
          geração de APF, refinamento, especificação) pode usar um provider diferente, com um fallback automático caso o
          principal falhe.
        </Desc>

        {/* Add/Edit form */}
        {(llmAdding || llmEditing !== null) && (
          <div className="border border-[#bfdbfe] bg-[#f8faff] rounded-lg p-4 mb-4 space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-2">
                <label className="text-[11px] text-txt-3 block mb-1">Nome</label>
                <input value={llmForm.nome} onChange={e => setLlmForm({ ...llmForm, nome: e.target.value })}
                  className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring" placeholder="Ex: GPT-5.4 (Azure AI Foundry)" />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] text-txt-3 block mb-1">Tipo</label>
                <select value={llmForm.kind} onChange={e => setLlmForm({ ...llmForm, kind: e.target.value as LlmKind })}
                  className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring">
                  <option value="openai-compatible">OpenAI-compatible (Groq, DeepSeek, OpenRouter, OpenAI)</option>
                  <option value="azure-ai-foundry">Azure AI Foundry (multi-modelo)</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="text-[11px] text-txt-3 block mb-1">URL da API</label>
                <input value={llmForm.apiUrl} onChange={e => setLlmForm({ ...llmForm, apiUrl: e.target.value })}
                  className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring font-mono" placeholder="https://..." />
              </div>
              <div>
                <label className="text-[11px] text-txt-3 block mb-1">Modelo</label>
                <input value={llmForm.modelName} onChange={e => setLlmForm({ ...llmForm, modelName: e.target.value })}
                  className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring font-mono" placeholder="gpt-5.4" />
              </div>
            </div>
            {llmForm.kind === 'azure-ai-foundry' && (
              <div>
                <label className="text-[11px] text-txt-3 block mb-1">
                  Versão da API (query param <code className="bg-surface-2 px-1 rounded">api-version</code>)
                </label>
                <input value={llmForm.apiVersion} onChange={e => setLlmForm({ ...llmForm, apiVersion: e.target.value })}
                  className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring font-mono" placeholder="2024-05-01-preview" />
                <p className="text-[11px] text-txt-3 mt-1">
                  Veja o valor correto na página "Deployments"/"Playground" do seu recurso no Azure AI Foundry → "View code".
                  Deixe em branco para usar o padrão (pode não funcionar em todos os recursos).
                </p>
              </div>
            )}
            <div>
              <label className="text-[11px] text-txt-3 block mb-1">
                Chave de API {llmEditing !== null && <span className="text-txt-3">(deixe em branco para manter a atual)</span>}
              </label>
              <input type="password" value={llmForm.apiKey} onChange={e => setLlmForm({ ...llmForm, apiKey: e.target.value })}
                className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring font-mono" placeholder="••••••••" />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[12px] text-txt-2 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={llmForm.ativo} onChange={e => setLlmForm({ ...llmForm, ativo: e.target.checked })} className="w-4 h-4 rounded border-border" />
                Ativo
              </label>
              <Btn onClick={() => handleTestLlmProvider({})} variant="secondary" size="sm">{llmTesting ? 'Testando...' : 'Testar conexão'}</Btn>
              {llmTestResult && (
                <span className={`text-[12px] ${llmTestResult.ok ? 'text-[#15803d]' : 'text-[#b91c1c]'}`}>
                  {llmTestResult.ok ? '✓ ' : '✗ '}{llmTestResult.message}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {llmEditing !== null ? (
                <Btn onClick={() => handleUpdateLlmProvider(llmEditing)} variant="success">Salvar</Btn>
              ) : (
                <Btn onClick={handleAddLlmProvider} variant="success">Adicionar</Btn>
              )}
              <Btn onClick={() => { setLlmAdding(false); setLlmEditing(null); setLlmTestResult(null); }} variant="secondary">Cancelar</Btn>
            </div>
          </div>
        )}

        {/* Providers list */}
        <div className="space-y-2 mb-6">
          {llmProviders.map(p => (
            <div key={p.Id} className="border border-border rounded-lg p-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-txt truncate">{p.Nome}</span>
                  <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-surface-2 text-txt-3">{p.Kind}</span>
                  {!p.Ativo && <span className="text-[10px] px-1.5 py-0.5 bg-[#fef2f2] text-[#b91c1c] rounded">inativo</span>}
                </div>
                <div className="text-[11px] text-txt-3 truncate font-mono">{p.ModelName} · {p.ApiUrl} · {p.ApiKeyMasked}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => handleTestLlmProvider({ id: p.Id })}
                  className="text-[11px] px-2 h-7 rounded hover:bg-surface-2 text-txt-2 cursor-pointer" title="Testar conexão">Testar</button>
                <button onClick={() => { setLlmEditing(p.Id); setLlmAdding(false); setLlmTestResult(null); setLlmForm({ nome: p.Nome, kind: p.Kind, apiUrl: p.ApiUrl, apiKey: '', modelName: p.ModelName, apiVersion: p.ApiVersion || '', ativo: p.Ativo }); }}
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 text-txt-2 cursor-pointer" title="Editar"><IconPencil className="w-4 h-4" /></button>
                <button onClick={() => handleDeleteLlmProvider(p.Id)}
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-[#fee2e2] text-txt-2 hover:text-[#b91c1c] cursor-pointer" title="Remover"><IconTrash className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
          {llmProviders.length === 0 && <div className="text-[12px] text-txt-3 text-center py-4">Nenhum provider cadastrado.</div>}
        </div>

        {/* Atribuição por finalidade */}
        <div className="text-[13px] font-semibold text-txt mb-2">Atribuição por finalidade</div>
        <Desc>Escolha o provider principal e um de fallback (usado automaticamente se o principal falhar) para cada finalidade. A troca é salva automaticamente ao selecionar.</Desc>
        <div className="space-y-2">
          {([
            ['chat', 'Chat (PATi)'],
            ['classificacao', 'Classificação automática'],
            ['apf_geracao', 'Geração de APF'],
            ['apf_refinamento', 'Refinamento de APF'],
            ['spec_geracao', 'Geração de Especificação'],
          ] as [LlmFinalidade, string][]).map(([finalidade, label]) => {
            const cfg = llmUso.find(u => u.Finalidade === finalidade);
            return (
              <div key={finalidade} className="flex items-center gap-3 border border-border rounded-md p-3 bg-surface-2">
                <div className="w-[200px] text-[12px] font-medium text-txt shrink-0 flex items-center gap-1.5">
                  {label}
                  {llmUsoSaved === finalidade && <span className="text-[10px] text-[#15803d]">✓ salvo</span>}
                </div>
                <select
                  value={cfg?.ProviderId ?? ''}
                  onChange={e => handleChangeLlmUso(finalidade, e.target.value ? parseInt(e.target.value) : null, cfg?.FallbackProviderId ?? null)}
                  className="flex-1 h-8 px-2 border border-border rounded-md text-[12px] bg-bg focus-ring"
                >
                  <option value="">— Nenhum —</option>
                  {llmProviders.map(p => <option key={p.Id} value={p.Id}>{p.Nome}</option>)}
                </select>
                <span className="text-[11px] text-txt-3">fallback</span>
                <select
                  value={cfg?.FallbackProviderId ?? ''}
                  onChange={e => handleChangeLlmUso(finalidade, cfg?.ProviderId ?? null, e.target.value ? parseInt(e.target.value) : null)}
                  className="flex-1 h-8 px-2 border border-border rounded-md text-[12px] bg-bg focus-ring"
                >
                  <option value="">— Nenhum —</option>
                  {llmProviders.map(p => <option key={p.Id} value={p.Id}>{p.Nome}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </Card>
      )}

      {/* ═══ Base de Conhecimento PATi ═══ */}
      {activeSection === 'conhecimento' && (
      <Card>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Base de Conhecimento PATi</SectionTitle>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-txt-3">{knowledge.length} entradas</span>
            <Btn onClick={() => { setKbAdding(true); setKbEditing(null); setKbForm({ categoria: 'modulo', titulo: '', conteudo: '', tags: '' }); }} variant="primary">+ Adicionar</Btn>
          </div>
        </div>
        <Desc>Conhecimentos que a PATi usa para contagens APF precisas. Entradas com origem "aprendido" são geradas automaticamente a partir de refinamentos.</Desc>

        {/* Add/Edit form */}
        {(kbAdding || kbEditing !== null) && (
          <div className="border border-[#bfdbfe] bg-[#f8faff] rounded-lg p-4 mb-4 space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-[11px] text-txt-3 block mb-1">Categoria</label>
                <select value={kbForm.categoria} onChange={e => setKbForm({ ...kbForm, categoria: e.target.value })}
                  className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring">
                  <option value="arquitetura">Arquitetura</option>
                  <option value="modulo">Módulo</option>
                  <option value="padrao_contagem">Padrão de Contagem</option>
                  <option value="aprendizado">Aprendizado</option>
                </select>
              </div>
              <div className="col-span-3">
                <label className="text-[11px] text-txt-3 block mb-1">Título</label>
                <input value={kbForm.titulo} onChange={e => setKbForm({ ...kbForm, titulo: e.target.value })}
                  className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring" placeholder="Título descritivo" />
              </div>
            </div>
            <div>
              <label className="text-[11px] text-txt-3 block mb-1">Conteúdo</label>
              <textarea value={kbForm.conteudo} onChange={e => setKbForm({ ...kbForm, conteudo: e.target.value })}
                className="w-full border border-border rounded-md p-3 text-[13px] bg-bg focus-ring resize-y" rows={3} placeholder="Informação detalhada..." />
            </div>
            <div>
              <label className="text-[11px] text-txt-3 block mb-1">Tags (separadas por vírgula)</label>
              <input value={kbForm.tags} onChange={e => setKbForm({ ...kbForm, tags: e.target.value })}
                className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring" placeholder="tag1,tag2,tag3" />
            </div>
            <div className="flex gap-2">
              {kbEditing !== null ? (
                <Btn onClick={() => handleUpdateKnowledge(kbEditing)} variant="success">Salvar</Btn>
              ) : (
                <Btn onClick={handleAddKnowledge} variant="success">Adicionar</Btn>
              )}
              <Btn onClick={() => { setKbAdding(false); setKbEditing(null); }} variant="secondary">Cancelar</Btn>
            </div>
          </div>
        )}

        {/* Knowledge entries table */}
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {knowledge.map((k: any) => (
            <div key={k.Id} className={`border rounded-lg p-3 transition-colors ${k.Ativo ? 'border-border bg-surface' : 'border-[#fca5a5] bg-[#fef2f2] opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                      k.Categoria === 'arquitetura' ? 'bg-[#ede9fe] text-[#6d28d9]' :
                      k.Categoria === 'modulo' ? 'bg-[#dbeafe] text-[#1d4ed8]' :
                      k.Categoria === 'padrao_contagem' ? 'bg-[#fef3c7] text-[#92400e]' :
                      'bg-[#d1fae5] text-[#065f46]'
                    }`}>{k.Categoria}</span>
                    <span className="text-[12px] font-medium text-txt truncate">{k.Titulo}</span>
                    {k.Origem === 'aprendido' && <span className="text-[10px] px-1.5 py-0.5 bg-[#d1fae5] text-[#065f46] rounded">auto</span>}
                  </div>
                  <p className="text-[11px] text-txt-2 line-clamp-2">{k.Conteudo}</p>
                  {k.Tags && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {k.Tags.split(',').map((t: string) => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 bg-surface-2 text-txt-3 rounded">{t.trim()}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => handleToggleKnowledge(k.Id, k.Ativo)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 text-txt-2 cursor-pointer" title={k.Ativo ? 'Desativar' : 'Ativar'}>
                    {k.Ativo ? <IconEye className="w-4 h-4" /> : <IconEyeOff className="w-4 h-4" />}
                  </button>
                  <button onClick={() => { setKbEditing(k.Id); setKbAdding(false); setKbForm({ categoria: k.Categoria, titulo: k.Titulo, conteudo: k.Conteudo, tags: k.Tags || '' }); }}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 text-txt-2 cursor-pointer" title="Editar"><IconPencil className="w-4 h-4" /></button>
                  <button onClick={() => handleDeleteKnowledge(k.Id)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-[#fee2e2] text-txt-2 hover:text-[#b91c1c] cursor-pointer" title="Remover"><IconTrash className="w-4 h-4" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
      )}

      {/* ═══ Usuários & Papéis ═══ */}
      {activeSection === 'usuarios' && (
      <Card>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Usuários & Papéis</SectionTitle>
          <span className="text-[11px] text-txt-3">{users.length} usuário(s)</span>
        </div>
        <Desc>Controla quem tem acesso às Configurações (Admin) e quem acessa apenas o Dashboard (Operador). Um Operador só visualiza os work items dos projetos DevOps associados ao seu perfil.</Desc>

        {/* Add user form */}
        <div className="flex items-end gap-3 mb-2 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="text-[11px] text-txt-3 block mb-1">E-mail</label>
            <input
              value={newUserEmail}
              onChange={e => setNewUserEmail(e.target.value)}
              className="w-full h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring"
              placeholder="usuario@paradigmabs.com.br"
            />
          </div>
          <div>
            <label className="text-[11px] text-txt-3 block mb-1">Papel</label>
            <select
              value={newUserRole}
              onChange={e => setNewUserRole(e.target.value as 'Admin' | 'Operador')}
              className="h-8 px-2 border border-border rounded-md text-[13px] bg-bg focus-ring"
            >
              <option value="Operador">Operador</option>
              <option value="Admin">Admin</option>
            </select>
          </div>
          <Btn onClick={handleAddUser} variant="success">+ Adicionar</Btn>
        </div>

        {/* Projetos visíveis — apenas para novo usuário Operador */}
        {newUserRole === 'Operador' && (
          <div className="mb-4 p-3 bg-surface-2 rounded-md border border-border">
            <label className="text-[11px] text-txt-3 block mb-1.5">Projetos DevOps visíveis para este usuário</label>
            <div className="flex flex-wrap gap-3">
              {allProjects.length === 0 && <span className="text-[12px] text-txt-3 italic">Nenhum projeto configurado em "Projetos DevOps"</span>}
              {allProjects.map(p => (
                <label key={p} className="flex items-center gap-1.5 text-[12px] text-txt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newUserProjects.includes(p)}
                    onChange={e => setNewUserProjects(v => e.target.checked ? [...v, p] : v.filter(x => x !== p))}
                    className="w-3.5 h-3.5 rounded border-border"
                  />
                  {p}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Busca por nome ou e-mail */}
        <div className="mb-3">
          <input
            value={userSearch}
            onChange={e => setUserSearch(e.target.value)}
            placeholder="Buscar por nome ou e-mail..."
            className="w-full h-9 px-3 border border-border rounded-md text-[13px] bg-bg focus-ring"
          />
          {userSearch.trim() && (
            <div className="mt-1 text-[11px] text-txt-3">{filteredUsers.length} de {users.length} usuário(s)</div>
          )}
        </div>

        {/* Users table — agrupada por papel */}
        <div className="space-y-4 max-h-[420px] overflow-y-auto">
          {usersByRole.map(group => (
            <div key={group.role}>
              <div className="flex items-center gap-2 mb-2 sticky top-0 bg-surface py-1">
                <span className={`text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                  group.role === 'Admin' ? 'bg-[#f0fdf4] text-[#15803d] border border-[#86efac]' : 'bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe]'
                }`}>{group.role}</span>
                <span className="text-[11px] text-txt-3">{group.items.length}</span>
              </div>
              <div className="space-y-2">
          {group.items.map((u) => (
            <div key={u.Id} className="border border-border rounded-lg p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-txt truncate">
                    {u.Nome || u.Email}
                    {currentUser?.email?.toLowerCase() === u.Email.toLowerCase() && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-[#dbeafe] text-[#1d4ed8] rounded">você</span>
                    )}
                  </div>
                  <div className="text-[11px] text-txt-3 truncate">{u.Email}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={u.Role}
                    onChange={e => handleChangeUserRole(u.Id, e.target.value as 'Admin' | 'Operador')}
                    className="h-7 px-2 border border-border rounded-md text-[12px] bg-bg focus-ring"
                  >
                    <option value="Operador">Operador</option>
                    <option value="Admin">Admin</option>
                  </select>
                  <button
                    onClick={() => handleDeleteUser(u.Id)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-[#fee2e2] text-txt-2 hover:text-[#b91c1c] cursor-pointer"
                    title="Remover"
                  >
                    <IconTrash className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Segmentação por projeto DevOps */}
              <div className="mt-2 pt-2 border-t border-border flex items-center justify-between gap-3">
                {u.Role === 'Admin' ? (
                  <span className="text-[11px] px-2 py-0.5 bg-[#f0fdf4] text-[#15803d] border border-[#86efac] rounded-full font-medium">Todos os projetos</span>
                ) : editingUserId === u.Id ? (
                  <div className="flex-1 flex flex-wrap items-center gap-3">
                    {allProjects.map(p => (
                      <label key={p} className="flex items-center gap-1.5 text-[12px] text-txt-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editingUserProjects.includes(p)}
                          onChange={e => setEditingUserProjects(v => e.target.checked ? [...v, p] : v.filter(x => x !== p))}
                          className="w-3.5 h-3.5 rounded border-border"
                        />
                        {p}
                      </label>
                    ))}
                    <div className="flex gap-2 ml-auto">
                      <button onClick={() => handleSaveUserProjects(u.Id, u.Role)} className="text-[12px] text-[#1d4ed8] font-medium hover:underline cursor-pointer">Salvar</button>
                      <button onClick={() => setEditingUserId(null)} className="text-[12px] text-txt-3 hover:underline cursor-pointer">Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {u.Projects.length === 0 ? (
                        <span className="text-[11px] text-txt-3 italic">Nenhum projeto associado — não verá nenhum work item</span>
                      ) : u.Projects.map(p => (
                        <span key={p} className="text-[11px] px-2 py-0.5 bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe] rounded-full">{p}</span>
                      ))}
                    </div>
                    <Btn
                      onClick={() => { setEditingUserId(u.Id); setEditingUserProjects(u.Projects); }}
                      variant="secondary"
                      size="sm"
                    >
                      <span className="inline-flex items-center gap-1"><IconPencil className="w-3 h-3" /> Editar</span>
                    </Btn>
                  </>
                )}
              </div>
            </div>
          ))}
              </div>
            </div>
          ))}
          {users.length === 0 && (
            <div className="text-[12px] text-txt-3 text-center py-4">Nenhum usuário cadastrado.</div>
          )}
          {users.length > 0 && filteredUsers.length === 0 && (
            <div className="text-[12px] text-txt-3 text-center py-4">Nenhum usuário encontrado para "{userSearch}".</div>
          )}
        </div>
      </Card>
      )}

      </div>
    </div>

    {/* Toast */}
    {toast && <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />}
    </>
  );
}
