import { useEffect, useState, useCallback } from 'react';
import { fetchAuditLog, fetchDocVersions } from '../services/api';

// ── types ────────────────────────────────────────────────────────────────────
interface AuditItem {
  Id: number;
  WorkItemId: number;
  WorkItemTitle: string;
  Tipo: 'APF' | 'SPEC';
  Versao: number;
  TotalPF: number | null;
  TotalHoras: number | null;
  GeradoPorNome: string | null;
  GeradoPorEmail: string | null;
  CriadoEm: string;
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
const Badge = ({ label, variant }: { label: string; variant: 'apf' | 'spec' }) => (
  <span className={`inline-flex items-center h-5 px-2 rounded text-[11px] font-semibold tracking-wide
    ${variant === 'apf'
      ? 'bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe]'
      : 'bg-[#f0fdf4] text-[#15803d] border border-[#86efac]'}`}>
    {label}
  </span>
);

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

function initials(name: string) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

// ── Drawer: versions of a single work item ───────────────────────────────────
function VersionsDrawer({ workItemId, title, onClose }: { workItemId: number; title: string; onClose: () => void }) {
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDocVersions(workItemId)
      .then(setVersions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workItemId]);

  const apf = versions.filter(v => v.Tipo === 'APF');
  const spec = versions.filter(v => v.Tipo === 'SPEC');

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />
      {/* panel */}
      <div className="w-[480px] h-full bg-white shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface">
          <div>
            <p className="text-[11px] text-txt-3 font-medium uppercase tracking-wide">Versões</p>
            <p className="text-[14px] font-semibold text-txt mt-0.5">#{workItemId} — {title}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-2 text-txt-3 hover:text-txt text-lg font-medium">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {loading && <p className="text-[13px] text-txt-3 animate-pulse">Carregando versões…</p>}

          {!loading && apf.length === 0 && spec.length === 0 && (
            <p className="text-[13px] text-txt-3">Nenhuma versão registrada para este chamado.</p>
          )}

          {[{ label: 'APF', items: apf }, { label: 'SPEC', items: spec }].map(({ label, items }) => items.length > 0 && (
            <div key={label}>
              <p className="text-[12px] font-semibold text-txt-2 uppercase tracking-wide mb-2">{label}</p>
              <div className="space-y-2">
                {items.map(v => (
                  <div key={v.Id} className="border border-border rounded-lg p-3 bg-surface hover:bg-surface-2 transition-colors">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <Pill n={v.Versao} />
                        {v.TotalPF != null && (
                          <span className="text-[12px] font-semibold text-[#1d4ed8]">{v.TotalPF} PF</span>
                        )}
                        {v.TotalHoras != null && (
                          <span className="text-[12px] text-txt-3">· {v.TotalHoras}h</span>
                        )}
                      </div>
                      <span className="text-[11px] text-txt-3">{fmtDate(v.CriadoEm)}</span>
                    </div>
                    {v.GeradoPorNome && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <div className="w-5 h-5 rounded-full bg-[#e0e7ff] text-[#3730a3] text-[9px] font-bold flex items-center justify-center">
                          {initials(v.GeradoPorNome)}
                        </div>
                        <span className="text-[12px] text-txt-2">{v.GeradoPorNome}</span>
                        {v.GeradoPorEmail && <span className="text-[11px] text-txt-3">({v.GeradoPorEmail})</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function Audit() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [drawerWi, setDrawerWi] = useState<{ id: number; title: string } | null>(null);

  // filters
  const [filterTipo, setFilterTipo] = useState('');
  const [filterUser, setFilterUser] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const PAGE_SIZE = 50;

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const data = await fetchAuditLog({ page: p, size: PAGE_SIZE, tipo: filterTipo, from: filterFrom, to: filterTo });
      setItems(data.items);
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filterTipo, filterFrom, filterTo]);

  useEffect(() => { load(1); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // derive unique users from current page for filter highlight
  const uniqueUsers = Array.from(new Set(items.map(i => i.GeradoPorNome).filter(Boolean)));

  const filtered = filterUser
    ? items.filter(i => i.GeradoPorNome === filterUser)
    : items;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-txt">Auditoria de Documentos</h2>
          <p className="text-[13px] text-txt-3 mt-0.5">Histórico de APFs e Especificações geradas pela PATi</p>
        </div>
        <span className="text-[13px] text-txt-3">{total} registro{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Filters */}
      <div className="bg-surface border border-border rounded-[10px] p-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-txt-3 uppercase tracking-wide">Tipo</label>
          <select
            value={filterTipo}
            onChange={e => setFilterTipo(e.target.value)}
            className="h-8 px-2 text-[13px] border border-border rounded-md bg-white text-txt focus:outline-none focus:ring-1 focus:ring-[#6366f1]"
          >
            <option value="">Todos</option>
            <option value="APF">APF</option>
            <option value="SPEC">SPEC</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-txt-3 uppercase tracking-wide">Usuário</label>
          <select
            value={filterUser}
            onChange={e => setFilterUser(e.target.value)}
            className="h-8 px-2 text-[13px] border border-border rounded-md bg-white text-txt focus:outline-none focus:ring-1 focus:ring-[#6366f1] min-w-[160px]"
          >
            <option value="">Todos</option>
            {uniqueUsers.map(u => <option key={u!} value={u!}>{u}</option>)}
          </select>
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

        {(filterTipo || filterUser || filterFrom || filterTo) && (
          <button
            onClick={() => { setFilterTipo(''); setFilterUser(''); setFilterFrom(''); setFilterTo(''); }}
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
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-24">Data</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2">Chamado</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-20">Tipo</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-16">Versão</th>
              <th className="text-right px-4 py-3 font-semibold text-txt-2 w-20">PF</th>
              <th className="text-right px-4 py-3 font-semibold text-txt-2 w-20">Horas</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2">Gerado por</th>
              <th className="text-center px-4 py-3 font-semibold text-txt-2 w-20">Versões</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-txt-3 animate-pulse">
                  Carregando…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-txt-3">
                  Nenhum registro encontrado.
                </td>
              </tr>
            )}
            {!loading && filtered.map((item, i) => (
              <tr
                key={item.Id}
                className={`border-b border-border transition-colors hover:bg-surface-2 ${i % 2 === 0 ? '' : 'bg-[#fafafa]'}`}
              >
                <td className="px-4 py-2.5 text-txt-3 whitespace-nowrap">{fmtDate(item.CriadoEm)}</td>
                <td className="px-4 py-2.5">
                  <a
                    href={`/workitem/${item.WorkItemId}`}
                    className="text-[#1d4ed8] hover:underline font-medium"
                  >
                    #{item.WorkItemId}
                  </a>
                  <span className="text-txt-3 ml-2 truncate max-w-[280px] inline-block align-middle">
                    {item.WorkItemTitle}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge label={item.Tipo} variant={item.Tipo === 'APF' ? 'apf' : 'spec'} />
                </td>
                <td className="px-4 py-2.5"><Pill n={item.Versao} /></td>
                <td className="px-4 py-2.5 text-right font-semibold text-txt">
                  {item.TotalPF != null ? item.TotalPF : '—'}
                </td>
                <td className="px-4 py-2.5 text-right text-txt-2">
                  {item.TotalHoras != null ? item.TotalHoras : '—'}
                </td>
                <td className="px-4 py-2.5">
                  {item.GeradoPorNome ? (
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-[#e0e7ff] text-[#3730a3] text-[10px] font-bold flex items-center justify-center shrink-0">
                        {initials(item.GeradoPorNome)}
                      </div>
                      <span className="text-txt">{item.GeradoPorNome}</span>
                    </div>
                  ) : (
                    <span className="text-txt-3 italic text-[12px]">Anônimo</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <button
                    onClick={() => setDrawerWi({ id: item.WorkItemId, title: item.WorkItemTitle || '' })}
                    className="text-[12px] text-[#6366f1] hover:underline font-medium"
                  >
                    ver
                  </button>
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

      {/* Versions drawer */}
      {drawerWi && (
        <VersionsDrawer
          workItemId={drawerWi.id}
          title={drawerWi.title}
          onClose={() => setDrawerWi(null)}
        />
      )}
    </div>
  );
}
