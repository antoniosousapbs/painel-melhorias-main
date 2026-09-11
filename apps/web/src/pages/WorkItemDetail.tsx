import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchWorkItem, updateWorkItem, fetchAudit, fetchNextPriority } from '../services/api';
import { getDevOpsWorkItemUrl } from '../utils/devops';
import type { WorkItem } from '../types';

type IconProps = { className?: string };
const IconPencil = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 20l.9-3.8L15.5 5.6a1.8 1.8 0 012.6 0l1.3 1.3a1.8 1.8 0 010 2.6L8.8 20l-4.1.9a.7.7 0 01-.7-.9z" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M13.7 7.4l2.9 2.9" strokeLinecap="round"/>
  </svg>
);

const CATEGORIAS = ['Produto', 'Hibrido', 'Cliente', 'Info Insuficiente'];
const TIPOS = ['UX', 'RegraNegocio', 'Relatorio', 'Integracao', 'WorkflowAprovacao'];
const MODULOS = ['Cotacao', 'Pedidos', 'Fornecedores', 'Contratos', 'Aprovacao', 'Geral', 'Fiscal'];
const IMPACTOS = ['Alto', 'Medio', 'Baixo'];

const catBadge: Record<string, string> = {
  Produto: 'badge-produto',
  Hibrido: 'badge-hibrido',
  Cliente: 'badge-cliente',
  'Info Insuficiente': 'badge-info',
};

export default function WorkItemDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<WorkItem | null>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [nextPrio, setNextPrio] = useState<number | null>(null);

  const [form, setForm] = useState({
    categoria: '',
    tipo: '',
    modulo: '',
    prioridade: '',
    impactoOperacao: '',
    esforcoAPF: '',
  });

  const load = async () => {
    if (!id) return;
    const data = await fetchWorkItem(parseInt(id));
    setItem(data);
    setForm({
      categoria: data.Categoria || '',
      tipo: data.Tipo || '',
      modulo: data.Modulo || '',
      prioridade: data.Prioridade != null ? String(data.Prioridade) : '',
      impactoOperacao: data.ImpactoOperacao || '',
      esforcoAPF: data.EsforcoAPF ? String(data.EsforcoAPF) : '',
    });
    const auditData = await fetchAudit(parseInt(id));
    setAudit(auditData);
    if (data.ClienteNome) {
      fetchNextPriority(data.ClienteNome).then(setNextPrio).catch(() => setNextPrio(null));
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setSaveError('');
    try {
      await updateWorkItem(parseInt(id), {
        ...form,
        prioridade: form.prioridade === '' ? null : Number(form.prioridade),
        esforcoAPF: form.esforcoAPF ? parseFloat(form.esforcoAPF) : null,
      });
      await load();
      setEditing(false);
    } catch (err: any) {
      setSaveError(err.message || 'Erro ao salvar');
    }
    setSaving(false);
  };

  if (!item) {
    return <div className="text-center py-16 text-txt-3 text-[13px]">Carregando...</div>;
  }

  return (
    <div>
      {/* Back + Title bar */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => navigate(-1)}
          className="h-9 px-3 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] hover:border-[#bfd2ff] transition-colors duration-150"
        >
          ← Voltar
        </button>
        <span className="font-mono text-[12px] text-txt-3">#{item.Id}</span>
        <a
          href={getDevOpsWorkItemUrl(item.Id, item.DevOpsAreaPath)}
          target="_blank"
          rel="noopener"
          className="inline-block px-[10px] py-1 text-[12px] font-medium text-accent bg-[#f0f6ff] border border-[#dbeafe] rounded-sm hover:bg-[#dbeafe] hover:border-[#93c5fd] transition-[background,border-color] duration-[120ms]"
        >
          Abrir no DevOps ↗
        </a>
      </div>

      {/* Title & Meta panel */}
      <div className="bg-surface border border-border rounded-[10px] shadow-sm p-6 mb-4">
        <h3 className="text-[15px] font-semibold text-txt mb-4 leading-snug">{item.Title}</h3>
        <div className="grid grid-cols-3 gap-4 text-[13px] max-[760px]:grid-cols-1">
          <div>
            <span className="text-[11px] font-medium uppercase tracking-[.05em] text-txt-3">Cliente</span>
            <div className="mt-0.5 text-txt">{item.ClienteNome || '—'}</div>
          </div>
          <div>
            <span className="text-[11px] font-medium uppercase tracking-[.05em] text-txt-3">Status DevOps</span>
            <div className="mt-0.5 text-txt">{item.DevOpsState || '—'}</div>
          </div>
          <div>
            <span className="text-[11px] font-medium uppercase tracking-[.05em] text-txt-3">Tags</span>
            <div className="mt-0.5 text-txt">{item.DevOpsTags || '—'}</div>
          </div>
        </div>
      </div>

      {/* Classification panel */}
      <div className="bg-surface border border-border rounded-[10px] shadow-sm p-6 mb-4">
        <div className="flex items-center justify-between mb-5">
          <h4 className="text-[13px] font-semibold tracking-tight text-txt">Classificação</h4>
          <div className="flex gap-2">
            {!editing ? (
              <button
                onClick={() => setEditing(true)}
                className="h-9 px-3 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] hover:border-[#bfd2ff] transition-colors duration-150"
              >
                <span className="inline-flex items-center gap-1.5"><IconPencil className="w-3.5 h-3.5" /> Editar</span>
              </button>
            ) : (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="h-9 px-3 border border-accent-2 rounded-sm bg-accent-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50 transition-colors duration-150"
                >
                  {saving ? 'Salvando...' : 'Salvar'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="h-9 px-3 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] transition-colors duration-150"
                >
                  Cancelar
                </button>
              </>
            )}
          </div>
        </div>

        {item.ClassificacaoOrigem && (
          <div className="text-[11px] text-txt-3 mb-4">
            Origem: {item.ClassificacaoOrigem} · Confiança: {((item.ClassificacaoConfianca || 0) * 100).toFixed(0)}%
            {item.ClassificacaoRevisada && ' · ✓ Revisada manualmente'}
          </div>
        )}

        {saveError && (
          <div className="text-[12px] text-danger mb-4">{saveError}</div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Field label="Categoria" value={form.categoria} options={CATEGORIAS} editing={editing} onChange={v => setForm({ ...form, categoria: v })} badge={catBadge} />
          <Field label="Tipo" value={form.tipo} options={TIPOS} editing={editing} onChange={v => setForm({ ...form, tipo: v })} />
          <Field label="Módulo" value={form.modulo} options={MODULOS} editing={editing} onChange={v => setForm({ ...form, modulo: v })} />
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-[.05em] text-txt-3 mb-1.5">
              Prioridade {editing && nextPrio != null && <span className="text-txt-3 normal-case font-normal">(próximo: {nextPrio})</span>}
            </label>
            {editing ? (
              <input
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                placeholder="Número (manual)"
                className="h-9 w-full border border-border rounded-sm px-2 text-[13px] bg-bg focus-ring"
                value={form.prioridade}
                onChange={e => setForm({ ...form, prioridade: e.target.value.replace(/[^0-9]/g, '') })}
              />
            ) : (
              <div className="text-[13px] font-mono text-txt">{form.prioridade || '—'}</div>
            )}
          </div>
          <Field label="Impacto Operação" value={form.impactoOperacao} options={IMPACTOS} editing={editing} onChange={v => setForm({ ...form, impactoOperacao: v })} />
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-[.05em] text-txt-3 mb-1.5">
              Esforço APF
            </label>
            {editing ? (
              <input
                type="number"
                step="0.5"
                className="h-9 w-[92px] border border-border rounded-sm px-2 font-mono text-[13px] bg-bg focus-ring"
                value={form.esforcoAPF}
                onChange={e => setForm({ ...form, esforcoAPF: e.target.value })}
              />
            ) : (
              <div className="text-[13px] font-mono text-txt">{form.esforcoAPF || '—'}</div>
            )}
          </div>
        </div>
      </div>

      {/* Audit Log */}
      {audit.length > 0 && (
        <div className="bg-surface border border-border rounded-[10px] shadow-sm p-6">
          <h4 className="text-[13px] font-semibold tracking-tight text-txt mb-4">Histórico de Alterações</h4>
          <div className="space-y-2">
            {audit.map((entry, i) => (
              <div key={i} className="flex items-center gap-3 text-[12px] text-txt-2">
                <span className="text-txt-3 font-mono text-[11px]">{new Date(entry.AlteradoEm).toLocaleString('pt-BR')}</span>
                <span className="font-semibold text-txt">{entry.Campo}:</span>
                <span className="line-through text-danger/60">{entry.ValorAnterior || '(vazio)'}</span>
                <span className="text-txt-3">→</span>
                <span className="text-accent-2 font-medium">{entry.ValorNovo}</span>
                <span className="text-txt-3 ml-auto">por {entry.AlteradoPor}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, options, editing, onChange, badge }: {
  label: string; value: string; options: string[]; editing: boolean; onChange: (v: string) => void; badge?: Record<string, string>;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-[.05em] text-txt-3 mb-1.5">
        {label}
      </label>
      {editing ? (
        <select
          className="h-9 w-full border border-border rounded-sm px-2 text-[13px] bg-bg focus-ring"
          value={value}
          onChange={e => onChange(e.target.value)}
        >
          <option value="">—</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        badge && value ? (
          <span className={`inline-block text-[11px] font-semibold tracking-[.02em] px-2 py-0.5 rounded-full ${badge[value] || ''}`}>
            {value}
          </span>
        ) : (
          <div className="text-[13px] text-txt">{value || '—'}</div>
        )
      )}
    </div>
  );
}
