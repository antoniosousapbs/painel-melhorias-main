import { useEffect, useState, useCallback } from 'react';
import { fetchUnifiedAudit, fetchDocVersions, UnifiedAuditItem } from '../services/api';
import UserAvatar from '../components/UserAvatar';

// ── types ─────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  DOC_APF: 'APF',
  DOC_SPEC: 'Especificação',
  DOC_SPEC_DOCX: 'Especificação',
  CAMPO_ALTERADO: 'Campo alterado',
  ACESSO: 'Acesso',
  ERRO: 'Erro',
  SYNC: 'Sync DevOps',
};

function eventBadgeClass(eventType: string, sucesso: boolean): string {
  if (!sucesso || eventType === 'ERRO') return 'bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]';
  if (eventType.startsWith('DOC_')) return 'bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe]';
  if (eventType === 'CAMPO_ALTERADO') return 'bg-[#fefce8] text-[#a16207] border border-[#fde68a]';
  if (eventType === 'ACESSO') return 'bg-[#f0fdf4] text-[#15803d] border border-[#86efac]';
  return 'bg-surface-2 text-txt-2 border border-border';
}

interface DocVersion {
  Id: number;
  WorkItemId: number;
  WorkItemTitle: string;
  Tipo: string;
  Versao: number;
  TotalPF: number | null;
  TotalHoras: number | null;
  GeradoPorNome: string | null;
  GeradoPorEmail: string | null;
  CriadoEm: string;
}

// ── small reusable pieces ────────────────────────────────────────────────────
const Pill = ({ n }: { n: number }) => (
  <span className="inline-flex items-center justify-center w-6 h-5 rounded-full bg-[#e0e7ff] text-[#3730a3] text-[10px] font-bold">
    v{n}
  </span>
);

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ── Drawer: detalhe completo de UM evento de auditoria (compacto, nunca navega de página) ──
function EventDetailDrawer({ item, onClose }: { item: UnifiedAuditItem; onClose: () => void }) {
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(item.Source === 'DOC' && !!item.WorkItemId);

  useEffect(() => {
    if (item.Source === 'DOC' && item.WorkItemId) {
      fetchDocVersions(item.WorkItemId)
        .then(setVersions)
        .catch(console.error)
        .finally(() => setLoadingVersions(false));
    }
  }, [item]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const apf = versions.filter(v => v.Tipo === 'APF');
  const spec = versions.filter(v => v.Tipo === 'SPEC' || v.Tipo === 'SPEC_DOCX');

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />
      {/* panel */}
      <div className="w-[440px] h-full bg-white shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface">
          <div>
            <p className="text-[11px] text-txt-3 font-medium uppercase tracking-wide">Detalhes do evento</p>
            <span className={`inline-flex items-center h-5 px-2 mt-1 rounded text-[11px] font-semibold tracking-wide whitespace-nowrap ${eventBadgeClass(item.EventType, item.Sucesso)}`}>
              {EVENT_LABELS[item.EventType] || item.EventType}
            </span>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-2 text-txt-3 hover:text-txt text-lg font-medium">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          <div>
            <p className="text-[11px] font-semibold text-txt-3 uppercase tracking-wide mb-1">Data</p>
            <p className="text-[13px] text-txt">{fmtDate(item.Data)}</p>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-txt-3 uppercase tracking-wide mb-1">Evento</p>
            <p className="text-[13px] text-txt">
              {item.WorkItemId ? `#${item.WorkItemId}${item.WorkItemTitle ? ` — ${item.WorkItemTitle}` : ''}` : (item.WorkItemTitle || '—')}
            </p>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-txt-3 uppercase tracking-wide mb-1">Usuário</p>
            {item.UsuarioNome ? (
              <div className="flex items-center gap-2">
                <UserAvatar nome={item.UsuarioNome} email={item.UsuarioEmail} size={24} />
                <span className="text-[13px] text-txt">{item.UsuarioNome}</span>
                {item.UsuarioEmail && <span className="text-[12px] text-txt-3">({item.UsuarioEmail})</span>}
              </div>
            ) : <p className="text-[13px] text-txt-3 italic">Sistema</p>}
          </div>

          <div>
            <p className="text-[11px] font-semibold text-txt-3 uppercase tracking-wide mb-1">Detalhe</p>
            <p className="text-[13px] text-txt-2 whitespace-pre-wrap">{item.Detalhe || '—'}</p>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-txt-3 uppercase tracking-wide mb-1">Status</p>
            <span className={`inline-flex items-center h-5 px-2 rounded text-[11px] font-semibold whitespace-nowrap ${item.Sucesso ? 'bg-[#f0fdf4] text-[#15803d] border border-[#86efac]' : 'bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]'}`}>
              {item.Sucesso ? 'Sucesso' : 'Falha'}
            </span>
          </div>

          {item.Source === 'DOC' && (
            <div>
              <p className="text-[11px] font-semibold text-txt-3 uppercase tracking-wide mb-2">Todas as versões deste chamado</p>
              {loadingVersions && <p className="text-[13px] text-txt-3 animate-pulse">Carregando versões…</p>}
              {!loadingVersions && apf.length === 0 && spec.length === 0 && (
                <p className="text-[13px] text-txt-3">Nenhuma versão registrada.</p>
              )}
              {[{ label: 'APF', items: apf }, { label: 'Especificação', items: spec }].map(({ label, items }) => items.length > 0 && (
                <div key={label} className="mb-3">
                  <p className="text-[11px] font-semibold text-txt-2 uppercase tracking-wide mb-1.5">{label}</p>
                  <div className="space-y-1.5">
                    {items.map(v => (
                      <div key={v.Id} className="border border-border rounded-lg p-2.5 bg-surface">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Pill n={v.Versao} />
                            {v.TotalPF != null && <span className="text-[12px] font-semibold text-[#1d4ed8]">{v.TotalPF} PF</span>}
                            {v.TotalHoras != null && <span className="text-[12px] text-txt-3">· {v.TotalHoras}h</span>}
                          </div>
                          <span className="text-[11px] text-txt-3">{fmtDate(v.CriadoEm)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function Audit() {
  const [items, setItems] = useState<UnifiedAuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<UnifiedAuditItem | null>(null);

  // filters
  const [filterEventType, setFilterEventType] = useState('');
  const [filterUser, setFilterUser] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const PAGE_SIZE = 50;

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const data = await fetchUnifiedAudit({ page: p, size: PAGE_SIZE, eventType: filterEventType, user: filterUser, from: filterFrom, to: filterTo });
      setItems(data.items);
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filterEventType, filterUser, filterFrom, filterTo]);

  useEffect(() => { load(1); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-txt">Auditoria Completa</h2>
          <p className="text-[13px] text-txt-3 mt-0.5">Gerações de documentos, alterações de campo, acessos, erros e sincronizações</p>
        </div>
        <span className="text-[13px] text-txt-3">{total} registro{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Filters */}
      <div className="bg-surface border border-border rounded-[10px] p-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-txt-3 uppercase tracking-wide">Tipo de Evento</label>
          <select
            value={filterEventType}
            onChange={e => setFilterEventType(e.target.value)}
            className="h-8 px-2 text-[13px] border border-border rounded-md bg-white text-txt focus:outline-none focus:ring-1 focus:ring-[#6366f1] min-w-[200px]"
          >
            <option value="">Todos</option>
            <option value="DOC_APF">Geração de APF</option>
            <option value="DOC_SPEC">Geração de Especificação (PDF)</option>
            <option value="DOC_SPEC_DOCX">Geração de Especificação (Word)</option>
            <option value="CAMPO_ALTERADO">Alteração de campo</option>
            <option value="ACESSO">Acesso ao sistema</option>
            <option value="ERRO">Erro</option>
            <option value="SYNC">Sincronização DevOps</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-txt-3 uppercase tracking-wide">Usuário</label>
          <input
            value={filterUser}
            onChange={e => setFilterUser(e.target.value)}
            placeholder="Nome ou e-mail"
            className="h-8 px-2 text-[13px] border border-border rounded-md bg-white text-txt focus:outline-none focus:ring-1 focus:ring-[#6366f1] min-w-[180px]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-txt-3 uppercase tracking-wide">De</label>
          <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)}
            className="h-8 px-2 text-[13px] border border-border rounded-md bg-white text-txt focus:outline-none focus:ring-1 focus:ring-[#6366f1]" />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-txt-3 uppercase tracking-wide">Até</label>
          <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)}
            className="h-8 px-2 text-[13px] border border-border rounded-md bg-white text-txt focus:outline-none focus:ring-1 focus:ring-[#6366f1]" />
        </div>

        <button
          onClick={() => load(1)}
          disabled={loading}
          className="h-8 px-4 rounded-md text-[13px] font-medium border border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8] hover:bg-[#dbeafe] disabled:opacity-50 transition-colors"
        >
          {loading ? 'Buscando…' : 'Filtrar'}
        </button>

        {(filterEventType || filterUser || filterFrom || filterTo) && (
          <button
            onClick={() => { setFilterEventType(''); setFilterUser(''); setFilterFrom(''); setFilterTo(''); }}
            className="h-8 px-3 rounded-md text-[12px] text-txt-3 hover:text-txt border border-border hover:bg-surface-2 transition-colors"
          >
            Limpar
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-surface border border-border rounded-[10px] shadow-sm overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-32">Data</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-44">Tipo de Evento</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2">Evento</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2">Detalhe</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2">Usuário</th>
              <th className="text-center px-4 py-3 font-semibold text-txt-2 w-20">Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-txt-3 animate-pulse">
                  Carregando…
                </td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-txt-3">
                  Nenhum registro encontrado.
                </td>
              </tr>
            )}
            {!loading && items.map((item, i) => (
              <tr
                key={item.UniqueId}
                onClick={() => setSelectedItem(item)}
                className={`border-b border-border transition-colors hover:bg-surface-2 cursor-pointer ${i % 2 === 0 ? '' : 'bg-[#fafafa]'}`}
              >
                <td className="px-4 py-2.5 text-txt-3 whitespace-nowrap">{fmtDate(item.Data)}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center h-5 px-2 rounded text-[11px] font-semibold tracking-wide whitespace-nowrap ${eventBadgeClass(item.EventType, item.Sucesso)}`}>
                    {EVENT_LABELS[item.EventType] || item.EventType}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  {item.WorkItemId ? (
                    <>
                      <span className="text-[#1d4ed8] font-medium">#{item.WorkItemId}</span>
                      {item.WorkItemTitle && (
                        <span className="text-txt-3 ml-2 truncate max-w-[220px] inline-block align-middle">{item.WorkItemTitle}</span>
                      )}
                    </>
                  ) : <span className="text-txt-2">{item.WorkItemTitle || '—'}</span>}
                </td>
                <td className="px-4 py-2.5 text-txt-2 max-w-[360px] truncate" title={item.Detalhe || ''}>
                  {item.Detalhe || '—'}
                </td>
                <td className="px-4 py-2.5">
                  {item.UsuarioNome ? (
                    <div className="flex items-center gap-2">
                      <UserAvatar nome={item.UsuarioNome} email={item.UsuarioEmail} size={24} />
                      <span className="text-txt">{item.UsuarioNome}</span>
                    </div>
                  ) : (
                    <span className="text-txt-3 italic text-[12px]">Sistema</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span className="text-[12px] text-[#6366f1] font-medium">ver ›</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-txt-3">
            Página {page} de {totalPages} · {total} registros
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => load(page - 1)}
              disabled={page <= 1 || loading}
              className="h-8 px-3 text-[13px] border border-border rounded-md bg-surface hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              ‹ Anterior
            </button>
            <button
              onClick={() => load(page + 1)}
              disabled={page >= totalPages || loading}
              className="h-8 px-3 text-[13px] border border-border rounded-md bg-surface hover:bg-surface-2 disabled:opacity-40 transition-colors"
            >
              Próxima ›
            </button>
          </div>
        </div>
      )}

      {/* Detail drawer — compacto, nunca navega de página */}
      {selectedItem && (
        <EventDetailDrawer
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}
