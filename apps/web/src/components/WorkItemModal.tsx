import { useEffect, useState } from 'react';
import { fetchNextPriority } from '../services/api';
import type { WorkItem } from '../types';

const inputCls = 'h-9 w-full px-3 border border-border rounded-sm bg-bg text-[13px] focus-ring transition-[border-color,box-shadow] duration-150';
const labelCls = 'text-[11px] font-semibold uppercase tracking-[.05em] text-txt-3 mb-1';

/** Modal de detalhe/edição de um WorkItem — usado no Dashboard (edição normal) e no
 * Histórico de Chamados Encerrados (via prop `readOnly`, sem nenhum campo editável nem
 * ação de salvar — o chamado já está fechado, não faz sentido reclassificar por aqui). */
export default function WorkItemModal({ item, onClose, onSave, readOnly }: {
  item: WorkItem;
  onClose: () => void;
  onSave?: (id: number, data: Record<string, any>) => Promise<void>;
  readOnly?: boolean;
}) {
  const [categoria, setCategoria] = useState(item.Categoria || '');
  const [tipo, setTipo] = useState(item.Tipo || '');
  const [prioridade, setPrioridade] = useState<string>(item.Prioridade != null ? String(item.Prioridade) : '');
  const [nextPrio, setNextPrio] = useState<number | null>(null);
  const [esforco, setEsforco] = useState(item.EsforcoAPF ?? '');
  const [impacto, setImpacto] = useState(item.ImpactoOperacao || '');
  const [apfDispensado, setApfDispensado] = useState(item.ApfDispensado || false);
  const [apfDispensadoMotivo, setApfDispensadoMotivo] = useState(item.ApfDispensadoMotivo || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    setCategoria(item.Categoria || '');
    setTipo(item.Tipo || '');
    setPrioridade(item.Prioridade != null ? String(item.Prioridade) : '');
    setEsforco(item.EsforcoAPF ?? '');
    setImpacto(item.ImpactoOperacao || '');
    setApfDispensado(item.ApfDispensado || false);
    setApfDispensadoMotivo(item.ApfDispensadoMotivo || '');
    // Sugestão de próxima prioridade só faz sentido no modo de edição
    if (!readOnly && item.ClienteNome) {
      fetchNextPriority(item.ClienteNome).then(n => setNextPrio(n)).catch(() => setNextPrio(0));
    }
  }, [item, readOnly]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setSaveError('');
    if (apfDispensado && !apfDispensadoMotivo.trim()) {
      setSaveError('Informe o motivo para dispensar este chamado de APF');
      setSaving(false);
      return;
    }
    if (apfDispensado && !(Number(esforco) > 0)) {
      setSaveError('Informe o esforço estimado (em horas, maior que zero) para dispensar este chamado de APF');
      setSaving(false);
      return;
    }
    try {
      await onSave(item.Id, {
        categoria: categoria || null,
        tipo: tipo || null,
        prioridade: prioridade === '' ? null : Number(prioridade),
        esforcoAPF: esforco === '' ? null : Number(esforco),
        impactoOperacao: impacto || null,
        apfDispensado,
        apfDispensadoMotivo: apfDispensado ? apfDispensadoMotivo.trim() : null,
      });
    } catch (err: any) {
      setSaveError(err.message || 'Erro ao salvar');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-[640px] max-h-[90vh] overflow-auto animate-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <span className="text-[12px] font-mono text-txt-3 mr-2">#{item.Id}</span>
            <span className="text-[15px] font-semibold text-txt">{item.Title}</span>
            {readOnly && (
              <span className="ml-2 inline-flex items-center h-5 px-2 rounded text-[11px] font-semibold bg-surface-2 text-txt-2 border border-border align-middle">
                Encerrado — somente leitura
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-txt-3 hover:text-txt text-[18px] leading-none px-1">✕</button>
        </div>

        {/* Info */}
        <div className="px-6 py-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] border-b border-border bg-surface-2">
          <div><span className="text-txt-3">Cliente:</span> <span className="font-medium">{item.ClienteNome || '—'}</span></div>
          <div><span className="text-txt-3">Módulo:</span> <span className="font-medium">{item.Modulo || '—'}</span></div>
          <div><span className="text-txt-3">Responsável:</span> <span className="font-medium">{item.AssignedTo || '—'}</span></div>
          <div><span className="text-txt-3">DevOps:</span> <span className="font-medium">{item.DevOpsState || '—'}</span></div>
          <div><span className="text-txt-3">Origem:</span> <span className="font-medium">{item.ClassificacaoOrigem || '—'}</span></div>
        </div>

        {/* Campos — editáveis no Dashboard, texto simples no modo somente leitura */}
        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className={labelCls}>Categoria</div>
              {readOnly ? (
                <div className="text-[13px] text-txt">{categoria || '—'}</div>
              ) : (
                <select className={inputCls} value={categoria} onChange={e => setCategoria(e.target.value)}>
                  <option value="">—</option>
                  <option value="Produto">Roadmap</option>
                  <option value="Hibrido">Hibrido</option>
                  <option value="Cliente">Customização</option>
                  <option value="Info Insuficiente">Indefinido</option>
                </select>
              )}
            </div>
            <div>
              <div className={labelCls}>Tipo</div>
              {readOnly ? (
                <div className="text-[13px] text-txt">{tipo || '—'}</div>
              ) : (
                <select className={inputCls} value={tipo} onChange={e => setTipo(e.target.value)}>
                  <option value="">—</option>
                  <option value="UX">UX</option>
                  <option value="RegraNegocio">Regra de Negócio</option>
                  <option value="Relatorio">Relatório</option>
                  <option value="Integracao">Integração</option>
                  <option value="WorkflowAprovacao">Workflow Aprovação</option>
                </select>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className={labelCls}>Prioridade {!readOnly && nextPrio != null && <span className="text-txt-3 normal-case font-normal">(próximo: {nextPrio})</span>}</div>
              {readOnly ? (
                <div className="text-[13px] text-txt font-mono">{prioridade || '—'}</div>
              ) : (
                <input
                  className={inputCls}
                  type="number"
                  step="1"
                  min="0"
                  inputMode="numeric"
                  placeholder="Número (manual)"
                  value={prioridade}
                  onChange={e => setPrioridade(e.target.value.replace(/[^0-9]/g, ''))}
                />
              )}
            </div>
            <div>
              <div className={labelCls}>Esforço {!readOnly && apfDispensado && <span className="text-danger normal-case font-normal">(obrigatório)</span>}</div>
              {readOnly ? (
                <div className="text-[13px] text-txt font-mono">{esforco !== '' ? `${esforco}h` : '—'}</div>
              ) : (
                <div className="relative">
                  <input
                    className={`${inputCls} pr-8`}
                    type="number"
                    min="0"
                    value={esforco}
                    onChange={e => setEsforco(e.target.value)}
                    placeholder="0"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-txt-3">h</span>
                </div>
              )}
            </div>
            <div>
              <div className={labelCls}>Impacto Operação</div>
              {readOnly ? (
                <div className="text-[13px] text-txt">{impacto || '—'}</div>
              ) : (
                <select className={inputCls} value={impacto} onChange={e => setImpacto(e.target.value)}>
                  <option value="">—</option>
                  <option value="Alto">Alto</option>
                  <option value="Médio">Médio</option>
                  <option value="Baixo">Baixo</option>
                </select>
              )}
            </div>
          </div>

          {/* Dispensa de APF — só faz sentido como AÇÃO no modo de edição */}
          {!readOnly && (
            <div className="pt-2 border-t border-border">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={apfDispensado}
                  onChange={e => setApfDispensado(e.target.checked)}
                  className="w-4 h-4 accent-accent cursor-pointer"
                />
                <span className="text-[13px] font-medium text-txt">Este chamado não requer APF</span>
              </label>
              {apfDispensado && (
                <input
                  className={`${inputCls} mt-2`}
                  type="text"
                  placeholder="Motivo (obrigatório) — ex: correção simples, não gera pontos de função"
                  value={apfDispensadoMotivo}
                  onChange={e => setApfDispensadoMotivo(e.target.value)}
                />
              )}
            </div>
          )}
          {readOnly && apfDispensado && (
            <div className="pt-2 border-t border-border text-[13px] text-txt-2">
              <span className="font-medium text-txt">APF dispensado</span>{apfDispensadoMotivo ? ` — ${apfDispensadoMotivo}` : ''}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-surface-2">
          {saveError ? (
            <span className="text-[12px] text-danger">{saveError}</span>
          ) : <span />}
          <div className="flex gap-2">
            {readOnly ? (
              <button
                onClick={onClose}
                className="h-9 px-4 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] transition-colors duration-150"
              >
                Fechar
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  className="h-9 px-4 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] transition-colors duration-150"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="h-9 px-5 rounded-sm bg-accent text-white text-[13px] font-semibold shadow-sm hover:bg-[#0044cc] disabled:opacity-50 transition-colors duration-150"
                >
                  {saving ? 'Salvando...' : 'Salvar'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
